// Theme resolver: a manual registry theme, or binary light/dark auto resolution.
import { get } from './settings';
import { appCssVars, isConcreteTheme, themeDefinition } from './themeRegistry';
import { on, emit } from './events';
import { regionState } from './region';
import { listTrips, loadFirstTrackPoint } from './store';
import { sunTimes } from './solar';

let timer = null;
let ref = null;
let dayKey = '';
let times = null;
let colorOverride: string | null = null;
let modeOverride: string | null = null;

function autoEffective() {
  const now = new Date();
  const key = now.toDateString() + '|' + (ref ? `${ref.lat},${ref.lon}` : '');
  if (key !== dayKey) {
    dayKey = key;
    times = ref ? sunTimes(now, ref.lat, ref.lon) : null;
  }
  if (!times) return 'dark';
  if (times.polar === 'day') return 'light';
  if (times.polar === 'night') return 'dark';
  return now >= times.sunrise && now < times.sunset ? 'light' : 'dark';
}

export function effectiveTheme() {
  if (modeOverride) return isConcreteTheme(modeOverride) ? modeOverride : 'dark';
  const v = get('theme');
  if (v === 'auto') return autoEffective();
  return isConcreteTheme(v) ? v : 'dark';
}

export function applyTheme() {
  const eff = effectiveTheme();
  const root = document.documentElement;
  root.dataset.theme = eff === 'dark' ? '' : eff;
  for (const [name, value] of Object.entries(appCssVars(eff))) root.style.setProperty(name, value);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', colorOverride || themeDefinition(eff).palette.vectorBg);
  emit('theme:applied', { effective: eff });
}

/** Temporarily overrides the effective theme without changing the saved setting. */
export function setThemeModeOverride(mode: string | null) {
  if (modeOverride === mode) return;
  modeOverride = mode;
  applyTheme();
}

/** Highlights the OS status bar with a fixed color until cleared (OLED black). */
export function setThemeColorOverride(color: string | null) {
  colorOverride = color;
  applyTheme();
}

export function themeInfo() {
  return { mode: get('theme'), effective: effectiveTheme(), ref, times };
}

export function setReference(lat, lon) {
  ref = { lat, lon };
  dayKey = '';
  applyTheme();
}

function manageTimer() {
  const want = get('theme') === 'auto';
  if (want && !timer) timer = setInterval(applyTheme, 60_000);
  if (!want && timer) { clearInterval(timer); timer = null; }
}

export async function initTheme() {
  applyTheme();
  manageTimer();
  on('settings:changed', (e) => {
    if (e.key === 'theme' || e.keys?.includes('theme')) { applyTheme(); manageTimer(); }
  });
  try {
    const trips = await listTrips();
    const point = trips[0] ? await loadFirstTrackPoint(trips[0].id) : null;
    if (point) ref = { lat: point.lat, lon: point.lon };
  } catch { /* reference stays regional default */ }
  if (!ref) ref = regionState.effective === 'cn' ? { lat: 39.9042, lon: 116.4074 } : { lat: 48.8566, lon: 2.3522 };
  dayKey = '';
  applyTheme();
}