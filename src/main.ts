// TrackMint迹刻 bootstrap — pure frontend, offline-first, dual-region adaptive.
import './styles/main.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import { initI18n, t } from './core/i18n';
import { initRegion, regionState } from './core/region';
import * as themeCore from './core/theme';
import { on as busOn } from './core/events';
import { isolateDamaged, createTrip, addSegment, appendPoints, addWaypoint } from './core/store';
import * as storeCore from './core/store';
import * as recorderCore from './core/recorder';
import * as rewalkCore from './core/rewalk';
import * as batchCore from './core/batch';
import * as backupCore from './core/backup';
import * as coordsCore from './core/coords';
import * as keepaliveCore from './core/keepalive';
import { parseShareFragment } from './core/shareLink';
import { parseMeetFragment } from './core/meetLink';
import { importDemoTrip } from './core/demo';
import * as meetCore from './core/meet';
import * as meetLinkCore from './core/meetLink';
import { setActiveTrip } from './ui/state';
import { createShell } from './ui/shell';
import { initInstall } from './ui/install';
import { initUpdates, showUpdateNotice } from './ui/updates';
import { toast } from './ui/helpers';
import { diag } from './core/diag';

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

  // fixes spilled synchronously on pagehide that never reached IndexedDB
  try {
    const recovered = await recorderCore.recoverPendingSpill();
    if (recovered) diag('recorder', 'pending points recovered', { count: recovered });
  } catch (e) { console.warn('pending spill recovery failed', e); }

  const shell = createShell(document.getElementById('app'));
  document.getElementById('boot-splash')?.remove();
  diag('boot', 'app ready', { lang: navigator.language });
  // debug handle for diagnostics & acceptance testing (spec: debuggability)
  window.__lt = { recorder: recorderCore, store: storeCore, coords: coordsCore, region: regionState, shell, theme: themeCore, rewalk: rewalkCore, batch: batchCore, backup: backupCore, keepalive: keepaliveCore, meet: meetCore.meet, meetCore, meetLink: meetLinkCore, updates: { show: showUpdateNotice } };

  // live meetup invite (#meet=…) — code and key stay in the fragment
  const hasMeetFragment = /[#&]meet=/.test(location.hash);
  const meetCode = parseMeetFragment(location.hash);
  const shared = hasMeetFragment ? null : parseShareFragment(location.hash);
  if (hasMeetFragment && !meetCode) {
    history.replaceState(null, '', location.pathname + location.search);
    shell.navigate('meet');
    toast(t('meet.autoJoinFail'), 'err', 4200);
  } else if (meetCode) {
    shell.navigate('meet');
    try {
      await meetCore.joinMeetSession(meetCode);
      toast(t('meet.autoJoined'), 'ok', 3500);
    } catch (e) {
      console.warn('meet auto-join failed', e);
      history.replaceState(null, '', location.pathname + location.search);
      toast(t('meet.autoJoinFail'), 'err', 4200);
    }
  } else if (shared) {
    // shared-link import (#t=…) — fragment never reaches a server
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

  // Desktop entry points: ?demo=1 opens the built-in trip, ?sim=1 replays it as live GPS.
  if (!hasMeetFragment && !shared) {
    const entry = new URLSearchParams(location.search);
    if (entry.get('demo') === '1') {
      try {
        const trip = await importDemoTrip();
        await setActiveTrip(trip.id);
        shell.navigate('analysis');
        toast(t('demo.loaded'), 'ok');
      } catch (e) { console.warn('demo load failed', e); }
    } else if (entry.get('sim') === '1') {
      try {
        const { startPlayback } = await import('./core/simulator');
        shell.navigate('record');
        await startPlayback({});
      } catch (e) { console.warn('sim playback failed', e); }
    }
  }

  // network state toasts
  busOn('network:offline', () => toast(t('toast.offlineMode'), 'warn', 4000));
  busOn('network:online', () => toast(t('toast.backOnline'), 'ok', 2500));

  initInstall({ nudge: !hasMeetFragment && !shared });

  // Service worker: prompt before reloading so an active recording is never interrupted.
  initUpdates();
}

boot().catch((e) => {
  console.error('boot failed', e);
  const sub = document.getElementById('boot-sub');
  if (sub) sub.textContent = 'Boot failed: ' + (e?.message || e);
});