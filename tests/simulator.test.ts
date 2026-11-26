import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  handleFix: vi.fn(),
  emit: vi.fn()
}));

vi.mock('../src/core/recorder', () => ({
  startRecording: mocks.startRecording,
  stopRecording: mocks.stopRecording,
  handleFix: mocks.handleFix,
  rec: {}
}));
vi.mock('../src/core/settings', () => ({ get: vi.fn(() => 20) }));
vi.mock('../src/core/events', () => ({ emit: mocks.emit }));
vi.mock('../src/core/i18n', () => ({ t: vi.fn((key) => key) }));
vi.mock('../src/core/demo', () => ({ buildDemoPoints: vi.fn(() => []) }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  mocks.startRecording.mockResolvedValue(true);
  mocks.stopRecording.mockResolvedValue('trip-1');
  mocks.handleFix.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('scenario playback', () => {
  it('feeds generated fixes through the recorder with accelerated wall-clock timestamps', async () => {
    const { startScenario } = await import('../src/core/simulator');
    await expect(startScenario({
      scenario: 'hike',
      durationMs: 3000,
      sampleMs: 1000,
      startTime: 1000,
      playbackSpeed: 1
    })).resolves.toBe(true);

    await vi.advanceTimersByTimeAsync(5000);

    expect(mocks.startRecording).toHaveBeenCalledWith({
      simulated: true,
      name: 'record.simRecording · hike',
      activity: 'hike'
    });
    expect(mocks.handleFix).toHaveBeenCalledTimes(4);
    expect(mocks.handleFix.mock.calls.map(([fix]) => fix.t)).toEqual([10_000, 11_000, 12_000, 13_000]);
    expect(mocks.handleFix.mock.calls.every(([fix]) => fix.speed > 0)).toBe(true);
    expect(mocks.stopRecording).toHaveBeenCalledTimes(1);
    expect(mocks.emit).toHaveBeenCalledWith('sim:stopped');
  });

  it('emits network events while preserving the shared playback lock', async () => {
    const { startScenario, startPlayback, stopPlayback } = await import('../src/core/simulator');
    await startScenario({
      scenario: 'network-switch',
      durationMs: 120_000,
      sampleMs: 1000,
      startTime: 1000,
      playbackSpeed: 20
    });
    await vi.advanceTimersByTimeAsync(2600);

    expect(mocks.emit).toHaveBeenCalledWith('sim:event', expect.objectContaining({ type: 'network-offline' }));
    expect(mocks.emit).toHaveBeenCalledWith('sim:event', expect.objectContaining({ type: 'network-online' }));
    await expect(startPlayback({})).resolves.toBe(false);
    await stopPlayback();
  });

  it('validates a scenario before creating a recording', async () => {
    const { startScenario } = await import('../src/core/simulator');
    await expect(startScenario({ scenario: 'invalid' as any })).rejects.toThrow('unknown simulation scenario');
    expect(mocks.startRecording).not.toHaveBeenCalled();
  });
});
