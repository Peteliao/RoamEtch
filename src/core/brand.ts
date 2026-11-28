// Brand assets for exports: site URL, QR rendering and shared canvas fonts.
import qrcode from 'qrcode-generator';
import { t } from './i18n';

export const SITE_URL = 'https://peteliao.github.io/RoamEtch/';
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

export function drawBrandMark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  colors: { bg?: string; accent?: string; amber?: string; dot?: string } = {}
) {
  const bg = colors.bg || '#101820';
  const accent = colors.accent || '#2bcda7';
  const amber = colors.amber || '#f5b942';
  const dotFill = colors.dot || '#f2f5f7';
  const r = size * 0.24;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, size, size, r);
  else ctx.rect(x, y, size, size);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 512, size / 512);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 30;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(120, 392);
  ctx.bezierCurveTo(168, 300, 150, 232, 216, 208);
  ctx.bezierCurveTo(282, 184, 320, 260, 352, 196);
  ctx.bezierCurveTo(368, 162, 372, 128, 400, 112);
  ctx.stroke();
  const dot = (dx: number, dy: number, radius: number, color: string) => {
    ctx.beginPath();
    ctx.arc(dx, dy, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  };
  dot(120, 392, 34, accent);
  dot(400, 112, 34, amber);
  dot(216, 208, 18, dotFill);
  dot(352, 196, 18, dotFill);
  ctx.restore();
}

function drawQrLogo(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, background = '#ffffff') {
  const pad = size * 0.12;
  ctx.fillStyle = background;
  ctx.fillRect(cx - size / 2 - pad, cy - size / 2 - pad, size + pad * 2, size + pad * 2);
  drawBrandMark(ctx, cx - size / 2, cy - size / 2, size);
}

/** Draw a scannable H-level QR with a quiet zone and centered brand mark. */
export function drawQr(ctx: CanvasRenderingContext2D, url: string, x: number, y: number, size: number, background = '#ffffff') {
  const qr = qrcode(0, 'H');
  qr.addData(url);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 2;
  const cell = size / (n + quiet * 2);
  ctx.fillStyle = background;
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = '#101820';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(x + (c + quiet) * cell, y + (r + quiet) * cell, cell + 0.4, cell + 0.4);
    }
  }
  drawQrLogo(ctx, x + size / 2, y + size / 2, size * 0.2, background);
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
  ctx.font = `700 ${Math.round(26 * s)}px ${SPORT_FONT}`;
  ctx.fillText(t('app.slogan1'), tx, y + qrSize * 0.22, mw);
  ctx.fillText(t('app.slogan2'), tx, y + qrSize * 0.50, mw);
  ctx.fillStyle = colors.text;
  ctx.font = `600 ${Math.round(24 * s)}px ${SPORT_FONT}`;
  ctx.fillText(SITE_URL, tx, y + qrSize * 0.70, mw);
  ctx.fillStyle = colors.muted;
  ctx.font = `500 ${Math.round(21 * s)}px ${SPORT_FONT}`;
  ctx.fillText(`${t('app.scan')} · ${t('app.brandLine')}`, tx, y + qrSize * 0.94, mw);
  return Math.max(qrSize, Math.round(qrSize * 0.92 + 8 * s));
}
