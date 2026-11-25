// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ theme: 'dark' }));

vi.mock('../src/core/brand', () => ({
  SITE_URL: 'https://example.test/roametch/',
  SPORT_FONT: 'sans-serif',
  loadBrandFonts: vi.fn(async () => {}),
  drawBrandMark: vi.fn(),
  drawQr: vi.fn()
}));
vi.mock('../src/core/theme', () => ({ effectiveTheme: () => mocks.theme }));

function installStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  });
}

let promo: typeof import('../src/core/promo');
let i18n: typeof import('../src/core/i18n');

beforeEach(async () => {
  vi.resetModules();
  installStorage();
  vi.stubGlobal('Path2D', class { constructor(public d?: string) {} });
  i18n = await import('../src/core/i18n');
  await i18n.initI18n();
  promo = await import('../src/core/promo');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('promo variants', () => {
  it('cycles through all eight variants and wraps', () => {
    expect(promo.PROMO_VARIANT_COUNT).toBe(8);
    let variant = 0;
    const sequence = [];
    for (let i = 0; i < promo.PROMO_VARIANT_COUNT; i++) {
      sequence.push(variant);
      variant = promo.nextVariant(variant);
    }
    expect(sequence).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(variant).toBe(0);
    expect(promo.nextVariant(-1)).toBe(0);
  });

  it('keeps random initial selection within range without consecutive repeats', () => {
    let previous = promo.pickPromoVariant(() => 0.2);
    expect(previous).toBeGreaterThanOrEqual(0);
    expect(previous).toBeLessThan(promo.PROMO_VARIANT_COUNT);
    for (let i = 0; i < 24; i++) {
      const next = promo.pickPromoVariant(() => 0.2);
      expect(next).not.toBe(previous);
      expect(next).toBeGreaterThanOrEqual(0);
      expect(next).toBeLessThan(promo.PROMO_VARIANT_COUNT);
      previous = next;
    }
  });

  it('provides eight distinct localized RoamEtch captions with the site URL', async () => {
    for (const lang of ['zh', 'en'] as const) {
      await i18n.setLanguage(lang);
      const captions = Array.from({ length: promo.PROMO_VARIANT_COUNT }, (_, variant) => promo.promoCaption(variant));
      expect(new Set(captions).size).toBe(promo.PROMO_VARIANT_COUNT);
      for (const caption of captions) {
        expect(caption).toContain('RoamEtch');
        expect(caption).toContain('迹刻');
        expect(caption).toContain('#RoamEtch');
        expect(caption).toContain('https://example.test/roametch/');
        expect(caption).not.toContain('{{url}}');
        expect(caption).not.toContain('TrackMint');
        if (lang === 'zh') expect(caption).not.toContain('会合');
      }
    }
  });

  it('renders every variant at 1080×1350 with normalized metadata and translated copy', async () => {
    await i18n.setLanguage('zh');
    const canvases: HTMLCanvasElement[] = [];
    const texts: string[] = [];
    const gradient = { addColorStop: vi.fn() };
    const ctx = new Proxy({
      measureText: (text: string) => ({ width: String(text).length * 12 }),
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient
    }, {
      get(target, key: string) {
        if (key in target) return target[key as keyof typeof target];
        return (...args: any[]) => {
          if (key === 'fillText') texts.push(String(args[0]));
        };
      }
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx as any);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback: BlobCallback) {
      canvases.push(this);
      callback(new Blob(['png'], { type: 'image/png' }));
    });

    const themes = ['dark', 'light', 'contrast', 'matrix', 'neon', 'starship', 'aurora', 'amber', 'deepsea', 'vermilion'];
    for (let variant = 0; variant < promo.PROMO_VARIANT_COUNT; variant++) {
      mocks.theme = themes[variant % themes.length];
      const result = await promo.generatePromo(variant);
      expect(result.variant).toBe(variant);
      expect(result.filename).toMatch(new RegExp(`^roametch-promo-${variant + 1}-\\d+\\.png$`));
      expect(result.caption).toBe(promo.promoCaption(variant));
      expect(result.blob.type).toBe('image/png');
      expect(canvases.at(-1)?.width).toBe(1080);
      expect(canvases.at(-1)?.height).toBe(1350);
      expect(texts).toContain('RoamEtch迹刻');
    }
    expect(texts.some((text) => text.startsWith('promo.'))).toBe(false);
    expect(await promo.generatePromo(8)).toMatchObject({ variant: 0 });
  });
});
