// Add-to-home-screen guide: one-time mobile hint plus a permanent settings entry.
import { t } from '../core/i18n';
import { rec } from '../core/recorder';
import { isEmbeddedWebView } from '../core/shareEnv';
import { el, icon, modal, toast } from './helpers';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const NUDGE_KEY = 'trackmint.installNudge.v1';
let deferredPrompt: InstallPromptEvent | null = null;
let installed = false;

export function isStandaloneMode() {
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as any).standalone === true;
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isAndroid() {
  return /Android/i.test(navigator.userAgent);
}

function isMobileBrowser() {
  return isIOS() || isAndroid() || (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);
}

function platformKey() {
  return isIOS() ? 'ios' : isAndroid() ? 'android' : 'desktop';
}

function step(n, text) {
  return el('div', { class: 'install-step' },
    el('span', { class: 'istep-num' }, String(n)),
    el('span', {}, text));
}

function platformGuide() {
  const p = platformKey();
  const title = t(`install.${p}Title`);
  const heading = p === 'ios' ? icon('share', 16) : p === 'android' ? icon('download', 16) : icon('globe', 16);
  const steps = p === 'ios'
    ? [t('install.ios1'), t('install.ios2'), t('install.ios3')]
    : p === 'android'
      ? [t('install.android1'), t('install.android2'), t('install.android3')]
      : [t('install.desktop1'), t('install.desktop2')];
  return el('div', { class: 'install-platform' },
    el('h4', {}, heading, title),
    ...steps.map((s, i) => step(i + 1, s)),
    p === 'ios' ? el('div', { class: 'install-subnote' }, t('install.iosShareHint')) : null);
}

async function runNativePrompt() {
  if (!deferredPrompt) return;
  const prompt = deferredPrompt;
  deferredPrompt = null;
  await prompt.prompt();
  const choice = await prompt.userChoice;
  if (choice.outcome === 'accepted') {
    installed = true;
    toast(t('install.accepted'), 'ok');
  }
}

export function openInstallGuide(auto = false) {
  if (installed || isStandaloneMode()) {
    installed = true;
    if (!auto) toast(t('install.installed'), 'ok');
    return;
  }
  const embedded = isEmbeddedWebView();
  const canInstallNow = !!deferredPrompt && !embedded;
  const body = el('div', { class: 'install-guide' },
    el('div', { class: 'install-hero' },
      el('img', { src: './icons/icon-192.png', alt: '', width: '58', height: '58' }),
      el('strong', {}, auto ? t('install.autoTitle') : t('install.title')),
      el('p', {}, auto ? t('install.autoIntro') : t('install.intro')),
      el('span', { class: 'install-badge' }, icon('shield', 13), t('install.badge'))),
    embedded ? el('div', { class: 'install-warn' }, icon('warn', 17), t('install.embedded')) : null,
    embedded ? null : platformGuide(),
    el('div', { class: 'install-subnote' }, t('install.privacy'))
  );
  const m = modal({
    title: auto ? t('install.title') : t('settings.installTitle'),
    body,
    footer: [
      el('button', { class: 'btn ghost', onclick: () => m.close() }, auto ? t('install.later') : t('common.close')),
      canInstallNow
        ? el('button', { class: 'btn primary', onclick: async () => { await runNativePrompt(); m.close(); } }, icon('download', 16), t('install.installNow'))
        : el('button', { class: 'btn primary', onclick: () => m.close() }, t('install.done'))
    ]
  });
}

export function installSettingsInfo() {
  return {
    installed: installed || isStandaloneMode(),
    canInstallNow: !!deferredPrompt
  };
}

export function initInstall({ nudge = true } = {}) {
  installed = isStandaloneMode();
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as InstallPromptEvent;
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferredPrompt = null;
  });
  if (!nudge || installed || !isMobileBrowser() || isEmbeddedWebView()) return;
  try { if (localStorage.getItem(NUDGE_KEY)) return; } catch { /* storage unavailable */ }
  window.setTimeout(() => {
    if (installed || isStandaloneMode() || rec.status !== 'idle') return;
    try { localStorage.setItem(NUDGE_KEY, String(Date.now())); } catch { /* ignore */ }
    openInstallGuide(true);
  }, 4200);
}
