import test from 'node:test';
import assert from 'node:assert/strict';
import {createGmoClient, gmoTradingDate, utcDailyFromFourHour} from '../src/gmo-public.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-25T16:02:00Z');
const response = (data, status = 200, headers = {}) => ({ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => ({status: 0, data, responsetime: '2026-11-25T16:02:00Z'})});
const apiCandle = (time, open = 150, high = 152, low = 149, close = 151) => ({openTime: String(time), open: String(open), high: String(high), low: String(low), close: String(close)});
const candle = (time, open = 150, high = 152, low = 149, close = 151) => ({timestamp: time, open, high, low, close});
function client(fetchImpl, options = {}) {
  return createGmoClient({fetchImpl, requestGapMs: 0, sleepImpl: async () => {}, clock: () => NOW, ...options});
}

test('GMO date flips at 06:00 JST, including year rollover', () => {
  assert.equal(gmoTradingDate(Date.parse('2026-11-25T20:59:59Z')), '20261125');
  assert.equal(gmoTradingDate(Date.parse('2026-11-25T21:00:00Z')), '20261126');
  assert.equal(gmoTradingDate(Date.parse('2026-12-31T21:00:00Z')), '20270101');
});

test('UTC daily OHLC keeps market gaps and excludes initial and final partial days', () => {
  const monday = Date.parse('2026-11-23T00:00:00Z');
  const rows = [
    candle(monday - DAY + 20 * HOUR, 140, 151, 138, 150),
    candle(monday + 20 * HOUR, 151, 155, 150, 154),
    candle(monday, 150, 153, 149, 152),
    candle(monday + 2 * DAY, 154, 156, 153, 155),
  ];
  assert.deepEqual(utcDailyFromFourHour(rows, {from: monday, now: monday + 2 * DAY + 5 * HOUR}), [candle(monday, 150, 155, 149, 154)]);
  assert.deepEqual(utcDailyFromFourHour(rows, {from: monday + HOUR, now: monday + 2 * DAY + 5 * HOUR}), []);
  assert.throws(() => utcDailyFromFourHour([candle(monday + HOUR)], {now: NOW}), /UTC-aligned/);
});

test('confirmed-only frames, 06 JST date partitions, and shared market status', async () => {
  const calls = [];
  const now = Date.parse('2026-11-25T21:01:00Z');
  const source = client(async rawUrl => {
    const url = new URL(rawUrl);
    calls.push(url);
    if (url.pathname.endsWith('/status')) return response({status: 'OPEN'});
    if (url.searchParams.get('interval') === '15min' && url.searchParams.get('date') === '20261125') {
      return response([apiCandle(Date.parse('2026-11-25T20:30:00Z')), apiCandle(Date.parse('2026-11-25T20:45:00Z'))]);
    }
    if (url.searchParams.get('interval') === '4hour') return response([apiCandle(Date.parse('2026-11-25T16:00:00Z')), apiCandle(Date.parse('2026-11-25T20:00:00Z'))]);
    return response([]);
  });
  const result = await source.fetchPairCandles({symbol: 'USD_JPY', now, quick: true});
  assert.deepEqual(result.candles.m15.map(row => row.timestamp), [Date.parse('2026-11-25T20:30:00Z')]);
  assert.deepEqual(result.candles.h4.map(row => row.timestamp), [Date.parse('2026-11-25T16:00:00Z')]);
  assert.deepEqual(result.metadata.requestedPartitions.m15, ['20261124', '20261125', '20261126']);
  assert.equal(result.metadata.marketStatus, 'OPEN');
  assert.equal(result.metadata.priceType, 'BID');
  assert.equal(result.metadata.closedOnly, true);
  await source.fetchPairCandles({symbol: 'ZAR_JPY', now, quick: true});
  assert.equal(calls.filter(url => url.pathname.endsWith('/status')).length, 1);
  assert.equal(calls.filter(url => url.searchParams.get('interval') === '4hour').length, 2, 'h4/d1 share one request per pair/year');
});

test('403 fails without retry, and a partial intraday history is never published', async () => {
  const calls = [];
  const source = client(async rawUrl => {
    const url = new URL(rawUrl);
    calls.push(url);
    if (url.pathname.endsWith('/status')) return response({status: 'OPEN'});
    if (url.searchParams.get('interval') === '15min') {
      if (url.searchParams.get('date') === '20261124') return response(null, 403);
      return response([apiCandle(Date.parse('2026-11-23T16:00:00Z'))]);
    }
    if (url.searchParams.get('interval') === '1hour' && url.searchParams.get('date') === '20261125') return response([apiCandle(Date.parse('2026-11-25T15:00:00Z'))]);
    return response([]);
  });
  const result = await source.fetchPairCandles({symbol: 'ZAR_JPY', now: NOW, quick: true});
  assert.match(result.errors.m15, /HTTP 403/);
  assert.deepEqual(result.candles.m15, []);
  assert.equal(result.candles.h1.length, 1);
  assert.equal(result.errors.h1, undefined);
  assert.equal(calls.filter(url => url.searchParams.get('interval') === '15min' && url.searchParams.get('date') === '20261124').length, 1);
  assert.equal(calls.filter(url => url.searchParams.get('interval') === '15min' && url.searchParams.get('date') === '20261125').length, 0);
});

test('old-year failure only invalidates dependent daily history; native h4 stays valid', async () => {
  let historicalAttempts = 0;
  const source = client(async rawUrl => {
    const url = new URL(rawUrl);
    if (url.pathname.endsWith('/status')) return response(null, 403);
    if (url.searchParams.get('interval') === '4hour') {
      if (url.searchParams.get('date') === '2025') {
        historicalAttempts++;
        return response(null, 503);
      }
      return response([apiCandle(Date.parse('2026-11-25T12:00:00Z'))]);
    }
    return response([]);
  });
  const result = await source.fetchPairCandles({symbol: 'USD_JPY', now: NOW});
  assert.equal(result.metadata.marketStatus, 'unknown');
  assert.match(result.metadata.marketStatusError, /403/);
  assert.equal(result.candles.h4.length, 1);
  assert.equal(result.errors.h4, undefined);
  assert.deepEqual(result.candles.d1, []);
  assert.match(result.errors.d1, /HTTP 503/);
  assert.equal(historicalAttempts, 3);
});

test('an unaligned row outside the requested window invalidates native h4 and daily', async () => {
  const source = client(async rawUrl => {
    const url = new URL(rawUrl);
    if (url.pathname.endsWith('/status')) return response({status: 'OPEN'});
    if (url.searchParams.get('interval') === '4hour') return response([
      apiCandle(Date.parse('2026-01-01T01:00:00Z')),
      apiCandle(Date.parse('2026-11-25T12:00:00Z')),
    ]);
    return response([]);
  });
  const result = await source.fetchPairCandles({symbol: 'USD_JPY', now: NOW, quick: true});
  assert.match(result.errors.h4, /not aligned/);
  assert.match(result.errors.d1, /not aligned/);
  assert.deepEqual(result.candles.h4, []);
  assert.deepEqual(result.candles.d1, []);
});
