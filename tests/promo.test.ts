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

const audienceSlugs = [
  'solo-outdoor', 'road-crews', 'travel-creators', 'cross-border', 'frontend-open-source',
  'endurance-athletes', 'urban-commuters', 'family-outings', 'overland-vanlife', 'event-leads',
  'field-researchers', 'gpx-data-stewards', 'yearly-memory', 'night-oled', 'dog-walkers',
  'site-visits', 'loved-ones'
];
const audienceKeys = [
  'soloOutdoor', 'roadCrews', 'travelCreators', 'crossBorder', 'frontend', 'athletes', 'commuters',
  'family', 'overland', 'eventLeads', 'fieldResearch', 'dataStewards', 'yearlyMemory', 'nightOled',
  'dogWalkers', 'siteVisits', 'lovedOnes'
];
const copyFields = [
  'label', 'eyebrow', 'headline1', 'headline2', 'sub1', 'sub2',
  'feature1', 'feature2', 'feature3', 'cta', 'caption'
] as const;

let promo: typeof import('../src/core/promo');
let i18n: typeof import('../src/core/i18n');

const promoLanguages = ['zh', 'zh-TW', 'ja', 'ko', 'es', 'en'] as const;
const resourceKeys = { zh: 'zh', 'zh-TW': 'zhTW', ja: 'ja', ko: 'ko', es: 'es', en: 'en' } as const;

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

function installCanvasMock() {
  const canvases: HTMLCanvasElement[] = [];
  const texts: string[] = [];
  const textCalls: Array<{ text: string; x: number; y: number; maxWidth?: number }> = [];
  const gradient = { addColorStop: vi.fn() };
  const ctx = new Proxy({
    measureText: (text: string) => ({ width: String(text).length * 12 }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient
  }, {
    get(target, key: string) {
      if (key in target) return target[key as keyof typeof target];
      return (...args: any[]) => {
        if (key === 'fillText') {
          const text = String(args[0]);
          texts.push(text);
          textCalls.push({ text, x: Number(args[1]), y: Number(args[2]), maxWidth: args[3] == null ? undefined : Number(args[3]) });
        }
      };
    }
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx as any);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback: BlobCallback) {
    canvases.push(this);
    callback(new Blob(['png'], { type: 'image/png' }));
  });
  return { canvases, texts, textCalls };
}

describe('promo variants', () => {
  it('cycles through all 25 variants and wraps', () => {
    expect(promo.PROMO_VARIANT_COUNT).toBe(25);
    let variant = 0;
    const sequence = [];
    for (let i = 0; i < promo.PROMO_VARIANT_COUNT; i++) {
      sequence.push(variant);
      variant = promo.nextVariant(variant);
    }
    expect(sequence).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(variant).toBe(0);
    expect(promo.nextVariant(-1)).toBe(0);
    expect(promo.nextVariant(24)).toBe(0);
    expect(promo.nextVariant(25)).toBe(1);
  });

  it('exposes the complete 17-audience label and filename catalog', () => {
    for (let index = 0; index < audienceSlugs.length; index++) {
      expect(promo.promoVariantSlug(index + 8)).toBe(audienceSlugs[index]);
      expect(promo.promoVariantLabel(index + 8)).not.toBe(`promo.audience.${audienceKeys[index]}.label`);
      expect(promo.promoVariantLabel(index + 8).length).toBeGreaterThan(0);
    }
    for (let variant = 0; variant < 8; variant++) {
      expect(promo.promoVariantSlug(variant)).toBe(String(variant + 1));
      expect(promo.promoVariantLabel(variant)).not.toMatch(/^promo\./);
    }
  });

  it('keeps random initial selection within range without consecutive repeats', () => {
    let previous = promo.pickPromoVariant(() => 0.2);
    expect(previous).toBeGreaterThanOrEqual(0);
    expect(previous).toBeLessThan(promo.PROMO_VARIANT_COUNT);
    for (let i = 0; i < 40; i++) {
      const next = promo.pickPromoVariant(() => 0.2);
      expect(next).not.toBe(previous);
      expect(next).toBeGreaterThanOrEqual(0);
      expect(next).toBeLessThan(promo.PROMO_VARIANT_COUNT);
      previous = next;
    }
  });

  it('provides 25 distinct localized captions with the site URL', async () => {
    for (const lang of promoLanguages) {
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

  it('has complete localized copy for every audience', async () => {
    for (const lang of promoLanguages) {
      await i18n.setLanguage(lang);
      const audience = i18n[resourceKeys[lang]].promo.audience as Record<string, Record<string, string>>;
      expect(Object.keys(audience)).toEqual(audienceKeys);
      for (const key of audienceKeys) {
        for (const field of copyFields) {
          const value = audience[key][field];
          expect(value, `${lang}.${key}.${field}`).toBeTruthy();
          expect(value).not.toMatch(/^promo\./);
        }
        expect(audience[key].caption).toContain('{{url}}');
      }
    }
  });

  it('avoids absolute, unsupported and misleading advertising claims', async () => {
    const zhBanned = /最|第一|唯一|100%|永不|绝对|极致|零风险|不上传|不留云端痕迹|散场即焚|无需安装任何软件|一键自托管|无缝/;
    const enBanned = /\b(best|number one|absolute|zero-risk|seamless)\b|#1|100%|\bnever\b|nothing uploaded|no history kept/;
    for (const lang of ['zh', 'en'] as const) {
      await i18n.setLanguage(lang);
      const banned = lang === 'zh' ? zhBanned : enBanned;
      const captions = Array.from({ length: promo.PROMO_VARIANT_COUNT }, (_, variant) => promo.promoCaption(variant));
      const audience = i18n[lang].promo.audience as Record<string, Record<string, string>>;
      const audienceCopy = audienceKeys.flatMap((key) => copyFields.map((field) => audience[key][field]));
      for (const text of [...captions, ...audienceCopy]) expect(text).not.toMatch(banned);
    }
  });

  it('renders each complete localized slogan once on one baseline', async () => {
    const { texts, textCalls } = installCanvasMock();
    for (const lang of promoLanguages) {
      await i18n.setLanguage(lang);
      const textStart = texts.length;
      const callStart = textCalls.length;
      await promo.generatePromo(0);
      const rendered = texts.slice(textStart);
      const slogan = i18n.t('app.slogan');
      const sloganCalls = textCalls.slice(callStart).filter((call) => call.text === slogan);
      expect(sloganCalls).toHaveLength(1);
      expect(sloganCalls[0]).toMatchObject({ x: 72, y: 180, maxWidth: 936 });
      expect(rendered).not.toContain(i18n.t('app.slogan1'));
      expect(rendered).not.toContain(i18n.t('app.slogan2'));
    }
  });

  it('draws complete hero and call-to-action copy without ellipsis in every language', async () => {
    const { texts } = installCanvasMock();
    const audienceKeysByVariant: Record<number, string> = { 8: 'soloOutdoor', 15: 'family', 17: 'eventLeads', 24: 'lovedOnes' };
    for (const lang of promoLanguages) {
      await i18n.setLanguage(lang);
      for (const variant of [0, 8, 15, 17, 24]) {
        const textStart = texts.length;
        await promo.generatePromo(variant);
        const renderedTexts = texts.slice(textStart);
        const rendered = new Set(renderedTexts);
        const audienceKey = audienceKeysByVariant[variant];
        const copy = variant === 0
          ? ['eyebrow', 'headline1', 'headline2', 'sub1', 'sub2'].map((key) => i18n.t(`promo.${key}`))
          : ['eyebrow', 'headline1', 'headline2', 'sub1', 'sub2'].map((key) => i18n.t(`promo.audience.${audienceKey}.${key}`));
        const cta = variant === 0 ? i18n.t('promo.cta') : i18n.t(`promo.audience.${audienceKey}.cta`);
        for (const text of [...copy, cta, i18n.t('promo.footer')]) {
          expect(rendered.has(text), `${lang}.${variant}.${text}`).toBe(true);
          expect(text).not.toContain('…');
        }
        expect(renderedTexts.some((text) => text.includes('…')), `${lang}.${variant}`).toBe(false);
      }
    }
  });

  it('draws the recovery flow, symmetric status labels and compact footer in every language', async () => {
    const { texts } = installCanvasMock();
    for (const lang of promoLanguages) {
      await i18n.setLanguage(lang);
      const textStart = texts.length;
      await promo.generatePromo(5);
      const rendered = new Set(texts.slice(textStart));
      for (const key of ['gBackground', 'gRelocated', 'gSegment', 'gGap', 'gInterrupted', 'gNoData', 'gRestored', 'gRepair', 'gRepairValue', 'gStatPoints', 'gStatSegments', 'gStatLocal']) {
        expect(rendered.has(i18n.t(`promo.${key}`)), `${lang}.${key}`).toBe(true);
      }
      expect(rendered.has('01')).toBe(true);
      expect(rendered.has('02')).toBe(true);
      expect(rendered.has('03')).toBe(true);
      expect(rendered.has('LOCAL')).toBe(true);
      expect(rendered.has(i18n.t('promo.footer'))).toBe(true);
      expect(rendered.has(i18n.t('promo.gNote'))).toBe(false);
    }
  });

  it('renders every variant in every language without ellipsis or untranslated promo keys', async () => {
    const { texts } = installCanvasMock();
    for (const lang of promoLanguages) {
      await i18n.setLanguage(lang);
      for (let variant = 0; variant < promo.PROMO_VARIANT_COUNT; variant++) {
        const textStart = texts.length;
        await promo.generatePromo(variant);
        const rendered = texts.slice(textStart);
        expect(rendered.some((text) => text.includes('…')), `${lang}.${variant}`).toBe(false);
        expect(rendered.some((text) => text.startsWith('promo.')), `${lang}.${variant}`).toBe(false);
      }
    }
  });

  it('renders all 25 variants across all 14 themes with translated copy and normalized metadata', async () => {
    await i18n.setLanguage('zh');
    const { canvases, texts } = installCanvasMock();
    const themes = [
      'dark', 'light', 'contrast', 'matrix', 'neon', 'starship',
      'aurora', 'amber', 'deepsea', 'vermilion', 'sakura', 'butterfly', 'pearl', 'rose'
    ];
    for (const theme of themes) {
      mocks.theme = theme;
      for (let variant = 0; variant < promo.PROMO_VARIANT_COUNT; variant++) {
        const textStart = texts.length;
        const result = await promo.generatePromo(variant);
        expect(result.variant).toBe(variant);
        expect(result.filename).toMatch(new RegExp(`^roametch-promo-${promo.promoVariantSlug(variant)}-\\d+\\.png$`));
        expect(result.caption).toBe(promo.promoCaption(variant));
        expect(result.blob.type).toBe('image/png');
        expect(canvases.at(-1)?.width).toBe(1080);
        expect(canvases.at(-1)?.height).toBe(1350);
        expect(texts.slice(textStart).some((text) => text.startsWith('promo.'))).toBe(false);
      }
    }
    expect(canvases).toHaveLength(350);
    expect(texts).toContain('RoamEtch');
    expect(texts).toContain('迹刻');
    expect(await promo.generatePromo(25)).toMatchObject({ variant: 0 });
    expect(await promo.generatePromo(-1)).toMatchObject({ variant: 24 });
  });
});
