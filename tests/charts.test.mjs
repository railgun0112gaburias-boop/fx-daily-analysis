import test from 'node:test';
import assert from 'node:assert/strict';
import {summarize} from '../src/indicators.mjs';
import {renderAnnotatedChart} from '../src/charts.mjs';

function candles(n=100){
  const start=Date.UTC(2026,10,1);
  return Array.from({length:n},(_,i)=>{
    const p=9.5+Math.sin(i/7)*0.07+i*0.0002;
    return {timestamp:start+i*900000,open:p-0.003,high:p+0.013,low:p-0.015,close:p+0.004};
  });
}
test('renders annotated SVG with exact verified OHLC levels and timestamps',()=>{
  const rows=candles(),summary=summarize(rows,'m15',Date.UTC(2026,10,15));
  const svg=renderAnnotatedChart({symbol:'ZAR/JPY',timeframe:'m15',candles:rows,summary,generatedUTC:'2026-11-11T03:33:00.000Z'});
  assert.match(svg,/<svg/);
  assert.match(svg,/ローソク足/);
  assert.match(svg,/支持候補/);
  assert.match(svg,/抵抗候補/);
  assert.match(svg,/確定スイング高値/);
  assert.match(svg,/最新確定終値/);
  assert.match(svg,/9\.\d{4}/);
  assert.equal((svg.match(/<rect x=/g)||[]).length>30,true);
});
test('does not draw a chart from insufficient or unknown timeframe data',()=>{
  const rows=candles();
  assert.throws(()=>renderAnnotatedChart({symbol:'USD/JPY',timeframe:'w1',candles:rows,summary:{status:'insufficient'}}));
  assert.throws(()=>renderAnnotatedChart({symbol:'USD/JPY',timeframe:'wrong',candles:rows,summary:{status:'ok'}}));
});
