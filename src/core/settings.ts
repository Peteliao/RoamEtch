// App settings persisted in localStorage. Language / units / region are fully decoupled.
import { emit } from './events';

const KEY = 'localtrace.settings.v1';

const DEFAULTS = {
  language: 'auto',            // auto | zh | en   (UI language, independent of region)
  regionMode: 'auto',          // auto | cn | global  (manual override wins)
  units: 'metric',             // metric | imperial
  theme: 'dark',               // dark | light | contrast
  activity: 'auto',            // auto | hike | drive | bike | run | travel
  speedDisplay: 'auto',        // auto | speed | pace
  recordQuality: 'balanced',   // high | balanced | low
  wakeLock: true,
  ascentThreshold: 4,          // metres hysteresis
  weightKg: 65,                // used for calorie estimates
  accuracyLimit: 50,           // metres, worse fixes flagged invalid
  privacyRadius: 300,          // metres, start/end privacy circle
  tiandituKey: '',             // BYOK
  maptilerKey: '',             // BYOK (P1 reserved)
  customTileUrl: '',           // advanced: {z}/{x}/{y} template, WGS84 assumed
  customTileName: '',
  elevationEndpoint: '',       // advanced override, must accept ?latitude=&longitude=
  sim: {                       // debug simulation switches [v1.4]
    enabled: false,
    network: 'off',            // off | cn | global | offline | corsfail
    playbackSpeed: 20
  },
  panelCollapsed: false,
  lastTripId: null
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    // one-time: old installs defaulted to 'hike' before auto-detect existed
    if (parsed && parsed.migrateActivity !== 1) {
      if (parsed.activity === 'hike') parsed.activity = 'auto';
      parsed.migrateActivity = 1;
      localStorage.setItem(KEY, JSON.stringify(parsed));
    }
    cache = parsed
      ? { ...DEFAULTS, ...parsed, sim: { ...DEFAULTS.sim, ...(parsed.sim || {}) } }
      : { ...DEFAULTS, sim: { ...DEFAULTS.sim } };
  } catch {
    cache = { ...DEFAULTS, sim: { ...DEFAULTS.sim } };
  }
  return cache;
}

export function getSettings() { return load(); }
export function get(key) { return load()[key]; }

export function set(key, value) {
  const s = load();
  s[key] = value;
  persist(s);
  emit('settings:changed', { key, value });
}

export function patch(obj) {
  const s = load();
  Object.assign(s, obj);
  persist(s);
  emit('settings:changed', { keys: Object.keys(obj) });
}

function persist(s) {
  cache = s;
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { console.warn('settings persist failed', e); }
}

export function resolvedLanguage() {
  const l = get('language');
  if (l === 'zh' || l === 'en') return l;
  const nav = (navigator.language || 'en').toLowerCase();
  return nav.startsWith('zh') ? 'zh' : 'en';
}