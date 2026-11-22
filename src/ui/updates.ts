// Service-worker updates are explicit: never reload while a recording is live.
import { t } from '../core/i18n';
import { rec } from '../core/recorder';
import { on } from '../core/events';
import { el, icon, toast } from './helpers';

let updateSW: ((reloadPage?: boolean) => Promise<void>) | null = null;
let banner = null;
let primaryBtn = null;
let hintEl = null;
let installing = false;

function recordingLock() {
  return rec.status === 'recording' || rec.status === 'paused';
}

function refresh() {
  if (!banner) return;
  const locked = recordingLock();
  primaryBtn.disabled = locked || installing;
  primaryBtn.textContent = installing ? t('update.applying') : t('update.now');
  hintEl.textContent = locked ? t('update.blockedRec') : t('update.hint');
}

function buildBanner() {
  banner = el('div', { class: 'update-bar', role: 'status', 'aria-live': 'polite' });
  hintEl = el('span', {}, t('update.hint'));
  primaryBtn = el('button', {
    class: 'btn sm primary',
    onclick: async () => {
      if (recordingLock()) { refresh(); return; }
      if (document.querySelector('.modal-backdrop')) { toast(t('update.blockedBusy'), 'warn'); return; }
      if (!updateSW || installing) return;
      installing = true;
      refresh();
      try {
        await updateSW(true);
      } catch (e) {
        console.error('service worker update failed', e);
        installing = false;
        refresh();
        toast(t('update.failed'), 'err');
      }
    }
  }, t('update.now'));
  banner.append(
    icon('refresh', 18),
    el('div', { class: 'ub-text' }, el('strong', {}, t('update.ready')), hintEl),
    el('button', { class: 'btn sm ghost', onclick: () => { banner?.remove(); banner = null; } }, t('update.later')),
    primaryBtn
  );
  document.body.append(banner);
  refresh();
}

export function showUpdateNotice() {
  if (banner) return;
  buildBanner();
}

function rebuildForLanguage() {
  if (!banner) return;
  banner.remove();
  banner = null;
  buildBanner();
}

export function initUpdates() {
  if (!('serviceWorker' in navigator)) return;
  on('recstatus:changed', refresh);
  on('language:changed', rebuildForLanguage);
  import('virtual:pwa-register').then(({ registerSW }) => {
    updateSW = registerSW({
      immediate: true,
      onNeedRefresh: showUpdateNotice,
      onRegisterError: (e) => console.warn('service worker registration failed', e)
    });
  }).catch(() => { /* dev mode without a service worker */ });
}
