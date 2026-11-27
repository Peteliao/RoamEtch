import { describe, expect, it } from 'vitest';
import {
  buildAnnualReport,
  buildPersonalRecords,
  type AnnualEntry,
  type AnnualReport,
  type PersonalRecord
} from '../src/core/annualReport';
import { computeDistanceSplits } from '../src/core/distanceSplits';
import { computeStats } from '../src/core/stats';

const EARTH_RADIUS = 6371008.8;
const MINUTE = 60_000;

function stats(values: any = {}) {
  return {
    distance: 0,
    duration: 0,
    activeMs: 0,
    movingMs: 0,
    stillMs: 0,
    breakMs: 0,
    ascent: 0,
    descent: 0,
    avgSpeed: 0,
    ...values
  };
}

function entry(id: string, createdAt: number, values: any = {}, trip: any = {}): AnnualEntry {
  return {
    trip: { id, name: `Trip ${id}`, activity: 'hike', createdAt, ...trip },
    stats: stats(values)
  };
}

function at(distance: number, t: number, alt: number | null = 100) {
  return { lat: 0, lon: (distance / EARTH_RADIUS) * 180 / Math.PI, t, alt };
}

function computedEntry(
  id: string,
  createdAt: number,
  segments: Array<{ id: string; points: ReturnType<typeof at>[] }>,
  activity = 'bike'
): AnnualEntry {
  return {
    trip: { id, name: `Trip ${id}`, activity, createdAt },
    stats: computeStats(segments, { activity }),
    splits: computeDistanceSplits(segments, 1000, { activity })
  };
}

function movingEntry(id: string, createdAt: number, distance: number, stepMs = 20_000) {
  const points = Array.from({ length: distance / 100 + 1 }, (_, index) => at(index * 100, createdAt + index * stepMs));
  return computedEntry(id, createdAt, [{ id: `segment-${id}`, points }]);
}

function manualSplit(overrides: any = {}) {
  const startDistance = overrides.startDistance ?? 0;
  const endDistance = overrides.endDistance ?? 1000;
  const startTime = overrides.startTime ?? 1_000_000;
  const duration = overrides.duration ?? 200_000;
  return {
    index: 0,
    distance: endDistance - startDistance,
    duration,
    activeMs: duration,
    movingMs: overrides.movingMs ?? duration,
    avgSpeed: 5,
    partial: false,
    startDistance,
    endDistance,
    parts: [{
      segmentId: overrides.segmentId ?? 'segment-a',
      segmentIndex: overrides.segmentIndex ?? 0,
      startDistance,
      endDistance,
      points: [
        at(startDistance, startTime, overrides.startAlt ?? 100),
        at(endDistance, startTime + (overrides.pointDuration ?? duration), overrides.endAlt ?? 110)
      ]
    }],
    ...overrides
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function expectMondayWeeks(report: AnnualReport) {
  for (const week of report.weeks) {
    expect(new Date(`${week.start}T00:00:00`).getDay()).toBe(1);
    expect(new Date(`${week.end}T00:00:00`).getDay()).toBe(0);
  }
}

describe('annual reports', () => {
  it('returns a complete empty-safe report with an injected clock', () => {
    const report = buildAnnualReport([], 2026, { now: new Date(2026, 4, 10, 12) });

    expect(report.year).toBe(2026);
    expect(report.asOf).toBe('2026-05-10');
    expect(report.totals).toEqual({
      distance: 0, duration: 0, activeMs: 0, movingMs: 0, stillMs: 0, breakMs: 0,
      ascent: 0, descent: 0, tripCount: 0, activeDays: 0
    });
    expect(report.activities).toEqual([]);
    expect(report.months).toHaveLength(12);
    expect(report.months.every((month) => month.tripCount === 0 && month.activeDays === 0)).toBe(true);
    expect(report.weeks.length).toBeGreaterThanOrEqual(52);
    expect(report.weeks.length).toBeLessThanOrEqual(53);
    expectMondayWeeks(report);
    expect(report.streaks).toEqual({
      longest: 0, current: 0, longestStart: null, longestEnd: null, currentStart: null, currentEnd: null
    });
    expect(report.longestTrip).toBeNull();
    expect(report.longestDurationTrip).toBeNull();
    expect(report.mostAscentDay).toBeNull();
  });

  it('aggregates totals, unique active days, activities, and monthly trends', () => {
    const day = new Date(2026, 0, 5);
    const report = buildAnnualReport([
      entry('a', new Date(2026, 0, 5, 6).getTime(), {
        distance: 1000, duration: 3_600_000, activeMs: 3_000_000, movingMs: 2_400_000,
        stillMs: 600_000, breakMs: 600_000, ascent: 100, descent: 80
      }),
      entry('b', new Date(2026, 0, 5, 18).getTime(), {
        distance: 2000, duration: 7_200_000, activeMs: 5_400_000, movingMs: 3_600_000,
        stillMs: 1_800_000, breakMs: 1_800_000, ascent: 200, descent: 150
      }),
      entry('c', new Date(2026, 0, 5, 20).getTime(), {
        distance: 4000, duration: 1_800_000, activeMs: 1_800_000, movingMs: 1_800_000,
        stillMs: 0, breakMs: 0, ascent: 0, descent: 0
      }, { activity: 'bike' })
    ], 2026, { asOf: '2026-01-05' });

    expect(report.totals).toEqual({
      distance: 7000, duration: 12_600_000, activeMs: 10_200_000, movingMs: 7_800_000,
      stillMs: 2_400_000, breakMs: 2_400_000, ascent: 300, descent: 230, tripCount: 3, activeDays: 1
    });
    const hike = report.activities.find((activity) => activity.activity === 'hike')!;
    expect(hike).toMatchObject({ tripCount: 2, activeDays: 1, distance: 3000, duration: 10_800_000 });
    expect(hike.ratio).toBeCloseTo(2 / 3);
    expect(hike.distanceRatio).toBeCloseTo(3 / 7);
    expect(hike.durationRatio).toBeCloseTo(6 / 7);
    expect(report.activities.find((activity) => activity.activity === 'bike')).toMatchObject({
      tripCount: 1, distance: 4000, ratio: 1 / 3, distanceRatio: 4 / 7, durationRatio: 1 / 7
    });
    expect(report.months[0]).toEqual({ month: 1, ...report.totals });
    expect(report.months.slice(1).every((month) => month.distance === 0 && month.activeDays === 0)).toBe(true);
    expect(report.weeks.find((week) => week.start === '2026-01-05')).toMatchObject({
      isoYear: 2026, week: 2, tripCount: 3, activeDays: 1, distance: 7000
    });
    expect(report.streaks.current).toBe(1);
  });

  it('uses local calendar year boundaries and inclusive day filters', () => {
    const entries = [
      entry('previous-year', new Date(2025, 11, 31, 23, 59).getTime(), { distance: 100 }),
      entry('midnight', new Date(2026, 0, 1, 0, 0).getTime(), { distance: 100 }),
      entry('late', new Date(2026, 0, 1, 23, 59).getTime(), { distance: 100 }),
      entry('next-day', new Date(2026, 0, 2, 0, 0).getTime(), { distance: 100 })
    ];

    const all = buildAnnualReport(entries, 2026, { asOf: '2026-01-02' });
    expect(all.totals).toMatchObject({ tripCount: 3, activeDays: 2, distance: 300 });
    expect(all.months[0].tripCount).toBe(3);

    const first = buildAnnualReport(entries, 2026, { start: '2026-01-01', end: '2026-01-01' });
    expect(first.totals).toMatchObject({ tripCount: 2, activeDays: 1, distance: 200 });
    expect(buildAnnualReport(entries, 2026, { start: '2026-01-02' }).totals.tripCount).toBe(1);
    expect(buildAnnualReport(entries, 2026, { end: '2026-01-01' }).totals.tripCount).toBe(2);
    expect(buildAnnualReport(entries, 2025, { asOf: '2025-12-31' }).totals.tripCount).toBe(1);
    expect(buildAnnualReport(entries, 2026, { start: '2026-02-30' }).totals.tripCount).toBe(0);
    expect(buildAnnualReport(entries, 2026, { start: '2026-01-03', end: '2026-01-01' }).totals.tripCount).toBe(0);
  });

  it('keeps local days and Monday weeks stable across a DST transition', () => {
    const entries = [
      entry('saturday', new Date(2026, 2, 7, 23, 30).getTime(), { distance: 100 }),
      entry('sunday-early', new Date(2026, 2, 8, 0, 30).getTime(), { distance: 100 }),
      entry('sunday-late', new Date(2026, 2, 8, 23, 30).getTime(), { distance: 100 }),
      entry('monday', new Date(2026, 2, 9, 0, 30).getTime(), { distance: 100 })
    ];
    const report = buildAnnualReport(entries, 2026, { asOf: '2026-03-09' });

    expect(report.totals).toMatchObject({ tripCount: 4, activeDays: 3, distance: 400 });
    expect(report.streaks).toMatchObject({
      longest: 3, current: 3, longestStart: '2026-03-07', longestEnd: '2026-03-09',
      currentStart: '2026-03-07', currentEnd: '2026-03-09'
    });
    expect(report.weeks.find((week) => week.start === '2026-03-02')).toMatchObject({
      tripCount: 3, activeDays: 2, distance: 300
    });
    expect(report.weeks.find((week) => week.start === '2026-03-09')).toMatchObject({
      isoYear: 2026, week: 11, tripCount: 1, activeDays: 1, distance: 100
    });
  });

  it('labels boundary weeks with local Monday ranges and ISO week years', () => {
    const entries = [
      entry('dec-29', new Date(2025, 11, 29, 12).getTime(), { distance: 100 }),
      entry('dec-31', new Date(2025, 11, 31, 12).getTime(), { distance: 100 }),
      entry('jan-1', new Date(2026, 0, 1, 12).getTime(), { distance: 100 }),
      entry('jan-4', new Date(2026, 0, 4, 12).getTime(), { distance: 100 }),
      entry('jan-5', new Date(2026, 0, 5, 12).getTime(), { distance: 100 })
    ];
    const report = buildAnnualReport(entries, 2026, { asOf: '2026-01-05' });

    expect(report.weeks[0]).toMatchObject({
      isoYear: 2026, week: 1, start: '2025-12-29', end: '2026-01-04', tripCount: 2, activeDays: 2
    });
    expect(report.weeks[1]).toMatchObject({
      isoYear: 2026, week: 2, start: '2026-01-05', end: '2026-01-11', tripCount: 1
    });
    const previous = buildAnnualReport(entries, 2025, { asOf: '2025-12-31' });
    expect(previous.weeks.find((week) => week.start === '2025-12-29')).toMatchObject({
      isoYear: 2026, week: 1, tripCount: 2, activeDays: 2
    });
  });

  it('separates historical and current unique-day streaks', () => {
    const entries = [
      entry('jan-1', new Date(2026, 0, 1, 8).getTime()),
      entry('jan-2-a', new Date(2026, 0, 2, 8).getTime()),
      entry('jan-2-b', new Date(2026, 0, 2, 18).getTime()),
      entry('jan-3', new Date(2026, 0, 3, 8).getTime()),
      entry('jan-10', new Date(2026, 0, 10, 8).getTime()),
      entry('jan-11', new Date(2026, 0, 11, 8).getTime()),
      entry('jan-12', new Date(2026, 0, 12, 8).getTime())
    ];

    const historical = buildAnnualReport(entries, 2026, { asOf: '2026-01-11' });
    expect(historical.totals.activeDays).toBe(6);
    expect(historical.streaks).toEqual({
      longest: 3, current: 2, longestStart: '2026-01-01', longestEnd: '2026-01-03',
      currentStart: '2026-01-10', currentEnd: '2026-01-11'
    });
    expect(buildAnnualReport(entries, 2026, { asOf: '2026-01-12' }).streaks.current).toBe(3);
    expect(buildAnnualReport(entries, 2026, { asOf: '2026-01-04' }).streaks.current).toBe(0);
    expect(buildAnnualReport(entries, 2026, { asOf: '2026-01-20' }).streaks).toMatchObject({ longest: 3, current: 0 });
    expect(buildAnnualReport(entries, 2026, { asOf: 'invalid' }).streaks.current).toBe(0);
  });

  it('lets explicit asOf override the injected current clock', () => {
    const entries = [
      entry('one', new Date(2026, 0, 1, 8).getTime()),
      entry('two', new Date(2026, 0, 2, 8).getTime()),
      entry('three', new Date(2026, 0, 3, 8).getTime())
    ];
    const report = buildAnnualReport(entries, 2026, { now: new Date(2026, 0, 20), asOf: new Date(2026, 0, 3) });
    expect(report.asOf).toBe('2026-01-03');
    expect(report.streaks.current).toBe(3);
    expect(buildAnnualReport(entries, 2026, { now: new Date(2026, 0, 20) }).streaks.current).toBe(0);
  });

  it('finds longest distance, longest duration, and aggregated most-ascent day', () => {
    const report = buildAnnualReport([
      entry('long-distance', new Date(2026, 5, 1, 8).getTime(), {
        distance: 15_000, duration: 7_200_000, movingMs: 6_000_000, ascent: 200
      }),
      entry('long-duration', new Date(2026, 5, 2, 8).getTime(), {
        distance: 10_000, duration: 10_800_000, movingMs: 7_200_000, ascent: 400
      }),
      entry('same-day', new Date(2026, 5, 2, 18).getTime(), {
        distance: 5000, duration: 3_600_000, movingMs: 3_000_000, ascent: 300
      })
    ], 2026, { asOf: '2026-06-02' });

    expect(report.longestTrip).toMatchObject({
      tripId: 'long-distance', name: 'Trip long-distance', activity: 'hike', distance: 15_000,
      duration: 7_200_000, movingMs: 6_000_000, avgSpeed: 2.5, date: '2026-06-01'
    });
    expect(report.longestTrip?.timestamp).toBe(new Date(2026, 5, 1, 8).getTime());
    expect(report.longestDurationTrip).toMatchObject({ tripId: 'long-duration', duration: 10_800_000 });
    expect(report.mostAscentDay).toMatchObject({
      date: '2026-06-02', ascent: 700, descent: 0, distance: 15_000, tripCount: 2, activeDays: 1
    });
  });

  it('does not invent highlights for zero or missing metrics', () => {
    const report = buildAnnualReport([
      { trip: { id: 'missing', createdAt: new Date(2026, 0, 1).getTime() }, stats: null },
      entry('stationary', new Date(2026, 0, 2).getTime())
    ], 2026, { asOf: '2026-01-02' });
    expect(report.totals).toMatchObject({ tripCount: 2, activeDays: 2, distance: 0, duration: 0 });
    expect(report.longestTrip).toBeNull();
    expect(report.longestDurationTrip).toBeNull();
    expect(report.mostAscentDay).toBeNull();
  });

  it('omits invalid dates and normalizes absent or invalid stats without throwing', () => {
    const report = buildAnnualReport([
      null as any,
      { trip: null, stats: stats({ distance: 100 }) },
      { trip: { id: 'bad-date', createdAt: 'not-a-date' }, stats: stats({ distance: 100 }) },
      { trip: { id: 'missing-stats', createdAt: new Date(2026, 0, 1).getTime() }, stats: undefined },
      entry('invalid-stats', new Date(2026, 0, 2).getTime(), {
        distance: NaN, duration: -1, activeMs: Infinity, movingMs: -5, stillMs: NaN,
        breakMs: -10, ascent: NaN, descent: -2
      })
    ], 2026, { asOf: '2026-01-02' });

    expect(report.totals).toEqual({
      distance: 0, duration: 0, activeMs: 0, movingMs: 0, stillMs: 0, breakMs: 0,
      ascent: 0, descent: 0, tripCount: 2, activeDays: 2
    });
    expect(report.activities).toHaveLength(2);
    expect(report.activities.every((activity) => activity.ratio === 0.5)).toBe(true);
    expect(Object.values(report.totals).every(Number.isFinite)).toBe(true);
  });

  it('derives omitted still and break time and labels missing activity as unknown', () => {
    const report = buildAnnualReport([
      entry('partial', new Date(2026, 0, 1).getTime(), {
        distance: 100, duration: 1000, activeMs: 800, movingMs: 300, stillMs: undefined, breakMs: undefined
      }, { activity: undefined })
    ], 2026, { asOf: '2026-01-01' });
    expect(report.totals).toMatchObject({ stillMs: 500, breakMs: 200 });
    expect(report.activities[0]).toMatchObject({ activity: 'unknown', tripCount: 1, ratio: 1 });
  });

  it('does not mutate entries, splits, or options', () => {
    const start = new Date(2026, 0, 1, 6).getTime();
    const entries = deepFreeze([movingEntry('frozen', start, 6000)]);
    const options = deepFreeze({ asOf: '2026-01-01', start: '2026-01-01', end: '2026-01-01' });
    const before = JSON.stringify(entries);

    buildAnnualReport(entries, 2026, options);
    buildPersonalRecords(entries, [5000]);

    expect(JSON.stringify(entries)).toBe(before);
    expect(options).toEqual({ asOf: '2026-01-01', start: '2026-01-01', end: '2026-01-01' });
  });
});

describe('personal records', () => {
  it('returns no fabricated records for empty or insufficient data', () => {
    expect(buildPersonalRecords([])).toEqual([]);
    expect(buildPersonalRecords([movingEntry('short', new Date(2026, 0, 1).getTime(), 3000)])).toEqual([]);
    expect(buildPersonalRecords([movingEntry('long', new Date(2026, 0, 1).getTime(), 6000)], [])).toEqual([]);
    const noSplits = movingEntry('stats-only', new Date(2026, 0, 1).getTime(), 6000);
    expect(buildPersonalRecords([{ ...noSplits, splits: [] }])).toEqual([]);
  });

  it('builds default 5 km and 10 km records from computed interpolated splits', () => {
    const start = new Date(2026, 3, 10, 6).getTime();
    const records = buildPersonalRecords([movingEntry('ten', start, 12_000)]);

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      distance: 5000, tripId: 'ten', name: 'Trip ten', activity: 'bike',
      elapsedMs: 1_000_000,
      timestamp: start, date: '2026-04-10'
    });
    expect(records[0].movingMs).toBeCloseTo(1_000_000, 6);
    expect(records[0].avgSpeed).toBeCloseTo(5, 12);
    expect(records[0].source).toMatchObject({
      splitIndexes: [0, 1, 2, 3, 4], startDistance: 0, endDistance: 5000,
      rawStartDistance: 0, rawEndDistance: 5000
    });
    expect(records[0].source.parts).toHaveLength(5);
    expect(records[0].source.parts[0]).toMatchObject({
      splitIndex: 0, partIndex: 0, segmentId: 'segment-ten', segmentIndex: 0,
      startDistance: 0, endDistance: 1000
    });
    expect(records[0].source.startBoundary).toMatchObject({ distance: 0, t: start, interpolated: false });
    expect(records[0].source.endBoundary).toMatchObject({ distance: 5000, t: start + 1_000_000, interpolated: false });
    expect(records[1]).toMatchObject({
      distance: 10_000, elapsedMs: 2_000_000,
      timestamp: start, date: '2026-04-10'
    });
    expect(records[1].movingMs).toBeCloseTo(2_000_000, 6);
    expect(records[1].avgSpeed).toBeCloseTo(5, 12);
    expect(records[1].source.splitIndexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('sorts, deduplicates, and validates requested distances', () => {
    const records = buildPersonalRecords(
      [movingEntry('custom', new Date(2026, 0, 1).getTime(), 12_000)],
      [10_000, 5000, 5000, 0, -1000, NaN, Infinity]
    );
    expect(records.map((record) => record.distance)).toEqual([5000, 10_000]);
  });

  it('retains raw source boundaries at a detailed partial-split point', () => {
    const start = new Date(2026, 0, 1, 6).getTime();
    const [record] = buildPersonalRecords([movingEntry('partial', start, 5200)], [2500]);

    expect(record).toMatchObject({
      distance: 2500, elapsedMs: 500_000,
      timestamp: start, date: '2026-01-01'
    });
    expect(record.movingMs).toBeCloseTo(500_000, 6);
    expect(record.avgSpeed).toBeCloseTo(5, 12);
    expect(record.source).toMatchObject({
      splitIndexes: [0, 1, 2], startDistance: 0, endDistance: 2500,
      rawStartDistance: 0, rawEndDistance: 3000
    });
    expect(record.source.endBoundary).toMatchObject({
      distance: 2500, t: start + 500_000, segmentId: 'segment-partial', partIndex: 0, interpolated: false
    });
    expect(record.source.endBoundary.lon).toBeCloseTo(at(2500, 0).lon, 12);
    expect(record.source.endBoundary.alt).toBe(100);
  });

  it('finds the fastest split-aligned window inside a trip', () => {
    const start = new Date(2026, 0, 1, 6).getTime();
    const points = Array.from({ length: 101 }, (_, index) => {
      const distance = index * 100;
      const seconds = distance <= 5000 ? distance / 100 * 20 : 1000 + (distance - 5000) / 100 * 10;
      return at(distance, start + seconds * 1000);
    });
    const variable = computedEntry('variable', start, [{ id: 'variable-segment', points }]);
    const slower = movingEntry('slower', start, 5000);
    const [record] = buildPersonalRecords([slower, variable], [5000]);

    expect(record).toMatchObject({
      tripId: 'variable', distance: 5000, elapsedMs: 500_000,
      timestamp: start + 1_000_000, date: '2026-01-01'
    });
    expect(record.movingMs).toBeCloseTo(500_000, 6);
    expect(record.avgSpeed).toBeCloseTo(10, 12);
    expect(record.source).toMatchObject({ startDistance: 5000, endDistance: 10_000, rawStartDistance: 5000, rawEndDistance: 10_000 });
    expect(record.source.splitIndexes).toEqual([5, 6, 7, 8, 9]);
  });

  it('finds a continuous 5 km window whose boundaries fall inside splits', () => {
    const start = new Date(2026, 0, 1, 6).getTime();
    const points = Array.from({ length: 151 }, (_, index) => {
      const distance = index * 50;
      const seconds = distance <= 1500
        ? distance
        : distance <= 6500
          ? 1500 + (distance - 1500) / 3
          : 1500 + 5000 / 3 + (distance - 6500);
      return at(distance, start + seconds * 1000);
    });
    const variable = computedEntry('continuous', start, [{ id: 'continuous-segment', points }]);
    const [record] = buildPersonalRecords([variable], [5000]);

    expect(record).toMatchObject({
      tripId: 'continuous', distance: 5000,
      timestamp: start + 1_500_000, date: '2026-01-01'
    });
    expect(record.elapsedMs).toBeCloseTo(1_666_666.6666666667, 3);
    expect(record.movingMs).toBeCloseTo(1_666_666.6666666667, 3);
    expect(record.avgSpeed).toBeCloseTo(3, 9);
    expect(record.source).toMatchObject({
      startDistance: 1500, endDistance: 6500, rawStartDistance: 1000, rawEndDistance: 7000
    });
    expect(record.source.splitIndexes).toEqual([1, 2, 3, 4, 5, 6]);
    expect(record.source.startBoundary).toMatchObject({ distance: 1500, interpolated: false });
    expect(record.source.endBoundary).toMatchObject({ distance: 6500, interpolated: false });
  });

  it('considers interpolated starts when the end lands on a moving-time breakpoint', () => {
    const start = new Date(2026, 0, 1, 6).getTime();
    const points = [at(0, start)];
    const add = (distance: number, seconds: number) => points.push(at(distance, start + seconds * 1000));
    for (let distance = 50; distance <= 1500; distance += 50) add(distance, distance);
    for (let distance = 1600; distance <= 9000; distance += 100) add(distance, 1500 + (distance - 1500) / 3);
    for (let distance = 9100; distance <= 10_000; distance += 100) add(distance, 1500 + 7500 / 3 + (distance - 9000) / 6);
    const variable = computedEntry('end-breakpoint', start, [{ id: 'end-breakpoint-segment', points }]);
    const [record] = buildPersonalRecords([variable], [4550]);

    expect(record.movingMs).toBeCloseTo(1_350_000, 3);
    expect(record.timestamp).toBeCloseTo(start + 2_816_666.6666666665, 3);
    expect(record.source).toMatchObject({
      startDistance: 5450, endDistance: 10_000, rawStartDistance: 5000, rawEndDistance: 10_000
    });
    expect(record.source.startBoundary).toMatchObject({ distance: 5450, interpolated: true });
    expect(record.source.endBoundary).toMatchObject({ distance: 10_000, interpolated: false });
  });

  it('considers interpolated ends when the start lands on a moving-time breakpoint', () => {
    const start = new Date(2026, 0, 1, 6).getTime();
    const points = [at(0, start)];
    const add = (distance: number, seconds: number) => points.push(at(distance, start + seconds * 1000));
    for (let distance = 50; distance <= 1500; distance += 50) add(distance, distance);
    for (let distance = 1600; distance <= 4000; distance += 100) add(distance, 1500 + (distance - 1500) / 4);
    for (let distance = 4110; distance < 7500; distance += 110) add(distance, 1500 + 2500 / 4 + (distance - 4000) / 2);
    add(7500, 1500 + 2500 / 4 + 3500 / 2);
    const variable = computedEntry('start-breakpoint', start, [{ id: 'start-breakpoint-segment', points }]);
    const [record] = buildPersonalRecords([variable], [4300]);

    expect(record.movingMs).toBeCloseTo(1_525_000, 6);
    expect(record.timestamp).toBe(start + 1_500_000);
    expect(record.source).toMatchObject({
      startDistance: 1500, endDistance: 5800, rawStartDistance: 1000, rawEndDistance: 6000
    });
    expect(record.source.startBoundary).toMatchObject({ distance: 1500, interpolated: false });
    expect(record.source.endBoundary).toMatchObject({ distance: 5800, interpolated: true });
  });

  it('reproduces both records for the 121-point, 60-second e2e seed', () => {
    const start = new Date(2026, 0, 15, 8).getTime();
    const lonStep = 100 / (111_320 * Math.cos(30 * Math.PI / 180));
    const points = Array.from({ length: 121 }, (_, index) => ({
      lat: 30,
      lon: 120 + index * lonStep,
      t: start + index * 60_000,
      alt: 100 + index * 0.5,
      acc: 5,
      speed: 100 / 60,
      heading: 90
    }));
    const segments = [{ id: 'e2e-segment', points }];
    const seeded: AnnualEntry = {
      trip: { id: 'e2e-seed', name: '十二公里徒步', activity: 'hike', createdAt: start },
      stats: computeStats(segments, { activity: 'hike' }),
      splits: computeDistanceSplits(segments, 1000, { activity: 'hike' })
    };
    const records = buildPersonalRecords([seeded]);

    expect(records.map((record) => record.distance)).toEqual([5000, 10_000]);
    expect(records[0].movingMs).toBeCloseTo(3_003_370.2867, 3);
    expect(records[1].movingMs).toBeCloseTo(6_006_740.5734, 3);
    expect(records.every((record) => record.tripId === 'e2e-seed' && record.elapsedMs > 0)).toBe(true);
  });

  it('falls back to split-level moving time when point timing cannot reproduce it', () => {
    const start = new Date(2026, 0, 1, 6).getTime();
    const split = manualSplit({
      duration: 200_000,
      movingMs: 150_000,
      parts: [{
        segmentId: 'fallback-segment',
        segmentIndex: 0,
        startDistance: 0,
        endDistance: 1000,
        points: [at(0, start), at(500, start + 50_000), at(1000, start + 200_000)]
      }]
    });
    const [record] = buildPersonalRecords([{
      trip: { id: 'fallback', activity: 'bike' },
      stats: null,
      splits: [split]
    }], [500]);

    expect(record).toMatchObject({ distance: 500, elapsedMs: 100_000, movingMs: 75_000 });
    expect(record.source.endBoundary).toMatchObject({ distance: 500, interpolated: true });
  });

  it('never stitches distances across separate trips', () => {
    const start = new Date(2026, 0, 1, 6).getTime();
    const entries = [movingEntry('a', start, 3000), movingEntry('b', start + 3_600_000, 3000)];

    expect(buildPersonalRecords(entries, [5000, 10_000])).toEqual([]);
    const records = buildPersonalRecords(entries, [3000]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ tripId: 'a', distance: 3000 });
    expect(records[0].movingMs).toBeCloseTo(600_000, 6);
    expect(records[0].source.parts.every((part) => part.segmentId === 'segment-a')).toBe(true);
  });

  it('never stitches distances across separate prepared runs in one trip', () => {
    const start = new Date(2026, 0, 1, 6).getTime();
    const value: AnnualEntry = {
      trip: { id: 'separate-runs', activity: 'bike' },
      stats: null,
      splits: [
        manualSplit({ index: 0, startDistance: 0, endDistance: 1000, startTime: start }),
        manualSplit({ index: 1, startDistance: 2000, endDistance: 3000, startTime: start + 400_000 })
      ]
    };

    expect(buildPersonalRecords([value], [2500])).toEqual([]);
    const [record] = buildPersonalRecords([value], [1000]);
    expect(record).toMatchObject({ tripId: 'separate-runs', distance: 1000, timestamp: start });
    expect(record.source.splitIndexes).toEqual([0]);
  });

  it('distinguishes elapsed time from moving time when a split contains a pause', () => {
    const start = new Date(2026, 0, 1, 6).getTime();
    const points = [
      at(0, start),
      at(200, start + 40_000),
      at(400, start + 80_000),
      at(600, start + 120_000),
      at(800, start + 160_000),
      at(1000, start + 200_000),
      at(1000, start + 400_000),
      at(1200, start + 440_000),
      at(1400, start + 480_000),
      at(1600, start + 520_000),
      at(1800, start + 560_000),
      at(2000, start + 600_000)
    ];
    const paused = computedEntry('paused', start, [{ id: 'pause-segment', points }]);
    const [record] = buildPersonalRecords([paused], [2000]);

    expect(record).toMatchObject({
      distance: 2000, elapsedMs: 600_000, movingMs: 400_000, avgSpeed: 5,
      timestamp: start, date: '2026-01-01'
    });
    expect(record.source.splitIndexes).toEqual([0, 1]);
  });

  it('retains segment and part provenance across segments within one trip', () => {
    const start = new Date(2026, 0, 1, 6).getTime();
    const segmented = computedEntry('segmented', start, [
      { id: 'segment-a', points: [at(0, start, 100), at(200, start + 40_000, 102), at(400, start + 80_000, 104), at(600, start + 120_000, 110)] },
      { id: 'segment-b', points: [at(10_000, start + 120_000, 200), at(10_200, start + 160_000, 202), at(10_400, start + 200_000, 204), at(10_600, start + 240_000, 210)] }
    ]);
    const [record] = buildPersonalRecords([segmented], [1000]);

    expect(record).toMatchObject({ tripId: 'segmented', distance: 1000, elapsedMs: 200_000 });
    expect(record.movingMs).toBeCloseTo(200_000, 6);
    expect(record.source.splitIndexes).toEqual([0]);
    expect(record.source.parts).toHaveLength(2);
    expect(record.source.parts[0]).toMatchObject({
      splitIndex: 0, partIndex: 0, segmentId: 'segment-a', segmentIndex: 0, startDistance: 0
    });
    expect(record.source.parts[1]).toMatchObject({
      splitIndex: 0, partIndex: 1, segmentId: 'segment-b', segmentIndex: 1, endDistance: 1000
    });
    expect(record.source.parts[0].endDistance).toBeCloseTo(600, 6);
    expect(record.source.parts[1].startDistance).toBeCloseTo(600, 6);
    expect(record.source.startBoundary).toMatchObject({ segmentId: 'segment-a', lon: at(0, 0).lon });
    expect(record.source.endBoundary).toMatchObject({ segmentId: 'segment-b', partIndex: 1, interpolated: false });
    expect(record.source.endBoundary.lon).toBeCloseTo(at(10_400, 0).lon, 12);
  });

  it('accepts a zero-span segment part at an interpolated split boundary', () => {
    const start = new Date(2026, 0, 1, 6).getTime();
    const split = manualSplit({
      index: 4,
      startDistance: 1000,
      endDistance: 2000,
      startTime: start,
      parts: [
        { segmentId: 'segment-a', segmentIndex: 0, startDistance: 1000, endDistance: 1000, points: [at(1000, start)] },
        {
          segmentId: 'segment-b', segmentIndex: 1, startDistance: 1000, endDistance: 2000,
          points: [at(10_000, start), at(10_100, start + 200_000)]
        }
      ]
    });
    const [record] = buildPersonalRecords([{
      trip: { id: 'boundary-part', name: 'Boundary part', activity: 'bike' },
      stats: null,
      splits: [split]
    }], [1000]);

    expect(record).toMatchObject({ distance: 1000, elapsedMs: 200_000, movingMs: 200_000 });
    expect(record.source.startBoundary).toMatchObject({ segmentId: 'segment-b', partIndex: 1, interpolated: false });
    expect(record.source.endBoundary).toMatchObject({ segmentId: 'segment-b', partIndex: 1, interpolated: false });
  });

  it('uses deterministic earliest-time tie breaking regardless of input order', () => {
    const early = new Date(2026, 0, 1, 6).getTime();
    const late = early + 86_400_000;
    const entries = [movingEntry('late', late, 5000), movingEntry('early', early, 5000)];
    expect(buildPersonalRecords(entries, [5000])[0].tripId).toBe('early');
    expect(buildPersonalRecords([...entries].reverse(), [5000])[0].tripId).toBe('early');
  });

  it('skips missing timing and invalid or nonpositive durations', () => {
    const invalid = [
      manualSplit({ duration: 0 }),
      manualSplit({ duration: -1 }),
      manualSplit({ duration: NaN }),
      manualSplit({ movingMs: 0 }),
      manualSplit({ movingMs: -1 }),
      manualSplit({ movingMs: 300_000, duration: 200_000 }),
      manualSplit({ distance: 999 }),
      manualSplit({ parts: [] }),
      manualSplit({ parts: [{ segmentId: 'untimed', segmentIndex: 0, startDistance: 0, endDistance: 1000, points: [at(0, null as any), at(1000, 1_200_000)] }] }),
      manualSplit({ pointDuration: 0 })
    ];
    const entries = invalid.map((split, index) => ({
      trip: { id: `invalid-${index}`, name: `Invalid ${index}`, activity: 'run', createdAt: 1_000_000 },
      stats: stats({ distance: 1000, duration: 200_000, movingMs: 200_000 }),
      splits: [split]
    }));

    expect(buildPersonalRecords(entries, [1000])).toEqual([]);
  });

  it('accepts valid supplied provenance without trip stats or createdAt', () => {
    const split = manualSplit({
      index: 7,
      segmentId: 42,
      segmentIndex: 3,
      startTime: new Date(2026, 0, 2, 23, 30).getTime(),
      startAlt: -10,
      endAlt: -20
    });
    const [record] = buildPersonalRecords([{
      trip: { id: 'metadata-light', activity: 'run' },
      stats: null,
      splits: [split]
    }], [1000]);

    expect(record).toMatchObject({
      tripId: 'metadata-light', name: null, activity: 'run', distance: 1000,
      elapsedMs: 200_000, movingMs: 200_000, avgSpeed: 5,
      timestamp: new Date(2026, 0, 2, 23, 30).getTime(), date: '2026-01-02'
    });
    expect(record.source.splitIndexes).toEqual([7]);
    expect(record.source.parts[0]).toMatchObject({ segmentId: 42, segmentIndex: 3, partIndex: 0 });
    expect(record.source.startBoundary.alt).toBe(-10);
    expect(record.source.endBoundary.alt).toBe(-20);
  });

  it('keeps record output deterministic and does not mutate supplied splits', () => {
    const value = deepFreeze({
      trip: { id: 'immutable', name: 'Immutable', activity: 'hike', createdAt: 1_000_000 },
      stats: stats({ distance: 1000, duration: 200_000, movingMs: 200_000 }),
      splits: [manualSplit()]
    });
    const before = JSON.stringify(value);
    const first: PersonalRecord[] = buildPersonalRecords([value], [1000]);
    const second = buildPersonalRecords([value], [1000]);

    expect(first).toEqual(second);
    expect(JSON.stringify(value)).toBe(before);
    expect(first[0]).not.toBeInstanceOf(Promise);
  });
});
