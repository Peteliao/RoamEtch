// Canvas palettes resolve through the central registry; unknown values retain
// the historical dark fallback used by imports and older saved settings.
import { effectiveTheme } from './theme';
import { themeDefinition } from './themeRegistry';
export type { CanvasPalette } from './themeRegistry';

export function paletteFor(theme: string) {
  return themeDefinition(theme).palette;
}

export function canvasPalette() {
  return paletteFor(effectiveTheme());
}
