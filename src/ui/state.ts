// Shared UI state: active trip selection + debounced worker recalculation.
import { cacheTripStats, loadTripFull } from '../core/store';
import { computeStatsAsync } from '../core/workerBridge';
import { get, set } from '../core/settings';
import { emit } from '../core/events';
import { backfillTripAltitudes } from '../core/elevation';
import { clearHistory } from '../core/history';

export const appState = {
  view: 'record',
  activeTripId: null,
  activeTripFull: null,
  tripSession: 0,
  editMode: false,
  showTripInRecord: false,
  tripDetail: { open: false, tripId: null, section: 'overview' },
  stats: null
};

export function isTripSectionActive(section) {
  const detail = appState.tripDetail;
  return detail.open && detail.section === section
    && (appState.view === 'trips' || appState.view === 'analysis' || appState.view === 'export');
}

let recalcTimer = null;
let activeTripRequest = 0;
let statsRequest = 0;
let statsComputeKey = '';
let altBackfillTimer = null;
let altBackfillController = null;

export async function setActiveTrip(id, { fit = false } = {}) {
  const request = ++activeTripRequest;
  statsRequest++;
  cancelAltBackfill();
  if (id !== appState.activeTripId) {
    appState.tripSession++;
    clearHistory();
    appState.activeTripFull = null;
    appState.stats = null;
    statsComputeKey = '';
    if (appState.tripDetail.tripId && appState.tripDetail.tripId !== id) {
      appState.tripDetail = { open: false, tripId: null, section: 'overview' };
    }
  }
  appState.activeTripId = id;
  set('lastTripId', id);
  if (!id) {
    appState.activeTripFull = null;
    appState.stats = null;
    statsComputeKey = '';
    emit('trip:active', null);
    return null;
  }
  const trackSnapshot = id === appState.activeTripId ? appState.activeTripFull : null;
  const full = trackSnapshot
    ? await loadTripFull(id, { trackSnapshot })
    : await loadTripFull(id);
  if (request !== activeTripRequest || appState.activeTripId !== id) return null;
  if (fit) appState.showTripInRecord = true;
  appState.activeTripFull = full;
  emit('trip:active', full);
  await recalcNow();
  return full;
}

export async function refreshActiveTrip(id = appState.activeTripId, {
  recalc = true,
  session = appState.tripSession,
  view = null,
  metadataOnly = false
}: { recalc?: boolean; session?: number; view?: string | null; metadataOnly?: boolean } = {}) {
  if (!id || session !== appState.tripSession || (view && view !== appState.view)) return null;
  // Recording edits can refresh their own trip without changing the selected trip.
  if (id !== appState.activeTripId) {
    const full = await loadTripFull(id);
    if (!full || session !== appState.tripSession || (view && view !== appState.view)) return null;
    return full;
  }
  const request = ++activeTripRequest;
  statsRequest++;
  const trackSnapshot = id === appState.activeTripId ? appState.activeTripFull : null;
  const full = trackSnapshot
    ? await loadTripFull(id, { trackSnapshot, trackUnchanged: metadataOnly })
    : await loadTripFull(id);
  if (request !== activeTripRequest || appState.activeTripId !== id
    || session !== appState.tripSession || (view && view !== appState.view)) return null;
  if (appState.activeTripFull?.trip.activity !== full.trip.activity) appState.stats = null;
  appState.activeTripFull = full;
  emit('trip:active', full);
  if (recalc) scheduleRecalc();
  else if (recalcTimer) {
    clearTimeout(recalcTimer);
    recalcTimer = null;
  }
  return full;
}

export function scheduleRecalc() {
  if (recalcTimer) clearTimeout(recalcTimer);
  recalcTimer = setTimeout(recalcNow, 350);
}

export async function recalcNow() {
  if (recalcTimer) clearTimeout(recalcTimer);
  recalcTimer = null;
  const full = appState.activeTripFull;
  if (!full) return null;
  const id = full.trip.id;
  const options = {
    ascentThreshold: get('ascentThreshold'),
    activity: full.trip.activity,
    weightKg: get('weightKg')
  };
  const reportedDistance = full.trip.reportedDistance != null ? Number(full.trip.reportedDistance) : null;
  const computeKey = JSON.stringify([
    id, full.trip.updatedAt || 0, reportedDistance, options.ascentThreshold,
    options.activity, options.weightKg
  ]);
  if (computeKey === statsComputeKey && appState.stats) return appState.stats;
  const request = ++statsRequest;
  emit('stats:busy');
  const stats = await computeStatsAsync(
    full.segments.map((s) => ({ id: s.id, points: s.points })),
    options
  );
  if (request !== statsRequest || appState.activeTripId !== id || appState.activeTripFull?.trip.id !== id) return null;
  const resolvedStats = reportedDistance != null && isFinite(reportedDistance) && reportedDistance >= 0
    ? { ...stats, distance: reportedDistance }
    : stats;
  const cached = await cacheTripStats(id, full.trip.updatedAt, {
    ...resolvedStats, series: undefined, segments: resolvedStats.segments
  });
  if (!cached || request !== statsRequest || appState.activeTripId !== id || appState.activeTripFull?.trip.id !== id) return null;
  appState.stats = resolvedStats;
  statsComputeKey = computeKey;
  emit('trip:stats', resolvedStats);
  return resolvedStats;
}

export function cancelAltBackfill() {
  if (altBackfillTimer) clearTimeout(altBackfillTimer);
  altBackfillTimer = null;
  altBackfillController?.abort();
  altBackfillController = null;
}

/** After edits that null-out altitudes, refill from service when online. */
export function scheduleAltBackfill(tripId = appState.activeTripId) {
  cancelAltBackfill();
  if (!tripId) return;
  const session = appState.tripSession;
  const view = appState.view;
  const controller = new AbortController();
  altBackfillController = controller;
  altBackfillTimer = setTimeout(async () => {
    altBackfillTimer = null;
    if (controller.signal.aborted || session !== appState.tripSession
      || tripId !== appState.activeTripId || view !== appState.view) return;
    try {
      const filled = await backfillTripAltitudes(tripId, { signal: controller.signal });
      if (!filled || controller.signal.aborted || session !== appState.tripSession
        || tripId !== appState.activeTripId || view !== appState.view) return;
      await refreshActiveTrip(tripId, { session, view });
      if (!controller.signal.aborted && session === appState.tripSession
        && tripId === appState.activeTripId && view === appState.view) {
        emit('toast', { type: 'ok', msg: `${filled} pts altitude filled` });
      }
    } catch (error) {
      if (!controller.signal.aborted) console.warn('altitude backfill failed', error);
    } finally {
      if (altBackfillController === controller) altBackfillController = null;
    }
  }, 800);
}