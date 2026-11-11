import fs from 'node:fs/promises';
import {getHistoricalRates} from 'dukascopy-node';
import {normalizeCandles,closedOnly,weeksFromDaily,summarize} from './indicators.mjs';
import {renderAnnotatedChart} from './charts.mjs';

// FX_QUICK_CHECK=1 limits data lookback for first connection test.
// First verify that both instruments are available; a quick check is NOT the full production analysis.
const quick=process.env.FX_QUICK_CHECK==='1';
const config=quick?{m15:2,h1:3,h4:4,d1:7}:{m15:15,h1:45,h4:100,d1:400};
const now=Date.now();
const pairs=[{symbol:'ZAR/JPY',instrument:'zarjpy',account:'みんなのFX'},{symbol:'USD/JPY',instrument:'usdjpy',account:'GMOクリック証券'}];
const report={generatedUTC:new Date(now).toISOString(),source:'Dukascopy via dukascopy-node (Bid OHLC)',quickCheck:quick,marketDataOnly:true,accountsNotConnected:true,pairs:{}};
const toJst=iso=>new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(iso));
const price=(n,s)=>typeof n==='number'&&Number.isFinite(n)?n.toFixed(s==='ZAR/JPY'?4:3):'未取得';
const level=(p,s)=>price(p.price,s);
await fs.rm('reports/charts',{recursive:true,force:true});
await fs.mkdir('reports/charts',{recursive:true});
for(const pair of pairs){
  const frames={},errors=[],candleSets={};let completedDaily=null;
  for(const [frame,days] of Object.entries(config)){
    try{
      const rows=await getHistoricalRates({
        instrument:pair.instrument,
        dates:{from:new Date(now-days*86400000),to:new Date(now)},
        timeframe:frame,priceType:'bid',format:'json',volumes:false,ignoreFlats:true,
        batchSize:8,pauseBetweenBatchesMs:500,retryCount:2,failAfterRetryCount:true
      });
      const clean=closedOnly(normalizeCandles(rows),frame,now);
      candleSets[frame]=clean;
      if(frame==='d1')completedDaily=clean;
      const result=summarize(clean,frame,now);
      frames[frame]={...result,rawCount:rows.length,confirmedCount:clean.length};
      if(!clean.length)errors.push(frame+': no confirmed candles');
    }catch(e){
      frames[frame]={status:'unavailable',error:String(e.message||e)};
      errors.push(frame+': '+String(e.message||e));
    }
  }
  if(completedDaily?.length){
    const weeks=weeksFromDaily(completedDaily,now);
    candleSets.w1=weeks.closed;
    frames.w1={...summarize(weeks.closed,'w1',now),formingWeek:weeks.forming};
  }else{
    frames.w1={status:'unavailable',error:'daily candles were not retrieved'};
    errors.push('w1: daily candles missing');
  }
  const charts={};
  for(const tf of ['m15','h1','h4','d1','w1']){
    if(frames[tf]?.status!=='ok'||!candleSets[tf]?.length)continue;
    const file='charts/'+pair.instrument+'_'+tf+'.svg';
    try{
      const svg=renderAnnotatedChart({symbol:pair.symbol,timeframe:tf,candles:candleSets[tf],summary:frames[tf],generatedUTC:report.generatedUTC});
      await fs.writeFile('reports/'+file,svg,'utf8');
      charts[tf]=file;
    }catch(e){errors.push('chart '+tf+': '+String(e.message||e));}
  }
  report.pairs[pair.symbol]={account:pair.account,frames,charts,errors};
}
const lines=[
  '# FX 5時間足 データ確認（'+toJst(report.generatedUTC)+' JST）',
  '取得元：'+report.source+'。口座情報は未連携。実際の売買価格は各社のBid/Askを使用してください。',
  quick?'**初回接続テスト用の短期間データです。40本未満の時間足は判定できません。**':'確定足のみ使用。4時間足・日足はUTC区切り、週足は月曜日UTCで日足から集計。'
];
for(const [sym,p] of Object.entries(report.pairs)){
  lines.push('\n## '+sym+'（'+p.account+'）');
  if(p.charts.h4)lines.push('\n**注釈付き4時間足チャート（重要高安値・支持・抵抗を書き込み）**\n\n!['+sym+' 4時間足・注釈付き](./'+p.charts.h4+')\n');
  const chartLinks=['m15','h1','h4','d1','w1'].filter(tf=>p.charts[tf]).map(tf=>'['+({m15:'15分',h1:'1時間',h4:'4時間',d1:'日足',w1:'週足'}[tf])+'](./'+p.charts[tf]+')');
  if(chartLinks.length)lines.push('**全5時間足の注釈チャート**：'+chartLinks.join(' / '));
  for(const frame of ['m15','h1','h4','d1','w1']){
    const x=p.frames[frame];
    if(x.status!=='ok'){
      const reason=x.error||x.reason||('確定足不足 ('+(x.count??0)+'本)');
      lines.push('- '+frame+'：データ未取得／判定不可（'+reason+'）'+(x.confirmedCount!==undefined?'、取得確定足 '+x.confirmedCount+'本':''));
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
const gotBoth=pairs.every(p=>Object.values(report.pairs[p.symbol].frames).slice(0,4).every(f=>f.rawCount>0));
if(!gotBoth)process.exitCode=1;
if(!quick&&Object.values(report.pairs).some(p=>Object.values(p.frames).some(x=>x.status!=='ok')))process.exitCode=1;
