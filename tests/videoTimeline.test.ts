import { describe, expect, it } from 'vitest';
import { buildVideoTimeline, sampleVideoTimeline } from '../src/core/videoTimeline';

describe('video timeline', () => {
  it('keeps fixed replay timing and adds an endpoint hold before the outro', () => {
    const timeline = buildVideoTimeline([], 'fixed', 15);
    expect(timeline.durationMs).toBe(17800);
    expect(timeline.phases.map((phase) => phase.kind)).toEqual(['travel', 'endpoint']);
    expect(sampleVideoTimeline(timeline, 16000).u).toBe(1);
    expect(sampleVideoTimeline(timeline, 17000).phase.kind).toBe('endpoint');
  });

  it('pauses smart replay at each node and freezes route progress during the hold', () => {
    const timeline = buildVideoTimeline([
      { u: 0.2, holdMs: 3200, nodeIndex: 0 },
      { u: 0.8, holdMs: 3800, nodeIndex: 1 }
    ], 'smart', 15);
    const firstNode = timeline.phases.find((phase) => phase.kind === 'node')!;
    const start = sampleVideoTimeline(timeline, firstNode.startMs + 100);
    const end = sampleVideoTimeline(timeline, firstNode.endMs - 100);
    expect(start.u).toBeCloseTo(0.2);
    expect(end.u).toBeCloseTo(0.2);
    expect(start.nodeIndex).toBe(0);
    expect(timeline.durationMs).toBe(25200);
    expect(buildVideoTimeline([], 'smart', 30).durationMs).toBe(18200);
    expect(sampleVideoTimeline(timeline, timeline.durationMs - 100).phase.kind).toBe('endpoint');
  });

  it('groups coincident nodes and caps smart holds for dense tracks', () => {
    const grouped = buildVideoTimeline([
      { u: 0.5, holdMs: 2600, nodeIndex: 0 },
      { u: 0.5, holdMs: 3800, nodeIndex: 1 }
    ], 'smart', 10);
    const groupedPhases = grouped.phases.filter((phase) => phase.kind === 'node');
    expect(groupedPhases).toHaveLength(1);
    expect(groupedPhases[0].nodeIndex).toBe(1);
    expect(groupedPhases[0].endMs - groupedPhases[0].startMs).toBe(3800);

    const stops = Array.from({ length: 30 }, (_, i) => ({ u: i / 29, holdMs: 2600, nodeIndex: i }));
    const timeline = buildVideoTimeline(stops, 'smart', 10);
    expect(timeline.phases.filter((phase) => phase.kind === 'node').length).toBeLessThanOrEqual(12);
  });
});
