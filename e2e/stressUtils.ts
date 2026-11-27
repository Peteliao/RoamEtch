import { expect, type CDPSession, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const STRESS_PORT = 5202;
export const STRESS_BASE_TIME = Date.UTC(2026, 0, 3, 8);
export const STRESS_TRACK_NAME = '确定性大数据压力轨迹';
export const STRESS_CHUNK_SIZE = 400;
export const FIXTURE_NAMES = ['压力固定行程甲', '压力固定行程乙', '压力固定行程丙'];
export const EVIDENCE_LIMITS = [
  'Synthetic GPX, mocked geolocation, and Playwright fake-clock coverage only; this is not a real 4–8 hour soak.',
  'Desktop Chromium with a mobile viewport only; this is not iOS/Safari, physical-device memory, crash, or battery evidence.',
  'Remote tiles, geocoding, and elevation traffic are blocked; weak-network and carrier behavior are not exercised in the full-chain or lifecycle scenarios.',
  'The separate cold-start scenario uses Chromium CDP throughput, latency, and packet-loss shaping plus offline/online switching; this is browser-level shaping, not radio or carrier evidence.',
  'CDP heap values are sampled renderer JS heap, not total browser process memory or worker-combined memory.',
  'GPX parsing and small-track serialization remain main-thread work; large-track map simplification and GPX serialization use compute.worker with a main-thread fallback. Large worker payloads use transferable columnar typed arrays; IndexedDB structured cloning remains on the main thread.',
  'The sanitized application diagnostic ring does not contain every recorder lifecycle event; segment/state evidence is captured in the attached test report.',
  'Three fixture trips are seeded and fingerprinted inside a disposable Playwright context; no persistent browser profile or eraseAll() is used.'
] as const;

export interface DeterministicPoint {
  lat: number;
  lon: number;
  alt: number;
  t: number;
}

const ROW_POINTS = 2_000;

export function deterministicPointAt(index: number): DeterministicPoint {
  const row = Math.floor(index / ROW_POINTS);
  const lane = index % ROW_POINTS;
  const x = row % 2 === 0 ? lane : ROW_POINTS - 1 - lane;
  return {
    lat: Number((30 + row * 0.00001).toFixed(7)),
    lon: Number((120 + x * 0.00001).toFixed(7)),
    alt: 100,
    t: STRESS_BASE_TIME + index * 1_000
  };
}

function haversine(a: DeterministicPoint, b: DeterministicPoint) {
  const rad = (degrees: number) => degrees * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function expectedTrackDistance(pointCount: number) {
  let distance = 0;
  for (let index = 1; index < pointCount; index++) {
    distance += haversine(deterministicPointAt(index - 1), deterministicPointAt(index));
  }
  return distance;
}

/** Generate bounded batches so Node does not retain a million-element string array. */
export function buildDeterministicGpx(pointCount: number) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="RoamEtch-stress" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${STRESS_TRACK_NAME}</name><time>${new Date(STRESS_BASE_TIME).toISOString()}</time></metadata>`,
    '  <trk><name>确定性大数据压力轨迹</name><trkseg>'
  ];
  const chunks: Buffer[] = [Buffer.from(lines.join('\n') + '\n', 'utf8')];
  for (let offset = 0; offset < pointCount; offset += 4_000) {
    const batch: string[] = [];
    const end = Math.min(pointCount, offset + 4_000);
    for (let index = offset; index < end; index++) {
      const point = deterministicPointAt(index);
      batch.push(`    <trkpt lat="${point.lat.toFixed(7)}" lon="${point.lon.toFixed(7)}"><ele>${point.alt}</ele><time>${new Date(point.t).toISOString()}</time></trkpt>`);
    }
    chunks.push(Buffer.from(batch.join('\n') + '\n', 'utf8'));
  }
  chunks.push(Buffer.from('  </trkseg></trk>\n</gpx>\n', 'utf8'));
  return Buffer.concat(chunks);
}

export function writeDeterministicGpx(filePath: string, pointCount: number) {
  const bytes = buildDeterministicGpx(pointCount);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, bytes);
  return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function parseTrackPointBlock(block: Buffer) {
  const text = block.toString('utf8');
  const number = (name: string) => Number(text.match(new RegExp(`${name}="([^"]+)"`))?.[1]);
  return {
    lat: number('lat'),
    lon: number('lon'),
    alt: Number(text.match(/<ele>([^<]+)<\/ele>/)?.[1]),
    t: Date.parse(text.match(/<time>([^<]+)<\/time>/)?.[1] || '')
  };
}

/** Stream-count exported trkpt elements and compare first/middle/last with the deterministic source. */
export function summarizeExportedGpx(filePath: string, pointCount: number, trackName = STRESS_TRACK_NAME) {
  const bytes = readFileSync(filePath);
  const marker = Buffer.from('<trkpt ', 'utf8');
  const closing = Buffer.from('</trkpt>', 'utf8');
  const wanted = new Map<number, ReturnType<typeof parseTrackPointBlock>>([[0, null as any], [Math.floor(pointCount / 2), null as any], [pointCount - 1, null as any]]);
  let count = 0;
  let offset = 0;
  for (;;) {
    const start = bytes.indexOf(marker, offset);
    if (start < 0) break;
    if (wanted.has(count)) {
      const end = bytes.indexOf(closing, start);
      wanted.set(count, parseTrackPointBlock(bytes.subarray(start, end + closing.length)));
    }
    count++;
    offset = start + marker.length;
  }
  const segmentMarker = Buffer.from('<trkseg>', 'utf8');
  let segments = 0;
  offset = 0;
  for (;;) {
    const found = bytes.indexOf(segmentMarker, offset);
    if (found < 0) break;
    segments++;
    offset = found + segmentMarker.length;
  }
  const samples = [...wanted.entries()].map(([index, point]) => ({ index, point, expected: deterministicPointAt(index) }));
  return {
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    pointCount: count,
    segments,
    containsTrackName: bytes.includes(Buffer.from(`<name>${trackName}</name>`, 'utf8')),
    samples
  };
}

export async function ready(page: Page, timeoutMs = 45_000) {
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt)), { timeout: timeoutMs }).toBe(true);
}

/** Only the local production-preview origin is allowed; third-party latency cannot skew budgets. */
export async function blockStressRemote(page: Page) {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'data:' || url.protocol === 'blob:' || (url.hostname === '127.0.0.1' && url.port === String(STRESS_PORT))) {
      return route.continue();
    }
    return route.abort();
  });
}

/**
 * Test-side instrumentation proves that compute.worker actually replied. The bridge
 * can otherwise hide a timeout/error behind its synchronous main-thread fallback.
 */
export async function installStressProbes(page: Page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const workerState = { workers: [] as any[], errors: [] as any[] };
    (window as any).__stressWorkerProbe = workerState;
    const pointCount = (message: any) => {
      if (Array.isArray(message?.payload?.segments)) {
        return message.payload.segments.reduce((sum: number, segment: any) => sum + (segment.points?.length || 0), 0);
      }
      if (Array.isArray(message?.payload?.full?.segments)) {
        return message.payload.full.segments.reduce((sum: number, segment: any) => sum + (segment.points?.length || 0), 0);
      }
      return message?.payload?.points?.length ?? null;
    };
    class ProbeWorker extends NativeWorker {
      record: any;
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        this.record = { index: workerState.workers.length, url: String(scriptURL), sent: [], responses: [], terminated: false, terminatedAt: null };
        workerState.workers.push(this.record);
        this.addEventListener('message', (event) => {
          const data = event.data || {};
          const result = data.result || {};
          this.record.responses.push({
            id: data.id,
            ok: data.ok,
            error: data.error || null,
            at: performance.now(),
            pointCount: result.pointCount ?? null,
            segCount: result.segCount ?? null,
            duration: result.duration ?? null,
            distance: result.distance ?? null,
            seriesLengths: result.series ? Object.fromEntries(Object.entries(result.series).map(([key, value]) => [key, (value as any[]).length])) : null
          });
        });
        this.addEventListener('error', (event) => workerState.errors.push({ index: this.record.index, message: event.message }));
        this.addEventListener('messageerror', () => workerState.errors.push({ index: this.record.index, message: 'messageerror' }));
      }
      postMessage(message: any, transferList?: Transferable[]) {
        this.record.sent.push({ id: message?.id, type: message?.type, pointCount: message?.pointCount ?? pointCount(message), at: performance.now() });
        return transferList ? super.postMessage(message, transferList) : super.postMessage(message);
      }
      terminate() {
        this.record.terminated = true;
        this.record.terminatedAt = performance.now();
        return super.terminate();
      }
    }
    window.Worker = ProbeWorker as any;

    const perfState = {
      longTasks: [] as any[],
      maxFrameGap: 0,
      frames: 0,
      lastFrame: performance.now(),
      startedAt: performance.now()
    };
    (window as any).__stressPerfProbe = perfState;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        perfState.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
    const frame = (now: number) => {
      perfState.frames++;
      perfState.maxFrameGap = Math.max(perfState.maxFrameGap, now - perfState.lastFrame);
      perfState.lastFrame = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

export async function resetPerfProbe(page: Page) {
  await page.evaluate(() => {
    const state = (window as any).__stressPerfProbe;
    state.longTasks = [];
    state.maxFrameGap = 0;
    state.frames = 0;
    state.startedAt = performance.now();
    state.lastFrame = performance.now();
  });
}

export async function readPerfProbe(page: Page) {
  return page.evaluate(() => {
    const state = (window as any).__stressPerfProbe;
    const durations = state.longTasks.map((task: any) => task.duration).sort((a: number, b: number) => b - a);
    return {
      observedMs: performance.now() - state.startedAt,
      frames: state.frames,
      maxFrameGapMs: state.maxFrameGap,
      longTaskCount: durations.length,
      longTasksOver50Ms: durations.filter((duration: number) => duration > 50).length,
      longTasksOver1s: durations.filter((duration: number) => duration > 1_000).length,
      longestLongTaskMs: durations[0] || 0,
      p95LongTaskMs: durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.05))] || 0,
      topLongTasks: state.longTasks.slice().sort((a: any, b: any) => b.duration - a.duration).slice(0, 10)
    };
  });
}

export async function readWorkerProbe(page: Page) {
  return page.evaluate(() => (window as any).__stressWorkerProbe);
}

export async function waitForFullWorkerStats(page: Page, points: number) {
  await expect.poll(async () => {
    const probe = await readWorkerProbe(page);
    return probe.workers.some((worker: any) => worker.sent.some((task: any) =>
      task.type === 'stats' && task.pointCount === points
      && worker.responses.some((response: any) => response.id === task.id && response.ok && response.pointCount === points)));
  }, { timeout: 45_000, message: `compute.worker must return a full ${points}-point stats result` }).toBe(true);
  return readWorkerProbe(page);
}

export function findCompletedWorkerTask(probe: any, type: string, points: number) {
  for (const worker of probe.workers) {
    for (const task of worker.sent) {
      if (task.type !== type || task.pointCount !== points) continue;
      const response = worker.responses.find((item: any) => item.id === task.id);
      if (response?.ok) {
        return { id: task.id, type, pointCount: points, durationMs: response.at - task.at, responseAt: response.at };
      }
    }
  }
  return null;
}

export function assertFullWorkerStats(probe: any, points: number) {
  const allTasks = probe.workers.flatMap((worker: any) => worker.sent
    .filter((task: any) => task.type === 'stats' && task.pointCount === points)
    .map((task: any) => ({ worker, task, response: worker.responses.find((response: any) => response.id === task.id) })));
  const tasks = allTasks.filter(({ response }: any) => response?.ok && response.pointCount === points);
  expect(tasks.length, 'at least one full stats task must complete in compute.worker, not the main-thread fallback').toBeGreaterThan(0);
  for (const { worker, task, response } of tasks) {
    expect(response.segCount).toBe(1);
    if (worker.terminated) {
      expect(worker.terminatedAt, `Worker ${worker.index} may be terminated by a later abort, but not before full stats replied; ${JSON.stringify({ task, response, sent: worker.sent, responses: worker.responses, errors: probe.errors })}`).toBeGreaterThanOrEqual(response.at);
    }
    expect(response.at - task.at, `Worker task ${task.id} duration`).toBeLessThanOrEqual(16_000);
    expect(response.seriesLengths).toEqual({ d: points, alt: points, rawAlt: points, speed: points, slope: points, t: points });
  }
  expect(probe.errors).toEqual([]);
  return {
    dispatchedFullStatsTasks: allTasks.length,
    verifiedWorkerTasks: tasks.map(({ task, response }: any) => ({ id: task.id, durationMs: response.at - task.at, distance: response.distance, duration: response.duration })),
    unresolvedOrFallbackFullStatsTasks: allTasks.length - tasks.length
  };
}

export interface StressMetrics {
  JSHeapUsedSize: number;
  JSHeapTotalSize: number;
  TaskDuration: number;
  ScriptDuration: number;
  Nodes: number;
}

const METRIC_NAMES: (keyof StressMetrics)[] = ['JSHeapUsedSize', 'JSHeapTotalSize', 'TaskDuration', 'ScriptDuration', 'Nodes'];

export async function openStressCdp(page: Page): Promise<CDPSession> {
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  await session.send('HeapProfiler.enable');
  return session;
}

export async function readStressMetrics(session: CDPSession): Promise<StressMetrics> {
  const { metrics } = await session.send('Performance.getMetrics');
  const result = {} as StressMetrics;
  for (const name of METRIC_NAMES) {
    const value = metrics.find((metric) => metric.name === name)?.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`CDP metric missing: ${name}`);
    result[name] = value;
  }
  return result;
}

export async function sampleStressMetrics(session: CDPSession, baseline: StressMetrics) {
  let peak = { ...baseline };
  let samples = 1;
  const pending = new Set<Promise<void>>();
  const timer = setInterval(() => {
    const request = readStressMetrics(session).then((value) => {
      samples++;
      for (const name of METRIC_NAMES) peak[name] = Math.max(peak[name], value[name]);
    }).catch(() => { /* A final synchronous read surfaces protocol failures. */ })
      .finally(() => { pending.delete(request); });
    pending.add(request);
  }, 75);
  return {
    stop: async () => {
      clearInterval(timer);
      await Promise.all(pending);
      return { peak, samples };
    }
  };
}

export async function seedThreeFixtureTrips(page: Page) {
  const ids = await page.evaluate(async ({ names, baseTime }) => {
    const store = (window as any).__lt.store;
    const created: string[] = [];
    for (let index = 0; index < names.length; index++) {
      const start = baseTime + index * 10_000;
      const trip = await store.createTrip({
        name: names[index], activity: 'hike', status: 'finished', createdAt: start
      });
      const segment = await store.addSegment(trip.id, start);
      await store.appendPoints(segment.id, trip.id, [
        { lat: 31 + index * 0.01, lon: 121 + index * 0.01, alt: 40 + index, t: start, acc: 5 },
        { lat: 31.001 + index * 0.01, lon: 121.001 + index * 0.01, alt: 41 + index, t: start + 60_000, acc: 5 }
      ]);
      await store.addWaypoint({ tripId: trip.id, name: `固定节点${index + 1}`, lat: 31.0005 + index * 0.01, lon: 121.0005 + index * 0.01, t: start + 30_000 });
      await store.updateTrip(trip.id, {
        tags: ['固定', `fixture-${index + 1}`], favorite: true,
        privacy: { radius: 100 + index, hideSensitive: false },
        customMetadata: { fixture: index + 1 }
      }, { touch: false });
      created.push(trip.id);
    }
    return created;
  }, { names: FIXTURE_NAMES, baseTime: STRESS_BASE_TIME - 86_400_000 });
  return { ids, fingerprint: await fingerprintFixtureTrips(page, ids) };
}

export async function fingerprintFixtureTrips(page: Page, ids: string[]) {
  return page.evaluate(async (fixtureIds) => {
    const store = (window as any).__lt.store;
    const rows = [];
    for (const id of fixtureIds) {
      const [trip, segments, chunks, waypoints] = await Promise.all([
        store.getTrip(id),
        store.db.segments.where('tripId').equals(id).toArray(),
        store.db.trackChunks.where('tripId').equals(id).toArray(),
        store.db.waypoints.where('tripId').equals(id).toArray()
      ]);
      // thumbPoints is a derived preview cache populated lazily by the trip list;
      // preservation covers the authored row, raw chunks, segments, and waypoints.
      const { thumbPoints: _thumbPoints, ...fixtureTrip } = trip;
      rows.push({ trip: fixtureTrip, segments, chunks, waypoints });
    }
    return rows;
  }, ids);
}

export async function readTripStorageSummary(page: Page, tripId: string) {
  return page.evaluate(async (id) => {
    const db = (window as any).__lt.store.db;
    const segments = await db.segments.where('tripId').equals(id).sortBy('index');
    const segmentRows = [];
    for (const segment of segments) {
      const sequence = new Set<number>();
      let chunkCount = 0;
      let pointCount = 0;
      let minChunkPoints = Infinity;
      let maxChunkPoints = 0;
      let firstPoint = null;
      let lastPoint = null;
      for (let offset = 0; ; offset += 16) {
        const chunks = await db.trackChunks.where('[segmentId+seq]').between([segment.id, 0], [segment.id, Number.MAX_SAFE_INTEGER]).offset(offset).limit(16).toArray();
        for (const chunk of chunks) {
          chunkCount++;
          sequence.add(chunk.seq);
          const points = chunk.points || [];
          pointCount += points.length;
          minChunkPoints = Math.min(minChunkPoints, points.length);
          maxChunkPoints = Math.max(maxChunkPoints, points.length);
          if (!firstPoint && points.length) firstPoint = points[0];
          if (points.length) lastPoint = points[points.length - 1];
        }
        if (chunks.length < 16) break;
      }
      segmentRows.push({
        id: segment.id, index: segment.index, startTime: segment.startTime, endTime: segment.endTime,
        chunkCount, pointCount, minChunkPoints, maxChunkPoints,
        contiguousSequence: sequence.size === chunkCount && Math.min(...sequence) === 0 && Math.max(...sequence) === chunkCount - 1,
        firstPoint: firstPoint && { lat: firstPoint.lat, lon: firstPoint.lon, alt: firstPoint.alt, t: firstPoint.t },
        lastPoint: lastPoint && { lat: lastPoint.lat, lon: lastPoint.lon, alt: lastPoint.alt, t: lastPoint.t }
      });
    }
    const trip = await (window as any).__lt.store.getTrip(id);
    return {
      trip: {
        id: trip.id, name: trip.name, activity: trip.activity, status: trip.status, tags: trip.tags,
        hasTime: trip.hasTime, updatedAt: trip.updatedAt,
        statsCache: trip.statsCache && {
          distance: trip.statsCache.distance, duration: trip.statsCache.duration,
          pointCount: trip.statsCache.pointCount, segCount: trip.statsCache.segCount
        }
      },
      segmentCount: segmentRows.length,
      chunkCount: segmentRows.reduce((sum, segment) => sum + segment.chunkCount, 0),
      pointCount: segmentRows.reduce((sum, segment) => sum + segment.pointCount, 0),
      segments: segmentRows
    };
  }, tripId);
}

export async function readRawChunkFingerprint(page: Page, tripId: string) {
  return page.evaluate(async (id) => {
    const rows = [];
    for (let offset = 0; ; offset += 16) {
      const chunks = await (window as any).__lt.store.db.trackChunks.where('tripId').equals(id).offset(offset).limit(16).toArray();
      for (const chunk of chunks) {
        rows.push({
          id: chunk.id, segmentId: chunk.segmentId, seq: chunk.seq, count: chunk.points.length,
          firstT: chunk.points[0]?.t, lastT: chunk.points[chunk.points.length - 1]?.t,
          firstLat: chunk.points[0]?.lat, firstLon: chunk.points[0]?.lon,
          lastLat: chunk.points[chunk.points.length - 1]?.lat, lastLon: chunk.points[chunk.points.length - 1]?.lon
        });
      }
      if (chunks.length < 16) break;
    }
    return rows.sort((a: any, b: any) => a.segmentId.localeCompare(b.segmentId) || a.seq - b.seq);
  }, tripId);
}

export async function readRecordMapSummary(page: Page) {
  return page.evaluate(() => {
    const map = (window as any).__lt.shell.getViews().record.getMap();
    const source = map.map.getSource('track');
    const serialized = source.serialize();
    const features = serialized.data.features || [];
    const coordinates = features[0]?.geometry?.coordinates || [];
    let indexEntries = 0;
    for (const index of map._indexMaps.values()) indexEntries += index.size;
    return {
      rawPointCount: map.segments.reduce((sum: number, segment: any) => sum + segment.points.length, 0),
      rawSegmentCount: map.segments.length,
      indexEntries,
      renderedFeatureCount: features.length,
      renderedCoordinateCount: coordinates.length,
      renderedFirst: coordinates[0] || null,
      renderedLast: coordinates[coordinates.length - 1] || null,
      mapLoaded: map.map.loaded()
    };
  });
}

export async function readBoundedPreview(page: Page, tripId: string) {
  return page.evaluate(async (id) => {
    const preview = await (window as any).__lt.store.loadTripPreview(id);
    return {
      points: preview.segments.reduce((sum: number, segment: any) => sum + segment.points.length, 0),
      readOnly: preview.readOnly,
      segments: preview.segments.length
    };
  }, tripId);
}

export async function installSyntheticGeolocation(page: Page) {
  await page.addInitScript(() => {
    const callbacks = new Map<number, any>();
    const state = { nextId: 1, watchCalls: 0, currentCalls: 0, clearCalls: 0, emits: 0, options: [] as any[] };
    const geolocation = {
      watchPosition(success: any, _error: any, options: any) {
        const id = state.nextId++;
        callbacks.set(id, success);
        state.watchCalls++;
        state.options.push(options);
        return id;
      },
      clearWatch(id: number) {
        callbacks.delete(id);
        state.clearCalls++;
      },
      getCurrentPosition(_success: any, _error: any, options: any) {
        state.currentCalls++;
        state.options.push(options);
      }
    };
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: geolocation });
    (window as any).__stressGeo = {
      get watchCalls() { return state.watchCalls; },
      get currentCalls() { return state.currentCalls; },
      get clearCalls() { return state.clearCalls; },
      get emits() { return state.emits; },
      emit(timestamp: number, index: number) {
        state.emits++;
        const position = {
          timestamp,
          coords: {
            latitude: 30,
            longitude: 120 + index * 0.00045,
            accuracy: 5,
            altitude: 100,
            altitudeAccuracy: 5,
            speed: 0.8,
            heading: 90
          }
        };
        for (const callback of callbacks.values()) callback(position);
      }
    };
  });
}

export async function emitSyntheticFix(page: Page, index: number) {
  const timestamp = await page.evaluate((fixIndex) => {
    const t = Date.now();
    (window as any).__stressGeo.emit(t, fixIndex);
    return t;
  }, index);
  await expect.poll(() => page.evaluate(() => (window as any).__lt.recorder.rec.lastFixT), { timeout: 10_000 }).toBe(timestamp);
  return timestamp;
}

export async function setSyntheticVisibility(page: Page, visibilityState: 'hidden' | 'visible') {
  await page.evaluate((state) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  }, visibilityState);
}

/** Fault-inject one blocked chunk write so a real pagehide spill survives document destruction. */
export async function blockNextChunkWriteAndSpill(page: Page, nextIndex: number) {
  return page.evaluate(async ({ fixIndex }) => {
    const db = (window as any).__lt.store.db;
    const recorder = (window as any).__lt.recorder;
    const tripId = recorder.rec.tripId;
    const initialPointCount = recorder.rec.live.pointCount;
    const firstFixTimestamp = Math.max(Date.now(), recorder.rec.lastFixT) + 60_000;
    const persisted = await db.trackChunks.where('tripId').equals(tripId).toArray();
    const persistedPoints = persisted.reduce((sum: number, chunk: any) => sum + chunk.points.length, 0);
    const persistedSegments = [...new Set(persisted.map((chunk: any) => chunk.segmentId))].length;
    let release: () => void;
    let blockedWrites = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    (window as any).__stressReleaseChunkWrite = release;
    // Dexie hooks cover both put(update) and add(create), including writes issued
    // through transaction-bound table methods in the production store.
    const blockChunkWrite = () => {
      blockedWrites++;
      return gate;
    };
    db.trackChunks.hook('creating', blockChunkWrite);
    db.trackChunks.hook('updating', blockChunkWrite);
    try {
      const yieldTask = () => new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
        channel.port2.postMessage(0);
      });
      const waitFor = async (predicate: () => boolean, label: string) => {
        for (let attempt = 0; attempt < 500; attempt++) {
          if (predicate()) return;
          await yieldTask();
        }
        throw new Error(`timed out waiting for ${label}; pending=${recorder.rec.saveState.pending}, blockedWrites=${blockedWrites}`);
      };
      const fixStates = [];
      for (let offset = 0; offset < 3; offset++) {
        // Keep implied speed consistent with the mocked 0.8 m/s fix so the
        // production jump gate accepts these fault-injection points.
        const timestamp = firstFixTimestamp + offset * 60_000;
        (window as any).__stressGeo.emit(timestamp, fixIndex + offset);
        // The Playwright clock is paused here, so wait on real tasks and then
        // invoke the production flush explicitly instead of advancing its timer.
        await waitFor(() => recorder.rec.lastFixT === timestamp && recorder.rec.saveState.pending === offset + 1,
          `fix ${offset + 1} to enter the pending buffer`);
        if (offset === 0) {
          void recorder.flushBuffer();
          await waitFor(() => blockedWrites === 1, 'the first gated chunk write');
        }
        fixStates.push({
          timestamp,
          lastFixT: recorder.rec.lastFixT,
          pointCount: recorder.rec.live.pointCount,
          pending: recorder.rec.saveState.pending,
          persistedPoints,
          persistedSegments,
          segmentId: recorder.rec.segmentId,
          blockedWrites
        });
      }
      const pending = recorder.rec.saveState.pending;
      if (recorder.rec.live.pointCount !== initialPointCount + 3 || pending !== 3 || blockedWrites !== 1) throw new Error(`expected one gated write with 3 buffered fixes before pagehide, got pending=${pending}, blockedWrites=${blockedWrites}; ${JSON.stringify({ fixStates, live: recorder.rec.live, saveState: recorder.rec.saveState, status: recorder.rec.status, filteredCount: recorder.rec.filteredCount })}`);
      window.dispatchEvent(new Event('pagehide'));
      const spill = JSON.parse(localStorage.getItem('roametch.pendingPoints.v1') || 'null');
      if (!spill || spill.points.length !== 3) throw new Error('pagehide did not persist exactly three pending fixes');
      return {
        pending,
        blockedWrites,
        persistedPoints,
        persistedSegments,
        spillSavedAt: spill.savedAt,
        spillTimestamps: spill.points.map((point: any) => point.t),
        livePointCount: recorder.rec.live.pointCount
      };
    } finally {
      // The reload destroys this document. Keeping the gate installed until then is intentional.
    }
  }, { fixIndex: nextIndex });
}

export async function attachStressReport(testInfo: TestInfo, name: string, report: unknown) {
  const body = JSON.stringify(report, null, 2) + '\n';
  const directory = join(testInfo.project.outputDir, '..', 'reports');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${name}.json`);
  writeFileSync(path, body);
  await testInfo.attach(`${name}.json`, { body, contentType: 'application/json' });
  return path;
}
