import fs from 'node:fs/promises';
import {createGmoClient} from './gmo-public.mjs';
import {normalizeCandles,closedOnly,weeksFromDaily,summarize} from './indicators.mjs';
import {renderAnnotatedChart} from './charts.mjs';
import {markFreshness} from './freshness.mjs';

// FX_QUICK_CHECK=1 limits data lookback for first connection test.
// First verify that both instruments are available; a quick check is NOT the full production analysis.
const quick=process.env.FX_QUICK_CHECK==='1';
const now=Date.now();
const pairs=[{symbol:'ZAR/JPY',apiSymbol:'ZAR_JPY',instrument:'zarjpy',account:'みんなのFX'},{symbol:'USD/JPY',apiSymbol:'USD_JPY',instrument:'usdjpy',account:'GMOクリック証券'}];
const source='GMO Coin Forex Public API (BID OHLC)';
const report={schemaVersion:2,generatedUTC:new Date(now).toISOString(),requestedCutoffUTC:new Date(now).toISOString(),source,priceType:'BID',sourceURL:'https://api.coin.z.com/fxdocs/',sourceNotice:'市場参照データはGMOコインの配信です。みんなのFX・GMOクリック証券の口座価格ではありません。過去のDukascopy系列とは接続せず、全時間足を同一ソースから再計算します。',boundaries:{m15:'UTC 00/15/30/45 minutes',h1:'UTC hour',h4:'UTC 00/04/08/12/16/20',d1:'UTC 00:00 (aggregated from verified 4-hour candles)',w1:'Monday 00:00 UTC (aggregated from UTC daily candles)'},runId:process.env.GITHUB_RUN_ID??null,runAttempt:process.env.GITHUB_RUN_ATTEMPT??null,runStartedUTC:process.env.FX_RUN_STARTED_UTC??new Date(now).toISOString(),quickCheck:quick,marketDataOnly:true,accountsNotConnected:true,pairs:{}};
const client=createGmoClient();
const toJst=iso=>new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(iso));
const price=(n,s)=>typeof n==='number'&&Number.isFinite(n)?n.toFixed(s==='ZAR/JPY'?4:3):'未取得';
const level=(p,s)=>price(p.price,s);
await fs.rm('reports/charts',{recursive:true,force:true});
await fs.mkdir('reports/charts',{recursive:true});
for(const pair of pairs){
  const frames={},errors=[],candleSets={};let completedDaily=null;
  console.log('Fetching '+pair.symbol+' from GMO Coin public BID OHLC');
  const fetched=await client.fetchPairCandles({symbol:pair.apiSymbol,now,quick});
  const marketStatus=fetched.metadata?.marketStatus??'UNKNOWN';
  for(const frame of ['m15','h1','h4','d1']){
    try{
      if(fetched.errors?.[frame])throw Error(fetched.errors[frame]);
      const rows=fetched.candles[frame]??[];
      const clean=closedOnly(normalizeCandles(rows),frame,now);
      candleSets[frame]=clean;
      if(frame==='d1')completedDaily=clean;
      const result=summarize(clean,frame,now);
      frames[frame]={...markFreshness(result,frame,marketStatus,now),source,priceType:'BID',rawCount:fetched.metadata?.rawCounts?.[frame]??rows.length,rawCountBasis:fetched.metadata?.rawCountBasis?.[frame]??'source candles',confirmedCount:clean.length};
      if(!clean.length)errors.push(frame+': no confirmed candles');
    }catch(e){
      frames[frame]={status:'unavailable',error:String(e.message||e)};
      errors.push(frame+': '+String(e.message||e));
    }
  }
  if(completedDaily?.length){
    const weeks=weeksFromDaily(completedDaily,now-120000);
    candleSets.w1=weeks.closed;
    frames.w1={...markFreshness(summarize(weeks.closed,'w1',now),'w1',marketStatus,now),source,priceType:'BID',formingWeek:weeks.forming};
  }else{
    frames.w1={status:'unavailable',error:'daily candles were not retrieved'};
    errors.push('w1: daily candles missing');
  }
  report.pairs[pair.symbol]={account:pair.account,source,priceType:'BID',marketStatus,fetch:fetched.metadata,frames,charts:{},errors};
  report.pairs[pair.symbol]._candleSets=candleSets;
}
// Use one generation timestamp for the JSON, Markdown and all ten images.
report.generatedUTC=new Date().toISOString();
for(const pair of pairs){
  const p=report.pairs[pair.symbol],{frames,errors}=p,candleSets=p._candleSets,charts={};
  for(const tf of ['m15','h1','h4','d1','w1']){
    if(frames[tf]?.status!=='ok'||!candleSets[tf]?.length)continue;
    const file='charts/'+pair.instrument+'_'+tf+'.svg';
    try{
      const svg=renderAnnotatedChart({symbol:pair.symbol,timeframe:tf,candles:candleSets[tf],summary:frames[tf],generatedUTC:report.generatedUTC,source:'GMOコイン公式FX公開API / BID',account:pair.account});
      await fs.writeFile('reports/'+file,svg,'utf8');
      charts[tf]=file;
    }catch(e){errors.push('chart '+tf+': '+String(e.message||e));}
  }
  p.charts=charts;
  delete p._candleSets;
}
const lines=[
  '# FX 5時間足 データ確認（'+toJst(report.generatedUTC)+' JST）',
  '取得元：'+report.source+'。口座情報は未連携。実際の売買価格は各社のBid/Askを使用してください。',
  report.sourceNotice,
  '取得開始/判定基準：'+toJst(report.requestedCutoffUTC)+' JST。画像生成：'+toJst(report.generatedUTC)+' JST。',
  quick?'**接続テスト用の短期間データです。本番レポートとは別に扱い、40本未満の時間足は判定できません。**':'確定足のみ使用（終了後2分の確認猶予）。4時間足・日足はUTC区切り、週足は月曜日UTCで日足から集計。GMOコインのnative日足（JST06時区切り）は使用しません。'
];
for(const [sym,p] of Object.entries(report.pairs)){
  lines.push('\n## '+sym+'（'+p.account+'）');
  lines.push('分析対象口座：'+p.account+'／価格参照：GMOコイン BID／取得元市場状態：'+p.marketStatus);
  if(p.charts.h4)lines.push('\n**注釈付き4時間足チャート（重要高安値・支持・抵抗を書き込み）**\n\n!['+sym+' 4時間足・注釈付き](./'+p.charts.h4+')\n');
  const chartLinks=['m15','h1','h4','d1','w1'].filter(tf=>p.charts[tf]).map(tf=>'['+({m15:'15分',h1:'1時間',h4:'4時間',d1:'日足',w1:'週足'}[tf])+'](./'+p.charts[tf]+')');
  if(chartLinks.length)lines.push('**全5時間足の注釈チャート**：'+chartLinks.join(' / '));
  for(const frame of ['m15','h1','h4','d1','w1']){
    const x=p.frames[frame];
    if(x.status!=='ok'){
      const reason=x.error||x.reason||('確定足不足 ('+(x.count??0)+'本)');
      lines.push('- '+frame+'：未更新/判定不可（'+reason+'）'+(x.latestCloseUTC?'、最終確定 '+toJst(x.latestCloseUTC)+' JST':'')+(x.confirmedCount!==undefined?'、取得確定足 '+x.confirmedCount+'本':''));
      continue;
    }
    lines.push('- '+frame+'：最新確定 '+toJst(x.latestCloseUTC)+' JST、終値 '+price(x.close,sym)+'、ダウ '+x.trend+'、RSI14 '+(x.rsi14?.toFixed(1)??'未取得')+'、MACD '+price(x.macd12269?.macd,sym)+' / signal '+price(x.macd12269?.signal,sym)+'、直近高値 '+x.importantHighs.map(v=>level(v,sym)).join(' / ')+'、直近安値 '+x.importantLows.map(v=>level(v,sym)).join(' / ')+'、支持候補 '+x.supports.map(v=>level(v,sym)).join(' / ')+'、抵抗候補 '+x.resistances.map(v=>level(v,sym)).join(' / '));
    if(frame==='m15'&&x.ageHours>3)lines.push('  - 注意：15分足が'+x.ageHours+'時間更新されていません。休場や取得先の遅延を確認してください。');
  }
  if(p.errors.length)lines.push('- 取得エラー: '+p.errors.join(' / '));
}
lines.push('\n口座残高・建玉・必要証拠金・ロスカット水準は自動取得しません。');
await fs.mkdir('reports',{recursive:true});
await Promise.all([
  fs.writeFile('reports/latest.json',JSON.stringify(report,null,2)),
  fs.writeFile('reports/latest.md',lines.join('\n')+'\n')
]);
console.log(lines.join('\n'));
const gotBoth=pairs.every(p=>['m15','h1','h4','d1'].every(tf=>report.pairs[p.symbol].frames[tf].rawCount>0));
if(!gotBoth)process.exitCode=1;
if(!quick&&Object.values(report.pairs).some(p=>p.errors.length||Object.values(p.frames).some(x=>!['ok','market_closed'].includes(x.status))))process.exitCode=1;
