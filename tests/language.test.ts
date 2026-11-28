// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { browserUILanguage, isUILanguage, languageTag, UI_LANGUAGES } from '../src/core/language';
import { initI18n, setLanguage, t } from '../src/core/i18n';
import { simulationModeLabel } from '../src/core/region';

describe('UI language mapping', () => {
  it('exposes the six supported locale codes', () => {
    expect(UI_LANGUAGES).toEqual(['zh', 'zh-TW', 'en', 'ja', 'ko', 'es']);
    for (const lang of UI_LANGUAGES) expect(isUILanguage(lang)).toBe(true);
    expect(isUILanguage('fr')).toBe(false);
    expect(isUILanguage(undefined)).toBe(false);
  });

  it('maps every UI language to its BCP-47 tag', () => {
    expect(UI_LANGUAGES.map(languageTag)).toEqual(['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'es']);
    expect(languageTag('unknown')).toBe('en');
  });

  it('detects browser languages and traditional Chinese regions', () => {
    expect(browserUILanguage('zh-CN')).toBe('zh');
    expect(browserUILanguage('zh-Hans')).toBe('zh');
    expect(browserUILanguage('zh-TW')).toBe('zh-TW');
    expect(browserUILanguage('zh-Hant-HK')).toBe('zh-TW');
    expect(browserUILanguage('zh-HK')).toBe('zh-TW');
    expect(browserUILanguage('zh_MO')).toBe('zh-TW');
    expect(browserUILanguage('ja-JP')).toBe('ja');
    expect(browserUILanguage('ko-KR')).toBe('ko');
    expect(browserUILanguage('es-MX')).toBe('es');
    expect(browserUILanguage('en-GB')).toBe('en');
    expect(browserUILanguage('fr-FR')).toBe('en');
    expect(browserUILanguage(undefined)).toBe('en');
  });

  it('localizes every network simulation label', async () => {
    await initI18n();
    const expected = {
      zh: ['CN', '全球', '离线', 'CORS 失败'],
      'zh-TW': ['CN', '全球', '離線', 'CORS 失敗'],
      en: ['CN', 'Global', 'offline', 'CORS failure'],
      ja: ['CN', 'グローバル', 'オフライン', 'CORS 失敗'],
      ko: ['CN', '글로벌', '오프라인', 'CORS 실패'],
      es: ['CN', 'Global', 'Sin conexión', 'Error de CORS']
    };
    for (const lang of UI_LANGUAGES) {
      await setLanguage(lang);
      expect(['cn', 'global', 'offline', 'corsfail'].map(simulationModeLabel)).toEqual(expected[lang]);
    }
  });

  it('uses singular and plural count forms in English and Spanish', async () => {
    await initI18n();
    await setLanguage('en');
    expect(t('story.dayCount', { n: 1, count: 1 })).toBe('1 day');
    expect(t('story.dayCount', { n: 2, count: 2 })).toBe('2 days');
    expect(t('trips.backupOk', { n: 1, count: 1 })).toBe('Backup exported (1 trip)');
    expect(t('trips.batchExportOk', { n: 2, count: 2 })).toBe('Exported 2 trips');

    await setLanguage('es');
    expect(t('story.dayCount', { n: 1, count: 1 })).toBe('1 día');
    expect(t('story.dayCount', { n: 2, count: 2 })).toBe('2 días');
    expect(t('trips.backupOk', { n: 1, count: 1 })).toBe('Copia exportada (1 viaje)');
    expect(t('trips.batchExportOk', { n: 2, count: 2 })).toBe('Se exportaron 2 viajes');
  });

  it('keeps document language, title and description in sync with every UI language', async () => {
    const description = document.createElement('meta');
    description.name = 'description';
    document.head.append(description);
    await initI18n();

    for (const lang of UI_LANGUAGES) {
      await setLanguage(lang);
      expect(document.documentElement.lang).toBe(languageTag(lang));
      expect(document.title).toBe(`${t('app.name')} · ${t('app.tagline')}`);
      expect(description.content).toBe(t('app.slogan'));
    }
  });
});
