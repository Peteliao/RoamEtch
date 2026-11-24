import { describe, expect, it } from 'vitest';
import { OriginalImageCache, type CachedOriginalImage } from '../src/core/originalImageCache';

function entry(fileId: string, size = 64): CachedOriginalImage {
  return {
    fileId, size, blob: new Blob([new Uint8Array(size)]), sha256: 'a'.repeat(64),
    mime: 'image/jpeg', width: 320, height: 240, createdAt: 1, lastUsed: 1
  };
}

describe('original image LRU cache', () => {
  it('keeps only the newest ten images and refreshes access order', () => {
    const cache = new OriginalImageCache(2, 1024);
    expect(cache.put(entry('one'))).toBe(true);
    expect(cache.put(entry('two'))).toBe(true);
    expect(cache.get('one')?.fileId).toBe('one');
    expect(cache.put(entry('three'))).toBe(true);
    expect(cache.get('two')).toBeNull();
    expect(cache.get('one')).not.toBeNull();
    expect(cache.get('three')).not.toBeNull();
  });

  it('enforces the byte budget and rejects an image larger than the whole pool', () => {
    const cache = new OriginalImageCache(10, 100);
    cache.put(entry('one', 60));
    cache.put(entry('two', 60));
    expect(cache.byteSize).toBe(60);
    expect(cache.get('one')).toBeNull();
    expect(cache.put(entry('huge', 101))).toBe(false);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.byteSize).toBe(0);
  });
});
