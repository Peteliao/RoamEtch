// QR decoding shared by the live camera and photo-album join flows.
// BarcodeDetector is used when the browser has it; jsQR covers iOS Safari.
import jsQR from 'jsqr';
import { readLocalImageHeader } from './chatImage';

const VIDEO_SCAN_EDGE = 720;
const IMAGE_SCAN_EDGE = 1600;

type NativeDetector = {
  detect: (source: CanvasImageSource) => Promise<Array<{ rawValue?: string }>>;
};

let detectorPromise: Promise<NativeDetector | null> | null = null;

async function nativeDetector(): Promise<NativeDetector | null> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const BD = (window as any).BarcodeDetector;
      if (typeof BD !== 'function') return null;
      try {
        const formats = await BD.getSupportedFormats?.();
        if (formats && !formats.includes('qr_code')) return null;
        return new BD({ formats: ['qr_code'] }) as NativeDetector;
      } catch {
        return null;
      }
    })();
  }
  return detectorPromise;
}

function clean(text: unknown) {
  const value = String(text ?? '').trim();
  return value || null;
}

export function decodeQrPixels(data: Uint8ClampedArray, width: number, height: number) {
  if (!width || !height || data.length < width * height * 4) return null;
  try {
    return clean(jsQR(data, width, height, { inversionAttempts: 'attemptBoth' })?.data);
  } catch {
    return null;
  }
}

function scratchCanvas(width: number, height: number, maxEdge: number) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return { canvas, ctx, scale };
}

export async function decodeQrCanvas(canvas: HTMLCanvasElement) {
  const detector = await nativeDetector();
  if (detector) {
    try {
      const found = await detector.detect(canvas);
      const raw = clean(found?.[0]?.rawValue);
      if (raw) return raw;
    } catch {
      /* fall back to jsQR */
    }
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return decodeQrPixels(image.data, canvas.width, canvas.height);
}

export async function decodeQrVideoFrame(video: HTMLVideoElement, scratch: HTMLCanvasElement) {
  if (!video.videoWidth || !video.videoHeight) return null;
  const detector = await nativeDetector();
  if (detector) {
    try {
      const found = await detector.detect(video);
      const raw = clean(found?.[0]?.rawValue);
      if (raw) return raw;
    } catch {
      /* fall back to jsQR */
    }
  }
  const plan = scratchCanvas(video.videoWidth, video.videoHeight, VIDEO_SCAN_EDGE);
  if (!plan.ctx) return null;
  if (scratch.width !== plan.canvas.width || scratch.height !== plan.canvas.height) {
    scratch.width = plan.canvas.width;
    scratch.height = plan.canvas.height;
  }
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, scratch.width, scratch.height);
  const image = ctx.getImageData(0, 0, scratch.width, scratch.height);
  return decodeQrPixels(image.data, scratch.width, scratch.height);
}

async function loadImage(file: File): Promise<any> {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file); } catch { /* fall through */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode-failed')); };
    img.src = url;
  });
}

export async function decodeQrImageFile(file: File) {
  const header = await readLocalImageHeader(file);
  if (!header) return null;
  let img: any = null;
  try {
    img = await loadImage(file);
    const width = img.width || img.naturalWidth || header.width;
    const height = img.height || img.naturalHeight || header.height;
    const plan = scratchCanvas(width, height, IMAGE_SCAN_EDGE);
    if (!plan.ctx) return null;
    plan.ctx.drawImage(img, 0, 0, plan.canvas.width, plan.canvas.height);
    return await decodeQrCanvas(plan.canvas);
  } catch {
    return null;
  } finally {
    try { img?.close?.(); } catch { /* bitmap already closed */ }
  }
}
