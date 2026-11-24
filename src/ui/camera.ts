// Embedded camera: keeps the PWA in the foreground so geolocation keeps running.
// Chat shots are compressed to a weak-network budget; quick shots become photo
// waypoints. Album import is bounded before the browser decodes pixels.
import { t } from '../core/i18n';
import { el, icon } from './helpers';
import { armKeepAlive } from '../core/keepalive';
import { processPhoto } from '../core/photos';
import { saveOriginalPhoto } from '../core/deviceSave';
import { CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_MAX_EDGE, chatImageLadder, readLocalImageHeader } from '../core/chatImage';

export type CameraFix = {
  lat: number;
  lon: number;
  alt?: number | null;
  acc?: number | null;
};

export type CameraPhoto = {
  blob: Blob;
  thumb: Blob;
  width: number;
  height: number;
};

export type ChatCameraShot = CameraPhoto & {
  base64: string;
  mime: string;
  bytes: number;
  caption: string;
  fix: CameraFix | null;
};

export type QuickCameraShot = CameraPhoto & {
  takenAt: number;
  fix: CameraFix | null;
  original?: Blob;
  originalWidth?: number;
  originalHeight?: number;
};

export type QuickSaveResult = {
  ok: boolean;
  label?: string;
  thumbUrl?: string;
  undo?: () => Promise<boolean | void>;
};

type CameraMode = 'chat' | 'quick' | 'oled';

type CameraOptions = {
  mode: CameraMode;
  getFix: () => CameraFix | null | Promise<CameraFix | null>;
  onChatSend?: (shot: ChatCameraShot) => Promise<boolean>;
  onQuickSave?: (shot: QuickCameraShot) => Promise<QuickSaveResult>;
  idleCloseMs?: number;
};

const LOCAL_EDGE = 1600;
const THUMB_EDGE = 300;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let activeCamera: { close: () => void } | null = null;

export function cameraApiAvailable() {
  return !!navigator.mediaDevices?.getUserMedia;
}

function lowDataMode() {
  const c = (navigator as any).connection;
  return !!(c?.saveData) || c?.effectiveType === 'slow-2g' || c?.effectiveType === '2g';
}

function supportsWebp() {
  try {
    return document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    return false;
  }
}

function resizeCanvas(source: HTMLCanvasElement, maxEdge: number) {
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
  if (scale >= 1) return source;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(source.width * scale));
  out.height = Math.max(1, Math.round(source.height * scale));
  out.getContext('2d').drawImage(source, 0, 0, out.width, out.height);
  return out;
}

function canvasBlob(canvas: HTMLCanvasElement, type = 'image/jpeg', quality = 0.82) {
  return new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } catch {
      resolve(null);
    }
  });
}

async function compressChatShot(canvas: HTMLCanvasElement) {
  const type = supportsWebp() ? 'image/webp' : 'image/jpeg';
  let best: { blob: Blob; width: number; height: number; mime: string } | null = null;
  for (const step of chatImageLadder(lowDataMode())) {
    const sized = resizeCanvas(canvas, step.maxEdge);
    const blob = await canvasBlob(sized, type, step.quality);
    if (!blob?.size) continue;
    const candidate = {
      blob,
      width: sized.width,
      height: sized.height,
      mime: blob.type || type
    };
    if (!best || blob.size < best.blob.size) best = candidate;
    if (blob.size <= CHAT_IMAGE_MAX_BYTES) return { ...candidate, oversize: false };
  }
  return best ? { ...best, oversize: best.blob.size > CHAT_IMAGE_MAX_BYTES } : null;
}

async function encodeQuickPhoto(canvas: HTMLCanvasElement): Promise<CameraPhoto & { original: Blob; originalWidth: number; originalHeight: number }> {
  const main = resizeCanvas(canvas, LOCAL_EDGE);
  const [blob, full] = await Promise.all([
    canvasBlob(main, 'image/jpeg', 0.82),
    canvasBlob(canvas, 'image/jpeg', 0.92)
  ]);
  if (!blob) throw new Error('encode-failed');
  const thumbCanvas = resizeCanvas(main, THUMB_EDGE);
  const thumb = await canvasBlob(thumbCanvas, 'image/jpeg', 0.72);
  return {
    blob,
    thumb: thumb || blob,
    width: main.width,
    height: main.height,
    original: full || blob,
    originalWidth: canvas.width,
    originalHeight: canvas.height
  };
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      resolve(text.slice(text.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error || new Error('read-failed'));
    reader.readAsDataURL(blob);
  });
}

async function fileToCanvas(file: File, header?: { width: number; height: number }) {
  const size = header || await readLocalImageHeader(file);
  if (!size) throw new Error('image-too-large');
  return new Promise<HTMLCanvasElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const sourceWidth = img.naturalWidth || img.width;
      const sourceHeight = img.naturalHeight || img.height;
      const scale = Math.min(1, CHAT_IMAGE_MAX_EDGE / Math.max(sourceWidth, sourceHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode-failed'));
    };
    img.src = url;
  });
}

function albumFile() {
  return new Promise<File | null>((resolve) => {
    const input = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    input.addEventListener('change', () => {
      resolve(input.files?.[0] || null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

function vibrate(ms = 24) {
  try { navigator.vibrate?.(ms); } catch { /* unsupported */ }
}

export function openCamera(opts: CameraOptions) {
  if (activeCamera) return activeCamera;

  let closed = false;
  let stream: MediaStream | null = null;
  let streamSeq = 0;
  let facing: 'environment' | 'user' = 'environment';
  let torchOn = false;
  let videoReady = false;
  let busy = false;
  let shotCount = 0;
  let idleTimer = 0;
  let hintTimer = 0;
  let chipTimer = 0;
  let lockTimer = 0;
  let lockTick = 0;
  let preview: HTMLElement | null = null;
  let previewShot: ChatCameraShot | null = null;
  let previewSeq = 0;
  let previewUrl = '';
  let chipUrl = '';
  let fixCache: CameraFix | null = null;
  let fixPromise: Promise<CameraFix | null> | null = null;
  const ownedUrls = new Set<string>();

  const trackUrl = (url: string) => { ownedUrls.add(url); return url; };
  const releaseUrl = (url?: string) => {
    if (!url) return;
    try { URL.revokeObjectURL(url); } catch { /* already revoked */ }
    ownedUrls.delete(url);
  };

  const video = el('video', { class: 'cam-video', autoplay: '', playsinline: '', muted: '' }) as HTMLVideoElement;
  video.muted = true;
  video.setAttribute('playsinline', '');
  (video as any).webkitPlaysinline = true;

  const title = el('div', { class: 'cam-title' }, opts.mode === 'chat' ? t('camera.titleChat') : opts.mode === 'oled' ? t('camera.titleLocked') : t('camera.titleQuick'));
  const sub = el('div', { class: 'cam-sub' });
  const closeLabel = el('span', {}, opts.mode === 'chat' ? '' : t('camera.done'));
  const closeBtn = el('button', {
    class: 'cam-topbtn cam-close' + (opts.mode === 'chat' ? ' icon-only' : ''),
    type: 'button', 'aria-label': t('common.close'), onclick: () => closeCamera()
  }, opts.mode === 'chat' ? icon('x', 22) : null, closeLabel);
  const torchBtn = el('button', {
    class: 'cam-topbtn cam-torch', type: 'button', hidden: true,
    title: t('camera.torch'), 'aria-label': t('camera.torch')
  }, icon('flash', 20));
  torchBtn.addEventListener('click', () => void toggleTorch());

  const top = el('div', { class: 'cam-top' }, closeBtn, el('div', { class: 'cam-head' }, title, sub), torchBtn);
  const hint = el('div', { class: 'cam-hint' });
  const flash = el('div', { class: 'cam-flash' });
  const toastEl = el('div', { class: 'cam-toast', hidden: true });
  const chip = el('div', { class: 'cam-chip', hidden: true });

  const shutterDot = el('span', { class: 'cam-shutter-dot' });
  const shutter = el('button', { class: 'cam-shutter', type: 'button', 'aria-label': t('camera.shutter'), disabled: true }, shutterDot);
  const albumBtn = el('button', {
    class: 'cam-side', type: 'button', title: t('camera.album'), 'aria-label': t('camera.album')
  }, icon('photo', 23), el('span', {}, t('camera.album')));
  const flipBtn = el('button', {
    class: 'cam-side', type: 'button', title: t('camera.flip'), 'aria-label': t('camera.flip')
  }, icon('refresh', 23), el('span', {}, t('camera.flip')));
  const leftSlot = opts.mode === 'chat' ? albumBtn : el('span', { class: 'cam-side-spacer' });
  const bottom = el('div', { class: 'cam-bottom' }, leftSlot, shutter, flipBtn);
  const stage = el('div', { class: 'cam-stage' }, video, flash, top, hint, toastEl, chip, bottom);
  const overlay = el('div', { class: 'cam-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': title.textContent }, stage);
  document.body.append(overlay);

  const api = { close: () => closeCamera() };
  activeCamera = api;

  function closeCamera() {
    if (closed) return;
    closed = true;
    previewSeq++;
    clearTimeout(idleTimer);
    clearInterval(hintTimer);
    clearTimeout(chipTimer);
    clearInterval(lockTick);
    clearTimeout(lockTimer);
    stopStream();
    releaseUrl(previewUrl);
    previewUrl = '';
    releaseUrl(chipUrl);
    chipUrl = '';
    for (const url of [...ownedUrls]) releaseUrl(url);
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    activeCamera = null;
    // Opening a camera stream can pause the hidden keepalive video on iOS.
    armKeepAlive();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); closeCamera(); }
  }
  document.addEventListener('keydown', onKey);

  function resetIdle() {
    if (!opts.idleCloseMs) return;
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      if (closed) return;
      closeCamera();
    }, opts.idleCloseMs);
  }
  overlay.addEventListener('pointerdown', resetIdle, true);

  function setBusy(on: boolean) {
    busy = on;
    shutter.classList.toggle('busy', on);
    shutter.disabled = on || !videoReady || (opts.mode !== 'chat' && !fixCache);
  }

  async function readFix(refresh = false) {
    if (refresh) {
      fixCache = null;
      fixPromise = null;
    }
    if (fixCache) return fixCache;
    if (!fixPromise) {
      fixPromise = Promise.resolve().then(() => opts.getFix()).then((fix) => {
        const valid = fix && Number.isFinite(fix.lat) && Number.isFinite(fix.lon)
          && Math.abs(fix.lat) <= 90 && Math.abs(fix.lon) <= 180;
        return valid ? fix : null;
      }).catch(() => null).then((fix) => {
        if (fix) fixCache = fix;
        fixPromise = null;
        return fix;
      });
    }
    return fixPromise;
  }

  async function refreshHint() {
    if (closed || preview) return;
    const fix = await readFix();
    if (closed || preview) return;
    if (recCountHint()) {
      sub.textContent = t('camera.count', { n: shotCount });
    } else {
      sub.textContent = opts.mode === 'chat' ? t('camera.chatSub') : t('camera.quickSub');
    }
    if (opts.mode === 'chat') {
      hint.textContent = fix ? t('camera.fixOk') : t('camera.fixMissing');
    } else {
      hint.textContent = fix ? t('camera.fixOk') : t('camera.noFix');
      if (!busy) shutter.disabled = !videoReady || !fix;
    }
  }

  function recCountHint() {
    return opts.mode !== 'chat' && shotCount > 0;
  }

  function updateCount() {
    if (opts.mode === 'chat') return;
    closeLabel.textContent = shotCount > 0 ? t('camera.doneN', { n: shotCount }) : t('camera.done');
    refreshHint();
  }

  function camToast(text: string, type: 'info' | 'ok' | 'warn' | 'err' = 'info') {
    toastEl.textContent = text;
    toastEl.className = `cam-toast show ${type}`;
    clearTimeout((toastEl as any)._timer);
    (toastEl as any)._timer = setTimeout(() => {
      toastEl.className = 'cam-toast';
    }, 2600);
  }

  function stopTracks() {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      try { track.stop(); } catch { /* already ended */ }
    }
    stream = null;
    video.srcObject = null;
    videoReady = false;
    torchOn = false;
    torchBtn.hidden = true;
    torchBtn.classList.remove('active');
  }

  function stopStream() {
    streamSeq++;
    stopTracks();
    shutter.disabled = true;
  }

  function showFlash() {
    flash.classList.add('on');
    setTimeout(() => flash.classList.remove('on'), 110);
  }

  async function toggleTorch() {
    const track = stream?.getVideoTracks?.()[0];
    if (!track) return;
    try {
      torchOn = !torchOn;
      await track.applyConstraints({ advanced: [{ torch: torchOn } as any] });
      torchBtn.classList.toggle('active', torchOn);
    } catch {
      torchOn = false;
      torchBtn.classList.remove('active');
    }
  }

  async function setupTorch() {
    const track = stream?.getVideoTracks?.()[0];
    const caps = (track as any)?.getCapabilities?.();
    torchBtn.hidden = !(facing === 'environment' && caps?.torch);
  }

  async function startStream() {
    if (closed) return;
    const seq = ++streamSeq;
    stopTracks();
    if (!cameraApiAvailable()) {
      showCameraError(new Error('unsupported'));
      return;
    }
    videoReady = false;
    shutter.disabled = true;
    let pending: Promise<MediaStream>;
    try {
      pending = navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      });
    } catch (e) {
      showCameraError(e);
      return;
    }
    try {
      const media = await pending;
      if (closed || seq !== streamSeq) {
        for (const track of media.getTracks()) track.stop();
        return;
      }
      stream = media;
      video.srcObject = media;
      try { await video.play(); } catch { /* metadata still loads */ }
      await new Promise<void>((resolve) => {
        if (video.videoWidth) { resolve(); return; }
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          video.removeEventListener('loadedmetadata', finish);
          video.removeEventListener('playing', finish);
          resolve();
        };
        video.addEventListener('loadedmetadata', finish);
        video.addEventListener('playing', finish);
        setTimeout(finish, 1200);
      });
      // Let exposure settle before the shutter unlocks.
      await wait(250);
      if (closed || seq !== streamSeq) return;
      if (!video.videoWidth || !video.videoHeight) {
        showCameraError(new Error('no-frame'));
        return;
      }
      videoReady = true;
      stage.querySelector('.cam-error')?.remove();
      void setupTorch();
      refreshHint();
      setBusy(false);
      resetIdle();
    } catch (e) {
      if (closed || seq !== streamSeq) return;
      showCameraError(e);
    }
  }

  function showCameraError(err: any) {
    if (closed) return;
    stopTracks();
    shutter.disabled = true;
    const name = String(err?.name || err?.message || '');
    const titleKey = name === 'NotAllowedError' || name === 'SecurityError'
      ? 'camera.errPermission'
      : name === 'NotFoundError' || name === 'OverconstrainedError'
        ? 'camera.errMissing'
        : name === 'NotReadableError' || name === 'AbortError'
          ? 'camera.errBusy'
          : 'camera.errGeneric';
    const panel = el('div', { class: 'cam-error' },
      el('span', { class: 'cam-error-ic' }, icon('camera', 34)),
      el('h3', {}, t(titleKey)),
      el('p', {}, t('camera.errHint')),
      el('div', { class: 'cam-error-actions' },
        el('button', { class: 'cam-btn primary', type: 'button', onclick: () => { panel.remove(); void startStream(); } }, t('common.retry')),
        el('button', { class: 'cam-btn', type: 'button', onclick: () => closeCamera() }, t('common.close'))
      ),
      opts.mode === 'chat'
        ? el('button', { class: 'cam-link', type: 'button', onclick: () => { panel.remove(); void useAlbum(); } }, t('camera.pickAlbum'))
        : null,
      opts.mode === 'chat' ? el('p', { class: 'cam-warn' }, t('camera.albumWarn')) : null
    );
    stage.querySelector('.cam-error')?.remove();
    stage.append(panel);
  }

  function grabFrame() {
    if (!video.videoWidth || !video.videoHeight) return null;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  async function openChatPreview(canvas: HTMLCanvasElement) {
    if (closed) return;
    const seq = ++previewSeq;
    const fix = await readFix(true);
    if (closed || seq !== previewSeq) return;
    const img = el('img', { alt: t('camera.previewAlt') });
    const meta = el('div', { class: 'cam-meta' }, el('span', { class: 'cam-mini-spin' }), t('camera.compressing'));
    const caption = el('input', {
      class: 'cam-caption', type: 'text', maxlength: '200',
      placeholder: t('camera.captionPlaceholder'), 'aria-label': t('camera.captionPlaceholder')
    });
    const retake = el('button', { class: 'cam-btn', type: 'button' }, t('camera.retake'));
    const send = el('button', { class: 'cam-btn primary', type: 'button', disabled: true }, t('camera.send'));
    preview = el('div', { class: 'cam-preview' },
      el('div', { class: 'cam-preview-media' }, img),
      el('div', { class: 'cam-preview-panel' }, meta, caption, el('div', { class: 'cam-preview-actions' }, retake, send))
    );
    stage.append(preview);
    previewShot = null;

    releaseUrl(previewUrl);
    previewUrl = '';
    img.src = canvas.toDataURL('image/jpeg', 0.72);

    retake.addEventListener('click', () => {
      if (busy) return;
      releasePreview();
      if (!videoReady || !stream) void startStream();
      else refreshHint();
    });
    caption.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void submit(); }
    });
    send.addEventListener('click', () => void submit());

    async function submit() {
      if (busy || !previewShot || seq !== previewSeq) return;
      busy = true;
      send.disabled = true;
      send.textContent = t('camera.sending');
      let ok = false;
      try {
        ok = await (opts.onChatSend?.({ ...previewShot, caption: caption.value.trim() }) || Promise.resolve(false));
      } catch {
        ok = false;
      }
      if (closed || seq !== previewSeq) return;
      busy = false;
      if (ok) {
        closeCamera();
        return;
      }
      send.disabled = false;
      send.textContent = t('camera.send');
      camToast(t('camera.sendFail'), 'err');
    }

    void (async () => {
      try {
        const compressed = await compressChatShot(canvas);
        if (closed || seq !== previewSeq || !preview?.isConnected) return;
        if (!compressed) {
          meta.textContent = t('camera.compressFail');
          return;
        }
        const url = trackUrl(URL.createObjectURL(compressed.blob));
        releaseUrl(previewUrl);
        previewUrl = url;
        img.src = url;
        const kb = Math.max(1, Math.round(compressed.blob.size / 1024));
        meta.textContent = `${compressed.width}×${compressed.height} · ${kb} KB`
          + (compressed.oversize ? ` · ${t('camera.oversize')}` : '');
        meta.classList.toggle('warn', compressed.oversize);
        if (compressed.oversize) return;
        const base64 = await blobToBase64(compressed.blob);
        if (closed || seq !== previewSeq || !preview?.isConnected) return;
        previewShot = {
          blob: compressed.blob,
          thumb: compressed.blob,
          width: compressed.width,
          height: compressed.height,
          base64,
          mime: compressed.mime,
          bytes: compressed.blob.size,
          caption: caption.value.trim(),
          fix
        };
        send.disabled = false;
        send.focus();
      } catch {
        if (!closed && seq === previewSeq && preview?.isConnected) meta.textContent = t('camera.compressFail');
      }
    })();
  }

  function releasePreview() {
    previewSeq++;
    if (!preview) return;
    preview.remove();
    preview = null;
    previewShot = null;
    busy = false;
    releaseUrl(previewUrl);
    previewUrl = '';
    refreshHint();
  }

  async function useAlbum() {
    const file = await albumFile();
    if (!file || closed) return;
    const header = await readLocalImageHeader(file);
    if (closed) return;
    if (!header) { camToast(t('camera.imageReject'), 'err'); return; }
    if (opts.mode === 'chat') {
      try {
        const canvas = await fileToCanvas(file, header);
        await openChatPreview(canvas);
      } catch {
        if (!closed) camToast(t('camera.compressFail'), 'err');
      }
      return;
    }
    try {
      const fix = await readFix(true);
      if (closed) return;
      if (!fix) { camToast(t('camera.noFix'), 'warn'); return; }
      const processed = await processPhoto(file);
      await saveQuickShot({
        blob: processed.blob,
        thumb: processed.thumb,
        width: processed.width,
        height: processed.height,
        original: file,
        originalWidth: header.width,
        originalHeight: header.height,
        takenAt: processed.exif?.time || Date.now(),
        fix
      });
    } catch {
      if (!closed) camToast(t('camera.saveFail'), 'err');
    }
  }

  async function saveOriginal(photo?: QuickCameraShot) {
    if (!photo?.original) return;
    const outcome = await saveOriginalPhoto(photo.original, photo.takenAt);
    if (closed) return;
    if (outcome === 'shared' || outcome === 'picked') camToast(t('camera.originalOk'), 'ok');
    else if (outcome === 'downloaded') camToast(t('camera.originalDownloaded'), 'ok');
    else if (outcome === 'failed') camToast(t('camera.originalFail'), 'err');
  }

  function showSavedChip(result: QuickSaveResult, photo?: QuickCameraShot) {
    if (!result.ok) return;
    chip.innerHTML = '';
    releaseUrl(chipUrl);
    chipUrl = result.thumbUrl ? trackUrl(result.thumbUrl) : '';
    const originalBtn = photo?.original
      ? el('button', { class: 'cam-chip-original', type: 'button', onclick: () => void saveOriginal(photo) },
        icon('download', 15), t('camera.saveOriginal'))
      : null;
    const undoBtn = result.undo
      ? el('button', { class: 'cam-chip-undo', type: 'button', onclick: async () => {
        try {
          const undone = await result.undo?.();
          if (undone === false) throw new Error('undo-failed');
          shotCount = Math.max(0, shotCount - 1);
          updateCount();
          chip.hidden = true;
          camToast(t('camera.undone'), 'ok');
        } catch {
          camToast(t('camera.undoFail'), 'err');
        }
      } }, icon('undo', 15), t('camera.undo'))
      : null;
    chip.append(
      chipUrl ? el('img', { src: chipUrl, alt: '' }) : icon('photo', 22),
      el('div', { class: 'cam-chip-main' },
        el('div', { class: 'cam-chip-title' }, result.label || t('camera.saved')),
        el('div', { class: 'cam-chip-sub' }, photo?.original ? t('camera.savedNoteOriginal') : t('camera.savedNote'))),
      originalBtn || undoBtn ? el('div', { class: 'cam-chip-actions' }, originalBtn, undoBtn) : null
    );
    chip.hidden = false;
    clearTimeout(chipTimer);
    chipTimer = window.setTimeout(() => { chip.hidden = true; }, 9000);
  }

  async function saveQuickShot(photo: QuickCameraShot) {
    if (!opts.onQuickSave) return;
    busy = true;
    setBusy(true);
    try {
      const result = await opts.onQuickSave(photo);
      if (closed) {
        releaseUrl(result?.thumbUrl);
        return;
      }
      if (!result?.ok) {
        camToast(t('camera.saveFail'), 'err');
        return;
      }
      shotCount++;
      updateCount();
      if (opts.mode === 'oled') showLockCard(result, photo);
      else showSavedChip(result, photo);
    } catch {
      if (!closed) camToast(t('camera.saveFail'), 'err');
    } finally {
      busy = false;
      if (!closed && opts.mode !== 'oled') setBusy(false);
    }
  }

  function showLockCard(result: QuickSaveResult, photo?: QuickCameraShot) {
    clearTimeout(idleTimer);
    stopTracks();
    armKeepAlive();
    const url = result.thumbUrl ? trackUrl(result.thumbUrl) : '';
    const seconds = el('div', { class: 'cam-lock-count' });
    let left = 3;
    const tick = () => {
      seconds.textContent = t('camera.lockCountdown', { s: left });
    };
    tick();
    const saveBtn = photo?.original
      ? el('button', { class: 'cam-btn', type: 'button', style: { gridColumn: '1 / -1' }, onclick: () => void saveOriginal(photo) },
        icon('download', 17), t('camera.saveOriginal'))
      : null;
    const card = el('div', { class: 'cam-lockcard' },
      url ? el('img', { src: url, alt: t('camera.previewAlt') }) : icon('check', 48),
      el('h3', {}, result.label || t('camera.saved')),
      seconds,
      el('div', { class: 'cam-lock-actions' },
        el('button', { class: 'cam-btn', type: 'button', onclick: () => {
          clearInterval(lockTick);
          clearTimeout(lockTimer);
          card.remove();
          void startStream();
        } }, icon('camera', 17), t('camera.retakeOne')),
        el('button', { class: 'cam-btn primary', type: 'button', onclick: () => closeCamera() }, icon('powerlock', 17), t('camera.lockNow')),
        saveBtn
      )
    );
    stage.append(card);
    lockTick = window.setInterval(() => {
      left--;
      if (left <= 0) {
        clearInterval(lockTick);
        closeCamera();
        return;
      }
      tick();
    }, 1000);
  }

  async function takeQuickShot() {
    if (busy || closed) return;
    busy = true;
    setBusy(true);
    try {
      const fix = await readFix(true);
      if (closed) return;
      if (!fix) { camToast(t('camera.noFix'), 'warn'); return; }
      const canvas = grabFrame();
      if (!canvas) { camToast(t('camera.noFrame'), 'warn'); return; }
      const takenAt = Date.now();
      showFlash();
      vibrate();
      const encoded = await encodeQuickPhoto(canvas);
      await saveQuickShot({ ...encoded, takenAt, fix });
    } catch {
      camToast(t('camera.saveFail'), 'err');
    } finally {
      busy = false;
      if (!closed && opts.mode !== 'oled') setBusy(false);
    }
  }

  shutter.addEventListener('click', () => {
    if (opts.mode === 'chat') {
      if (busy || !videoReady) return;
      const canvas = grabFrame();
      if (!canvas) { camToast(t('camera.noFrame'), 'warn'); return; }
      showFlash();
      vibrate();
      void openChatPreview(canvas);
    } else {
      void takeQuickShot();
    }
  });
  albumBtn.addEventListener('click', () => void useAlbum());
  flipBtn.addEventListener('click', () => {
    if (busy) return;
    facing = facing === 'environment' ? 'user' : 'environment';
    releasePreview();
    void startStream();
  });

  refreshHint();
  hintTimer = window.setInterval(refreshHint, 1000);
  resetIdle();
  // Open the stream inside the originating click so iOS treats it as a gesture.
  void startStream();

  return api;
}