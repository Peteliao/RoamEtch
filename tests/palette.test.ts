import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ theme: 'dark' }));
vi.mock('../src/core/theme', () => ({ effectiveTheme: () => mocks.theme }));

import { canvasPalette, paletteFor } from '../src/core/palette';
import { CONCRETE_THEME_IDS, THEME_DEFINITIONS } from '../src/core/themeRegistry';

describe('canvas theme palettes', () => {
  beforeEach(() => { mocks.theme = 'dark'; });

  it('provides a distinct green-black Matrix palette with every export token', () => {
    const matrix = paletteFor('matrix');
    expect(matrix).not.toBe(paletteFor('dark'));
    expect(matrix.panel).toBe('#020805');
    expect(matrix.vectorBg).toBe('#000300');
    expect(matrix.accent).toBe('#39ff88');
    expect(matrix.text).toBe('#d6ffe5');
    for (const key of [
      'panel', 'text', 'muted', 'faint', 'accent', 'accentSoft', 'accentLine', 'amber',
      'vectorBg', 'grid', 'cellBg', 'progressTrack', 'badgeBg', 'badgeEdge', 'lut',
      'trackHalo', 'trackCasing', 'wpRing', 'endRing', 'edgeShade'
    ]) expect(matrix[key]).toBeTruthy();
    expect(matrix.lut[2][1]).toBeGreaterThan(matrix.lut[2][0]);
    expect(matrix.lut[2][1]).toBeGreaterThan(matrix.lut[2][2]);
  });

  it('resolves every registered theme through the shared palette objects', () => {
    for (const id of CONCRETE_THEME_IDS) {
      expect(paletteFor(id)).toBe(THEME_DEFINITIONS[id].palette);
      mocks.theme = id;
      expect(canvasPalette()).toBe(paletteFor(id));
    }
  });

  it('uses the effective Matrix theme and retains the dark fallback', () => {
    mocks.theme = 'matrix';
    expect(canvasPalette()).toBe(paletteFor('matrix'));
    mocks.theme = 'unknown';
    expect(canvasPalette()).toBe(paletteFor('dark'));
  });
});
