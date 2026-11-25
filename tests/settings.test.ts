import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function installStorage(seed?: Record<string, any>) {
  const values = new Map<string, string>();
  if (seed) values.set('localtrace.settings.v1', JSON.stringify(seed));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  });
  return values;
}

describe('P2P settings', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it('defaults direct transfer off and includes it in factory reset', async () => {
    installStorage();
    const settings = await import('../src/core/settings');
    expect(settings.get('meetP2PEnabled')).toBe(false);
    expect(settings.get('meetP2PNoticeVersion')).toBe(0);
    settings.set('meetP2PEnabled', true);
    settings.set('meetTurnPass', 'temporary');
    settings.resetSettings();
    expect(settings.get('meetP2PEnabled')).toBe(false);
    expect(settings.get('meetTurnPass')).toBe('');
  });

  it('persists the Matrix preference and restores dark on reset', async () => {
    installStorage();
    const settings = await import('../src/core/settings');
    expect(settings.get('theme')).toBe('dark');
    settings.set('theme', 'matrix');
    vi.resetModules();
    const reloaded = await import('../src/core/settings');
    expect(reloaded.get('theme')).toBe('matrix');
    reloaded.resetSettings();
    expect(reloaded.get('theme')).toBe('dark');
  });

  it('accepts all registered themes and rejects unknown saved or patched values', async () => {
    installStorage({ theme: 'obsolete' });
    const settings = await import('../src/core/settings');
    expect(settings.get('theme')).toBe('dark');
    for (const theme of ['auto', 'neon', 'starship', 'aurora', 'amber', 'deepsea', 'vermilion']) {
      settings.set('theme', theme);
      expect(settings.get('theme')).toBe(theme);
    }
    settings.set('theme', 'oled');
    settings.patch({ theme: 'unknown', units: 'imperial' });
    expect(settings.get('theme')).toBe('vermilion');
    expect(settings.get('units')).toBe('imperial');
  });

  it('keeps a fresh P2P opt-in after reload', async () => {
    installStorage();
    const first = await import('../src/core/settings');
    first.set('meetP2PEnabled', true);
    first.set('meetP2PNoticeVersion', 1);
    vi.resetModules();
    const reloaded = await import('../src/core/settings');
    expect(reloaded.get('meetP2PEnabled')).toBe(true);
    expect(reloaded.get('meetP2PNoticeVersion')).toBe(1);
  });

  it('migrates the old reserved STUN field without disabling custom TURN values', async () => {
    installStorage({
      meetStun: 'stun:stun.cloudflare.com:3478', meetTurnUrl: 'turn:relay.example:3478',
      meetTurnUser: 'user', meetTurnPass: 'secret', migrateMeetMulti: 1, migrateMeetV2: 1, migrateActivity: 1
    });
    const settings = await import('../src/core/settings');
    expect(settings.get('meetStun').split('\n')).toHaveLength(3);
    expect(settings.get('meetP2PEnabled')).toBe(false);
    expect(settings.get('meetTurnPass')).toBe('secret');
  });
});
