// iOS PWA best-effort keep-alive: a tiny muted looping video keeps the page
// active longer while the screen is physically locked. It cannot override iOS
// suspension, so visibility re-arm + gap repair remain the safety net.
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let video: HTMLVideoElement | null = null;
let armed = false;

export function isIosDevice() { return IOS; }
export function isKeepAliveActive() { return !!video && !video.paused; }

function assetUrl() {
  return new URL(`${import.meta.env.BASE_URL}keepalive.mp4`, document.baseURI).href;
}

function ensureVideo() {
  if (video) return video;
  const v = document.createElement('video');
  v.src = assetUrl();
  v.loop = true;
  v.muted = true;
  v.defaultMuted = true;
  v.autoplay = true;
  v.playsInline = true;
  (v as any).webkitPlaysInline = true;
  v.setAttribute('playsinline', '');
  v.setAttribute('webkit-playsinline', '');
  v.setAttribute('aria-hidden', 'true');
  (v as any).disablePictureInPicture = true;
  v.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:2147483646;';
  v.addEventListener('pause', () => {
    if (armed && document.visibilityState === 'visible') v.play().catch(() => {});
  });
  document.body.append(v);
  video = v;
  return v;
}

/** Call from a user gesture (start/resume) when possible. */
export function armKeepAlive(force = false) {
  if (!IOS && !force) return false;
  armed = true;
  const v = ensureVideo();
  v.play().catch(() => {
    // Autoplay may need the next user gesture; visibilitychange retries.
    setTimeout(() => { if (armed) v.play().catch(() => {}); }, 1200);
  });
  return true;
}

export function disarmKeepAlive() {
  armed = false;
  if (!video) return;
  try { video.pause(); } catch { /* ignore */ }
  video.removeAttribute('src');
  video.load();
  video.remove();
  video = null;
}

document.addEventListener('visibilitychange', () => {
  if (armed && document.visibilityState === 'visible' && video) {
    video.play().catch(() => {});
  }
});
