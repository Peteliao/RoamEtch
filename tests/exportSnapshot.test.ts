// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload: any) => void>>();
  return {
    listeners,
    state: {
      activeTripId: null as string | null,
      activeTripFull: null as any,
      view: 'export',
      tripDetail: { open: false, tripId: null as string | null, section: 'overview' }
    },
    setActiveTrip: vi.fn(),
    listTrips: vi.fn(),
    loadTripFull: vi.fn(),
    generatePoster: vi.fn(),
    generateTrackVideo: vi.fn(),
    prepareMap: vi.fn(),
    routePlaceNames: vi.fn(),
    loadBrandFonts: vi.fn(),
    exportFile: vi.fn(),
    toast: vi.fn(),
    modal: vi.fn(),
    clipboardWrite: vi.fn(),
    on: vi.fn((event: string, fn: (payload: any) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return () => listeners.get(event)?.delete(fn);
    })
  };
});

vi.mock('../src/core/i18n', () => ({
  t: (key: string, vars: Record<string, any> = {}) => {
    const values = Object.values(vars).map(String);
    return values.length ? `${key} ${values.join(' ')}` : key;
  },
  currentLang: () => 'zh'
}));
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
  exportFile: mocks.exportFile,
  isWeChat: () => false,
  nativeShare: vi.fn()
}));
vi.mock('../src/core/store', () => ({ listTrips: mocks.listTrips, loadTripFull: mocks.loadTripFull }));
vi.mock('../src/core/mapPaint', () => ({ prepareMap: mocks.prepareMap }));
vi.mock('../src/core/shareInfo', () => ({ routePlaceNames: mocks.routePlaceNames }));
vi.mock('../src/core/brand', () => ({ loadBrandFonts: mocks.loadBrandFonts }));
vi.mock('../src/ui/state', () => ({
  appState: mocks.state,
  setActiveTrip: mocks.setActiveTrip,
  isTripSectionActive: (section: string) => {
    const detail = mocks.state.tripDetail;
    return detail.open && detail.section === section
      && (mocks.state.view === 'trips' || mocks.state.view === 'analysis' || mocks.state.view === 'export');
  }
}));
vi.mock('../src/ui/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/helpers')>();
  return { ...actual, toast: mocks.toast, modal: mocks.modal };
});

import { createExportView } from '../src/ui/export';
import { buildGPX, buildGeoJSON, buildKML } from '../src/core/gpx';
import { buildSelfContainedHTML } from '../src/core/htmlExport';
import { buildShareLink } from '../src/core/shareLink';

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
let mounted: Array<{ destroy: () => void }> = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function makeFull(id: string, name: string, waypoints: any[] = [], updatedAt = 1) {
  return {
    trip: { id, name, activity: 'hike', createdAt: 1_700_000_000_000, updatedAt },
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

function videoResult() {
  return {
    blob: new Blob(['video']),
    mime: 'video/webm',
    cover: '',
    musicTrack: null,
    usedVectorFallback: false
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

async function mount() {
  const exported = createExportView(() => null);
  mounted.push(exported);
  document.body.append(exported.view);
  await vi.waitFor(() => expect(exported.view.querySelector('.card .small.muted')?.textContent).toContain('Initial trip'));
  return exported;
}

beforeEach(() => {
  document.body.innerHTML = '';
  mounted = [];
  mocks.listeners.clear();
  vi.clearAllMocks();
  mocks.state.activeTripId = null;
  mocks.state.activeTripFull = null;
  mocks.state.view = 'export';
  mocks.state.tripDetail = { open: false, tripId: null, section: 'overview' };
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: mocks.clipboardWrite }
  });
  mocks.clipboardWrite.mockResolvedValue(undefined);
  let objectUrlId = 0;
  URL.createObjectURL = vi.fn(() => `blob:export-${++objectUrlId}`);
  URL.revokeObjectURL = vi.fn();
  mocks.listTrips.mockResolvedValue([
    { id: 'a', name: 'Initial trip', createdAt: 1 },
    { id: 'b', name: 'Other trip', createdAt: 2 }
  ]);
  mocks.loadTripFull.mockResolvedValue(makeFull('a', 'Initial trip'));
  let selectionRequest = 0;
  mocks.setActiveTrip.mockImplementation(async (id: string | null) => {
    const request = ++selectionRequest;
    mocks.state.activeTripId = id;
    if (!id) {
      mocks.state.activeTripFull = null;
      emitActive(null);
      return null;
    }
    const full = await mocks.loadTripFull(id);
    if (request !== selectionRequest || mocks.state.activeTripId !== id) return null;
    mocks.state.activeTripFull = full;
    emitActive(full);
    return full;
  });
  mocks.generatePoster.mockResolvedValue({ blob: new Blob(['poster']), usedVectorFallback: false });
  mocks.generateTrackVideo.mockResolvedValue(videoResult());
  mocks.prepareMap.mockResolvedValue(undefined);
  mocks.routePlaceNames.mockResolvedValue([]);
  mocks.loadBrandFonts.mockResolvedValue(undefined);
  vi.mocked(buildGPX).mockReturnValue('<gpx/>');
  vi.mocked(buildGeoJSON).mockReturnValue({ type: 'FeatureCollection', name: 'Test trip', features: [] });
  vi.mocked(buildKML).mockReturnValue('<kml/>');
  vi.mocked(buildSelfContainedHTML).mockResolvedValue({ html: '<html></html>', size: 13, places: [], photos: 0 });
});

afterEach(() => {
  for (const exported of mounted) exported.destroy();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  document.body.innerHTML = '';
  vi.useRealTimers();
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
    expect(mocks.loadTripFull).toHaveBeenCalledWith('a', { trackSnapshot: mocks.state.activeTripFull });
    expect(mocks.generatePoster.mock.calls[0][0]).toBe(latest);
    expect(mocks.generatePoster.mock.calls[0][1].privacy).toEqual({ radius: 0, mode: 'all', offset: true, hideSensitive: true });
  });

  it('does not let a pending selector load overwrite a newer active event', async () => {
    const { view } = await mount();
    const oldLoad = deferred<any>();
    mocks.loadTripFull.mockReturnValueOnce(oldLoad.promise);
    const select = view.querySelector<HTMLSelectElement>('select')!;
    select.value = 'b';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(mocks.setActiveTrip).toHaveBeenCalledWith('b'));

    const active = makeFull('a', 'Active A');
    mocks.state.activeTripId = 'a';
    mocks.state.activeTripFull = active;
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
    expect(mocks.generateTrackVideo.mock.calls[0][1].privacy).toEqual({ radius: 0, mode: 'all', offset: true, hideSensitive: true });
    expect(mocks.generateTrackVideo.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    await vi.waitFor(() => expect(card(view, 'export.video').querySelector('video')!.style.display).toBe(''));
  });

  it('reloads fresh nodes for standard files and self-contained HTML', async () => {
    const { view } = await mount();
    const latest = makeFull('a', 'Fresh file snapshot', [
      { id: 'wp-file', name: 'Fresh file node', desc: 'Fresh file description', lat: 30.001, lon: 120.001, type: 'custom', hidden: false }
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

  it('rebuilds share links from the latest database snapshot without a redundant generate button', async () => {
    const { view } = await mount();
    const latest = makeFull('a', 'Fresh link snapshot', [
      { id: 'wp-link', name: 'Fresh link node', desc: 'Fresh link description', lat: 30.001, lon: 120.001, type: 'custom', hidden: false }
    ]);
    mocks.loadTripFull.mockResolvedValueOnce(latest);
    vi.mocked(buildShareLink).mockClear();
    const linkCard = card(view, 'export.link');
    expect([...linkCard.querySelectorAll('button')].some((button) => button.textContent === 'export.linkBuild')).toBe(false);
    linkCard.querySelector<HTMLButtonElement>('.btn')!.click();

    await vi.waitFor(() => expect(mocks.loadTripFull).toHaveBeenCalledWith('a', { trackSnapshot: mocks.state.activeTripFull }));
    await vi.waitFor(() => expect(mocks.clipboardWrite).toHaveBeenCalledTimes(1));
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

  it('preserves outputs across same-trip reloads and keeps an in-flight video valid', async () => {
    const exported = await mount();
    const { view } = exported;
    const posterPreview = card(view, 'export.poster').querySelector<HTMLElement>('.poster-preview')!;
    card(view, 'export.poster').querySelector<HTMLButtonElement>('.btn.primary')!.click();
    await vi.waitFor(() => expect(posterPreview.querySelector('img')).not.toBeNull());
    const posterSrc = posterPreview.querySelector('img')!.getAttribute('src');

    const pendingVideo = deferred<any>();
    mocks.generateTrackVideo.mockReturnValueOnce(pendingVideo.promise);
    card(view, 'export.video').querySelector<HTMLButtonElement>('.btn.primary')!.click();
    await vi.waitFor(() => expect(mocks.generateTrackVideo).toHaveBeenCalledTimes(1));
    const signal = mocks.generateTrackVideo.mock.calls[0][1].signal as AbortSignal;

    expect(card(view, 'export.poster').querySelector<HTMLButtonElement>('.btn.primary')!.disabled).toBe(true);
    expect(card(view, 'export.html').querySelector<HTMLButtonElement>('.btn')!.disabled).toBe(true);
    [...card(view, 'common.export').querySelectorAll<HTMLButtonElement>('.btn')].forEach((button) => expect(button.disabled).toBe(true));

    await mocks.setActiveTrip('a');
    await exported.refresh();
    expect(signal.aborted).toBe(false);
    expect(posterPreview.querySelector('img')!.getAttribute('src')).toBe(posterSrc);

    pendingVideo.resolve(videoResult());
    const video = card(view, 'export.video').querySelector<HTMLVideoElement>('video')!;
    await vi.waitFor(() => expect(video.style.display).toBe(''));
    expect(posterPreview.querySelector('img')!.getAttribute('src')).toBe(posterSrc);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalledWith('export.tripChanged', 'warn');

    const firstVideoSrc = video.getAttribute('src');
    const replacementVideo = deferred<any>();
    mocks.generateTrackVideo.mockReturnValueOnce(replacementVideo.promise);
    card(view, 'export.video').querySelector<HTMLButtonElement>('.btn.primary')!.click();
    await vi.waitFor(() => expect(mocks.generateTrackVideo).toHaveBeenCalledTimes(2));
    expect(video.getAttribute('src')).toBe(firstVideoSrc);
    expect(video.style.display).toBe('');

    await mocks.setActiveTrip('a');
    replacementVideo.resolve(videoResult());
    await vi.waitFor(() => expect(video.getAttribute('src')).not.toBe(firstVideoSrc));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(firstVideoSrc);
    expect(posterPreview.querySelector('img')!.getAttribute('src')).toBe(posterSrc);
  });

  it('invalidates outputs and rejects poster completion when updatedAt genuinely changes', async () => {
    const { view } = await mount();
    const posterPreview = card(view, 'export.poster').querySelector<HTMLElement>('.poster-preview')!;
    const generate = card(view, 'export.poster').querySelector<HTMLButtonElement>('.btn.primary')!;
    generate.click();
    await vi.waitFor(() => expect(posterPreview.querySelector('img')).not.toBeNull());
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);

    const pendingPoster = deferred<any>();
    mocks.generatePoster.mockReturnValueOnce(pendingPoster.promise);
    generate.click();
    await vi.waitFor(() => expect(mocks.generatePoster).toHaveBeenCalledTimes(2));

    const updated = makeFull('a', 'Updated trip', [], 2);
    mocks.state.activeTripFull = updated;
    emitActive(updated);
    expect(posterPreview.style.display).toBe('none');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:export-1');

    pendingPoster.resolve({ blob: new Blob(['stale poster']), usedVectorFallback: false });
    await vi.waitFor(() => expect(generate.disabled).toBe(false));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(posterPreview.querySelector('img')).toBeNull();
    expect(mocks.toast).toHaveBeenCalledWith('export.tripChanged', 'warn');
  });

  it('rejects a different-trip video completion and localizes the invalidation toast', async () => {
    const { view } = await mount();
    const pendingVideo = deferred<any>();
    mocks.generateTrackVideo.mockReturnValueOnce(pendingVideo.promise);
    card(view, 'export.video').querySelector<HTMLButtonElement>('.btn.primary')!.click();
    await vi.waitFor(() => expect(mocks.generateTrackVideo).toHaveBeenCalledTimes(1));
    const signal = mocks.generateTrackVideo.mock.calls[0][1].signal as AbortSignal;

    mocks.loadTripFull.mockResolvedValueOnce(makeFull('b', 'Other trip'));
    await mocks.setActiveTrip('b');
    expect(signal.aborted).toBe(true);
    pendingVideo.resolve(videoResult());

    const video = card(view, 'export.video').querySelector<HTMLVideoElement>('video')!;
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('export.tripChanged', 'warn'));
    expect(video.style.display).toBe('none');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(view.querySelector<HTMLSelectElement>('select')!.value).toBe('b');
  });

  it('uses setActiveTrip for selector changes and appState.activeTripId for generation', async () => {
    const { view } = await mount();
    mocks.loadTripFull.mockResolvedValueOnce(makeFull('b', 'Other trip'));
    const select = view.querySelector<HTMLSelectElement>('select')!;
    select.value = 'b';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(view.querySelector('.card .small.muted')?.textContent).toContain('Other trip'));
    expect(mocks.setActiveTrip).toHaveBeenCalledWith('b');
    expect(mocks.state.activeTripId).toBe('b');

    // A stale DOM value must not become a second selection authority.
    select.value = 'a';
    mocks.loadTripFull.mockClear();
    mocks.loadTripFull.mockResolvedValueOnce(makeFull('b', 'Other trip'));
    const generate = card(view, 'export.poster').querySelector<HTMLButtonElement>('.btn.primary')!;
    expect(generate.disabled).toBe(false);
    generate.click();
    await vi.waitFor(() => expect(mocks.loadTripFull).toHaveBeenCalledWith('b', { trackSnapshot: mocks.state.activeTripFull }));
    await vi.waitFor(() => expect(mocks.generatePoster).toHaveBeenCalledTimes(1));
    expect(mocks.loadTripFull).toHaveBeenCalledWith('b', { trackSnapshot: mocks.state.activeTripFull });
    expect(select.value).toBe('b');
  });

  it('revokes replaced poster and video URLs and releases both on destroy', async () => {
    const exported = await mount();
    const { view } = exported;
    const posterPreview = card(view, 'export.poster').querySelector<HTMLElement>('.poster-preview')!;
    const generatePoster = card(view, 'export.poster').querySelector<HTMLButtonElement>('.btn.primary')!;
    generatePoster.click();
    await vi.waitFor(() => expect(posterPreview.querySelector('img')?.getAttribute('src')).toBe('blob:export-1'));
    generatePoster.click();
    await vi.waitFor(() => expect(posterPreview.querySelector('img')?.getAttribute('src')).toBe('blob:export-2'));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:export-1');

    card(view, 'export.video').querySelector<HTMLButtonElement>('.btn.primary')!.click();
    const video = card(view, 'export.video').querySelector<HTMLVideoElement>('video')!;
    await vi.waitFor(() => expect(video.getAttribute('src')).toBe('blob:export-3'));

    exported.destroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:export-2');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:export-3');
    expect(posterPreview.querySelector('img')).toBeNull();
    expect(video.hasAttribute('src')).toBe(false);
  });

  it('forwards share style, camera and icon privacy, and clears previews when style changes', async () => {
    const { view } = await mount();
    const privacyCard = card(view, 'export.privacy');
    const startIcon = privacyCard.querySelector<HTMLInputElement>('input.hide-start-icon')!;
    startIcon.checked = true;
    startIcon.dispatchEvent(new Event('change'));
    expect(privacyCard.querySelector<HTMLElement>('.privacy-summary')!.textContent).toContain('export.startIconHidden');

    const posterCard = card(view, 'export.poster');
    const preview = posterCard.querySelector<HTMLElement>('.poster-preview')!;
    posterCard.querySelector<HTMLButtonElement>('.btn.primary')!.click();
    await vi.waitFor(() => expect(preview.querySelector('img')).not.toBeNull());
    const posterOpts = mocks.generatePoster.mock.calls[0][1];
    expect(posterOpts.privacy).toEqual({ radius: 0, mode: 'all', offset: true, hideSensitive: true, hideStartIcon: true });
    expect(posterOpts.style).toMatchObject({ background: 'theme', trackColor: 'theme', trackWidth: 6.5, layout: 'stack' });

    const background = posterCard.querySelector<HTMLSelectElement>('.share-style select')!;
    background.value = 'night';
    background.dispatchEvent(new Event('change'));
    expect(preview.style.display).toBe('none');
    expect(preview.querySelector('img')).toBeNull();

    const videoCard = card(view, 'export.video');
    const camera = videoCard.querySelector<HTMLSelectElement>('select.video-camera')!;
    camera.value = 'follow';
    camera.dispatchEvent(new Event('change'));
    const photoCutIn = videoCard.querySelector<HTMLInputElement>('input.photo-cut-in')!;
    photoCutIn.checked = false;
    photoCutIn.dispatchEvent(new Event('change'));
    videoCard.querySelector<HTMLButtonElement>('.btn.primary')!.click();

    await vi.waitFor(() => expect(mocks.generateTrackVideo).toHaveBeenCalledTimes(1));
    const videoOpts = mocks.generateTrackVideo.mock.calls[0][1];
    expect(videoOpts.privacy).toEqual({ radius: 0, mode: 'all', offset: true, hideSensitive: true, hideStartIcon: true });
    expect(videoOpts.style).toMatchObject({ background: 'night', camera: 'follow', photoCutIn: false });
  });

  it('collapses privacy controls behind Adjust and updates the dynamic summary immediately', async () => {
    const { view } = await mount();
    const full = makeFull('a', 'Privacy trip', [
      { id: 'wp-hidden', name: 'Hidden', lat: 30.001, lon: 120.001, type: 'custom', hidden: true }
    ]);
    mocks.state.activeTripFull = full;
    emitActive(full);
    const privacyCard = card(view, 'export.privacy');
    const radius = privacyCard.querySelector<HTMLInputElement>('input[type="number"]')!;
    const hide = privacyCard.querySelector<HTMLInputElement>('input.hide-sensitive')!;
    const summary = privacyCard.querySelector<HTMLElement>('.privacy-summary')!;
    const crop = privacyCard.querySelector<HTMLElement>('.privacy-crop')!;
    const controls = privacyCard.querySelector<HTMLElement>('.privacy-controls')!;
    const adjust = privacyCard.querySelector<HTMLButtonElement>('.privacy-adjust')!;

    expect(controls.hidden).toBe(true);
    expect(controls.style.display).toBe('none');
    expect(adjust.getAttribute('aria-expanded')).toBe('false');
    expect(adjust.getAttribute('aria-controls')).toBe(controls.id);
    adjust.click();
    expect(controls.hidden).toBe(false);
    expect(controls.style.display).toBe('');
    expect(adjust.getAttribute('aria-expanded')).toBe('true');
    adjust.click();
    expect(controls.hidden).toBe(true);
    expect(adjust.getAttribute('aria-expanded')).toBe('false');

    radius.value = '0';
    radius.dispatchEvent(new Event('change'));
    hide.checked = false;
    hide.dispatchEvent(new Event('change'));
    expect(summary.textContent).toContain('export.privacyRadiusOff');
    expect(summary.textContent).toContain('export.sensitiveVisible');
    expect(summary.textContent).toContain('export.vectorOnlyOff');
    expect(crop.textContent).toBe('export.cropNote 0 0');

    radius.value = '500';
    radius.dispatchEvent(new Event('change'));
    expect(summary.textContent).toContain('export.checkCircle · 500 m');
    hide.checked = true;
    hide.dispatchEvent(new Event('change'));
    expect(summary.textContent).toContain('export.sensitiveHidden');
    const vector = controls.querySelector<HTMLInputElement>('input.vector-only')!;
    vector.checked = true;
    vector.dispatchEvent(new Event('change'));
    expect(summary.textContent).toContain('export.vectorOnlyOn');
    expect(crop.textContent).toBe('export.cropNote 3 1');
    expect(summary.textContent).not.toContain('export.cropNote');
    expect(summary.textContent).not.toContain('export.stripExif');
    expect(summary.textContent).not.toContain('export.checkCoords');
    expect(privacyCard.querySelectorAll('.privacy-check')).toHaveLength(0);
  });

  it('shows empty-state recovery actions while keeping output controls disabled', async () => {
    mocks.listTrips.mockResolvedValue([]);
    const exported = createExportView(() => null);
    mounted.push(exported);
    document.body.append(exported.view);
    await vi.waitFor(() => expect(
      exported.view.querySelector<HTMLElement>('.export-empty')?.style.display
    ).toBe(''));

    expect(mocks.setActiveTrip).not.toHaveBeenCalled();
    const empty = exported.view.querySelector<HTMLElement>('.export-empty')!;
    const actions = empty.querySelectorAll<HTMLButtonElement>('.empty-actions button');
    expect(actions).toHaveLength(3);
    actions.forEach((button) => expect(button.disabled).toBe(false));
    [...exported.view.querySelectorAll<HTMLButtonElement>('button')]
      .filter((button) => !empty.contains(button))
      .forEach((button) => expect(button.disabled).toBe(true));
    expect(card(exported.view, 'export.poster').style.display).toBe('none');
    expect(card(exported.view, 'export.video').style.display).toBe('none');
    expect(card(exported.view, 'common.export').style.display).toBe('none');
  });

  it('prewarms for nested Share and the legacy export alias, but not a hidden trip section', async () => {
    const exported = await mount();
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    mocks.state.view = 'trips';
    mocks.state.tripDetail = { open: true, tripId: 'a', section: 'share' };

    await exported.refresh();
    await vi.advanceTimersByTimeAsync(600);
    expect(mocks.prepareMap).toHaveBeenCalledTimes(2);
    expect(mocks.routePlaceNames).toHaveBeenCalledTimes(1);
    expect(mocks.loadBrandFonts).toHaveBeenCalledTimes(1);

    mocks.prepareMap.mockClear();
    mocks.routePlaceNames.mockClear();
    mocks.loadBrandFonts.mockClear();
    mocks.state.tripDetail = { open: true, tripId: 'a', section: 'overview' };
    await exported.refresh();
    await vi.advanceTimersByTimeAsync(600);
    expect(mocks.prepareMap).not.toHaveBeenCalled();
    expect(mocks.routePlaceNames).not.toHaveBeenCalled();
    expect(mocks.loadBrandFonts).not.toHaveBeenCalled();

    mocks.state.view = 'export';
    mocks.state.tripDetail = { open: false, tripId: null, section: 'overview' };
    await exported.refresh();
    await vi.advanceTimersByTimeAsync(600);
    expect(mocks.prepareMap).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending prewarm when Share hides and resumes with fresh privacy/version keys', async () => {
    const exported = await mount();
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    mocks.state.view = 'trips';
    mocks.state.tripDetail = { open: true, tripId: 'a', section: 'share' };

    await exported.refresh();
    mocks.state.tripDetail.section = 'overview';
    await vi.advanceTimersByTimeAsync(600);
    expect(mocks.prepareMap).not.toHaveBeenCalled();

    mocks.state.tripDetail.section = 'share';
    await exported.refresh();
    await vi.advanceTimersByTimeAsync(600);
    expect(mocks.prepareMap).toHaveBeenCalledTimes(2);

    mocks.prepareMap.mockClear();
    const radius = exported.view.querySelector<HTMLInputElement>('input[type="number"]')!;
    radius.value = '500';
    radius.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(600);
    expect(mocks.prepareMap).toHaveBeenCalledTimes(2);

    mocks.prepareMap.mockClear();
    emitActive(makeFull('a', 'Updated prewarm trip', [], 2));
    await vi.advanceTimersByTimeAsync(600);
    expect(mocks.prepareMap).toHaveBeenCalledTimes(2);
  });
});
