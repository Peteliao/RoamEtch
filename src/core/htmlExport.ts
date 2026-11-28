// Rich self-contained single-file trip page:
// - warm offline layout, optional online CN/Global basemap
// - full stats, elevation profile, waypoint timeline + embedded thumbs
// - interactive pan/zoom, replay, theme switch, branded footer
import { simplify, fmtDistance, fmtDuration, fmtSpeed, fmtPace, fmtAltitude, haversine, sampleTrackSegments, usableTrackPoints, interpolateLongitude } from './geo';
import { applyPrivacy, type PrivacyOptions } from './privacy';
import { computeStats } from './stats';
import { get } from './settings';
import { languageTag } from './language';
import { effectiveTheme } from './theme';
import { t, currentLang } from './i18n';
import { tripTimeInfo, routePlaceNames } from './shareInfo';
import { WP_ICONS } from './waypointMeta';
import { SITE_URL, drawQr } from './brand';
import { paletteFor } from './palette';
import { CONCRETE_THEME_IDS, HTML_THEME_CYCLE, htmlCssVars, themeDefinition } from './themeRegistry';
import { VIEWER_CSS, VIEWER_JS } from './htmlExportViewer';
import { normalizeShareStyle, trackColorValue } from './shareStyle';

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

function cssVars(theme) {
  return htmlCssVars(theme);
}

function styleAttr(vars) {
  return Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');
}

function canvasPalettes() {
  const out = {};
  for (const th of CONCRETE_THEME_IDS) {
    const p = paletteFor(th);
    out[th] = {
      bg: p.vectorBg,
      panel: p.panel,
      grid: p.grid,
      accent: p.accent,
      amber: p.amber,
      text: p.text,
      muted: p.muted,
      faint: p.faint,
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

function buildProfile(series, value: 'alt' | 'speed' | 'slope', scale = 1, distances: number[] = []) {
  const sourceD = series?.d || [];
  const values = series?.[value] || [];
  const d = distances.length === values.length ? distances : sourceD;
  if (values.length < 2) return [];
  const step = Math.max(1, Math.ceil(values.length / 240));
  const out = [];
  for (let i = 0; i < values.length; i += step) {
    if (values[i] == null || !isFinite(values[i])) continue;
    out.push([Math.round(d[i] || 0), Math.round(values[i] * scale * 10) / 10]);
  }
  const lastIdx = values.length - 1;
  if (values[lastIdx] != null && isFinite(values[lastIdx])) {
    const last = [Math.round(d[lastIdx] || 0), Math.round(values[lastIdx] * scale * 10) / 10];
    if (!out.length || out[out.length - 1][0] !== last[0]) out.push(last);
  }
  return out.length >= 2 ? out : [];
}

function fullPointTrack(full) {
  const tracks = [];
  const distances = [];
  let total = 0;
  for (const segment of full.segments || []) {
    const points = usableTrackPoints(segment.points || []);
    if (points.length < 2) continue;
    const cum = [0];
    distances.push(total);
    for (let index = 1; index < points.length; index++) {
      const step = haversine(points[index - 1].lat, points[index - 1].lon, points[index].lat, points[index].lon);
      cum.push(cum[index - 1] + step);
      distances.push(total + cum[index]);
    }
    tracks.push({ points, cum, offset: total });
    total += cum[cum.length - 1];
  }
  return { tracks, distances, total };
}

function wrapLongitude(value: number) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function nearestTrackDistance(track, waypoint) {
  if (!track.tracks.length) return null;
  const cosine = Math.max(0.01, Math.cos(waypoint.lat * Math.PI / 180));
  const candidates = [];
  for (const { points, cum, offset } of track.tracks) {
    for (let index = 0; index < points.length - 1; index++) {
      const from = points[index], to = points[index + 1];
      const ax = wrapLongitude(from.lon - waypoint.lon) * cosine;
      const ay = from.lat - waypoint.lat;
      const bx = wrapLongitude(to.lon - waypoint.lon) * cosine;
      const by = to.lat - waypoint.lat;
      const dx = bx - ax, dy = by - ay;
      const fraction = dx * dx + dy * dy > 0
        ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
        : 0;
      const lat = from.lat + (to.lat - from.lat) * fraction;
      const lon = interpolateLongitude(from.lon, to.lon, fraction);
      const spatial = haversine(waypoint.lat, waypoint.lon, lat, lon);
      const time = Number.isFinite(from.t) && Number.isFinite(to.t) && to.t > from.t
        ? from.t + (to.t - from.t) * fraction
        : null;
      const timeDelta = Number.isFinite(waypoint.time) && time != null
        ? Math.abs(waypoint.time - time)
        : Number.POSITIVE_INFINITY;
      candidates.push({
        spatial,
        timeDelta,
        distance: offset + cum[index] + (cum[index + 1] - cum[index]) * fraction
      });
    }
  }
  if (!candidates.length) return null;
  const nearest = candidates.reduce((best, candidate) => candidate.spatial < best.spatial ? candidate : best);
  const timed = candidates.filter((candidate) => candidate.spatial <= nearest.spatial + 25
    && Number.isFinite(candidate.timeDelta));
  const chosen = timed.length
    ? timed.reduce((best, candidate) => candidate.timeDelta < best.timeDelta ? candidate : best)
    : nearest;
  return {
    distance: chosen.distance,
    progress: track.total > 0 ? Math.max(0, Math.min(1, chosen.distance / track.total)) : 0
  };
}

function sameTrackPoint(a, b) {
  return !!a && !!b && haversine(a.lat, a.lon, b.lat, b.lon) < 0.05;
}

function buildExportGaps(segments, originalSegments, units) {
  const boundaries = [];
  for (let index = 0; index < originalSegments.length - 1; index++) {
    const from = originalSegments[index]?.points?.at(-1);
    const to = originalSegments[index + 1]?.points?.[0];
    if (from && to) boundaries.push({ from, to });
  }
  const gaps = [];
  for (let index = 0; index < segments.length - 1; index++) {
    const from = segments[index].points.at(-1), to = segments[index + 1].points[0];
    const distance = haversine(from.lat, from.lon, to.lat, to.lon);
    const recording = boundaries.some((boundary) => sameTrackPoint(from, boundary.from) && sameTrackPoint(to, boundary.to));
    if (distance < 2 && recording) continue;
    const dt = Number.isFinite(from.t) && Number.isFinite(to.t) && to.t > from.t ? to.t - from.t : null;
    const formatted = fmtDistance(distance, units);
    gaps.push({
      a: [Math.round(from.lon * 1e6) / 1e6, Math.round(from.lat * 1e6) / 1e6],
      b: [Math.round(to.lon * 1e6) / 1e6, Math.round(to.lat * 1e6) / 1e6],
      d: Math.round(distance),
      dt,
      kind: recording ? 'recording' : 'privacy',
      text: `${formatted.v} ${formatted.u}${dt ? ` · ${fmtDuration(dt, { compact: true })}` : ''}`
    });
  }
  return gaps;
}

async function attachPhotos(nodes, media, enabled, cfg) {
  if (!enabled || !cfg.photos || !media?.length) return 0;
  const byId = new Map<any, any>();
  for (const m of (media as any[])) byId.set(m.id, m);
  let budget = cfg.budget;
  let used = 0;
  const perNode = 3;
  for (const node of nodes) {
    if (used >= cfg.photos) break;
    const ids = node.wp.mediaIds || [];
    if (!ids.length) continue;
    const imgs = [];
    for (const id of ids) {
      if (imgs.length >= perNode || used >= cfg.photos || budget <= 0) break;
      const rec = byId.get(id);
      const blob = rec?.thumb || rec?.blob;
      if (!blob) continue;
      try {
        const url = await blobDataUrl(blob);
        if (!url || url.length > 140_000 || url.length > budget) continue;
        imgs.push(url);
        budget -= url.length;
        used++;
      } catch { /* a single unreadable thumb should not fail the export */ }
    }
    node.imgs = imgs;
    node.img = imgs[0] || '';
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
  style?: any;
  privacy?: PrivacyOptions;
  includePhotos?: boolean;
  places?: string[];
  onProgress?: (p: number) => void;
};

export function estimateHTMLSize(full, { tier = 'clear', privacy = {}, includePhotos = true }: BuildOpts = {}) {
  const cfg = htmlTierConfig(tier);
  const preview = { ...full, segments: sampleTrackSegments(full.segments || [], 4000) };
  const cropped = applyPrivacy(preview, privacy);
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
  const style = normalizeShareStyle(opts.style || {});
  const cfg = htmlTierConfig(tier);
  const cropped = applyPrivacy(full, privacy);
  const tol = cfg.tol;
  const pointLimit = cfg.points;
  const wpsLimit = cfg.waypoints;
  const simplified = cropped.segments
    .map((segment) => simplify(segment.points || [], tol))
    .filter((segment) => segment.length >= 2);
  const totalSimplified = simplified.reduce((sum, segment) => sum + segment.length, 0);
  const stride = Math.max(1, Math.ceil(totalSimplified / pointLimit));
  const exportSegments = simplified
    .map((segment) => segment.filter((_, index) => index % stride === 0 || index === segment.length - 1))
    .filter((segment) => segment.length >= 2)
    .map((points) => ({ points }));
  const segs = exportSegments
    .map((segment) => segment.points.map((p) => [Math.round(p.lon * 1e6) / 1e6, Math.round(p.lat * 1e6) / 1e6]));
  const pts = segs.flat();
  const trackColor = trackColorValue(style.trackColor, '');
  const stats = computeStats(exportSegments, {
    ascentThreshold: get('ascentThreshold'),
    activity: full.trip.activity,
    weightKg: get('weightKg')
  });
  const units = get('units');
  const locale = languageTag(currentLang());
  const lang = locale;
  const initialTheme = effectiveTheme();
  const ti = tripTimeInfo(full);
  const track = fullPointTrack({ segments: exportSegments });
  const gaps = buildExportGaps(exportSegments, full.segments, units);
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
      const match = nearestTrackDistance(track, w);
      const dist = match?.distance ?? null;
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
        pr: match?.progress ?? null,
        de: String(w.desc || '').slice(0, 600),
        pc: (w.mediaIds || []).length,
        img: '',
        imgs: [] as string[]
      };
    })
    .sort((a, b) => a.dNum - b.dNum || a.idx - b.idx);

  const photos = await attachPhotos(nodes, full.media, includePhotos, cfg);
  onProgress?.(0.55);
  const places = (await placePromise).filter(Boolean).slice(0, 6);
  onProgress?.(0.8);

  const dist = fmtDistance(track.total, units);
  const asc = fmtAltitude(stats.ascent, units);
  const desc = fmtAltitude(stats.descent, units);
  const maxAlt = stats.maxAlt == null ? null : fmtAltitude(stats.maxAlt, units);
  const minAlt = stats.minAlt == null ? null : fmtAltitude(stats.minAlt, units);
  const avgSpeed = fmtSpeed(stats.avgSpeed, units);
  const maxSpeed = fmtSpeed(stats.maxSpeed, units);
  const avgPace = fmtPace(stats.avgSpeed, units);
  const durationMs = stats.duration || ti?.durationMs || 0;
  const durationShort = durationMs > 0 ? fmtDuration(durationMs, { compact: true }) : '--';
  const profiles = {
    elevation: buildProfile(stats.series, 'alt', units === 'imperial' ? 3.28084 : 1, track.distances),
    speed: buildProfile(stats.series, 'speed', units === 'imperial' ? 2.23694 : 3.6, track.distances),
    slope: buildProfile(stats.series, 'slope', 1, track.distances)
  };
  const profile = profiles.elevation;
  const profileEndObj = fmtDistance(track.total, units);

  const title = full.trip.name || t('record.newTripName');
  const activity = t(`record.activities.${full.trip.activity || 'auto'}`);
  const dateText = (ti ? new Date(ti.ts) : new Date(full.trip.createdAt || Date.now()))
    .toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
  const startText = ti ? clockText(ti.ts, locale, sameDay) : '';
  const endText = ti ? clockText(ti.te, locale, sameDay) : '';
  const privacyRadius = Math.max(0, +privacy.radius || 0);
  const privacyParts = privacyRadius > 0
    ? [privacy.mode === 'ends'
      ? t('export.htmlPrivacyEnds', { r: privacyRadius })
      : t('export.htmlPrivacyOn', { r: privacyRadius })]
    : [t('export.htmlPrivacyOff')];
  if (privacyRadius > 0 && privacy.offset) {
    privacyParts.push(t('export.htmlPrivacyOffset', { r: Math.round(privacyRadius * 1.25) }));
  }
  const privacyText = privacyParts.join(' · ');
  const privacyIcons = privacy.hideStartIcon || privacy.hideEndIcon
    ? (privacy.hideStartIcon && privacy.hideEndIcon ? t('export.htmlIconsBothHidden')
      : privacy.hideStartIcon ? t('export.htmlStartIconHidden') : t('export.htmlEndIconHidden'))
    : '';

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
    vector: t('export.htmlVector'),
    direction: t('export.htmlDirection'),
    speed: t('export.htmlSpeed'),
    elevation: t('export.htmlElevation'),
    speedProfile: t('export.htmlSpeedProfile'),
    slopeProfile: t('export.htmlSlopeProfile'),
    gaps: t('export.htmlGaps'),
    gapRecording: t('export.htmlGapRecording'),
    gapPrivacy: t('export.htmlGapPrivacy'),
    gapNone: t('export.htmlGapNone'),
    gapConnect: t('export.htmlGapConnect'),
    gapConnectHint: t('export.htmlGapConnectHint'),
    close: t('common.close'),
    previous: t('common.previous'),
    next: t('common.next')
  };

  const data = {
    v: 4,
    tier,
    distance: track.total,
    segs,
    pts: pts.map((p) => [p[0], p[1]]),
    wps: nodes.map((n) => ({
      n: n.name, ty: n.type, tl: n.typeLabel, ic: n.icon,
      la: n.la, lo: n.lo, tm: n.tm, dst: n.dst, pr: n.pr, de: n.de, ph: n.imgs
    })),
    profile,
    profiles,
    profileEnd: `${profileEndObj.v} ${profileEndObj.u}`,
    altUnit: fmtAltitude(0, units).u,
    speedUnit: fmtSpeed(0, units).u,
    slopeUnit: '%',
    gaps,
    labels,
    palettes: canvasPalettes(),
    css: Object.fromEntries(CONCRETE_THEME_IDS.map((th) => [th, cssVars(th)])),
    themeCycle: HTML_THEME_CYCLE,
    hideStart: !!privacy.hideStartIcon,
    hideEnd: !!privacy.hideEndIcon,
    trackColor,
    trackWidth: style.trackWidth
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

  const statsHtml = detailRows
    .map(([k, v]) => `<div class="s"><div class="sv">${esc(v)}</div><div class="sk">${esc(k)}</div></div>`)
    .join('');
  const placesHtml = places.length
    ? `<div class="places">${places.map((p) => `<span class="place">${esc(p)}</span>`).join('')}</div>`
    : '';
  const hasProfile = Object.values(profiles).some((points) => points.length >= 2);
  const profileHtml = hasProfile
    ? `<div class="profile-tools"><select id="profileSel" aria-label="${esc(t('export.htmlProfile'))}">
        <option value="elevation"${profiles.elevation.length >= 2 ? '' : ' disabled'}>${esc(t('export.htmlElevation'))}</option>
        <option value="speed"${profiles.speed.length >= 2 ? '' : ' disabled'}>${esc(t('export.htmlSpeedProfile'))}</option>
        <option value="slope"${profiles.slope.length >= 2 ? '' : ' disabled'}>${esc(t('export.htmlSlopeProfile'))}</option>
      </select><span id="profileValue"></span></div>
      <div class="chartwrap"><canvas id="prof"></canvas></div>`
    : `<div class="empty">${esc(t('analysis.noAlt'))}</div>`;
  const gapsHtml = gaps.length
    ? `<div class="gap-list">${gaps.map((gap) => `<div class="gap-item ${gap.kind}">
        <span class="gap-dot"></span><div><div class="gap-kind">${esc(t(`export.htmlGap${gap.kind === 'recording' ? 'Recording' : 'Privacy'}`))}</div>
        <div class="gap-meta">${esc(gap.text)}</div></div>
      </div>`).join('')}</div>
      ${gaps.some((gap) => gap.kind === 'recording')
        ? `<label class="checkrow"><input id="gapConnect" type="checkbox"><span>${esc(t('export.htmlGapConnect'))}</span></label><div class="hint">${esc(t('export.htmlGapConnectHint'))}</div>`
        : ''}`
    : `<div class="hint gap-none">${esc(t('export.htmlGapNone'))}</div>`;
  const nodeHtml = nodes.length
    ? `<div class="nodes">${nodes.map((n, i) => {
        const bits = [n.tm, n.dst, n.pc > 1 ? t('export.htmlPhotoCount', { n: n.pc }) : n.pc === 1 ? t('wp.photos') : '']
          .filter(Boolean);
        return `<article class="node" data-node="${i}" tabindex="0" role="button" aria-label="${esc(n.name)}">
          <div class="node-ico">${esc(n.icon)}</div>
          <div class="node-body">
            <div class="node-title"><span>${esc(n.name)}</span><span class="nbadge">${esc(n.typeLabel)}</span></div>
            ${bits.length ? `<div class="node-meta">${esc(bits.join(' · '))}</div>` : ''}
            ${n.de ? `<p>${esc(n.de)}</p>` : ''}
            ${n.imgs.length ? `<div class="node-gallery">${n.imgs.map((src, index) => `<img src="${src}" alt="${esc(n.name)} ${index + 1}" loading="lazy" decoding="async">`).join('')}</div>` : ''}
          </div>
        </article>`;
      }).join('')}</div>`
    : `<div class="empty">${esc(t('export.htmlNoNodes'))}</div>`;

  const qr = qrDataUrl();
  const brandFoot = `<div class="brandfoot">
    ${qr ? `<img class="qr" src="${qr}" alt="QR">` : ''}
    <div>
      <div class="bf-slogan"><span>${esc(t('app.slogan1'))}</span><span>${esc(t('app.slogan2'))}</span></div>
      <a class="bf-link" href="${SITE_URL}" target="_blank" rel="noopener">${esc(SITE_URL.replace(/^https?:\/\//, ''))}</a>
      <div class="bf-sub">${esc(t('export.htmlScan'))}</div>
    </div>
  </div>`;
  const initialVars = cssVars(initialTheme);
  const initialPal = themeDefinition(initialTheme).palette;

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
    <button class="round active" id="directionBtn" type="button" aria-label="${esc(t('export.htmlDirection'))}" title="${esc(t('export.htmlDirection'))}" aria-pressed="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19 19 5M10 5h9v9"/></svg>
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
      <label class="speed-control"><span class="sr-only">${esc(t('export.htmlSpeed'))}</span><select id="speedSel" aria-label="${esc(t('export.htmlSpeed'))}"><option value="1">1×</option><option value="2">2×</option><option value="5">5×</option></select></label>
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
      <div class="sec">${esc(t('export.htmlProfile'))}</div>
      ${profileHtml}
      <div class="sec">${esc(t('export.htmlGaps'))} ${gaps.length ? `<span class="count">${gaps.length}</span>` : ''}</div>
      ${gapsHtml}
      <div class="sec">${esc(t('export.htmlTimeline'))} ${nodes.length ? `<span class="count">${nodes.length}</span>` : ''}</div>
      ${nodeHtml}
      ${brandFoot}
      <div class="fine">${esc(privacyText)}${privacyIcons ? ` · ${esc(privacyIcons)}` : ''} · ${esc(t('export.htmlMadeBy'))}${photos ? ` · ${photos} ${esc(t('wp.photos'))}` : ''}<br><span id="attrib">© OpenStreetMap contributors</span></div>
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
