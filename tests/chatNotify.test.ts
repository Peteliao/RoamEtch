import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('chat notification sound', () => {
  it('waits for a user gesture and disconnects finished audio nodes', async () => {
    const oscillators: any[] = [];
    const gains: any[] = [];
    const context = {
      state: 'running',
      currentTime: 0,
      destination: {},
      createOscillator: vi.fn(() => {
        const oscillator = {
          type: '', frequency: { setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn(),
          start: vi.fn(), stop: vi.fn(), onended: null as null | (() => void)
        };
        oscillators.push(oscillator);
        return oscillator;
      }),
      createGain: vi.fn(() => {
        const gain = {
          gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
          connect: vi.fn(), disconnect: vi.fn()
        };
        gains.push(gain);
        return gain;
      })
    };
    const AudioContext = vi.fn(function () { return context; });
    vi.stubGlobal('AudioContext', AudioContext);
    const notify = await import('../src/core/chatNotify');

    expect(notify.playChatNotificationSound()).toBe(false);
    expect(AudioContext).not.toHaveBeenCalled();
    expect(notify.unlockChatNotificationSound()).toBe(context);
    expect(notify.playChatNotificationSound()).toBe(true);
    expect(oscillators).toHaveLength(2);
    expect(gains).toHaveLength(2);
    expect(oscillators[0].start).toHaveBeenCalledOnce();
    expect(oscillators[1].stop).toHaveBeenCalledOnce();

    for (const oscillator of oscillators) oscillator.onended?.();
    for (const oscillator of oscillators) expect(oscillator.disconnect).toHaveBeenCalledOnce();
    for (const gain of gains) expect(gain.disconnect).toHaveBeenCalledOnce();
  });
});
