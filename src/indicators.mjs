// Calculate indicators from verified OHLC only; do not synthesize price data.
export const WINDOWS={m15:900000,h1:3600000,h4:14400000,d1:86400000,w1:604800000};
export function normalizeCandles(rows){
  if(!Array.isArray(rows))throw Error('Expected array of OHLC candles');
  const out=rows.map(r=>{
    const v=Array.isArray(r)?{timestamp:r[0],open:r[1],high:r[2],low:r[3],close:r[4]}:r;
    const c={timestamp:+v.timestamp,open:+v.open,high:+v.high,low:+v.low,close:+v.close};
    if(!Object.values(c).every(Number.isFinite))throw Error('Non-numeric OHLC');
    if(c.high<Math.max(c.open,c.close,c.low)||c.low>Math.min(c.open,c.close,c.high))throw Error('Invalid high/low');
    return c;
  }).sort((a,b)=>a.timestamp-b.timestamp);
  const seen=new Set();return out.filter(c=>{if(seen.has(c.timestamp))return false;seen.add(c.timestamp);return true});
}
export function closedOnly(rows,tf,now=Date.now(),graceMs=120000){
  if(!WINDOWS[tf])throw Error('Unknown timeframe: '+tf);
  return rows.filter(c=>c.timestamp+WINDOWS[tf]+graceMs<=now);
}
export function ema(a,n){
  const out=Array(a.length).fill(null);if(a.length<n)return out;
  let p=a.slice(0,n).reduce((x,y)=>x+y,0)/n;out[n-1]=p;const alpha=2/(n+1);
  for(let i=n;i<a.length;i++){p=alpha*a[i]+(1-alpha)*p;out[i]=p;}
  return out;
}
export function rsi(a,n=14){
  if(a.length<=n)return null;let up=0,dn=0;
  for(let i=1;i<=n;i++){const d=a[i]-a[i-1];up+=Math.max(d,0);dn+=Math.max(-d,0);}
  let u=up/n,v=dn/n;
  for(let i=n+1;i<a.length;i++){const d=a[i]-a[i-1];u=(u*(n-1)+Math.max(d,0))/n;v=(v*(n-1)+Math.max(-d,0))/n;}
  return v===0?(u===0?50:100):100-100/(1+u/v);
}
export function macd(a,fast=12,slow=26,signal=9){
  const f=ema(a,fast),s=ema(a,slow),diff=[];
  for(let i=0;i<a.length;i++)if(f[i]!==null&&s[i]!==null)diff.push(f[i]-s[i]);
  if(diff.length<signal)return null;
  const last=diff.at(-1),sig=ema(diff,signal).at(-1);
  return {macd:last,signal:sig,histogram:last-sig};
}
export function swings(cs,left=2,right=2){
  const highs=[],lows=[];
  for(let i=left;i<cs.length-right;i++){
    let h=true,l=true;
    for(let j=i-left;j<=i+right;j++)if(j!==i){if(cs[j].high>=cs[i].high)h=false;if(cs[j].low<=cs[i].low)l=false;}
    if(h)highs.push({timestamp:cs[i].timestamp,price:cs[i].high});
    if(l)lows.push({timestamp:cs[i].timestamp,price:cs[i].low});
  }
  return {highs,lows};
}
export function dow(cs){
  const {highs,lows}=swings(cs);const h=highs.slice(-2),l=lows.slice(-2);
  if(h.length<2||l.length<2)return {trend:'判定保留（確定高安値不足）',highs:h,lows:l};
  const ups=h[1].price>h[0].price&&l[1].price>l[0].price;
  const downs=h[1].price<h[0].price&&l[1].price<l[0].price;
  return {trend:ups?'上昇':downs?'下落':'混在・転換・レンジ',highs:h,lows:l};
}
export function levels(cs){
  const price=cs.at(-1)?.close;if(price===undefined)return {supports:[],resistances:[]};
  const s=swings(cs);
  return {supports:s.lows.filter(p=>p.price<price).slice(-14).sort((a,b)=>b.price-a.price).slice(0,3),
    resistances:s.highs.filter(p=>p.price>price).slice(-14).sort((a,b)=>a.price-b.price).slice(0,3)};
}
export function weeksFromDaily(daily,now=Date.now()){
  const m=new Map();
  for(const c of daily){
    const d=new Date(c.timestamp);
    const start=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())-((d.getUTCDay()+6)%7)*86400000;
    if(!m.has(start))m.set(start,{timestamp:start,open:c.open,high:c.high,low:c.low,close:c.close});
    else {const w=m.get(start);w.high=Math.max(w.high,c.high);w.low=Math.min(w.low,c.low);w.close=c.close;}
  }
  const rows=[...m.values()].sort((a,b)=>a.timestamp-b.timestamp);
  return {closed:rows.filter(c=>c.timestamp+WINDOWS.w1<=now),forming:rows.findLast(c=>c.timestamp+WINDOWS.w1>now)??null};
}
export function summarize(cs,tf,now=Date.now()){
  if(cs.length<40)return {status:'insufficient',count:cs.length,reason:'40本未満の確定足'};
  const d=dow(cs),l=levels(cs),a=cs.map(c=>c.close),last=cs.at(-1);
  return {status:'ok',count:cs.length,latestCloseUTC:new Date(last.timestamp+WINDOWS[tf]).toISOString(),
    ageHours:+((now-last.timestamp-WINDOWS[tf])/3600000).toFixed(2),
    close:last.close,trend:d.trend,importantHighs:d.highs,importantLows:d.lows,
    supports:l.supports,resistances:l.resistances,rsi14:rsi(a),macd12269:macd(a)};
}
