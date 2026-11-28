// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generatePromo: vi.fn(),
  exportImage: vi.fn(),
  modal: vi.fn(),
  toast: vi.fn(),
  share: vi.fn(),
  writeText: vi.fn()
}));

vi.mock('../src/core/i18n', () => ({
  t: (key: string) => key,
  currentLang: () => 'en',
  setLanguage: vi.fn()
}));
vi.mock('../src/core/settings', () => {
  const values: Record<string, any> = {
    language: 'en', theme: 'dark', regionMode: 'auto', units: 'metric', activity: 'auto',
    speedDisplay: 'auto', recordQuality: 'balanced', meetRelayMode: 'mqtt',
    sim: { enabled: false, network: 'off', playbackSpeed: 20 }
  };
  return {
    get: (key: string) => values[key],
    set: vi.fn(), patch: vi.fn(), resetSettings: vi.fn(), MEET_P2P_NOTICE_VERSION: 1
  };
});
vi.mock('../src/core/events', () => ({ on: vi.fn(() => () => {}), emit: vi.fn() }));
vi.mock('../src/core/meet', () => ({ meet: { resumeP2P: vi.fn(), stopP2P: vi.fn() } }));
vi.mock('../src/core/region', () => ({
  regionState: { probe: { cn: 'pending', global: 'pending' }, syncGuess: 'cn', simulated: null },
  setRegionMode: vi.fn(), runProbe: vi.fn(async () => {})
}));
vi.mock('../src/core/store', () => ({
  storageEstimate: vi.fn(async () => ({ quota: 1000, usage: 100 })),
  eraseAll: vi.fn(), isolateDamaged: vi.fn(),
  listQuarantinedRows: vi.fn(async () => []),
  restoreQuarantinedRows: vi.fn(), discardQuarantinedRows: vi.fn()
}));
vi.mock('../src/core/gpx', () => ({ triggerDownload: vi.fn() }));
vi.mock('../src/core/diag', () => ({ exportDiagLog: vi.fn(() => '{}') }));
vi.mock('../src/ui/backupFlow', () => ({
  exportBackupFlow: vi.fn(), restoreBackupFlow: vi.fn(), lastBackupLabel: () => 'never', backupDue: () => false
}));
vi.mock('../src/core/simulator', () => ({ startPlayback: vi.fn(), stopPlayback: vi.fn(), isPlaying: () => false }));
vi.mock('../src/core/promo', () => ({
  generatePromo: mocks.generatePromo,
  nextVariant: (variant: number) => (variant + 1) % 25,
  PROMO_VARIANT_COUNT: 25,
  promoVariantLabel: (variant: number) => `Variant ${variant + 1}`
}));
vi.mock('../src/core/rewalk', () => ({ setRewalkVoice: vi.fn() }));
vi.mock('../src/core/version', () => ({ APP_VERSION: 'test' }));
vi.mock('../src/core/shareEnv', () => ({ exportImage: mocks.exportImage }));
vi.mock('../src/ui/install', () => ({ openInstallGuide: vi.fn(), installSettingsInfo: () => ({ installed: false }) }));
vi.mock('../src/ui/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/helpers')>();
  return { ...actual, modal: mocks.modal, toast: mocks.toast, confirmModal: vi.fn(), filePicker: vi.fn() };
});

import { createSettingsView } from '../src/ui/settings';

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function promoResult(variant: number, label: string) {
  return {
    variant,
    blob: new Blob([label], { type: 'image/png' }),
    filename: `roametch-promo-${variant + 1}-${label}.png`,
    caption: `caption ${variant} ${label}`
  };
}

function button(root: ParentNode, text: string) {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes(text));
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

async function openPreview(result = promoResult(7, 'initial')) {
  mocks.generatePromo.mockResolvedValueOnce(result);
  const settings = createSettingsView(() => null);
  document.body.append(settings.view);
  button(settings.view, 'settings.promoAction').click();
  await vi.waitFor(() => expect(document.querySelector('.promo-preview-img')).not.toBeNull());
  return result;
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  let urlCount = 0;
  URL.createObjectURL = vi.fn(() => `blob:promo-${++urlCount}`);
  URL.revokeObjectURL = vi.fn();
  Object.defineProperty(navigator, 'share', { configurable: true, value: mocks.share });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.writeText } });
  mocks.share.mockResolvedValue(undefined);
  mocks.writeText.mockResolvedValue(undefined);
  mocks.exportImage.mockResolvedValue({ mode: 'download' });
  mocks.modal.mockImplementation(({ body, footer, onClose }) => {
    const backdrop = document.createElement('div');
    const box = document.createElement('div');
    const close = () => {
      if (!backdrop.isConnected) return;
      backdrop.remove();
      onClose?.();
    };
    box.append(body, ...(footer || []));
    backdrop.append(box);
    document.body.append(backdrop);
    return { close, box, backdrop };
  });
});

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('promo preview variant switcher', () => {
  it('uses a dedicated responsive action group with wrapped labels', async () => {
    await openPreview();
    const modalOptions = mocks.modal.mock.calls[0][0];
    expect(modalOptions.wide).toBe(true);
    expect(document.querySelector('.promo-modal')).not.toBeNull();
    const actions = document.querySelector('.promo-actions')!;
    expect(actions.children).toHaveLength(4);
    for (const action of actions.querySelectorAll('button')) {
      expect(action.querySelector('.promo-action-icon svg')).not.toBeNull();
      expect(action.querySelector('.promo-action-label')?.textContent).toBeTruthy();
    }
  });

  it('keeps three aligned actions when file sharing is unavailable', async () => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
    await openPreview();
    const actions = document.querySelector('.promo-actions')!;
    expect(actions.classList.contains('three')).toBe(true);
    expect(actions.children).toHaveLength(3);
    expect(actions.querySelector('.primary')?.textContent).toContain('settings.promoDownload');
  });

  it('cycles sequentially and keeps image, save, copy, share and object URL state together', async () => {
    const initial = await openPreview();
    const second = promoResult(8, 'second');
    const third = promoResult(9, 'third');
    mocks.generatePromo.mockResolvedValueOnce(second).mockResolvedValueOnce(third);
    const img = document.querySelector<HTMLImageElement>('.promo-preview-img')!;
    const next = button(document.body, 'settings.promoNext');

    next.click();
    await vi.waitFor(() => expect(img.dataset.variant).toBe('8'));
    expect(mocks.generatePromo).toHaveBeenNthCalledWith(2, 8);
    expect(img.src).toBe('blob:promo-2');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:promo-1');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:promo-2');

    button(document.body, 'settings.promoDownload').click();
    await vi.waitFor(() => expect(mocks.exportImage).toHaveBeenCalledWith(second.blob, second.filename));
    button(document.body, 'settings.promoCopy').click();
    await vi.waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith(second.caption));
    button(document.body, 'settings.promoShare').click();
    await vi.waitFor(() => expect(mocks.share).toHaveBeenCalled());
    const shared = mocks.share.mock.calls[0][0];
    expect(shared.text).toBe(second.caption);
    expect(shared.files[0].name).toBe(second.filename);

    next.click();
    await vi.waitFor(() => expect(img.dataset.variant).toBe('9'));
    expect(mocks.generatePromo).toHaveBeenNthCalledWith(3, 9);
    expect(img.src).toBe('blob:promo-3');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:promo-2');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:promo-3');

    mocks.modal.mock.results[0].value.close();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:promo-3');
    expect(initial.variant).toBe(7);
  });

  it('lists all 25 designs and switches directly to an audience variant', async () => {
    await openPreview(promoResult(0, 'initial'));
    const select = document.querySelector<HTMLSelectElement>('.promo-variant-select')!;
    expect(select.options).toHaveLength(25);
    expect(select.querySelectorAll('option')[8].textContent).toContain('Variant 9');
    expect(document.querySelector('.promo-variant-index')?.textContent).toBe('settings.promoVariantIndex');

    const audience = promoResult(8, 'audience');
    mocks.generatePromo.mockResolvedValueOnce(audience);
    select.value = '8';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector<HTMLImageElement>('.promo-preview-img')?.dataset.variant).toBe('8'));
    expect(mocks.generatePromo).toHaveBeenLastCalledWith(8);
    expect(select.value).toBe('8');
    expect(select.disabled).toBe(false);

    button(document.body, 'settings.promoDownload').click();
    await vi.waitFor(() => expect(mocks.exportImage).toHaveBeenCalledWith(audience.blob, audience.filename));
    button(document.body, 'settings.promoCopy').click();
    await vi.waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith(audience.caption));
  });

  it('wraps from the final audience design back to the first feature design', async () => {
    await openPreview(promoResult(24, 'final'));
    const first = promoResult(0, 'first');
    mocks.generatePromo.mockResolvedValueOnce(first);
    button(document.body, 'settings.promoNext').click();
    await vi.waitFor(() => expect(mocks.generatePromo).toHaveBeenLastCalledWith(0));
    expect(document.querySelector<HTMLImageElement>('.promo-preview-img')?.dataset.variant).toBe('0');
    expect(document.querySelector<HTMLSelectElement>('.promo-variant-select')?.value).toBe('0');
  });

  it('retains the current promo and URL when regeneration fails', async () => {
    await openPreview(promoResult(2, 'initial'));
    const error = new Error('render failed');
    mocks.generatePromo.mockRejectedValueOnce(error);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const img = document.querySelector<HTMLImageElement>('.promo-preview-img')!;
    const next = button(document.body, 'settings.promoNext');

    next.click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('settings.promoFailed', 'err'));
    expect(img.dataset.variant).toBe('2');
    expect(img.src).toBe('blob:promo-1');
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(next.disabled).toBe(false);
  });

  it('does not create or revoke a new URL after closing during generation', async () => {
    await openPreview(promoResult(0, 'initial'));
    const pending = deferred<ReturnType<typeof promoResult>>();
    mocks.generatePromo.mockReturnValueOnce(pending.promise);
    button(document.body, 'settings.promoNext').click();
    await vi.waitFor(() => expect(mocks.generatePromo).toHaveBeenCalledWith(1));

    mocks.modal.mock.results[0].value.close();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:promo-1');
    pending.resolve(promoResult(1, 'late'));
    await Promise.resolve();
    await Promise.resolve();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});
