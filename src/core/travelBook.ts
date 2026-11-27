// Self-contained travel book / multi-day archive. Privacy cropping is applied
// before day grouping, so hidden nodes, photos and route portions never reach
// the exported file. Weather is disclosed separately from offline sun times.
import { t, currentLang } from './i18n';
import { get } from './settings';
import { applyPrivacy } from './privacy';
import { fmtDistance, fmtDuration, fmtAltitude } from './geo';
import { buildStoryDays, normalizeStory, storyTitle, storySummary } from './story';
import type { Story, StoryDay } from './story';
import { mergeManualWeather, weatherCodeKey, weatherIcon } from './weather';
import type { WeatherSummary } from './weather';

export type BookWeather = {
  summary: WeatherSummary;
  cached: boolean;
  fetchedAt?: number;
  model?: 'forecast' | 'archive';
};

export type TravelBookOptions = {
  story?: Story;
  weather?: Record<string, BookWeather>;
  privacy?: { radius?: number; hideSensitive?: boolean; hideStartIcon?: boolean; hideEndIcon?: boolean; start?: any; end?: any };
  includePhotos?: boolean;
};

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function blobDataUrl(blob): Promise<string> {
  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => resolve('');
      reader.readAsDataURL(blob);
    } catch {
      resolve('');
    }
  });
}

function routeSvg(segments, { showStart = true, showEnd = true } = {}) {
  const pts = [];
  for (const segment of segments) {
    for (const point of segment.points || []) {
      if (Number.isFinite(point.lat) && Number.isFinite(point.lon)) pts.push(point);
    }
  }
  if (pts.length < 2) return '';
  const midLat = pts.reduce((sum, p) => sum + p.lat, 0) / pts.length;
  const cos = Math.cos(midLat * Math.PI / 180);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    const x = p.lon * cos, y = -p.lat;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const spanX = Math.max(1e-9, maxX - minX), spanY = Math.max(1e-9, maxY - minY);
  const width = 860, height = 320, pad = 26;
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;
  const project = (p) => [offsetX + (p.lon * cos - minX) * scale, offsetY + (-p.lat - minY) * scale];
  const stride = Math.max(1, Math.ceil(pts.length / 1600));
  const paths = [];
  for (const segment of segments) {
    const points = (segment.points || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (points.length < 2) continue;
    const sampled = [];
    for (let i = 0; i < points.length; i += stride) sampled.push(points[i]);
    if (sampled[sampled.length - 1] !== points[points.length - 1]) sampled.push(points[points.length - 1]);
    paths.push(sampled.map((p, i) => `${i ? 'L' : 'M'}${project(p).map((v) => v.toFixed(1)).join(' ')}`).join(' '));
  }
  const start = project(pts[0]);
  const end = project(pts[pts.length - 1]);
  return `<svg class="route" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(t('story.bookRoute'))}">
    <rect width="${width}" height="${height}" rx="18" fill="#efe6d6"/>
    <path d="${paths.join(' ')}" fill="none" stroke="#2f6f5e" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>
    ${showStart ? `<circle cx="${start[0].toFixed(1)}" cy="${start[1].toFixed(1)}" r="8" fill="#fff" stroke="#2f6f5e" stroke-width="4"/><text x="${start[0].toFixed(1)}" y="${(start[1] - 15).toFixed(1)}" text-anchor="middle" class="route-label">${esc(t('story.bookStart'))}</text>` : ''}
    ${showEnd ? `<circle cx="${end[0].toFixed(1)}" cy="${end[1].toFixed(1)}" r="8" fill="#2f6f5e"/><text x="${end[0].toFixed(1)}" y="${(end[1] - 15).toFixed(1)}" text-anchor="middle" class="route-label">${esc(t('story.bookEnd'))}</text>` : ''}
  </svg>`;
}

function fmtClock(ms, lang) {
  return new Date(ms).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' });
}

function dayStats(day: StoryDay, units) {
  const dist = fmtDistance(day.distance, units);
  const asc = fmtAltitude(day.ascent, units);
  const duration = day.duration > 0 ? fmtDuration(day.duration, { compact: true }) : '--';
  return `<div class="stats">
    <span><b>${esc(dist.v)}</b>${esc(dist.u)}</span>
    <span><b>${esc(duration)}</b>${esc(t('story.duration'))}</span>
    <span><b>↑${esc(asc.v)}</b>${esc(asc.u)}</span>
  </div>`;
}

function weatherBlock(day: StoryDay, story: Story, weather: Record<string, BookWeather> | undefined) {
  const manual = story.manualWeather[day.day];
  const record = weather?.[day.day];
  const summary = record
    ? mergeManualWeather(record.summary, manual)
    : manual
      ? mergeManualWeather({
        temp: null, code: null, rain: null, wind: null, uv: null,
        hour: 12, sample: '', missing: ['rain', 'uv']
      }, manual)
      : null;
  const manualOnly = !record && manual;
  const source = record
    ? `${esc(t('story.weatherSource'))} · ${esc(t(record.model === 'archive' ? 'story.weatherArchive' : 'story.weatherForecast'))} · ${esc(t(record.cached ? 'story.weatherCached' : 'story.weatherNetwork'))}`
    : '';
  const sample = record ? `${esc(t('story.weatherSample'))} ${esc(record.summary.sample)}` : '';
  const missing = summary?.missing?.length
    ? `<div class="weather-missing">${esc(t('story.weatherMissing', { fields: summary.missing.map((key) => t(`story.missing.${key}`)).join(' / ') }))}</div>`
    : '';
  if (!summary) {
    return `<div class="weather empty"><div class="weather-head">${esc(t('story.weather'))}</div>
      <div class="muted">${esc(t('story.weatherNone'))}</div>
      <div class="weather-source">${esc(t('story.weatherNeedNetwork'))}</div></div>`;
  }
  const condition = manual?.condition
    ? esc(manual.condition)
    : t(`story.codes.${weatherCodeKey(summary.code)}`);
  const manualNote = summary.manual
    ? `<div class="manual-tag">${esc(t('story.manualTag'))}</div>`
    : '';
  return `<div class="weather">
    <div class="weather-head">${weatherIcon(summary.code)} ${esc(condition)} ${manualNote}</div>
    <div class="weather-grid">
      ${summary.temp != null ? `<span>${Math.round(summary.temp)}°C</span>` : ''}
      ${summary.rain != null ? `<span>☔ ${Math.round(summary.rain)}%</span>` : ''}
      ${summary.wind != null ? `<span>💨 ${Math.round(summary.wind)} km/h</span>` : ''}
      ${summary.uv != null ? `<span>UV ${Math.round(summary.uv)}</span>` : ''}
    </div>
    ${missing}
    <div class="weather-source">${manualOnly ? esc(t('story.manualSupplement')) : source}</div>
    ${manualOnly ? `<div class="weather-source">${esc(t('story.weatherNeedNetwork'))}</div>` : sample ? `<div class="weather-source">${sample}</div>` : ''}
    ${manual?.note ? `<div class="weather-note">${esc(manual.note)}</div>` : ''}
  </div>`;
}

function sunBlock(day: StoryDay) {
  if (!day.sun.available) return '';
  const text = day.sun.polar === 'day'
    ? t('story.polarDay')
    : day.sun.polar === 'night' ? t('story.polarNight') : '';
  return `<div class="sun">
    <div class="sun-head">${esc(t('story.sunTitle'))}</div>
    <div class="sun-times">
      ${day.sun.sunrise ? `<span>↑ ${esc(t('story.sunrise'))} ${esc(day.sun.sunrise)}</span>` : ''}
      ${day.sun.sunset ? `<span>↓ ${esc(t('story.sunset'))} ${esc(day.sun.sunset)}</span>` : ''}
      ${text ? `<span>${esc(text)}</span>` : ''}
    </div>
    <div class="sun-note">${esc(t('story.sunOffline'))}</div>
  </div>`;
}

export async function buildTravelBook(full: any, opts: TravelBookOptions = {}) {
  const lang = currentLang();
  const units = get('units');
  const privacy = opts.privacy || {};
  const cropped = applyPrivacy(full, privacy);
  const croppedFull = { ...full, segments: cropped.segments, waypoints: cropped.waypoints };
  const story = normalizeStory(opts.story || full.trip?.story);
  const days = buildStoryDays(croppedFull, {
    ascentThreshold: get('ascentThreshold'),
    activity: full.trip?.activity,
    weightKg: get('weightKg'),
    lang
  });
  const mediaById = new Map<string, any>((full.media || []).map((m) => [m.id, m]));
  const total = storySummary(days);
  const title = storyTitle(full.trip, story) || t('record.newTripName');
  const activity = t(`record.activities.${full.trip?.activity || 'auto'}`);
  const dateRange = days.length
    ? `${new Date(`${days[0].day}T12:00:00`).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' })}${days.length > 1 ? ` — ${new Date(`${days[days.length - 1].day}T12:00:00`).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' })}` : ''}`
    : '';

  const photoCache = new Map<string, string>();
  async function photoUrl(media) {
    if (!media) return '';
    if (photoCache.has(media.id)) return photoCache.get(media.id)!;
    const url = await blobDataUrl(media.thumb || media.blob);
    photoCache.set(media.id, url);
    return url;
  }

  const daySections: string[] = [];
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const note = (story.dayNotes[day.day] || '').trim();
    const nodeHtml = day.nodes.length
      ? `<div class="nodes">${day.nodes.map((node) => `
          <div class="node">
            <div class="node-time">${node.time ? esc(fmtClock(node.time, lang)) : ''}</div>
            <div class="node-main"><b>${esc(node.name || t('story.unnamedNode'))}</b>${node.desc ? `<p>${esc(node.desc)}</p>` : ''}</div>
          </div>`).join('')}</div>`
      : '';
    const photos = opts.includePhotos ? day.photos : [];
    const photoHtml = photos.length
      ? `<div class="photos">${(await Promise.all(photos.map(async (photo) => {
          const src = await photoUrl(photo.media);
          return src ? `<figure><img src="${src}" alt="${esc(photo.nodeName || t('story.photo'))}" loading="lazy"><figcaption>${esc(photo.nodeName || t('story.photo'))}</figcaption></figure>` : '';
        }))).join('')}</div>`
      : '';
    const dayNotesMissing = !note && !day.nodes.length && !photos.length && !day.hasTrack;
    if (dayNotesMissing && !opts.weather?.[day.day]) continue;
    daySections.push(`<section class="day">
      <div class="day-head"><span class="day-index">${String(i + 1).padStart(2, '0')}</span><h2>${esc(day.label)}</h2></div>
      ${dayStats(day, units)}
      <div class="env">${weatherBlock(day, story, opts.weather)}${sunBlock(day)}</div>
      ${note ? `<div class="day-note">${esc(note).replace(/\n/g, '<br>')}</div>` : ''}
      ${nodeHtml}
      ${photoHtml}
      ${opts.includePhotos === false && day.photos.length ? `<div class="muted small">${esc(t('story.photosExcluded'))}</div>` : ''}
    </section>`);
  }

  const route = routeSvg(cropped.segments, {
    showStart: !opts.privacy?.hideStartIcon,
    showEnd: !opts.privacy?.hideEndIcon
  });
  const radius = Math.max(0, +privacy.radius || 0);
  const privacyText = radius > 0 ? t('story.bookPrivacyOn', { r: radius }) : t('story.bookPrivacyOff');
  const privacyExtras = [];
  if (cropped.croppedPoints) privacyExtras.push(t('story.bookCroppedPoints', { n: cropped.croppedPoints }));
  if (cropped.croppedWaypoints) privacyExtras.push(t('story.bookCroppedNodes', { n: cropped.croppedWaypoints }));
  if (privacy.hideStartIcon && privacy.hideEndIcon) privacyExtras.push(t('export.htmlIconsBothHidden'));
  else if (privacy.hideStartIcon) privacyExtras.push(t('export.htmlStartIconHidden'));
  else if (privacy.hideEndIcon) privacyExtras.push(t('export.htmlEndIconHidden'));
  const dist = fmtDistance(total.distance, units);
  const asc = fmtAltitude(total.ascent, units);

  return `<!doctype html><html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(t('story.bookTitle'))}</title>
<style>
:root{--ink:#2b2a26;--muted:#7b7569;--paper:#fbf7ef;--line:#e5dccb;--accent:#2f6f5e;--warm:#b9803f}
*{box-sizing:border-box}body{margin:0;background:#ede6d9;color:var(--ink);font:16px/1.65 "Songti SC","Noto Serif SC",Georgia,serif}
.book{max-width:920px;margin:28px auto;background:var(--paper);border-radius:24px;overflow:hidden;box-shadow:0 20px 60px rgba(60,45,20,.14)}
.cover{padding:56px 56px 34px;background:linear-gradient(160deg,#f7efdf,#efe2ce)}
.brand{letter-spacing:.32em;font-size:12px;color:var(--warm);text-transform:uppercase}
.cover h1{font-size:46px;line-height:1.18;margin:14px 0 10px;letter-spacing:.03em}
.cover .meta{color:var(--muted);font-size:14px}
.cover .intro{margin-top:18px;font-size:17px;max-width:680px;color:#4d493f;white-space:pre-line}
.cover-stats{display:flex;gap:26px;margin-top:26px;flex-wrap:wrap;color:var(--accent)}
.cover-stats b{display:block;font-size:26px;line-height:1.1}
.cover-stats span{font-size:12px;color:var(--muted);letter-spacing:.08em;text-transform:uppercase}
.route-wrap{padding:0 40px 10px}.route{width:100%;height:auto;display:block;border:1px solid var(--line)}
.route-label{font-size:12px;fill:#4f4a41;font-family:inherit}
.privacy{padding:8px 56px 26px;color:var(--muted);font-size:12.5px}
.toc{display:flex;gap:8px;flex-wrap:wrap;padding:0 56px 18px}.toc a{color:var(--accent);text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:4px 12px;font-size:13px}
.days{padding:0 56px 56px}
.day{border-top:1px solid var(--line);padding:34px 0 8px;break-inside:avoid-page}
.day-head{display:flex;align-items:baseline;gap:14px}.day-index{font:600 13px/1 ui-monospace,monospace;color:var(--warm);letter-spacing:.12em}
.day h2{font-size:26px;margin:0 0 12px}
.stats{display:flex;gap:24px;flex-wrap:wrap;color:var(--muted);font-size:13px;margin:6px 0 14px}
.stats b{color:var(--ink);font-size:19px;margin-right:3px}
.env{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}
.weather,.sun{border:1px solid var(--line);border-radius:14px;padding:13px 15px;background:#fffdf8}
.weather-head{font-weight:600;margin-bottom:4px}.weather-grid{display:flex;gap:14px;flex-wrap:wrap;font-size:14px}
.weather-source,.sun-note{color:var(--muted);font-size:11.5px;margin-top:5px}.weather-missing{color:var(--warm);font-size:11.5px;margin-top:4px}
.weather-note{font-size:13px;margin-top:6px;padding-top:6px;border-top:1px dashed var(--line)}
.manual-tag{font-size:10px;color:#fff;background:var(--warm);border-radius:999px;padding:1px 7px;vertical-align:2px;margin-left:4px}
.sun-head{font-weight:600;margin-bottom:4px}.sun-times{display:flex;gap:14px;flex-wrap:wrap;font-size:14px}
.day-note{margin:14px 0;padding:14px 18px;border-left:3px solid var(--warm);background:#f6efe2;white-space:normal}
.nodes{margin:16px 0}.node{display:flex;gap:16px;padding:9px 0;border-bottom:1px dashed var(--line)}
.node-time{min-width:52px;color:var(--muted);font:12px/1.6 ui-monospace,monospace}
.node-main b{font-size:15px}.node-main p{margin:2px 0 0;color:#5b564c;font-size:13.5px}
.photos{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0}
.photos figure{margin:0;background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}
.photos img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block}
.photos figcaption{font-size:11.5px;color:var(--muted);padding:6px 8px}
.muted{color:var(--muted)}.small{font-size:12px}
.foot{padding:22px 56px 38px;border-top:1px solid var(--line);color:var(--muted);font-size:12px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.empty-book{padding:0 56px 40px;color:var(--muted)}
@media(max-width:720px){.cover{padding:36px 24px 24px}.cover h1{font-size:32px}.route-wrap,.privacy,.toc,.days,.foot{padding-left:22px;padding-right:22px}.env{grid-template-columns:1fr}.photos{grid-template-columns:repeat(2,1fr)}.book{margin:0;border-radius:0}}
@media print{body{background:#fff}.book{box-shadow:none;margin:0;max-width:none}.toc{display:none}.day{break-inside:avoid-page}.cover{background:#fff}}
</style></head><body><article class="book">
<header class="cover">
  <div class="brand">RoamEtch · ${esc(t('story.bookTitle'))}</div>
  <h1>${esc(title)}</h1>
  <div class="meta">${esc(dateRange)} · ${esc(activity)}${days.length ? ` · ${esc(t('story.dayCount', { n: total.days }))}` : ''}</div>
  ${story.intro.trim() ? `<div class="intro">${esc(story.intro.trim()).replace(/\n/g, '<br>')}</div>` : ''}
  <div class="cover-stats">
    <span><b>${esc(dist.v)}</b>${esc(dist.u)} ${esc(t('story.distance'))}</span>
    <span><b>${esc(asc.v)}</b>${esc(asc.u)} ${esc(t('story.ascent'))}</span>
    <span><b>${total.nodes}</b>${esc(t('story.nodes'))}</span>
    <span><b>${total.photos}</b>${esc(t('story.photos'))}</span>
  </div>
</header>
${route ? `<div class="route-wrap">${route}</div>` : ''}
<div class="privacy">${esc(privacyText)}${privacyExtras.length ? ` · ${esc(privacyExtras.join(' · '))}` : ''}<br>${esc(t('story.bookPrivacyNote'))}</div>
${days.length > 1 ? `<nav class="toc">${days.map((day, i) => `<a href="#d${i + 1}">${esc(day.label)}</a>`).join('')}</nav>` : ''}
<div class="days">
${daySections.length ? daySections.map((html, i) => html.replace('<section class="day">', `<section class="day" id="d${i + 1}">`)).join('') : `<div class="empty-book">${esc(t('story.bookEmpty'))}</div>`}
</div>
<footer class="foot"><span>RoamEtch · ${esc(t('story.bookFooter'))}</span><span>${esc(t('story.bookNoUpload'))}</span></footer>
</article></body></html>`;
}
