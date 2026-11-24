import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateLegacyKey } from '../src/core/storageKeys';

let values: Map<string, string>;

beforeEach(() => {
  values = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('legacy storage keys', () => {
  it('moves an existing value without changing its payload', () => {
    values.set('trackmint.pendingPoints.v1', '{"points":[1,2]}');
    migrateLegacyKey('trackmint.pendingPoints.v1', 'roametch.pendingPoints.v1');
    expect(values.get('roametch.pendingPoints.v1')).toBe('{"points":[1,2]}');
    expect(values.has('trackmint.pendingPoints.v1')).toBe(false);
  });

  it('keeps the current value when both keys exist', () => {
    values.set('legacy', 'old');
    values.set('current', 'new');
    migrateLegacyKey('legacy', 'current');
    expect(values.get('current')).toBe('new');
    expect(values.has('legacy')).toBe(false);
  });

  it('does nothing when the legacy key is absent', () => {
    migrateLegacyKey('legacy', 'current');
    expect(values.size).toBe(0);
  });
});
