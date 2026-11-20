// Deterministic trip score (0-100) + grade + one-line comment, from stats only.
// Activity baselines keep a 10 km hike and a 40 km ride comparable.
import { get } from './settings.js';
import { t } from './i18n.js';
import { fmtDistance, fmtSpeed, fmtAltitude } from './geo.js';
import { canvasPalette } from './palette.js';

const BASE = {
  hike: { dist: 12000, climb: 600, speed: 1.4 },
  drive: { dist: 150000, climb: 800, speed: 16.7 },
  bike: { dist: 40000, climb: 600, speed: 5.5 },
  run: { dist: 10000, climb: 250, speed: 2.8 },
  travel: { dist: 20000, climb: 300, speed: 6 }
};

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif';
const MONO = 'ui-monospace, "SF Mono", Consolas, monospace';

export function computeTripScore(stats, activity) {
  const b = BASE[activity] || BASE.hike;
  const units = get('units');
  const parts = {
    distance: Math.min(1, stats.distance / b.dist),
    ascent: Math.min(1, stats.ascent / b.climb),
    moving: stats.duration > 0 ? Math.min(1, stats.movingMs / stats.duration) : 0.5,
    speed: Math.min(1, stats.avgSpeed / b.speed),
    quality: (stats.hasTime ? 0.4 : 0) + (stats.maxAlt != null ? 0.3 : 0) + Math.min(0.3, (stats.pointCount / 500) * 0.3)
  };
  const score = Math.round(100 * (0.3 * parts.distance + 0.2 * parts.ascent + 0.2 * parts.moving + 0.15 * parts.speed + 0.15 * parts.quality));
  const grade = score >= 85 ? 'S' : score >= 70 ? 'A' : score >= 50 ? 'B' : 'C';
  const top = Object.entries(parts).sort((a, b2) => b2[1] - a[1])[0][0];
  const d = fmtDistance(stats.distance, units);
  const s = fmtSpeed(stats.avgSpeed, units);
  const a = fmtAltitude(stats.ascent, units);
  const highlight = top === 'distance' ? t('score.hlDistance', { v: d.v + d.u })
    : top === 'ascent' ? t('score.hlAscent', { v: a.v + a.u })
    : top === 'moving' ? t('score.hlMoving', { p: Math.round(parts.moving * 100) })
    : top === 'speed' ? t('score.hlSpeed', { v: `${s.v} ${s.u}` })
    : t('score.hlQuality');
  return { score, grade, comment: `${t('score.verdict' + grade)} ${highlight}`, parts };
}

export function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

export function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawScoreBadge(ctx, { score, grade }, x, y, P = canvasPalette()) {
  const w = 168, h = 76;
  roundRectPath(ctx, x, y, w, h, 18);
  ctx.fillStyle = P.badgeBg;
  ctx.fill();
  ctx.strokeStyle = P.badgeEdge;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.fillStyle = P.muted;
  ctx.font = `18px ${FONT}`;
  ctx.fillText(t('score.label'), x + 18, y + 26);
  ctx.fillStyle = P.accent;
  ctx.font = `800 40px ${MONO}`;
  ctx.fillText(String(score), x + 18, y + 62);
  const sw = ctx.measureText(String(score)).width;
  ctx.fillStyle = P.amber;
  ctx.font = `800 28px ${MONO}`;
  ctx.fillText(grade, x + 18 + sw + 10, y + 60);
}