import { describe, expect, it } from 'vitest';
import {
  SHARE_STYLE_DEFAULTS, normalizeShareStyle, posterLayout, shareFontStack, squareOverlayLayout, squareStackLayout, trackColorValue
} from '../src/core/shareStyle';

describe('share style', () => {
  it('normalizes unknown values, clamps ranges and keeps the explicit switches', () => {
    const style = normalizeShareStyle({
      background: 'night',
      mapRatio: 100,
      trackColor: 'rose',
      trackWidth: 1,
      statsCard: false,
      title: `  ${'x'.repeat(30)}  `,
      font: 'serif',
      layout: 'overlay',
      camera: 'follow',
      photoCutIn: false
    });
    expect(style.background).toBe('night');
    expect(style.mapRatio).toBe(72);
    expect(style.trackWidth).toBe(3.5);
    expect(style.statsCard).toBe(false);
    expect(style.photoCutIn).toBe(false);
    expect(style.title).toBe('x'.repeat(24));
    expect(style.layout).toBe('overlay');
    expect(style.camera).toBe('follow');

    const fallback = normalizeShareStyle({ background: 'neon', mapRatio: -2, trackColor: 'pink', font: 'comic', camera: 'orbit' });
    expect(fallback.background).toBe(SHARE_STYLE_DEFAULTS.background);
    expect(fallback.mapRatio).toBe(38);
    expect(fallback.trackColor).toBe(SHARE_STYLE_DEFAULTS.trackColor);
    expect(fallback.font).toBe(SHARE_STYLE_DEFAULTS.font);
    expect(fallback.camera).toBe(SHARE_STYLE_DEFAULTS.camera);
    expect(fallback.statsCard).toBe(true);
    expect(fallback.photoCutIn).toBe(true);
  });

  it('resolves concrete track colors and fonts while retaining the theme fallback', () => {
    expect(trackColorValue('theme', '#123456')).toBe('#123456');
    expect(trackColorValue('rose', '#123456')).toBe('#f472b6');
    expect(trackColorValue('white', '')).toBe('#f4f7f8');
    expect(shareFontStack('serif')).toContain('Georgia');
    expect(shareFontStack('mono')).toContain('monospace');
  });

  it('clamps the map share differently for square and vertical posters', () => {
    expect(posterLayout('square', normalizeShareStyle({ mapRatio: 72 }))).toMatchObject({ H: 1080, mapRatio: 56, mapH: 605 });
    expect(posterLayout('vertical', normalizeShareStyle({ mapRatio: 72 }))).toMatchObject({ H: 1920, mapRatio: 72, mapH: 1382 });
    expect(posterLayout('vertical', normalizeShareStyle({ mapRatio: 20 }))).toMatchObject({ mapRatio: 40, mapH: 768 });
  });

  it('keeps the square profile clear of the brand block and reserves overlay chart space', () => {
    const stack = squareStackLayout(1080, 605, true);
    expect(stack.profileY + stack.profileH).toBeLessThanOrEqual(stack.brandY - 18);
    expect(stack.profileH).toBeGreaterThanOrEqual(96);
    const overlay = squareOverlayLayout(1080, 605);
    const profileY = overlay.innerY + 190;
    const profileBottom = overlay.innerY + overlay.innerH - 100;
    expect(profileBottom - profileY).toBeGreaterThanOrEqual(96);
    expect(overlay.innerY + overlay.innerH).toBeLessThanOrEqual(overlay.cardY + overlay.cardH);
  });
});
