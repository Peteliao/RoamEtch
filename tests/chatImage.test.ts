import { describe, expect, it } from 'vitest';
import {
  CHAT_IMAGE_MAX_BASE64,
  CHAT_IMAGE_MAX_BYTES,
  CHAT_IMAGE_MAX_EDGE,
  LOCAL_IMAGE_MAX_BYTES,
  LOCAL_IMAGE_MAX_PIXELS,
  chatImageLadder,
  readChatImageHeader,
  readLocalImageHeader,
  sanitizeChatImagePacket
} from '../src/core/chatImage';

const packet = () => ({
  im: btoa('weak-network-photo'),
  imt: 'image/webp',
  imw: 720,
  imh: 540,
  la: 31.23,
  lo: 121.47,
  ac: 8
});

describe('chat image compression ladder', () => {
  it('starts at 720px and steps down in quality and size', () => {
    const ladder = chatImageLadder();
    expect(ladder[0]).toEqual({ maxEdge: 720, quality: 0.65 });
    expect(ladder.at(-1)).toEqual({ maxEdge: 360, quality: 0.32 });
    expect(ladder).toHaveLength(16);
  });

  it('uses the 480px low-data tier', () => {
    const ladder = chatImageLadder(true);
    expect(ladder[0]).toEqual({ maxEdge: 480, quality: 0.65 });
    expect(ladder.at(-1)).toEqual({ maxEdge: 320, quality: 0.32 });
  });
});

describe('chat image packet validation', () => {
  it('accepts a valid image with a valid WGS-84 fix', () => {
    const input = packet();
    expect(sanitizeChatImagePacket(input)).toEqual({
      base64: input.im,
      mime: input.imt,
      width: input.imw,
      height: input.imh,
      lat: input.la,
      lon: input.lo,
      acc: input.ac
    });
  });

  it('accepts JPEG without coordinates', () => {
    const value = sanitizeChatImagePacket({ im: btoa('jpeg'), imt: 'image/jpeg', imw: 480, imh: 320 });
    expect(value).toMatchObject({ mime: 'image/jpeg', width: 480, height: 320, lat: null, lon: null, acc: null });
  });

  it.each([
    ['missing payload', { im: '' }],
    ['invalid base64', { im: 'not base64!' }],
    ['oversized payload', { im: 'A'.repeat(CHAT_IMAGE_MAX_BASE64 + 4) }],
    ['wrong MIME', { imt: 'image/svg+xml' }],
    ['fractional width', { imw: 720.5 }],
    ['zero height', { imh: 0 }],
    ['excessive dimensions', { imw: 4097 }]
  ])('rejects %s', (_name, patch) => {
    expect(sanitizeChatImagePacket({ ...packet(), ...patch })).toBeNull();
  });

  it('enforces the decoded 56 KB byte limit', () => {
    const maxBase64 = Math.ceil(CHAT_IMAGE_MAX_BYTES / 3) * 4;
    expect(sanitizeChatImagePacket({ ...packet(), im: 'A'.repeat(maxBase64) })).toBeNull();
  });

  it('drops invalid coordinates and accuracy instead of accepting abuse', () => {
    expect(sanitizeChatImagePacket({ ...packet(), la: 91, lo: 181, ac: -1 }))
      .toMatchObject({ lat: null, lon: null, acc: null });
    expect(sanitizeChatImagePacket({ ...packet(), la: 0, lo: 0, ac: 10_001 }))
      .toMatchObject({ lat: 0, lon: 0, acc: null });
  });

  it.each([
    ['null pair', { la: null, lo: null }],
    ['missing latitude', { la: undefined, lo: 121.47 }],
    ['empty strings', { la: '', lo: '' }],
    ['partial pair', { la: 31.23, lo: null }]
  ])('does not turn %s into a Gulf of Guinea fix', (_name, patch) => {
    expect(sanitizeChatImagePacket({ ...packet(), ...patch }))
      .toMatchObject({ lat: null, lon: null, acc: null });
  });

  it('enforces the intended long-edge and pixel budgets', () => {
    expect(sanitizeChatImagePacket({ ...packet(), imw: CHAT_IMAGE_MAX_EDGE + 1, imh: 480 })).toBeNull();
    expect(sanitizeChatImagePacket({ ...packet(), imw: CHAT_IMAGE_MAX_EDGE, imh: CHAT_IMAGE_MAX_EDGE })).not.toBeNull();
  });
});

function webpHeader(width: number, height: number) {
  const bytes = new Uint8Array(25);
  bytes.set(new TextEncoder().encode('RIFF'));
  new DataView(bytes.buffer).setUint32(4, 17, true);
  bytes.set(new TextEncoder().encode('WEBP'), 8);
  bytes.set(new TextEncoder().encode('VP8L'), 12);
  new DataView(bytes.buffer).setUint32(16, 5, true);
  bytes[20] = 0x2f;
  new DataView(bytes.buffer).setUint32(21, (width - 1) | ((height - 1) << 14), true);
  return bytes;
}

function jpegHeader(width: number, height: number) {
  const bytes = new Uint8Array(21);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height, false);
  view.setUint16(9, width, false);
  bytes[11] = 3;
  return bytes;
}

describe('chat image encoded headers', () => {
  it('reads bounded WebP and JPEG dimensions before pixel decoding', async () => {
    expect(await readChatImageHeader(new Blob([webpHeader(720, 480)]), 'image/webp')).toEqual({ width: 720, height: 480 });
    expect(await readChatImageHeader(new Blob([jpegHeader(480, 720)]), 'image/jpeg')).toEqual({ width: 480, height: 720 });
  });

  it('rejects oversized or malformed encoded dimensions', async () => {
    expect(await readChatImageHeader(new Blob([webpHeader(721, 480)]), 'image/webp')).toBeNull();
    expect(await readChatImageHeader(new Blob([jpegHeader(4096, 4096)]), 'image/jpeg')).toBeNull();
    expect(await readChatImageHeader(new Blob([new Uint8Array(25)]), 'image/webp')).toBeNull();
    expect(await readChatImageHeader(new Blob([jpegHeader(720, 480)]), 'image/webp')).toBeNull();
  });
});

function pngHeader(width: number, height: number) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set(new TextEncoder().encode('IHDR'), 12);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

describe('local album image headers', () => {
  it('accepts bounded JPEG, PNG and WebP sources before decoding', async () => {
    expect(await readLocalImageHeader(new Blob([jpegHeader(4032, 3024)], { type: 'image/jpeg' })))
      .toEqual({ mime: 'image/jpeg', width: 4032, height: 3024 });
    expect(await readLocalImageHeader(new Blob([pngHeader(3024, 4032)], { type: 'image/png' })))
      .toEqual({ mime: 'image/png', width: 3024, height: 4032 });
    expect(await readLocalImageHeader(new Blob([webpHeader(1920, 1080)], { type: 'image/webp' })))
      .toEqual({ mime: 'image/webp', width: 1920, height: 1080 });
  });

  it('rejects compression bombs, unsupported formats and oversized files', async () => {
    expect(await readLocalImageHeader(new Blob([jpegHeader(20_000, 20_000)]))).toBeNull();
    expect(await readLocalImageHeader(new Blob([pngHeader(30_000, 30_000)]))).toBeNull();
    expect(await readLocalImageHeader(new Blob([new Uint8Array([0x47, 0x49, 0x46, 0x38])], { type: 'image/gif' }))).toBeNull();
    expect(await readLocalImageHeader(new Blob([new Uint8Array(LOCAL_IMAGE_MAX_BYTES + 1)]))).toBeNull();
    expect(LOCAL_IMAGE_MAX_PIXELS).toBeLessThan(64 * 1000 * 1000);
  });
});
