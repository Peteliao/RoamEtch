// Brand assets for exports: site URL, QR rendering and shared canvas fonts.
import qrcode from 'qrcode-generator';
import { t } from './i18n';

export const SITE_URL = 'https://peteliao.github.io/TrackMint/';
export const SPORT_FONT = '"Barlow Condensed", "Bahnschrift", "DIN Alternate", system-ui, sans-serif';

let fontsLoading: Promise<any> | null = null;
export function loadBrandFonts() {
  if (!fontsLoading) {
    fontsLoading = Promise.all([
      document.fonts.load(`700 40px "Barlow Condensed"`),
      document.fonts.load(`600 30px "Barlow Condensed"`)
    ]).catch(() => []);
  }
  return fontsLoading;
}

/**
 * Draw a scannable QR code (quiet zone included) at an exact pixel size.
 * Uses dark-on-white regardless of theme for reliable scanning.
 */
export function drawQr(ctx: CanvasRenderingContext2D, url: string, x: number, y: number, size: number) {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 2;
  const cell = size / (n + quiet * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = '#101820';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(x + (c + quiet) * cell, y + (r + quiet) * cell, cell + 0.4, cell + 0.4);
    }
  }
}

const SIG_KEYS = ['', 'Weak', 'Fair', 'Good', 'Strong'];

/** 4 ascending bars + label; baseline is the text baseline, bars sit above it. */
export function drawSignalChip(
  ctx: CanvasRenderingContext2D,
  x: number,
  baseline: number,
  level: number,
  colors: { on: string; off: string; text: string }
): number {
  const heights = [8, 12, 17, 23];
  const bw = 6, gap = 4;
  let bx = x;
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = i < level ? colors.on : colors.off;
    ctx.fillRect(bx, baseline - heights[i], bw, heights[i]);
    bx += bw + gap;
  }
  ctx.fillStyle = colors.text;
  ctx.font = '600 22px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textAlign = 'left';
  const label = `${t('panel.signal')} ${level ? t(`panel.sig${SIG_KEYS[level]}`) : '--'}`;
  ctx.fillText(label, bx + 4, baseline);
  return bx + 4 + ctx.measureText(label).width - x;
}

/**
 * Brand strip for exports: scannable QR of the experience site plus slogan,
 * URL and value line. Text is left-aligned next to the QR; returns total height.
 */
export function drawBrandBlock(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  qrSize: number,
  colors: { accent: string; text: string; muted: string },
  maxTextWidth = 0
) {
  drawQr(ctx, SITE_URL, x, y, qrSize);
  const tx = x + qrSize + Math.round(qrSize * 0.14);
  const s = qrSize / 110;               // text scale follows QR size
  const mw = maxTextWidth || undefined;
  ctx.textAlign = 'left';
  ctx.fillStyle = colors.accent;
  ctx.font = `700 ${Math.round(34 * s)}px ${SPORT_FONT}`;
  ctx.fillText(t('app.slogan'), tx, y + qrSize * 0.33, mw);
  ctx.fillStyle = colors.text;
  ctx.font = `600 ${Math.round(25 * s)}px ${SPORT_FONT}`;
  ctx.fillText(SITE_URL, tx, y + qrSize * 0.63, mw);
  ctx.fillStyle = colors.muted;
  ctx.font = `500 ${Math.round(21 * s)}px ${SPORT_FONT}`;
  ctx.fillText(`${t('app.scan')} · ${t('app.brandLine')}`, tx, y + qrSize * 0.92, mw);
  return Math.max(qrSize, Math.round(qrSize * 0.92 + 8 * s));
}
