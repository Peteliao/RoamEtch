// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n, setLanguage, t } from '../src/core/i18n';
import { set } from '../src/core/settings';
import { loadTripFull } from '../src/core/store';
import { feedFix, startRewalk, stopRewalk } from '../src/core/rewalk';

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

beforeEach(async () => {
  localStorage.clear();
  set('language', 'zh');
  set('rewalkVoice', true);
  await initI18n();
  spoken.length = 0;
  speechSynthesisMock.speak.mockClear();
  speechSynthesisMock.cancel.mockClear();
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
});
