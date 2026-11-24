// Shared UI state: active trip selection + debounced worker recalculation.
import { loadTripFull, updateTrip } from '../core/store';
import { computeStatsAsync } from '../core/workerBridge';
import { get, set } from '../core/settings';
import { emit } from '../core/events';
import { backfillTripAltitudes } from '../core/elevation';

export const appState = {
  view: 'record',
  activeTripId: null,
  activeTripFull: null,
  editMode: false,
  showTripInRecord: false,
  stats: null
};

let recalcTimer = null;
let activeTripRequest = 0;
let statsRequest = 0;

export async function setActiveTrip(id, { fit = false } = {}) {
  const request = ++activeTripRequest;
  statsRequest++;
  appState.activeTripId = id;
  set('lastTripId', id);
  if (!id) {
    appState.activeTripFull = null;
    appState.stats = null;
    emit('trip:active', null);
    return null;
  }
  const full = await loadTripFull(id);
  if (request !== activeTripRequest || appState.activeTripId !== id) return null;
  appState.activeTripFull = full;
  emit('trip:active', full);
  await recalcNow();
  return full;
}

export async function refreshActiveTrip(id = appState.activeTripId) {
  if (!id) return null;
  // Recording edits can refresh their own trip without changing the selected trip.
  if (id !== appState.activeTripId) return loadTripFull(id);
  const request = ++activeTripRequest;
  statsRequest++;
  const full = await loadTripFull(id);
  if (request !== activeTripRequest || appState.activeTripId !== id) return null;
  appState.activeTripFull = full;
  emit('trip:active', full);
  scheduleRecalc();
  return full;
}

export function scheduleRecalc() {
  if (recalcTimer) clearTimeout(recalcTimer);
  recalcTimer = setTimeout(recalcNow, 350);
}

export async function recalcNow() {
  const request = ++statsRequest;
  const full = appState.activeTripFull;
  if (!full) return null;
  const id = full.trip.id;
  emit('stats:busy');
  const stats = await computeStatsAsync(
    full.segments.map((s) => ({ id: s.id, points: s.points })),
    { ascentThreshold: get('ascentThreshold'), activity: full.trip.activity, weightKg: get('weightKg') }
  );
  if (request !== statsRequest || appState.activeTripId !== id || appState.activeTripFull?.trip.id !== id) return null;
  const reportedDistance = full.trip.reportedDistance != null ? Number(full.trip.reportedDistance) : null;
  const resolvedStats = reportedDistance != null && isFinite(reportedDistance) && reportedDistance >= 0
    ? { ...stats, distance: reportedDistance }
    : stats;
  await updateTrip(id, { statsCache: { ...resolvedStats, series: undefined, segments: resolvedStats.segments } });
  if (request !== statsRequest || appState.activeTripId !== id || appState.activeTripFull?.trip.id !== id) return null;
  appState.stats = resolvedStats;
  emit('trip:stats', resolvedStats);
  return resolvedStats;
}

/** After edits that null-out altitudes, refill from service when online. */
export function scheduleAltBackfill() {
  const id = appState.activeTripId;
  if (!id) return;
  setTimeout(async () => {
    const filled = await backfillTripAltitudes(id);
    if (filled) {
      await refreshActiveTrip();
      emit('toast', { type: 'ok', msg: `${filled} pts altitude filled` });
    }
  }, 800);
}