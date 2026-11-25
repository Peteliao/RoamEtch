// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/i18n', () => ({ t: (key: string) => key }));
vi.mock('../src/core/events', () => ({ on: vi.fn() }));

import { modal } from '../src/ui/helpers';

beforeEach(() => {
  document.body.innerHTML = '';
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
});

afterEach(() => {
  document.querySelectorAll('.modal-backdrop').forEach((node) => node.remove());
  vi.useRealTimers();
});

describe('modal accessibility', () => {
  it('exposes dialog semantics and moves initial focus to the dialog', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();

    const result = modal({ title: 'Trip actions', body: document.createElement('p') });
    const dialog = result.box;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Trip actions');
    expect(document.activeElement).toBe(dialog);
    expect(dialog.querySelector('.m-head .iconbtn')?.getAttribute('aria-label')).toBe('common.close');
    result.close();
  });

  it('traps Tab in both directions', () => {
    const first = document.createElement('button');
    const last = document.createElement('button');
    const result = modal({ title: 'Choices', body: [first, last] });
    const close = result.box.querySelector('.m-head .iconbtn');
    last.focus();
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(close);
    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(last);
    result.close();
  });

  it('closes only the topmost dialog on Escape and restores focus', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const first = modal({ title: 'First', body: document.createElement('p') });
    const second = modal({ title: 'Second', body: document.createElement('p') });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(second.backdrop.isConnected).toBe(false);
    expect(first.backdrop.isConnected).toBe(true);
    expect(document.activeElement).toBe(first.box);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(first.backdrop.isConnected).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
});
