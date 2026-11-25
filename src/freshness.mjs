const MINUTE=60_000;
const DAY=24*60*MINUTE;
const PERIODS={m15:15*MINUTE,h1:60*MINUTE,h4:4*60*MINUTE,d1:DAY,w1:7*DAY};
const CONFIRMATION_GRACE=2*MINUTE;
const MONDAY_UTC=Date.UTC(1970,0,5);

// Match closedOnly's two-minute grace. No weekend or holiday exemption:
// a missing latest UTC candle is deliberately reported as not updated.
export function markFreshness(summary,tf,marketStatus,now=Date.now()){
  if(summary.status!=='ok')return summary;
  const period=PERIODS[tf];
  if(!period||!Number.isFinite(now))throw new RangeError('Invalid timeframe or freshness cutoff');
  const anchor=tf==='w1'?MONDAY_UTC:0;
  const expectedClose=anchor+Math.floor((now-CONFIRMATION_GRACE-anchor)/period)*period;
  const expectedCloseUTC=new Date(expectedClose).toISOString();
  const result={...summary,expectedCloseUTC};
  const state=String(marketStatus??'UNKNOWN').toUpperCase();
  if(['CLOSE','CLOSED','PREOPEN'].includes(state)){
    return {...result,status:'market_closed',reason:'未更新/判定不可（取得元市場休場。指標値は最終確定足の参考値）'};
  }
  if(state==='MAINTENANCE'){
    return {...result,status:'unavailable',reason:'未更新/判定不可（取得元市場メンテナンス）'};
  }
  const latestClose=Date.parse(summary.latestCloseUTC);
  if(!Number.isFinite(latestClose)){
    return {...result,status:'unavailable',reason:'未更新/判定不可（最新確定足時刻を確認できません）'};
  }
  if(latestClose<expectedClose){
    return {...result,status:'stale',reason:'未更新/判定不可（期待する最新確定足 '+expectedCloseUTC+' に未到達）'};
  }
  if(latestClose>expectedClose){
    return {...result,status:'unavailable',reason:'未更新/判定不可（足の時刻が確定猶予後のUTC区切りと一致しません）'};
  }
  return result;
}
