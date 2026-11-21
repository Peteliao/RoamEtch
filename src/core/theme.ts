// Theme resolver: manual dark/light/contrast, or auto by local sunrise/sunset.
import { get } from './settings';
import { on, emit } from './events';
import { regionState } from './region';
import { listTrips, loadTripFull } from './store';
import { sunTimes } from './solar';

let timer = null;
let ref = null;
let dayKey = '';
let times = null;
let colorOverride: string | null = null;

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
  const v = get('theme');
  return v === 'auto' ? autoEffective() : v;
}

export function applyTheme() {
  const eff = effectiveTheme();
  document.documentElement.dataset.theme = eff === 'dark' ? '' : eff;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', colorOverride || (eff === 'light' || eff === 'contrast' ? '#f5f7f6' : '#101820'));
  emit('theme:applied', { effective: eff });
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
    const full = trips[0] ? await loadTripFull(trips[0].id) : null;
    const p = full?.segments?.[0]?.points?.[0];
    if (p) ref = { lat: p.lat, lon: p.lon };
  } catch { /* reference stays regional default */ }
  if (!ref) ref = regionState.effective === 'cn' ? { lat: 39.9042, lon: 116.4074 } : { lat: 48.8566, lon: 2.3522 };
  dayKey = '';
  applyTheme();
}