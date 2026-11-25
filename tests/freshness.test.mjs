import test from 'node:test';
import assert from 'node:assert/strict';
import {markFreshness} from '../src/freshness.mjs';

const minute=60_000;
const day=24*60*minute;
const periods={m15:15*minute,h1:60*minute,h4:4*60*minute,d1:day,w1:7*day};
const iso=ms=>new Date(ms).toISOString();
const summary=latestCloseUTC=>({status:'ok',latestCloseUTC,close:9,rsi14:55,ageHours:0});

test('all UTC timeframes advance exactly after the two-minute confirmation grace',()=>{
  const boundary=Date.parse('2026-11-23T00:00:00Z'); // Monday UTC, including weekly boundary.
  for(const [tf,period] of Object.entries(periods)){
    const previous=summary(iso(boundary-period));
    const before=markFreshness(previous,tf,'OPEN',boundary+2*minute-1);
    assert.equal(before.status,'ok',tf);
    assert.equal(before.expectedCloseUTC,previous.latestCloseUTC,tf);
    const at=markFreshness(previous,tf,'OPEN',boundary+2*minute);
    assert.equal(at.status,'stale',tf);
    assert.equal(at.expectedCloseUTC,iso(boundary),tf);
    assert.equal(markFreshness(summary(iso(boundary)),tf,'OPEN',boundary+2*minute).status,'ok',tf);
  }
});

test('one missing latest candle is stale even when a permissive age value says fresh',()=>{
  const now=Date.parse('2026-11-25T13:07:00Z');
  const expected={m15:'2026-11-25T13:00:00Z',h1:'2026-11-25T13:00:00Z',h4:'2026-11-25T12:00:00Z',d1:'2026-11-25T00:00:00Z',w1:'2026-11-23T00:00:00Z'};
  for(const [tf,close] of Object.entries(expected)){
    const result=markFreshness(summary(iso(Date.parse(close)-periods[tf])),tf,'OPEN',now);
    assert.equal(result.status,'stale',tf);
    assert.equal(result.expectedCloseUTC,iso(Date.parse(close)),tf);
  }
  // Do not silently exempt the weekend when the source still reports OPEN.
  assert.equal(markFreshness(summary('2026-11-28T00:00:00Z'),'d1','OPEN',Date.parse('2026-11-29T07:07:00Z')).status,'stale');
});

test('closed and maintenance states suppress analysis while retaining expected cutoff',()=>{
  const now=Date.parse('2026-11-25T13:07:00Z');
  const frame=summary('2026-11-25T13:00:00Z');
  for(const state of ['CLOSE','CLOSED','PREOPEN']){
    const result=markFreshness(frame,'m15',state,now);
    assert.equal(result.status,'market_closed',state);
    assert.equal(result.expectedCloseUTC,'2026-11-25T13:00:00.000Z',state);
  }
  assert.equal(markFreshness(frame,'m15','MAINTENANCE',now).status,'unavailable');
  assert.equal(frame.status,'ok');
  const unavailable={status:'unavailable',error:'HTTP 503'};
  assert.equal(markFreshness(unavailable,'m15','CLOSED',now),unavailable);
});

test('invalid and not-yet-confirmed timestamps cannot become current charts',()=>{
  const now=Date.parse('2026-11-23T00:01:59Z');
  assert.equal(markFreshness(summary('2026-11-23T00:00:00Z'),'w1','OPEN',now).status,'unavailable');
  assert.equal(markFreshness(summary('invalid'),'m15','OPEN',now).status,'unavailable');
});
