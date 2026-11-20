// Self-contained single-file HTML export [v1.4]:
// - instant offline vector rendering (no external deps)
// - when online, auto-detects opener's network region and loads CN/Global tiles
// - three size tiers: clear / light / none
import { simplify, fmtDistance, fmtDuration } from './geo';
import { applyPrivacy } from './privacy';
import { computeStats } from './stats';
import { get } from './settings';

const VIEWER_JS = `
(function(){
var D=window.__TRIP__;
var cv=document.getElementById('cv'),ctx=cv.getContext('2d');
var W,H,dpr=Math.min(2,window.devicePixelRatio||1);
function resize(){W=innerWidth;H=innerHeight;cv.width=W*dpr;cv.height=H*dpr;cv.style.width=W+'px';cv.style.height=H+'px';ctx.setTransform(dpr,0,0,dpr,0,0);draw();}
function bounds(){var a=D.pts,minx=1e9,miny=1e9,maxx=-1e9,maxy=-1e9;for(var i=0;i<a.length;i++){var p=a[i];if(p[0]<minx)minx=p[0];if(p[0]>maxx)maxx=p[0];if(p[1]<miny)miny=p[1];if(p[1]>maxy)maxy=p[1];}return[minx,miny,maxx,maxy];}
var B=bounds();
function fit(){var pad=70,kx=(W-pad*2)/Math.max(1e-6,B[2]-B[0]),ky=(H-pad*2-120)/Math.max(1e-6,B[3]-B[1]);var k=Math.min(kx,ky);var ox=(W-(B[2]-B[0])*k)/2,oy=(H-120-(B[3]-B[1])*k)/2;return function(lon,lat){return[ox+(lon-B[0])*k,H-120-oy-(lat-B[1])*k];};}
var TF=fit();
var tiles=null,provider=null;
function draw(){
ctx.fillStyle='#0e1626';ctx.fillRect(0,0,W,H);
ctx.strokeStyle='rgba(36,51,82,.5)';ctx.lineWidth=1;
for(var x=0;x<W;x+=64){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
for(var y=0;y<H;y+=64){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
if(tiles){for(var i=0;i<tiles.length;i++){var t=tiles[i];if(t.img&&t.img.complete&&t.img.naturalWidth)ctx.drawImage(t.img,t.x,t.y,256,256);}}
TF=fit();
ctx.lineCap='round';ctx.lineJoin='round';
ctx.beginPath();
for(var i=0;i<D.pts.length;i++){var p=TF(D.pts[i][0],D.pts[i][1]);i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]);}
ctx.strokeStyle='rgba(6,35,28,.6)';ctx.lineWidth=9;ctx.stroke();
ctx.strokeStyle='#2dd4a7';ctx.lineWidth=4.5;ctx.stroke();
if(D.pts.length){var s=TF(D.pts[0][0],D.pts[0][1]),e=TF(D.pts[D.pts.length-1][0],D.pts[D.pts.length-1][1]);
ctx.fillStyle='#2dd4a7';ctx.beginPath();ctx.arc(s[0],s[1],8,0,7);ctx.fill();
ctx.fillStyle='#f5b942';ctx.beginPath();ctx.arc(e[0],e[1],8,0,7);ctx.fill();}
for(var i=0;i<D.wps.length;i++){var w=D.wps[i],p=TF(w.lo,w.la);ctx.fillStyle='#e8eef7';ctx.beginPath();ctx.arc(p[0],p[1],5,0,7);ctx.fill();ctx.fillStyle='#93a3bd';ctx.font='11px system-ui';ctx.fillText(w.n||'',p[0]+8,p[1]+4);}
}
// --- dual-region auto detection (sync tz guess + async race probe) ---
function tzGuess(){try{var tz=Intl.DateTimeFormat().resolvedOptions().timeZone||'';return /^Asia\\/(Shanghai|Urumqi|Chongqing|Harbin|Kashgar)/.test(tz)?'cn':'global';}catch(e){return 'global';}}
function probe(url,ms){return new Promise(function(res){var im=new Image();var to=setTimeout(function(){im.src='';res(false);},ms);im.onload=function(){clearTimeout(to);res(true);};im.onerror=function(){clearTimeout(to);res(false);};im.src=url;});}
var AMAP='https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}';
var OSM='https://tile.openstreetmap.org/{z}/{x}/{y}.png';
function xOf(lon,z){return(lon+180)/360*Math.pow(2,z);}
function yOf(lat,z){var r=lat*Math.PI/180;return(1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*Math.pow(2,z);}
// compact GCJ-02 (only for amap + China bbox)
function gcj(lon,lat){if(lon<72||lon>137.9||lat<0.8||lat>55.9)return[lon,lat];var a=6378245,ee=.00669342162296594323;function tLat(x,y){var r=-100+2*x+3*y+.2*y*y+.1*x*y+.2*Math.sqrt(Math.abs(x));r+=(20*Math.sin(6*x*Math.PI)+20*Math.sin(2*x*Math.PI))*2/3;r+=(20*Math.sin(y*Math.PI)+40*Math.sin(y/3*Math.PI))*2/3;r+=(160*Math.sin(y/12*Math.PI)+320*Math.sin(y*Math.PI/30))*2/3;return r;}function tLon(x,y){var r=300+x+2*y+.1*x*x+.1*x*y+.1*Math.sqrt(Math.abs(x));r+=(20*Math.sin(6*x*Math.PI)+20*Math.sin(2*x*Math.PI))*2/3;r+=(20*Math.sin(x*Math.PI)+40*Math.sin(x/3*Math.PI))*2/3;r+=(150*Math.sin(x/12*Math.PI)+300*Math.sin(x/30*Math.PI))*2/3;return r;}var dLat=tLat(lon-105,lat-35),dLon=tLon(lon-105,lat-35);var rl=lat/180*Math.PI,m=1-ee*Math.sin(rl)*Math.sin(rl),sm=Math.sqrt(m);dLat=dLat*180/((a*(1-ee))/(m*sm)*Math.PI);dLon=dLon*180/(a/sm*Math.cos(rl)*Math.PI);return[lon+dLon,lat+dLat];}
function loadTiles(){
var z=13;for(;z>2;z--){var dx=(xOf(B[2],z)-xOf(B[0],z))*256,dy=(yOf(B[1],z)-yOf(B[3],z))*256;if(dx<W-100&&dy<H-220)break;}
var useGcj=provider==='amap';
var p0=useGcj?gcj(B[0],B[1]):[B[0],B[1]],p1=useGcj?gcj(B[2],B[3]):[B[2],B[3]];
var x0=Math.floor(xOf(p0[0],z)),x1=Math.floor(xOf(p1[0],z));
var y0=Math.floor(yOf(p1[1],z)),y1=Math.floor(yOf(p0[1],z));
var ox=xOf(p0[0],z)*256,oy=yOf(p1[1],z)*256;
var offX=(W-(x1-x0+1)*256)/2;
var offY=(H-120-(y1-y0+1)*256)/2;
TF=function(lon,lat){var q=useGcj?gcj(lon,lat):[lon,lat];return[offX+xOf(q[0],z)*256-x0*256,offY+yOf(q[1],z)*256-y0*256];};
void ox;void oy;
tiles=[];
var tpl=provider==='amap'?AMAP:OSM;
for(var x=x0;x<=x1;x++)for(var y=y0;y<=y1;y++){
(function(x,y){var t={x:offX+(x-x0)*256,y:offY+(y-y0)*256,img:new Image()};t.img.crossOrigin='anonymous';t.img.onload=draw;t.img.onerror=function(){};t.img.src=tpl.replace('{z}',z).replace('{x}',x).replace('{y}',y);tiles.push(t);})(x,y);
}
document.getElementById('bm').textContent=provider==='amap'?'AMap GCJ-02':'OSM WGS-84';
draw();
}
if(D.tier!=='none'){
var guess=tzGuess();
Promise.all([probe(AMAP.replace('{z}',3).replace('{x}',4).replace('{y}',2),1800),probe(OSM.replace('{z}',3).replace('{x}',4).replace('{y}',2),1800)]).then(function(r){
var cnOk=r[0],glOk=r[1];
if(guess==='cn'&&cnOk)provider='amap';else if(guess==='global'&&glOk)provider='osm';else if(cnOk)provider='amap';else if(glOk)provider='osm';
if(provider)loadTiles();else document.getElementById('bm').textContent='offline · vector';
});
}
addEventListener('resize',resize);resize();
})();
`;

export function buildSelfContainedHTML(full, { tier = 'clear', privacy }: any = {}) {
  const cropped = applyPrivacy(full, privacy);
  const tol = tier === 'clear' ? 3 : 15;
  const pts = simplify(cropped.segments.flatMap((s) => s.points), tol).slice(0, tier === 'clear' ? 2000 : 600);
  const stats = computeStats(cropped.segments, { ascentThreshold: get('ascentThreshold') });
  const units = get('units');
  const d = fmtDistance(stats.distance, units);
  const data = {
    name: full.trip.name || 'Trip',
    activity: full.trip.activity,
    createdAt: full.trip.createdAt,
    tier,
    pts: pts.map((p) => [Math.round(p.lon * 1e6) / 1e6, Math.round(p.lat * 1e6) / 1e6]),
    wps: cropped.waypoints.slice(0, tier === 'clear' ? 30 : 8).map((w) => ({ n: w.name, t: w.type, la: w.lat, lo: w.lon })),
    stats: {
      distance: `${d.v} ${d.u}`,
      duration: fmtDuration(stats.duration, { compact: true }),
      ascent: `${Math.round(stats.ascent)} m`,
      descent: `${Math.round(stats.descent)} m`
    }
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(data.name)} · TrackMint</title>
<style>
html,body{margin:0;height:100%;background:#0b1220;color:#e8eef7;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden}
#cv{position:fixed;inset:0}
#top{position:fixed;top:0;left:0;right:0;padding:14px 18px;background:linear-gradient(rgba(7,11,20,.9),transparent);pointer-events:none}
#top h1{margin:0;font-size:18px}
#top .m{font-size:12px;color:#93a3bd;margin-top:3px}
#bar{position:fixed;bottom:0;left:0;right:0;display:flex;gap:0;background:rgba(11,18,32,.94);border-top:1px solid #243352;padding:10px 6px calc(10px + env(safe-area-inset-bottom))}
#bar div{flex:1;text-align:center}
#bar .v{font-size:17px;font-weight:800;font-family:ui-monospace,Consolas,monospace;color:#2dd4a7}
#bar .k{font-size:10.5px;color:#93a3bd;margin-top:2px}
#bm{position:fixed;top:14px;right:16px;font-size:10.5px;color:#5d6f8d;background:rgba(11,18,32,.7);padding:3px 8px;border-radius:8px}
</style></head><body>
<canvas id="cv"></canvas>
<div id="top"><h1>${escapeHtml(data.name)}</h1><div class="m">${new Date(data.createdAt).toLocaleDateString()} · TrackMint · WGS-84</div></div>
<div id="bm">vector</div>
<div id="bar">
<div><div class="v">${data.stats.distance}</div><div class="k">Distance</div></div>
<div><div class="v">${data.stats.duration}</div><div class="k">Duration</div></div>
<div><div class="v">↑${data.stats.ascent}</div><div class="k">Ascent</div></div>
<div><div class="v">↓${data.stats.descent}</div><div class="k">Descent</div></div>
</div>
<script>window.__TRIP__=${json};<\/script>
<script>${VIEWER_JS}<\/script>
</body></html>`;
  return { html, size: html.length };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}