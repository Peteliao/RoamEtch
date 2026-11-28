import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeWaypointPhoto } from '../src/core/trackVideo';

afterEach(() => vi.unstubAllGlobals());

describe('video waypoint photos', () => {
  it('falls back from a broken thumbnail to the original and later media records', async () => {
    const photo = { width: 100, height: 80 };
    const decode = vi.fn(async (blob: any) => blob === 'original' || blob === 'second' ? photo : null);
    vi.stubGlobal('createImageBitmap', decode);
    await expect(decodeWaypointPhoto([
      { thumb: 'broken', blob: 'original' },
      { thumb: 'second', blob: 'unused' }
    ])).resolves.toBe(photo);
    expect(decode.mock.calls.map(([blob]) => blob)).toEqual(['broken', 'original']);
  });
});
