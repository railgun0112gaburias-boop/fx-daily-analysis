// Documented, unauthenticated market-data API: https://api.coin.z.com/fxdocs/
// GMO Coin is the price provider, not either of the user's brokerage accounts.
const BASE = 'https://forex-api.coin.z.com/public/v1';
const SOURCE = 'GMO Coin Forex Public API';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const WINDOWS = {m15: 900_000, h1: HOUR, h4: 4 * HOUR, d1: DAY};
const NORMAL_DAYS = {m15: 15, h1: 45, h4: 100, d1: 400};
const QUICK_DAYS = {m15: 2, h1: 3, h4: 4, d1: 7};
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function timestamp(value) {
  const result = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(result)) throw new Error('Invalid timestamp');
  return result;
}

// The documented API date changes at 06:00 JST (21:00 UTC the preceding day).
export function gmoTradingDate(value) {
  return new Date(timestamp(value) + 3 * HOUR).toISOString().slice(0, 10).replaceAll('-', '');
}

function tradingDates(from, now) {
  const keyTime = value => {
    const key = gmoTradingDate(value);
    return Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8)));
  };
  const last = keyTime(now);
  // Also include two prior business-date partitions immediately after rollover.
  const first = Math.min(keyTime(from), last - 2 * DAY);
  const dates = [];
  for (let day = first; day <= last; day += DAY) dates.push(new Date(day).toISOString().slice(0, 10).replaceAll('-', ''));
  return dates;
}

function yearsBetween(from, now) {
  const years = [];
  for (let year = new Date(from).getUTCFullYear(); year <= new Date(now).getUTCFullYear(); year++) years.push(String(year));
  return years;
}

function mergeCandles(rows) {
  const byTime = new Map();
  for (const candle of rows) {
    const previous = byTime.get(candle.timestamp);
    if (previous && ['open', 'high', 'low', 'close'].some(key => previous[key] !== candle[key])) {
      throw new Error(`Conflicting OHLC at ${new Date(candle.timestamp).toISOString()}`);
    }
    byTime.set(candle.timestamp, candle);
  }
  return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function parseCandles(rows, windowMs) {
  if (!Array.isArray(rows)) throw new Error('GMO Coin data is not a candle array');
  return mergeCandles(rows.map(row => {
    if (!row || typeof row !== 'object') throw new Error('Invalid GMO Coin candle');
    const values = [row.openTime, row.open, row.high, row.low, row.close];
    if (values.some(value => value === null || value === undefined || value === '' || typeof value === 'boolean')) {
      throw new Error('Missing GMO Coin OHLC value');
    }
    const [time, open, high, low, close] = values.map(Number);
    if (![time, open, high, low, close].every(Number.isFinite) || !Number.isSafeInteger(time)) throw new Error('Non-numeric GMO Coin OHLC');
    if (time % windowMs !== 0) throw new Error(`GMO Coin candle is not aligned to UTC ${windowMs / HOUR}h boundaries`);
    if (Math.min(open, high, low, close) <= 0 || high < Math.max(open, low, close) || low > Math.min(open, high, close)) {
      throw new Error('Invalid GMO Coin high/low');
    }
    return {timestamp: time, open, high, low, close};
  }));
}

// Source candles must be confirmed UTC-aligned native 4h candles. Weekend and
// holiday gaps remain gaps: an actual partial trading day can have fewer than 6.
export function utcDailyFromFourHour(rows, {from = -Infinity, now = Date.now(), graceMs = 120_000} = {}) {
  const end = timestamp(now);
  const days = new Map();
  for (const candle of mergeCandles(rows)) {
    if (candle.timestamp % WINDOWS.h4 !== 0) throw new Error('Daily aggregation requires UTC-aligned 4h candles');
    const day = Math.floor(candle.timestamp / DAY) * DAY;
    // Reject a whole initial partial calendar day, not just its earlier bars.
    if (day < from || day + DAY + graceMs > end || candle.timestamp + WINDOWS.h4 + graceMs > end) continue;
    if (!days.has(day)) days.set(day, {...candle, timestamp: day});
    else {
      const value = days.get(day);
      value.high = Math.max(value.high, candle.high);
      value.low = Math.min(value.low, candle.low);
      value.close = candle.close;
    }
  }
  return [...days.values()];
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createGmoClient({
  fetchImpl = globalThis.fetch,
  requestGapMs = 300,
  timeoutMs = 15_000,
  maxAttempts = 3,
  confirmationGraceMs = 120_000,
  sleepImpl = defaultSleep,
  clock = Date.now,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error('maxAttempts must be between 1 and 3');
  if (!Number.isFinite(requestGapMs) || requestGapMs < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(confirmationGraceMs) || confirmationGraceMs < 0) {
    throw new Error('Invalid request timing configuration');
  }

  const requestLog = [];
  let queue = Promise.resolve();
  let nextRequestAt = 0;
  let statusPromise;

  // Requests, including retries, share one conservative queue across both pairs.
  function queuedAttempt(operation) {
    const result = queue.then(async () => {
      const delay = Math.max(0, nextRequestAt - clock());
      if (delay) await sleepImpl(delay);
      try { return await operation(); }
      finally { nextRequestAt = clock() + requestGapMs; }
    });
    queue = result.catch(() => undefined);
    return result;
  }

  async function requestJson(url, kind) {
    const log = {url, kind, startedUTC: new Date(clock()).toISOString(), attempts: 0, httpStatus: null};
    requestLog.push(log);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      log.attempts = attempt;
      let retryDelay = 500 * 2 ** (attempt - 1);
      try {
        const result = await queuedAttempt(async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const response = await fetchImpl(url, {signal: controller.signal});
            log.httpStatus = response.status;
            if (!response.ok) {
              // A public API access refusal is final; do not try alternate identities.
              const error = new Error(`GMO Coin HTTP ${response.status} (${url})`);
              error.retryable = response.status === 429 || response.status >= 500;
              const retryAfter = response.headers?.get?.('retry-after');
              if (retryAfter) {
                const seconds = Number(retryAfter);
                const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - clock();
                if (Number.isFinite(delay)) {
                  // Do not ignore a long server-requested pause or block a report indefinitely.
                  if (delay > 5000) {
                    error.retryable = false;
                    error.message += `; Retry-After requires waiting ${Math.ceil(delay / 1000)}s`;
                  } else retryDelay = Math.max(retryDelay, delay, 0);
                }
              }
              throw error;
            }
            let payload;
            try { payload = await response.json(); }
            catch (error) {
              const invalid = new Error(`Invalid GMO Coin JSON (${url}): ${errorText(error)}`);
              invalid.retryable = error?.name === 'AbortError';
              throw invalid;
            }
            if (!payload || payload.status !== 0) {
              const error = new Error(`GMO Coin API status ${payload?.status ?? 'missing'} (${url}): ${JSON.stringify(payload?.messages ?? []).slice(0, 500)}`);
              error.retryable = false;
              throw error;
            }
            log.responseUTC = payload.responsetime ?? null;
            log.rowCount = Array.isArray(payload.data) ? payload.data.length : null;
            return payload.data;
          } finally { clearTimeout(timer); }
        });
        log.fetchedUTC = new Date(clock()).toISOString();
        log.ok = true;
        delete log.error;
        return result;
      } catch (error) {
        log.error = errorText(error);
        log.ok = false;
        log.fetchedUTC = new Date(clock()).toISOString();
        const retryable = error?.retryable ?? (error instanceof TypeError || error?.name === 'AbortError' || error?.name === 'TimeoutError');
        if (!retryable || attempt >= maxAttempts) throw error;
        await sleepImpl(retryDelay);
      }
    }
  }

  function marketStatus() {
    if (!statusPromise) statusPromise = requestJson(`${BASE}/status`, 'market-status')
      .then(data => ({marketStatus: typeof data?.status === 'string' ? data.status : 'unknown', marketStatusFetchedUTC: new Date(clock()).toISOString()}))
      .catch(error => ({marketStatus: 'unknown', marketStatusFetchedUTC: new Date(clock()).toISOString(), marketStatusError: errorText(error)}));
    return statusPromise;
  }

  async function fetchPairCandles({symbol, now = Date.now(), quick = false} = {}) {
    if (!['ZAR_JPY', 'USD_JPY'].includes(symbol)) throw new Error(`Unsupported FX symbol: ${symbol}`);
    const current = timestamp(now);
    const days = quick ? QUICK_DAYS : NORMAL_DAYS;
    const from = Object.fromEntries(Object.entries(days).map(([frame, count]) => [frame, current - count * DAY]));
    // Extend to a whole Monday-start week, so subsequent weekly aggregation has
    // no truncated first week. This adds at most six full days to the lookback.
    const firstFullDay = Math.floor(from.d1 / DAY) * DAY;
    from.d1 = firstFullDay - ((new Date(firstFullDay).getUTCDay() + 6) % 7) * DAY;
    const status = await marketStatus();
    const logStart = requestLog.length;
    const candles = {m15: [], h1: [], h4: [], d1: []};
    const errors = {};
    const rawCounts = {};
    const partitions = {};
    const yearCache = new Map();
    const urlFor = (interval, date) => `${BASE}/klines?${new URLSearchParams({symbol, priceType: 'BID', interval, date})}`;

    async function fetchYears(years) {
      const all = [];
      for (const year of years) {
        if (!yearCache.has(year)) yearCache.set(year, requestJson(urlFor('4hour', year), `${symbol}/4hour/${year}`)
          .then(rows => parseCandles(rows, WINDOWS.h4)));
        all.push(...await yearCache.get(year));
      }
      return mergeCandles(all);
    }

    for (const [frame, interval] of [['m15', '15min'], ['h1', '1hour']]) {
      const dates = tradingDates(from[frame], current);
      partitions[frame] = dates;
      try {
        const rows = [];
        for (const date of dates) rows.push(...parseCandles(await requestJson(urlFor(interval, date), `${symbol}/${interval}/${date}`), WINDOWS[frame]));
        const relevant = mergeCandles(rows).filter(candle => candle.timestamp >= from[frame] && candle.timestamp <= current);
        rawCounts[frame] = relevant.length;
        candles[frame] = relevant.filter(candle => candle.timestamp + WINDOWS[frame] + confirmationGraceMs <= current);
      } catch (error) { errors[frame] = errorText(error); }
    }

    for (const frame of ['h4', 'd1']) {
      const years = yearsBetween(from[frame], current);
      partitions[frame] = years;
      try {
        const all = await fetchYears(years);
        const relevant = all.filter(candle => candle.timestamp >= from[frame] && candle.timestamp <= current);
        rawCounts[frame] = relevant.length;
        candles[frame] = frame === 'h4'
          ? relevant.filter(candle => candle.timestamp + WINDOWS.h4 + confirmationGraceMs <= current)
          : utcDailyFromFourHour(relevant, {from: from.d1, now: current, graceMs: confirmationGraceMs});
      } catch (error) { errors[frame] = errorText(error); }
    }

    const log = requestLog.slice(logStart);
    return {
      candles,
      errors,
      metadata: {
        source: SOURCE,
        provider: 'GMOコイン',
        documentation: 'https://api.coin.z.com/fxdocs/',
        endpoint: BASE,
        symbol,
        priceType: 'BID',
        accountQuotes: false,
        fetchedUTC: new Date(clock()).toISOString(),
        analysisAsOfUTC: new Date(current).toISOString(),
        ...status,
        closedOnly: true,
        confirmationGraceMs,
        requests: log.length,
        requestAttempts: log.reduce((sum, item) => sum + item.attempts, 0),
        requestLog: log,
        rawCounts,
        rawCountBasis: {m15: 'native 15min', h1: 'native 1hour', h4: 'native 4hour', d1: 'native 4hour input'},
        confirmedCounts: Object.fromEntries(Object.entries(candles).map(([frame, rows]) => [frame, rows.length])),
        requestedPartitions: partitions,
        lookbackStartUTC: Object.fromEntries(Object.entries(from).map(([frame, value]) => [frame, new Date(value).toISOString()])),
        frameSources: {m15: 'native 15min', h1: 'native 1hour', h4: 'native UTC 4hour', d1: 'UTC calendar days aggregated from native UTC 4hour'},
        aggregation: 'UTC 4h boundaries checked on every source row; UTC daily OHLC uses existing source bars only; no synthetic weekend/holiday candles; first daily date aligned to Monday UTC for complete weekly aggregation.',
        datePartition: 'Intraday YYYYMMDD changes at 06:00 JST (21:00 UTC); request date = UTC date of timestamp + 3h. Native 4hour requests use YYYY.',
        responseTimeNote: 'Historical yearly responses may retain an old responsetime; fetchedUTC is the actual retrieval time. Candle freshness is checked from candle close times.',
      },
    };
  }

  return {fetchPairCandles};
}
