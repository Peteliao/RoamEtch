// Inline CSS / JS for the single-file trip page. Kept dependency-free so the
// exported HTML opens offline from any file manager or chat app.

export const VIEWER_CSS = String.raw`
:root{
  --bg:#000;--panel:#000;--text:#fff;--muted:#b8b8b8;--faint:#7a7a7a;
  --accent:#2bcda7;--accent-soft:rgba(43,205,167,.14);--accent-ink:#06251d;
  --amber:#f5b942;--chip:rgba(184,184,184,.08);--border:rgba(255,255,255,.14);
  --border2:rgba(255,255,255,.24);--glass:rgba(0,0,0,.86);--sheet:#000;
  --shadow:0 20px 50px rgba(0,0,0,.42);
}
*{box-sizing:border-box}
html,body{margin:0;height:100%;overflow:hidden;background:var(--bg)}
body{
  color:var(--text);
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
}
button{font:inherit;color:inherit}
a{color:var(--accent);text-decoration:none}
#map{
  position:fixed;inset:0;z-index:0;display:block;width:100%;height:100%;
  touch-action:none;cursor:grab;outline:none;
}
#map:active{cursor:grabbing}
#hud{position:fixed;inset:0;z-index:2;pointer-events:none}
#hud .trip-head,#hud .dock,#hud .map-tools,#hud .sheet{pointer-events:auto}
.grow{flex:1;min-width:0}
.trip-head{
  position:absolute;top:calc(10px + env(safe-area-inset-top,0px));left:50%;
  width:calc(100% - 20px);max-width:560px;transform:translateX(-50%);
  padding:12px 14px 11px;border:1px solid var(--border);border-radius:18px;
  background:var(--glass);box-shadow:var(--shadow);
  -webkit-backdrop-filter:blur(16px) saturate(1.2);backdrop-filter:blur(16px) saturate(1.2);
}
.head-top{display:flex;align-items:center;gap:7px;margin-bottom:5px}
.brandmark{width:18px;height:18px;color:var(--accent);flex:none}
.brandmark svg{display:block;width:100%;height:100%}
.brandname{font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.trip-head h1{
  margin:2px 0 0;font-size:20px;line-height:1.22;font-weight:850;letter-spacing:-.01em;
  overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;
}
.meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:7px;font-size:12px;color:var(--muted)}
.act-pill{
  display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;
  background:var(--accent-soft);color:var(--accent);font-size:12px;font-weight:800;letter-spacing:.02em;
}
.meta .dot{width:3px;height:3px;border-radius:50%;background:var(--faint);flex:none}
.places{display:flex;gap:5px;overflow-x:auto;margin-top:9px;padding-bottom:1px;scrollbar-width:none}
.places::-webkit-scrollbar{display:none}
.place{
  flex:none;height:23px;display:inline-flex;align-items:center;padding:0 8px;
  border:1px solid var(--border);border-radius:999px;color:var(--muted);
  font-size:12px;font-weight:600;background:var(--chip);
}
.round{
  width:40px;height:40px;border:1px solid var(--border);border-radius:50%;
  background:var(--glass);color:var(--text);display:inline-flex;align-items:center;justify-content:center;
  cursor:pointer;-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
  box-shadow:0 4px 16px rgba(0,0,0,.14);
}
.round:active{transform:scale(.94)}
.round.sm{width:30px;height:30px;padding:0}
.round svg{width:16px;height:16px;display:block}
.map-tools{
  position:absolute;right:12px;top:50%;transform:translateY(-50%);
  display:flex;flex-direction:column;gap:8px;
}
.map-tools .round{font-size:20px;font-weight:500;line-height:1}
.dock{
  position:absolute;left:50%;bottom:calc(10px + env(safe-area-inset-bottom,0px));
  width:calc(100% - 20px);max-width:560px;transform:translateX(-50%);
  padding:7px 12px 9px;border:1px solid var(--border);border-radius:18px;
  background:var(--glass);box-shadow:var(--shadow);
  -webkit-backdrop-filter:blur(16px) saturate(1.2);backdrop-filter:blur(16px) saturate(1.2);
}
.prog{padding:6px 2px;margin:-5px 0 5px;cursor:pointer;touch-action:none}
.ptrack{height:4px;border-radius:999px;background:var(--chip);overflow:hidden}
#progFill{height:100%;width:0;border-radius:999px;background:var(--accent);transition:width .08s linear}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:0}
.m{min-width:0;padding:0 9px 0 2px}
.m + .m{border-left:1px solid var(--border);padding-left:11px}
.mv{
  font-size:20px;font-weight:850;line-height:1.05;letter-spacing:-.02em;
  font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.mv small{font-size:12px;font-weight:700;color:var(--muted);margin-left:2px;letter-spacing:0}
.m.hero .mv{color:var(--accent)}
.mk{font-size:12px;color:var(--faint);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dock-actions{display:flex;align-items:center;gap:7px;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)}
.guide{flex:1;min-width:0;font-size:12px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bm{
  flex:none;height:24px;display:inline-flex;align-items:center;padding:0 7px;
  border-radius:7px;background:var(--chip);color:var(--faint);
  font-size:12px;font-weight:700;white-space:nowrap;
}
.btn{
  flex:none;height:32px;padding:0 11px;border:1px solid var(--border);border-radius:10px;
  background:var(--chip);color:var(--text);display:inline-flex;align-items:center;gap:5px;
  font-size:12px;font-weight:800;cursor:pointer;
}
.btn:active{transform:scale(.97)}
.btn.primary{background:var(--accent);color:var(--accent-ink);border-color:transparent}
.btn svg{width:13px;height:13px;display:block}
.wp-pop{
  position:absolute;z-index:6;max-width:232px;padding:10px 12px;
  border:1px solid var(--border);border-radius:14px;background:var(--glass);
  box-shadow:var(--shadow);pointer-events:none;
  -webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);
}
.wp-pop[hidden]{display:none}
.wp-pop .t{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:850;line-height:1.3}
.wp-pop .t span:first-child{font-size:15px}
.wp-pop .m{font-size:12px;color:var(--muted);margin-top:3px}
.wp-pop p{margin:6px 0 0;font-size:12px;line-height:1.45;color:var(--muted);white-space:pre-wrap;max-height:110px;overflow:hidden}
.scrim{
  position:absolute;inset:0;z-index:4;background:rgba(0,0,0,.36);
  opacity:0;pointer-events:none;transition:opacity .24s ease;
}
.scrim.show{opacity:1;pointer-events:auto}
.sheet{
  position:absolute;left:50%;bottom:0;z-index:5;width:min(100%,680px);
  max-height:86vh;max-height:86dvh;padding-bottom:calc(24px + env(safe-area-inset-bottom,0px));
  transform:translate(-50%,105%);border:1px solid var(--border);border-bottom:none;
  border-radius:22px 22px 0 0;background:var(--sheet);box-shadow:var(--shadow);
  overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;
  transition:transform .3s cubic-bezier(.22,.75,.3,1);
}
.sheet.open{transform:translate(-50%,0)}
.sheet-head{position:sticky;top:0;z-index:2;padding:8px 16px 0;background:var(--sheet)}
.handle{width:38px;height:4px;border-radius:2px;background:var(--border2);margin:0 auto 7px}
.sheet-bar{display:flex;align-items:center;gap:10px;padding-bottom:8px;border-bottom:1px solid var(--border)}
.sheet-bar h2{margin:0;font-size:16.5px;font-weight:850}
.sheet-body{padding:4px 16px 0}
.statgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:11px}
.s{min-width:0;padding:8px 9px;border-radius:11px;background:var(--chip)}
.sv{
  font-size:14px;font-weight:850;line-height:1.15;font-variant-numeric:tabular-nums;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.sk{font-size:12px;color:var(--faint);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sec{
  display:flex;align-items:center;gap:7px;margin:18px 2px 8px;
  font-size:12px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);
}
.count{
  display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:999px;
  background:var(--accent-soft);color:var(--accent);font-size:12px;letter-spacing:0;
}
.chartwrap{height:154px;padding:8px 5px 2px;border-radius:14px;background:var(--chip)}
.chartwrap canvas{display:block;width:100%;height:100%}
.empty{padding:12px;border-radius:12px;background:var(--chip);color:var(--faint);font-size:12px}
.nodes{position:relative}
.node{display:flex;gap:11px;padding:10px 0;position:relative}
.node + .node{border-top:1px solid var(--border)}
.node-ico{
  flex:none;width:34px;height:34px;border-radius:50%;border:1px solid var(--border);
  background:var(--chip);display:flex;align-items:center;justify-content:center;font-size:15px;
}
.node-body{flex:1;min-width:0}
.node-title{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:13px;font-weight:850;line-height:1.3}
.nbadge{
  display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:999px;
  border:1px solid var(--border);color:var(--muted);font-size:12px;font-weight:650;
}
.node-meta{font-size:12px;color:var(--faint);margin-top:3px}
.node p{margin:6px 0 0;color:var(--muted);font-size:12px;line-height:1.5;white-space:pre-wrap}
.node img{display:block;width:100%;max-height:240px;object-fit:cover;border-radius:12px;margin-top:8px;background:var(--chip)}
.brandfoot{
  display:flex;align-items:center;gap:12px;margin-top:20px;padding:10px;
  border-radius:14px;background:var(--chip);
}
.brandfoot .qr{width:74px;height:74px;border-radius:9px;background:#fff;flex:none;display:block}
.bf-slogan{font-size:13px;font-weight:850;line-height:1.3}
.bf-link{display:block;margin-top:3px;font-size:12px;color:var(--accent);word-break:break-all}
.bf-sub{font-size:12px;color:var(--faint);margin-top:3px;line-height:1.4}
.fine{margin:12px 0 0;text-align:center;color:var(--faint);font-size:12px;line-height:1.5}
@media (max-width:520px){
  .guide{display:none}
  .trip-head h1{font-size:18px}
  .mv{font-size:18px}
}
html[data-theme="matrix"] .trip-head,
html[data-theme="matrix"] .dock,
html[data-theme="matrix"] .sheet{box-shadow:var(--shadow),inset 0 1px rgba(57,255,136,.08)}
html[data-theme="matrix"] body::after{
  content:'';position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.42;
  background-image:repeating-linear-gradient(180deg,rgba(0,0,0,.17) 0 1px,transparent 1px 4px),radial-gradient(ellipse at center,transparent 48%,rgba(0,0,0,.36) 100%);
}
html[data-theme="matrix"] .brandname,
html[data-theme="matrix"] .trip-head h1,
html[data-theme="matrix"] .mv,
html[data-theme="matrix"] .sheet-bar h2{font-family:ui-monospace,"SF Mono","Cascadia Mono",Consolas,monospace;letter-spacing:.03em}
html[data-theme="matrix"] .brandname{color:var(--accent)}
html[data-theme="matrix"] .act-pill,
html[data-theme="matrix"] .m.hero .mv{text-shadow:0 0 14px rgba(57,255,136,.24)}
html[data-theme="neon"] body::before{
  content:'';position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.62;
  background:radial-gradient(ellipse at 8% 4%,color-mix(in srgb,var(--fx-primary) 28%,transparent),transparent 52%),
    radial-gradient(ellipse at 92% 38%,color-mix(in srgb,var(--fx-secondary) 22%,transparent),transparent 48%),
    linear-gradient(var(--fx-secondary) 1px,transparent 1px) 0 0/48px 48px,
    linear-gradient(90deg,var(--fx-secondary) 1px,transparent 1px) 0 0/48px 48px;
}
html[data-theme="neon"] body::after{
  content:'';position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.34;
  background:repeating-linear-gradient(180deg,rgba(0,0,0,.24) 0 1px,transparent 1px 4px),radial-gradient(ellipse at center,transparent 54%,rgba(2,3,12,.48) 100%);
}
html[data-theme="neon"] .trip-head h1,html[data-theme="neon"] .mv{text-shadow:0 0 16px color-mix(in srgb,var(--fx-primary) 40%,transparent)}
html[data-theme="starship"] body::before{
  content:'';position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.62;
  background:radial-gradient(circle at 84% 14%,color-mix(in srgb,var(--fx-primary) 13%,transparent),transparent 24%),
    linear-gradient(var(--fx-secondary) 1px,transparent 1px) 0 0/48px 48px,
    linear-gradient(90deg,var(--fx-secondary) 1px,transparent 1px) 0 0/48px 48px,
    repeating-linear-gradient(180deg,transparent 0 95px,color-mix(in srgb,var(--fx-secondary) 9%,transparent) 95px 96px);
}
html[data-theme="starship"] body::after{
  content:'';position:fixed;inset:12px;z-index:1;pointer-events:none;opacity:.5;
  border:1px solid color-mix(in srgb,var(--fx-primary) 35%,transparent);
  background:linear-gradient(var(--fx-primary),var(--fx-primary)) left top/36px 2px no-repeat,
    linear-gradient(var(--fx-primary),var(--fx-primary)) left top/2px 36px no-repeat,
    linear-gradient(var(--fx-primary),var(--fx-primary)) right bottom/36px 2px no-repeat,
    linear-gradient(var(--fx-primary),var(--fx-primary)) right bottom/2px 36px no-repeat;
}
html[data-theme="starship"] .brandname,html[data-theme="starship"] h1,html[data-theme="starship"] .mv{font-family:ui-monospace,monospace;letter-spacing:.05em;text-transform:uppercase}
html[data-theme="aurora"] body::before{
  content:'';position:fixed;inset:-20%;z-index:1;pointer-events:none;opacity:.55;filter:blur(28px);
  background:radial-gradient(ellipse at 20% 0%,color-mix(in srgb,var(--fx-primary) 25%,transparent),transparent 42%),
    radial-gradient(ellipse at 78% 12%,color-mix(in srgb,var(--fx-secondary) 23%,transparent),transparent 40%),
    radial-gradient(ellipse at 55% 48%,rgba(91,169,255,.16),transparent 46%);
  animation:viewer-aurora 18s ease-in-out infinite alternate;
}
@keyframes viewer-aurora{to{transform:translate3d(4%,3%,0) rotate(3deg)}}
html[data-theme="aurora"] body::after{content:'';position:fixed;inset:0;z-index:1;pointer-events:none;background:linear-gradient(125deg,rgba(255,255,255,.055),transparent 28%,transparent 72%,rgba(255,255,255,.035))}
html[data-theme="amber"] body::before{
  content:'';position:fixed;inset:0;z-index:1;pointer-events:none;
  background:radial-gradient(ellipse at center,color-mix(in srgb,var(--fx-primary) 15%,transparent),transparent 64%),repeating-linear-gradient(180deg,rgba(0,0,0,.18) 0 1px,transparent 1px 4px);
  animation:viewer-amber 7s steps(1) infinite;
}
@keyframes viewer-amber{0%,94%,100%{opacity:.8}95%{opacity:.68}97%{opacity:.9}}
html[data-theme="amber"] body::after{content:'';position:fixed;inset:0;z-index:1;pointer-events:none;background:radial-gradient(ellipse at center,transparent 48%,rgba(0,0,0,.46) 100%)}
html[data-theme="amber"] h1,html[data-theme="amber"] .mv{font-family:ui-monospace,monospace;text-transform:uppercase;text-shadow:0 0 12px color-mix(in srgb,var(--fx-primary) 35%,transparent)}
html[data-theme="deepsea"] body::before{
  content:'';position:fixed;inset:-10%;z-index:1;pointer-events:none;opacity:.7;
  background:radial-gradient(ellipse at 12% 28%,color-mix(in srgb,var(--fx-primary) 18%,transparent),transparent 34%),
    radial-gradient(ellipse at 84% 70%,color-mix(in srgb,var(--fx-secondary) 17%,transparent),transparent 38%),
    repeating-radial-gradient(ellipse at 60% 20%,transparent 0 54px,color-mix(in srgb,var(--fx-primary) 7%,transparent) 55px 56px);
  animation:viewer-deepsea 12s ease-in-out infinite alternate;
}
@keyframes viewer-deepsea{to{transform:scale(1.04) translateY(-1%);opacity:.5}}
html[data-theme="deepsea"] body::after{content:'';position:fixed;inset:0;z-index:1;pointer-events:none;background:linear-gradient(180deg,transparent 60%,rgba(0,245,212,.05)),radial-gradient(ellipse at center,transparent 48%,rgba(0,4,10,.44))}
html[data-theme="vermilion"] body::before{
  content:'';position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.7;
  background:radial-gradient(ellipse at 12% 20%,rgba(63,55,45,.10),transparent 36%),
    radial-gradient(ellipse at 83% 72%,rgba(92,111,107,.10),transparent 34%),
    repeating-linear-gradient(94deg,transparent 0 128px,color-mix(in srgb,var(--fx-primary) 5%,transparent) 129px 130px);
}
html[data-theme="vermilion"] body::after{
  content:'迹';position:fixed;right:18px;top:72px;z-index:1;pointer-events:none;width:38px;height:38px;display:grid;place-items:center;
  border:2px solid var(--fx-primary);color:var(--fx-primary);background:color-mix(in srgb,var(--bg) 82%,transparent);
  font:700 24px "Songti SC",serif;opacity:.72;transform:rotate(-4deg);
}
html[data-theme="vermilion"] h1,html[data-theme="vermilion"] .mv{font-family:"Noto Serif CJK SC","Songti SC",serif}
html[data-theme="contrast"] body::before{content:'';position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.65;background:repeating-linear-gradient(122deg,transparent 0 94px,color-mix(in srgb,var(--fx-secondary) 8%,transparent) 95px 96px)}
html.oled-lock body::before,html.oled-lock body::after{display:none!important}
@media (max-width:370px){
  .trip-head{padding:10px 12px}
  .m{padding-right:5px}
  .m + .m{padding-left:8px}
  .mv{font-size:16.5px}
  .statgrid{grid-template-columns:repeat(2,1fr)}
  .btn{padding:0 9px}
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{transition:none!important;animation:none!important}
  #progFill{transition:none!important}
}
`;

export const VIEWER_JS = String.raw`
(function(){
'use strict';
var D=window.__TRIP__;
var L=D.labels||{};
var root=document.documentElement;
var metaTheme=document.getElementById('tc');
var cv=document.getElementById('map');
var ctx=cv.getContext('2d');
var W=0,H=0,dpr=Math.min(2,window.devicePixelRatio||1);
var pts=D.pts||[];
var wps=D.wps||[];
var state={z:1,tx:0,ty:0};
var base=null;
var useGcj=false,provider=null;
var tiles=[],tileZ=0,tileLoaded=0,tileFailed=0;
var theme=root.getAttribute('data-theme')||'dark';
var pal=D.palettes[theme]||D.palettes.dark;
var selected=-1,popTimer=0;
var playing=false,replay=0,raf=0,playStart=0,playFrom=0;
var DUR=18000;
var cum=[],total=0,i=0;
for(i=1;i<pts.length;i++){
  var dx=pts[i][0]-pts[i-1][0],dy=pts[i][1]-pts[i-1][1];
  var rr=Math.PI/180;
  var h=Math.sin(dy*rr/2)*Math.sin(dy*rr/2)+Math.cos(pts[i-1][1]*rr)*Math.cos(pts[i][1]*rr)*Math.sin(dx*rr/2)*Math.sin(dx*rr/2);
  cum.push((cum.length?cum[cum.length-1]:0)+6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h)));
}
if(pts.length)cum.unshift(0);
total=cum.length?cum[cum.length-1]:0;

function clamp(v,a,b){return v<a?a:v>b?b:v;}
function mercX(lon){return (lon+180)/360;}
function mercY(lat){var r=lat*Math.PI/180;return (1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2;}
function gcj(lon,lat){
  if(lon<72||lon>137.9||lat<0.8||lat>55.9)return[lon,lat];
  var a=6378245,ee=.00669342162296594323;
  function tLat(x,y){var r=-100+2*x+3*y+.2*y*y+.1*x*y+.2*Math.sqrt(Math.abs(x));r+=(20*Math.sin(6*x*Math.PI)+20*Math.sin(2*x*Math.PI))*2/3;r+=(20*Math.sin(y*Math.PI)+40*Math.sin(y/3*Math.PI))*2/3;r+=(160*Math.sin(y/12*Math.PI)+320*Math.sin(y*Math.PI/30))*2/3;return r;}
  function tLon(x,y){var r=300+x+2*y+.1*x*x+.1*x*y+.1*Math.sqrt(Math.abs(x));r+=(20*Math.sin(6*x*Math.PI)+20*Math.sin(2*x*Math.PI))*2/3;r+=(20*Math.sin(x*Math.PI)+40*Math.sin(x/3*Math.PI))*2/3;r+=(150*Math.sin(x/12*Math.PI)+300*Math.sin(x/30*Math.PI))*2/3;return r;}
  var dLat=tLat(lon-105,lat-35),dLon=tLon(lon-105,lat-35);
  var rl=lat/180*Math.PI,m=1-ee*Math.sin(rl)*Math.sin(rl),sm=Math.sqrt(m);
  dLat=dLat*180/((a*(1-ee))/(m*sm)*Math.PI);
  dLon=dLon*180/(a/sm*Math.cos(rl)*Math.PI);
  return[lon+dLon,lat+dLat];
}
function sourceBounds(){
  var list=pts.length?pts:wps.map(function(w){return [w.lo,w.la];});
  if(!list.length)return null;
  var minx=1e9,miny=1e9,maxx=-1e9,maxy=-1e9;
  for(var j=0;j<list.length;j++){
    var q=useGcj?gcj(list[j][0],list[j][1]):list[j];
    var x=mercX(q[0]),y=mercY(q[1]);
    if(x<minx)minx=x;if(x>maxx)maxx=x;if(y<miny)miny=y;if(y>maxy)maxy=y;
  }
  if(maxx-minx<1e-9){minx-=.00001;maxx+=.00001;}
  if(maxy-miny<1e-9){miny-=.00001;maxy+=.00001;}
  return [minx,miny,maxx,maxy];
}
function fitBase(){
  var b=sourceBounds();
  if(!b){b=[.49,.49,.51,.51];}
  var top=clamp(H*.22,132,214);
  var bottom=clamp(H*.25,174,226);
  var side=clamp(W*.1,34,72);
  var availW=Math.max(40,W-side*2);
  var availH=Math.max(40,H-top-bottom);
  var kx=availW/(b[2]-b[0]),ky=availH/(b[3]-b[1]);
  var k=Math.min(kx,ky);
  base={k:k,cx:W/2,cy:top+availH/2,mx:(b[0]+b[2])/2,my:(b[1]+b[3])/2,top:top,bottom:bottom};
}
function projectRaw(lon,lat){
  return [
    base.cx+(mercX(lon)-base.mx)*base.k*state.z+state.tx,
    base.cy+(mercY(lat)-base.my)*base.k*state.z+state.ty
  ];
}
function project(lon,lat){
  if(useGcj){var q=gcj(lon,lat);return projectRaw(q[0],q[1]);}
  return projectRaw(lon,lat);
}
function lonAt(x,z){return x/Math.pow(2,z)*360-180;}
function latAt(y,z){var n=Math.PI-2*Math.PI*y/Math.pow(2,z);return Math.atan((Math.exp(n)-Math.exp(-n))/2)*180/Math.PI;}

function tileRange(z){
  var b=sourceBounds();
  if(!b)return null;
  var n=Math.pow(2,z);
  return {
    x0:Math.max(0,Math.floor(b[0]*n)-1),
    x1:Math.min(n-1,Math.floor(b[2]*n)+1),
    y0:Math.max(0,Math.floor(b[1]*n)-1),
    y1:Math.min(n-1,Math.floor(b[3]*n)+1)
  };
}
function countTiles(z){
  var r=tileRange(z);
  return r?(r.x1-r.x0+1)*(r.y1-r.y0+1):0;
}
function pickTileZoom(){
  var z=Math.round(Math.log(Math.max(1,base.k)/256)/Math.LN2)+1;
  if(!isFinite(z))z=10;
  z=clamp(z,3,16);
  while(z>3&&countTiles(z)>49)z--;
  return z;
}
function loadTiles(){
  tiles=[];tileLoaded=0;tileFailed=0;
  if(provider!=='osm'&&provider!=='amap')return;
  tileZ=pickTileZoom();
  var r=tileRange(tileZ);
  if(!r)return;
  var tpl=provider==='amap'
    ?'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}'
    :'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  for(var x=r.x0;x<=r.x1;x++){
    for(var y=r.y0;y<=r.y1;y++){
      (function(tx,ty){
        var img=new Image();
        var tile={x:tx,y:ty,img:img};
        img.onload=function(){tileLoaded++;draw();};
        img.onerror=function(){
          tileFailed++;
          if(tileLoaded===0&&tileFailed===tiles.length)setBadge(L.vector||'vector');
        };
        img.src=tpl.replace('{z}',tileZ).replace('{x}',tx).replace('{y}',ty);
        tiles.push(tile);
      })(x,y);
    }
  }
  draw();
}
function setBadge(text){var el=document.getElementById('bm');if(el)el.textContent=text;}
function setAttrib(text){var el=document.getElementById('attrib');if(el)el.textContent=text;}

function drawGrid(){
  ctx.strokeStyle=pal.grid;ctx.lineWidth=1;
  for(var x=0;x<W;x+=64){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
  for(var y=0;y<H;y+=64){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
}
function drawTiles(){
  if(!tiles.length)return false;
  var drew=false;
  for(var j=0;j<tiles.length;j++){
    var t=tiles[j];
    if(!t.img.complete||!t.img.naturalWidth)continue;
    var p0=projectRaw(lonAt(t.x,tileZ),latAt(t.y,tileZ));
    var p1=projectRaw(lonAt(t.x+1,tileZ),latAt(t.y+1,tileZ));
    var tw=p1[0]-p0[0],th=p1[1]-p0[1];
    if(p0[0]>W||p0[1]>H||p0[0]+tw<0||p0[1]+th<0)continue;
    ctx.drawImage(t.img,p0[0],p0[1],tw+.6,th+.6);
    drew=true;
  }
  return drew;
}
function strokePath(arr,color,width,alpha){
  if(!arr||arr.length<2)return;
  ctx.beginPath();
  for(var j=0;j<arr.length;j++){j?ctx.lineTo(arr[j][0],arr[j][1]):ctx.moveTo(arr[j][0],arr[j][1]);}
  ctx.strokeStyle=color;ctx.lineWidth=width;
  ctx.globalAlpha=alpha==null?1:alpha;
  ctx.stroke();
  ctx.globalAlpha=1;
}
function screenRoute(){
  var out=[];
  for(var j=0;j<pts.length;j++)out.push(project(pts[j][0],pts[j][1]));
  return out;
}
function partialRoute(sp,p){
  if(p==null||p>=1)return sp.slice();
  var target=total*p,out=[];
  for(var j=0;j<cum.length;j++){
    if(cum[j]<=target)out.push(sp[j]);
    else break;
  }
  var idx=out.length-1;
  if(idx>=0&&idx<pts.length-1){
    var span=cum[idx+1]-cum[idx]||1;
    var f=clamp((target-cum[idx])/span,0,1);
    var a=sp[idx],b=sp[idx+1];
    out.push([a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f]);
  }
  return out;
}
function pointAt(p){
  var sp=partialRoute(screenRoute(),p);
  return sp.length?sp[sp.length-1]:null;
}
function drawMarkers(sp){
  if(sp.length){
    var s=sp[0],e=sp[sp.length-1];
    ctx.beginPath();ctx.arc(s[0],s[1],10,0,Math.PI*2);ctx.fillStyle=pal.casing;ctx.fill();
    ctx.beginPath();ctx.arc(s[0],s[1],6.2,0,Math.PI*2);ctx.fillStyle=pal.accent;ctx.fill();
    ctx.beginPath();ctx.arc(e[0],e[1],10.5,0,Math.PI*2);ctx.fillStyle=pal.endRing;ctx.fill();
    ctx.beginPath();ctx.arc(e[0],e[1],6.2,0,Math.PI*2);ctx.fillStyle=pal.amber;ctx.fill();
  }
}
function drawWaypoints(){
  var labels=wps.length<=10;
  for(var j=0;j<wps.length;j++){
    var w=wps[j],p=project(w.lo,w.la);
    if(p[0]<-40||p[0]>W+40||p[1]<-40||p[1]>H+40)continue;
    if(j===selected){
      ctx.beginPath();ctx.arc(p[0],p[1],15,0,Math.PI*2);ctx.strokeStyle=pal.accent;ctx.lineWidth=2.5;ctx.stroke();
    }
    ctx.beginPath();ctx.arc(p[0],p[1],10.5,0,Math.PI*2);
    ctx.fillStyle=pal.casing;ctx.globalAlpha=.9;ctx.fill();ctx.globalAlpha=1;
    ctx.strokeStyle=pal.wpRing;ctx.lineWidth=2;ctx.stroke();
    ctx.font='13px "Apple Color Emoji","Segoe UI Emoji",system-ui,sans-serif';
    ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=pal.text;
    ctx.fillText(w.ic||'•',p[0],p[1]+.5);
    if((labels||j===selected)&&w.n){
      var name=w.n.length>16?w.n.slice(0,15)+'…':w.n;
      ctx.font='600 11px system-ui,-apple-system,sans-serif';
      var tw=ctx.measureText(name).width;
      var tx=p[0]+13;
      if(tx+tw>W-8)tx=p[0]-13-tw;
      var ty=p[1]+4;
      ctx.textAlign='left';
      ctx.lineJoin='round';ctx.strokeStyle=pal.casing;ctx.lineWidth=3.4;
      ctx.strokeText(name,tx,ty);
      ctx.fillStyle=pal.text;ctx.fillText(name,tx,ty);
    }
  }
}
function draw(){
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle=pal.bg;ctx.fillRect(0,0,W,H);
  var hasTiles=drawTiles();
  if(!hasTiles)drawGrid();
  if(pts.length>1){
    var sp=screenRoute();
    ctx.lineCap='round';ctx.lineJoin='round';
    strokePath(sp,pal.halo,13);
    strokePath(sp,pal.casing,8);
    if(playing||replay>0){
      strokePath(sp,pal.accent,4.4,.3);
      strokePath(partialRoute(sp,replay),pal.accent,5);
    }else{
      strokePath(sp,pal.accent,4.4);
    }
    drawMarkers(sp);
    if(playing||replay>0){
      var pos=pointAt(replay);
      if(pos){
        ctx.beginPath();ctx.arc(pos[0],pos[1],9,0,Math.PI*2);ctx.fillStyle=pal.casing;ctx.fill();
        ctx.beginPath();ctx.arc(pos[0],pos[1],6,0,Math.PI*2);ctx.fillStyle=pal.accent;ctx.fill();
      }
    }
  }
  drawWaypoints();
}
function resize(){
  W=window.innerWidth;H=window.innerHeight;
  cv.width=Math.round(W*dpr);cv.height=Math.round(H*dpr);
  cv.style.width=W+'px';cv.style.height=H+'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);
  fitBase();draw();
}

var pointers=new Map();
var drag=null,pinch=null,multi=false;
function pinchState(){
  var arr=[];pointers.forEach(function(v){arr.push(v);});
  if(arr.length<2)return null;
  var a=arr[0],b=arr[1];
  return {
    x:(a.x+b.x)/2,y:(a.y+b.y)/2,
    d:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y))
  };
}
function zoomAt(qx,qy,factor){
  var nz=clamp(state.z*factor,.55,8);
  var r=nz/state.z;
  state.tx=qx-base.cx-(qx-base.cx-state.tx)*r;
  state.ty=qy-base.cy-(qy-base.cy-state.ty)*r;
  state.z=nz;draw();
}
cv.addEventListener('pointerdown',function(e){
  e.preventDefault();
  try{cv.setPointerCapture(e.pointerId);}catch(err){}
  pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  hidePop();
  if(pointers.size===1){
    drag={sx:e.clientX,sy:e.clientY,x:e.clientX,y:e.clientY,moved:false};
    pinch=null;multi=false;
  }else{
    drag=null;multi=true;pinch=pinchState();
  }
});
cv.addEventListener('pointermove',function(e){
  var prev=pointers.get(e.pointerId);
  if(!prev)return;
  var dx=e.clientX-prev.x,dy=e.clientY-prev.y;
  pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(pointers.size===1&&drag){
    if(Math.hypot(e.clientX-drag.sx,e.clientY-drag.sy)>5)drag.moved=true;
    if(drag.moved){
      state.tx+=dx;state.ty+=dy;draw();
    }
  }else if(pointers.size>=2){
    var p=pinchState();
    if(pinch&&p){
      var r=clamp(p.d/pinch.d,.75,1.33);
      var nz=clamp(state.z*r,.55,8);
      var real=nz/state.z;
      state.tx=p.x-base.cx-(pinch.x-base.cx-state.tx)*real;
      state.ty=p.y-base.cy-(pinch.y-base.cy-state.ty)*real;
      state.z=nz;
      draw();
    }
    pinch=p;
  }
});
function endPointer(e){
  pointers.delete(e.pointerId);
  if(pointers.size===0){
    if(drag&&!drag.moved&&!multi)handleTap(e.clientX,e.clientY);
    drag=null;pinch=null;multi=false;
  }else{
    drag=null;pinch=pointers.size>=2?pinchState():null;
  }
}
cv.addEventListener('pointerup',endPointer);
cv.addEventListener('pointercancel',function(e){
  pointers.delete(e.pointerId);drag=null;pinch=null;multi=false;
});
cv.addEventListener('wheel',function(e){
  e.preventDefault();
  zoomAt(e.clientX,e.clientY,e.deltaY<0?1.22:.82);
},{passive:false});
document.getElementById('zin').addEventListener('click',function(){zoomAt(W/2,H/2,1.32);});
document.getElementById('zout').addEventListener('click',function(){zoomAt(W/2,H/2,.76);});
document.getElementById('zreset').addEventListener('click',function(){
  state.z=1;state.tx=0;state.ty=0;draw();hidePop();
});

function handleTap(x,y){
  var best=-1,bd=26*26;
  for(var j=0;j<wps.length;j++){
    var p=project(wps[j].lo,wps[j].la);
    var dd=(p[0]-x)*(p[0]-x)+(p[1]-y)*(p[1]-y);
    if(dd<bd){bd=dd;best=j;}
  }
  if(best>=0)showNode(best);else hidePop();
}
var pop=document.getElementById('wpPop');
function hidePop(){
  clearTimeout(popTimer);selected=-1;pop.hidden=true;draw();
}
function showNode(idx){
  selected=idx;
  var w=wps[idx],p=project(w.lo,w.la);
  pop.textContent='';
  var title=document.createElement('div');title.className='t';
  var ic=document.createElement('span');ic.textContent=w.ic||'•';
  var nm=document.createElement('span');nm.textContent=w.n||w.tl||'';
  title.appendChild(ic);title.appendChild(nm);
  var meta=document.createElement('div');meta.className='m';
  meta.textContent=[w.tl,w.tm,w.dst].filter(Boolean).join(' · ');
  pop.appendChild(title);pop.appendChild(meta);
  if(w.de){
    var desc=document.createElement('p');desc.textContent=w.de;
    pop.appendChild(desc);
  }
  pop.hidden=false;
  var left=Math.min(W-244,Math.max(10,p[0]+14));
  if(W<260)left=10;
  var top=Math.min(H-130,Math.max(10,p[1]+14));
  pop.style.left=left+'px';pop.style.top=top+'px';
  clearTimeout(popTimer);
  popTimer=setTimeout(hidePop,7000);
  draw();
}

function updatePlayUi(){
  var ic=document.getElementById('playIc'),tx=document.getElementById('playTxt');
  if(ic)ic.innerHTML=playing
    ?'<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'
    :'<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  if(tx)tx.textContent=playing?L.pause:L.replay;
}
function setReplay(p){
  replay=clamp(p,0,1);
  document.getElementById('progFill').style.width=(replay*100)+'%';
  draw();
}
function stopPlay(){
  playing=false;cancelAnimationFrame(raf);raf=0;updatePlayUi();
}
function tick(now){
  if(!playing)return;
  var p=playFrom+(now-playStart)/DUR;
  if(p>=1){setReplay(1);stopPlay();return;}
  setReplay(p);
  raf=requestAnimationFrame(tick);
}
document.getElementById('playBtn').addEventListener('click',function(){
  if(total<=0)return;
  if(playing){stopPlay();return;}
  if(replay>=1)setReplay(0);
  playing=true;playFrom=replay;playStart=performance.now();
  updatePlayUi();raf=requestAnimationFrame(tick);
});
document.getElementById('prog').addEventListener('pointerdown',function(e){
  e.preventDefault();e.stopPropagation();
  var r=e.currentTarget.getBoundingClientRect();
  setReplay((e.clientX-r.left)/Math.max(1,r.width));
  if(!playing)updatePlayUi();
});
if(total<=0){
  var pb=document.getElementById('playBtn');pb.disabled=true;pb.style.opacity='.45';
}
var profCv=document.getElementById('prof');
function drawProfile(){
  if(!profCv||!D.profile||D.profile.length<2)return;
  var w=profCv.clientWidth||320,h=profCv.clientHeight||140;
  profCv.width=Math.round(w*dpr);profCv.height=Math.round(h*dpr);
  var c=profCv.getContext('2d');c.setTransform(dpr,0,0,dpr,0,0);
  c.clearRect(0,0,w,h);
  var P=D.profile,padL=38,padR=8,padT=10,padB=20;
  var plotW=Math.max(10,w-padL-padR),plotH=Math.max(10,h-padT-padB);
  var d0=P[0][0],d1=P[P.length-1][0];
  if(d1<=d0)d1=d0+1;
  var lo=1e9,hi=-1e9;
  for(var j=0;j<P.length;j++){if(P[j][1]<lo)lo=P[j][1];if(P[j][1]>hi)hi=P[j][1];}
  if(hi-lo<2){var mid=(hi+lo)/2;lo=mid-1;hi=mid+1;}
  var pad=(hi-lo)*.12;lo-=pad;hi+=pad;
  function X(d){return padL+(d-d0)/(d1-d0)*plotW;}
  function Y(a){return padT+plotH-(a-lo)/(hi-lo)*plotH;}
  c.strokeStyle=pal.grid;c.lineWidth=1;
  for(var g=0;g<3;g++){
    var yy=padT+g*plotH/2;
    c.beginPath();c.moveTo(padL,yy);c.lineTo(w-padR,yy);c.stroke();
  }
  c.beginPath();
  for(var k=0;k<P.length;k++){k?c.lineTo(X(P[k][0]),Y(P[k][1])):c.moveTo(X(P[k][0]),Y(P[k][1]));}
  c.lineTo(X(d1),padT+plotH);c.lineTo(X(d0),padT+plotH);c.closePath();
  c.globalAlpha=.16;c.fillStyle=pal.accent;c.fill();c.globalAlpha=1;
  c.beginPath();
  for(var m=0;m<P.length;m++){m?c.lineTo(X(P[m][0]),Y(P[m][1])):c.moveTo(X(P[m][0]),Y(P[m][1]));}
  c.strokeStyle=pal.accent;c.lineWidth=2;c.lineJoin='round';c.lineCap='round';c.stroke();
  c.font='600 9.5px system-ui,-apple-system,sans-serif';
  c.fillStyle=pal.faint;c.textAlign='right';c.textBaseline='middle';
  c.fillText(Math.round(hi)+' '+(D.altUnit||'m'),padL-5,padT+4);
  c.fillText(Math.round(lo)+' '+(D.altUnit||'m'),padL-5,padT+plotH-2);
  c.textAlign='left';c.textBaseline='alphabetic';
  c.fillText('0',padL,h-6);
  c.textAlign='right';c.fillText(D.profileEnd||'',w-padR,h-6);
}

var sheet=document.getElementById('sheet'),scrim=document.getElementById('scrim');
function setSheet(open){
  sheet.classList.toggle('open',open);
  scrim.classList.toggle('show',open);
  sheet.setAttribute('aria-hidden',open?'false':'true');
  if(open){hidePop();setTimeout(drawProfile,60);}
}
document.getElementById('detailBtn').addEventListener('click',function(){setSheet(true);});
document.getElementById('closeBtn').addEventListener('click',function(){setSheet(false);});
scrim.addEventListener('click',function(){setSheet(false);});
document.addEventListener('keydown',function(e){if(e.key==='Escape')setSheet(false);});

function applyTheme(th){
  theme=th;
  var vars=D.css[th]||D.css.dark;
  pal=D.palettes[th]||D.palettes.dark;
  root.setAttribute('data-theme',th);
  for(var k in vars)root.style.setProperty(k,vars[k]);
  if(metaTheme)metaTheme.setAttribute('content',pal.bg);
  draw();drawProfile();
}
var cycle=D.themeCycle||Object.keys(D.palettes||{});
document.getElementById('themeBtn').addEventListener('click',function(){
  var idx=cycle.indexOf(theme);
  applyTheme(cycle[(idx+1)%cycle.length]);
});

function probe(url,ms){
  return new Promise(function(res){
    var img=new Image();
    var done=false;
    var timer=setTimeout(function(){if(done)return;done=true;img.src='';res(false);},ms);
    img.onload=function(){if(done)return;done=true;clearTimeout(timer);res(true);};
    img.onerror=function(){if(done)return;done=true;clearTimeout(timer);res(false);};
    img.src=url;
  });
}
function tzGuess(){
  try{
    var tz=Intl.DateTimeFormat().resolvedOptions().timeZone||'';
    return /^Asia\/(Shanghai|Urumqi|Chongqing|Harbin|Kashgar)/.test(tz)?'cn':'global';
  }catch(err){return 'global';}
}
function chooseProvider(p){
  provider=p;useGcj=p==='amap';
  state.z=1;state.tx=0;state.ty=0;
  fitBase();loadTiles();
  setBadge(p==='amap'?'AMap · GCJ-02':'OSM · WGS-84');
  setAttrib(p==='amap'?'© 高德地图 AMap':'© OpenStreetMap contributors');
}
function initTiles(){
  if(D.tier==='none'){setBadge(L.vector||'vector');setAttrib('');return;}
  if(navigator.onLine===false){setBadge(L.vector||'vector');setAttrib('');return;}
  var a='https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=4&y=2&z=3';
  var o='https://tile.openstreetmap.org/3/4/2.png';
  Promise.all([probe(a,1800),probe(o,1800)]).then(function(r){
    var cnOk=r[0],glOk=r[1];
    var guess=tzGuess();
    if(guess==='cn'&&cnOk)chooseProvider('amap');
    else if(guess==='global'&&glOk)chooseProvider('osm');
    else if(cnOk)chooseProvider('amap');
    else if(glOk)chooseProvider('osm');
    else {setBadge(L.vector||'vector');setAttrib('');}
  });
}

window.addEventListener('resize',function(){
  resize();
  setTimeout(drawProfile,40);
});
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(function(){setTimeout(drawProfile,30);});
resize();
setTimeout(drawProfile,30);
initTiles();
})();
`;
