import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const db: any = {
    trackChunks: { where: vi.fn(), get: vi.fn(), put: vi.fn() },
    segments: { get: vi.fn(), where: vi.fn() },
    trips: {},
    transaction: vi.fn()
  };
  return {
    db,
    elevCacheGet: vi.fn(),
    elevCachePut: vi.fn(),
    updateTrip: vi.fn(),
    emit: vi.fn()
  };
});

vi.mock('../src/core/store', () => ({
  db: mocks.db,
  elevCacheGet: mocks.elevCacheGet,
  elevCachePut: mocks.elevCachePut,
  updateTrip: mocks.updateTrip,
  gridKey: (lat: number, lon: number) => `${lat.toFixed(3)},${lon.toFixed(3)}`
}));
vi.mock('../src/core/providers', () => ({
  elevationEndpoint: () => 'https://elevation.test',
  isServiceOffline: () => false
}));
vi.mock('../src/core/settings', () => ({ get: vi.fn() }));
vi.mock('../src/core/events', () => ({ emit: mocks.emit }));

import { backfillTripAltitudes, patchFlushedAltitude } from '../src/core/elevation';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function mockChunkScan(chunks: any[]) {
  const toArray = vi.fn(async () => chunks);
  const first = vi.fn(async ([segmentId, minSeq]: [string, number]) => [...chunks]
    .filter((chunk) => chunk.segmentId === segmentId && chunk.seq >= minSeq)
    .sort((a, b) => a.seq - b.seq)[0]);
  mocks.db.trackChunks.where.mockImplementation((index: string) => index === '[segmentId+seq]'
    ? { between: (lower: [string, number]) => ({ first: () => first(lower) }) }
    : { equals: () => ({ toArray }) });
  return toArray;
}

function mockReverseChunks(chunks: any[], onVisit?: (chunk: any) => void) {
  mocks.db.trackChunks.where.mockReturnValue({
    between: () => ({
      reverse: () => ({
        limit: (count: number) => ({
          toArray: async () => {
            const limited = [...chunks].reverse().slice(0, count);
            if (onVisit) limited.forEach(onVisit);
            return limited;
          }
        })
      })
    })
  });
}

const original = { lat: 30, lon: 120, t: 1000, alt: null, altSrc: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('navigator', { onLine: true });
  mocks.db.transaction.mockImplementation(async (_mode, _tables, write) => write());
  mocks.db.trackChunks.put.mockResolvedValue(undefined);
  mocks.db.segments.where.mockReturnValue({
    equals: () => ({ sortBy: async () => [{ id: 'seg-1', tripId: 'trip-1', index: 0 }] })
  });
  mocks.elevCacheGet.mockResolvedValue(null);
  mocks.elevCachePut.mockResolvedValue(undefined);
  mocks.updateTrip.mockResolvedValue(undefined);
});

afterEach(() => vi.unstubAllGlobals());

describe('altitude backfill concurrency', () => {
  it('does not write altitude caches or report progress when aborted before the cache write', async () => {
    const controller = new AbortController();
    const onProgress = vi.fn();
    let fetchSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      fetchSignal = init.signal as AbortSignal;
      return Promise.resolve({
        ok: true,
        json: async () => {
          controller.abort();
          return { elevation: [123] };
        }
      });
    });
    vi.stubGlobal('fetch', fetch);
    const chunk = { id: 'chunk-1', tripId: 'trip-1', segmentId: 'seg-1', seq: 0, points: [original] };
    mockChunkScan([chunk]);
    mocks.db.trackChunks.get.mockResolvedValue(chunk);

    await expect(backfillTripAltitudes('trip-1', {
      signal: controller.signal,
      onProgress
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(fetchSignal?.aborted).toBe(true);
    expect(mocks.elevCachePut).not.toHaveBeenCalled();
    expect(mocks.db.trackChunks.put).not.toHaveBeenCalled();
    expect(mocks.updateTrip).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalledWith('elev:backfilled', expect.anything());
  });

  it('does not resurrect a chunk replaced while the request was in flight', async () => {
    const response = deferred<any>();
    const fetch = vi.fn(() => response.promise);
    vi.stubGlobal('fetch', fetch);
    mockChunkScan([{ id: 'chunk-1', tripId: 'trip-1', segmentId: 'seg-1', seq: 0, points: [original] }]);
    mocks.db.trackChunks.get.mockResolvedValue(undefined);

    const pending = backfillTripAltitudes('trip-1');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    response.resolve({ ok: true, json: async () => ({ elevation: [123] }) });

    await expect(pending).resolves.toBe(0);
    expect(mocks.db.trackChunks.put).not.toHaveBeenCalled();
    expect(mocks.updateTrip).not.toHaveBeenCalled();
  });

  it('merges into the current chunk without dropping appended points', async () => {
    const response = deferred<any>();
    const fetch = vi.fn(() => response.promise);
    vi.stubGlobal('fetch', fetch);
    const appended = { lat: 30.001, lon: 120.001, t: 2000, alt: null, altSrc: null };
    mockChunkScan([{ id: 'chunk-1', tripId: 'trip-1', segmentId: 'seg-1', seq: 0, points: [original] }]);
    mocks.db.trackChunks.get.mockResolvedValue({
      id: 'chunk-1', tripId: 'trip-1', segmentId: 'seg-1', seq: 0, points: [original, appended]
    });

    const pending = backfillTripAltitudes('trip-1');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    response.resolve({ ok: true, json: async () => ({ elevation: [123] }) });

    await expect(pending).resolves.toBe(1);
    expect(mocks.db.trackChunks.put).toHaveBeenCalledWith(expect.objectContaining({
      id: 'chunk-1',
      points: [
        { ...original, alt: 123, altSrc: 'svc' },
        appended
      ]
    }));
    expect(mocks.updateTrip).toHaveBeenCalledWith('trip-1', { statsCache: null });
    expect(original.alt).toBeNull();
  });

  it('skips a fix edited or filled while the request was in flight', async () => {
    const response = deferred<any>();
    const fetch = vi.fn(() => response.promise);
    vi.stubGlobal('fetch', fetch);
    mockChunkScan([{ id: 'chunk-1', tripId: 'trip-1', segmentId: 'seg-1', seq: 0, points: [original] }]);
    mocks.db.trackChunks.get.mockResolvedValue({
      id: 'chunk-1', tripId: 'trip-1', segmentId: 'seg-1', seq: 0,
      points: [{ ...original, lon: 121 }]
    });

    const pending = backfillTripAltitudes('trip-1');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    response.resolve({ ok: true, json: async () => ({ elevation: [123] }) });

    await expect(pending).resolves.toBe(0);
    expect(mocks.db.trackChunks.put).not.toHaveBeenCalled();
    expect(mocks.updateTrip).not.toHaveBeenCalled();
  });

  it('streams trip chunks instead of materializing the full track', async () => {
    const toArray = mockChunkScan([{
      id: 'chunk-1', tripId: 'trip-1', segmentId: 'seg-1', seq: 0,
      points: [{ ...original, alt: 100 }]
    }]);

    await expect(backfillTripAltitudes('trip-1')).resolves.toBe(0);
    expect(toArray).not.toHaveBeenCalled();
  });
});

describe('flushed altitude patches', () => {
  it('merges into the current chunk and preserves appended points', async () => {
    const appended = { lat: 30.001, lon: 120.001, t: 2000, alt: null, altSrc: null };
    const chunk = { id: 'chunk-1', tripId: 'trip-1', segmentId: 'seg-1', seq: 0, points: [original, appended] };
    mocks.db.segments.get.mockResolvedValue({ id: 'seg-1', tripId: 'trip-1' });
    mockReverseChunks([chunk]);

    await expect(patchFlushedAltitude('seg-1', { ...original, alt: 123, altSrc: 'svc' })).resolves.toBe(true);

    expect(mocks.db.transaction).toHaveBeenCalledWith('rw',
      [mocks.db.trackChunks, mocks.db.segments, mocks.db.trips], expect.any(Function));
    expect(mocks.db.trackChunks.put).toHaveBeenCalledWith({
      ...chunk,
      points: [{ ...original, alt: 123, altSrc: 'svc' }, appended]
    });
    expect(mocks.updateTrip).toHaveBeenCalledWith('trip-1', { statsCache: null });
    expect(original.alt).toBeNull();
  });

  it('does not overwrite an edited fix or a deleted segment', async () => {
    const chunk = {
      id: 'chunk-1', tripId: 'trip-1', segmentId: 'seg-1', seq: 0,
      points: [{ ...original, lon: 121 }]
    };
    mocks.db.segments.get.mockResolvedValue({ id: 'seg-1', tripId: 'trip-1' });
    mockReverseChunks([chunk]);

    await expect(patchFlushedAltitude('seg-1', { ...original, alt: 123, altSrc: 'svc' })).resolves.toBe(false);
    mocks.db.segments.get.mockResolvedValue(undefined);
    await expect(patchFlushedAltitude('seg-1', { ...original, alt: 123, altSrc: 'svc' })).resolves.toBe(false);

    expect(mocks.db.trackChunks.put).not.toHaveBeenCalled();
    expect(mocks.updateTrip).not.toHaveBeenCalled();
  });

  it('bounds late-altitude lookup to the most recent 32 chunks', async () => {
    const chunks = Array.from({ length: 40 }, (_, seq) => ({
      id: `chunk-${seq}`, tripId: 'trip-1', segmentId: 'seg-1', seq,
      points: [{ ...original, t: 1000 + seq * 1000 }]
    }));
    let visited = 0;
    mocks.db.segments.get.mockResolvedValue({ id: 'seg-1', tripId: 'trip-1' });
    mockReverseChunks(chunks, () => { visited++; });

    await expect(patchFlushedAltitude('seg-1', { ...original, alt: 123, altSrc: 'svc' })).resolves.toBe(false);
    expect(mocks.db.trackChunks.where).toHaveBeenCalledWith('[segmentId+seq]');
    expect(visited).toBe(32);
    expect(mocks.db.trackChunks.put).not.toHaveBeenCalled();
  });
});
