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
.round.active{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}
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
.speed-control{flex:none;height:32px;display:inline-flex;align-items:center}
.speed-control select,.profile-tools select{
  height:32px;border:1px solid var(--border);border-radius:9px;padding:0 7px;
  background:var(--chip);color:var(--text);font:700 12px system-ui,-apple-system,sans-serif;
}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
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
  box-shadow:var(--shadow);pointer-events:auto;
  -webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);
}
.wp-pop[hidden]{display:none}
.wp-pop .t{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:850;line-height:1.3}
.wp-pop .t span:first-child{font-size:15px}
.wp-pop .m{font-size:12px;color:var(--muted);margin-top:3px}
.wp-pop p{margin:6px 0 0;font-size:12px;line-height:1.45;color:var(--muted);white-space:pre-wrap;max-height:110px;overflow:hidden}
.wp-pop .pop-photos{display:flex;gap:5px;margin-top:8px;overflow-x:auto;max-width:100%}
.wp-pop .pop-photos img{width:68px;height:52px;object-fit:cover;border-radius:8px;background:var(--chip);cursor:zoom-in;flex:none}
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
.chartwrap canvas{display:block;width:100%;height:100%;touch-action:none;cursor:crosshair}
.profile-tools{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 2px 7px}
#profileValue{font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap}
.gap-list{display:grid;gap:7px}
.gap-item{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:11px;background:var(--chip)}
.gap-dot{width:9px;height:9px;border-radius:50%;border:2px solid var(--amber);flex:none}
.gap-item.privacy .gap-dot{border-color:var(--muted);background:transparent}
.gap-kind{font-size:12px;font-weight:800}
.gap-meta{font-size:12px;color:var(--faint);margin-top:2px;font-variant-numeric:tabular-nums}
.checkrow{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;font-weight:700;cursor:pointer}
.checkrow input{width:16px;height:16px;accent-color:var(--accent)}
.hint{font-size:12px;line-height:1.45;color:var(--faint);margin-top:6px}
.gap-none{margin:0 2px}
.empty{padding:12px;border-radius:12px;background:var(--chip);color:var(--faint);font-size:12px}
.nodes{position:relative}
.node{display:flex;gap:11px;padding:10px 0;position:relative;cursor:pointer;border-radius:8px}
.node:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
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
.node-gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:6px;margin-top:8px}
.node-gallery img{
  display:block;width:100%;height:126px;object-fit:cover;border-radius:12px;
  background:var(--chip);cursor:zoom-in;
}
.lightbox{
  position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;
  padding:18px;background:rgba(0,0,0,.84);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);
}
.lightbox[hidden]{display:none}
.lightbox img{max-width:100%;max-height:86vh;border-radius:14px;box-shadow:var(--shadow)}
.lightbox .close{position:absolute;top:calc(12px + env(safe-area-inset-top,0px));right:12px}
.lightbox .nav{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:44px;font-size:20px}
.lightbox .prev{left:12px}.lightbox .next{right:12px}
.brandfoot{
  display:flex;align-items:center;gap:12px;margin-top:20px;padding:10px;
  border-radius:14px;background:var(--chip);
}
.brandfoot .qr{width:74px;height:74px;border-radius:9px;background:#fff;flex:none;display:block}
.brandfoot>div{min-width:0}
.bf-slogan{font-size:13px;font-weight:850;line-height:1.35}
.bf-slogan span{display:block}
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
  content:'';position:fixed;inset:-8%;z-index:1;pointer-events:none;filter:blur(12px);opacity:.82;
  background:radial-gradient(ellipse at 12% 8%,color-mix(in srgb,var(--fx-primary) 24%,transparent),transparent 46%),
    radial-gradient(ellipse at 88% 34%,color-mix(in srgb,var(--fx-secondary) 20%,transparent),transparent 44%),
    radial-gradient(ellipse at 54% 96%,rgba(129,140,255,.14),transparent 50%),
    linear-gradient(118deg,transparent 0 43%,color-mix(in srgb,var(--fx-primary) 9%,transparent) 49%,transparent 58%);
}
html[data-theme="neon"] body::after{
  content:'';position:fixed;inset:0;z-index:1;pointer-events:none;
  background:radial-gradient(ellipse at center,transparent 58%,rgba(2,3,12,.42) 100%);
}
html[data-theme="neon"] .trip-head h1,html[data-theme="neon"] .mv{text-shadow:0 0 10px color-mix(in srgb,var(--fx-primary) 26%,transparent)}
html[data-theme="starship"] body::before{
  content:'';position:fixed;inset:-6%;z-index:1;pointer-events:none;filter:blur(8px);opacity:.86;
  background:radial-gradient(circle at 84% 16%,color-mix(in srgb,var(--fx-primary) 17%,transparent),transparent 27%),
    radial-gradient(ellipse at 10% 88%,color-mix(in srgb,var(--fx-secondary) 13%,transparent),transparent 44%),
    radial-gradient(ellipse at 52% 46%,rgba(33,77,110,.20),transparent 58%),
    linear-gradient(132deg,transparent 0 62%,color-mix(in srgb,var(--fx-secondary) 7%,transparent) 68%,transparent 76%);
}
html[data-theme="starship"] body::after{
  content:'';position:fixed;inset:0;z-index:1;pointer-events:none;
  background:radial-gradient(ellipse at center,transparent 56%,rgba(1,6,11,.46) 100%);
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
html[data-theme="sakura"] body::before{
  content:'';position:fixed;inset:-10%;z-index:1;pointer-events:none;filter:blur(16px);
  background:radial-gradient(ellipse at 16% 8%,rgba(255,255,255,.78),transparent 42%),
    radial-gradient(ellipse at 86% 72%,color-mix(in srgb,var(--fx-primary) 15%,transparent),transparent 46%),
    radial-gradient(ellipse at 8% 94%,color-mix(in srgb,var(--fx-secondary) 9%,transparent),transparent 38%),
    linear-gradient(126deg,transparent 0 54%,rgba(255,255,255,.24) 62%,transparent 72%);
  animation:viewer-sakura 20s ease-in-out infinite alternate;
}
@keyframes viewer-sakura{to{transform:translate3d(2%,-1.5%,0)}}
html[data-theme="sakura"] body::after{content:'';position:fixed;inset:0;z-index:1;pointer-events:none;background:linear-gradient(124deg,rgba(255,255,255,.18),transparent 34%,transparent 76%,rgba(200,95,125,.035))}
html[data-theme="butterfly"] body::before{
  content:'';position:fixed;inset:-12%;z-index:1;pointer-events:none;filter:blur(18px);
  background:radial-gradient(ellipse at 18% 12%,color-mix(in srgb,var(--fx-primary) 17%,transparent),transparent 44%),
    radial-gradient(ellipse at 84% 26%,color-mix(in srgb,var(--fx-secondary) 15%,transparent),transparent 42%),
    radial-gradient(ellipse at 66% 92%,rgba(230,150,199,.16),transparent 48%),
    conic-gradient(from 210deg at 72% 24%,transparent 0 72%,rgba(255,255,255,.20) 78%,transparent 84%);
  animation:viewer-butterfly 18s ease-in-out infinite alternate;
}
@keyframes viewer-butterfly{to{transform:translate3d(-2%,2%,0) rotate(1.5deg)}}
html[data-theme="butterfly"] body::after{content:'';position:fixed;inset:0;z-index:1;pointer-events:none;background:linear-gradient(118deg,rgba(255,255,255,.24),transparent 40%,transparent 72%,rgba(63,159,154,.05))}
html[data-theme="pearl"] body::before{
  content:'';position:fixed;inset:-8%;z-index:1;pointer-events:none;filter:blur(7px);
  background:radial-gradient(circle at 72% 18%,rgba(255,255,255,.92),transparent 34%),
    radial-gradient(ellipse at 14% 82%,color-mix(in srgb,var(--fx-secondary) 13%,transparent),transparent 46%),
    conic-gradient(from 28deg at 72% 18%,rgba(255,255,255,.28),rgba(246,235,213,.10),rgba(255,255,255,.30),rgba(230,214,186,.08),rgba(255,255,255,.28)),
    repeating-radial-gradient(ellipse at 88% 90%,transparent 0 44px,color-mix(in srgb,var(--fx-primary) 5%,transparent) 45px 46px);
  animation:viewer-pearl 16s ease-in-out infinite alternate;
}
@keyframes viewer-pearl{to{transform:translate3d(1%,1%,0);opacity:.86}}
html[data-theme="pearl"] body::after{content:'';position:fixed;inset:0;z-index:1;pointer-events:none;background:radial-gradient(ellipse at center,transparent 62%,rgba(105,87,63,.07) 100%)}
html[data-theme="rose"] body::before{
  content:'';position:fixed;inset:-8%;z-index:1;pointer-events:none;
  background:radial-gradient(ellipse at 20% 10%,color-mix(in srgb,var(--fx-primary) 17%,transparent),transparent 46%),
    radial-gradient(ellipse at 86% 84%,color-mix(in srgb,var(--fx-secondary) 10%,transparent),transparent 42%),
    linear-gradient(132deg,rgba(255,255,255,.025),transparent 38%,rgba(216,181,106,.035));
}
html[data-theme="rose"] body::after{
  content:'';position:fixed;inset:10px;z-index:1;pointer-events:none;border:1px solid rgba(216,181,106,.18);
  box-shadow:inset 0 0 70px rgba(10,2,6,.20),inset 0 0 0 1px rgba(217,139,159,.035);
}
html[data-theme="rose"] h1,html[data-theme="rose"] .mv{font-family:"Noto Serif CJK SC","Songti SC",serif}
html[data-theme="contrast"] body::before{content:'';position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.65;background:repeating-linear-gradient(122deg,transparent 0 94px,color-mix(in srgb,var(--fx-secondary) 8%,transparent) 95px 96px)}
html.oled-lock body::before,html.oled-lock body::after{display:none!important}
@media (max-width:370px){
  .trip-head{padding:10px 12px}
  .m{padding-right:5px}
  .m + .m{padding-left:8px}
  .mv{font-size:16.5px}
  .statgrid{grid-template-columns:repeat(2,1fr)}
  .btn{padding:0 9px}
  .bm{display:none}
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
var segs=(D.segs&&D.segs.length?D.segs:[pts]).filter(function(s){return s&&s.length>1;});
var wps=D.wps||[];
var gaps=D.gaps||[];
var profiles=D.profiles||{elevation:D.profile||[]};
var profileType='elevation';
var showArrows=true,showGapLinks=false,replaySpeed=1;
var state={z:1,tx:0,ty:0};
var base=null;
var useGcj=false,provider=null;
var tiles=[],tileZ=0,tileLoaded=0,tileFailed=0;
var theme=root.getAttribute('data-theme')||'dark';
var pal=D.palettes[theme]||D.palettes.dark;
var selected=-1,popTimer=0;
var playing=false,replay=0,raf=0,playStart=0,playFrom=0;
var DUR=18000;
var trackColor=D.trackColor||pal.accent;
var customTrackColor=!!D.trackColor;
var trackWidth=Math.max(3.4,Math.min(9,+D.trackWidth||4.4));
var segCums=[],segLengths=[],total=0,i=0;
function distLL(a,b){
  var dx=b[0]-a[0],dy=b[1]-a[1],rr=Math.PI/180;
  var h=Math.sin(dy*rr/2)*Math.sin(dy*rr/2)+Math.cos(a[1]*rr)*Math.cos(b[1]*rr)*Math.sin(dx*rr/2)*Math.sin(dx*rr/2);
  return 6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
}
for(i=0;i<segs.length;i++){
  var seg=segs[i],cc=[0],sum=0;
  for(var j=1;j<seg.length;j++){sum+=distLL(seg[j-1],seg[j]);cc.push(sum);}
  segCums.push(cc);segLengths.push(sum);total+=sum;
}

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
function centerOn(lon,lat,zoom){
  state.z=clamp(zoom||Math.max(1.6,state.z),.55,8);
  state.tx=0;state.ty=0;
  var p=project(lon,lat);
  state.tx=W/2-p[0];
  state.ty=base.cy-p[1];
  draw();
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
function strokeSegs(list,color,width,alpha){
  if(!list||!list.length)return;
  ctx.strokeStyle=color;ctx.lineWidth=width;
  ctx.globalAlpha=alpha==null?1:alpha;
  for(var j=0;j<list.length;j++){
    var arr=list[j];
    if(!arr||arr.length<2)continue;
    ctx.beginPath();
    for(var k=0;k<arr.length;k++){k?ctx.lineTo(arr[k][0],arr[k][1]):ctx.moveTo(arr[k][0],arr[k][1]);}
    ctx.stroke();
  }
  ctx.globalAlpha=1;
}
function screenSegs(){
  var out=[];
  for(var j=0;j<segs.length;j++){
    var s=segs[j],q=[];
    for(var k=0;k<s.length;k++)q.push(project(s[k][0],s[k][1]));
    out.push(q);
  }
  return out;
}
function partialSegs(spSegs,p){
  if(p==null||p>=1)return spSegs;
  var target=total*clamp(p,0,1),acc=0,out=[];
  for(var j=0;j<spSegs.length;j++){
    var len=segLengths[j]||0;
    if(target>=acc+len){
      out.push(spSegs[j]);
      acc+=len;
      continue;
    }
    var local=Math.max(0,target-acc);
    var cum=segCums[j],part=[];
    for(var k=0;k<spSegs[j].length;k++){
      if(cum[k]<=local)part.push(spSegs[j][k]);
      else break;
    }
    var idx=part.length-1;
    if(idx>=0&&idx<spSegs[j].length-1){
      var span=(cum[idx+1]-cum[idx])||1;
      var f=clamp((local-cum[idx])/span,0,1);
      var a=spSegs[j][idx],b=spSegs[j][idx+1];
      part.push([a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f]);
    }
    if(part.length)out.push(part);
    break;
  }
  return out;
}
function pointAtD(d){
  var target=clamp(d,0,total),acc=0;
  for(var j=0;j<segs.length;j++){
    var len=segLengths[j]||0;
    if(target>acc+len){acc+=len;continue;}
    var local=target-acc,cum=segCums[j],sp=[];
    for(var k=0;k<segs[j].length;k++)sp.push(project(segs[j][k][0],segs[j][k][1]));
    var idx=0;
    while(idx<cum.length-1&&cum[idx+1]<local)idx++;
    if(idx>=sp.length-1)return sp[sp.length-1];
    var span=(cum[idx+1]-cum[idx])||1;
    var f=clamp((local-cum[idx])/span,0,1);
    return [sp[idx][0]+(sp[idx+1][0]-sp[idx][0])*f,sp[idx][1]+(sp[idx+1][1]-sp[idx][1])*f];
  }
  var last=segs.length?segs[segs.length-1]:[];
  return last.length?project(last[last.length-1][0],last[last.length-1][1]):null;
}
function pointAt(p){return pointAtD(total*p);}
function waypointProgress(w){
  if(w.pr!=null&&isFinite(w.pr))return clamp(w.pr,0,1);
  if(total<=0)return 0;
  var best=Infinity,bestD=0,offset=0,cos=Math.max(.01,Math.cos(w.la*Math.PI/180));
  function wrap(v){return ((v+180)%360+360)%360-180;}
  for(var j=0;j<segs.length;j++){
    var s=segs[j],cum=segCums[j];
    for(var k=0;k<s.length-1;k++){
      var a=s[k],b=s[k+1],ax=wrap(a[0]-w.lo)*cos,ay=a[1]-w.la;
      var bx=wrap(b[0]-w.lo)*cos,by=b[1]-w.la,dx=bx-ax,dy=by-ay;
      var f=dx*dx+dy*dy>0?clamp(-(ax*dx+ay*dy)/(dx*dx+dy*dy),0,1):0;
      var lon=a[0]+wrap(b[0]-a[0])*f,lat=a[1]+(b[1]-a[1])*f;
      var d=distLL([w.lo,w.la],[lon,lat]);
      if(d<best){best=d;bestD=offset+cum[k]+(cum[k+1]-cum[k])*f;}
    }
    offset+=segLengths[j]||0;
  }
  return clamp(bestD/total,0,1);
}
function drawMarkers(spSegs){
  if(!spSegs.length)return;
  var first=spSegs[0][0];
  var lastArr=spSegs[spSegs.length-1];
  var end=lastArr[lastArr.length-1];
  if(first&&!D.hideStart){
    ctx.beginPath();ctx.arc(first[0],first[1],10,0,Math.PI*2);ctx.fillStyle=pal.casing;ctx.fill();
    ctx.beginPath();ctx.arc(first[0],first[1],6.2,0,Math.PI*2);ctx.fillStyle=trackColor;ctx.fill();
  }
  if(end&&!D.hideEnd){
    ctx.beginPath();ctx.arc(end[0],end[1],10.5,0,Math.PI*2);ctx.fillStyle=pal.endRing;ctx.fill();
    ctx.beginPath();ctx.arc(end[0],end[1],6.2,0,Math.PI*2);ctx.fillStyle=pal.amber;ctx.fill();
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
function drawGapLinks(){
  if(!showGapLinks)return;
  ctx.save();ctx.setLineDash([7,7]);ctx.lineCap='butt';
  ctx.strokeStyle=pal.amber;ctx.lineWidth=2;ctx.globalAlpha=.65;
  for(var j=0;j<gaps.length;j++){
    var gap=gaps[j];
    if(gap.kind!=='recording'||!gap.a||!gap.b)continue;
    var a=project(gap.a[0],gap.a[1]),b=project(gap.b[0],gap.b[1]);
    ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);ctx.stroke();
  }
  ctx.restore();
}
function drawGapMarkers(){
  for(var j=0;j<gaps.length;j++){
    var gap=gaps[j],color=gap.kind==='privacy'?pal.muted:pal.amber;
    var ends=[gap.a,gap.b];
    for(var k=0;k<ends.length;k++){
      if(!ends[k])continue;
      var p=project(ends[k][0],ends[k][1]);
      if(p[0]<-20||p[0]>W+20||p[1]<-20||p[1]>H+20)continue;
      ctx.beginPath();ctx.arc(p[0],p[1],4.5,0,Math.PI*2);
      ctx.fillStyle=pal.bg;ctx.fill();ctx.strokeStyle=color;ctx.lineWidth=2;ctx.stroke();
    }
  }
}
function drawDirection(spSegs){
  if(!showArrows)return;
  var spacing=clamp(W*.12,52,92);
  ctx.lineCap='round';ctx.lineJoin='round';
  for(var j=0;j<spSegs.length;j++){
    var arr=spSegs[j],travel=0,next=spacing*.55;
    for(var k=1;k<arr.length;k++){
      var a=arr[k-1],b=arr[k],dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy);
      if(len<.5){travel+=len;continue;}
      while(next<=travel+len){
        var f=(next-travel)/len,x=a[0]+dx*f,y=a[1]+dy*f;
        var ux=dx/len,uy=dy/len,nx=-uy,ny=ux;
        function arrow(color,width){
          ctx.beginPath();ctx.moveTo(x-ux*4+nx*4,y-uy*4+ny*4);
          ctx.lineTo(x+ux*4,y+uy*4);
          ctx.lineTo(x-ux*4-nx*4,y-uy*4-ny*4);
          ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();
        }
        arrow(pal.casing,4.8);arrow(pal.text,2.1);
        next+=spacing;
      }
      travel+=len;
    }
  }
}
function draw(){
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle=pal.bg;ctx.fillRect(0,0,W,H);
  var hasTiles=drawTiles();
  if(!hasTiles)drawGrid();
  drawGapLinks();
  if(segs.length){
    var sp=screenSegs();
    ctx.lineCap='round';ctx.lineJoin='round';
    strokeSegs(sp,pal.halo,13);
    strokeSegs(sp,pal.casing,8);
    if(playing||replay>0){
      strokeSegs(sp,trackColor,trackWidth,.28);
      strokeSegs(partialSegs(sp,replay),trackColor,Math.max(4,trackWidth+.6));
    }else{
      strokeSegs(sp,trackColor,trackWidth);
    }
    drawMarkers(sp);
    drawDirection(sp);
    drawGapMarkers();
    if(playing||replay>0){
      var pos=pointAt(replay);
      if(pos){
        ctx.beginPath();ctx.arc(pos[0],pos[1],9,0,Math.PI*2);ctx.fillStyle=pal.casing;ctx.fill();
        ctx.beginPath();ctx.arc(pos[0],pos[1],6,0,Math.PI*2);ctx.fillStyle=pal.amber;ctx.fill();
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
var directionBtn=document.getElementById('directionBtn');
directionBtn&&directionBtn.addEventListener('click',function(){
  showArrows=!showArrows;
  directionBtn.classList.toggle('active',showArrows);
  directionBtn.setAttribute('aria-pressed',showArrows?'true':'false');
  draw();
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
var lightbox=null,lightboxItems=[],lightboxIndex=0;
function closeLightbox(){
  if(lightbox)lightbox.hidden=true;
  lightboxItems=[];lightboxIndex=0;
}
function openLightbox(items,index){
  if(!items||!items.length)return;
  hidePop();
  if(!lightbox){
    lightbox=document.createElement('div');
    lightbox.className='lightbox';
    lightbox.hidden=true;
    lightbox.setAttribute('role','dialog');
    lightbox.setAttribute('aria-modal','true');
    var close=document.createElement('button');
    close.type='button';close.className='round close';close.setAttribute('aria-label',L.close);close.textContent='×';
    close.addEventListener('click',closeLightbox);
    var prev=document.createElement('button');
    prev.type='button';prev.className='round nav prev';prev.setAttribute('aria-label',L.previous);prev.textContent='‹';
    prev.addEventListener('click',function(){lightboxStep(-1);});
    var next=document.createElement('button');
    next.type='button';next.className='round nav next';next.setAttribute('aria-label',L.next);next.textContent='›';
    next.addEventListener('click',function(){lightboxStep(1);});
    var im=document.createElement('img');
    im.alt='';
    lightbox.appendChild(im);lightbox.appendChild(close);lightbox.appendChild(prev);lightbox.appendChild(next);
    lightbox.addEventListener('click',function(e){if(e.target===lightbox)closeLightbox();});
    document.body.appendChild(lightbox);
  }
  lightboxItems=items.slice();lightboxIndex=index||0;
  lightbox.hidden=false;
  lightbox.querySelector('img').src=items[lightboxIndex];
  var multi=items.length>1;
  lightbox.querySelector('.prev').style.display=multi?'':'none';
  lightbox.querySelector('.next').style.display=multi?'':'none';
}
function lightboxStep(step){
  if(!lightboxItems.length)return;
  lightboxIndex=(lightboxIndex+step+lightboxItems.length)%lightboxItems.length;
  lightbox.querySelector('img').src=lightboxItems[lightboxIndex];
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
  if(w.ph&&w.ph.length){
    var gallery=document.createElement('div');gallery.className='pop-photos';
    for(var j=0;j<w.ph.length;j++){
      (function(src,index){
        var im=document.createElement('img');
        im.src=src;im.alt=(w.n||'')+' '+(index+1);im.loading='lazy';
        im.addEventListener('click',function(e){e.stopPropagation();openLightbox(w.ph,index);});
        gallery.appendChild(im);
      })(w.ph[j],j);
    }
    pop.appendChild(gallery);
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
function locateNode(idx){
  var w=wps[idx];
  if(!w)return;
  setSheet(false);stopPlay();hidePop();
  centerOn(w.lo,w.la,1.8);
  showNode(idx);
  setReplay(waypointProgress(w));
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
  if(sheet&&sheet.classList.contains('open'))drawProfile();
}
function stopPlay(){
  playing=false;cancelAnimationFrame(raf);raf=0;updatePlayUi();
}
function tick(now){
  if(!playing)return;
  var p=playFrom+(now-playStart)*replaySpeed/DUR;
  if(p>=1){setReplay(1);stopPlay();return;}
  setReplay(p);
  raf=requestAnimationFrame(tick);
}
function togglePlay(){
  if(total<=0)return;
  if(playing){stopPlay();return;}
  if(replay>=1)setReplay(0);
  playing=true;playFrom=replay;playStart=performance.now();
  updatePlayUi();raf=requestAnimationFrame(tick);
}
document.getElementById('playBtn').addEventListener('click',togglePlay);
var speedSel=document.getElementById('speedSel');
speedSel&&speedSel.addEventListener('change',function(){
  replaySpeed=clamp(+speedSel.value||1,1,5);
  if(playing){playFrom=replay;playStart=performance.now();}
});
var prog=document.getElementById('prog');
var scrubbing=false;
function progressAt(e){
  var r=prog.getBoundingClientRect();
  return (e.clientX-r.left)/Math.max(1,r.width);
}
prog.addEventListener('pointerdown',function(e){
  e.preventDefault();e.stopPropagation();
  try{prog.setPointerCapture(e.pointerId);}catch(err){}
  scrubbing=true;stopPlay();
  setReplay(progressAt(e));
});
prog.addEventListener('pointermove',function(e){
  if(!scrubbing)return;
  e.preventDefault();
  setReplay(progressAt(e));
});
function endScrub(e){
  if(!scrubbing)return;
  scrubbing=false;
  try{prog.releasePointerCapture(e.pointerId);}catch(err){}
}
prog.addEventListener('pointerup',endScrub);
prog.addEventListener('pointercancel',endScrub);
if(total<=0){
  var pb=document.getElementById('playBtn');pb.disabled=true;pb.style.opacity='.45';
}
var profCv=document.getElementById('prof');
var profSel=document.getElementById('profileSel');
var profGeom={padL:38,padR:8,plotW:1,plotH:1,d0:0,d1:1};
function activeProfile(){
  var p=profiles[profileType];
  return p&&p.length>=2?p:null;
}
function profileUnit(){
  return profileType==='speed'?(D.speedUnit||'km/h'):profileType==='slope'?'%':(D.altUnit||'m');
}
if(profSel){
  var available=['elevation','speed','slope'].filter(function(key){return profiles[key]&&profiles[key].length>=2;});
  if(available.indexOf(profSel.value)<0&&available.length){profSel.value=available[0];profileType=available[0];}
  profSel.addEventListener('change',function(){profileType=profSel.value;drawProfile();});
}
function drawProfile(){
  var P=activeProfile();
  if(!profCv||!P)return;
  var w=profCv.clientWidth||320,h=profCv.clientHeight||140;
  profCv.width=Math.round(w*dpr);profCv.height=Math.round(h*dpr);
  var c=profCv.getContext('2d');c.setTransform(dpr,0,0,dpr,0,0);
  c.clearRect(0,0,w,h);
  var padL=38,padR=8,padT=10,padB=20;
  var plotW=Math.max(10,w-padL-padR),plotH=Math.max(10,h-padT-padB);
  var d0=P[0][0],d1=P[P.length-1][0];
  if(d1<=d0)d1=d0+1;
  profGeom={padL:padL,padR:padR,plotW:plotW,plotH:plotH,d0:d0,d1:d1};
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
  var unit=profileUnit();
  c.fillText(Math.round(hi)+' '+unit,padL-5,padT+4);
  c.fillText(Math.round(lo)+' '+unit,padL-5,padT+plotH-2);
  c.textAlign='left';c.textBaseline='alphabetic';
  c.fillText('0',padL,h-6);
  c.textAlign='right';c.fillText(D.profileEnd||'',w-padR,h-6);
  if(replay>0||playing){
    var target=(isFinite(D.distance)?D.distance:d1)*clamp(replay,0,1);
    var xx=X(target);
    c.strokeStyle=pal.amber;c.lineWidth=1.5;
    c.beginPath();c.moveTo(xx,padT);c.lineTo(xx,padT+plotH);c.stroke();
    var best=0,bestD=1e9;
    for(var q=0;q<P.length;q++){var dd=Math.abs(P[q][0]-target);if(dd<bestD){bestD=dd;best=q;}}
    c.beginPath();c.arc(xx,Y(P[best][1]),3.8,0,Math.PI*2);c.fillStyle=pal.amber;c.fill();
    var pv=document.getElementById('profileValue');
    if(pv)pv.textContent=P[best][1]+' '+unit;
  }
}
var profDrag=false;
function profileSeek(e){
  if(!profCv)return;
  var r=profCv.getBoundingClientRect();
  var frac=(e.clientX-r.left-profGeom.padL)/Math.max(1,profGeom.plotW);
  setReplay(clamp(frac,0,1));
}
profCv&&profCv.addEventListener('pointerdown',function(e){
  e.preventDefault();profDrag=true;stopPlay();
  try{profCv.setPointerCapture(e.pointerId);}catch(err){}
  profileSeek(e);
});
profCv&&profCv.addEventListener('pointermove',function(e){
  if(!profDrag)return;
  e.preventDefault();profileSeek(e);
});
function endProfileDrag(e){
  if(!profDrag)return;
  profDrag=false;
  try{profCv.releasePointerCapture(e.pointerId);}catch(err){}
}
profCv&&profCv.addEventListener('pointerup',endProfileDrag);
profCv&&profCv.addEventListener('pointercancel',endProfileDrag);

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
var gapConnect=document.getElementById('gapConnect');
gapConnect&&gapConnect.addEventListener('change',function(){showGapLinks=!!gapConnect.checked;draw();});
sheet.addEventListener('click',function(e){
  if(e.target&&e.target.closest&&e.target.closest('.node-gallery'))return;
  var node=e.target&&e.target.closest?e.target.closest('.node[data-node]'):null;
  if(node)locateNode(+node.getAttribute('data-node'));
});
sheet.addEventListener('keydown',function(e){
  if(e.key!=='Enter'&&e.key!==' ')return;
  var node=e.target&&e.target.matches?e.target.matches('.node[data-node]')?e.target:null:null;
  if(node){e.preventDefault();e.stopPropagation();locateNode(+node.getAttribute('data-node'));}
});
document.addEventListener('click',function(e){
  var im=e.target&&e.target.closest?e.target.closest('.node-gallery img'):null;
  if(!im)return;
  var gallery=im.closest('.node-gallery');
  var imgs=gallery?[].slice.call(gallery.querySelectorAll('img')):[im];
  openLightbox(imgs.map(function(x){return x.getAttribute('src');}),Math.max(0,imgs.indexOf(im)));
});
document.addEventListener('keydown',function(e){
  if(e.defaultPrevented)return;
  var tag=e.target&&e.target.tagName?e.target.tagName.toUpperCase():'';
  if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT')return;
  if(e.key==='Escape'){
    if(lightbox&&!lightbox.hidden){closeLightbox();e.preventDefault();return;}
    setSheet(false);hidePop();return;
  }
  if(lightbox&&!lightbox.hidden){
    if(e.key==='ArrowLeft'){lightboxStep(-1);e.preventDefault();}
    else if(e.key==='ArrowRight'){lightboxStep(1);e.preventDefault();}
    return;
  }
  if(tag==='BUTTON'&&(e.key===' '||e.key==='Enter'))return;
  if(e.key===' '||e.key==='Spacebar'){e.preventDefault();togglePlay();return;}
  if(e.key==='ArrowLeft'||e.key==='ArrowRight'){
    e.preventDefault();stopPlay();
    setReplay(replay+(e.key==='ArrowRight'?1:-1)*(e.shiftKey?0.1:0.02));
    return;
  }
  if(e.key==='Home'){e.preventDefault();stopPlay();setReplay(0);return;}
  if(e.key==='End'){e.preventDefault();stopPlay();setReplay(1);return;}
  if(e.key==='+'||e.key==='='){e.preventDefault();zoomAt(W/2,H/2,1.22);return;}
  if(e.key==='-'||e.key==='_'){e.preventDefault();zoomAt(W/2,H/2,.82);return;}
  if(e.key==='r'||e.key==='R'){e.preventDefault();state.z=1;state.tx=0;state.ty=0;draw();hidePop();return;}
  if(e.key==='t'||e.key==='T'){e.preventDefault();document.getElementById('themeBtn').click();}
});

function applyTheme(th){
  theme=th;
  var vars=D.css[th]||D.css.dark;
  pal=D.palettes[th]||D.palettes.dark;
  if(!customTrackColor)trackColor=pal.accent;
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
