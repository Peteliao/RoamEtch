import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { en, zh } from '../src/core/i18n';

function flatten(value: any, prefix = '', out: Record<string, string> = {}) {
  for (const [key, child] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object') flatten(child, full, out);
    else out[full] = String(child);
  }
  return out;
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
    // Skip concatenated/dynamic expressions such as t('score.verdict' + grade).
    const pattern = /\bt\(\s*(['"])([^'"]*)\1(\s*[,)])/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      if (match[2]) keys.add(match[2]);
    }
  }
  return [...keys].sort();
}

describe('translation coverage', () => {
  it('provides every statically referenced key in both languages', () => {
    const zhKeys = flatten(zh);
    const enKeys = flatten(en);
    const missing = staticKeys().flatMap((key) => [
      ...(key in zhKeys ? [] : [`zh:${key}`]),
      ...(key in enKeys ? [] : [`en:${key}`])
    ]);
    expect(missing).toEqual([]);
  });

  it('keeps the Chinese and English key sets identical', () => {
    const zhKeys = Object.keys(flatten(zh)).sort();
    const enKeys = Object.keys(flatten(en)).sort();
    expect(enKeys.filter((key) => !zhKeys.includes(key))).toEqual([]);
    expect(zhKeys.filter((key) => !enKeys.includes(key))).toEqual([]);
  });
});
