import { describe, expect, it } from 'vitest';
import { haversine } from '../src/core/geo';
import {
  runSimulation,
  simulateTrack,
  type SimulatedFix,
  type SimulationEvent,
  type SimulationItem
} from '../src/core/simulation';

function fixes(items: SimulationItem[]) {
  return items.filter((item): item is { kind: 'fix'; fix: SimulatedFix } => item.kind === 'fix').map((item) => item.fix);
}

function events(items: SimulationItem[]) {
  return items.filter((item): item is { kind: 'event'; event: SimulationEvent } => item.kind === 'event').map((item) => item.event);
}

function trackDistance(points: SimulatedFix[]) {
  let distance = 0;
  for (let index = 1; index < points.length; index++) {
    distance += haversine(points[index - 1].lat, points[index - 1].lon, points[index].lat, points[index].lon);
  }
  return distance;
}

describe('GPS trajectory simulation', () => {
  it('generates deterministic fixes and events for the same seed', () => {
    const options = { scenario: 'mixed' as const, durationMs: 60_000, sampleMs: 1000, startTime: 1000, seed: 7 };
    expect([...simulateTrack(options)]).toEqual([...simulateTrack(options)]);
  });

  it('moves hiking, cycling and driving scenarios at their expected speeds', () => {
    const options = { durationMs: 120_000, sampleMs: 1000, startTime: 1000, seed: 3 };
    const hike = fixes([...simulateTrack({ ...options, scenario: 'hike' })]);
    const cycle = fixes([...simulateTrack({ ...options, scenario: 'cycle' })]);
    const drive = fixes([...simulateTrack({ ...options, scenario: 'drive' })]);

    expect(hike).toHaveLength(121);
    expect(hike.every((fix) => fix.speed > 1 && fix.speed < 1.6)).toBe(true);
    expect(trackDistance(cycle)).toBeGreaterThan(trackDistance(hike) * 4);
    expect(trackDistance(drive)).toBeGreaterThan(trackDistance(cycle) * 3);
    expect(hike.every((fix, index) => index === 0 || fix.t > hike[index - 1].t)).toBe(true);
  });

  it('injects both poor-accuracy and displaced drift fixes', () => {
    const options = { durationMs: 120_000, sampleMs: 1000, startTime: 1000, seed: 5 };
    const normal = fixes([...simulateTrack({ ...options, scenario: 'hike' })]);
    const items = [...simulateTrack({ ...options, scenario: 'drift' })];
    const drifted = fixes(items);

    expect(events(items).some((event) => event.type === 'gps-drift')).toBe(true);
    expect(drifted.some((fix) => fix.acc > 50)).toBe(true);
    expect(drifted.some((fix, index) => Math.abs(fix.lon - normal[index].lon) > 0.0002)).toBe(true);
  });

  it('creates a location-loss gap longer than the recorder segment threshold', () => {
    const items = [...simulateTrack({ scenario: 'location-loss', durationMs: 20 * 60_000, sampleMs: 10_000, startTime: 1000 })];
    const points = fixes(items);
    const loss = events(items).find((event) => event.type === 'location-loss');
    const restored = events(items).find((event) => event.type === 'location-restored');
    const gaps = points.slice(1).map((point, index) => point.t - points[index].t);

    expect(loss?.durationMs).toBe(8 * 60_000);
    expect(restored?.t).toBeGreaterThan(loss!.t);
    expect(Math.max(...gaps)).toBeGreaterThan(5 * 60_000);
  });

  it('injects a large altitude spike without changing fix cadence', () => {
    const points = fixes([...simulateTrack({ scenario: 'altitude-spike', durationMs: 600_000, sampleMs: 1000, startTime: 1000 })]);
    const altitudes = points.map((point) => point.alt);
    expect(Math.max(...altitudes) - Math.min(...altitudes)).toBeGreaterThan(140);
    expect(points.every((point, index) => index === 0 || point.t - points[index - 1].t === 1000)).toBe(true);
  });

  it('keeps a stationary scenario still and a sudden-stop scenario stopped', () => {
    const stationary = fixes([...simulateTrack({ scenario: 'stationary', durationMs: 300_000, sampleMs: 10_000, startTime: 1000 })]);
    expect(stationary.every((point) => point.speed === 0)).toBe(true);
    expect(trackDistance(stationary)).toBeLessThan(10);

    const items = [...simulateTrack({ scenario: 'sudden-stop', durationMs: 300_000, sampleMs: 10_000, startTime: 1000 })];
    const moving = fixes(items);
    const stop = events(items).find((event) => event.type === 'sudden-stop')!;
    expect(moving.some((point) => point.t < stop.t && point.speed > 0)).toBe(true);
    expect(moving.filter((point) => point.t >= stop.t).every((point) => point.speed === 0)).toBe(true);
  });

  it('models background suspension and network loss as ordered events', () => {
    const background = [...simulateTrack({ scenario: 'background-suspend', durationMs: 20 * 60_000, sampleMs: 10_000, startTime: 1000 })];
    const backgroundEvents = events(background);
    expect(backgroundEvents.map((event) => event.type)).toEqual(['background-suspend', 'background-resume']);
    expect(backgroundEvents[1].t - backgroundEvents[0].t).toBe(10 * 60_000);

    const network = events([...simulateTrack({ scenario: 'network-switch', durationMs: 120_000, sampleMs: 1000, startTime: 1000 })]);
    expect(network.map((event) => event.type)).toEqual(['network-offline', 'network-online']);
    expect(network[0].t).toBeLessThan(network[1].t);
  });

  it('combines all anomaly phases without hiding fixes inside overlapping gaps', () => {
    const items = [...simulateTrack({ scenario: 'mixed', durationMs: 60 * 60_000, sampleMs: 10_000, startTime: 1000, seed: 9 })];
    const types = new Set(events(items).map((event) => event.type));
    const points = fixes(items);
    const gaps = points.slice(1).map((point, index) => point.t - points[index].t);

    expect([...types]).toEqual(expect.arrayContaining([
      'gps-drift', 'location-loss', 'location-restored', 'altitude-spike', 'stationary',
      'resume-motion', 'sudden-stop', 'background-suspend', 'background-resume',
      'network-offline', 'network-online'
    ]));
    expect(points.length).toBeGreaterThan(250);
    expect(Math.max(...gaps)).toBeGreaterThan(5 * 60_000);
    expect(points.some((point) => point.alt > 240)).toBe(true);
    expect(points.some((point) => point.speed === 0)).toBe(true);
  });

  it('runs hooks in order and honours cancellation', async () => {
    const controller = new AbortController();
    const order: string[] = [];
    const result = await runSimulation(
      { scenario: 'network-switch', durationMs: 60_000, sampleMs: 1000, startTime: 1000 },
      {
        signal: controller.signal,
        onEvent: (event) => { order.push(event.type); },
        onFix: () => {
          order.push('fix');
          if (order.filter((entry) => entry === 'fix').length === 5) controller.abort();
        }
      }
    );

    expect(result).toMatchObject({ fixes: 5, aborted: true, firstFixT: 1000, lastFixT: 5000 });
    expect(order[0]).toBe('fix');
    expect(order.slice(1, 5)).toEqual(Array(4).fill('fix'));
  });

  it.each([4, 8])('compresses a %i-hour recording into a deterministic fixed-cadence track', (hours) => {
    const durationMs = hours * 60 * 60_000;
    const points = fixes([...simulateTrack({ scenario: 'hike', durationMs, sampleMs: 10_000, startTime: 1000 })]);
    expect(points).toHaveLength(hours * 360 + 1);
    expect(points.at(-1)!.t - points[0].t).toBe(durationMs);
  });

  it('rejects invalid scenario boundaries before generating fixes', () => {
    expect(() => [...simulateTrack({ scenario: 'unknown' as any })]).toThrow('unknown simulation scenario');
    expect(() => [...simulateTrack({ durationMs: 0 })]).toThrow('durationMs');
    expect(() => [...simulateTrack({ sampleMs: Number.NaN })]).toThrow('sampleMs');
    expect(() => [...simulateTrack({ start: { lat: 91, lon: 120, alt: 100 } })]).toThrow('latitude');
  });
});
