// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { feedFix, rewalk, startRewalk, stopRewalk } from '../src/core/rewalk';

const mocks = vi.hoisted(() => ({
  loadTripFull: vi.fn(),
  emit: vi.fn()
}));

vi.mock('../src/core/store', () => ({ loadTripFull: mocks.loadTripFull }));
vi.mock('../src/core/events', () => ({ emit: mocks.emit }));
vi.mock('../src/core/recorder', () => ({ rec: { status: 'idle' } }));
vi.mock('../src/core/i18n', () => ({
  t: (key: string, opts: Record<string, any> = {}) =>
    Object.keys(opts).length ? `${key}|${JSON.stringify(opts)}` : key,
  currentLang: () => 'en'
}));
vi.mock('../src/core/settings', () => ({
  get: (key: string) => key === 'units' ? 'metric' : true,
  set: vi.fn()
}));

class FakeUtterance {
  text: string;
  volume = 1;
  rate = 1;
  lang = '';
  voice: unknown = null;
  constructor(text: string) { this.text = text; }
}

const spoken: FakeUtterance[] = [];
const speechSynthesisMock = {
  paused: false,
  speak: vi.fn((utterance: FakeUtterance) => { spoken.push(utterance); }),
  cancel: vi.fn(),
  resume: vi.fn(),
  getVoices: vi.fn(() => [])
};

function fullTrip(segments: any[][], statsCache: any = null, waypoints: any[] = []) {
  return {
    trip: { id: 'trip-1', name: 'Test route', statsCache },
    segments: segments.map((points, index) => ({ id: `segment-${index}`, points })),
    waypoints
  } as any;
}

async function begin(segments: any[][], mode: 'full-fwd' | 'full-rev' | 'near-end' | 'near-start' = 'full-fwd', statsCache: any = null, waypoints: any[] = []) {
  mocks.loadTripFull.mockResolvedValue(fullTrip(segments, statsCache, waypoints));
  await expect(startRewalk('trip-1', mode)).resolves.toBe(true);
}

function fix(lat: number, lon: number, t: number | null = null, speed: number | null = null) {
  feedFix(lat, lon, 5, null, speed, t);
}

function lastFixEvent(): any {
  return mocks.emit.mock.calls.filter(([event]) => event === 'rewalk:fix').at(-1)?.[1];
}

beforeEach(() => {
  spoken.length = 0;
  mocks.loadTripFull.mockReset();
  mocks.emit.mockReset();
  speechSynthesisMock.speak.mockClear();
  speechSynthesisMock.cancel.mockClear();
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
  vi.stubGlobal('speechSynthesis', speechSynthesisMock);
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { watchPosition: vi.fn(() => 7), clearWatch: vi.fn() }
  });
});

afterEach(() => {
  stopRewalk();
  vi.unstubAllGlobals();
});

describe('re-walk route projection and bearings', () => {
  it('projects onto segment interiors and never connects separate segments', async () => {
    await begin([
      [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.01 }],
      [{ lat: 1, lon: 1 }, { lat: 1, lon: 1.01 }]
    ]);
    fix(0, 0, 1000);

    fix(0.001, 0.005, 2000);
    expect(rewalk.projection?.segmentIndex).toBe(0);
    expect(rewalk.projection?.fraction).toBeCloseTo(0.5, 5);
    expect(rewalk.maxAlong).toBeGreaterThan(500);
    expect(rewalk.maxAlong).toBeLessThan(600);
    expect(rewalk.offTrack).toBeGreaterThan(100);
    expect(rewalk.offTrack).toBeLessThan(120);
    expect(rewalk.routeBearing).toBeCloseTo(90, 3);
    expect(rewalk.total).toBeLessThan(3000);

    // This lies on the old flattened bridge between segment endpoints.
    fix(0.5, 0.505, 3000);
    expect(rewalk.projection?.dist).toBeGreaterThan(70_000);
    expect(rewalk.segmentRanges).toHaveLength(2);
  });

  it('keeps route and navigation bearings finite and normalized', async () => {
    await begin([[{ lat: 0, lon: 179.99 }, { lat: 0, lon: -179.99 }]]);
    fix(1, 1, 1000);
    expect(rewalk.navBearing).toBeGreaterThanOrEqual(0);
    expect(rewalk.navBearing).toBeLessThan(360);
    expect(Number.isFinite(rewalk.navBearing)).toBe(true);

    fix(0, 179.99, 2000);
    expect(rewalk.navBearing).toBeNull();
    expect(rewalk.routeBearing).toBeCloseTo(90, 3);
  });

  it('returns null route bearing at a disconnected segment endpoint', async () => {
    await begin([
      [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.01 }],
      [{ lat: 1, lon: 1 }, { lat: 1, lon: 1.01 }]
    ]);
    fix(0, 0, 1000);
    fix(0, 0.01, 2000);

    expect(rewalk.projection?.segmentIndex).toBe(0);
    expect(rewalk.routeBearing).toBeNull();
    expect(lastFixEvent().routeBearing).toBeNull();
  });
});

describe('re-walk live navigation metrics', () => {
  const route = [[{ lat: 0, lon: 0 }, { lat: 0, lon: 0.01 }]];

  it('uses the current projection after backtracking for remaining, ETA, progress and next waypoint', async () => {
    const nearWp = { id: 'near', type: 'waypoint', name: 'Near waypoint', desc: '', lat: 0, lon: 0.00045 };
    const laterWp = { id: 'later', type: 'waypoint', name: 'Later waypoint', desc: '', lat: 0, lon: 0.00125 };
    await begin(route, 'full-fwd', null, [nearWp, laterWp]);
    fix(0, 0, 1000, 2);
    fix(0, 0.0009, 2000, 2);
    const forward = lastFixEvent();
    expect(forward.nextWp.name).toBe('Later waypoint');

    fix(0, 0.00018, 3000, 2);
    const along = rewalk.along;
    const backtracked = lastFixEvent();
    const near = rewalk.wps.find((w) => w.id === 'near')!;
    expect(along).toBeLessThan(forward.along);
    expect(rewalk.maxAlong).toBeCloseTo(forward.along, 6);
    expect(backtracked.along).toBeCloseTo(along, 6);
    expect(backtracked.remaining).toBeCloseTo(rewalk.total - along, 6);
    expect(backtracked.etaSeconds).toBe(Math.round((rewalk.total - along) / 2));
    expect(backtracked.progress).toBeCloseTo(along / rewalk.total, 6);
    expect(backtracked.nextWp).toMatchObject({ name: 'Near waypoint' });
    expect(backtracked.nextWp.dist).toBeCloseTo(near.distAlong - along, 6);
  });

  it('speaks a nearby waypoint with bearing and ETA placeholders filled', async () => {
    const nearWp = { id: 'near', type: 'waypoint', name: 'Near waypoint', desc: '', lat: 0, lon: 0.0009 };
    await begin(route, 'full-fwd', null, [nearWp]);
    fix(0, 0, 1000, 2);
    const announcement = spoken.find((utterance) => utterance.text.startsWith('rewalk.nearAnnounce|'));
    expect(announcement).toBeTruthy();
    expect(announcement!.text).toContain('rewalk.toward');
    expect(announcement!.text).toContain('rewalk.directions.east');
    expect(announcement!.text).toContain('rewalk.etaPhrase');
    expect(announcement!.text).not.toContain('{{');
  });
});

describe('re-walk ETA', () => {
  const route = [[{ lat: 0, lon: 0 }, { lat: 0, lon: 0.01 }]];

  it('prefers a valid GPS speed and marks it as measured', async () => {
    await begin(route);
    fix(0, 0, 1000, 2);
    expect(rewalk.etaSeconds).toBe(Math.round(rewalk.total / 2));
    expect(rewalk.etaSource).toBe('gps');
    expect(rewalk.etaEstimated).toBe(false);
    expect(rewalk.speedMps).toBe(2);
    expect(lastFixEvent()).toMatchObject({ etaSource: 'gps', etaEstimated: false, speedMps: 2 });
  });

  it('uses a continuous-fix implied-speed EWMA when GPS speed is absent', async () => {
    await begin(route);
    fix(0, 0, 1000);
    fix(0, 0.0001, 2000);
    fix(0, 0.0003, 3000);

    const first = 11.119;
    const second = 22.238;
    const expected = 0.35 * second + 0.65 * first;
    expect(rewalk.recentSpeedMps).toBeCloseTo(expected, 1);
    expect(rewalk.etaSource).toBe('recent');
    expect(rewalk.etaEstimated).toBe(true);
    expect(rewalk.etaSeconds).toBe(Math.round((rewalk.total - rewalk.maxAlong) / rewalk.recentSpeedMps!));
  });

  it('falls back to historical distance/movingMs and marks the ETA estimated', async () => {
    await begin(route, 'full-fwd', { distance: 1000, movingMs: 500_000 });
    fix(0, 0, 1000);
    fix(0, 0, 2000, Number.NaN);
    expect(rewalk.historicalSpeedMps).toBe(2);
    expect(rewalk.etaSource).toBe('historical');
    expect(rewalk.etaEstimated).toBe(true);
    expect(rewalk.etaSeconds).toBe(Math.round(rewalk.total / 2));
  });

  it('returns a null ETA when no defensible speed exists', async () => {
    await begin([[{ lat: 0, lon: 0 }, { lat: 0, lon: 0.01 }]]);
    fix(0, 0, 1000);
    fix(0, 0, 2000, -1);
    expect(rewalk.etaSeconds).toBeNull();
    expect(rewalk.etaSource).toBeNull();
    expect(rewalk.etaEstimated).toBe(false);
    expect(rewalk.speedMps).toBeNull();
  });
});

describe('re-walk turn guidance', () => {
  const corner = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.004 },
    { lat: 0.004, lon: 0.004 }
  ];

  it('looks ahead by along-distance and deduplicates a significant turn', async () => {
    await begin([corner]);
    fix(0, 0, 1000);
    expect(rewalk.turn).toBeNull();

    fix(0, 0.003, 2000);
    const id = rewalk.turn?.id;
    expect(rewalk.turn).toMatchObject({ direction: 'left', angleDeg: 90, isNew: true });
    expect(rewalk.turn?.distanceM).toBeGreaterThan(100);
    expect(rewalk.turn?.distanceM).toBeLessThan(120);
    const turnAnnouncement = spoken.find((utterance) => utterance.text.startsWith('rewalk.turnAnnounce|'));
    expect(turnAnnouncement).toBeTruthy();
    expect(turnAnnouncement!.text).toContain('rewalk.turnLeft');
    expect(turnAnnouncement!.text).not.toContain('{{');

    fix(0, 0.0032, 3000);
    expect(rewalk.turn?.id).toBe(id);
    expect(rewalk.turn?.isNew).toBe(false);
    expect(rewalk.announcedTurns.has(id!)).toBe(true);
    expect(spoken.filter((utterance) => utterance.text === 'rewalk.offAnnounce')).toHaveLength(0);

    fix(0.001, 0.004, 4000);
    expect(rewalk.turn).toBeNull();
  });

  it('orients turns and route bearings correctly on a reverse track', async () => {
    await begin([corner], 'full-rev');
    fix(0.004, 0.004, 1000);
    fix(0.002, 0.004, 2000);
    expect(rewalk.mode).toBe('full-rev');
    expect(rewalk.routeBearing).toBeCloseTo(180, 3);
    expect(rewalk.routeTurns).toHaveLength(1);
    expect(rewalk.maxAlong).toBeLessThan(300);
    expect(rewalk.routeTurns[0].alongM - rewalk.maxAlong).toBeLessThan(250);
    expect(rewalk.turn).toMatchObject({ direction: 'right', angleDeg: 90, isNew: true });
    expect(rewalk.turn?.distanceM).toBeGreaterThan(200);
    expect(rewalk.turn?.distanceM).toBeLessThan(240);
  });

  it('restores upcoming turn guidance after backtracking using current along-distance', async () => {
    await begin([[{ lat: 0, lon: 0 }, { lat: 0, lon: 0.0015 }, { lat: 0.0015, lon: 0.0015 }]]);
    fix(0, 0, 1000);
    const id = rewalk.turn?.id;
    expect(id).toBeTruthy();
    fix(0, 0.0009, 2000);
    expect(rewalk.turn?.id).toBe(id);

    fix(0, 0.0015, 3000);
    expect(rewalk.turn).toBeNull();
    const maxAlong = rewalk.maxAlong;
    const maxIdx = rewalk.maxIdx;

    fix(0, 0.00018, 4000);
    const along = rewalk.along;
    expect(along).toBeLessThan(maxAlong);
    expect(rewalk.maxAlong).toBe(maxAlong);
    expect(rewalk.maxIdx).toBe(maxIdx);
    expect(rewalk.idx).toBe(0);
    expect(rewalk.turn).toMatchObject({ id, direction: 'left', angleDeg: 90, isNew: false });
    expect(rewalk.turn?.distanceM).toBeCloseTo(rewalk.routeTurns[0].alongM - along, 6);
    expect(lastFixEvent().turn?.distanceM).toBeCloseTo(rewalk.turn?.distanceM, 6);
  });
});

describe('re-walk sustained off-route state', () => {
  const route = [[{ lat: 0, lon: 0 }, { lat: 0, lon: 0.01 }]];

  it('caps GPS dt, applies hysteresis, and announces only after ten seconds', async () => {
    await begin(route);
    fix(0, 0, 1000);
    fix(0.001, 0, 2000);
    expect(rewalk.offRoute).toBe(true);
    expect(rewalk.offRouteForMs).toBe(0);

    fix(0.001, 0, 7000);
    expect(rewalk.offRouteForMs).toBe(5000);
    expect(lastFixEvent().offRouteAnnounce).toBe(false);

    fix(0.001, 0, 12_000);
    expect(rewalk.offRouteForMs).toBe(10_000);
    expect(lastFixEvent().offRouteAnnounce).toBe(true);
    expect(spoken.filter((utterance) => utterance.text === 'rewalk.offAnnounce')).toHaveLength(1);

    fix(0.001, 0, 13_000);
    expect(spoken.filter((utterance) => utterance.text === 'rewalk.offAnnounce')).toHaveLength(1);

    fix(0.0005, 0, 14_000); // >45m and <=60m: remain off route
    expect(rewalk.offRoute).toBe(true);
    fix(0.0004, 0, 15_000); // <=45m: exit
    expect(rewalk.offRoute).toBe(false);
    expect(rewalk.offRouteForMs).toBe(0);
    fix(0.0005, 0, 16_000); // >45m and <=60m: stay on route
    expect(rewalk.offRoute).toBe(false);
    fix(0.0006, 0, 17_000); // >60m: enter again
    expect(rewalk.offRoute).toBe(true);
    expect(rewalk.offRouteForMs).toBe(0);
  });

  it('ignores stale/out-of-order fixes but accepts equal timestamps with zero dt', async () => {
    await begin(route);
    fix(0, 0, 10_000);
    fix(0.001, 0, 11_000);
    fix(0.0012, 0, 12_000);
    const before = { ...rewalk.lastFix };
    const emissions = mocks.emit.mock.calls.length;

    fix(0, 0, 11_500);
    expect(rewalk.lastFix).toEqual(before);
    expect(rewalk.offRouteForMs).toBe(1000);
    expect(mocks.emit).toHaveBeenCalledTimes(emissions);

    fix(0.0012, 0, 12_000);
    expect(rewalk.lastFix?.t).toBe(12_000);
    expect(rewalk.offRouteForMs).toBe(1000);
  });

  it('passes geolocation speed and timestamp through the existing watch contract', async () => {
    await begin(route);
    const callback = vi.mocked(navigator.geolocation.watchPosition).mock.calls[0][0] as any;
    callback({
      coords: { latitude: 0, longitude: 0, accuracy: 5, heading: 90, speed: 1.5 },
      timestamp: 1234
    });
    expect(rewalk.lastFix).toMatchObject({ lat: 0, lon: 0, speed: 1.5, t: 1234, heading: 90 });
    expect(rewalk.etaSource).toBe('gps');
  });
});
