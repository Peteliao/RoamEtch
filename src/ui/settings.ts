// Settings view: region (dual-profile) control, language/units/theme, recording prefs,
// BYOK advanced sources, debug simulation switches, storage & data management.
import { t } from '../core/i18n';
import { get, set, patch, resetSettings, MEET_P2P_NOTICE_VERSION } from '../core/settings';
import { meet } from '../core/meet';
import { on } from '../core/events';
import { regionState, setRegionMode, runProbe } from '../core/region';
import { storageEstimate, eraseAll, isolateDamaged, listTrips } from '../core/store';
import { appState, setActiveTrip } from './state';
import { triggerDownload } from '../core/gpx';
import { exportDiagLog } from '../core/diag';
import { exportBackupFlow, restoreBackupFlow, lastBackupLabel, backupDue } from './backupFlow';
import { startPlayback, stopPlayback, isPlaying } from '../core/simulator';
import { setLanguage, currentLang } from '../core/i18n';
import { generatePromo, nextVariant } from '../core/promo';
import { setRewalkVoice } from '../core/rewalk';
import { APP_VERSION } from '../core/version';
import { THEME_OPTIONS } from '../core/themeRegistry';
import { exportImage } from '../core/shareEnv';
import { openInstallGuide, installSettingsInfo } from './install';
import { el, icon, toast, confirmModal, filePicker, modal } from './helpers';

export function createSettingsView(navigate) {
  const view = el('div', { class: 'view', id: 'view-settings' });
  const scroll = el('div', { class: 'view-scroll' });
  view.append(scroll);

  function section(label) {
    return el('div', { class: 'section-label' }, label);
  }
  function panel(...rows) {
    return el('div', { class: 'card' }, ...rows);
  }
  function card(iconKey, title, ...rows) {
    return el('div', { class: 'card' }, el('h3', {}, icon(iconKey, 18), title), ...rows);
  }
  function collapsible(title, ...rows) {
    const details = el('details', { class: 'settings-collapse' },
      el('summary', {}, icon('chevronRight', 14), title),
      el('div', { class: 'settings-collapse-body' }, ...rows));
    return { details, open: () => { details.open = true; } };
  }
  function segRow(label, options, current, onPick, note = '', className = '') {
    const toggle = el('div', { class: `seg-toggle${className ? ` ${className}` : ''}` });
    for (const [val, txt] of options) {
      const b = el('button', { class: val === current ? 'active' : '' }, txt);
      b.onclick = () => {
        toggle.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        onPick(val);
      };
      toggle.append(b);
    }
    return el('div', { class: 'setting-row stack', style: { flexWrap: 'wrap' } },
      el('div', { class: 'txt' }, el('div', { class: 't' }, label), note ? el('div', { class: 'd' }, note) : null), toggle);
  }
  function switchRow(label, desc, key, onChange = null) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = !!get(key);
    cb.onchange = () => { set(key, cb.checked); onChange?.(cb.checked); };
    return el('div', { class: 'setting-row' },
      el('div', { class: 'txt' }, el('div', { class: 't' }, label), desc ? el('div', { class: 'd' }, desc) : null),
      el('label', { class: 'switch' }, cb, el('span', { class: 'slider' })));
  }
  function numRow(label, desc, key, { min = 0, max = 10000, step = 1, unit = '' } = {}) {
    const inp = el('input', { type: 'number', min, max, step, value: get(key), style: { width: '90px' } });
    inp.onchange = () => set(key, Math.max(min, Math.min(max, +inp.value || min)));
    return el('div', { class: 'setting-row' },
      el('div', { class: 'txt' }, el('div', { class: 't' }, label + (unit ? ` (${unit})` : '')), desc ? el('div', { class: 'd' }, desc) : null), inp);
  }
  function textRow(label, hint, key, placeholder = '', type = 'text') {
    const inp = el('input', { type, value: get(key) || '', placeholder });
    inp.onchange = () => { set(key, inp.value.trim()); toast(t('settings.keySaved'), 'ok', 1800); };
    return el('div', { class: 'field' }, el('label', {}, label), inp, hint ? el('div', { class: 'hint' }, hint) : null);
  }
  function textAreaRow(label, hint, key, placeholder = '') {
    const inp = el('textarea', { rows: '3', placeholder, spellcheck: 'false' });
    inp.value = get(key) || '';
    inp.onchange = () => { set(key, inp.value.trim()); toast(t('settings.keySaved'), 'ok', 1800); };
    return el('div', { class: 'field' }, el('label', {}, label), inp, hint ? el('div', { class: 'hint' }, hint) : null);
  }

  // ---- region ----
  const probeTable = el('table', { class: 'probe-table' });
  const regionNote = el('div', { class: 'small faint', style: { marginTop: '8px' } });
  function renderProbe() {
    const s = regionState;
    probeTable.innerHTML = '';
    const row = (name, st, ms) => el('tr', {},
      el('td', {}, name),
      el('td', { class: st === 'ok' ? 'ok' : st === 'fail' ? 'bad' : 'pending' },
        st === 'ok' ? '● ' + t('region.probeOk') : st === 'fail' ? '● ' + t('region.probeFail') : '○ ' + t('region.probePending')),
      el('td', { class: 'mono faint' }, ms != null ? `${ms}ms` : ''));
    probeTable.append(
      el('tr', { class: 'faint' }, el('td', {}, t('region.probeTitle')), el('td', {}, ''), el('td', {}, '')),
      row(t('region.cn'), s.probe.cn, s.probe.cnMs),
      row(t('region.global'), s.probe.global, s.probe.globalMs),
      el('tr', {}, el('td', { class: 'faint' }, t('region.syncJudge')), el('td', { colspan: 2, class: 'faint' }, s.syncGuess === 'cn' ? t('region.cn') : t('region.global')))
    );
    regionNote.textContent = s.simulated
      ? t('region.simActive', { mode: s.simulated })
      : t('region.coordNote');
  }
  renderProbe();
  on('region:probed', renderProbe);
  on('region:changed', renderProbe);
  on('region:probing', renderProbe);

  const reprobeBtn = el('button', { class: 'btn sm' }, '↻ ' + t('region.reprobe'));
  reprobeBtn.onclick = async () => {
    reprobeBtn.disabled = true;
    reprobeBtn.textContent = t('region.probing') + '…';
    await runProbe();
    renderProbe();
    reprobeBtn.disabled = false;
    reprobeBtn.textContent = '↻ ' + t('region.reprobe');
  };

  const regionCard = card('map', t('settings.region'),
    segRow(t('region.title'), [
      ['auto', t('region.modeAuto')], ['cn', t('region.modeCn')], ['global', t('region.modeGlobal')]
    ], get('regionMode'), (v) => { setRegionMode(v); renderProbe(); }, t('region.switchHint')),
    probeTable,
    el('div', { class: 'row', style: { marginTop: '8px' } }, reprobeBtn),
    regionNote
  );

  // ---- appearance ----
  const langCard = panel(
    segRow(t('settings.language'), [
      ['auto', t('settings.langAuto')], ['zh', t('settings.langZh')], ['en', t('settings.langEn')]
    ], get('language'), (v) => setLanguage(v), t('settings.langNote')),
    segRow(t('settings.units'), [['metric', t('settings.metric')], ['imperial', t('settings.imperial')]], get('units'), (v) => set('units', v)),
    segRow(t('settings.theme'), THEME_OPTIONS.map((option) => [option.id, t(option.labelKey)]),
      get('theme'), (v) => set('theme', v), t('settings.themeAutoHint'), 'theme-toggle')
  );

  // ---- recording ----
  const voiceToggle = el('input', { type: 'checkbox' });
  voiceToggle.checked = get('rewalkVoice') !== false;
  voiceToggle.onchange = () => setRewalkVoice(voiceToggle.checked);
  on('rewalk:mute', ({ muted }) => { voiceToggle.checked = !muted; });
  const voiceRow = el('div', { class: 'setting-row' },
    el('div', { class: 'txt' },
      el('div', { class: 't' }, t('settings.rewalkVoice')),
      el('div', { class: 'd' }, t('settings.rewalkVoiceHint'))),
    el('label', { class: 'switch' }, voiceToggle, el('span', { class: 'slider' })));
  const recCard = panel(
    segRow(t('settings.activity'), [['auto', t('settings.activityAuto')], ...['hike', 'drive', 'bike', 'run', 'travel'].map((a) => [a, t(`record.activities.${a}`)])], get('activity'), (v) => set('activity', v), t('settings.activityAutoHint')),
    segRow(t('settings.speedDisplay'), [['auto', t('settings.speedAuto')], ['speed', t('settings.speedSpeed')], ['pace', t('settings.speedPace')]], get('speedDisplay'), (v) => set('speedDisplay', v)),
    segRow(t('settings.recordQuality'), [['high', t('settings.qHigh')], ['balanced', t('settings.qBalanced')], ['low', t('settings.qLow')]], get('recordQuality'), (v) => set('recordQuality', v)),
    switchRow(t('settings.wakeLock'), t('settings.wakeLockHint'), 'wakeLock'),
    voiceRow,
    numRow(t('settings.ascentThreshold'), '3–5 m', 'ascentThreshold', { min: 1, max: 20, unit: 'm' }),
    numRow(t('settings.weight'), t('settings.weightHint'), 'weightKg', { min: 30, max: 200, unit: 'kg' }),
    numRow(t('settings.accuracyLimit'), '', 'accuracyLimit', { min: 10, max: 500, unit: 'm' })
  );

  // ---- privacy ----
  const privacyCard = panel(
    numRow(t('settings.privacyRadius'), t('settings.privacyRadiusHint'), 'privacyRadius', { min: 0, max: 5000, step: 50, unit: 'm' })
  );

  // ---- advanced / BYOK ----
  const advCard = card('compass', t('settings.advanced'),
    textRow(t('settings.tiandituKey'), t('settings.tiandituKeyHint'), 'tiandituKey', 'tk=…'),
    textRow(t('settings.maptilerKey'), '', 'maptilerKey'),
    textRow(t('settings.customTileName'), '', 'customTileName'),
    textRow(t('settings.customTile'), t('settings.customTileHint'), 'customTileUrl', 'https://…/{z}/{x}/{y}.png'),
    textRow(t('settings.elevationEndpoint'), t('settings.elevationEndpointHint'), 'elevationEndpoint', 'https://api.open-meteo.com/v1/elevation')
  );

  // ---- live meetup relay (blind forwarding only; key stays in the fragment) ----
  let meetRelayMode = get('meetRelayMode') || 'mqtt';
  const meetRelayFields = el('div', {});
  function renderMeetRelayFields() {
    meetRelayFields.innerHTML = '';
    if (meetRelayMode === 'ws') {
      meetRelayFields.append(
        textRow(t('settings.meetWsUrl'), t('settings.meetWsHint'), 'meetWsUrl', 'wss://example.workers.dev/room/{room}')
      );
    } else {
      const resetBtn = el('button', { class: 'btn sm ghost', type: 'button' },
        icon('refresh', 14), t('settings.meetBrokerReset'));
      resetBtn.onclick = () => {
        set('meetMqttUrl', '');
        set('meetMqttPrefix', 'roametch/v2/meet');
        renderMeetRelayFields();
        toast(t('settings.meetBrokerResetDone'), 'ok', 2200);
      };
      meetRelayFields.append(
        textRow(t('settings.meetBroker'), t('settings.meetBrokerHint'), 'meetMqttUrl', t('settings.meetBrokerAuto')),
        textRow(t('settings.meetPrefix'), t('settings.meetPrefixHint'), 'meetMqttPrefix', 'roametch/v2/meet'),
        el('div', { class: 'row wrap', style: { marginTop: '-4px' } }, resetBtn)
      );
    }
  }
  renderMeetRelayFields();
  const relaySection = el('div', { class: 'relay-settings-block' },
    el('div', { class: 'settings-subhead relay-subhead' }, icon('globe', 15), t('settings.meetRelay')),
    el('div', { class: 'small muted', style: { margin: '-2px 0 10px' } }, t('settings.meetChannelNote')),
    segRow(t('settings.meetChannel'), [
      ['mqtt', t('settings.meetMqtt')], ['ws', t('settings.meetWs')]
    ], meetRelayMode, (v) => { meetRelayMode = v; set('meetRelayMode', v); renderMeetRelayFields(); }, t('settings.meetSettingsNote')),
    meetRelayFields
  );
  const p2pToggle = el('input', { type: 'checkbox' });
  p2pToggle.checked = get('meetP2PEnabled') === true;
  p2pToggle.onchange = async () => {
    const enabled = p2pToggle.checked;
    p2pToggle.disabled = true;
    if (enabled && Number(get('meetP2PNoticeVersion')) < MEET_P2P_NOTICE_VERSION) {
      p2pToggle.checked = false;
      const accepted = await confirmModal({
        title: t('meet.p2pNoticeTitle'),
        message: t('meet.p2pNoticeBody'),
        confirmText: t('meet.p2pNoticeConfirm')
      });
      if (!accepted) { p2pToggle.disabled = false; return; }
      set('meetP2PNoticeVersion', MEET_P2P_NOTICE_VERSION);
    }
    set('meetP2PEnabled', enabled);
    if (enabled) meet.resumeP2P();
    else meet.stopP2P();
    p2pToggle.checked = enabled;
    p2pToggle.disabled = false;
  };
  const p2pSection = el('div', { class: 'relay-settings-block' },
    el('div', { class: 'settings-subhead relay-subhead' }, icon('shield', 15), t('settings.meetP2P')),
    el('div', { class: 'setting-row' },
      el('div', { class: 'txt' }, el('div', { class: 't' }, t('settings.meetP2P')), el('div', { class: 'd' }, t('settings.meetP2PHint'))),
      el('label', { class: 'switch' }, p2pToggle, el('span', { class: 'slider' }))),
    el('div', { class: 'small faint', style: { marginTop: '8px' } }, t('settings.meetP2PPrivacy')));
  const meetAdvanced = collapsible(t('settings.meetAdvanced'),
    relaySection,
    p2pSection,
    el('div', { class: 'settings-subhead' }, icon('globe', 15), t('settings.meetIce')),
    textAreaRow(t('settings.meetStun'), t('settings.meetStunHint'), 'meetStun', 'stun:stun.cloudflare.com:3478'),
    textAreaRow(t('settings.meetTurn'), t('settings.meetTurnHint'), 'meetTurnUrl', 'turn:turn.example.com:3478'),
    textRow(t('settings.meetTurnUser'), '', 'meetTurnUser'),
    textRow(t('settings.meetTurnPass'), t('settings.meetIceHint'), 'meetTurnPass', '', 'password'));
  const meetCard = card('meet', t('settings.meetGroup'),
    textRow(t('settings.meetNick'), t('settings.meetNickHint'), 'meetName', t('meet.namePlaceholder')),
    meetAdvanced.details);

  // ---- debug ----
  const simSel = el('select', { style: { width: '170px' } });
  for (const [v, k] of [['off', 'simOff'], ['cn', 'simCn'], ['global', 'simGlobal'], ['offline', 'simOffline'], ['corsfail', 'simCors']]) {
    simSel.append(el('option', { value: v }, t(`settings.${k}`)));
  }
  simSel.value = get('sim').network;
  const simEnable = el('input', { type: 'checkbox' });
  simEnable.checked = get('sim').enabled;
  function applySim() {
    patch({ sim: { ...get('sim'), enabled: simEnable.checked, network: simSel.value } });
    runProbe({ silent: true });
    renderProbe();
    renderSimBanner();
  }
  simEnable.onchange = applySim;
  simSel.onchange = applySim;

  const speedSel = el('select', { style: { width: '90px' } });
  for (const s of [1, 5, 20, 50, 100, 200]) speedSel.append(el('option', { value: s }, `${s}×`));
  speedSel.value = String(get('sim').playbackSpeed);
  speedSel.onchange = () => patch({ sim: { ...get('sim'), playbackSpeed: +speedSel.value } });

  const playBtn = el('button', { class: 'btn sm primary' }, icon('play', 14), t('settings.simStart'));
  const playFileBtn = el('button', { class: 'btn sm' }, t('settings.simFile'));
  const playStatus = el('span', { class: 'small faint' });
  playBtn.onclick = async () => {
    if (isPlaying()) { await stopPlayback(); playBtn.innerHTML = ''; playBtn.append(icon('play', 14), t('settings.simStart')); playStatus.textContent = ''; return; }
    const ok = await startPlayback({});
    if (ok) {
      playBtn.innerHTML = '';
      playBtn.append(icon('stop', 14), t('settings.simStop'));
      navigate('record');
    }
  };
  playFileBtn.onclick = async () => {
    const f = await filePicker('.gpx,application/gpx+xml,text/xml');
    if (!f) return;
    const text = await f.text();
    const ok = await startPlayback({ gpxText: text, name: f.name });
    if (ok) { navigate('record'); playBtn.innerHTML = ''; playBtn.append(icon('stop', 14), t('settings.simStop')); }
  };
  on('sim:progress', ({ i, total }) => { playStatus.textContent = `${i}/${total}`; });
  on('sim:stopped', () => { playBtn.innerHTML = ''; playBtn.append(icon('play', 14), t('settings.simStart')); playStatus.textContent = ''; });

  const simBanner = el('div', {});
  function renderSimBanner() {
    simBanner.innerHTML = '';
    if (get('sim').enabled && get('sim').network !== 'off') {
      simBanner.append(el('div', { class: 'debug-banner' }, '🧪 ' + t('region.simActive', { mode: get('sim').network })));
    }
  }
  renderSimBanner();

  const diagBtn = el('button', { class: 'btn sm' }, icon('download', 14), t('settings.diagLog'));
  diagBtn.onclick = () => {
    triggerDownload(exportDiagLog(), `roametch-diag-${Date.now()}.json`);
    toast(t('settings.diagLogOk'), 'ok');
  };

  const debugCard = card('settings', t('settings.debug'),
    simBanner,
    el('div', { class: 'setting-row' },
      el('div', { class: 'txt' }, el('div', { class: 't' }, t('settings.simNetwork')), el('div', { class: 'd' }, 'CN / Global / offline / CORS')),
      el('label', { class: 'switch' }, simEnable, el('span', { class: 'slider' })), simSel),
    el('div', { class: 'setting-row', style: { flexWrap: 'wrap' } },
      el('div', { class: 'txt' }, el('div', { class: 't' }, t('settings.simPlayback')), el('div', { class: 'd' }, t('settings.simPlaybackHint'))),
      el('div', { class: 'row' }, speedSel, playBtn)),
    el('div', { class: 'row wrap', style: { marginTop: '6px' } }, playFileBtn, playStatus),
    el('div', { class: 'sep' }),
    diagBtn
  );

  // ---- data & storage ----
  const storageLine = el('div', { class: 'small muted' });
  const backupHealthLine = el('div', { class: 'small muted', style: { marginTop: '3px' } });
  const backupBtn = el('button', { class: 'btn sm' }, icon('download', 14), t('trips.backup'));
  backupBtn.onclick = async () => {
    try { await exportBackupFlow(); refreshStorage(); }
    catch { toast(t('backup.exportErr'), 'err'); }
  };
  const restoreBtn = el('button', { class: 'btn sm' }, icon('export', 14), t('trips.restore'));
  restoreBtn.onclick = async () => {
    const f = await filePicker('.trip,.zip,.enc,application/zip,application/octet-stream');
    if (!f) return;
    try {
      await restoreBackupFlow(f, { onRestored: async () => {
        const trips = await listTrips();
        const nextId = trips.some((trip) => trip.id === appState.activeTripId) ? appState.activeTripId : trips[0]?.id || null;
        await setActiveTrip(nextId);
        await refreshStorage();
      } });
    } catch { toast(t('trips.restoreErr'), 'err'); }
  };
  const eraseBtn = el('button', { class: 'btn danger block' }, icon('trash', 14), t('settings.clearAll'));
  eraseBtn.onclick = async () => {
    const ok = await confirmModal({ title: t('settings.clearAll'), message: t('settings.clearConfirm'), danger: true, confirmText: t('settings.clearAll') });
    if (!ok) return;
    const again = await confirmModal({ title: t('settings.dangerTitle'), message: t('settings.clearConfirm2'), danger: true, confirmText: t('common.confirm') });
    if (!again) return;
    await eraseAll();
    await setActiveTrip(null);
    toast(t('settings.cleared'), 'ok');
    refreshStorage();
  };
  const resetBtn = el('button', { class: 'btn sm' }, icon('refresh', 14), t('settings.resetAction'));
  resetBtn.onclick = async () => {
    const ok = await confirmModal({
      title: t('settings.resetTitle'),
      message: t('settings.resetConfirm'),
      confirmText: t('settings.resetAction')
    });
    if (!ok) return;
    meet.stopP2P();
    resetSettings();
    toast(t('settings.resetDone'), 'ok', 1600);
    setTimeout(() => location.reload(), 450);
  };
  async function refreshStorage() {
    const est = await storageEstimate();
    storageLine.textContent = est.quota
      ? `${t('settings.storageUsage')}: ${(est.usage / 1048576).toFixed(1)} MB / ${(est.quota / 1048576).toFixed(0)} MB`
      : t('settings.storageUsage') + ': --';
    backupHealthLine.textContent = t('backup.lastBackup', { when: lastBackupLabel() }) + (backupDue() ? ' · ' + t('backup.dueShort') : '');
    backupHealthLine.style.color = backupDue() ? 'var(--warn)' : '';
  }
  refreshStorage();
  on('backup:exported', refreshStorage);
  const dangerZone = el('div', { class: 'danger-zone' },
    el('div', { class: 'dz-title' }, icon('warn', 14), t('settings.dangerTitle')),
    el('div', { class: 'small faint', style: { marginBottom: '10px' } }, t('settings.dangerHint')),
    eraseBtn);
  const dataCard = card('database', t('settings.dataBackup'), storageLine, backupHealthLine,
    el('div', { class: 'row wrap', style: { marginTop: '8px' } }, backupBtn, restoreBtn),
    el('div', { class: 'settings-subhead' }, icon('refresh', 15), t('settings.resetTitle')),
    el('div', { class: 'small muted', style: { margin: '-2px 0 10px' } }, t('settings.resetDesc')),
    resetBtn,
    el('div', { class: 'sep' }),
    dangerZone);

  // ---- shareable promo image ----
  function copyPromoCaption(caption) {
    const text = caption;
    const fallback = () => {
      const area = el('textarea', { readonly: true, rows: '11' });
      area.value = text;
      const m = modal({
        title: t('settings.promoCopy'),
        body: el('div', { class: 'field' }, area),
        footer: [el('button', { class: 'btn primary', onclick: () => m.close() }, t('common.close'))]
      });
      setTimeout(() => { area.focus(); area.select(); }, 60);
      toast(t('settings.promoCopyFail'), 'warn');
    };
    const paste = async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast(t('settings.promoCopied'), 'ok');
        return;
      } catch { /* fall back to a hidden textarea */ }
      try {
        const area = el('textarea', { style: { position: 'fixed', left: '-9999px', top: '0' } });
        area.value = text;
        document.body.append(area);
        area.focus();
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        if (ok) {
          toast(t('settings.promoCopied'), 'ok');
          return;
        }
      } catch { /* fall through */ }
      fallback();
    };
    paste();
  }
  function openPromoPreview(blob, filename, caption, variant) {
    let current = { blob, filename, caption, variant };
    let currentFile = new File([blob], filename, { type: 'image/png' });
    const canShare = !!navigator.share && !!navigator.canShare?.({ files: [currentFile] });
    let currentUrl = URL.createObjectURL(blob);
    let closed = false;
    const img = el('img', { class: 'promo-preview-img', src: currentUrl, alt: t('settings.promoPreviewAlt') });
    img.dataset.variant = String(variant);
    const copyBtn = el('button', { class: 'btn' }, icon('copy', 16), t('settings.promoCopy'));
    const nextBtn = el('button', { class: 'btn' }, icon('refresh', 16), t('settings.promoNext'));
    const saveBtn = el('button', { class: `btn ${canShare ? '' : 'primary'}` }, icon('download', 16), t('settings.promoDownload'));
    const shareBtn = canShare
      ? el('button', { class: 'btn primary' }, icon('share', 16), t('settings.promoShare'))
      : null;
    const setBusy = (busy: boolean) => {
      nextBtn.disabled = busy;
      saveBtn.disabled = busy;
      if (shareBtn) shareBtn.disabled = busy;
    };
    const applyPromo = (result: typeof current) => {
      const nextFile = new File([result.blob], result.filename, { type: 'image/png' });
      const nextUrl = URL.createObjectURL(result.blob);
      const previousUrl = currentUrl;
      current = result;
      currentFile = nextFile;
      img.src = nextUrl;
      img.dataset.variant = String(result.variant);
      currentUrl = nextUrl;
      URL.revokeObjectURL(previousUrl);
    };
    const m = modal({
      title: t('settings.promoPreviewTitle'),
      body: el('div', {},
        el('div', { class: 'small muted promo-preview-note' }, t('settings.promoKeep')),
        img),
      footer: [nextBtn, copyBtn, saveBtn, shareBtn].filter(Boolean),
      onClose: () => {
        if (closed) return;
        closed = true;
        URL.revokeObjectURL(currentUrl);
      }
    });
    copyBtn.onclick = () => copyPromoCaption(current.caption);
    nextBtn.onclick = async () => {
      if (closed || nextBtn.disabled) return;
      const requestedVariant = nextVariant(current.variant);
      setBusy(true);
      try {
        const result = await generatePromo(requestedVariant);
        if (!closed) applyPromo(result);
      } catch (err) {
        if (!closed) {
          console.error(err);
          toast(t('settings.promoFailed'), 'err');
        }
      } finally {
        if (!closed) setBusy(false);
      }
    };
    saveBtn.onclick = async () => {
      const res = await exportImage(current.blob, current.filename);
      if (res.mode === 'longpress') {
        img.src = res.dataUrl;
        toast(t('settings.promoLongPress'), 'warn');
      } else {
        toast(t('settings.promoDownloaded'), 'ok');
      }
    };
    if (shareBtn) {
      shareBtn.onclick = async () => {
        try {
          await navigator.share({ title: t('promo.shareTitle'), text: current.caption, files: [currentFile] });
        } catch (e) {
          if (e?.name !== 'AbortError') saveBtn.click();
        }
      };
    }
  }
  const promoBtn = el('button', { class: 'btn primary' }, icon('sparkles', 15), t('settings.promoAction'));
  let promoBusy = false;
  promoBtn.onclick = async () => {
    if (promoBusy) return;
    promoBusy = true;
    promoBtn.disabled = true;
    promoBtn.replaceChildren(icon('refresh', 15), t('settings.promoGenerating'));
    try {
      const { blob, filename, caption, variant } = await generatePromo();
      openPromoPreview(blob, filename, caption, variant);
    } catch (err) {
      console.error(err);
      toast(t('settings.promoFailed'), 'err');
    } finally {
      promoBusy = false;
      promoBtn.disabled = false;
      promoBtn.replaceChildren(icon('sparkles', 15), t('settings.promoAction'));
    }
  };
  const promoCard = card('sparkles', t('settings.promoTitle'),
    el('div', { class: 'promo-hero' },
      el('img', { src: './icons/icon-192.png', alt: '', width: '52', height: '52', loading: 'lazy' }),
      el('div', { style: { minWidth: '0' } },
        el('div', { class: 'promo-headline' }, t('app.slogan')),
        el('div', { class: 'small muted' }, t('app.brandLine')))),
    el('div', { class: 'small muted', style: { margin: '10px 0' } }, t('settings.promoDesc')),
    promoBtn,
    el('div', { class: 'small faint', style: { marginTop: '8px' } }, t('settings.promoKeep'))
  );
  promoCard.classList.add('promo-card');

  // ---- install ----
  const installInfo = installSettingsInfo();
  const installBtn = installInfo.installed
    ? el('button', { class: 'btn sm', disabled: true }, icon('check', 14), t('settings.installDone'))
    : el('button', { class: 'btn sm primary', onclick: () => openInstallGuide() }, icon('download', 14), t('settings.installAction'));
  const installCard = card('download', t('settings.installTitle'),
    el('div', { class: 'small muted', style: { marginBottom: '10px' } }, t('settings.installDesc')),
    installBtn
  );

  // ---- about ----
  const debugSlot = el('div', { class: 'settings-debug', style: { display: 'none' } }, debugCard);
  let debugTaps = 0;
  let debugTimer = 0;
  const aboutVersion = el('button', { class: 'about-version' }, t('settings.aboutText', { version: APP_VERSION }));
  aboutVersion.onclick = () => {
    debugTaps++;
    clearTimeout(debugTimer);
    if (debugTaps >= 7) {
      debugTaps = 0;
      debugSlot.style.display = '';
      debugSlot.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    debugTimer = window.setTimeout(() => { debugTaps = 0; }, 2200);
  };
  const aboutCard = card('info', t('settings.about'),
    aboutVersion,
    el('div', { class: 'small faint', style: { marginTop: '6px' } }, '⚠ ' + t('settings.disclaimer')));
  const mapAdvanced = collapsible(t('settings.advanced'), advCard, meetCard);

  scroll.append(
    el('div', { class: 'page-head' }, el('h2', { class: 'page-title' }, t('settings.title'))),
    section(t('settings.appearanceGroup')), langCard,
    section(t('settings.recordGroup')), recCard,
    section(t('settings.privacyGroup')), privacyCard,
    section(t('settings.mapGroup')), regionCard, mapAdvanced.details,
    section(t('settings.dataGroup')), dataCard,
    section(t('settings.aboutGroup')), aboutCard, installCard, promoCard, debugSlot
  );

  return {
    view,
    refresh: () => { renderProbe(); renderSimBanner(); refreshStorage(); },
    resize: () => {},
    focus: (intent) => {
      const anchor = typeof intent === 'string' ? intent : intent?.anchor;
      if (anchor !== 'relay') return;
      requestAnimationFrame(() => {
        mapAdvanced.open();
        meetAdvanced.open();
        relaySection.scrollIntoView({ behavior: 'smooth', block: 'center' });
        meetCard.classList.remove('settings-focus');
        void meetCard.offsetWidth;
        meetCard.classList.add('settings-focus');
        setTimeout(() => meetCard.classList.remove('settings-focus'), 2000);
      });
    }
  };
}
