// Publish only the current attempt's report. A failed fetch must never leave an
// older success report or SVG looking current.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {renderChartPng} from './png-charts.mjs';

const frames = ['m15','h1','h4','d1','w1'];
const pairs = [
  {symbol:'ZAR/JPY',account:'みんなのFX',instrument:'zarjpy'},
  {symbol:'USD/JPY',account:'GMOクリック証券',instrument:'usdjpy'}
];
const source = 'GMOコイン FX Public API (BID OHLC)';
const frameNames = {m15:'15分足',h1:'1時間足',h4:'4時間足',d1:'日足',w1:'週足'};
const price = (value,symbol) => Number.isFinite(value) ? value.toFixed(symbol==='ZAR/JPY'?4:3) : '未取得';
const escapeCell = value => String(value??'').replaceAll('|','\\|').replaceAll('\n',' ');
const decodeXml = value => value.replace(/&(quot|apos|lt|gt|amp);/g,(_,name)=>({quot:'"',apos:"'",lt:'<',gt:'>',amp:'&'}[name]));

function unavailableReport({now,runStartedUTC,runId,runAttempt,reason}) {
  return {
    generatedUTC:new Date(now).toISOString(),runStartedUTC,runId,runAttempt,
    source,quickCheck:false,marketDataOnly:true,accountsNotConnected:true,
    pairs:Object.fromEntries(pairs.map(pair=>[pair.symbol,{
      account:pair.account,
      frames:Object.fromEntries(frames.map(frame=>[frame,{status:'unavailable',error:reason}])),
      charts:{},errors:[reason]
    }]))
  };
}

function reportProblem(report,{runStartedUTC,runId,runAttempt,now}) {
  const generated=Date.parse(report?.generatedUTC),started=Date.parse(runStartedUTC);
  if(!Number.isFinite(started)) return '今回の実行開始時刻が確認できません。';
  if(!Number.isFinite(generated)||generated<started||generated>now+120000) return '今回の実行で生成されたレポートを確認できません（旧データまたは不正な生成日時）。';
  if(report.quickCheck) return '接続確認用の短期データは本番レポートとして公開できません。';
  if(runId&&String(report.runId)!==String(runId)) return 'レポートの実行IDが今回のGitHub Actions実行と一致しません。';
  if(runAttempt&&String(report.runAttempt)!==String(runAttempt)) return 'レポートの試行番号が今回のGitHub Actions実行と一致しません。';
  for(const pair of pairs) {
    const entry=report.pairs?.[pair.symbol];
    if(entry?.account!==pair.account||frames.some(frame=>!entry.frames?.[frame])) return '通貨ペア・口座・時間足の構成が不正です。';
    if(entry.errors!==undefined&&!Array.isArray(entry.errors)) return '取得エラー情報の形式が不正です。';
  }
  return null;
}

async function chartProblem(file,expected) {
  let svg;
  try { svg=await fs.readFile(file,'utf8'); }
  catch { return '今回のチャートファイルがありません。'; }
  if(!/^\s*<svg\b/.test(svg)||!svg.trimEnd().endsWith('</svg>')) return 'チャートのSVG形式が不正です。';
  const metadata=svg.match(/<metadata(?:\s[^>]*)?>([\s\S]*?)<\/metadata>/);
  if(!metadata) return 'チャートの生成・確定日時を照合できません。';
  try {
    const actual=JSON.parse(decodeXml(metadata[1]));
    if(Object.entries(expected).some(([key,value])=>actual[key]!==value)) return 'チャートの通貨ペア・時間足・生成日時・確定日時がJSONと一致しません。';
  } catch { return 'チャートの日時メタデータが不正です。'; }
  return null;
}

function markdown(report,status) {
  const lines=[
    '# FX 5時間足 データ確認',
    '',
    `生成日時（UTC）：${report.generatedUTC} ／ 実行状態：**${status.status}**`,
    `取得元：${report.source}。`,
    report.sourceNotice??'GMOコインの公開市場データであり、みんなのFX・GMOクリック証券の口座価格ではありません。',
    '口座情報は未連携です。売買量・口座残高・建玉・証拠金維持率・強制ロスカット水準は取得していません。',
    report.boundaryNotes??(report.boundaries?`時間足境界：${Object.entries(report.boundaries).map(([frame,boundary])=>`${frameNames[frame]??frame}=${boundary}`).join(' ／ ')}。取引業者のチャートとは一致しない場合があります。`:'各時間足の区切りはJSONのデータ仕様を確認してください。取引業者のチャートとは一致しない場合があります。'),
    report.requestedCutoffUTC?`取得開始・判定基準（UTC）：${report.requestedCutoffUTC}`:'',
    status.runUrl?`[GitHub Actions実行記録](${status.runUrl})`:'',
    ''
  ];
  if(status.status!=='success') lines.push('**未更新／判定不可の時間足があります。取得できなかった足・旧チャートを現在の発注根拠として利用しないでください。**','');
  for(const pair of pairs) {
    const entry=report.pairs[pair.symbol];
    lines.push(`## ${pair.symbol}（${pair.account}）`,'');
    if(entry.pngCharts.h4) lines.push(`![${pair.symbol} 注釈付き4時間足](./${entry.pngCharts.h4})`,'');
    else if(entry.charts.h4) lines.push(`4時間足PNG：未生成。 [確認済みSVGを開く](./${entry.charts.h4})`,'');
    else lines.push('4時間足チャート：未生成／未更新。旧画像は掲載していません。','');
    const links=frames.filter(frame=>entry.charts[frame]).map(frame=>entry.pngCharts[frame]?`[${frameNames[frame]} PNG](./${entry.pngCharts[frame]}) / [SVG](./${entry.charts[frame]})`:`[${frameNames[frame]} SVG](./${entry.charts[frame]})`);
    if(links.length) lines.push(links.join(' / '),'');
    lines.push('| 足 | 状態・最新確定UTC | 終値 | ダウ | RSI14 | MACD / Signal |','|---|---|---|---|---|---|');
    for(const frame of frames) {
      const item=entry.frames[frame];
      if(item.status!=='ok') {
        const reason=escapeCell(item.error??item.reason??item.status);
        const last=item.latestCloseUTC?`（最終取得確定UTC：${escapeCell(item.latestCloseUTC)}）`:'';
        lines.push(`| ${frameNames[frame]} | 未更新／判定不可：${reason}${last} | — | — | — | — |`);
        continue;
      }
      lines.push(`| ${frameNames[frame]} | ${item.latestCloseUTC} | ${price(item.close,pair.symbol)} | ${escapeCell(item.trend)} | ${Number.isFinite(item.rsi14)?item.rsi14.toFixed(1):'未取得'} | ${price(item.macd12269?.macd,pair.symbol)} / ${price(item.macd12269?.signal,pair.symbol)} |`);
    }
    lines.push('');
    for(const frame of frames) {
      const item=entry.frames[frame];
      if(item.status!=='ok') continue;
      const levels=key=>(item[key]??[]).map(point=>price(point.price,pair.symbol)).join(' / ')||'候補なし';
      lines.push(`- ${frameNames[frame]}：確定高値 ${levels('importantHighs')}、確定安値 ${levels('importantLows')}、支持候補 ${levels('supports')}、抵抗候補 ${levels('resistances')}。`);
      if(item.chartError) lines.push(`  チャート未生成：${escapeCell(item.chartError)}`);
    }
    if(entry.errors?.length) lines.push('',...entry.errors.map(error=>`- 取得・生成エラー：${escapeCell(error)}`));
    lines.push('');
  }
  lines.push('チャートの観察点は条件未確認の候補です。実際の各業者のBid/Ask・スプレッドと新しい確定足を確認してください。','');
  return lines.filter(line=>line!==undefined).join('\n');
}

export async function finalizeRun({reportsDir='reports',runStartedUTC,runId=null,runAttempt=null,runUrl=null,analysisOutcome='unknown',now=Date.now(),quickCheck=false}={}) {
  if(quickCheck) return {status:'quick_check',publishable:false,failed:analysisOutcome!=='success'};
  await fs.mkdir(reportsDir,{recursive:true});
  let report,problem;
  try { report=JSON.parse(await fs.readFile(path.join(reportsDir,'latest.json'),'utf8')); }
  catch { problem='今回の分析結果を読み込めません（分析未実行・JSON未生成・破損）。'; }
  if(!problem) problem=reportProblem(report,{runStartedUTC,runId,runAttempt,now});
  const reasons=[];
  if(problem) {
    reasons.push(problem);
    report=unavailableReport({now,runStartedUTC,runId,runAttempt,reason:problem});
  }
  if(analysisOutcome!=='success') reasons.push(`分析ステップの結果：${analysisOutcome}。実行ログを確認してください。`);
  const keep=new Set();
  let ok=0,closed=0,chartCount=0,pngChartCount=0;
  for(const pair of pairs) {
    const entry=report.pairs[pair.symbol];
    entry.charts??={};entry.errors??=[];
    // These are regenerated solely from this attempt's verified SVG files.
    entry.pngCharts={};entry.chartArtifacts={};
    for(const frame of frames) {
      const item=entry.frames[frame];
      if(item.status==='market_closed') closed++;
      if(item.status!=='ok') { delete entry.charts[frame];continue; }
      if(!Number.isFinite(item.close)||!Number.isFinite(Date.parse(item.latestCloseUTC))||Date.parse(item.latestCloseUTC)>Date.parse(report.generatedUTC)) {
        item.status='unavailable';item.error='確定終値・確定日時が不正です。';
        entry.errors.push(`${frame}: ${item.error}`);delete entry.charts[frame];continue;
      }
      ok++;
      const relative=`charts/${pair.instrument}_${frame}.svg`;
      const error=entry.charts[frame]!==relative ? 'チャートの参照先が不正または未生成です。' : await chartProblem(path.join(reportsDir,relative),{
        symbol:pair.symbol,timeframe:frame,generatedUTC:report.generatedUTC,latestCloseUTC:item.latestCloseUTC
      });
      if(error) {
        item.chartError=error;delete entry.charts[frame];
        entry.errors.push(`${frame}: ${error}`);
      } else {
        keep.add(path.basename(relative));chartCount++;delete item.chartError;
        const pngRelative=relative.replace(/\.svg$/,'.png');
        try {
          const artifact=await renderChartPng(path.join(reportsDir,relative),path.join(reportsDir,pngRelative),{
            symbol:pair.symbol,timeframe:frame,generatedUTC:report.generatedUTC,latestCloseUTC:item.latestCloseUTC,
            svg:relative,png:pngRelative
          });
          entry.pngCharts[frame]=pngRelative;entry.chartArtifacts[frame]=artifact;
          keep.add(path.basename(pngRelative));pngChartCount++;
        } catch(error) {
          item.chartError='PNG生成失敗：'+error.message;
          entry.errors.push(`${frame}: ${item.chartError}`);
        }
      }
    }
    // Unknown references are not permitted, even if no renderer used them.
    entry.charts=Object.fromEntries(frames.filter(frame=>entry.charts[frame]).map(frame=>[frame,entry.charts[frame]]));
  }
  const chartDir=path.join(reportsDir,'charts');
  await fs.mkdir(chartDir,{recursive:true});
  for(const file of await fs.readdir(chartDir)) if(!keep.has(file)) await fs.rm(path.join(chartDir,file),{recursive:true,force:true});
  const complete=ok+closed===pairs.length*frames.length&&chartCount===ok&&pngChartCount===ok;
  const hasErrors=Object.values(report.pairs).some(entry=>entry.errors.length>0);
  const healthy=complete&&!hasErrors&&analysisOutcome==='success'&&!problem;
  const status={
    generatedUTC:new Date(now).toISOString(),runStartedUTC,runId,runAttempt,runUrl,
    status:healthy?(closed?'market_closed':'success'):(ok?'partial':'failed'),
    analysisOutcome,reportGeneratedUTC:report.generatedUTC,availableFrames:ok,closedFrames:closed,chartCount,pngChartCount,
    errors:[...reasons,...pairs.flatMap(pair=>report.pairs[pair.symbol].errors.map(error=>`${pair.symbol}: ${error}`))]
  };
  report.runStatus=status.status;report.runUrl=runUrl;
  // Write temp siblings then rename, so an interrupted finalizer cannot advertise
  // a publishable run until all three files have been written successfully.
  const outputs={'latest.json':JSON.stringify(report,null,2)+'\n','latest.md':markdown(report,status),'status.json':JSON.stringify(status,null,2)+'\n'};
  for(const [file,content] of Object.entries(outputs)) {
    await fs.writeFile(path.join(reportsDir,file+'.tmp'),content,'utf8');
    await fs.rename(path.join(reportsDir,file+'.tmp'),path.join(reportsDir,file));
  }
  return {...status,publishable:true,failed:!healthy};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const env=process.env;
  try {
    const result=await finalizeRun({
      reportsDir:env.FX_REPORTS_DIR??'reports',runStartedUTC:env.FX_RUN_STARTED_UTC,
      runId:env.GITHUB_RUN_ID??null,runAttempt:env.GITHUB_RUN_ATTEMPT??null,
      runUrl:env.GITHUB_RUN_ID&&env.GITHUB_REPOSITORY?`${env.GITHUB_SERVER_URL??'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`:null,
      analysisOutcome:env.FX_ANALYSIS_OUTCOME??'unknown',quickCheck:env.FX_QUICK_CHECK==='1'
    });
    if(env.GITHUB_OUTPUT) await fs.appendFile(env.GITHUB_OUTPUT,`publishable=${result.publishable}\nstatus=${result.status}\n`);
    console.log(JSON.stringify(result,null,2));
    if(result.failed) process.exitCode=1;
  } catch(error) {
    console.error('Report finalization failed:',error.message);
    process.exitCode=1;
  }
}
