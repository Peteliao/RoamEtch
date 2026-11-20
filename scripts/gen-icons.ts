// Generates PWA PNG icons from the same vector design as icon.svg (pure Node, no deps).
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BG = hex('#0b1220'), ROUTE = hex('#2dd4a7'), END = hex('#f5b942'), DOT = hex('#e8eef7');

function cubic(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
  ];
}
const segs = [];
const curves = [
  [[120, 392], [168, 300], [150, 232], [216, 208]],
  [[216, 208], [282, 184], [320, 260], [352, 196]],
  [[352, 196], [384, 132], [372, 128], [400, 112]]
];
for (const c of curves) {
  let prev = c[0];
  for (let i = 1; i <= 48; i++) {
    const p = cubic(c[0], c[1], c[2], c[3], i / 48);
    segs.push([prev, p]);
    prev = p;
  }
}
function distSeg(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx, y = a[1] + t * dy;
  return Math.hypot(px - x, py - y);
}

function render(size) {
  const s = size / 512;
  const buf = Buffer.alloc(size * size * 4);
  const rr = 112 * s;
  const circles = [
    { x: 120 * s, y: 392 * s, r: 34 * s, c: ROUTE },
    { x: 400 * s, y: 112 * s, r: 34 * s, c: END },
    { x: 216 * s, y: 208 * s, r: 18 * s, c: DOT },
    { x: 352 * s, y: 196 * s, r: 18 * s, c: DOT }
  ];
  const strokeR = 15 * s;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      // rounded-rect coverage
      let cov = 1;
      const cx = Math.max(rr, Math.min(size - rr, px));
      const cy = Math.max(rr, Math.min(size - rr, py));
      const dCorner = Math.hypot(px - cx, py - cy);
      if (dCorner > rr - 0.5) cov = Math.max(0, Math.min(1, rr + 0.5 - dCorner));
      let r = 0, g = 0, b = 0, a = 0;
      if (cov > 0) { r = BG[0]; g = BG[1]; b = BG[2]; a = cov; }
      const blend = (color, alpha) => {
        if (alpha <= 0) return;
        const na = alpha + a * (1 - alpha);
        r = (color[0] * alpha + r * a * (1 - alpha)) / na;
        g = (color[1] * alpha + g * a * (1 - alpha)) / na;
        b = (color[2] * alpha + b * a * (1 - alpha)) / na;
        a = na;
      };
      let dMin = Infinity;
      for (const [p, q] of segs) {
        if (px < Math.min(p[0], q[0]) * s - strokeR - 1 || px > Math.max(p[0], q[0]) * s + strokeR + 1 ||
            py < Math.min(p[1], q[1]) * s - strokeR - 1 || py > Math.max(p[1], q[1]) * s + strokeR + 1) continue;
        const d = distSeg(px, py, [p[0] * s, p[1] * s], [q[0] * s, q[1] * s]);
        if (d < dMin) dMin = d;
      }
      blend(ROUTE, Math.max(0, Math.min(1, strokeR + 0.5 - dMin)));
      for (const c of circles) {
        const d = Math.hypot(px - c.x, py - c.y);
        blend(c.c, Math.max(0, Math.min(1, c.r + 0.5 - d)));
      }
      const i = (y * size + x) * 4;
      buf[i] = Math.round(r); buf[i + 1] = Math.round(g); buf[i + 2] = Math.round(b); buf[i + 3] = Math.round(a * 255);
    }
  }
  return buf;
}

for (const size of [192, 512]) {
  writeFileSync(join(outDir, `icon-${size}.png`), encodePNG(size, render(size)));
  console.log(`icon-${size}.png written`);
}