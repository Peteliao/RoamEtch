// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n, setLanguage, t } from '../src/core/i18n';
import { set } from '../src/core/settings';
import { loadTripFull } from '../src/core/store';
import { feedFix, getRewalkNavigation, markExternalNavigation, rewalk, speak, startRewalk, stopRewalk } from '../src/core/rewalk';

vi.mock('../src/core/store', () => ({ loadTripFull: vi.fn() }));
vi.mock('../src/core/recorder', () => ({ rec: { status: 'idle' } }));

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

const points = [
  { lat: 30, lon: 120, t: 0 },
  { lat: 30.001, lon: 120, t: 10_000 },
  { lat: 30.002, lon: 120, t: 20_000 }
];

function voiceTexts() {
  return spoken.map((utterance) => utterance.text).filter((text) => text.trim());
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fullTrip(id: string, name: string) {
  return {
    trip: { id, name },
    segments: [{ id: `${id}-segment`, points }],
    waypoints: []
  } as any;
}

beforeEach(async () => {
  localStorage.clear();
  set('language', 'zh');
  set('rewalkVoice', true);
  await initI18n();
  spoken.length = 0;
  speechSynthesisMock.speak.mockClear();
  speechSynthesisMock.cancel.mockClear();
  speechSynthesisMock.getVoices.mockReset().mockReturnValue([]);
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
  vi.stubGlobal('speechSynthesis', speechSynthesisMock);
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { watchPosition: vi.fn(() => 7), clearWatch: vi.fn() }
  });
  vi.mocked(loadTripFull).mockResolvedValue({
    trip: { id: 'trip-1', name: '滨江步道' },
    segments: [{ id: 'segment-1', points }],
    waypoints: []
  } as any);
});

afterEach(() => {
  stopRewalk();
  vi.unstubAllGlobals();
});

describe('re-walk TTS wording', () => {
  it('uses natural startup and end-completion speech while keeping the UI name', async () => {
    expect(await startRewalk('trip-1', 'full-fwd')).toBe(true);
    expect(t('rewalk.title')).toBe('重走行程');
    expect(voiceTexts()[0]).toBe('开始沿原路线再走一遍。滨江步道，起点 → 终点。');
    expect(voiceTexts()[0]).not.toContain('重走');

    feedFix(points[0].lat, points[0].lon);
    feedFix(points[2].lat, points[2].lon);
    expect(voiceTexts().at(-1)).toBe('本次行程完成，已到达终点。');
  });

  it('uses the start-completion sentence for a reverse walk', async () => {
    expect(await startRewalk('trip-1', 'full-rev')).toBe(true);
    expect(voiceTexts()[0]).toBe('开始沿原路线再走一遍。滨江步道，终点 → 起点。');

    feedFix(points[2].lat, points[2].lon);
    feedFix(points[0].lat, points[0].lon);
    expect(voiceTexts().at(-1)).toBe('本次行程完成，已到达起点。');
  });

  it('keeps startup and completion speech muted when re-walk voice is off', async () => {
    set('rewalkVoice', false);
    expect(await startRewalk('trip-1', 'full-fwd')).toBe(true);
    feedFix(points[0].lat, points[0].lon);
    feedFix(points[2].lat, points[2].lon);
    expect(voiceTexts()).toEqual([]);
  });

  it('provides the same natural announcements in English', async () => {
    await setLanguage('en');
    expect(await startRewalk('trip-1', 'full-fwd')).toBe(true);
    expect(voiceTexts()[0]).toBe('Starting another walk along the original route. 滨江步道: Start → End.');
    feedFix(points[0].lat, points[0].lon);
    feedFix(points[2].lat, points[2].lon);
    expect(voiceTexts().at(-1)).toBe('This walk is complete. You have reached the end.');
  });

  it('prefers an exact Traditional Chinese voice over a Simplified Chinese voice', async () => {
    const traditional = { lang: 'zh-TW', name: 'Traditional Chinese' };
    speechSynthesisMock.getVoices.mockReturnValue([
      { lang: 'zh-CN', name: 'Simplified Chinese' },
      traditional
    ]);
    await setLanguage('zh-TW');

    speak('繁體中文語音');

    expect(spoken.at(-1)?.lang).toBe('zh-TW');
    expect(spoken.at(-1)?.voice).toBe(traditional);
  });

  it('does not force a Simplified Chinese voice for Traditional Chinese speech', async () => {
    speechSynthesisMock.getVoices.mockReturnValue([
      { lang: 'zh-CN', name: 'Simplified Chinese' }
    ]);
    await setLanguage('zh-TW');

    speak('繁體中文語音');

    expect(spoken.at(-1)?.lang).toBe('zh-TW');
    expect(spoken.at(-1)?.voice).toBeNull();
  });

  it('offers driving navigation for a distant approach without repeating local guidance', async () => {
    expect(await startRewalk('trip-1', 'full-fwd')).toBe(true);
    feedFix(31, 121);
    const nav = getRewalkNavigation('web');
    expect(nav?.provider).toBe('amap');
    expect(nav?.mode).toBe('driving');
    expect(nav?.distanceM).toBeGreaterThan(100_000);
    const count = voiceTexts().length;
    feedFix(31.0001, 121.0001);
    expect(voiceTexts()).toHaveLength(count);
  });

  it('announces distance and compass direction for a nearby approach', async () => {
    expect(await startRewalk('trip-1', 'full-fwd')).toBe(true);
    feedFix(30.0089, 120.0005);
    expect(voiceTexts().at(-1)).toContain('向南前往起点');
    feedFix(30.004, 120.002);
    expect(voiceTexts().at(-1)).toContain('向西南前往起点');
    expect(voiceTexts().at(-1)).toMatch(/前方\d/);
  });

  it('suppresses local voice after external navigation starts and resumes on the track', async () => {
    expect(await startRewalk('trip-1', 'full-fwd')).toBe(true);
    feedFix(31, 121);
    expect(markExternalNavigation()).toBe(true);
    const count = voiceTexts().length;
    feedFix(30.02, 120);
    expect(voiceTexts()).toHaveLength(count);
    feedFix(points[0].lat, points[0].lon);
    expect(voiceTexts().slice(count)).toContain('已回到路线，开始沿轨迹行进。');
  });
});

describe('re-walk load cancellation', () => {
  it('does not start navigation when stopped while the trip load is pending', async () => {
    const load = deferred<any>();
    vi.mocked(loadTripFull).mockReturnValueOnce(load.promise);

    const pending = startRewalk('trip-1');
    stopRewalk();
    load.resolve(fullTrip('trip-1', 'Old trip'));

    await expect(pending).resolves.toBe('cancelled');
    expect(rewalk.active).toBe(false);
    expect(navigator.geolocation.watchPosition).not.toHaveBeenCalled();
  });

  it('does not let an older pending load replace a newer re-walk session', async () => {
    const oldLoad = deferred<any>();
    vi.mocked(loadTripFull)
      .mockReturnValueOnce(oldLoad.promise)
      .mockResolvedValueOnce(fullTrip('trip-2', 'New trip'));

    const pendingOld = startRewalk('trip-1');
    await expect(startRewalk('trip-2')).resolves.toBe(true);
    oldLoad.resolve(fullTrip('trip-1', 'Old trip'));

    await expect(pendingOld).resolves.toBe('cancelled');
    expect(rewalk.active).toBe(true);
    expect(rewalk.tripId).toBe('trip-2');
    expect(rewalk.name).toBe('New trip');
    expect(navigator.geolocation.watchPosition).toHaveBeenCalledTimes(1);
  });
});
