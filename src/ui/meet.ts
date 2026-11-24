// Live meetup view: create/join codes, encrypted peer map, distance/bearing list,
// meetup routing, QR sharing, kick/reset and self-destruct countdown.
import { t } from '../core/i18n';
import { get, set } from '../core/settings';
import { on } from '../core/events';
import { meet, getMeetSnapshot, MEET_CHAT_MAX_LEN } from '../core/meet';
import { normalizeMeetInvite, isLegacyMeetCode } from '../core/meetLink';
import { fmtDistance, fmtDuration } from '../core/geo';
import { regionState } from '../core/region';
import { drawQr } from '../core/brand';
import { TrackMap } from './map';
import { el, icon, toast, modal, confirmModal } from './helpers';
import { openCamera } from './camera';
import { CHAT_IMAGE_KEEP, readChatImageHeader } from '../core/chatImage';

export function createMeetView(navigate) {
  const view = el('div', { class: 'view', id: 'view-meet' });
  const mapContainer = el('div', { class: 'meet-map' });
  const top = el('div', { class: 'meet-top' });
  const codeText = el('span', { class: 'meet-code-txt' });
  const codePill = el('button', {
    class: 'meet-code-pill', type: 'button', title: t('meet.shareTitle'),
    onclick: () => openShareSheet()
  }, icon('meet', 16), codeText, el('span', { class: 'chev' }, icon('share', 14)));
  const statusDot = el('span', { class: 'dot' });
  const statusTxt = el('span', { class: 'meet-status-txt' });
  const statusChip = el('div', { class: 'meet-status-chip' }, statusDot, statusTxt);
  top.append(codePill, statusChip);

  const tools = el('div', { class: 'meet-tools' });
  const followBtn = el('button', {
    class: 'iconbtn', type: 'button', title: t('record.follow'), 'aria-label': t('record.follow'),
    onclick: toggleFollow
  }, icon('follow'));
  const fitBtn = el('button', {
    class: 'iconbtn', type: 'button', title: t('record.fit'), 'aria-label': t('record.fit'),
    onclick: () => map?.fitMeet()
  }, icon('fit'));
  const shareBtn = el('button', {
    class: 'iconbtn', type: 'button', title: t('meet.shareTitle'), 'aria-label': t('meet.shareTitle'),
    onclick: () => openShareSheet()
  }, icon('share'));
  const chatBadge = el('span', { class: 'meet-chat-badge', hidden: true });
  const chatBtn = el('button', {
    class: 'iconbtn meet-chat-btn', type: 'button', title: t('meet.chat'), 'aria-label': t('meet.chat'),
    onclick: () => openChatSheet()
  }, icon('chat'), chatBadge);
  tools.append(chatBtn, followBtn, fitBtn, shareBtn);

  const empty = el('div', { class: 'meet-empty' });
  const panel = el('div', { class: 'meet-panel' });
  const peerCountEl = el('div', { class: 'mp-title' });
  const nearestEl = el('div', { class: 'mp-sub' });
  const chevEl = el('span', { class: 'mp-chev' }, icon('chevron', 16));
  const panelHead = el('div', {
    class: 'mp-head', role: 'button', tabindex: '0',
    onclick: togglePanel,
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePanel(); } }
  }, el('span', { class: 'mp-ic' }, icon('meet', 18)), el('div', { class: 'mp-titles' }, peerCountEl, nearestEl), chevEl);
  const panelBody = el('div', { class: 'mp-body' });
  const panelFoot = el('div', { class: 'mp-foot' });
  panel.append(panelHead, panelBody, panelFoot);

  view.append(mapContainer, top, tools, empty, panel);

  let snap = getMeetSnapshot();
  let map = null;
  let autoFitDone = false;
  let lastCode = '';
  let panelCollapsed = false;
  let lastTickRender = 0;
  let chatModal = null;
  let chatRefresh: (() => void) | null = null;
  let chatImageViewer = null;
  let photoRefTimer = 0;
  const chatImageUrls = new Map<string, string>();
  const chatImagePending = new Map<string, Promise<string>>();

  function initialCenter() {
    if (snap.active && snap.self?.hasFix) return [snap.self.lon, snap.self.lat] as any;
    if (regionState.effective === 'cn') return [116.4, 39.9] as any;
    return [10, 30] as any;
  }

  function ensureMap() {
    if (map) return map;
    const center = initialCenter();
    map = new TrackMap(mapContainer, {
      compact: true,
      preserveDrawingBuffer: false,
      fallbackText: t('map.fallback'),
      onMeetPeerClick: (id) => flyPeer(id)
    }).init(center, snap.active && snap.self?.hasFix ? 14 : (regionState.effective === 'cn' ? 9 : 3));
    map.map?.once('load', maybeAutoFit);
    return map;
  }

  on('map:followoff', () => followBtn.classList.remove('active'));

  function relayLabel() {
    return get('meetRelayMode') === 'ws' ? t('meet.relayCustom') : t('meet.relayPublic');
  }

  function buildEmpty() {
    empty.innerHTML = '';
    empty.append(el('div', { class: 'meet-empty-card' },
      el('div', { class: 'me-hero' }, icon('meet', 30)),
      el('h2', {}, t('meet.emptyTitle')),
      el('p', { class: 'meet-empty-copy' }, t('meet.emptyText')),
      el('div', { class: 'meet-empty-actions' },
        el('button', { class: 'btn primary big block', onclick: openCreate }, icon('meet', 18), t('meet.create')),
        el('button', { class: 'btn ghost big block', onclick: () => openJoin() }, icon('pin', 18), t('meet.join'))),
      el('div', { class: 'meet-safe-note' }, icon('shield', 15), t('meet.expiryWarning')),
      el('div', { class: 'meet-safe-sub' }, `${relayLabel()} · ${t('meet.serverless')}`),
      el('button', { class: 'meet-settings-link', onclick: () => navigate('settings', 'relay') }, icon('settings', 14), t('meet.relaySettings'))
    ));
  }
  buildEmpty();

  function updateChatBadge(s = snap) {
    const n = Number(s?.chatUnread) || 0;
    chatBadge.hidden = n <= 0;
    chatBadge.textContent = n > 99 ? '99+' : String(n);
    const label = n > 0 ? t('meet.chatUnread', { n }) : t('meet.chat');
    chatBtn.title = label;
    chatBtn.setAttribute('aria-label', label);
    chatBtn.disabled = !s?.active;
  }

  function base64ImageBlob(data: string, mime: string) {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  async function chatImageUrl(msg) {
    if (!msg?.img?.data) return '';
    const cached = chatImageUrls.get(msg.id);
    if (cached) return cached;
    const pending = chatImagePending.get(msg.id);
    if (pending) return pending;
    const job = (async () => {
      try {
        const blob = base64ImageBlob(msg.img.data, msg.img.mime);
        const header = await readChatImageHeader(blob, msg.img.mime);
        if (!chatModal || !header || header.width !== msg.img.width || header.height !== msg.img.height) return '';
        if (!getMeetSnapshot().messages.some((m) => m.id === msg.id && m.img?.data)) return '';
        const url = URL.createObjectURL(blob);
        chatImageUrls.set(msg.id, url);
        while (chatImageUrls.size > CHAT_IMAGE_KEEP + 8) {
          const oldest = chatImageUrls.keys().next().value;
          if (!oldest) break;
          URL.revokeObjectURL(chatImageUrls.get(oldest));
          chatImageUrls.delete(oldest);
        }
        return url;
      } catch {
        return '';
      }
    })().finally(() => chatImagePending.delete(msg.id));
    chatImagePending.set(msg.id, job);
    return job;
  }

  function syncChatImageUrls(messages) {
    const live = new Set(messages.filter((m) => m.img?.data).map((m) => m.id));
    for (const [id, url] of chatImageUrls) {
      if (live.has(id)) continue;
      URL.revokeObjectURL(url);
      chatImageUrls.delete(id);
    }
  }

  function clearChatImageUrls() {
    for (const url of chatImageUrls.values()) {
      try { URL.revokeObjectURL(url); } catch { /* already revoked */ }
    }
    chatImageUrls.clear();
  }

  function closeChat() {
    const m = chatModal;
    chatModal = null;
    chatRefresh = null;
    chatImageViewer?.close();
    chatImageViewer = null;
    clearChatImageUrls();
    m?.close();
  }

  function chatEmptyState() {
    return el('div', { class: 'meet-chat-empty' },
      el('span', { class: 'mce-ic' }, icon('chat', 28)),
      el('div', { class: 'mce-t' }, t('meet.chatEmpty')),
      el('div', { class: 'mce-d' }, t('meet.chatEmptyHint')));
  }

  function locateChatPhoto(msg) {
    closeChat();
    const target = ensureMap();
    const pin = () => {
      target.flyTo(msg.lat, msg.lon, 16);
      target.setPhotoRef(msg.lat, msg.lon, t('meet.chatImagePin'));
    };
    if (target.map.loaded()) pin();
    else target.map.once('load', pin);
    clearTimeout(photoRefTimer);
    photoRefTimer = window.setTimeout(() => map?.clearPhotoRef(), 60_000);
    toast(t('meet.chatImageMapHint'), 'ok');
  }

  async function openChatImage(msg) {
    const url = await chatImageUrl(msg);
    if (!url) return;
    const time = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    const coords = msg.lat != null && msg.lon != null
      ? `${msg.lat.toFixed(5)}, ${msg.lon.toFixed(5)} (WGS-84)`
      : t('meet.chatImageNoFix');
    const body = el('div', { class: 'chat-image-viewer' },
      el('img', { src: url, alt: t('meet.chatImageView') }),
      msg.text ? el('div', { class: 'iv-caption' }, msg.text) : null,
      el('div', { class: 'iv-meta' }, `${msg.name} · ${time} · ${coords}`));
    chatImageViewer = modal({
      title: t('meet.chatImageView'),
      body,
      wide: true,
      footer: msg.lat != null && msg.lon != null
        ? el('button', {
          class: 'btn primary block', type: 'button',
          onclick: () => { chatImageViewer?.close(); chatImageViewer = null; locateChatPhoto(msg); }
        }, icon('map', 16), t('meet.chatImageLocate'))
        : null,
      onClose: () => { chatImageViewer = null; }
    });
  }

  function chatRow(s, msg) {
    const own = !!msg.self || msg.fromId === s.self?.id;
    const time = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    let bubble;
    if (msg.img) {
      const img = el('img', { alt: t('meet.chatImageView') });
      const lock = el('span', { class: 'mc-image-lock' }, icon('shield', 12));
      bubble = el('button', {
        class: 'mc-image', type: 'button', disabled: true,
        'aria-label': t('meet.chatImageView')
      }, img, lock);
      bubble.addEventListener('click', () => { void openChatImage(msg); });
      void chatImageUrl(msg).then((url) => {
        if (!bubble.isConnected) return;
        if (!url) {
          bubble.className = 'mc-image-expired';
          bubble.replaceChildren(icon('photo', 18), t('meet.chatImageExpired'));
          return;
        }
        img.src = url;
        bubble.disabled = false;
      });
    } else {
      bubble = el('div', { class: 'mc-bubble' }, msg.text);
    }
    const main = el('div', { class: 'mc-main' },
      own ? null : el('div', { class: 'mc-name' }, msg.name),
      bubble,
      msg.img && msg.text ? el('div', { class: 'mc-caption' }, msg.text) : null,
      el('div', { class: 'mc-time' }, time));
    const row = el('div', { class: 'meet-chat-row' + (own ? ' self' : '') });
    if (!own) {
      row.append(el('span', { class: 'mc-avatar', style: { background: msg.color || 'var(--accent)' } },
        String(msg.name || '?').slice(0, 1)));
    }
    row.append(main);
    return row;
  }

  function openChatSheet() {
    if (chatModal) return;
    const initial = getMeetSnapshot();
    if (!initial.active) return;
    const list = el('div', { class: 'meet-chat-list', role: 'log', 'aria-live': 'polite' });
    const note = el('div', { class: 'meet-chat-note' },
      icon('shield', 15),
      el('div', {}, t('meet.chatPrivacy')));
    const input = el('textarea', {
      class: 'meet-chat-input', rows: '1', maxlength: String(MEET_CHAT_MAX_LEN),
      placeholder: t('meet.chatPlaceholder'), 'aria-label': t('meet.chatPlaceholder'),
      enterkeyhint: 'send'
    });
    const sendBtn = el('button', {
      class: 'meet-chat-send', type: 'button', title: t('meet.chatSend'),
      'aria-label': t('meet.chatSend'), disabled: true
    }, icon('send', 18));
    const camBtn = el('button', {
      class: 'meet-chat-cam', type: 'button', title: t('meet.chatPhoto'),
      'aria-label': t('meet.chatPhoto')
    }, icon('camera', 19));
    camBtn.addEventListener('click', () => {
      const cooldown = meet.imageCooldownLeft();
      if (cooldown > 0) {
        toast(t('meet.chatImageCooldown', { s: Math.ceil(cooldown / 1000) }), 'warn', 2200);
        return;
      }
      openCamera({
        mode: 'chat',
        getFix: () => {
          const self = getMeetSnapshot().self;
          return self?.hasFix && self.lat != null && self.lon != null
            ? { lat: self.lat, lon: self.lon, acc: self.acc }
            : null;
        },
        onChatSend: async (shot) => {
          const ok = await meet.sendImage({
            base64: shot.base64,
            mime: shot.mime,
            width: shot.width,
            height: shot.height,
            caption: shot.caption,
            lat: shot.fix?.lat ?? null,
            lon: shot.fix?.lon ?? null,
            acc: shot.fix?.acc ?? null
          });
          if (ok) {
            render(true);
            meet.markChatRead();
            toast(t('meet.chatImageSent'), 'ok', 2200);
          }
          return ok;
        }
      });
    });
    const composer = el('div', { class: 'meet-chat-compose' }, camBtn, input, sendBtn);
    const body = el('div', { class: 'meet-chat' }, note, list, composer);
    let sending = false;

    const grow = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(96, input.scrollHeight)}px`;
    };
    const syncSend = () => { sendBtn.disabled = sending || !input.value.trim(); };
    const render = (jump = false) => {
      const s = getMeetSnapshot();
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      syncChatImageUrls(s.messages);
      list.innerHTML = '';
      if (!s.messages.length) list.append(chatEmptyState());
      else for (const msg of s.messages) list.append(chatRow(s, msg));
      if (jump || nearBottom) {
        requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
      }
    };
    const send = async () => {
      if (sending) return;
      const text = input.value;
      if (!text.trim()) return;
      sending = true;
      syncSend();
      const ok = await meet.sendMessage(text);
      sending = false;
      if (ok) {
        input.value = '';
        grow();
        syncSend();
        render(true);
        input.focus();
      } else {
        syncSend();
        toast(t('meet.chatSendFail'), 'err');
      }
    };

    input.addEventListener('input', () => { grow(); syncSend(); });
    input.addEventListener('keydown', (e: any) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void send();
      }
    });
    sendBtn.addEventListener('click', () => void send());

    const m = modal({
      title: t('meet.chatTitle'),
      body,
      onClose: () => {
        chatModal = null;
        chatRefresh = null;
        chatImageViewer?.close();
        chatImageViewer = null;
        clearChatImageUrls();
      }
    });
    m.box.classList.add('meet-chat-modal');
    chatModal = m;
    chatRefresh = () => render(false);
    render(true);
    meet.markChatRead();
    updateChatBadge(getMeetSnapshot());
    setTimeout(() => { input.focus(); grow(); }, 80);
  }

  function fmtDist(m) {
    if (m == null) return '--';
    const d = fmtDistance(m, get('units'));
    return `${d.v} ${t(`units.${d.u}`)}`;
  }

  function dirLabel(deg) {
    const keys = ['dirN', 'dirNE', 'dirE', 'dirSE', 'dirS', 'dirSW', 'dirW', 'dirNW'];
    return t(`meet.${keys[Math.round(deg / 45) % 8]}`);
  }

  function bearingText(p) {
    if (p.clock != null) return t('meet.clock', { n: p.clock });
    if (p.bearing != null) return `${dirLabel(p.bearing)} ${t('meet.bearingDeg', { n: Math.round(p.bearing) })}`;
    return '';
  }

  function badge(text, cls = '') {
    return el('span', { class: 'meet-badge' + (cls ? ` ${cls}` : '') }, text);
  }

  function subForPeer(p) {
    if (p.stale) return t('meet.stale', { s: Math.round(p.age / 1000) });
    if (!p.sharing) return t('meet.sharingPaused');
    const bits = [];
    if (p.distance != null) bits.push(fmtDist(p.distance));
    const b = bearingText(p);
    if (b) bits.push(b);
    return bits.join(' · ') || t('meet.waitingFix');
  }

  function selfRow(s) {
    let sub = t('meet.waitingFix');
    if (s.geoError) sub = s.geoError === 'denied' ? t('meet.statusGpsDenied') : t('meet.gpsUnavailableHint');
    else if (s.self?.hasFix && s.sharing) sub = t('meet.sharing');
    else if (s.self?.hasFix) sub = t('meet.sharingPaused');
    return el('div', { class: 'meet-peer-row self' },
      el('span', { class: 'meet-peer-dot', style: { background: 'var(--accent)' } }),
      el('div', { class: 'meet-peer-main' },
        el('div', { class: 'meet-peer-name' }, el('span', { class: 'mp-name' }, s.self?.name || t('meet.me')), badge(t('meet.me')), s.isHost ? badge(t('meet.hostBadge'), 'host') : null),
        el('div', { class: 'meet-peer-sub' }, sub))
    );
  }

  function peerRow(s, p) {
    const main = el('div', { class: 'meet-peer-main', onclick: () => flyPeer(p.id) },
      el('div', { class: 'meet-peer-name' }, el('span', { class: 'mp-name' }, p.name), p.isHost ? badge(t('meet.hostBadge'), 'host') : null, p.stale ? badge(t('meet.staleBadge'), 'bad') : null),
      el('div', { class: 'meet-peer-sub' }, subForPeer(p))
    );
    const actions = el('div', { class: 'meet-peer-actions' });
    const activeRoute = s.route?.peerId === p.id;
    const loadingRoute = !!s.route?.loading && s.route.peerId === p.id;
    const routeBtn = el('button', {
      class: 'iconbtn meet-row-btn' + (activeRoute ? ' active' : ''),
      type: 'button',
      title: activeRoute ? t('meet.routeClear') : t('meet.route'),
      'aria-label': activeRoute ? t('meet.routeClear') : t('meet.route'),
      disabled: loadingRoute || p.lat == null || !s.self?.hasFix
    }, icon('routeFwd', 17));
    routeBtn.onclick = async (e) => {
      e.stopPropagation();
      if (loadingRoute) return;
      if (activeRoute) { meet.clearRoute(); return; }
      const route = await meet.route(p.id);
      if (route) toast(t('meet.routeDone', { dist: fmtDist(route.distance) }), 'ok');
      else toast(t('meet.routeFail'), 'err');
    };
    actions.append(routeBtn);
    if (s.isHost) {
      const kickBtn = el('button', {
        class: 'iconbtn meet-row-btn danger', type: 'button',
        title: t('meet.kick'), 'aria-label': t('meet.kick'),
        onclick: async (e) => { e.stopPropagation(); await kickPeer(p); }
      }, icon('x', 16));
      actions.append(kickBtn);
    }
    return el('div', { class: 'meet-peer-row' + (p.stale ? ' stale' : '') },
      el('span', { class: 'meet-peer-dot', style: { background: p.color } }), main, actions);
  }

  function warningBanner(key, text, action = null) {
    return el('div', { class: 'meet-warn' },
      el('span', { class: 'mi' }, icon(key, 16)),
      el('div', { class: 'mt' }, text),
      action || null);
  }

  function renderPanel(s) {
    if (!s.active) {
      panel.classList.remove('show');
      panelFoot.innerHTML = '';
      panelBody.innerHTML = '';
      return;
    }
    panel.classList.add('show');
    panel.classList.toggle('collapsed', panelCollapsed);
    panelHead.setAttribute('aria-expanded', panelCollapsed ? 'false' : 'true');
    peerCountEl.textContent = t('meet.peerCount', { n: s.peers.length });
    const nearest = s.peers.find((p) => !p.stale && p.distance != null);
    nearestEl.textContent = nearest
      ? t('meet.nearest', { name: nearest.name, dist: fmtDist(nearest.distance) })
      : t('meet.noPeersHint');
    const scrollTop = panelBody.scrollTop;
    panelBody.innerHTML = '';
    panelBody.append(selfRow(s));
    if (s.peers.length) {
      for (const p of s.peers) panelBody.append(peerRow(s, p));
    } else {
      panelBody.append(el('div', { class: 'meet-peer-empty' },
        el('span', { class: 'me-ic' }, icon('meet', 22)),
        el('div', { class: 'me-t' }, t('meet.noPeers')),
        el('div', { class: 'me-d' }, t('meet.noPeersHint')),
        el('button', { class: 'btn sm primary', onclick: openShareSheet }, icon('share', 15), t('meet.copyLink'))
      ));
    }
    if (s.relayState === 'error' || s.relayState === 'reconnecting') {
      panelBody.append(warningBanner('warn', t('meet.relayErrorHint'),
        el('button', { class: 'btn sm ghost', onclick: () => navigate('settings', 'relay') }, t('meet.relaySettings'))));
    }
    if (s.geoError) {
      panelBody.append(warningBanner('pin', s.geoError === 'denied' ? t('meet.gpsDeniedHint') : t('meet.gpsUnavailableHint'),
        el('button', { class: 'btn sm ghost', onclick: () => meet.retryGeo() }, t('meet.retryGps'))));
    }
    if (s.route?.loading) {
      const p = s.peers.find((x) => x.id === s.route.peerId);
      panelBody.append(el('div', { class: 'meet-route-note' }, icon('routeFwd', 15),
        `${t('meet.routeLoading')}${p ? ' · ' + p.name : ''}`));
    } else if (s.route) {
      const p = s.peers.find((x) => x.id === s.route.peerId);
      panelBody.append(el('div', { class: 'meet-route-note' },
        icon('routeFwd', 15),
        el('div', { class: 'mr-txt' },
          el('div', {}, `${t('meet.routeHint')}${p ? ' · ' + p.name : ''} · ${fmtDist(s.route.distance)}`),
          el('div', { class: 'mr-d' }, t('meet.routePrivacy'))),
        el('button', { class: 'iconbtn meet-row-btn', title: t('meet.routeClear'), onclick: () => meet.clearRoute() }, icon('x', 15))));
    }
    panelBody.scrollTop = scrollTop;
    renderFoot(s);
  }

  function renderFoot(s) {
    panelFoot.innerHTML = '';
    const remainder = Math.max(0, s.expiresAt - Date.now());
    const countdown = el('span', { class: 'meet-countdown', 'data-countdown': '' },
      `${t('meet.expiryLabel')} ${fmtDuration(remainder)}`);
    const footTop = el('div', { class: 'mp-foot-top' }, countdown,
      el('span', { class: 'meet-foot-privacy' }, t('meet.footerPrivacy')));
    const pauseBtn = el('button', {
      class: 'btn sm ghost', onclick: () => meet.setSharing(!s.sharing)
    }, icon(s.sharing ? 'pause' : 'play', 14), s.sharing ? t('meet.pauseSharing') : t('meet.resumeSharing'));
    const leaveBtn = el('button', {
      class: 'btn sm ghost meet-leave', onclick: leaveMeetFlow
    }, icon('x', 14), t('meet.leave'));
    panelFoot.append(footTop, el('div', { class: 'mp-foot-actions' }, pauseBtn, leaveBtn));
  }

  function updateCountdown(remaining?: number) {
    const elCountdown = panel.querySelector('[data-countdown]');
    if (!elCountdown || !snap.active) return;
    const ms = remaining != null ? remaining : Math.max(0, snap.expiresAt - Date.now());
    elCountdown.textContent = `${t('meet.expiryLabel')} ${fmtDuration(ms)}`;
  }

  function renderTop(s) {
    if (!s.active) {
      top.classList.remove('show');
      tools.classList.remove('show');
      shareBtn.disabled = true;
      return;
    }
    top.classList.add('show');
    tools.classList.add('show');
    shareBtn.disabled = false;
    codeText.textContent = s.roomLabel ? `#${s.roomLabel}` : '';
    const n = s.peers.length;
    let cls = '';
    let text = t('meet.statusConnecting');
    if (s.relayState === 'connected') {
      cls = 'ok';
      text = t('meet.statusLive') + (n ? ` · ${t('meet.peerCount', { n })}` : '');
    } else if (s.relayState === 'reconnecting') {
      cls = 'probing';
      text = t('meet.statusReconnecting');
    } else if (s.relayState === 'error') {
      cls = 'bad';
      text = t('meet.statusError');
    } else {
      cls = 'probing';
    }
    statusDot.className = `dot ${cls}`;
    statusTxt.textContent = text;
    statusChip.title = s.relayError ? `${t('meet.relayErrorHint')} (${s.relayError})` : text;
  }

  function syncMap(s) {
    if (!s.active) {
      map?.clearMeetData();
      map?.clearPosition();
      autoFitDone = false;
      lastCode = '';
      return;
    }
    if (s.code !== lastCode) {
      lastCode = s.code;
      autoFitDone = false;
    }
    if (!map) {
      if (!view.classList.contains('active')) return;
      ensureMap();
    }
    map.setMeetData({ self: s.self, peers: s.peers, route: s.route });
    if (s.self?.hasFix) maybeAutoFit();
  }

  function maybeAutoFit() {
    if (!snap.active || !snap.self?.hasFix || autoFitDone || !map) return;
    if (!map.map?.isStyleLoaded()) {
      map.map?.once('load', maybeAutoFit);
      return;
    }
    autoFitDone = true;
    map.fitMeet();
  }

  function applySnapshot(s) {
    snap = s;
    if (!s.active) closeChat();
    view.classList.toggle('meet-active', !!s.active);
    empty.style.display = s.active ? 'none' : 'flex';
    updateChatBadge(s);
    renderTop(s);
    renderPanel(s);
    syncMap(s);
    updateCountdown();
  }

  function togglePanel() {
    if (!snap.active) return;
    panelCollapsed = !panelCollapsed;
    panel.classList.toggle('collapsed', panelCollapsed);
    panelHead.setAttribute('aria-expanded', panelCollapsed ? 'false' : 'true');
  }

  function toggleFollow() {
    if (!snap.active) return;
    if (!snap.self?.hasFix) {
      meet.retryGeo();
      toast(t('meet.gpsUnavailableHint'), 'warn');
      return;
    }
    map.setFollow(!map.follow);
    followBtn.classList.toggle('active', map.follow);
  }

  function flyPeer(id) {
    const s = getMeetSnapshot();
    const p = s.peers.find((x) => x.id === id);
    if (!p || p.lat == null || p.lon == null) return;
    map.flyTo(p.lat, p.lon, Math.max(map.map?.getZoom?.() || 14, 14));
  }

  async function copyText(text: string, quiet = false) {
    try {
      await navigator.clipboard.writeText(text);
      if (!quiet) toast(t('common.copied'), 'ok');
      return true;
    } catch {
      try {
        const ta = el('textarea', { style: { position: 'fixed', left: '-9999px', top: '0' } });
        ta.value = text;
        document.body.append(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (ok) {
          if (!quiet) toast(t('common.copied'), 'ok');
          return true;
        }
      } catch { /* fall through */ }
    }
    if (!quiet) toast(t('meet.copyFail'), 'err');
    return false;
  }

  function drawShareQr(canvas, url) {
    const size = 256;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    drawQr(ctx, url, 0, 0, size);
  }

  function openShareSheet() {
    const s = getMeetSnapshot();
    if (!s.active) return;
    let m;
    const canvas = el('canvas', { class: 'meet-qr-canvas', 'aria-label': t('meet.qrHint') });
    const copyCodeBtn = el('button', { class: 'btn sm' }, icon('download', 14), t('meet.copyCode'));
    copyCodeBtn.onclick = () => copyText(s.invite);
    const copyLinkBtn = el('button', { class: 'btn sm primary' }, icon('share', 14), t('meet.copyLink'));
    copyLinkBtn.onclick = () => copyText(s.link);
    const nativeBtn = el('button', { class: 'btn sm' }, icon('share', 14), t('meet.shareLink'));
    nativeBtn.onclick = async () => {
      if (navigator.share) {
        try {
          await navigator.share({ title: t('meet.title'), text: t('meet.shareHint'), url: s.link });
          return;
        } catch (err: any) {
          if (err?.name === 'AbortError') return;
        }
      }
      const ok = await copyText(s.link, true);
      if (ok) toast(t('meet.shareNotSupported'), 'info', 3000);
      else toast(t('meet.copyFail'), 'err');
    };
    const body = el('div', { class: 'meet-share' },
      el('div', { class: 'meet-room-label' }, t('meet.roomLabel', { room: s.roomLabel })),
      el('div', { class: 'meet-code-big' }, s.invite),
      el('div', { class: 'meet-share-code-actions' }, copyCodeBtn),
      el('div', { class: 'meet-code-key-note' }, t('meet.codeAsKey')),
      el('div', { class: 'meet-qr-frame' }, canvas, el('div', { class: 'meet-qr-hint' }, t('meet.qrHint'))),
      el('div', { class: 'meet-share-actions' }, copyLinkBtn, nativeBtn),
      el('div', { class: 'meet-link-box', title: s.link }, s.link),
      el('div', { class: 'meet-share-note' }, icon('shield', 15), el('div', {}, t('meet.shareHint'))),
      el('div', { class: 'meet-share-note faint' }, icon('info', 15), el('div', {}, t('meet.linkNote') + ' ' + t('meet.publicNote'))),
      el('div', { class: 'meet-share-warn' }, t('meet.expiryWarning'))
    );
    if (s.isHost) {
      const resetBtn = el('button', { class: 'btn sm ghost meet-reset-btn' }, icon('refresh', 14), t('meet.resetCode'));
      resetBtn.onclick = async () => {
        const ok = await confirmModal({
          title: t('meet.resetCode'),
          message: t('meet.resetConfirm'),
          confirmText: t('meet.resetCode'),
          danger: true
        });
        if (!ok) return;
        await meet.reset();
        m?.close();
        toast(t('meet.resetDone'), 'ok', 3500);
        openShareSheet();
      };
      body.append(el('div', { class: 'meet-share-manage' },
        el('div', { class: 'msm-title' }, t('meet.hostManage')),
        resetBtn,
        el('div', { class: 'msm-hint' }, t('meet.resetHint'))));
    }
    m = modal({
      title: t('meet.shareTitle'),
      body,
      footer: [el('button', { class: 'btn ghost', onclick: () => m.close() }, t('common.close'))]
    });
    drawShareQr(canvas, s.link);
  }

  function openCreate() {
    let m;
    const nameInp = el('input', { type: 'text', value: get('meetName') || '', placeholder: t('meet.namePlaceholder'), maxlength: '20' });
    const expSel = el('select', { style: { width: '120px' } });
    for (const [v, key] of [[60, 'expiry1h'], [120, 'expiry2h'], [240, 'expiry4h'], [480, 'expiry8h']]) {
      expSel.append(el('option', { value: v }, t(`meet.${key}`)));
    }
    expSel.value = String(get('meetExpiryMin') || 120);
    const startBtn = el('button', { class: 'btn primary' }, icon('meet', 16), t('meet.start'));
    const cancelBtn = el('button', { class: 'btn ghost', onclick: () => m.close() }, t('common.cancel'));
    const body = el('div', {},
      el('div', { class: 'field' }, el('label', {}, t('meet.nameLabel')), nameInp, el('div', { class: 'hint' }, t('meet.nameHint'))),
      el('div', { class: 'field' },
        el('label', {}, t('meet.expiryLabel')),
        expSel,
        el('div', { class: 'hint' }, t('meet.expiryNote'))),
      el('div', { class: 'meet-create-note' }, icon('shield', 15),
        el('div', {}, t('meet.expiryWarning') + ' · ' + t('meet.publicNote')))
    );
    startBtn.onclick = async () => {
      const code = startBtn;
      code.disabled = true;
      startBtn.innerHTML = '';
      startBtn.append(icon('clock', 16), t('meet.starting'));
      try {
        const expiryMin = Number(expSel.value) || 120;
        set('meetExpiryMin', expiryMin);
        await meet.create({ name: nameInp.value, expiryMin });
        m.close();
        openShareSheet();
      } catch (e) {
        console.warn('meet create failed', e);
        toast(t('meet.createFailed'), 'err', 4500);
        startBtn.disabled = false;
        startBtn.innerHTML = '';
        startBtn.append(icon('meet', 16), t('meet.start'));
      }
    };
    nameInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') startBtn.click(); });
    m = modal({ title: t('meet.create'), body, footer: [cancelBtn, startBtn] });
    setTimeout(() => nameInp.focus(), 60);
  }

  function openJoin(prefill = '') {
    let m;
    const codeInp = el('input', {
      type: 'text', value: prefill || '',
      placeholder: t('meet.codePlaceholder'), maxlength: '512', autocomplete: 'off',
      autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
      style: { fontFamily: 'var(--mono)', letterSpacing: '0.02em' }
    });
    const nameInp = el('input', { type: 'text', value: get('meetName') || '', placeholder: t('meet.namePlaceholder'), maxlength: '20' });
    const joinBtn = el('button', { class: 'btn primary' }, icon('meet', 16), t('meet.join'));
    const cancelBtn = el('button', { class: 'btn ghost', onclick: () => m.close() }, t('common.cancel'));
    const body = el('div', {},
      el('div', { class: 'field' }, el('label', {}, t('meet.codeLabel')), codeInp, el('div', { class: 'hint' }, t('meet.joinHint'))),
      el('div', { class: 'field' }, el('label', {}, t('meet.nameLabel')), nameInp, el('div', { class: 'hint' }, t('meet.nameHint'))),
      el('div', { class: 'meet-create-note' }, icon('shield', 15),
        el('div', {}, t('meet.expiryWarning') + ' · ' + t('meet.publicNote')))
    );
    joinBtn.onclick = async () => {
      const invite = normalizeMeetInvite(codeInp.value);
      if (!invite) {
        const legacy = isLegacyMeetCode(codeInp.value);
        toast(legacy ? t('meet.legacyCode') : t('meet.invalidCode'), 'warn', legacy ? 5200 : 3000);
        codeInp.focus();
        return;
      }
      joinBtn.disabled = true;
      joinBtn.innerHTML = '';
      joinBtn.append(icon('clock', 16), t('meet.starting'));
      try {
        await meet.join(invite, { name: nameInp.value });
        m.close();
      } catch (e: any) {
        console.warn('meet join failed', e);
        const legacy = e?.message === 'legacy-meet-invite';
        toast(legacy ? t('meet.legacyCode') : t('meet.joinFailed'), legacy ? 'warn' : 'err', legacy ? 5200 : 4000);
        joinBtn.disabled = false;
        joinBtn.innerHTML = '';
        joinBtn.append(icon('meet', 16), t('meet.join'));
      }
    };
    codeInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });
    nameInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });
    m = modal({ title: t('meet.joinTitle'), body, footer: [cancelBtn, joinBtn] });
    setTimeout(() => codeInp.focus(), 60);
  }

  async function kickPeer(p) {
    const ok = await confirmModal({
      title: t('meet.kickTitle'),
      message: t('meet.kickConfirm', { name: p.name }),
      confirmText: t('meet.kick'),
      danger: true
    });
    if (!ok) return;
    const done = await meet.kick(p.id);
    if (done) toast(t('meet.kicked', { name: p.name }), 'ok');
  }

  async function leaveMeetFlow() {
    const ok = await confirmModal({
      title: t('meet.leave'),
      message: t('meet.leaveConfirm'),
      confirmText: t('meet.leave'),
      danger: true
    });
    if (!ok) return;
    await meet.leave('manual');
  }

  on('meet:state', (s) => applySnapshot(s));
  on('meet:self', (s) => {
    snap = s;
    if (s.active) {
      syncMap(s);
      updateCountdown();
    }
  });
  on('meet:tick', ({ remaining }) => {
    updateCountdown(remaining);
    if (snap.active && Date.now() - lastTickRender >= 5000) {
      lastTickRender = Date.now();
      renderPanel(getMeetSnapshot());
    }
  });
  on('meet:chat', () => {
    const s = getMeetSnapshot();
    updateChatBadge(s);
    if (!chatModal) return;
    if (s.chatUnread) meet.markChatRead();
    chatRefresh?.();
  });
  on('meet:ended', ({ reason }) => {
    closeChat();
    if (reason === 'expired') toast(t('meet.expired'), 'warn', 4200);
    else if (reason === 'kicked') toast(t('meet.kickedOut'), 'warn', 4200);
    else if (reason === 'manual') toast(t('meet.left'), 'ok');
  });
  on('meet:codeReset', () => {
    closeChat();
    toast(t('meet.resetDone'), 'ok', 3500);
  });

  applySnapshot(snap);

  return {
    view,
    resize: () => { ensureMap(); map.resize(); },
    refresh: () => applySnapshot(getMeetSnapshot()),
    getMap: () => map,
    destroy: () => {
      closeChat();
      clearTimeout(photoRefTimer);
      map?.clearPhotoRef();
      map?.destroy();
      map = null;
    }
  };
}
