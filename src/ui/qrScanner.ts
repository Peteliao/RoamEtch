// Live QR scanner for meetup invites. Keeps the camera in-page so closing the
// sheet never leaves a hidden capture session running.
import { t } from '../core/i18n';
import { decodeQrVideoFrame } from '../core/qr';
import { el, icon, trapFocus } from './helpers';
import { pushOverlayState, removeOverlayState } from './history';

export function openQrScanner(onResult: (text: string) => void) {
  let closed = false;
  let stream: MediaStream | null = null;
  let timer = 0;
  let scanning = false;
  let lastFrame = 0;

  const video = el('video', { class: 'qr-scan-video', autoplay: '', playsinline: '', muted: '' }) as HTMLVideoElement;
  video.muted = true;
  video.setAttribute('playsinline', '');
  (video as any).webkitPlaysinline = true;
  const scratch = document.createElement('canvas');
  const hint = el('div', { class: 'qr-scan-hint' }, t('meet.scanHint'));
  const status = el('div', { class: 'qr-scan-status' }, t('meet.scanStarting'));
  const retry = el('button', { class: 'qr-scan-retry', type: 'button', hidden: true }, icon('refresh', 16), t('common.retry'));
  const closeBtn = el('button', {
    class: 'qr-scan-close', type: 'button', 'aria-label': t('common.close'), onclick: () => close()
  }, icon('x', 22));
  const overlay = el('div', {
    class: 'qr-scan-overlay', role: 'dialog', 'aria-modal': 'true',
    'aria-label': t('meet.scanTitle'), tabindex: '-1'
  },
    video,
    el('div', { class: 'qr-scan-shade' }, el('div', { class: 'qr-scan-frame' })),
    el('div', { class: 'qr-scan-top' }, el('div', { class: 'qr-scan-title' }, t('meet.scanTitle')), closeBtn),
    el('div', { class: 'qr-scan-bottom' }, hint, status, retry)
  );
  document.body.append(overlay);

  const api = { close };
  let historyId = 0;
  let releaseFocus = () => {};

  function stop() {
    clearInterval(timer);
    timer = 0;
    scanning = false;
    if (stream) {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* already ended */ }
      }
    }
    stream = null;
    video.srcObject = null;
  }

  function close(fromHistory = false) {
    if (closed) return;
    closed = true;
    stop();
    releaseFocus();
    overlay.remove();
    removeOverlayState(historyId, { history: !fromHistory });
  }

  historyId = pushOverlayState(() => close(true));
  releaseFocus = trapFocus(overlay, { onEscape: () => close(), initial: closeBtn });

  function finish(text: string) {
    if (closed) return;
    close();
    onResult(text);
  }

  function fail(message: string) {
    if (closed) return;
    stop();
    status.textContent = message;
    status.classList.add('err');
    retry.hidden = false;
  }

  async function tick() {
    if (closed || scanning) return;
    if (video.readyState < 2 || !video.videoWidth) return;
    const now = Date.now();
    if (now - lastFrame < 140) return;
    lastFrame = now;
    scanning = true;
    try {
      const text = await decodeQrVideoFrame(video, scratch);
      if (text) finish(text);
    } finally {
      scanning = false;
    }
  }

  async function start() {
    retry.hidden = true;
    status.classList.remove('err');
    status.textContent = t('meet.scanStarting');
    if (!navigator.mediaDevices?.getUserMedia) {
      fail(t('meet.scanCameraFail'));
      return;
    }
    stop();
    status.hidden = false;
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      if (closed) {
        for (const track of media.getTracks()) track.stop();
        return;
      }
      stream = media;
      video.srcObject = media;
      try { await video.play(); } catch { /* frames may still arrive */ }
      await new Promise<void>((resolve) => {
        if (video.videoWidth) { resolve(); return; }
        let done = false;
        const finishLoad = () => {
          if (done) return;
          done = true;
          video.removeEventListener('loadedmetadata', finishLoad);
          video.removeEventListener('playing', finishLoad);
          resolve();
        };
        video.addEventListener('loadedmetadata', finishLoad);
        video.addEventListener('playing', finishLoad);
        setTimeout(finishLoad, 2500);
      });
      if (closed) return;
      status.hidden = true;
      timer = window.setInterval(() => { void tick(); }, 160);
      void tick();
    } catch (e: any) {
      const name = String(e?.name || '');
      fail(name === 'NotAllowedError' || name === 'SecurityError' ? t('meet.scanPermission') : t('meet.scanCameraFail'));
    }
  }

  retry.addEventListener('click', () => void start());
  void start();

  return api;
}
