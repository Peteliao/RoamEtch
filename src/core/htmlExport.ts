// Rich self-contained single-file trip page:
// - warm offline layout, optional online CN/Global basemap
// - full stats, elevation profile, waypoint timeline + embedded thumbs
// - interactive pan/zoom, replay, theme switch, branded footer
import { simplify, fmtDistance, fmtDuration, fmtSpeed, fmtPace, fmtAltitude, haversine } from './geo';
import { applyPrivacy } from './privacy';
import { computeStats } from './stats';
import { get } from './settings';
import { effectiveTheme } from './theme';
import { t, currentLang } from './i18n';
import { tripTimeInfo, routePlaceNames } from './shareInfo';
import { WP_ICONS } from './waypointMeta';
import { SITE_URL, drawQr } from './brand';
import { paletteFor } from './palette';
import { VIEWER_CSS, VIEWER_JS } from './htmlExportViewer';

const THEMES = ['dark', 'light', 'contrast'];

export const HTML_TIERS = {
  clear: { tol: 3, points: 2_000, waypoints: 30, photos: 12, budget: 680_000 },
  light: { tol: 15, points: 900, waypoints: 16, photos: 6, budget: 300_000 },
  none: { tol: 20, points: 600, waypoints: 10, photos: 0, budget: 0 }
};

export type HtmlTier = keyof typeof HTML_TIERS;

export function htmlTierConfig(tier: string) {
  return HTML_TIERS[tier as HtmlTier] || HTML_TIERS.clear;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hexA(hex, a) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function cssVars(theme) {
  const p = paletteFor(theme);
  return {
    'color-scheme': theme === 'dark' ? 'dark' : 'light',
    '--bg': p.vectorBg,
    '--panel': p.panel,
    '--text': p.text,
    '--muted': p.muted,
    '--faint': p.faint,
    '--accent': p.accent,
    '--accent-soft': p.accentSoft,
    '--accent-ink': theme === 'dark' ? '#06251d' : '#ffffff',
    '--amber': p.amber,
    '--chip': p.cellBg,
    '--border': theme === 'contrast' ? '#000000' : theme === 'light' ? 'rgba(24,37,31,.13)' : 'rgba(255,255,255,.14)',
    '--border2': theme === 'contrast' ? '#000000' : theme === 'light' ? 'rgba(24,37,31,.22)' : 'rgba(255,255,255,.24)',
    '--glass': theme === 'contrast' ? 'rgba(255,255,255,.97)' : hexA(p.panel, theme === 'light' ? 0.9 : 0.86),
    '--sheet': p.panel,
    '--shadow': theme === 'contrast'
      ? '0 18px 44px rgba(0,0,0,.22)'
      : theme === 'light' ? '0 20px 50px rgba(24,37,31,.18)' : '0 20px 50px rgba(0,0,0,.42)'
  };
}

function styleAttr(vars) {
  return Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');
}

function canvasPalettes() {
  const out = {};
  for (const th of THEMES) {
    const p = paletteFor(th);
    out[th] = {
      bg: p.vectorBg,
      panel: p.panel,
      grid: p.grid,
      accent: p.accent,
      amber: p.amber,
      text: p.text,
      muted: p.muted,
      halo: p.trackHalo,
      casing: p.trackCasing,
      wpRing: p.wpRing,
      endRing: p.endRing
    };
  }
  return out;
}

let brandQr = null;
function qrDataUrl() {
  if (brandQr !== null) return brandQr;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 168;
    const ctx = c.getContext('2d');
    if (!ctx) return (brandQr = '');
    drawQr(ctx, SITE_URL, 0, 0, 168);
    brandQr = c.toDataURL('image/png');
  } catch {
    brandQr = '';
  }
  return brandQr;
}

function blobDataUrl(blob) {
  return new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }).catch(() => { clearTimeout(timer); resolve(fallback); });
  });
}

function buildProfile(series) {
  const d = series?.d || [];
  const alt = series?.alt || [];
  if (alt.length < 2) return [];
  const step = Math.max(1, Math.ceil(alt.length / 240));
  const out = [];
  for (let i = 0; i < alt.length; i += step) {
    if (alt[i] == null || !isFinite(alt[i])) continue;
    out.push([Math.round(d[i] || 0), Math.round(alt[i] * 10) / 10]);
  }
  const lastIdx = alt.length - 1;
  if (alt[lastIdx] != null && isFinite(alt[lastIdx])) {
    const last = [Math.round(d[lastIdx] || 0), Math.round(alt[lastIdx] * 10) / 10];
    if (!out.length || out[out.length - 1][0] !== last[0]) out.push(last);
  }
  return out.length >= 2 ? out : [];
}

function fullPointTrack(full) {
  const pts = full.segments.flatMap((s) => s.points || []);
  if (!pts.length) return { pts: [], cum: [] };
  const stride = Math.max(1, Math.ceil(pts.length / 20000));
  const sample = [];
  for (let i = 0; i < pts.length; i += stride) sample.push(pts[i]);
  if (sample[sample.length - 1] !== pts[pts.length - 1]) sample.push(pts[pts.length - 1]);
  const cum = [0];
  for (let i = 1; i < sample.length; i++) {
    cum.push(cum[i - 1] + haversine(sample[i - 1].lat, sample[i - 1].lon, sample[i].lat, sample[i].lon));
  }
  return { pts: sample, cum };
}

function nearestTrackDistance(track, lat, lon) {
  if (!track.pts.length) return null;
  let best = Infinity, idx = 0;
  for (let i = 0; i < track.pts.length; i++) {
    const p = track.pts[i];
    const d = haversine(lat, lon, p.lat, p.lon);
    if (d < best) { best = d; idx = i; }
  }
  return track.cum[idx];
}

async function attachPhotos(nodes, media, enabled, cfg) {
  if (!enabled || !cfg.photos || !media?.length) return 0;
  const byId = new Map(media.map((m) => [m.id, m]));
  let budget = cfg.budget;
  let used = 0;
  for (const node of nodes) {
    if (used >= cfg.photos) break;
    const ids = node.wp.mediaIds || [];
    if (!ids.length) continue;
    const rec = ids.map((id) => byId.get(id)).find(Boolean);
    const blob = rec?.thumb || rec?.blob;
    if (!blob) continue;
    try {
      const url = await blobDataUrl(blob);
      if (!url || url.length > 140_000 || url.length > budget) continue;
      node.img = url;
      budget -= url.length;
      used++;
    } catch { /* a single unreadable thumb should not fail the export */ }
  }
  return used;
}

function clockText(ts, locale, sameDayAs) {
  if (!ts) return '';
  const d = new Date(ts);
  if (!isFinite(d.getTime())) return '';
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (!sameDayAs || d.toDateString() === sameDayAs.toDateString()) return time;
  return `${d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} ${time}`;
}

type BuildOpts = {
  tier?: string;
  privacy?: { radius?: number; hideSensitive?: boolean };
  includePhotos?: boolean;
  places?: string[];
  onProgress?: (p: number) => void;
};

export function estimateHTMLSize(full, { tier = 'clear', privacy = {}, includePhotos = true }: BuildOpts = {}) {
  const cfg = htmlTierConfig(tier);
  const cropped = applyPrivacy(full, privacy);
  const pts = simplify(cropped.segments.flatMap((s) => s.points || []), cfg.tol).slice(0, cfg.points);
  const nodeCount = Math.min(cropped.waypoints.length, cfg.waypoints);
  const photoCount = includePhotos && cfg.photos ? Math.min(cfg.photos, full.media?.length || 0) : 0;
  const base = VIEWER_CSS.length + VIEWER_JS.length + 24_000;
  const trackBytes = pts.length * 24;
  const nodeBytes = nodeCount * 360;
  const photoBytes = Math.min(cfg.budget, photoCount * 52_000);
  return base + trackBytes + nodeBytes + photoBytes;
}

export async function buildSelfContainedHTML(full, opts: BuildOpts = {}) {
  const { tier = 'clear', privacy = {}, includePhotos = true, onProgress } = opts;
  const cfg = htmlTierConfig(tier);
  const cropped = applyPrivacy(full, privacy);
  const routePts = cropped.segments.flatMap((s) => s.points || []);
  const tol = cfg.tol;
  const pointLimit = cfg.points;
  const wpsLimit = cfg.waypoints;
  const pts = simplify(routePts, tol).slice(0, pointLimit);
  const stats = computeStats(cropped.segments, {
    ascentThreshold: get('ascentThreshold'),
    activity: full.trip.activity,
    weightKg: get('weightKg')
  });
  const units = get('units');
  const locale = currentLang().startsWith('zh') ? 'zh-CN' : 'en-US';
  const lang = locale === 'zh-CN' ? 'zh-CN' : 'en';
  const initialTheme = effectiveTheme();
  const ti = tripTimeInfo(full);
  const track = fullPointTrack(cropped);
  const sameDay = ti ? new Date(ti.ts) : null;

  onProgress?.(0.15);
  const placePromise = opts.places?.length
    ? Promise.resolve(opts.places.slice(0, 6))
    : navigator.onLine === false
      ? Promise.resolve([])
      : withTimeout(routePlaceNames(cropped.segments, { max: 6 }), 3800, [] as string[]);

  const nodes = cropped.waypoints
    .slice(0, wpsLimit)
    .map((w, i) => {
      const type = w.type || 'custom';
      const typeLabel = t(`wp.types.${type}`);
      const dist = nearestTrackDistance(track, w.lat, w.lon);
      return {
        wp: w,
        idx: i,
        name: w.name || typeLabel,
        type,
        typeLabel,
        icon: WP_ICONS[type] || WP_ICONS.custom,
        la: Math.round(w.lat * 1e6) / 1e6,
        lo: Math.round(w.lon * 1e6) / 1e6,
        tm: clockText(w.time, locale, sameDay),
        dst: dist == null ? '' : (() => { const v = fmtDistance(dist, units); return `${v.v} ${v.u}`; })(),
        dNum: dist ?? Number.MAX_SAFE_INTEGER,
        de: String(w.desc || '').slice(0, 600),
        pc: (w.mediaIds || []).length,
        img: ''
      };
    })
    .sort((a, b) => a.dNum - b.dNum || a.idx - b.idx);

  const photos = await attachPhotos(nodes, full.media, includePhotos, cfg);
  onProgress?.(0.55);
  const places = (await placePromise).filter(Boolean).slice(0, 6);
  onProgress?.(0.8);

  const dist = fmtDistance(stats.distance, units);
  const asc = fmtAltitude(stats.ascent, units);
  const desc = fmtAltitude(stats.descent, units);
  const maxAlt = stats.maxAlt == null ? null : fmtAltitude(stats.maxAlt, units);
  const minAlt = stats.minAlt == null ? null : fmtAltitude(stats.minAlt, units);
  const avgSpeed = fmtSpeed(stats.avgSpeed, units);
  const maxSpeed = fmtSpeed(stats.maxSpeed, units);
  const avgPace = fmtPace(stats.avgSpeed, units);
  const durationMs = stats.duration || ti?.durationMs || 0;
  const durationShort = durationMs > 0 ? fmtDuration(durationMs, { compact: true }) : '--';
  const profile = buildProfile(stats.series);
  const profileEndObj = profile.length ? fmtDistance(profile[profile.length - 1][0], units) : null;

  const title = full.trip.name || t('record.newTripName');
  const activity = t(`record.activities.${full.trip.activity || 'auto'}`);
  const dateText = (ti ? new Date(ti.ts) : new Date(full.trip.createdAt || Date.now()))
    .toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
  const startText = ti ? clockText(ti.ts, locale, sameDay) : '';
  const endText = ti ? clockText(ti.te, locale, sameDay) : '';
  const privacyRadius = Math.max(0, +privacy.radius || 0);
  const privacyText = privacyRadius > 0
    ? t('export.htmlPrivacyOn', { r: privacyRadius })
    : t('export.htmlPrivacyOff');

  const detailRows: [string, string][] = [];
  if (stats.hasTime) {
    detailRows.push([t('analysis.activeTime'), fmtDuration(stats.activeMs)]);
    if (stats.breakMs > 0) detailRows.push([t('analysis.gapTime'), fmtDuration(stats.breakMs)]);
    detailRows.push([t('analysis.movingTime'), fmtDuration(stats.movingMs)]);
    detailRows.push([t('analysis.stillTime'), fmtDuration(stats.stillMs)]);
    detailRows.push([t('analysis.avgSpeed'), `${avgSpeed.v} ${avgSpeed.u}`]);
    detailRows.push([t('analysis.avgPace'), `${avgPace.v} ${avgPace.u}`]);
    detailRows.push([t('analysis.maxSpeed'), `${maxSpeed.v} ${maxSpeed.u}`]);
  }
  detailRows.push([t('analysis.ascent'), `${asc.v} ${asc.u}`]);
  detailRows.push([t('analysis.descent'), `${desc.v} ${desc.u}`]);
  if (maxAlt) detailRows.push([t('analysis.maxAlt'), `${maxAlt.v} ${maxAlt.u}`]);
  if (minAlt) detailRows.push([t('analysis.minAlt'), `${minAlt.v} ${minAlt.u}`]);
  if (stats.calories != null) detailRows.push([t('analysis.calories'), `${stats.calories} kcal`]);
  if (stats.avgAcc != null) detailRows.push([t('panel.accuracy'), `±${Math.round(stats.avgAcc)} m`]);
  detailRows.push([t('analysis.points'), String(stats.pointCount)]);

  const labels = {
    replay: t('export.htmlReplay'),
    pause: t('export.htmlPause'),
    vector: t('export.htmlVector')
  };

  const data = {
    v: 2,
    tier,
    pts: pts.map((p) => [Math.round(p.lon * 1e6) / 1e6, Math.round(p.lat * 1e6) / 1e6]),
    wps: nodes.map((n) => ({
      n: n.name, ty: n.type, tl: n.typeLabel, ic: n.icon,
      la: n.la, lo: n.lo, tm: n.tm, dst: n.dst, de: n.de
    })),
    profile,
    profileEnd: profileEndObj ? `${profileEndObj.v} ${profileEndObj.u}` : '',
    altUnit: fmtAltitude(0, units).u,
    labels,
    palettes: canvasPalettes(),
    css: Object.fromEntries(THEMES.map((th) => [th, cssVars(th)]))
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

  const statsHtml = detailRows
    .map(([k, v]) => `<div class="s"><div class="sv">${esc(v)}</div><div class="sk">${esc(k)}</div></div>`)
    .join('');
  const placesHtml = places.length
    ? `<div class="places">${places.map((p) => `<span class="place">${esc(p)}</span>`).join('')}</div>`
    : '';
  const profileHtml = profile.length
    ? '<div class="chartwrap"><canvas id="prof"></canvas></div>'
    : `<div class="empty">${esc(t('analysis.noAlt'))}</div>`;
  const nodeHtml = nodes.length
    ? `<div class="nodes">${nodes.map((n) => {
        const bits = [n.tm, n.dst, n.pc > 1 ? t('export.htmlPhotoCount', { n: n.pc }) : n.pc === 1 ? t('wp.photos') : '']
          .filter(Boolean);
        return `<article class="node">
          <div class="node-ico">${esc(n.icon)}</div>
          <div class="node-body">
            <div class="node-title"><span>${esc(n.name)}</span><span class="nbadge">${esc(n.typeLabel)}</span></div>
            ${bits.length ? `<div class="node-meta">${esc(bits.join(' · '))}</div>` : ''}
            ${n.de ? `<p>${esc(n.de)}</p>` : ''}
            ${n.img ? `<img src="${n.img}" alt="${esc(n.name)}" loading="lazy" decoding="async">` : ''}
          </div>
        </article>`;
      }).join('')}</div>`
    : `<div class="empty">${esc(t('export.htmlNoNodes'))}</div>`;

  const qr = qrDataUrl();
  const brandFoot = `<div class="brandfoot">
    ${qr ? `<img class="qr" src="${qr}" alt="QR">` : ''}
    <div>
      <div class="bf-slogan">${esc(t('app.slogan'))}</div>
      <a class="bf-link" href="${SITE_URL}" target="_blank" rel="noopener">${esc(SITE_URL.replace(/^https?:\/\//, ''))}</a>
      <div class="bf-sub">${esc(t('export.htmlScan'))}</div>
    </div>
  </div>`;
  const initialVars = cssVars(initialTheme);
  const initialPal = paletteFor(initialTheme);

  const html = `<!doctype html>
<html lang="${lang}" data-theme="${initialTheme}" style="${styleAttr(initialVars)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" id="tc" content="${initialPal.vectorBg}">
<meta name="description" content="${esc(title)} · RoamEtch">
<title>${esc(title)} · RoamEtch</title>
<style>${VIEWER_CSS}</style>
</head>
<body>
<canvas id="map"></canvas>
<div id="hud">
  <header class="trip-head">
    <div class="head-top">
      <span class="brandmark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M4 18c3.2-7 5.4 1 8.4-3S16 8 20 6"/><circle cx="4" cy="18" r="2" fill="currentColor" stroke="none"/><circle cx="20" cy="6" r="2" fill="currentColor" stroke="none"/></svg></span>
      <span class="brandname">RoamEtch</span>
      <span class="grow"></span>
      <button class="round sm" id="themeBtn" type="button" aria-label="${esc(t('export.htmlTheme'))}" title="${esc(t('export.htmlTheme'))}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>
      </button>
    </div>
    <h1>${esc(title)}</h1>
    <div class="meta">
      <span class="act-pill">${esc(activity)}</span>
      <span>${esc(dateText)}</span>
      ${startText ? `<span class="dot"></span><span>${esc(startText)}–${esc(endText)}</span>` : ''}
    </div>
    ${placesHtml}
  </header>
  <div class="map-tools">
    <button class="round" id="zin" type="button" aria-label="${esc(t('export.htmlZoomIn'))}" title="${esc(t('export.htmlZoomIn'))}">+</button>
    <button class="round" id="zout" type="button" aria-label="${esc(t('export.htmlZoomOut'))}" title="${esc(t('export.htmlZoomOut'))}">−</button>
    <button class="round" id="zreset" type="button" aria-label="${esc(t('export.htmlResetView'))}" title="${esc(t('export.htmlResetView'))}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.6 9A8 8 0 1 1 4 12"/><path d="M4 4v5h5"/></svg>
    </button>
  </div>
  <div class="wp-pop" id="wpPop" hidden></div>
  <footer class="dock">
    <div class="prog" id="prog"><div class="ptrack"><div id="progFill"></div></div></div>
    <div class="metrics">
      <div class="m hero"><div class="mv">${esc(dist.v)}<small>${esc(dist.u)}</small></div><div class="mk">${esc(t('analysis.distance'))}</div></div>
      <div class="m"><div class="mv">${esc(durationShort)}</div><div class="mk">${esc(t('analysis.duration'))}</div></div>
      <div class="m"><div class="mv">${esc(asc.v)}<small>${esc(asc.u)}</small></div><div class="mk">↑ ${esc(t('analysis.ascent'))}</div></div>
      <div class="m"><div class="mv">${nodes.length}</div><div class="mk">${esc(t('wp.title'))}</div></div>
    </div>
    <div class="dock-actions">
      <span class="guide">${esc(t('export.htmlGuide'))}</span>
      <span class="bm" id="bm">${esc(t('export.htmlVector'))}</span>
      <button class="btn" id="playBtn" type="button"><span id="playIc"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></span><span id="playTxt">${esc(t('export.htmlReplay'))}</span></button>
      <button class="btn primary" id="detailBtn" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>${esc(t('export.htmlDetail'))}</button>
    </div>
  </footer>
  <div class="scrim" id="scrim"></div>
  <aside class="sheet" id="sheet" aria-hidden="true" aria-label="${esc(t('export.htmlDetail'))}">
    <div class="sheet-head">
      <div class="handle"></div>
      <div class="sheet-bar">
        <h2>${esc(t('export.htmlDetail'))}</h2>
        <span class="grow"></span>
        <button class="round sm" id="closeBtn" type="button" aria-label="${esc(t('common.close'))}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
        </button>
      </div>
    </div>
    <div class="sheet-body">
      <div class="statgrid">${statsHtml}</div>
      <div class="sec">${esc(t('analysis.elevProfile'))}</div>
      ${profileHtml}
      <div class="sec">${esc(t('export.htmlTimeline'))} ${nodes.length ? `<span class="count">${nodes.length}</span>` : ''}</div>
      ${nodeHtml}
      ${brandFoot}
      <div class="fine">${esc(privacyText)} · ${esc(t('export.htmlMadeBy'))}${photos ? ` · ${photos} ${esc(t('wp.photos'))}` : ''}<br><span id="attrib">© OpenStreetMap contributors</span></div>
    </div>
  </aside>
</div>
<script>window.__TRIP__=${json};</script>
<script>${VIEWER_JS}</script>
</body>
</html>`;
  onProgress?.(1);
  const size = new Blob([html], { type: 'text/html' }).size;
  return { html, size, places, photos };
}
