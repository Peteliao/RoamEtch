// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  handlers: new Map<string, Array<(...args: any[]) => void>>(),
  rec: { status: 'idle' },
  overlay: false,
  toast: vi.fn()
}));

vi.mock('../src/core/i18n', () => ({ t: (key: string) => key }));
vi.mock('../src/core/recorder', () => ({ rec: harness.rec }));
vi.mock('../src/core/events', () => ({
  on: (name: string, callback: (...args: any[]) => void) => {
    const list = harness.handlers.get(name) || [];
    list.push(callback);
    harness.handlers.set(name, list);
    return () => {
      harness.handlers.set(name, (harness.handlers.get(name) || []).filter((entry) => entry !== callback));
    };
  }
}));
vi.mock('../src/ui/helpers', () => ({
  icon: () => document.createElement('span'),
  toast: harness.toast,
  hasOpenOverlay: () => harness.overlay,
  el: (tag: string, attrs: any = {}, ...children: any[]) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'style') Object.assign(node.style, value);
      else if (key.startsWith('on') && typeof value === 'function') (node as any)[key] = value;
      else if (value != null) node.setAttribute(key, String(value));
    }
    for (const child of children) {
      if (child == null) continue;
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }
}));

function worker() {
  return Object.assign(new EventTarget(), { state: 'installed', postMessage: vi.fn() });
}

function registration() {
  return Object.assign(new EventTarget(), {
    active: worker(), waiting: null as any, installing: null as any,
    update: vi.fn().mockResolvedValue(undefined)
  });
}

let reg: ReturnType<typeof registration>;
let serviceWorker: EventTarget & { register: ReturnType<typeof vi.fn>; controller: any };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('PROD', true);
  harness.handlers.clear();
  harness.rec.status = 'idle';
  harness.overlay = false;
  document.body.replaceChildren();
  reg = registration();
  serviceWorker = Object.assign(new EventTarget(), {
    register: vi.fn().mockResolvedValue(reg), controller: {}
  });
  vi.stubGlobal('navigator', { serviceWorker });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function init() {
  const updates = await import('../src/ui/updates');
  updates.initUpdates();
  await vi.waitFor(() => expect(serviceWorker.register).toHaveBeenCalledWith('./sw.js', { scope: './' }));
  await vi.waitFor(() => expect(reg.update).toHaveBeenCalled());
  return updates;
}

describe('service-worker update recovery', () => {
  it('finds an already waiting worker, shows the banner, and activates it promptly', async () => {
    reg.waiting = worker();
    await init();
    expect(document.querySelector('.update-bar')).not.toBeNull();
    expect(reg.waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect((document.querySelector('.update-bar .primary') as HTMLButtonElement).disabled).toBe(false);
  });

  it('defers activation and the update action while recording or paused', async () => {
    harness.rec.status = 'recording';
    reg.waiting = worker();
    const updates = await init();
    const waiting = reg.waiting;
    expect(waiting.postMessage).not.toHaveBeenCalled();
    const button = document.querySelector('.update-bar .primary') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    button.click();
    expect(waiting.postMessage).not.toHaveBeenCalled();

    harness.rec.status = 'finished';
    for (const callback of harness.handlers.get('recstatus:changed') || []) callback('finished');
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });

    // Dismissed notices can be surfaced again by a later lifecycle event.
    (document.querySelector('.update-bar .ghost') as HTMLButtonElement).click();
    updates.showUpdateNotice();
    expect(document.querySelector('.update-bar')).not.toBeNull();
  });

  it('discovers a newly installed waiting worker and blocks updates behind overlays', async () => {
    await init();
    const waiting = worker();
    reg.installing = waiting;
    reg.dispatchEvent(new Event('updatefound'));
    waiting.state = 'installed';
    waiting.dispatchEvent(new Event('statechange'));
    expect(document.querySelector('.update-bar')).not.toBeNull();
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });

    harness.overlay = true;
    const button = document.querySelector('.update-bar .primary') as HTMLButtonElement;
    button.click();
    expect(harness.toast).toHaveBeenCalledWith('update.blockedBusy', 'warn');
  });
});
