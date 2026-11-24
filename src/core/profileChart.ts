export type ProfileUnits = 'metric' | 'imperial';

export function distanceInUnit(metres: number, units: ProfileUnits) {
  return units === 'imperial' ? metres / 1609.344 : metres / 1000;
}

export function altitudeInUnit(metres: number, units: ProfileUnits) {
  return units === 'imperial' ? metres * 3.28084 : metres;
}

export function speedInUnit(metresPerSecond: number, units: ProfileUnits) {
  return units === 'imperial' ? metresPerSecond * 2.23694 : metresPerSecond * 3.6;
}

export function distanceUnit(units: ProfileUnits) {
  return units === 'imperial' ? 'mi' : 'km';
}

export function altitudeUnit(units: ProfileUnits) {
  return units === 'imperial' ? 'ft' : 'm';
}

export function speedUnit(units: ProfileUnits) {
  return units === 'imperial' ? 'mph' : 'km/h';
}

function numericRange(values: any[], zeroBased = false) {
  const valid = values.filter((v) => v != null && Number.isFinite(v));
  if (!valid.length) return null;
  let min = zeroBased ? 0 : Math.min(...valid);
  let max = Math.max(...valid);
  if (max <= min) {
    const pad = Math.max(1, Math.abs(max) * 0.08);
    min -= pad;
    max += pad;
  } else {
    const pad = (max - min) * 0.08;
    if (!zeroBased) min -= pad;
    max += pad;
  }
  return { min, max };
}

export function buildProfile(stats: any, units: ProfileUnits = 'metric', maxPoints = 1800) {
  const series = stats?.series || {};
  const n = series.d?.length || 0;
  const sourceIndices: number[] = [];
  const step = Math.max(1, Math.ceil((n - 1) / Math.max(1, maxPoints - 1)));
  for (let i = 0; i < n; i += step) sourceIndices.push(i);
  if (n > 0 && sourceIndices.at(-1) !== n - 1) sourceIndices.push(n - 1);
  const x = sourceIndices.map((i) => distanceInUnit(Number(series.d[i]) || 0, units));
  const alt = sourceIndices.map((i) => series.alt?.[i] == null ? null : altitudeInUnit(Number(series.alt[i]), units));
  const speed = sourceIndices.map((i) => series.speed?.[i] == null ? null : speedInUnit(Number(series.speed[i]), units));
  return {
    x, alt, speed, sourceIndices, units,
    hasAlt: alt.some((v) => v != null),
    hasSpeed: speed.some((v) => v != null),
    altRange: numericRange(alt),
    speedRange: numericRange(speed, true),
    maxX: Math.max(1e-6, x.at(-1) || 0)
  };
}

function pathSeries(ctx, values, px, py, draw) {
  let open = false;
  ctx.beginPath();
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) {
      if (open) { draw(); open = false; }
      return;
    }
    if (!open) { ctx.moveTo(px(i), py(v)); open = true; }
    else ctx.lineTo(px(i), py(v));
  });
  if (open) draw();
}

function fillSeries(ctx, values, px, py, baseline) {
  let run = [];
  const flush = () => {
    if (run.length < 2) { run = []; return; }
    ctx.beginPath();
    run.forEach((i, j) => j ? ctx.lineTo(px(i), py(values[i])) : ctx.moveTo(px(i), py(values[i])));
    ctx.lineTo(px(run[run.length - 1]), baseline);
    ctx.lineTo(px(run[0]), baseline);
    ctx.closePath();
    ctx.fill();
    run = [];
  };
  values.forEach((v, i) => Number.isFinite(v) ? run.push(i) : flush());
  flush();
}

function nearestValue(profile, values, x) {
  if (!values.length) return null;
  let lo = 0, hi = values.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (profile.x[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(profile.x[lo - 1] - x) < Math.abs(profile.x[lo] - x)) lo--;
  return values[lo];
}

export function drawProfileChart(ctx, profile, box, palette, options: any = {}) {
  const { x, y, w, h } = box;
  if (!profile || w <= 0 || h <= 0 || (!profile.hasAlt && !profile.hasSpeed)) return null;
  const font = Math.max(12, Math.min(22, Math.round(h / 10)));
  const top = font * 2.15;
  const left = profile.hasAlt ? font * 4.1 : 16;
  const right = profile.hasSpeed ? font * 4.4 : 16;
  const bottom = font * 1.65;
  const pw = Math.max(1, w - left - right);
  const ph = Math.max(1, h - top - bottom);
  const px = (i) => x + left + (profile.x[i] / profile.maxX) * pw;
  const valueX = (v) => x + left + (Math.max(0, Math.min(profile.maxX, v)) / profile.maxX) * pw;
  const altY = profile.altRange
    ? (v) => y + top + ph - ((v - profile.altRange.min) / (profile.altRange.max - profile.altRange.min)) * ph
    : null;
  const speedY = profile.speedRange
    ? (v) => y + top + ph - ((v - profile.speedRange.min) / (profile.speedRange.max - profile.speedRange.min)) * ph
    : null;
  const speedColor = `rgb(${palette.lut[1].join(',')})`;
  const labelFont = `${font}px system-ui, sans-serif`;

  ctx.save();
  ctx.font = labelFont;
  ctx.lineWidth = 1;
  ctx.strokeStyle = palette.grid;
  ctx.fillStyle = palette.muted;
  for (let i = 0; i <= 2; i++) {
    const gy = y + top + (ph * i) / 2;
    ctx.beginPath(); ctx.moveTo(x + left, gy); ctx.lineTo(x + left + pw, gy); ctx.stroke();
  }
  ctx.textAlign = 'left';
  let legendX = x + left;
  if (profile.hasAlt) {
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(legendX, y + font); ctx.lineTo(legendX + font * 1.4, y + font); ctx.stroke();
    ctx.fillStyle = palette.muted;
    ctx.fillText(`${options.altitudeLabel || 'Altitude'} · ${altitudeUnit(profile.units)}`, legendX + font * 1.8, y + font * 1.35);
    legendX += font * 8.5;
  }
  if (profile.hasSpeed) {
    ctx.strokeStyle = speedColor;
    ctx.beginPath(); ctx.moveTo(legendX, y + font); ctx.lineTo(legendX + font * 1.4, y + font); ctx.stroke();
    ctx.fillStyle = palette.muted;
    ctx.fillText(`${options.speedLabel || 'Speed'} · ${speedUnit(profile.units)}`, legendX + font * 1.8, y + font * 1.35);
  }

  if (profile.hasAlt && altY) {
    ctx.fillStyle = palette.accentSoft;
    fillSeries(ctx, profile.alt, px, altY, y + top + ph);
    pathSeries(ctx, profile.alt, px, altY, () => { ctx.strokeStyle = palette.accentLine; ctx.lineWidth = 2; ctx.stroke(); });
  }
  if (profile.hasSpeed && speedY) {
    pathSeries(ctx, profile.speed, px, speedY, () => { ctx.strokeStyle = speedColor; ctx.globalAlpha = 0.82; ctx.lineWidth = 2; ctx.stroke(); });
    ctx.globalAlpha = 1;
  }

  const cursorD = options.cursorD != null ? Math.max(0, Math.min(profile.maxX, options.cursorD)) : null;
  if (cursorD != null) {
    ctx.save();
    ctx.beginPath(); ctx.rect(x + left, y + top, Math.max(0, valueX(cursorD) - x - left), ph); ctx.clip();
    if (profile.hasAlt && altY) {
      pathSeries(ctx, profile.alt, px, altY, () => { ctx.strokeStyle = palette.accent; ctx.lineWidth = 2.6; ctx.stroke(); });
    }
    if (profile.hasSpeed && speedY) {
      pathSeries(ctx, profile.speed, px, speedY, () => { ctx.strokeStyle = speedColor; ctx.lineWidth = 2.6; ctx.stroke(); });
    }
    ctx.restore();
    ctx.strokeStyle = palette.amber;
    ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.moveTo(valueX(cursorD), y + top); ctx.lineTo(valueX(cursorD), y + top + ph); ctx.stroke();
    const currentAlt = options.cursorAlt ?? nearestValue(profile, profile.alt, cursorD);
    const currentSpeed = options.cursorSpeed ?? nearestValue(profile, profile.speed, cursorD);
    ctx.fillStyle = palette.amber;
    if (currentAlt != null && altY) { ctx.beginPath(); ctx.arc(valueX(cursorD), altY(currentAlt), 4.5, 0, Math.PI * 2); ctx.fill(); }
    if (currentSpeed != null && speedY) { ctx.beginPath(); ctx.arc(valueX(cursorD), speedY(currentSpeed), 4.5, 0, Math.PI * 2); ctx.fill(); }
  }

  ctx.font = labelFont;
  ctx.fillStyle = palette.muted;
  ctx.textAlign = 'right';
  if (profile.hasAlt && profile.altRange) {
    ctx.fillText(String(Math.round(profile.altRange.max)), x + left - 8, y + top + font * 0.35);
    ctx.fillText(String(Math.round(profile.altRange.min)), x + left - 8, y + top + ph);
  }
  ctx.textAlign = 'left';
  if (profile.hasSpeed && profile.speedRange) {
    ctx.fillText(String(Math.round(profile.speedRange.max)), x + left + pw + 8, y + top + font * 0.35);
    ctx.fillText(String(Math.round(profile.speedRange.min)), x + left + pw + 8, y + top + ph);
  }
  ctx.textAlign = 'left';
  ctx.fillText('0', x + left, y + h - 4);
  ctx.textAlign = 'center';
  ctx.fillText((profile.maxX / 2).toFixed(profile.maxX < 10 ? 1 : 0), x + left + pw / 2, y + h - 4);
  ctx.textAlign = 'right';
  ctx.fillText(`${profile.maxX.toFixed(profile.maxX < 10 ? 1 : 0)} ${distanceUnit(profile.units)}`, x + left + pw, y + h - 4);
  ctx.restore();
  return { left, top, width: pw, height: ph };
}
