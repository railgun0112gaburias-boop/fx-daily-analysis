// Standalone SVG candlestick visualization. Every marker derives from actual, confirmed OHLC.
import {WINDOWS} from './indicators.mjs';

const tfLabels={m15:'15分足',h1:'1時間足',h4:'4時間足',d1:'日足',w1:'週足'};
const periods={m15:96,h1:100,h4:100,d1:120,w1:80};
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const jst=(ms,short=false)=>new Intl.DateTimeFormat('ja-JP',{
  timeZone:'Asia/Tokyo',month:'2-digit',day:'2-digit',
  ...(short?{}:{year:'numeric'}),hour:'2-digit',minute:'2-digit',
  hour12:false
}).format(new Date(ms));
const fmt=(p,symbol)=>Number(p).toFixed(symbol==='ZAR/JPY'?4:3);
const line=(x1,y1,x2,y2,color,width=1,dash='')=>'<line x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'" stroke="'+color+'" stroke-width="'+width+'" '+(dash?'stroke-dasharray="'+dash+'" ':'')+'/>';
const text=(x,y,value,{fill='#c8d4e2',size=13,weight=400,anchor='start'}={})=>'<text x="'+x+'" y="'+y+'" fill="'+fill+'" font-size="'+size+'" font-weight="'+weight+'" text-anchor="'+anchor+'" font-family="Arial, Noto Sans JP, sans-serif">'+esc(value)+'</text>';
export function renderAnnotatedChart({symbol,timeframe,candles,summary,generatedUTC}){
  if(!Object.hasOwn(tfLabels,timeframe))throw Error('Unsupported chart timeframe '+timeframe);
  if(!Array.isArray(candles)||candles.length<4)throw Error('Not enough confirmed candles to chart');
  if(!summary||summary.status!=='ok')throw Error('No verified technical summary');
  const cs=candles.slice(-(periods[timeframe]||100));
  const W=1180,H=540,L=83,R=286,T=90,B=67,X=W-R,plotW=X-L,plotH=H-T-B;
  const lows=cs.map(c=>c.low),highs=cs.map(c=>c.high);
  let lo=Math.min(...lows),hi=Math.max(...highs);
  const pad=Math.max((hi-lo)*.085,symbol==='ZAR/JPY'?.002:.018);
  lo-=pad;hi+=pad;
  const y=p=>T+(hi-p)/(hi-lo)*plotH;
  const step=plotW/cs.length;
  const x=i=>L+(i+.5)*step;
  const candleW=Math.max(2,Math.min(8,step*.62));
  let out=['<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+esc(symbol+' '+tfLabels[timeframe]+' 注釈付きローソク足チャート')+'">'];
  out.push('<rect width="'+W+'" height="'+H+'" fill="#101b2b"/>');
  out.push('<rect x="'+L+'" y="'+T+'" width="'+plotW+'" height="'+plotH+'" fill="#132235" rx="4"/>');
  out.push(text(L,37,symbol+'   '+tfLabels[timeframe]+'   |   Bid OHLC・確定足のみ',{fill:'#f2f7ff',size:23,weight:700}));
  out.push(text(L,61,'データ生成 '+jst(generatedUTC)+' JST　 /　最新確定 '+jst(Date.parse(summary.latestCloseUTC))+' JST',{fill:'#9fb1c8',size:14}));
  out.push(text(L,80,'ダウ '+summary.trend+'　RSI14 '+(summary.rsi14?.toFixed(1)??'未取得')+'　MACD '+(summary.macd12269?.macd.toFixed(4)??'未取得'),{fill:'#afbbcc',size:13}));
  for(let i=0;i<=6;i++){
    const yy=T+i*plotH/6,price=hi-(hi-lo)*i/6;
    out.push(line(L,yy,X,yy,'#2a3c51',.8,'3,6'));
    out.push(text(L-9,yy+4,fmt(price,symbol),{fill:'#99abc0',size:12,anchor:'end'}));
  }
  for(let i=0;i<=5;i++){
    const ci=Math.min(cs.length-1,Math.floor(i*(cs.length-1)/5)),xx=x(ci);
    out.push(line(xx,T,xx,T+plotH,'#23364a',.7,'3,8'));
    out.push(text(xx,H-41,jst(cs[ci].timestamp,true),{fill:'#99abc0',size:12,anchor:'middle'}));
  }
  // Candles: bullish = teal, bearish = coral. Close price is horizontal yellow.
  cs.forEach((c,i)=>{
    const xx=x(i),up=c.close>=c.open,color=up?'#2aceb7':'#ff7d7d';
    out.push(line(xx,y(c.high),xx,y(c.low),color,1.2));
    out.push('<rect x="'+(xx-candleW/2).toFixed(2)+'" y="'+Math.min(y(c.open),y(c.close)).toFixed(2)+'" width="'+candleW.toFixed(2)+'" height="'+Math.max(1.2,Math.abs(y(c.open)-y(c.close))).toFixed(2)+'" fill="'+color+'" rx=".5"/>');
  });
  const latest=cs.at(-1),py=y(latest.close);
  out.push(line(L,py,X,py,'#f3c66a',1.6,'6,4'));
  // Draw three nearest support/resistance candidates and verified high/low pivots.
  const marks=[];
  const decorate=(arr,prefix,color)=>{
    arr?.slice(0,3).forEach((point,i)=>{
      if(point?.price>=lo&&point.price<=hi)marks.push({price:point.price,label:prefix+(i+1),color,kind:prefix==='S'?'支持候補':'抵抗候補'});
    });
  };
  decorate(summary.supports,'S','#42bece');
  decorate(summary.resistances,'R','#fe9d86');
  marks.push({price:latest.close,label:'C',color:'#f3c66a',kind:'最新確定終値'});
  for(const mark of marks){
    const yy=y(mark.price);
    if(mark.label!=='C')out.push(line(L,yy,X,yy,mark.color,1.25,'5,7'));
  }
  // Latest two swing highs/lows: plot exact timestamps, no invented price levels.
  for(const [list,prefix,color] of [
    [summary.importantHighs,'H','#ffa4a4'],
    [summary.importantLows,'L','#74def1']
  ]){
    (list||[]).forEach((point,i)=>{
      const idx=cs.findIndex(c=>c.timestamp===point.timestamp);
      if(idx<0||point.price<lo||point.price>hi)return;
      const xx=x(idx),yy=y(point.price);
      out.push('<circle cx="'+xx.toFixed(2)+'" cy="'+yy.toFixed(2)+'" r="5" fill="'+color+'" stroke="#0c1725" stroke-width="1.5"/>');
      const anchor=xx>X-80?'end':'start',tx=xx+(anchor==='end'?-11:11);
      const dy=prefix==='H'?-12:21;
      out.push(text(tx,yy+dy,prefix+(i+1)+' '+fmt(point.price,symbol),{fill:color,size:12,weight:600,anchor}));
    });
  }
  // Place labels in a separate right gutter; arrows point to actual prices.
  marks.sort((a,b)=>y(a.price)-y(b.price));
  const minGap=24,lowY=T+15,maxY=T+plotH-12;
  const slots=marks.map((m,i)=>Math.max(lowY,y(m.price)-2));
  for(let i=1;i<slots.length;i++)slots[i]=Math.max(slots[i],slots[i-1]+minGap);
  if(slots.length&&slots.at(-1)>maxY){
    let shift=slots.at(-1)-maxY;
    for(let i=slots.length-1;i>=0;i--){
      slots[i]-=shift;
      if(i>0&&slots[i-1]>slots[i]-minGap)shift=slots[i-1]-(slots[i]-minGap);
      else shift=0;
    }
  }
  marks.forEach((m,i)=>{
    const yy=y(m.price),ly=slots[i];
    out.push(line(X,yy,X+16,ly,m.color,1.2));
    out.push('<rect x="'+(X+18)+'" y="'+(ly-13)+'" width="'+(R-32)+'" height="20" fill="#23334a" rx="4"/>');
    out.push(text(X+27,ly+2,m.label+' '+fmt(m.price,symbol)+'   '+m.kind,{fill:m.color,size:12,weight:600}));
  });
  out.push(text(L,H-16,'● H = 確定スイング高値　● L = 確定スイング安値　R = 抵抗候補　S = 支持候補',{fill:'#a7bad0',size:12}));
  out.push(text(X+18,H-16,'参考水準・売買指示ではありません',{fill:'#a7bad0',size:11}));
  out.push('</svg>');
  return out.join('\n');
}
