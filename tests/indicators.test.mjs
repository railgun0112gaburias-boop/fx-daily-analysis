import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCandles,closedOnly,ema,rsi,macd,dow,weeksFromDaily,summarize} from '../src/indicators.mjs';
function fixture(n=90,step=900000){return Array.from({length:n},(_,i)=>{const p=9+i*.005+.01*Math.sin(i*.6);return {timestamp:Date.UTC(2026,0,1)+i*step,open:p,high:p+.02,low:p-.02,close:p+.003};});}
test('OHLC validity, order and duplicates',()=>{const d=fixture(3);assert.deepEqual(normalizeCandles([d[2],d[0],d[1],d[1]]).map(x=>x.timestamp),d.map(x=>x.timestamp));assert.throws(()=>normalizeCandles([{timestamp:1,open:1,high:0,low:0,close:1}]));});
test('incomplete candle and 2-minute confirmation',()=>{const d=fixture(2);assert.equal(closedOnly(d,'m15',d[1].timestamp+900000).length,1);assert.equal(closedOnly(d,'m15',d[1].timestamp+1020000).length,2);});
test('EMA RSI MACD and Dow calculations',()=>{const d=fixture();assert.equal(ema(d.map(x=>x.close),20).length,d.length);assert.ok(Number.isFinite(rsi(d.map(x=>x.close))));assert.ok(Number.isFinite(macd(d.map(x=>x.close)).histogram));assert.ok(dow(d).trend);assert.equal(summarize(d,'m15',Date.UTC(2026,2,1)).status,'ok');});
test('weekly UTC aggregation excludes incomplete week',()=>{const d=[{timestamp:Date.UTC(2026,10,2),open:1,high:1.2,low:.9,close:1.1},{timestamp:Date.UTC(2026,10,3),open:1.1,high:1.4,low:1,close:1.3},{timestamp:Date.UTC(2026,10,9),open:1.3,high:1.5,low:1.2,close:1.4}];const w=weeksFromDaily(d,Date.UTC(2026,10,11));assert.equal(w.closed.length,1);assert.equal(w.closed[0].high,1.4);assert.equal(w.forming.close,1.4);});
