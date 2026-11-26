// Rasterize the already verified SVG; do not recalculate or redraw price data.
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';

const japaneseFonts=[
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'
];
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function renderChartPng(svgFile,pngFile,metadata) {
  // Keep failure-report publication working even if npm installation failed.
  const {Resvg}=await import('@resvg/resvg-js');
  // Explicit Japanese fonts prevent successful-but-unreadable exports on CI.
  await Promise.all(japaneseFonts.map(file=>fs.access(file)));
  const svg=await fs.readFile(svgFile);
  const png=new Resvg(svg,{
    fitTo:{mode:'width',value:2360},
    font:{fontFiles:japaneseFonts,loadSystemFonts:false,
      defaultFontFamily:'Noto Sans CJK JP',sansSerifFamily:'Noto Sans CJK JP'}
  }).render().asPng();
  if(!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('PNG rasterization failed');
  const width=png.readUInt32BE(16),height=png.readUInt32BE(20);
  if(!width||!height)throw Error('PNG has no dimensions');
  await fs.writeFile(pngFile,png);
  return {...metadata,width,height,sourceSvgSha256:sha256(svg),pngSha256:sha256(png)};
}
