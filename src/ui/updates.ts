// Service-worker updates are explicit: activate a waiting worker promptly, but
// never reload while a recording is live or an overlay would lose unsaved work.
import { t } from '../core/i18n';
import { rec } from '../core/recorder';
import { on } from '../core/events';
import { el, icon, toast, hasOpenOverlay } from './helpers';

let registration: ServiceWorkerRegistration | null = null;
let banner: HTMLDivElement | null = null;
let primaryBtn: HTMLButtonElement | null = null;
let hintEl: HTMLSpanElement | null = null;
let installing = false;
let initialized = false;
let reloadRequested = false;
let activationPending = false;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

function recordingLock() {
  return rec.status === 'recording' || rec.status === 'paused';
}

function refresh() {
  if (!banner || !primaryBtn || !hintEl) return;
  const locked = recordingLock();
  primaryBtn.disabled = locked || installing || !registration;
  primaryBtn.textContent = installing ? t('update.applying') : t('update.now');
  hintEl.textContent = locked ? t('update.blockedRec') : t('update.hint');
}

function reloadWhenSafe() {
  if (!reloadRequested || recordingLock()) return false;
  if (hasOpenOverlay()) {
    // The user can click Update now again after closing the overlay.
    reloadRequested = false;
    installing = false;
    refresh();
    return false;
  }
  window.location.reload();
  return true;
}

function watchWaitingWorker(worker: ServiceWorker) {
  worker.addEventListener('statechange', () => {
    if (worker.state === 'installed' && registration?.active) {
      showUpdateNotice();
      requestWaitingActivation(worker);
    }
  });
}

function requestWaitingActivation(candidate: ServiceWorker | null = registration?.waiting || null) {
  if (!candidate || recordingLock()) return;
  try {
    // Workbox's generated SW listens for SKIP_WAITING when skipWaiting is false.
    activationPending = true;
    candidate.postMessage({ type: 'SKIP_WAITING' });
  } catch (error) {
    activationPending = false;
    console.warn('service worker activation failed', error);
  }
}

function buildBanner() {
  banner = el('div', { class: 'update-bar', role: 'status', 'aria-live': 'polite' });
  hintEl = el('span', {}, t('update.hint'));
  primaryBtn = el('button', {
    class: 'btn sm primary',
    onclick: async () => {
      if (recordingLock()) { refresh(); return; }
      if (hasOpenOverlay()) { toast(t('update.blockedBusy'), 'warn'); return; }
      if (!registration || installing) return;
      installing = true;
      reloadRequested = true;
      refresh();
      if (fallbackTimer) clearTimeout(fallbackTimer);
      fallbackTimer = null;
      try {
        if (registration.waiting) {
          registration.waiting.postMessage({ type: 'SKIP_WAITING' });
          fallbackTimer = setTimeout(() => {
            fallbackTimer = null;
            if (!registration?.waiting) {
              activationPending = true;
              installing = false;
              reloadWhenSafe();
              refresh();
            } else {
              installing = false;
              reloadRequested = false;
              refresh();
              toast(t('update.failed'), 'err');
            }
          }, 10_000);
        } else if (activationPending || !navigator.serviceWorker.controller) {
          installing = false;
          reloadWhenSafe();
          refresh();
        } else {
          installing = false;
          reloadRequested = false;
          await registration.update();
          showUpdateNotice();
          refresh();
        }
      } catch (e) {
        console.error('service worker update failed', e);
        installing = false;
        reloadRequested = false;
        refresh();
        toast(t('update.failed'), 'err');
      }
    }
  }, t('update.now'));
  banner.append(
    icon('refresh', 18),
    el('div', { class: 'ub-text' }, el('strong', {}, t('update.ready')), hintEl),
    el('button', {
      class: 'btn sm ghost',
      onclick: () => {
        reloadRequested = false;
        banner?.remove();
        banner = null;
      }
    }, t('update.later')),
    primaryBtn
  );
  document.body.append(banner);
  refresh();
}

export function showUpdateNotice() {
  if (banner) { refresh(); return; }
  buildBanner();
}

function rebuildForLanguage() {
  if (!banner) return;
  banner.remove();
  banner = null;
  buildBanner();
}

function attachRegistration(next: ServiceWorkerRegistration) {
  registration = next;
  if (next.waiting) {
    watchWaitingWorker(next.waiting);
    showUpdateNotice();
    requestWaitingActivation();
  }
  next.addEventListener('updatefound', () => {
    const worker = next.installing;
    if (worker) watchWaitingWorker(worker);
  });
  // Covers a worker that was already waiting before this page registered.
  void next.update().catch(() => { /* offline; the next visibility check retries */ });
}

async function registerUpdates() {
  try {
    // VitePWA emits sw.js beside index.html; injectRegister is disabled so this
    // module owns activation/reload and can enforce the recording lock.
    const next = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    attachRegistration(next);
  } catch (error) {
    console.warn('service worker registration failed', error);
  }
}

export function initUpdates() {
  if (initialized || !('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  initialized = true;
  on('recstatus:changed', () => {
    refresh();
    if (!recordingLock()) {
      requestWaitingActivation();
      if (activationPending) reloadWhenSafe();
    }
  });
  on('language:changed', rebuildForLanguage);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (fallbackTimer) clearTimeout(fallbackTimer);
    fallbackTimer = null;
    activationPending = true;
    installing = false;
    showUpdateNotice();
    if (reloadRequested) reloadWhenSafe();
    refresh();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void registration?.update().catch(() => undefined);
      if (registration?.waiting) showUpdateNotice();
    }
  });
  window.addEventListener('online', () => {
    void registration?.update().catch(() => undefined);
  });
  void registerUpdates();
}
