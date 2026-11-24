import { describe, expect, it } from 'vitest';
import qrcode from 'qrcode-generator';
import { decodeQrPixels } from '../src/core/qr';

function qrPixels(text: string, scale = 8, quiet = 4) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const side = (count + quiet * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!qr.isDark(row, col)) continue;
      for (let y = 0; y < scale; y++) {
        const py = (row + quiet) * scale + y;
        for (let x = 0; x < scale; x++) {
          const px = (col + quiet) * scale + x;
          const at = (py * side + px) * 4;
          data[at] = 0; data[at + 1] = 0; data[at + 2] = 0; data[at + 3] = 255;
        }
      }
    }
  }
  return { data, width: side, height: side };
}

describe('QR decoding', () => {
  it('reads a meetup invite from camera-sized pixels', () => {
    const text = 'https://example.com/#meet=TM2.abcdefghijklmnopqrstuv.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk';
    const { data, width, height } = qrPixels(text);
    expect(decodeQrPixels(data, width, height)).toBe(text);
  });

  it('ignores empty or malformed pixel buffers', () => {
    expect(decodeQrPixels(new Uint8ClampedArray(0), 0, 0)).toBeNull();
    expect(decodeQrPixels(new Uint8ClampedArray(16), 10, 10)).toBeNull();
    expect(decodeQrPixels(new Uint8ClampedArray(100 * 100 * 4).fill(255), 100, 100)).toBeNull();
  });
});
