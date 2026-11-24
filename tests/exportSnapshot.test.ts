// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload: any) => void>>();
  return {
    listeners,
    listTrips: vi.fn(),
    loadTripFull: vi.fn(),
    generatePoster: vi.fn(),
    generateTrackVideo: vi.fn(),
    on: vi.fn((event: string, fn: (payload: any) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return () => listeners.get(event)?.delete(fn);
    })
  };
});

vi.mock('../src/core/i18n', () => ({ t: (key: string, vars?: any) => vars?.s != null ? `${key} ${vars.s}` : key }));
vi.mock('../src/core/settings', () => ({
  get: (key: string) => ({ privacyRadius: 0, videoMusic: 'random' } as any)[key],
  set: vi.fn()
}));
vi.mock('../src/core/events', () => ({ on: mocks.on }));
vi.mock('../src/core/poster', () => ({ generatePoster: mocks.generatePoster }));
vi.mock('../src/core/gpx', () => ({ buildGPX: vi.fn(), buildGeoJSON: vi.fn(), buildKML: vi.fn() }));
vi.mock('../src/core/htmlExport', () => ({ buildSelfContainedHTML: vi.fn(), estimateHTMLSize: vi.fn(() => 1000) }));
vi.mock('../src/core/shareLink', () => ({ buildShareLink: vi.fn(() => ({ url: 'https://example.test/#t=test', size: 10 })) }));
vi.mock('../src/core/trackVideo', () => ({ generateTrackVideo: mocks.generateTrackVideo, videoSupported: () => true }));
vi.mock('../src/core/music', () => ({
  MUSIC_TRACKS: [],
  MUSIC_PREF_RANDOM: 'random',
  isMusicTrackId: () => false,
  musicSupported: () => false
}));
vi.mock('../src/core/videoCapture', () => ({ videoIsWebmOnly: () => false }));
vi.mock('../src/core/shareEnv', () => ({
  exportImage: vi.fn(),
  exportFile: vi.fn(),
  isWeChat: () => false,
  nativeShare: vi.fn()
}));
vi.mock('../src/core/store', () => ({ listTrips: mocks.listTrips, loadTripFull: mocks.loadTripFull }));
vi.mock('../src/core/mapPaint', () => ({ prepareMap: vi.fn() }));
vi.mock('../src/core/shareInfo', () => ({ routePlaceNames: vi.fn() }));
vi.mock('../src/core/brand', () => ({ loadBrandFonts: vi.fn() }));
vi.mock('../src/ui/state', () => ({ appState: { activeTripId: null } }));

import { createExportView } from '../src/ui/export';
import { buildGPX, buildGeoJSON, buildKML } from '../src/core/gpx';
import { buildSelfContainedHTML } from '../src/core/htmlExport';
import { buildShareLink } from '../src/core/shareLink';

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function makeFull(id: string, name: string, waypoints: any[] = []) {
  return {
    trip: { id, name, activity: 'hike', createdAt: 1_700_000_000_000, updatedAt: 1 },
    segments: [{
      id: `${id}-segment`,
      points: [
        { lat: 30, lon: 120, t: 1_700_000_000_000 },
        { lat: 30.001, lon: 120.001, t: 1_700_000_001_000 },
        { lat: 30.002, lon: 120.002, t: 1_700_000_002_000 }
      ]
    }],
    waypoints,
    media: []
  };
}

function emitActive(full: any) {
  for (const fn of mocks.listeners.get('trip:active') || []) fn(full);
}

function card(view: HTMLElement, title: string): HTMLElement {
  const found = [...view.querySelectorAll('.card')].find((node) => node.querySelector('h3')?.textContent === title) as HTMLElement | undefined;
  if (!found) throw new Error(`Missing card: ${title}`);
  return found;
}

async function mount(): Promise<{ view: HTMLElement }> {
  const exported = createExportView(() => null);
  document.body.append(exported.view);
  await vi.waitFor(() => expect(exported.view.querySelector('.card .small.muted')?.textContent).toContain('Initial trip'));
  return exported;
}

beforeEach(() => {
  document.body.innerHTML = '';
  mocks.listeners.clear();
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  URL.createObjectURL = vi.fn(() => 'blob:export-test');
  URL.revokeObjectURL = vi.fn();
  mocks.listTrips.mockResolvedValue([
    { id: 'a', name: 'Initial trip', createdAt: 1 },
    { id: 'b', name: 'Other trip', createdAt: 2 }
  ]);
  mocks.loadTripFull.mockResolvedValue(makeFull('a', 'Initial trip'));
  mocks.generatePoster.mockResolvedValue({ blob: new Blob(['poster']), usedVectorFallback: false });
  mocks.generateTrackVideo.mockResolvedValue({
    blob: new Blob(['video']),
    mime: 'video/webm',
    cover: '',
    musicTrack: null,
    usedVectorFallback: false
  });
  vi.mocked(buildSelfContainedHTML).mockResolvedValue({ html: '<html></html>', size: 13, places: [], photos: 0 });
});

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  document.body.innerHTML = '';
});

describe('export snapshots', () => {
  it('adopts a same-id active event and reloads the database snapshot before poster generation', async () => {
    const { view } = await mount();
    const updated = makeFull('a', 'Event snapshot', [
      { id: 'wp-event', name: 'Event node', desc: 'Event description', lat: 30.001, lon: 120.001, type: 'custom', hidden: false }
    ]);
    mocks.loadTripFull.mockClear();

    emitActive(updated);

    expect(mocks.loadTripFull).not.toHaveBeenCalled();
    expect(view.querySelector('.card .small.muted')?.textContent).toContain('Event snapshot');

    const latest = makeFull('a', 'Database snapshot', [
      { id: 'wp-latest', name: 'Latest node', desc: 'Latest description', lat: 30.001, lon: 120.001, type: 'custom', hidden: false, mediaIds: ['photo'] }
    ]);
    mocks.loadTripFull.mockResolvedValueOnce(latest);
    card(view, 'export.poster').querySelector<HTMLButtonElement>('.btn.primary')!.click();

    await vi.waitFor(() => expect(mocks.generatePoster).toHaveBeenCalledTimes(1));
    expect(mocks.loadTripFull).toHaveBeenCalledTimes(1);
    expect(mocks.loadTripFull).toHaveBeenCalledWith('a');
    expect(mocks.generatePoster.mock.calls[0][0]).toBe(latest);
    expect(mocks.generatePoster.mock.calls[0][1].privacy).toEqual({ radius: 0, hideSensitive: true });
  });

  it('does not let a pending old trip load overwrite a newer active event', async () => {
    const { view } = await mount();
    const oldLoad = deferred<any>();
    mocks.loadTripFull.mockReturnValueOnce(oldLoad.promise);
    const select = view.querySelector<HTMLSelectElement>('select')!;
    select.value = 'b';
    select.dispatchEvent(new Event('change'));

    const active = makeFull('a', 'Active A');
    emitActive(active);
    oldLoad.resolve(makeFull('b', 'Stale B'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(select.value).toBe('a');
    expect(view.querySelector('.card .small.muted')?.textContent).toContain('Active A');
  });

  it('passes the refreshed full trip and privacy options to video generation', async () => {
    const { view } = await mount();
    const latest = makeFull('a', 'Video snapshot', [
      { id: 'wp-video', name: 'Video node', desc: 'Video description', lat: 30.001, lon: 120.001, type: 'custom', hidden: false, mediaIds: ['photo'] }
    ]);
    mocks.loadTripFull.mockResolvedValueOnce(latest);
    card(view, 'export.video').querySelector<HTMLButtonElement>('.btn.primary')!.click();

    await vi.waitFor(() => expect(mocks.generateTrackVideo).toHaveBeenCalledTimes(1));
    expect(mocks.generateTrackVideo.mock.calls[0][0]).toBe(latest);
    expect(mocks.generateTrackVideo.mock.calls[0][1].privacy).toEqual({ radius: 0, hideSensitive: true });
    expect(mocks.generateTrackVideo.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    await vi.waitFor(() => expect(card(view, 'export.video').querySelector('video')!.style.display).toBe(''));
  });

  it('reloads fresh nodes for standard files and self-contained HTML', async () => {
    const { view } = await mount();
    const latest = makeFull('a', 'Fresh file snapshot', [
      { id: 'wp-file', name: 'Fresh file node', desc: 'Fresh description', lat: 30.001, lon: 120.001, type: 'custom', hidden: false }
    ]);
    mocks.loadTripFull.mockResolvedValue(latest);
    mocks.loadTripFull.mockClear();

    const files = card(view, 'common.export');
    const buttons = [...files.querySelectorAll<HTMLButtonElement>('.btn')];
    const builders = [buildGPX, buildGeoJSON, buildKML];
    for (let i = 0; i < buttons.length; i++) {
      buttons[i].click();
      await vi.waitFor(() => expect(builders[i]).toHaveBeenCalledTimes(1));
    }
    expect(mocks.loadTripFull).toHaveBeenCalledTimes(3);
    for (const build of builders) {
      expect(vi.mocked(build).mock.calls[0][0].waypoints[0].name).toBe('Fresh file node');
    }

    card(view, 'export.html').querySelector<HTMLButtonElement>('.btn')!.click();
    await vi.waitFor(() => expect(buildSelfContainedHTML).toHaveBeenCalledTimes(1));
    expect(mocks.loadTripFull).toHaveBeenCalledTimes(4);
    expect(vi.mocked(buildSelfContainedHTML).mock.calls[0][0].waypoints[0].name).toBe('Fresh file node');
  });

  it('rebuilds share links from the latest database snapshot', async () => {
    const { view } = await mount();
    const latest = makeFull('a', 'Fresh link snapshot', [
      { id: 'wp-link', name: 'Fresh link node', desc: 'Fresh description', lat: 30.001, lon: 120.001, type: 'custom', hidden: false }
    ]);
    mocks.loadTripFull.mockResolvedValueOnce(latest);
    vi.mocked(buildShareLink).mockClear();
    card(view, 'export.link').querySelector<HTMLButtonElement>('.btn')!.click();

    await vi.waitFor(() => expect(mocks.loadTripFull).toHaveBeenCalledWith('a'));
    await vi.waitFor(() => expect(buildShareLink).toHaveBeenCalled());
    expect(vi.mocked(buildShareLink).mock.calls.at(-1)![0].waypoints[0].name).toBe('Fresh link node');
  });

  it('can cancel while the pre-generation database reload is pending', async () => {
    const { view } = await mount();
    const pending = deferred<any>();
    mocks.loadTripFull.mockClear();
    mocks.loadTripFull.mockReturnValueOnce(pending.promise);
    const videoCard = card(view, 'export.video');
    const generate = videoCard.querySelector<HTMLButtonElement>('.btn.primary')!;
    const cancel = videoCard.querySelector<HTMLButtonElement>('button[aria-label="common.cancel"]')!;
    generate.click();

    await vi.waitFor(() => expect(mocks.loadTripFull).toHaveBeenCalledTimes(1));
    cancel.click();
    pending.resolve(makeFull('a', 'Late snapshot'));
    await vi.waitFor(() => expect(generate.disabled).toBe(false));

    expect(mocks.generateTrackVideo).not.toHaveBeenCalled();
    expect(cancel.style.display).toBe('none');
  });
});
