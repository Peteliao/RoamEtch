import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { zh, en, zhTW, ja, ko, es } from '../src/core/i18n';

const locales = { zh, en, 'zh-TW': zhTW, ja, ko, es };

function flatten(value: any, prefix = '', out: Record<string, string> = {}) {
  for (const [key, child] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object') flatten(child, full, out);
    else out[full] = String(child);
  }
  return out;
}

function placeholders(value: string) {
  return [...value.matchAll(/{{\s*([^}]+?)\s*}}/g)].map((match) => match[1]).sort();
}

function walk(dir: string, files: string[] = []) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) walk(file, files);
    else if (/[.](ts|tsx|js|mjs)$/.test(name)) files.push(file);
  }
  return files;
}

function staticKeys() {
  const keys = new Set<string>();
  for (const file of walk(path.resolve(process.cwd(), 'src'))) {
    const source = fs.readFileSync(file, 'utf8');
    const pattern = /\bt\(\s*(['"])([^'"]*)\1(\s*[,)])/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      if (match[2]) keys.add(match[2]);
    }
  }
  return [...keys].sort();
}

describe('translation coverage', () => {
  it('provides every statically referenced key in all six UI languages', () => {
    const flattened = Object.fromEntries(Object.entries(locales).map(([lang, resource]) => [lang, flatten(resource)]));
    const missing = staticKeys().flatMap((key) =>
      Object.entries(flattened).flatMap(([lang, values]) => key in values ? [] : [`${lang}:${key}`])
    );
    expect(missing).toEqual([]);
  });

  it('keeps every locale key set identical to English', () => {
    const enKeys = Object.keys(flatten(en)).sort();
    for (const [lang, resource] of Object.entries(locales)) {
      const keys = Object.keys(flatten(resource)).sort();
      expect(keys.filter((key) => !enKeys.includes(key)), `${lang}: extra keys`).toEqual([]);
      expect(enKeys.filter((key) => !keys.includes(key)), `${lang}: missing keys`).toEqual([]);
    }
  });

  it('preserves interpolation placeholders in every locale', () => {
    const enValues = flatten(en);
    for (const [lang, resource] of Object.entries(locales)) {
      const values = flatten(resource);
      const mismatches = Object.keys(enValues).flatMap((key) =>
        JSON.stringify(placeholders(values[key] ?? '')) === JSON.stringify(placeholders(enValues[key]))
          ? []
          : [`${lang}:${key}: ${placeholders(values[key] ?? '').join(',')} != ${placeholders(enValues[key]).join(',')}`]
      );
      expect(mismatches).toEqual([]);
    }
  });
});
