// Settings panel and pairing flow for cross-device trip sync.
// Pairing is out-of-band (QR/code). Signaling is encrypted through a blind
// relay; trip bytes move only over the authenticated WebRTC data channel.
import { currentLang, t } from '../core/i18n';
import { languageTag } from '../core/language';
import { get, set } from '../core/settings';
import { emit } from '../core/events';
import { drawQr } from '../core/brand';
import { listTrips } from '../core/store';
import {
  syncService, type SyncDeviceIdentity, type SyncPairingInvite, type SyncPeerRecord,
  type SyncProgress, type SyncSummary, type SyncTransportStatus
} from '../core/syncService';
import { SyncTransportError } from '../core/syncTransport';
import { appState, setActiveTrip } from './state';
import { el, icon, modal, confirmModal, toast } from './helpers';
import { openQrScanner } from './qrScanner';

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function errorText(error: any) {
  const code = String(error?.code || error?.name || 'sync-failed');
  if (code === 'AbortError' || code === 'sync-aborted') return t('sync.cancelled');
  const key = `sync.errors.${code}`;
  const text = t(key);
  if (text !== key) return text;
  return t('sync.errorGeneric', { code });
}

function statusText(status: SyncTransportStatus) {
  switch (status.phase) {
    case 'relay-connecting': return t('sync.status.relayConnecting');
    case 'relay-connected': return t('sync.status.relayConnected');
    case 'relay-retry': return t('sync.status.relayRetry');
    case 'waiting': return t('sync.status.waiting');
    case 'signaling': return t('sync.status.signaling');
    case 'connecting': return t('sync.status.connecting');
    case 'connected': return t('sync.status.connected');
    default: return t('sync.status.working');
  }
}

function progressText(progress: SyncProgress) {
  const phase = t(`sync.phase.${progress.phase}`);
  if (progress.phase === 'transfer') {
    return t('sync.progressTransfer', {
      phase,
      applied: progress.applied,
      total: Math.max(progress.applied, progress.total),
      bytes: formatBytes(progress.bytes)
    });
  }
  return phase;
}

function drawInviteQr(canvas: HTMLCanvasElement, code: string) {
  const size = 244;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  drawQr(ctx, code, 0, 0, size);
}

function copyText(text: string) {
  const fallback = () => {
    const area = el('textarea', { readonly: true, style: { position: 'fixed', left: '-9999px', top: '0' } });
    area.value = text;
    document.body.append(area);
    area.focus();
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* no clipboard */ }
    area.remove();
    if (ok) toast(t('common.copied'), 'ok');
    else toast(t('sync.copyFail'), 'err');
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => toast(t('common.copied'), 'ok')).catch(fallback);
  } else {
    fallback();
  }
}

export function createSyncPanel() {
  let identity: SyncDeviceIdentity | null = null;
  let fingerprint = '';
  let busy = false;
  let destroyed = false;

  const card = el('div', { class: 'card sync-panel' });
  const heading = el('h3', {}, icon('share', 18), t('sync.cardTitle'));
  const desc = el('div', { class: 'small muted sync-desc' }, t('sync.cardDesc'));
  const identityLine = el('div', { class: 'small mono sync-fingerprint' }, t('sync.loading'));
  const nameInput = el('input', {
    type: 'text', maxlength: '40', placeholder: t('sync.namePlaceholder'),
    autocomplete: 'off', spellcheck: 'false', disabled: ''
  }) as HTMLInputElement;
  const nameField = el('div', { class: 'field sync-name' },
    el('label', {}, t('sync.deviceName')),
    nameInput,
    el('div', { class: 'hint' }, t('sync.deviceNameHint')));
  const status = el('div', { class: 'small faint sync-line', 'aria-live': 'polite' }, '');
  const hostBtn = el('button', { class: 'btn primary' }, icon('share', 15), t('sync.hostAction'));
  const guestBtn = el('button', { class: 'btn' }, icon('camera', 15), t('sync.guestAction'));
  const pasteBtn = el('button', { class: 'btn' }, icon('keyboard', 15), t('sync.pasteAction'));
  const peersBox = el('div', { class: 'sync-peers' });
  const peersEmpty = el('div', { class: 'small faint' }, t('sync.peersEmpty'));
  const peersTitle = el('div', { class: 'settings-subhead' }, icon('shield', 15), t('sync.peersTitle'));
  const activeNote = el('div', { class: 'small faint sync-note' }, t('sync.activeNote'));
  const securityNote = el('div', { class: 'small faint sync-note' }, t('sync.securityNote'));

  const advanced = el('details', { class: 'settings-collapse sync-advanced' },
    el('summary', {}, icon('chevronRight', 14), t('sync.advanced')),
    el('div', { class: 'settings-collapse-body' },
      selectRow(t('sync.relayMode'), [['mqtt', t('sync.relayMqtt')], ['ws', t('sync.relayWs')]], 'syncRelayMode'),
      textRow(t('sync.broker'), t('sync.brokerHint'), 'syncMqttUrl', 'wss://broker.example.com:8084/mqtt'),
      textRow(t('sync.prefix'), t('sync.prefixHint'), 'syncMqttPrefix', 'roametch/v2/sync'),
      textRow(t('sync.wsUrl'), t('sync.wsHint'), 'syncWsUrl', 'wss://example.com/room/{room}'),
      textAreaRow(t('sync.stun'), t('sync.stunHint'), 'syncStun'),
      textAreaRow(t('sync.turn'), t('sync.turnHint'), 'syncTurnUrl'),
      textRow(t('sync.turnUser'), '', 'syncTurnUser'),
      textRow(t('sync.turnPass'), '', 'syncTurnPass', '', 'password'),
      el('div', { class: 'small faint sync-note' }, t('sync.iceHint')),
      el('div', { class: 'small faint sync-note' }, t('sync.changesNext'))
    ));

  card.append(heading, desc, nameField, identityLine, el('div', { class: 'row wrap sync-actions' }, hostBtn, guestBtn, pasteBtn),
    status, activeNote, securityNote, peersTitle, peersBox, peersEmpty, advanced);

  function selectRow(label: string, options: [string, string][], key: string) {
    const select = el('select');
    for (const [value, text] of options) {
      const option = el('option', { value }, text);
      if (get(key) === value) option.selected = true;
      select.append(option);
    }
    select.onchange = () => { set(key, select.value); toast(t('settings.keySaved'), 'ok', 1600); };
    return el('div', { class: 'field' }, el('label', {}, label), select);
  }

  function textRow(label: string, hint: string, key: string, placeholder = '', type = 'text') {
    const input = el('input', { type, value: get(key) || '', placeholder });
    input.onchange = () => { set(key, input.value.trim()); toast(t('settings.keySaved'), 'ok', 1600); };
    return el('div', { class: 'field' }, el('label', {}, label), input, hint ? el('div', { class: 'hint' }, hint) : null);
  }

  function textAreaRow(label: string, hint: string, key: string) {
    const input = el('textarea', { rows: '3', spellcheck: 'false' });
    input.value = get(key) || '';
    input.onchange = () => { set(key, input.value.trim()); toast(t('settings.keySaved'), 'ok', 1600); };
    return el('div', { class: 'field' }, el('label', {}, label), input, hint ? el('div', { class: 'hint' }, hint) : null);
  }

  async function ensureIdentity() {
    if (identity) return identity;
    status.textContent = t('sync.identityLoading');
    try {
      identity = await syncService.loadIdentity(get('syncDeviceName') || '');
      fingerprint = await syncService.fingerprint(identity);
      if (destroyed) return identity;
      nameInput.value = get('syncDeviceName') || identity.name;
      nameInput.disabled = false;
      identityLine.textContent = t('sync.fingerprint', { fingerprint });
      status.textContent = '';
      return identity;
    } catch (error) {
      console.error(error);
      status.textContent = t('sync.identityError');
      status.classList.add('err');
      throw error;
    }
  }

  nameInput.onchange = async () => {
    if (!identity) return;
    try {
      const updated = await syncService.renameIdentity(identity, nameInput.value);
      identity = updated;
      nameInput.value = updated.name;
      set('syncDeviceName', updated.name);
      toast(t('settings.keySaved'), 'ok', 1600);
    } catch (error) {
      console.error(error);
      toast(t('sync.nameFail'), 'err');
    }
  };

  async function renderPeers() {
    let peers: SyncPeerRecord[] = [];
    try { peers = await syncService.listPeers(); } catch { /* database unavailable */ }
    if (destroyed) return;
    peersBox.replaceChildren();
    peersEmpty.hidden = peers.length > 0;
    for (const peer of peers) {
      const remove = el('button', { class: 'btn sm ghost' }, icon('trash', 14), t('sync.remove'));
      remove.onclick = async () => {
        const ok = await confirmModal({
          title: t('sync.removeTitle'),
          message: t('sync.removeConfirm', { name: peer.name }),
          danger: true,
          confirmText: t('sync.remove')
        });
        if (!ok) return;
        try {
          await syncService.removePeer(peer.deviceId);
          toast(t('sync.removeDone'), 'ok');
          await renderPeers();
        } catch {
          toast(t('sync.removeFail'), 'err');
        }
      };
      peersBox.append(el('div', { class: 'sync-peer' },
        el('div', { class: 'sync-peer-main' },
          el('div', { class: 'sync-peer-name' }, peer.name || t('sync.unnamed')),
          el('div', { class: 'small mono faint' }, peer.fingerprint),
          el('div', { class: 'small faint' },
            `${t('sync.lastSync', { when: new Date(peer.lastSyncAt).toLocaleString(languageTag(currentLang())) })} · ${t('sync.recordCount', { n: peer.records })}`)),
        remove));
    }
  }

  function openProgressBody(title: string, subtitle: string) {
    const statusEl = el('div', { class: 'sync-status', role: 'status', 'aria-live': 'polite' }, t('sync.status.starting'));
    const detailEl = el('div', { class: 'small faint sync-detail' }, subtitle);
    return {
      body: el('div', { class: 'sync-flow' },
        el('div', { class: 'sync-flow-title' }, title),
        detailEl, statusEl),
      statusEl
    };
  }

  function showError(statusEl: HTMLElement, error: any) {
    statusEl.classList.add('err');
    statusEl.textContent = errorText(error);
  }

  function showSummary(statusEl: HTMLElement, summary: SyncSummary) {
    statusEl.classList.remove('err');
    statusEl.classList.add('ok');
    const unchanged = !summary.applied && !summary.sent && !summary.received && !summary.deleted;
    statusEl.textContent = unchanged
      ? t('sync.summaryNone')
      : t('sync.summary', {
          applied: summary.applied,
          sent: summary.sent,
          received: summary.received,
          deleted: summary.deleted,
          bytes: formatBytes(summary.bytes)
        });
  }

  async function afterSync() {
    await renderPeers();
    emit('sync:completed');
    try {
      const trips = await listTrips();
      const active = appState.activeTripId;
      const next = trips.some((trip) => trip.id === active) ? active : trips[0]?.id || null;
      await setActiveTrip(next);
    } catch (error) {
      console.warn('sync refresh failed', error);
    }
  }

  async function runEngine(
    current: SyncDeviceIdentity,
    invite: SyncPairingInvite,
    role: 'initiator' | 'responder',
    controller: AbortController,
    onStatus: (status: SyncTransportStatus) => void,
    onProgress: (progress: SyncProgress) => void,
    timeoutMs?: number
  ) {
    return syncService.sync({
      identity: current,
      invite,
      role,
      signal: controller.signal,
      onStatus,
      onProgress,
      timeoutMs
    });
  }

  async function openHostFlow() {
    if (busy) return;
    let current: SyncDeviceIdentity;
    try { current = await ensureIdentity(); } catch { return; }
    busy = true;
    try {
      const invite = await syncService.createInvite(current, { ttlMs: 10 * 60_000, name: current.name });
      const controller = new AbortController();
      let finished = false;
      const qr = el('canvas', { class: 'sync-qr', 'aria-label': t('sync.qrAlt') }) as HTMLCanvasElement;
      const codeBox = el('textarea', { class: 'sync-code', readonly: true, rows: '3', spellcheck: 'false' });
      codeBox.value = invite.code;
      const copyBtn = el('button', { class: 'btn sm' }, icon('copy', 14), t('sync.copyCode'));
      copyBtn.onclick = () => copyText(invite.code);
      const statusEl = el('div', { class: 'sync-status', role: 'status', 'aria-live': 'polite' }, t('sync.status.relayConnecting'));
      const closeBtn = el('button', { class: 'btn' }, t('common.cancel'));
      let m: ReturnType<typeof modal>;
      closeBtn.onclick = () => m.close();
      m = modal({
        title: t('sync.hostTitle'),
        body: el('div', { class: 'sync-flow' },
          el('div', { class: 'sync-qr-wrap' }, qr),
          el('div', { class: 'small muted sync-note' }, t('sync.hostDesc')),
          statusEl,
          el('details', { class: 'sync-code-details' },
            el('summary', {}, t('sync.codeToggle')),
            codeBox,
            el('div', { class: 'row wrap sync-code-actions' }, copyBtn)),
          el('div', { class: 'small faint sync-note' }, t('sync.securityNote'))),
        footer: [closeBtn],
        onClose: () => { if (!finished) controller.abort(); }
      });
      drawInviteQr(qr, invite.code);
      try {
        const summary = await runEngine(current, invite, 'initiator', controller,
          (state) => { if (!controller.signal.aborted) statusEl.textContent = statusText(state); },
          (progress) => { if (!controller.signal.aborted) statusEl.textContent = progressText(progress); },
          10 * 60_000);
        finished = true;
        closeBtn.textContent = t('common.close');
        showSummary(statusEl, summary);
        await afterSync();
      } catch (error) {
        if (!controller.signal.aborted) showError(statusEl, error);
      }
    } catch (error) {
      toast(errorText(error), 'err', 4200);
    } finally {
      busy = false;
    }
  }

  function openGuestProgress(invite: SyncPairingInvite, current: SyncDeviceIdentity) {
    const controller = new AbortController();
    let finished = false;
    const { body, statusEl } = openProgressBody(t('sync.guestTitle'), t('sync.guestDesc', { name: invite.name }));
    const closeBtn = el('button', { class: 'btn' }, t('common.cancel'));
    let m: ReturnType<typeof modal>;
    closeBtn.onclick = () => m.close();
    m = modal({
      title: t('sync.progressTitle'),
      body,
      footer: [closeBtn],
      onClose: () => { if (!finished) controller.abort(); }
    });
    void (async () => {
      try {
        const summary = await runEngine(current, invite, 'responder', controller,
          (state) => { if (!controller.signal.aborted) statusEl.textContent = statusText(state); },
          (progress) => { if (!controller.signal.aborted) statusEl.textContent = progressText(progress); },
          2 * 60_000);
        finished = true;
        closeBtn.textContent = t('common.close');
        showSummary(statusEl, summary);
        await afterSync();
      } catch (error) {
        if (!controller.signal.aborted) showError(statusEl, error);
      } finally {
        busy = false;
      }
    })();
  }

  async function openGuestFromCode(raw: string) {
    if (busy) return;
    const invite = syncService.parseInvite(raw);
    if (!invite || !await syncService.verifyInvite(invite)) {
      toast(t('sync.scanInvalid'), 'warn', 3600);
      return;
    }
    let current: SyncDeviceIdentity;
    try { current = await ensureIdentity(); } catch { return; }
    if (syncService.isSelfInvite(invite, current)) {
      toast(t('sync.self'), 'warn', 3200);
      return;
    }
    const hostFp = await syncService.hostFingerprint(invite);
    let m: ReturnType<typeof modal>;
    const cancelBtn = el('button', { class: 'btn' }, t('common.cancel'));
    cancelBtn.onclick = () => m.close();
    const connectBtn = el('button', { class: 'btn primary' }, t('sync.confirmConnect'));
    connectBtn.onclick = () => {
      m.close();
      busy = true;
      openGuestProgress(invite, current);
    };
    m = modal({
      title: t('sync.confirmTitle'),
      body: el('div', { class: 'sync-flow' },
        el('div', { class: 'sync-host-id' },
          el('div', { class: 'sync-host-name' }, invite.name || t('sync.unnamed')),
          el('div', { class: 'small mono faint' }, hostFp)),
        el('div', { class: 'small muted sync-note' }, t('sync.confirmDesc')),
        el('div', { class: 'small faint sync-note' }, t('sync.confirmFingerprint', { fingerprint: hostFp }))),
      footer: [cancelBtn, connectBtn]
    });
  }

  function openPaste() {
    if (busy) return;
    let m: ReturnType<typeof modal>;
    const area = el('textarea', { rows: '6', spellcheck: 'false', placeholder: t('sync.pastePlaceholder') });
    const cancelBtn = el('button', { class: 'btn' }, t('common.cancel'));
    cancelBtn.onclick = () => m.close();
    const connectBtn = el('button', { class: 'btn primary' }, t('sync.confirmConnect'));
    connectBtn.onclick = () => {
      const code = area.value.trim();
      if (!code) { area.focus(); return; }
      m.close();
      void openGuestFromCode(code);
    };
    m = modal({
      title: t('sync.pasteTitle'),
      body: el('div', { class: 'sync-flow' },
        el('div', { class: 'small faint sync-note' }, t('sync.pasteHint')),
        area),
      footer: [cancelBtn, connectBtn]
    });
    setTimeout(() => area.focus(), 60);
  }

  hostBtn.onclick = () => void openHostFlow();
  guestBtn.onclick = () => {
    if (busy) return;
    openQrScanner((text) => { void openGuestFromCode(text); }, {
      title: t('sync.scanTitle'),
      hint: t('sync.scanHint'),
      starting: t('sync.scanStarting'),
      cameraFail: t('sync.scanCameraFail'),
      permission: t('sync.scanPermission')
    });
  };
  pasteBtn.onclick = openPaste;

  void ensureIdentity().catch(() => {});
  void renderPeers();

  return {
    card,
    refresh: () => {
      void ensureIdentity().catch(() => {});
      void renderPeers();
    },
    destroy: () => { destroyed = true; }
  };
}
