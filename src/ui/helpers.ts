// Small DOM / toast / modal helpers.
import { t } from '../core/i18n';
import { on } from '../core/events';

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function icon(name, size = 20) {
  const paths = {
    record: '<circle cx="12" cy="12" r="8.2" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/>',
    meet: '<circle cx="9" cy="8" r="3" stroke="currentColor" stroke-width="2" fill="none"/><path d="M3.5 20c0-3 2.5-5.2 5.5-5.2s5.5 2.2 5.5 5.2" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><circle cx="17" cy="9.2" r="2.4" stroke="currentColor" stroke-width="2" fill="none"/><path d="M15.4 15.3c2.8 0 5 1.8 5 4.7" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
    trips: '<circle cx="5" cy="18.5" r="2.2" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="19" cy="5.5" r="2.2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M7.2 18.5h6.1a4 4 0 0 0 0-8H10a4 4 0 0 1 0-8h6.8" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
    routeFwd: '<circle cx="4.5" cy="19.5" r="1.9" fill="currentColor"/><path d="M6.8 19.5h7.4a4 4 0 0 0 0-8H9a4 4 0 0 1 0-8h7.2" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><path d="m14.6 1.6 3 2-3 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    routeRev: '<circle cx="19.5" cy="19.5" r="1.9" fill="currentColor"/><path d="M17.2 19.5H9.8a4 4 0 0 1 0-8H15a4 4 0 0 0 0-8H7.8" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><path d="m9.4 1.6-3 2 3 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    flag: '<path d="M6 21V4m0 1h10.5l-1.8 3.6L16.5 12H6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    analysis: '<path d="M4 19V5m0 14h16M7 15l4-6 3 3 5-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    export: '<path d="M12 3v12m0-12L8 7m4-4 4 4M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    settings: '<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10 2.1 2.1M19.1 4.9 17 7m-10 10-2.1 2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    follow: '<circle cx="12" cy="12" r="3" fill="currentColor"/><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5m11-5v5h-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    edit: '<path d="m4 20 4-1L20 7l-3-3L5 16l-1 4Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/>',
    powerlock: '<rect x="6" y="2" width="12" height="20" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><rect x="9.5" y="12.5" width="5" height="4" rx="1" fill="currentColor"/><path d="M10.5 12.5v-1.3a1.5 1.5 0 0 1 3 0v1.3" stroke="currentColor" stroke-width="1.4" fill="none"/>',
    moon: '<path d="M20.2 14.6A8.6 8.6 0 0 1 9.4 3.8a8.6 8.6 0 1 0 10.8 10.8Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/>',
    expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5m11-5v5h-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    compress: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4m11 5v-5h5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    play: '<path d="M7 4v16l13-8L7 4Z" fill="currentColor"/>',
    pause: '<path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/>',
    plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
    pin: '<path d="M12 21s-6.5-5.32-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.68 12 21 12 21Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/><circle cx="12" cy="10.5" r="2.3" fill="currentColor"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    undo: '<path d="M8 5 3 10l5 5M3 10h11a7 7 0 0 1 0 14h-3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    redo: '<path d="m16 5 5 5-5 5m5-5H10a7 7 0 0 0 0 14h3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4V8Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/><circle cx="12" cy="13" r="3.4" stroke="currentColor" stroke-width="2" fill="none"/>',
    warn: '<path d="M12 3 2 21h20L12 3Zm0 7v5m0 3v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    check: '<path d="m4 12 5 5L20 6" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    info: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 11v6m0-9v.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
    x: '<path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
    chevron: '<path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v3h16v-3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
    share: '<circle cx="6" cy="12" r="2.6" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="17" cy="5.5" r="2.6" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="17" cy="18.5" r="2.6" stroke="currentColor" stroke-width="2" fill="none"/><path d="m8.4 10.8 6.2-3.6m-6.2 6 6.2 3.6" stroke="currentColor" stroke-width="2"/>',
    chat: '<path d="M20.5 11.4a8 8 0 0 1-8.4 8 9.4 9.4 0 0 1-3.5-.7L4 20l1.2-4.2a7.5 7.5 0 0 1-1.2-4.2 8 8 0 0 1 8.4-8 8 8 0 0 1 8.1 7.8Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/><path d="M8.2 10h7.6M8.2 13.6h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    send: '<path d="m4 11.6 16-7.6-5.4 16-3.1-6.5L4 11.6Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/><path d="m11.5 13.5 8.5-9.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
    globe: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" fill="none"/><path d="M3 12h18M12 3c3 3.6 3 14.4 0 18-3-3.6-3-14.4 0-18Z" stroke="currentColor" stroke-width="1.6" fill="none"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5m-18 4 9 5 9-5" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/>',
    photo: '<rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="9" cy="10" r="1.8" fill="currentColor"/><path d="m5 17 5-4 3 2.4L17 11l2 2.4" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/>',
    batch: '<rect x="3" y="3" width="12" height="12" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M9 21h10a2 2 0 0 0 2-2V9" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
    more: '<circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 6M20 4v7h-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    search: '<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" fill="none"/><path d="m16.5 16.5 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Zm6-3v15m6-12v15" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/>',
    mountain: '<path d="m3 20 6.5-12 3.6 6 2.2-3.5L21 20H3Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/>',
    shield: '<path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6L12 3Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/><path d="m8.8 12 2.2 2.2 4.2-4.4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    database: '<ellipse cx="12" cy="6" rx="7.5" ry="3" stroke="currentColor" stroke-width="2" fill="none"/><path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" stroke="currentColor" stroke-width="2" fill="none"/>',
    palette: '<path d="M12 3a9 9 0 0 0 0 18c1.5 0 2-.9 2-1.8 0-1.6-1.6-1.7-1.6-3.2 0-1 .8-1.8 1.9-1.8H16a5 5 0 0 0 5-5c0-3.4-4-6.2-9-6.2Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/><circle cx="7.5" cy="11" r="1.1" fill="currentColor"/><circle cx="10" cy="7.5" r="1.1" fill="currentColor"/><circle cx="14.5" cy="7.5" r="1.1" fill="currentColor"/>',
    file: '<path d="M6 3h8l4 4v14H6V3Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/><path d="M14 3v5h5" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/>',
    chevronRight: '<path d="m9 6 6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="16" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M8 3v4m8-4v4M3.5 10h17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    clock: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 7v5l3.2 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.2 1.1 5.9L12 17l-5.3 2.8 1.1-5.9L3.5 9.7l5.9-.8L12 3.5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/>',
    tag: '<path d="M4 4h7l9 9-7 7-9-9V4Zm4 4v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    music: '<path d="M9 17.5V6l10-2v11.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="6.5" cy="17.5" r="2.6" fill="currentColor"/><circle cx="16.5" cy="15.5" r="2.6" fill="currentColor"/>',
    compass: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" fill="none"/><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/>',
    sparkles: '<path d="m10 3 1.4 4.1L15.5 8.5l-4.1 1.4L10 14l-1.4-4.1L4.5 8.5l4.1-1.4L10 3Zm7.5 9 .9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6Z" fill="currentColor"/>'
  };
  const span = el('span', { html: `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${paths[name] || paths.info}</svg>`, style: { display: 'inline-flex' } });
  return span;
}

// ---------- toast ----------
let toastRoot = null;
export function toast(msg, type = 'info', ms = 3200) {
  if (!toastRoot) {
    toastRoot = el('div', { id: 'toast-root' });
    document.body.append(toastRoot);
  }
  const ic = type === 'ok' ? 'check' : type === 'warn' ? 'warn' : type === 'err' ? 'x' : 'info';
  const node = el('div', { class: `toast ${type}` }, el('span', { class: 't-icon' }, icon(ic, 17)), el('span', {}, msg));
  toastRoot.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 260);
  }, ms);
  return node;
}
on('toast', ({ msg, type }) => toast(msg, type));

// ---------- modal ----------
export function modal({ title, body, footer = null, onClose = null, wide = false }) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const box = el('div', { class: 'modal', style: wide ? { maxWidth: '760px' } : {} });
  const close = () => { backdrop.remove(); onClose?.(); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  box.append(
    el('div', { class: 'm-head' }, el('h3', {}, title), el('button', { class: 'iconbtn', onclick: close, 'aria-label': 'close' }, icon('x'))),
    el('div', { class: 'm-body' }, body)
  );
  if (footer) box.append(el('div', { class: 'm-foot' }, footer));
  backdrop.append(box);
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', esc);
  document.body.append(backdrop);
  return { close, box, backdrop };
}

export function confirmModal({ title, message, confirmText, danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const m = modal({
      title,
      body: el('p', { class: 'muted', style: { margin: '4px 0 8px' } }, message),
      footer: [
        el('button', { class: 'btn ghost', onclick: () => { done(false); m.close(); } }, t('common.cancel')),
        el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => { done(true); m.close(); } }, confirmText || t('common.confirm'))
      ],
      onClose: () => done(false)
    });
  });
}

export function promptModal({ title, label, value = '', placeholder = '', hint = '' }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const input = el('input', { type: 'text', value, placeholder });
    const m = modal({
      title,
      body: el('div', { class: 'field' }, el('label', {}, label), input, hint ? el('div', { class: 'hint' }, hint) : null),
      footer: [
        el('button', { class: 'btn ghost', onclick: () => { done(null); m.close(); } }, t('common.cancel')),
        el('button', { class: 'btn primary', onclick: () => { done(input.value.trim()); m.close(); } }, t('common.ok'))
      ],
      onClose: () => done(null)
    });
    setTimeout(() => { input.focus(); input.select(); }, 60);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { done(input.value.trim()); m.close(); } });
  });
}

export function filePicker(accept = '*/*') {
  return new Promise<File | null>((resolve) => {
    const input = el('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', () => { resolve(input.files?.[0] || null); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

export function filePickerMulti(accept = '*/*') {
  return new Promise<File[]>((resolve) => {
    const input = el('input', { type: 'file', accept, multiple: true, style: { display: 'none' } });
    input.addEventListener('change', () => { resolve(Array.from(input.files || [])); input.remove(); });
    document.body.append(input);
    input.click();
  });
}