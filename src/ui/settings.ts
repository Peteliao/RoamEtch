// Settings view: region (dual-profile) control, language/units/theme, recording prefs,
// BYOK advanced sources, debug simulation switches, storage & data management.
import { t } from '../core/i18n';
import { get, set, patch } from '../core/settings';
import { on } from '../core/events';
import { regionState, setRegionMode, runProbe } from '../core/region';
import { storageEstimate, eraseAll, isolateDamaged } from '../core/store';
import { exportBackup, restoreBackup } from '../core/backup';
import { triggerDownload } from '../core/gpx';
import { exportDiagLog } from '../core/diag';
import { startPlayback, stopPlayback, isPlaying } from '../core/simulator';
import { setLanguage, currentLang } from '../core/i18n';
import { el, icon, toast, confirmModal, filePicker } from './helpers';

export function createSettingsView(navigate) {
  const view = el('div', { class: 'view', id: 'view-settings' });
  const scroll = el('div', { class: 'view-scroll' });
  view.append(scroll);

  function card(title, ...rows) {
    return el('div', { class: 'card' }, el('h3', {}, title), ...rows);
  }
  function segRow(label, options, current, onPick, note = '') {
    const toggle = el('div', { class: 'seg-toggle' });
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
  function textRow(label, hint, key, placeholder = '') {
    const inp = el('input', { type: 'text', value: get(key) || '', placeholder });
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

  const regionCard = card(t('settings.region'),
    segRow(t('region.title'), [
      ['auto', t('region.modeAuto')], ['cn', t('region.modeCn')], ['global', t('region.modeGlobal')]
    ], get('regionMode'), (v) => { setRegionMode(v); renderProbe(); }, t('region.switchHint')),
    probeTable,
    el('div', { class: 'row', style: { marginTop: '8px' } }, reprobeBtn),
    regionNote
  );

  // ---- language / units / theme ----
  const langCard = card(t('settings.language'),
    segRow(t('settings.language'), [
      ['auto', t('settings.langAuto')], ['zh', t('settings.langZh')], ['en', t('settings.langEn')]
    ], get('language'), (v) => setLanguage(v), t('settings.langNote')),
    segRow(t('settings.units'), [['metric', t('settings.metric')], ['imperial', t('settings.imperial')]], get('units'), (v) => set('units', v)),
    segRow(t('settings.theme'), [
      ['auto', t('settings.themeAuto')], ['dark', t('settings.themeDark')], ['light', t('settings.themeLight')], ['contrast', t('settings.themeContrast')]
    ], get('theme'), (v) => set('theme', v), t('settings.themeAutoHint'))
  );

  // ---- recording ----
  const recCard = card(t('record.title'),
    segRow(t('settings.activity'), [['auto', t('settings.activityAuto')], ...['hike', 'drive', 'bike', 'run', 'travel'].map((a) => [a, t(`record.activities.${a}`)])], get('activity'), (v) => set('activity', v), t('settings.activityAutoHint')),
    segRow(t('settings.speedDisplay'), [['auto', t('settings.speedAuto')], ['speed', t('settings.speedSpeed')], ['pace', t('settings.speedPace')]], get('speedDisplay'), (v) => set('speedDisplay', v)),
    segRow(t('settings.recordQuality'), [['high', t('settings.qHigh')], ['balanced', t('settings.qBalanced')], ['low', t('settings.qLow')]], get('recordQuality'), (v) => set('recordQuality', v)),
    switchRow(t('settings.wakeLock'), t('settings.wakeLockHint'), 'wakeLock'),
    numRow(t('settings.ascentThreshold'), '3–5 m', 'ascentThreshold', { min: 1, max: 20, unit: 'm' }),
    numRow(t('settings.accuracyLimit'), '', 'accuracyLimit', { min: 10, max: 500, unit: 'm' }),
    numRow(t('settings.privacyRadius'), '', 'privacyRadius', { min: 0, max: 5000, step: 50, unit: 'm' })
  );

  // ---- advanced / BYOK ----
  const advCard = card(t('settings.advanced'),
    textRow(t('settings.tiandituKey'), t('settings.tiandituKeyHint'), 'tiandituKey', 'tk=…'),
    textRow(t('settings.maptilerKey'), '', 'maptilerKey'),
    textRow(t('settings.customTileName'), '', 'customTileName'),
    textRow(t('settings.customTile'), t('settings.customTileHint'), 'customTileUrl', 'https://…/{z}/{x}/{y}.png'),
    textRow(t('settings.elevationEndpoint'), t('settings.elevationEndpointHint'), 'elevationEndpoint', 'https://api.open-meteo.com/v1/elevation')
  );

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
    triggerDownload(exportDiagLog(), `localtrace-diag-${Date.now()}.json`);
    toast(t('settings.diagLogOk'), 'ok');
  };

  const debugCard = card(t('settings.debug'),
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
  const backupBtn = el('button', { class: 'btn sm' }, icon('download', 14), t('trips.backup'));
  backupBtn.onclick = async () => {
    const { blob, filename, tripCount } = await exportBackup();
    triggerDownload(blob, filename);
    toast(t('trips.backupOk', { n: tripCount }), 'ok');
  };
  const restoreBtn = el('button', { class: 'btn sm' }, icon('export', 14), t('trips.restore'));
  restoreBtn.onclick = async () => {
    const f = await filePicker('.trip,.zip');
    if (!f) return;
    try {
      const n = await restoreBackup(f, 'skip');
      toast(t('trips.restoreOk', { n }), 'ok');
    } catch { toast(t('trips.restoreErr'), 'err'); }
  };
  const eraseBtn = el('button', { class: 'btn sm danger' }, icon('trash', 14), t('settings.clearAll'));
  eraseBtn.onclick = async () => {
    const ok = await confirmModal({ title: t('settings.clearAll'), message: t('settings.clearConfirm'), danger: true, confirmText: t('settings.clearAll') });
    if (!ok) return;
    await eraseAll();
    toast(t('settings.cleared'), 'ok');
    refreshStorage();
  };
  async function refreshStorage() {
    const est = await storageEstimate();
    storageLine.textContent = est.quota
      ? `${t('settings.storageUsage')}: ${(est.usage / 1048576).toFixed(1)} MB / ${(est.quota / 1048576).toFixed(0)} MB`
      : t('settings.storageUsage') + ': --';
  }
  refreshStorage();
  const dataCard = card(t('trips.storage'), storageLine,
    el('div', { class: 'row wrap', style: { marginTop: '8px' } }, backupBtn, restoreBtn, eraseBtn));

  // ---- about ----
  const aboutCard = card(t('settings.about'),
    el('div', { class: 'small muted' }, t('settings.aboutText')),
    el('div', { class: 'small faint', style: { marginTop: '6px' } }, '⚠ ' + t('settings.disclaimer')));

  scroll.append(
    el('h2', { class: 'page-title' }, t('settings.title')),
    regionCard, langCard, recCard, advCard, debugCard, dataCard, aboutCard
  );

  return { view, refresh: () => { renderProbe(); renderSimBanner(); refreshStorage(); }, resize: () => {} };
}