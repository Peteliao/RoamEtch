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

export async function setActiveTrip(id, { fit = false } = {}) {
  appState.activeTripId = id;
  set('lastTripId', id);
  if (!id) {
    appState.activeTripFull = null;
    appState.stats = null;
    emit('trip:active', null);
    return null;
  }
  const full = await loadTripFull(id);
  appState.activeTripFull = full;
  emit('trip:active', full);
  await recalcNow();
  return full;
}

export async function refreshActiveTrip() {
  if (!appState.activeTripId) return;
  const full = await loadTripFull(appState.activeTripId);
  appState.activeTripFull = full;
  emit('trip:active', full);
  scheduleRecalc();
}

export function scheduleRecalc() {
  if (recalcTimer) clearTimeout(recalcTimer);
  recalcTimer = setTimeout(recalcNow, 350);
}

export async function recalcNow() {
  const full = appState.activeTripFull;
  if (!full) return null;
  emit('stats:busy');
  const stats = await computeStatsAsync(
    full.segments.map((s) => ({ id: s.id, points: s.points })),
    { ascentThreshold: get('ascentThreshold'), activity: full.trip.activity, weightKg: get('weightKg') }
  );
  appState.stats = stats;
  await updateTrip(full.trip.id, { statsCache: { ...stats, series: undefined, segments: stats.segments } });
  emit('trip:stats', stats);
  return stats;
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