export const UI_LANGUAGES = ['zh', 'zh-TW', 'en', 'ja', 'ko', 'es'] as const;

export type UILanguage = typeof UI_LANGUAGES[number];

const LANGUAGE_TAGS: Record<UILanguage, string> = {
  zh: 'zh-CN',
  'zh-TW': 'zh-TW',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  es: 'es'
};

export function isUILanguage(value: unknown): value is UILanguage {
  return typeof value === 'string' && (UI_LANGUAGES as readonly string[]).includes(value);
}

export function browserUILanguage(value: string | undefined): UILanguage {
  const normalized = String(value || 'en').replace(/_/g, '-').toLowerCase();
  if (/^zh-(?:hant|tw|hk|mo)(?:-|$)/.test(normalized)) return 'zh-TW';
  const base = normalized.split('-')[0];
  return isUILanguage(base) ? base : 'en';
}

export function languageTag(value: unknown): string {
  return isUILanguage(value) ? LANGUAGE_TAGS[value] : 'en';
}
