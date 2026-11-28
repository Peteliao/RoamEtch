export type VideoPacing = 'fixed' | 'smart';

export type VideoNodeStop = { u: number; holdMs?: number; nodeIndex: number };

export type VideoPhase = {
  kind: 'travel' | 'node' | 'endpoint';
  startMs: number;
  endMs: number;
  fromU: number;
  toU: number;
  nodeIndex?: number;
};

export type VideoTimeline = { phases: VideoPhase[]; durationMs: number; endpointHoldMs: number };

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

function smartStops(stops: VideoNodeStop[]) {
  const sorted = stops
    .filter((stop) => Number.isFinite(stop.u))
    .map((stop) => ({ ...stop, u: clamp01(stop.u), holdMs: Math.max(2200, stop.holdMs || 3000) }))
    .sort((a, b) => a.u - b.u || a.nodeIndex - b.nodeIndex);
  const grouped: VideoNodeStop[] = [];
  for (const stop of sorted) {
    const previous = grouped.at(-1);
    if (previous && Math.abs(previous.u - stop.u) < 0.008) {
      if ((stop.holdMs || 0) >= (previous.holdMs || 0)) grouped[grouped.length - 1] = stop;
    } else {
      grouped.push(stop);
    }
  }
  if (grouped.length <= 12) return grouped;
  const selected: VideoNodeStop[] = [];
  for (let i = 0; i < 12; i++) {
    const stop = grouped[Math.round((i * (grouped.length - 1)) / 11)];
    if (stop !== selected.at(-1)) selected.push(stop);
  }
  return selected;
}

export function buildVideoTimeline(stops: VideoNodeStop[], pacing: VideoPacing = 'fixed', seconds = 15): VideoTimeline {
  const requested = Number.isFinite(seconds) ? seconds : 15;
  const travelBudget = pacing === 'smart' ? 15000 : Math.max(1000, requested * 1000);
  const endpointHoldMs = pacing === 'smart' ? 3200 : 2800;
  const phases: VideoPhase[] = [];
  let cursor = 0;
  if (pacing !== 'smart') {
    phases.push({ kind: 'travel', startMs: 0, endMs: travelBudget, fromU: 0, toU: 1 });
    cursor = travelBudget;
  } else {
    const selected = smartStops(stops);
    const boundaries = [0, ...selected.map((stop) => stop.u), 1];
    const weights = boundaries.slice(1).map((value, i) => Math.max(0.001, value - boundaries[i]));
    const minimum = 450;
    const budget = Math.max(travelBudget, weights.length * minimum);
    const spare = budget - weights.length * minimum;
    const weightTotal = weights.reduce((sum, value) => sum + value, 0);
    for (let i = 0; i < selected.length; i++) {
      const travelMs = minimum + spare * weights[i] / weightTotal;
      const fromU = boundaries[i], toU = boundaries[i + 1];
      phases.push({ kind: 'travel', startMs: cursor, endMs: cursor + travelMs, fromU, toU });
      cursor += travelMs;
      const stop = selected[i];
      const holdMs = stop.holdMs || 3000;
      phases.push({ kind: 'node', startMs: cursor, endMs: cursor + holdMs, fromU: stop.u, toU: stop.u, nodeIndex: stop.nodeIndex });
      cursor += holdMs;
    }
    const travelMs = minimum + spare * weights.at(-1)! / weightTotal;
    phases.push({ kind: 'travel', startMs: cursor, endMs: cursor + travelMs, fromU: boundaries.at(-2)!, toU: 1 });
    cursor += travelMs;
  }
  phases.push({ kind: 'endpoint', startMs: cursor, endMs: cursor + endpointHoldMs, fromU: 1, toU: 1 });
  cursor += endpointHoldMs;
  return { phases, durationMs: cursor, endpointHoldMs };
}

export function sampleVideoTimeline(timeline: VideoTimeline, elapsedMs: number) {
  const elapsed = Math.max(0, elapsedMs);
  const phase = timeline.phases.find((item) => elapsed < item.endMs) || timeline.phases.at(-1)!;
  const localMs = Math.max(0, elapsed - phase.startMs);
  const progress = phase.endMs > phase.startMs ? Math.min(1, localMs / (phase.endMs - phase.startMs)) : 1;
  const u = phase.kind === 'travel' ? phase.fromU + (phase.toU - phase.fromU) * progress : phase.toU;
  return { phase, localMs, u, nodeIndex: phase.nodeIndex };
}
