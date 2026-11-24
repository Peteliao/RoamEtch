export type CameraFocusPoint = { x: number; y: number };

type VideoRect = { left: number; top: number; width: number; height: number };

type FocusCapabilities = {
  focusMode?: string | string[];
  pointsOfInterest?: boolean;
};

type FocusSettings = {
  focusMode?: string;
  pointsOfInterest?: CameraFocusPoint[];
};

export type CameraFocusTrack = {
  applyConstraints?: (constraints: any) => Promise<void>;
  getCapabilities?: () => any;
  getSettings?: () => any;
};

const FOCUS_MATCH_EPSILON = 0.02;

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

/** Map a tap on a centered object-fit:cover video to normalized camera POI coordinates. */
export function cameraFocusPoint(
  clientX: number,
  clientY: number,
  rect: VideoRect,
  videoWidth: number,
  videoHeight: number
): CameraFocusPoint | null {
  if (![clientX, clientY, rect.left, rect.top, rect.width, rect.height, videoWidth, videoHeight].every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0 || videoWidth <= 0 || videoHeight <= 0) return null;

  const scale = Math.max(rect.width / videoWidth, rect.height / videoHeight);
  const renderedWidth = videoWidth * scale;
  const renderedHeight = videoHeight * scale;
  const offsetX = (rect.width - renderedWidth) / 2;
  const offsetY = (rect.height - renderedHeight) / 2;
  return {
    x: clamp01((clientX - rect.left - offsetX) / renderedWidth),
    y: clamp01((clientY - rect.top - offsetY) / renderedHeight)
  };
}

function preferredFocusMode(track: CameraFocusTrack, supported: Record<string, unknown> | null | undefined) {
  if (!track.applyConstraints || supported?.focusMode !== true || supported?.pointsOfInterest !== true) return null;
  let caps: FocusCapabilities | null = null;
  try { caps = (track.getCapabilities?.() || null) as FocusCapabilities | null; } catch { return null; }
  if (caps?.pointsOfInterest !== true) return null;
  const raw = caps.focusMode;
  const modes = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  if (modes.includes('continuous')) return 'continuous';
  if (modes.includes('single-shot')) return 'single-shot';
  return null;
}

/**
 * Apply a standard POI focus request and confirm that the camera actually adopted it.
 * Unsupported, rejected, or unconfirmed requests quietly leave the camera in auto focus.
 */
export async function requestCameraFocus(
  track: CameraFocusTrack,
  point: CameraFocusPoint,
  supported: Record<string, unknown> | null | undefined
): Promise<boolean> {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  const mode = preferredFocusMode(track, supported);
  if (!mode) return false;
  const target = { x: clamp01(point.x), y: clamp01(point.y) };
  try {
    await track.applyConstraints({
      focusMode: mode,
      pointsOfInterest: [target]
    } as any);
  } catch {
    return false;
  }

  let settings: FocusSettings | null = null;
  try { settings = (track.getSettings?.() || null) as FocusSettings | null; } catch { return false; }
  if (settings?.focusMode !== mode || !Array.isArray(settings.pointsOfInterest)) return false;
  return settings.pointsOfInterest.some((poi) => Number.isFinite(poi?.x) && Number.isFinite(poi?.y)
    && Math.abs(poi.x - target.x) <= FOCUS_MATCH_EPSILON
    && Math.abs(poi.y - target.y) <= FOCUS_MATCH_EPSILON);
}
