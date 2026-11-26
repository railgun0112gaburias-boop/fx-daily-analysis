import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {finalizeRun} from '../src/finalize-run.mjs';

const generatedUTC='2026-11-25T22:50:00.000Z';
const context={runStartedUTC:'2026-11-25T22:49:00.000Z',runId:'run-26',runAttempt:'1',now:Date.parse('2026-11-25T22:51:00.000Z'),analysisOutcome:'success'};
const frameNames=['m15','h1','h4','d1','w1'];
const pairSpecs=[['ZAR/JPY','みんなのFX','zarjpy'],['USD/JPY','GMOクリック証券','usdjpy']];

async function fixture(t) {
  const reportsDir=await fs.mkdtemp(path.join(os.tmpdir(),'fx-finalize-'));
  t.after(()=>fs.rm(reportsDir,{recursive:true,force:true}));
  await fs.mkdir(path.join(reportsDir,'charts'));
  const report={generatedUTC,runId:context.runId,runAttempt:context.runAttempt,source:'GMOコイン FX Public API (BID OHLC)',pairs:{}};
  for(const [symbol,account,instrument] of pairSpecs) {
    const entry={account,frames:{},charts:{},errors:[]};report.pairs[symbol]=entry;
    for(const timeframe of frameNames) {
      const latestCloseUTC='2026-11-25T22:00:00.000Z';
      entry.frames[timeframe]={status:'ok',latestCloseUTC,close:symbol==='ZAR/JPY'?9:159,trend:'混在',rsi14:50,macd12269:{macd:0,signal:0},supports:[],resistances:[],importantHighs:[],importantLows:[]};
      const relative=`charts/${instrument}_${timeframe}.svg`;entry.charts[timeframe]=relative;
      const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1180" height="620"><metadata>${JSON.stringify({symbol,timeframe,generatedUTC,latestCloseUTC})}</metadata><rect width="1180" height="620" fill="#101b2b"/><text x="10" y="30">確定高値 ${symbol}</text></svg>`;
      await fs.writeFile(path.join(reportsDir,relative),svg);
    }
  }
  await fs.writeFile(path.join(reportsDir,'latest.json'),JSON.stringify(report));
  return {reportsDir,report};
}

test('publishes a verified current attempt with all 10 matching charts',async t=>{
  const {reportsDir}=await fixture(t);
  const result=await finalizeRun({...context,reportsDir});
  assert.equal(result.status,'success');assert.equal(result.publishable,true);assert.equal(result.failed,false);
  assert.equal(result.chartCount,10);
  assert.equal(result.pngChartCount,10);
  const markdown=await fs.readFile(path.join(reportsDir,'latest.md'),'utf8');
  assert.match(markdown,/ZAR\/JPY（みんなのFX）/);assert.match(markdown,/USD\/JPY（GMOクリック証券）/);
  assert.match(markdown,/!\[ZAR\/JPY 注釈付き4時間足\]\(\.\/charts\/zarjpy_h4\.png\)/);
  const report=JSON.parse(await fs.readFile(path.join(reportsDir,'latest.json'),'utf8'));
  assert.equal(report.pairs['ZAR/JPY'].chartArtifacts.h4.generatedUTC,generatedUTC);
  assert.equal(report.pairs['ZAR/JPY'].chartArtifacts.h4.width,2360);
  assert.equal(report.pairs['ZAR/JPY'].chartArtifacts.h4.height,1240);
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  assert.equal(report.pairs['ZAR/JPY'].chartArtifacts.h4.sourceSvgSha256,hash(await fs.readFile(path.join(reportsDir,'charts/zarjpy_h4.svg'))));
  assert.equal(report.pairs['ZAR/JPY'].chartArtifacts.h4.pngSha256,hash(await fs.readFile(path.join(reportsDir,'charts/zarjpy_h4.png'))));
});

test('a failed run replaces an old success snapshot and removes its images',async t=>{
  const {reportsDir,report}=await fixture(t);
  report.generatedUTC='2026-11-22T22:48:54.160Z';
  await fs.writeFile(path.join(reportsDir,'latest.json'),JSON.stringify(report));
  const result=await finalizeRun({...context,reportsDir,analysisOutcome:'failure'});
  assert.equal(result.status,'failed');assert.equal(result.publishable,true);assert.equal(result.failed,true);
  const actual=JSON.parse(await fs.readFile(path.join(reportsDir,'latest.json'),'utf8'));
  assert.equal(actual.generatedUTC,new Date(context.now).toISOString());
  assert.equal(actual.pairs['ZAR/JPY'].frames.m15.status,'unavailable');
  assert.deepEqual(actual.pairs['USD/JPY'].charts,{});assert.deepEqual(await fs.readdir(path.join(reportsDir,'charts')),[]);
});

test('a partial run retains only current usable charts and rejects mismatched images',async t=>{
  const {reportsDir,report}=await fixture(t);
  report.pairs['ZAR/JPY'].frames.m15={status:'unavailable',error:'HTTP 403'};
  report.pairs['ZAR/JPY'].errors=['m15: HTTP 403'];
  await fs.writeFile(path.join(reportsDir,'charts/zarjpy_m15.png'),'old PNG');
  await fs.writeFile(path.join(reportsDir,'latest.json'),JSON.stringify(report));
  const usdChart=path.join(reportsDir,'charts/usdjpy_h4.svg');
  const svg=await fs.readFile(usdChart,'utf8');
  await fs.writeFile(usdChart,svg.replace(generatedUTC,'2026-11-22T22:00:00.000Z'));
  const result=await finalizeRun({...context,reportsDir,analysisOutcome:'failure'});
  assert.equal(result.status,'partial');assert.equal(result.chartCount,8);assert.equal(result.failed,true);
  const actual=JSON.parse(await fs.readFile(path.join(reportsDir,'latest.json'),'utf8'));
  assert.equal(actual.pairs['USD/JPY'].frames.h4.status,'ok');assert.match(actual.pairs['USD/JPY'].frames.h4.chartError,/一致/);
  assert.equal(actual.pairs['ZAR/JPY'].charts.m15,undefined);assert.equal(actual.pairs['USD/JPY'].charts.h4,undefined);
  const files=await fs.readdir(path.join(reportsDir,'charts'));
  assert.equal(files.includes('zarjpy_m15.svg'),false);assert.equal(files.includes('usdjpy_h4.svg'),false);
  assert.equal(files.includes('zarjpy_m15.png'),false);
});

test('missing or foreign-attempt results cannot publish old successful data',async t=>{
  const {reportsDir,report}=await fixture(t);
  report.runId='another-run';
  await fs.writeFile(path.join(reportsDir,'latest.json'),JSON.stringify(report));
  const result=await finalizeRun({...context,reportsDir});
  assert.equal(result.status,'failed');assert.match(result.errors.join(' '),/実行ID/);
  await fs.writeFile(path.join(reportsDir,'latest.json'),'{broken');
  const broken=await finalizeRun({...context,reportsDir,analysisOutcome:'skipped'});
  assert.equal(broken.status,'failed');assert.match(broken.errors.join(' '),/読み込めません/);
});

test('a quick connection check does not publish or rewrite production artifacts',async t=>{
  const {reportsDir}=await fixture(t);
  const before=await fs.readFile(path.join(reportsDir,'latest.json'),'utf8');
  const result=await finalizeRun({...context,reportsDir,quickCheck:true});
  assert.equal(result.publishable,false);
  assert.equal(await fs.readFile(path.join(reportsDir,'latest.json'),'utf8'),before);
});

test('a current all-unavailable report preserves the actual fetch errors',async t=>{
  const {reportsDir,report}=await fixture(t);
  for(const entry of Object.values(report.pairs)) {
    entry.frames=Object.fromEntries(frameNames.map(frame=>[frame,{status:'unavailable',error:'HTTP 403'}]));
    entry.errors=['HTTP 403'];
  }
  await fs.writeFile(path.join(reportsDir,'latest.json'),JSON.stringify(report));
  const result=await finalizeRun({...context,reportsDir,analysisOutcome:'failure'});
  assert.equal(result.status,'failed');assert.equal(result.reportGeneratedUTC,generatedUTC);
  assert.match(result.errors.join(' '),/HTTP 403/);assert.deepEqual(await fs.readdir(path.join(reportsDir,'charts')),[]);
});

test('a verified market closure is recorded without making it a fetch failure',async t=>{
  const {reportsDir,report}=await fixture(t);
  for(const entry of Object.values(report.pairs)) for(const item of Object.values(entry.frames)) item.status='market_closed';
  await fs.writeFile(path.join(reportsDir,'latest.json'),JSON.stringify(report));
  const result=await finalizeRun({...context,reportsDir});
  assert.equal(result.status,'market_closed');assert.equal(result.failed,false);assert.equal(result.closedFrames,10);
  assert.equal(result.chartCount,0);assert.deepEqual(await fs.readdir(path.join(reportsDir,'charts')),[]);
});
