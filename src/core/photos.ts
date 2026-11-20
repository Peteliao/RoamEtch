// Photo pipeline: read EXIF (GPS/time/orientation) -> rotate upright -> compress
// (long edge <= 1920 + 300px thumb) -> re-encode strips ALL EXIF. Original GPS never exported.
import exifr from 'exifr';

const LONG_EDGE = 1920;
const THUMB_EDGE = 300;

export async function readExif(file) {
  try {
    const data = await exifr.parse(file, { tiff: true, exif: true, gps: true });
    if (!data) return null;
    return {
      orientation: data.Orientation || 1,
      time: data.DateTimeOriginal ? new Date(data.DateTimeOriginal).getTime() : null,
      lat: data.latitude ?? null,
      lon: data.longitude ?? null
    };
  } catch {
    return null;
  }
}

function drawOriented(ctx, img, w, h, orientation) {
  // map EXIF orientation to canvas transform (output dims already swapped when needed)
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, h, w); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
    default: break;
  }
  ctx.drawImage(img, 0, 0, w, h);
}

async function loadBitmap(file): Promise<any> {
  if (createImageBitmap) {
    try { return await createImageBitmap(file); } catch { /* fall through */ }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function canvasToBlob(canvas, quality = 0.85) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', quality);
  });
}

/**
 * Returns { blob, thumb, width, height, exif }.
 * EXIF is read first; re-encoding via canvas guarantees stripped output.
 */
export async function processPhoto(file) {
  const exif = await readExif(file);
  const orientation = exif?.orientation || 1;
  const bmp = await loadBitmap(file);
  const srcW = bmp.width, srcH = bmp.height;
  const swap = orientation >= 5 && orientation <= 8;
  const outW0 = swap ? srcH : srcW;
  const outH0 = swap ? srcW : srcH;
  const scale = Math.min(1, LONG_EDGE / Math.max(outW0, outH0));
  const outW = Math.round(outW0 * scale);
  const outH = Math.round(outH0 * scale);

  const canvas = document.createElement('canvas');
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.save();
  // drawOriented expects pre-swap source dims; scale context for compression
  ctx.scale(scale, scale);
  drawOriented(ctx, bmp, srcW, srcH, orientation);
  ctx.restore();
  const blob = await canvasToBlob(canvas, 0.85);

  const tScale = Math.min(1, THUMB_EDGE / Math.max(outW, outH));
  const tCanvas = document.createElement('canvas');
  tCanvas.width = Math.round(outW * tScale);
  tCanvas.height = Math.round(outH * tScale);
  tCanvas.getContext('2d').drawImage(canvas, 0, 0, tCanvas.width, tCanvas.height);
  const thumb = await canvasToBlob(tCanvas, 0.7);

  if (bmp.close) bmp.close();
  return { blob, thumb, width: outW, height: outH, exif };
}