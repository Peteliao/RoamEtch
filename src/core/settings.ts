// App settings persisted in localStorage. Language / units / region are fully decoupled.
import { emit } from './events';
import { isThemeMode } from './themeRegistry';
import { browserUILanguage, isUILanguage } from './language';

const KEY = 'localtrace.settings.v1';

export const MEET_P2P_NOTICE_VERSION = 1;

export const DEFAULT_MEET_STUN = [
  'stun:stun.miwifi.com:3478',
  'stun:stun.chat.bilibili.com:3478',
  'stun:stun.cloudflare.com:3478'
];

const DEFAULTS = {
  language: 'auto',            // auto | zh | zh-TW | en | ja | ko | es (UI language, independent of region)
  regionMode: 'auto',          // auto | cn | global  (manual override wins)
  units: 'metric',             // metric | imperial
  theme: 'dark',               // auto or any stable id in themeRegistry
  activity: 'auto',            // auto | hike | drive | bike | run | travel
  speedDisplay: 'auto',        // auto | speed | pace
  recordQuality: 'balanced',   // high | balanced | low
  wakeLock: true,
  oledBrightness: 70,          // foreground brightness in pocket lock (35–100)
  rewalkVoice: true,           // voice guidance during re-walk
  ascentThreshold: 4,          // metres hysteresis
  weightKg: 65,                // used for calorie estimates
  accuracyLimit: 50,           // metres, worse fixes flagged invalid
  privacyRadius: 300,          // metres, start/end privacy circle
  tiandituKey: '',             // BYOK
  maptilerKey: '',             // BYOK (P1 reserved)
  customTileUrl: '',           // advanced: {z}/{x}/{y} template, WGS84 assumed
  customTileName: '',
  elevationEndpoint: '',       // advanced override, must accept ?latitude=&longitude=
  meetName: '',                // default display name in live meetups
  meetExpiryMin: 120,          // self-destruct timer; host advertises it to the room
  meetInviteExpiryMin: 1440,   // signed invite-link lifetime, independent of the session
  meetMarkerTtlMin: 30,        // default temporary-marker lifetime
  meetAlertEnabled: true,
  meetAlertDistance: 500,      // metres from a teammate or the assembly goal
  meetAlertCooldownMin: 5,
  meetAlertGoal: true,
  meetRelayMode: 'mqtt',       // mqtt | ws (webrtc reserved)
  meetMqttUrl: '',             // blank = auto-select public WSS nodes
  meetMqttPrefix: 'roametch/v2/meet',
  meetWsUrl: '',               // must contain {room}
  meetP2PEnabled: false,
  meetP2PNoticeVersion: 0,
  migrateMeetP2P: 1,
  meetStun: DEFAULT_MEET_STUN.join('\n'),
  meetTurnUrl: '',
  meetTurnUser: '',
  meetTurnPass: '',
  syncDeviceName: '',           // shown on paired devices; blank uses a generated label
  syncRelayMode: 'mqtt',        // mqtt | ws, independent from live team settings
  syncMqttUrl: '',              // blank = race the built-in public WSS nodes
  syncMqttPrefix: 'roametch/v2/sync',
  syncWsUrl: '',                // must contain {room}
  syncStun: DEFAULT_MEET_STUN.join('\n'),
  syncTurnUrl: '',
  syncTurnUser: '',
  syncTurnPass: '',
  sim: {                       // debug simulation switches [v1.4]
    enabled: false,
    network: 'off',            // off | cn | global | offline | corsfail
    playbackSpeed: 20
  },
  panelCollapsed: false,
  lastTripId: null,
  lastBackupAt: 0,
  videoMusic: 'random'        // random | dawn | ridge | star | breeze
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
    // meetup v2 uses a new default topic namespace; keep custom prefixes intact
    if (parsed && parsed.migrateMeetV2 !== 1) {
      if (parsed.meetMqttPrefix === 'trackmint/v1/meet') parsed.meetMqttPrefix = 'roametch/v2/meet';
      parsed.migrateMeetV2 = 1;
      localStorage.setItem(KEY, JSON.stringify(parsed));
    }
    // blank MQTT URL now means race all built-in public WSS nodes
    if (parsed && parsed.migrateMeetMulti !== 1) {
      if (!parsed.meetMqttUrl || parsed.meetMqttUrl === 'wss://broker.emqx.io:8084/mqtt') parsed.meetMqttUrl = '';
      parsed.migrateMeetMulti = 1;
      localStorage.setItem(KEY, JSON.stringify(parsed));
    }
    if (parsed && parsed.migrateMeetP2P !== 1) {
      if (parsed.meetStun === 'stun:stun.cloudflare.com:3478') parsed.meetStun = DEFAULTS.meetStun;
      parsed.meetP2PEnabled = false;
      parsed.meetP2PNoticeVersion = 0;
      parsed.migrateMeetP2P = 1;
      localStorage.setItem(KEY, JSON.stringify(parsed));
    }
    cache = parsed
      ? { ...DEFAULTS, ...parsed, sim: { ...DEFAULTS.sim, ...(parsed.sim || {}) } }
      : { ...DEFAULTS, sim: { ...DEFAULTS.sim } };
    if (!isThemeMode(cache.theme)) cache.theme = DEFAULTS.theme;
  } catch {
    cache = { ...DEFAULTS, sim: { ...DEFAULTS.sim } };
  }
  return cache;
}

export function getSettings() { return load(); }
export function get(key) { return load()[key]; }

export function set(key, value) {
  if (key === 'theme' && !isThemeMode(value)) return;
  const s = load();
  s[key] = value;
  persist(s);
  emit('settings:changed', { key, value });
}

/** Restore every preference to its factory default; trips and photos are untouched. */
export function resetSettings() {
  const fresh = { ...DEFAULTS, sim: { ...DEFAULTS.sim } };
  persist(fresh);
  emit('settings:changed', { reset: true });
}

export function patch(obj) {
  if ('theme' in obj && !isThemeMode(obj.theme)) {
    const { theme: _invalidTheme, ...valid } = obj;
    obj = valid;
  }
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
  if (isUILanguage(l)) return l;
  return browserUILanguage(navigator.language);
}