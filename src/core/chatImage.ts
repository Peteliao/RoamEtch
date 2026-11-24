// Weak-network photo rules shared by the meetup session and the embedded camera.
// Images stay small because every byte is encrypted and base64-encoded twice
// before it crosses the relay.

export const CHAT_IMAGE_MAX_BYTES = 56 * 1024;
export const CHAT_IMAGE_MAX_BASE64 = Math.ceil(CHAT_IMAGE_MAX_BYTES * 4 / 3) + 16;
export const CHAT_IMAGE_COOLDOWN_MS = 5_000;
export const CHAT_IMAGE_KEEP = 20;
export const CHAT_IMAGE_MAX_EDGE = 720;
export const CHAT_IMAGE_MAX_PIXELS = 720 * 720;
export const CHAT_IMAGE_MIMES = ['image/webp', 'image/jpeg'];
export const LOCAL_IMAGE_MAX_BYTES = 32 * 1024 * 1024;
export const LOCAL_IMAGE_MAX_PIXELS = 40 * 1000 * 1000;
export const ORIGINAL_IMAGE_MIMES = ['image/jpeg', 'image/webp', 'image/png'];
const LOCAL_IMAGE_HEADER_BYTES = 1024 * 1024;
const ORIGINAL_META_KEYS = ['fid', 'hs', 'hm', 'hw', 'hh', 'hsh'];

export type ChatImagePayload = {
  base64: string;
  mime: string;
  width: number;
  height: number;
  lat: number | null;
  lon: number | null;
  acc: number | null;
  fileId?: string;
  hdSize?: number;
  hdMime?: string;
  hdWidth?: number;
  hdHeight?: number;
  hdSha256?: string;
};

export function chatImageLadder(lowData = false) {
  const sizes = lowData ? [480, 400, 320] : [720, 560, 440, 360];
  const qualities = [0.65, 0.5, 0.4, 0.32];
  const steps = [];
  for (const maxEdge of sizes) {
    for (const quality of qualities) steps.push({ maxEdge, quality });
  }
  return steps;
}

export function sanitizeChatOriginalMeta(msg: any) {
  const fileId = typeof msg?.fid === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(msg.fid) ? msg.fid : '';
  const sha256 = typeof msg?.hsh === 'string' && /^[A-Fa-f0-9]{64}$/.test(msg.hsh) ? msg.hsh.toLowerCase() : '';
  const size = Number(msg?.hs);
  const mime = String(msg?.hm || '');
  const width = Number(msg?.hw);
  const height = Number(msg?.hh);
  if (!fileId || !sha256 || !Number.isSafeInteger(size) || size < 1 || size > LOCAL_IMAGE_MAX_BYTES) return null;
  if (!ORIGINAL_IMAGE_MIMES.includes(mime)) return null;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 32_767 || height > 32_767) return null;
  if (width * height > LOCAL_IMAGE_MAX_PIXELS) return null;
  return { fileId, sha256, size, mime, width, height };
}

/** Validate an untrusted `msg` image packet. Returns null when unusable. */
export function sanitizeChatImagePacket(msg: any): ChatImagePayload | null {
  const base64 = typeof msg?.im === 'string' ? msg.im.trim() : '';
  if (!base64 || base64.length > CHAT_IMAGE_MAX_BASE64 || base64.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  if (base64.length * 3 / 4 - padding > CHAT_IMAGE_MAX_BYTES) return null;
  const mime = String(msg?.imt || '');
  if (!CHAT_IMAGE_MIMES.includes(mime)) return null;
  const width = Number(msg?.imw);
  const height = Number(msg?.imh);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < 1 || height < 1 || width > CHAT_IMAGE_MAX_EDGE || height > CHAT_IMAGE_MAX_EDGE) return null;
  if (width * height > CHAT_IMAGE_MAX_PIXELS) return null;
  const latValue = msg?.la;
  const lonValue = msg?.lo;
  const lat = typeof latValue === 'number' ? latValue : Number.NaN;
  const lon = typeof lonValue === 'number' ? lonValue : Number.NaN;
  const hasFix = Number.isFinite(lat) && Number.isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  const accValue = msg?.ac;
  const acc = typeof accValue === 'number' ? accValue : Number.NaN;
  const hasOriginal = ORIGINAL_META_KEYS.some((key) => msg?.[key] != null);
  const original = hasOriginal ? sanitizeChatOriginalMeta(msg) : null;
  if (hasOriginal && !original) return null;
  return {
    base64,
    mime,
    width,
    height,
    lat: hasFix ? lat : null,
    lon: hasFix ? lon : null,
    acc: hasFix && Number.isFinite(acc) && acc >= 0 && acc <= 10_000 ? acc : null,
    ...(original ? {
      fileId: original.fileId,
      hdSize: original.size,
      hdMime: original.mime,
      hdWidth: original.width,
      hdHeight: original.height,
      hdSha256: original.sha256
    } : {})
  };
}

export async function sha256Hex(buffer: ArrayBuffer) {
  if (!crypto?.subtle) throw new Error('crypto-unavailable');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  return [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fourCC(bytes: Uint8Array, at: number) {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

function webpDimensions(view: DataView) {
  if (view.byteLength < 20 || fourCC(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), 0) !== 'RIFF'
    || fourCC(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), 8) !== 'WEBP') return null;
  let at = 12;
  while (at + 8 <= view.byteLength) {
    const type = fourCC(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (body + size > view.byteLength) return null;
    if (type === 'VP8X' && size >= 10) {
      return { width: 1 + view.getUint8(body + 4) + (view.getUint8(body + 5) << 8) + (view.getUint8(body + 6) << 16),
        height: 1 + view.getUint8(body + 7) + (view.getUint8(body + 8) << 8) + (view.getUint8(body + 9) << 16) };
    }
    if (type === 'VP8 ' && size >= 10 && view.getUint8(body + 3) === 0x9d && view.getUint16(body + 4, true) === 0x012a) {
      return { width: view.getUint16(body + 6, true) & 0x3fff, height: view.getUint16(body + 8, true) & 0x3fff };
    }
    if (type === 'VP8L' && size >= 5 && view.getUint8(body) === 0x2f) {
      const bits = view.getUint32(body + 1, true);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    at = body + size + (size & 1);
  }
  return null;
}

function jpegDimensions(view: DataView) {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
  let at = 2;
  while (at + 4 <= view.byteLength) {
    if (view.getUint8(at) !== 0xff) return null;
    let marker = view.getUint8(++at);
    while (marker === 0xff && ++at < view.byteLength) marker = view.getUint8(at);
    at++;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (at + 2 > view.byteLength) return null;
    const size = view.getUint16(at, false);
    if (size < 2 || at + size > view.byteLength) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (size < 7) return null;
      return { height: view.getUint16(at + 3, false), width: view.getUint16(at + 5, false) };
    }
    at += size;
  }
  return null;
}

function pngDimensions(view: DataView) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (view.byteLength < 24 || signature.some((byte, i) => view.getUint8(i) !== byte)
    || view.getUint32(8, false) !== 13 || fourCC(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), 12) !== 'IHDR') return null;
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

function dimensionsFor(view: DataView, mime: string) {
  if (mime === 'image/webp') return webpDimensions(view);
  if (mime === 'image/jpeg') return jpegDimensions(view);
  if (mime === 'image/png') return pngDimensions(view);
  return null;
}

function sniffImageMime(view: DataView) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (fourCC(bytes, 0) === 'RIFF' && fourCC(bytes, 8) === 'WEBP') return 'image/webp';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return '';
}

/** Check encoded headers before creating an object URL or decoding pixels. */
export async function readChatImageHeader(blob: Blob, mime: string) {
  if (!(blob instanceof Blob) || blob.size > CHAT_IMAGE_MAX_BYTES || !CHAT_IMAGE_MIMES.includes(mime)) return null;
  try {
    const view = new DataView(await blob.arrayBuffer());
    const size = dimensionsFor(view, mime);
    if (!size || size.width < 1 || size.height < 1
      || size.width > CHAT_IMAGE_MAX_EDGE || size.height > CHAT_IMAGE_MAX_EDGE
      || size.width * size.height > CHAT_IMAGE_MAX_PIXELS) return null;
    return size;
  } catch {
    return null;
  }
}

/** Bound local album inputs before the browser allocates decoded pixels. */
export async function readLocalImageHeader(blob: Blob) {
  if (!(blob instanceof Blob) || !blob.size || blob.size > LOCAL_IMAGE_MAX_BYTES) return null;
  try {
    const view = new DataView(await blob.slice(0, LOCAL_IMAGE_HEADER_BYTES).arrayBuffer());
    const mime = sniffImageMime(view);
    const size = dimensionsFor(view, mime);
    if (!size || size.width < 1 || size.height < 1 || size.width * size.height > LOCAL_IMAGE_MAX_PIXELS) return null;
    return { mime, ...size };
  } catch {
    return null;
  }
}
