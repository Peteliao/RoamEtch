// WeChat / QQ WebView detection and export adaptation [v1.4].
import { t } from './i18n.js';
import { emit } from './events.js';
import { triggerDownload } from './gpx.js';

export const isWeChat = () => /MicroMessenger/i.test(navigator.userAgent);
export const isQQ = () => /QQ\//i.test(navigator.userAgent) && !isWeChat();
export const isEmbeddedWebView = () => isWeChat() || isQQ();

export function wechatFileGuidance() {
  emit('toast', { type: 'warn', msg: t('export.wechatFileHint') });
}

/**
 * Image export: WeChat blocks <a download> blobs → show long-pressable <img>.
 * Returns { mode: 'download' } | { mode: 'longpress', dataUrl }.
 */
export async function exportImage(blob, filename) {
  if (isEmbeddedWebView()) {
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
    return { mode: 'longpress', dataUrl };
  }
  triggerDownload(blob, filename);
  return { mode: 'download' };
}

export function exportFile(blob, filename) {
  if (isEmbeddedWebView()) {
    wechatFileGuidance();
    // still attempt; some WebViews allow it
  }
  triggerDownload(blob, filename);
}

export async function nativeShare({ title, text, url, files }) {
  if (!navigator.share) return false;
  try {
    const payload = { title, text, url };
    if (files && navigator.canShare?.({ files })) payload.files = files;
    await navigator.share(payload);
    return true;
  } catch {
    return false;
  }
}