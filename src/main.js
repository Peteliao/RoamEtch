// TrackMint迹刻 bootstrap — pure frontend, offline-first, dual-region adaptive.
import './styles/main.css';
import { initI18n, t } from './core/i18n.js';
import { initRegion, regionState } from './core/region.js';
import * as themeCore from './core/theme.js';
import { on as busOn } from './core/events.js';
import { isolateDamaged, createTrip, addSegment, appendPoints, addWaypoint } from './core/store.js';
import * as storeCore from './core/store.js';
import * as recorderCore from './core/recorder.js';
import * as rewalkCore from './core/rewalk.js';
import * as batchCore from './core/batch.js';
import * as coordsCore from './core/coords.js';
import { parseShareFragment } from './core/shareLink.js';
import { setActiveTrip } from './ui/state.js';
import { createShell } from './ui/shell.js';
import { toast } from './ui/helpers.js';
import { diag } from './core/diag.js';

async function boot() {
  const bootSub = document.getElementById('boot-sub');
  await initI18n();
  bootSub && (bootSub.textContent = t('boot.region'));
  initRegion();

  // theme (manual or auto by sunrise/sunset)
  await themeCore.initTheme();

  // integrity: isolate damaged rows before UI loads
  try {
    const removed = await isolateDamaged();
    if (removed) { diag('store', 'damaged rows isolated', { removed }); }
  } catch (e) { console.warn('integrity check failed', e); }

  const shell = createShell(document.getElementById('app'));
  document.getElementById('boot-splash')?.remove();
  diag('boot', 'app ready', { lang: navigator.language });
  // debug handle for diagnostics & acceptance testing (spec: debuggability)
  window.__lt = { recorder: recorderCore, store: storeCore, coords: coordsCore, region: regionState, shell, theme: themeCore, rewalk: rewalkCore, batch: batchCore };

  // shared-link import (#t=…) — fragment never reaches a server
  const shared = parseShareFragment(location.hash);
  if (shared) {
    try {
      const trip = await createTrip({ name: shared.name, activity: shared.activity, status: 'finished' });
      const seg = await addSegment(trip.id);
      await appendPoints(seg.id, trip.id, shared.points.map((p) => ({ ...p, t: null, alt: null, altSrc: null, acc: null, speed: null })));
      for (const w of shared.waypoints) await addWaypoint({ ...w, tripId: trip.id, desc: '', time: null, hidden: false, mediaIds: [] });
      history.replaceState(null, '', location.pathname + location.search);
      await setActiveTrip(trip.id);
      shell.navigate('analysis');
      toast(t('trips.importOk', { name: shared.name }), 'ok');
    } catch (e) { console.warn('share import failed', e); }
  }

  // network state toasts
  busOn('network:offline', () => toast(t('toast.offlineMode'), 'warn', 4000));
  busOn('network:online', () => toast(t('toast.backOnline'), 'ok', 2500));

  // PWA service worker (app shell precache; tiles cached per provider bucket)
  try {
    const { registerSW } = await import('virtual:pwa-register');
    registerSW({ immediate: true });
  } catch { /* dev mode without SW */ }
}

boot().catch((e) => {
  console.error('boot failed', e);
  const sub = document.getElementById('boot-sub');
  if (sub) sub.textContent = 'Boot failed: ' + (e?.message || e);
});