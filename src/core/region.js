// RegionDetector [v1.4]: decides CN vs Global *service routing* only.
// Priority: manual override > session probe result > sync initial guess.
// Coordinate offset decisions are NOT made here (see coords.js + basemap coordSystem).
import { get, set } from './settings.js';
import { emit } from './events.js';
import { t } from './i18n.js';

const CN_TIMEZONES = new Set([
  'Asia/Shanghai', 'Asia/Urumqi', 'Asia/Chongqing', 'Asia/Harbin', 'Asia/Kashgar', 'Asia/Choibalsan'
]);
const PROBE_TIMEOUT = 1800;
const SESSION_KEY = 'localtrace.probe.v1';

const CN_PROBE = 'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=1&y=1&z=2';
const GLOBAL_PROBE = 'https://tile.openstreetmap.org/2/1/1.png';

export const regionState = {
  effective: 'global',       // cn | global
  source: 'sync',            // sync | probe | manual | sim
  syncGuess: 'global',
  probe: { cn: 'pending', global: 'pending' },  // pending | ok | fail
  probing: false,
  simulated: null            // cn | global | offline | corsfail | null
};

export function syncDetect() {
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* offline-safe */ }
  const lang = (navigator.language || '').toLowerCase();
  let guess;
  if (CN_TIMEZONES.has(tz)) guess = 'cn';
  else if (!tz && lang.startsWith('zh')) guess = 'cn';
  else guess = 'global';
  regionState.syncGuess = guess;
  return guess;
}

function applyEffective(effective, source) {
  const changed = regionState.effective !== effective || regionState.source !== source;
  regionState.effective = effective;
  regionState.source = source;
  if (changed) emit('region:changed', { ...regionState });
}

export function resolveRegion() {
  const sim = get('sim');
  if (sim?.enabled && sim.network !== 'off') {
    regionState.simulated = sim.network;
    const eff = sim.network === 'offline' || sim.network === 'corsfail' ? regionState.syncGuess : sim.network;
    applyEffective(eff, 'sim');
    return regionState;
  }
  regionState.simulated = null;
  const mode = get('regionMode');
  if (mode === 'cn' || mode === 'global') {
    applyEffective(mode, 'manual');
    return regionState;
  }
  // auto: session probe result beats sync guess
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { /* ignore */ }
  if (session && (session.cn === 'ok' || session.global === 'ok')) {
    regionState.probe = session;
    if (session.cn === 'ok' && session.global !== 'ok') applyEffective('cn', 'probe');
    else if (session.global === 'ok' && session.cn !== 'ok') applyEffective('global', 'probe');
    else applyEffective(regionState.syncGuess, 'probe');
  } else {
    applyEffective(regionState.syncGuess, 'sync');
  }
  return regionState;
}

async function probeOne(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT);
  const t0 = performance.now();
  try {
    // no-cors: opaque response still proves reachability; never blocks on CORS.
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
    return { ok: true, ms: Math.round(performance.now() - t0) };
  } catch {
    return { ok: false, ms: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
  }
}

/** Async race probe. Only auto-switches when current fails AND alternative succeeds. */
export async function runProbe({ silent = false } = {}) {
  const sim = get('sim');
  if (sim?.enabled && sim.network !== 'off') {
    regionState.probe = {
      cn: sim.network === 'cn' ? 'ok' : 'fail',
      global: sim.network === 'global' ? 'ok' : 'fail'
    };
    resolveRegion();
    return regionState;
  }
  regionState.simulated = null;
  if (!navigator.onLine) {
    regionState.probe = { cn: 'fail', global: 'fail' };
    resolveRegion();
    return regionState;
  }
  regionState.probing = true;
  emit('region:probing', { ...regionState });
  const [cn, global] = await Promise.all([probeOne(CN_PROBE), probeOne(GLOBAL_PROBE)]);
  regionState.probe = { cn: cn.ok ? 'ok' : 'fail', global: global.ok ? 'ok' : 'fail', cnMs: cn.ms, globalMs: global.ms };
  regionState.probing = false;
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ cn: regionState.probe.cn, global: regionState.probe.global })); } catch { /* ignore */ }

  const mode = get('regionMode');
  if (mode === 'auto') {
    const cur = regionState.effective;
    const curOk = regionState.probe[cur] === 'ok';
    const alt = cur === 'cn' ? 'global' : 'cn';
    const altOk = regionState.probe[alt] === 'ok';
    if (!curOk && altOk) {
      applyEffective(alt, 'probe');
      if (!silent) emit('toast', { type: 'ok', msg: t('region.switched', { profile: alt === 'cn' ? t('region.cn') : t('region.global') }) });
    } else if (curOk) {
      applyEffective(cur, 'probe');
    } else {
      // both failed: keep sync guess, never flap
      applyEffective(regionState.syncGuess, 'sync');
    }
  } else {
    resolveRegion();
  }
  emit('region:probed', { ...regionState });
  return regionState;
}

export function setRegionMode(mode) {
  set('regionMode', mode);
  resolveRegion();
}

export function isOfflineSim() {
  return regionState.simulated === 'offline' || (!navigator.onLine && !regionState.simulated);
}
export function isCorsFailSim() { return regionState.simulated === 'corsfail'; }

export function regionLabel() {
  const s = regionState;
  if (s.simulated) return t('region.simActive', { mode: s.simulated });
  if (s.source === 'manual') return s.effective === 'cn' ? t('region.manualCn') : t('region.manualGlobal');
  return s.effective === 'cn' ? t('region.autoCn') : t('region.autoGlobal');
}

export function initRegion() {
  syncDetect();
  resolveRegion();
  window.addEventListener('online', () => { runProbe(); emit('network:online'); });
  window.addEventListener('offline', () => { resolveRegion(); emit('network:offline'); });
  // probe shortly after boot, never blocking first paint
  setTimeout(() => runProbe(), 400);
}