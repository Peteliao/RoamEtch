import { describe, expect, it } from 'vitest';
import {
  CONCRETE_THEME_IDS, HTML_THEME_CYCLE, THEME_DEFINITIONS, THEME_OPTIONS,
  appCssVars, htmlCssVars, isConcreteTheme, isThemeMode, themeDefinition
} from '../src/core/themeRegistry';

const EXPECTED_IDS = [
  'dark', 'light', 'contrast', 'matrix', 'neon', 'starship',
  'aurora', 'amber', 'deepsea', 'vermilion', 'sakura', 'butterfly', 'pearl', 'rose'
];
const PALETTE_KEYS = [
  'panel', 'text', 'muted', 'faint', 'accent', 'accentSoft', 'accentLine', 'amber',
  'vectorBg', 'grid', 'cellBg', 'progressTrack', 'badgeBg', 'badgeEdge', 'lut',
  'trackHalo', 'trackCasing', 'wpRing', 'endRing', 'edgeShade'
] as const;

describe('central theme registry', () => {
  it('exposes exactly fifteen selector options and fourteen concrete export themes', () => {
    expect(THEME_OPTIONS.map((option) => option.id)).toEqual(['auto', ...EXPECTED_IDS]);
    expect(CONCRETE_THEME_IDS).toEqual(EXPECTED_IDS);
    expect(HTML_THEME_CYCLE).toEqual(EXPECTED_IDS);
    expect(isThemeMode('auto')).toBe(true);
    expect(isThemeMode('neon')).toBe(true);
    expect(isThemeMode('oled')).toBe(false);
    expect(isConcreteTheme('auto')).toBe(false);
    expect(isConcreteTheme('vermilion')).toBe(true);
    expect(isConcreteTheme('rose')).toBe(true);
  });

  it('owns bilingual labels, stable keys and the renamed Blazing sun', () => {
    expect(THEME_DEFINITIONS.contrast.id).toBe('contrast');
    expect(THEME_DEFINITIONS.contrast.labels).toEqual({ zh: '烈日', en: 'Blazing sun' });
    expect(THEME_DEFINITIONS.neon.labels).toEqual({ zh: '霓虹', en: 'Neon' });
    expect(THEME_DEFINITIONS.starship.labels).toEqual({ zh: '星舰', en: 'Starship' });
    expect(THEME_DEFINITIONS.aurora.labels).toEqual({ zh: '极光', en: 'Aurora' });
    expect(THEME_DEFINITIONS.amber.labels).toEqual({ zh: '琥珀', en: 'Amber' });
    expect(THEME_DEFINITIONS.deepsea.labels).toEqual({ zh: '深海', en: 'Deep sea' });
    expect(THEME_DEFINITIONS.vermilion.labels).toEqual({ zh: '朱砂', en: 'Vermilion' });
    expect(THEME_DEFINITIONS.sakura.labels).toEqual({ zh: '樱雾', en: 'Sakura mist' });
    expect(THEME_DEFINITIONS.butterfly.labels).toEqual({ zh: '蝶梦', en: 'Butterfly dream' });
    expect(THEME_DEFINITIONS.pearl.labels).toEqual({ zh: '珠光', en: 'Pearl' });
    expect(THEME_DEFINITIONS.rose.labels).toEqual({ zh: '蔷薇', en: 'Rose' });
    expect(new Set(THEME_OPTIONS.map((option) => option.labelKey)).size).toBe(15);
  });

  it('provides complete, distinct palettes and consistent color schemes', () => {
    const signatures = new Set<string>();
    for (const id of EXPECTED_IDS) {
      const definition = THEME_DEFINITIONS[id];
      expect(definition.id).toBe(id);
      expect(definition.effect).toBe(id);
      expect(['light', 'dark']).toContain(definition.colorScheme);
      for (const key of PALETTE_KEYS) expect(definition.palette[key]).toBeTruthy();
      expect(definition.palette.lut).toHaveLength(3);
      for (const stop of definition.palette.lut) {
        expect(stop).toHaveLength(3);
        expect(stop.every((channel) => channel >= 0 && channel <= 255)).toBe(true);
      }
      signatures.add(JSON.stringify(definition.palette));
      expect(appCssVars(id)['color-scheme']).toBe(definition.colorScheme);
      expect(htmlCssVars(id)['color-scheme']).toBe(definition.colorScheme);
      expect(appCssVars(id)['--bg']).toBe(definition.palette.vectorBg);
      expect(htmlCssVars(id)['--bg']).toBe(definition.palette.vectorBg);
      expect(appCssVars(id)['--map-attrib-bg']).toBeTruthy();
      expect(appCssVars(id)['--map-control-filter']).toBeTruthy();
    }
    expect(signatures.size).toBe(EXPECTED_IDS.length);
    expect(THEME_DEFINITIONS.light.colorScheme).toBe('light');
    expect(THEME_DEFINITIONS.contrast.colorScheme).toBe('light');
    expect(THEME_DEFINITIONS.vermilion.colorScheme).toBe('light');
    expect(THEME_DEFINITIONS.sakura.colorScheme).toBe('light');
    expect(THEME_DEFINITIONS.butterfly.colorScheme).toBe('light');
    expect(THEME_DEFINITIONS.pearl.colorScheme).toBe('light');
    expect(THEME_DEFINITIONS.rose.colorScheme).toBe('dark');
    expect(THEME_DEFINITIONS.matrix.colorScheme).toBe('dark');
  });

  it('retains Matrix and dark fallbacks for unknown values', () => {
    expect(themeDefinition('unknown')).toBe(THEME_DEFINITIONS.dark);
    expect(themeDefinition('auto')).toBe(THEME_DEFINITIONS.dark);
    expect(THEME_DEFINITIONS.matrix.palette.vectorBg).toBe('#000300');
    expect(THEME_DEFINITIONS.matrix.palette.accent).toBe('#39ff88');
  });
});
