import { describe, expect, it } from 'vitest';
import {
  applyTrackRepairs, buildTrackRepairEdits, buildTrackRepairPreview,
  sameTrackRepairPreview, TRACK_REPAIR_METRIC_SEMANTICS
} from '../src/core/trackRepair';

const point = (east = 0, t = 0, extra = {}) => ({
  lat: 30 + east / 111_320,
  lon: 120,
  t,
  acc: 8,
  alt: 100,
  ...extra
});
const segment = (points, id = 'seg-1') => ({ id, index: 0, points });

function byCategory(preview, category) {
  return preview.suggestions.filter((item) => item.category === category);
}

describe('explainable track repair', () => {
  it('classifies altitude jumps separately and clears only the suspect altitude by default', () => {
    const points = [point(0, 0, { alt: 100 }), point(1, 5_000, { alt: 240 }), point(2, 10_000, { alt: 241 })];
    const preview = buildTrackRepairPreview([segment(points)], 'hike');
    const jump = byCategory(preview, 'altitude-jump');

    expect(jump).toHaveLength(1);
    expect(jump[0]).toMatchObject({ action: 'clear-altitude', impactDistance: 0, confidence: 0.85 });
    expect(jump[0].detail).toMatchObject({ altitudeDelta: 140, elapsedMs: 5_000 });
    expect(preview.selected).toContain('altitude-jump');
    const repaired = applyTrackRepairs([segment(points)], preview.suggestions, preview.selected);
    expect(repaired.removed).toBe(0);
    expect(repaired.altitudeCleared).toBe(1);
    expect(repaired.segments[0].points[1]).toMatchObject({ lat: points[1].lat, lon: points[1].lon, t: 5_000 });
    expect(repaired.segments[0].points[1]).not.toHaveProperty('alt');
    expect(points[1].alt).toBe(240);
  });

  it('keeps invalid timestamps opt-in while removing exact duplicate fixes by default', () => {
    const points = [point(0, 1_000), point(0, 1_000), point(1, 500), point(2, null)];
    const preview = buildTrackRepairPreview([segment(points)], 'hike');

    expect(byCategory(preview, 'duplicate-fix')).toHaveLength(1);
    expect(byCategory(preview, 'invalid-time')).toHaveLength(2);
    expect(preview.selected).toContain('duplicate-fix');
    expect(preview.selected).not.toContain('invalid-time');
    const repaired = applyTrackRepairs([segment(points)], preview.suggestions, preview.selected);
    expect(repaired.removed).toBe(1);
    expect(repaired.segments[0].points.map((item) => item.t)).toEqual([1_000, 500, null]);
  });

  it('collapses a stationary random walk to one representative only when explicitly selected', () => {
    const offsets = [0, 12, -8, 15, -14, 9, -11, 13, -6, 10, -13, 7];
    const points = offsets.map((east, index) => point(east, index * 5_000));
    const preview = buildTrackRepairPreview([segment(points)], 'hike');
    const walk = byCategory(preview, 'stationary-walk');

    expect(walk).toHaveLength(1);
    expect(walk[0]).toMatchObject({ action: 'collapse', confidence: 0.7 });
    expect(walk[0].detail.pathDistance).toBeGreaterThan(180);
    expect(walk[0].detail.displacement).toBeLessThan(50);
    expect(preview.selected).not.toContain('stationary-walk');
    const repaired = applyTrackRepairs([segment(points)], preview.suggestions, ['stationary-walk']);
    const keepIndex = walk[0].indexes[walk[0].pointIds.indexOf(walk[0].keepPointId)];
    expect(repaired.segments[0].points).toHaveLength(1);
    expect(repaired.segments[0].points[0].t).toBe(points[keepIndex].t);
  });

  it('classifies pauses, location loss, short sampling gaps and unknown long gaps without inventing points', () => {
    const segments = [
      segment([point(0, 0), point(5, 90_000)], 'pause'),
      segment([point(0, 0), point(30, 360_000)], 'loss'),
      segment([point(0, 0), point(100, 90_000)], 'sampling'),
      segment([point(0, 0), point(1000, 180_000)], 'unknown')
    ];
    const preview = buildTrackRepairPreview(segments, 'drive');

    expect(byCategory(preview, 'gap-pause')).toHaveLength(1);
    expect(byCategory(preview, 'gap-location-loss')).toHaveLength(1);
    expect(byCategory(preview, 'gap-sampling')).toHaveLength(1);
    expect(byCategory(preview, 'gap-unknown')).toHaveLength(1);
    expect(preview.suggestions.filter((item) => item.action === 'classify')).toHaveLength(4);
    expect(preview.selected.some((item) => item.startsWith('gap-'))).toBe(false);
    const repaired = applyTrackRepairs(segments, preview.suggestions, preview.selected);
    expect(repaired.segments).toEqual(segments);
    expect(repaired.removed).toBe(0);
  });

  it('keeps suggestion identity stable when earlier point indexes shift', () => {
    const duplicate = point(4, 4_000);
    const before = buildTrackRepairPreview([segment([point(0, 0), point(1, 1_000), duplicate, duplicate])], 'hike');
    const after = buildTrackRepairPreview([segment([point(-10, -1_000), point(0, 0), point(1, 1_000), duplicate, duplicate])], 'hike');
    const beforeId = byCategory(before, 'duplicate-fix')[0].id;
    const afterId = byCategory(after, 'duplicate-fix')[0].id;

    expect(afterId).toBe(beforeId);
    expect(after.suggestions.find((item) => item.id === afterId).indexes[0]).toBe(4);
    expect(sameTrackRepairPreview(before, after)).toBe(false);
  });

  it('provides bounded before/after overlays and explicit corrected metric semantics', () => {
    const points = Array.from({ length: 5000 }, (_, index) => point(index % 40, index * 1000));
    const preview = buildTrackRepairPreview([segment(points)], 'hike');

    expect(preview.overlay.before[0].length).toBeLessThanOrEqual(4000);
    expect(preview.overlay.after[0].length).toBeLessThanOrEqual(4000);
    expect(preview.metrics.semantics).toEqual(TRACK_REPAIR_METRIC_SEMANTICS);
    expect(preview.metrics.after.pointCount).toBeLessThanOrEqual(preview.metrics.before.pointCount);
    expect(preview.metrics.after.duration).toBe(preview.metrics.before.duration);
    expect(preview.summary.classifiedGaps).toBe(0);
  });

  it('builds only changed segment edits and rejects altered previews or selections', () => {
    const points = [point(0, 0), point(0, 0), point(1, 1_000)];
    const segments = [segment(points), segment([point(2, 2_000, { alt: 110 })], 'seg-2')];
    const preview = buildTrackRepairPreview(segments, 'hike');
    const edits = buildTrackRepairEdits(segments, preview);

    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ segmentId: 'seg-1' });
    expect(edits[0].after).toHaveLength(2);
    expect(() => applyTrackRepairs(segments, preview.suggestions, ['not-a-category'])).toThrow('invalid-repair-selection');
    expect(sameTrackRepairPreview(preview, { ...preview, selected: ['invalid-time'] })).toBe(false);
    expect(sameTrackRepairPreview(preview, { ...preview, suggestions: [] })).toBe(false);
  });
});
