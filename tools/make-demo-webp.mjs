// Builds the bilingual README demo (animated WebP) from a real ?sim=1 session.
// Frames are captured with Playwright, encoded as lossy WebP by Chromium, and
// muxed into a RIFF animation container. No Pillow/ImageMagick/ffmpeg needed.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 5198;
const BASE = `http://127.0.0.1:${PORT}`;
const FRAMES = Number(process.env.DEMO_FRAMES || 42);
const RESULT_FRAMES = Number(process.env.DEMO_RESULT_FRAMES || 12);
const RENAME_FRAMES = Number(process.env.DEMO_RENAME_FRAMES || 8);
const RESET_FRAMES = Number(process.env.DEMO_RESET_FRAMES || 14);
const TOTAL_FRAMES = FRAMES + RESULT_FRAMES + RENAME_FRAMES + RESET_FRAMES;
const FRAME_MS = Number(process.env.DEMO_FRAME_MS || 160);
const WIDTH = Number(process.env.DEMO_WIDTH || 540);
const QUALITY = Number(process.env.DEMO_QUALITY || 0.58);

const LOCALES = [
  {
    id: 'zh',
    settings: { language: 'zh', theme: 'dark', sim: { enabled: true, playbackSpeed: 90 } }
  },
  {
    id: 'en',
    settings: { language: 'en', theme: 'dark', sim: { enabled: true, playbackSpeed: 90 } }
  }
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch { /* not ready */ }
    await wait(500);
  }
  throw new Error('vite dev server did not start');
}

function u24(value) {
  const b = Buffer.alloc(3);
  b.writeUIntLE(value, 0, 3);
  return b;
}

function chunk(id, data) {
  const header = Buffer.alloc(8);
  header.write(id, 0, 4, 'ascii');
  header.writeUInt32LE(data.length, 4);
  const pad = data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([header, data, pad]);
}

function parseWebP(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error('frame is not a WebP file');
  }
  const chunks = [];
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const end = off + 8 + size;
    if (end > buf.length) throw new Error(`truncated WebP chunk ${id}`);
    chunks.push({ id, data: buf.subarray(off + 8, end) });
    off = end + (size % 2);
  }
  return chunks;
}

function animationWebP(frames, width, height, frameMs) {
  const hasAlpha = frames.some((frame) => frame.some((c) => c.id === 'ALPH'));
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x02 | (hasAlpha ? 0x10 : 0);
  vp8x.writeUIntLE(width - 1, 4, 3);
  vp8x.writeUIntLE(height - 1, 7, 3);

  const anim = Buffer.alloc(6);
  anim.writeUInt32LE(0, 0);
  anim.writeUInt16LE(0, 4);

  const parts = [chunk('VP8X', vp8x), chunk('ANIM', anim)];
  for (const chunks of frames) {
    const header = Buffer.alloc(16);
    header.writeUIntLE(0, 0, 3);
    header.writeUIntLE(0, 3, 3);
    header.writeUIntLE(width - 1, 6, 3);
    header.writeUIntLE(height - 1, 9, 3);
    header.writeUIntLE(frameMs, 12, 3);
    header[15] = hasAlpha ? 0x00 : 0x02;
    const payload = Buffer.concat([header, ...chunks.map((c) => chunk(c.id, c.data))]);
    parts.push(chunk('ANMF', payload));
  }

  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), ...parts]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

async function encodeFrame(page, png, width, quality) {
  return page.evaluate(async ({ b64, width, quality }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = Math.round((img.height * width) / img.width);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/webp', quality);
    return {
      b64: url.slice(url.indexOf(',') + 1),
      width: canvas.width,
      height: canvas.height
    };
  }, { b64: png.toString('base64'), width, quality });
}

async function main() {
  const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const server = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore'
  });

  let browser;
  try {
    await waitForServer();
    browser = await chromium.launch();
    const encoder = await browser.newPage({ viewport: { width: 120, height: 120 } });

    for (const locale of LOCALES) {
      const context = await browser.newContext({
        locale: locale.id === 'zh' ? 'zh-CN' : 'en-US',
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        colorScheme: 'dark'
      });
      await context.addInitScript((settings) => {
        try {
          localStorage.setItem('localtrace.settings.v1', JSON.stringify(settings));
        } catch { /* storage unavailable */ }
      }, locale.settings);
      const page = await context.newPage();

      await page.goto(`${BASE}/?sim=1`);
      await page.addStyleTag({ content: '#toast-root { display: none !important; }' });
      await page.locator('#view-record.active').waitFor({ timeout: 30_000 });
      await page.locator('.rec-btn.stop').waitFor({ timeout: 20_000 });
      await page.locator('.maplibregl-canvas').first().waitFor({ timeout: 30_000 });
      await page.locator('.live-panel .lp-head').click();
      // Keep the real UI but drop debug-only chrome from the promo frames.
      await page.evaluate(() => {
        document.querySelector('.live-panel .lp-save')?.remove();
        const status = document.querySelector('.live-panel .lp-head .st');
        if (!status) return;
        const clean = () => {
          const at = status.textContent.indexOf(' · ');
          if (at > 0) status.textContent = status.textContent.slice(0, at);
        };
        clean();
        new MutationObserver(clean).observe(status, { childList: true, characterData: true, subtree: true });
      });
      await wait(8000);

      const frames = [];
      let size = null;
      const capture = async (label, count) => {
        for (let i = 0; i < count; i++) {
          const png = await page.screenshot({ type: 'png' });
          const encoded = await encodeFrame(encoder, png, WIDTH, QUALITY);
          const webp = Buffer.from(encoded.b64, 'base64');
          size = { width: encoded.width, height: encoded.height };
          frames.push(parseWebP(webp).filter((c) => c.id === 'ALPH' || c.id === 'VP8 ' || c.id === 'VP8L'));
          await page.waitForTimeout(120);
          process.stdout.write(`\r${locale.id}: ${label} frame ${i + 1}/${count} (${frames.length}/${TOTAL_FRAMES})`);
        }
      };
      await capture('recording', FRAMES);

      await page.locator('.rec-btn.stop').click();
      const result = page.locator('.record-result-sheet');
      await result.waitFor({ timeout: 30_000 });
      await capture('default name', RESULT_FRAMES);

      await result.locator('input[type="text"]').fill(locale.id === 'zh' ? '香山环线' : 'Xiangshan Loop');
      await wait(300);
      await capture('rename', RENAME_FRAMES);

      await result.locator('[data-result-action="done"]').click();
      await result.waitFor({ state: 'detached', timeout: 30_000 });
      const resetState = await page.evaluate(() => {
        const buttons = {
          node: document.querySelector('.rec-btn.node'),
          pause: document.querySelector('.rec-btn.pause'),
          stop: document.querySelector('.rec-btn.stop'),
          start: document.querySelector('.rec-pill.start'),
          activity: document.querySelector('.rec-buttons select.rec-pill')
        };
        return {
          status: window.__lt.recorder.rec.status,
          hidden: Object.fromEntries(Object.entries(buttons).map(([key, node]) => [key, !!node?.hidden])),
          activity: buttons.activity?.value
        };
      });
      if (resetState.status !== 'finished' || !resetState.hidden.node || !resetState.hidden.pause ||
          !resetState.hidden.stop || resetState.hidden.start || resetState.hidden.activity || resetState.activity !== 'auto') {
        throw new Error(`${locale.id}: finish flow did not reset the recording controls: ${JSON.stringify(resetState)}`);
      }
      await capture('ready for next trip', RESET_FRAMES);
      await context.close();

      const out = animationWebP(frames, size.width, size.height, FRAME_MS);
      const maxBytes = 2 * 1024 * 1024;
      if (out.length > maxBytes) {
        throw new Error(`${locale.id} demo is ${(out.length / 1048576).toFixed(2)} MB; raise compression`);
      }
      const target = join(ROOT, 'docs', 'screenshots', locale.id, 'demo.webp');
      mkdirSync(join(ROOT, 'docs', 'screenshots', locale.id), { recursive: true });
      writeFileSync(target, out);
      process.stdout.write(
        `\n${locale.id}: ${size.width}x${size.height}, ${TOTAL_FRAMES} frames, ` +
        `${(FRAME_MS * TOTAL_FRAMES / 1000).toFixed(1)}s, ${(out.length / 1024).toFixed(0)} KB → ${target}\n`
      );
    }
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
