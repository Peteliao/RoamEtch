import { describe, expect, it, vi } from 'vitest';
import { cameraFocusPoint, requestCameraFocus } from '../src/ui/cameraFocus';

const SUPPORTED = { focusMode: true, pointsOfInterest: true };

function fakeTrack(opts: {
  modes?: string[];
  pointsOfInterest?: boolean;
  reject?: boolean;
  confirm?: boolean;
  adoptedPoint?: { x: number; y: number };
} = {}) {
  let settings: { focusMode: string; pointsOfInterest: Array<{ x: number; y: number }> } = {
    focusMode: 'continuous',
    pointsOfInterest: []
  };
  const applyConstraints = vi.fn(async (constraints: any) => {
    if (opts.reject) throw new Error('unsupported');
    if (opts.confirm !== false) {
      settings = {
        focusMode: constraints.focusMode,
        pointsOfInterest: constraints.pointsOfInterest.map((point: { x: number; y: number }) => ({ ...point }))
      };
    }
  });
  const track = {
    applyConstraints,
    getCapabilities: vi.fn(() => ({
      focusMode: opts.modes ?? ['continuous', 'single-shot'],
      pointsOfInterest: opts.pointsOfInterest ?? true
    })),
    getSettings: vi.fn(() => ({
      ...settings,
      pointsOfInterest: settings.pointsOfInterest.map((point) => ({ ...point }))
    }))
  };
  return { track, applyConstraints };
}

describe('camera tap-to-focus coordinates', () => {
  const rect = { left: 20, top: 10, width: 430, height: 932 };

  it('maps the center of a cover-cropped landscape frame to the center POI', () => {
    expect(cameraFocusPoint(235, 476, rect, 1920, 1080)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('accounts for horizontal cropping instead of normalizing against the whole element', () => {
    const croppedEdge = (1 - (rect.width / rect.height) / (1920 / 1080)) / 2;
    expect(cameraFocusPoint(rect.left, rect.top, rect, 1920, 1080)?.x).toBeCloseTo(croppedEdge, 6);
    expect(cameraFocusPoint(rect.left + rect.width, rect.top, rect, 1920, 1080)?.x).toBeCloseTo(1 - croppedEdge, 6);
    expect(cameraFocusPoint(rect.left, rect.top, rect, 1920, 1080)?.y).toBe(0);
    expect(cameraFocusPoint(rect.left, rect.top + rect.height, rect, 1920, 1080)?.y).toBe(1);
  });

  it('accounts for vertical cropping in a landscape viewport', () => {
    const landscape = { left: 0, top: 0, width: 932, height: 430 };
    const croppedEdge = (1 - (landscape.height / landscape.width) / (1920 / 1080)) / 2;
    expect(cameraFocusPoint(0, 0, landscape, 1080, 1920)?.y).toBeCloseTo(croppedEdge, 6);
    expect(cameraFocusPoint(0, 430, landscape, 1080, 1920)?.y).toBeCloseTo(1 - croppedEdge, 6);
    expect(cameraFocusPoint(0, 0, landscape, 1080, 1920)?.x).toBe(0);
    expect(cameraFocusPoint(932, 0, landscape, 1080, 1920)?.x).toBe(1);
  });

  it('clamps out-of-frame taps and rejects invalid dimensions', () => {
    expect(cameraFocusPoint(-1_000, -1_000, rect, 1920, 1080)).toEqual({ x: 0, y: 0 });
    expect(cameraFocusPoint(10_000, 10_000, rect, 1920, 1080)).toEqual({ x: 1, y: 1 });
    expect(cameraFocusPoint(0, 0, rect, 0, 1080)).toBeNull();
    expect(cameraFocusPoint(Number.NaN, 0, rect, 1920, 1080)).toBeNull();
  });
});

describe('camera focus capability degradation', () => {
  it('prefers continuous focus and confirms the adopted POI from getSettings', async () => {
    const { track, applyConstraints } = fakeTrack({ modes: ['single-shot', 'continuous'] });
    await expect(requestCameraFocus(track, { x: 0.25, y: 0.75 }, SUPPORTED)).resolves.toBe(true);
    expect(applyConstraints).toHaveBeenCalledWith({
      focusMode: 'continuous',
      pointsOfInterest: [{ x: 0.25, y: 0.75 }]
    });
    expect(track.getSettings).toHaveBeenCalled();
  });

  it('uses single-shot when continuous focus is unavailable', async () => {
    const { track, applyConstraints } = fakeTrack({ modes: ['single-shot'] });
    await expect(requestCameraFocus(track, { x: 0.5, y: 0.5 }, SUPPORTED)).resolves.toBe(true);
    expect(applyConstraints).toHaveBeenCalledWith({
      focusMode: 'single-shot',
      pointsOfInterest: [{ x: 0.5, y: 0.5 }]
    });
  });

  it('does not call applyConstraints when either standard constraint is unsupported', async () => {
    for (const supported of [null, {}, { focusMode: true }, { pointsOfInterest: true },
      { focusMode: false, pointsOfInterest: true }, { focusMode: true, pointsOfInterest: false }]) {
      const { track, applyConstraints } = fakeTrack();
      await expect(requestCameraFocus(track, { x: 0.5, y: 0.5 }, supported)).resolves.toBe(false);
      expect(applyConstraints).not.toHaveBeenCalled();
    }
  });

  it('degrades quietly when track capabilities or applyConstraints are missing', async () => {
    const noCapabilities = { applyConstraints: vi.fn(async () => {}) };
    await expect(requestCameraFocus(noCapabilities, { x: 0.5, y: 0.5 }, SUPPORTED)).resolves.toBe(false);
    expect(noCapabilities.applyConstraints).not.toHaveBeenCalled();

    const noPoi = fakeTrack({ pointsOfInterest: false });
    await expect(requestCameraFocus(noPoi.track, { x: 0.5, y: 0.5 }, SUPPORTED)).resolves.toBe(false);
    expect(noPoi.applyConstraints).not.toHaveBeenCalled();

    const noMode = fakeTrack({ modes: ['manual'] });
    await expect(requestCameraFocus(noMode.track, { x: 0.5, y: 0.5 }, SUPPORTED)).resolves.toBe(false);
    expect(noMode.applyConstraints).not.toHaveBeenCalled();

    await expect(requestCameraFocus({}, { x: 0.5, y: 0.5 }, SUPPORTED)).resolves.toBe(false);
  });

  it('returns false without success feedback when the constraint request is rejected', async () => {
    const { track, applyConstraints } = fakeTrack({ reject: true });
    await expect(requestCameraFocus(track, { x: 0.5, y: 0.5 }, SUPPORTED)).resolves.toBe(false);
    expect(applyConstraints).toHaveBeenCalledTimes(1);
    expect(track.getSettings).not.toHaveBeenCalled();
  });

  it('requires getSettings to adopt both the focus mode and the requested point', async () => {
    const unconfirmed = fakeTrack({ confirm: false });
    await expect(requestCameraFocus(unconfirmed.track, { x: 0.5, y: 0.5 }, SUPPORTED)).resolves.toBe(false);

    const wrongPoint = fakeTrack();
    wrongPoint.track.getSettings.mockReturnValue({ focusMode: 'continuous', pointsOfInterest: [{ x: 0.1, y: 0.1 }] });
    await expect(requestCameraFocus(wrongPoint.track, { x: 0.5, y: 0.5 }, SUPPORTED)).resolves.toBe(false);

    const wrongMode = fakeTrack();
    wrongMode.track.getSettings.mockReturnValue({ focusMode: 'single-shot', pointsOfInterest: [{ x: 0.5, y: 0.5 }] });
    await expect(requestCameraFocus(wrongMode.track, { x: 0.5, y: 0.5 }, SUPPORTED)).resolves.toBe(false);
  });

  it('rejects invalid POI coordinates before touching the track', async () => {
    const { track, applyConstraints } = fakeTrack();
    await expect(requestCameraFocus(track, { x: Number.NaN, y: 0.5 }, SUPPORTED)).resolves.toBe(false);
    expect(applyConstraints).not.toHaveBeenCalled();
  });
});
