// Record view: map + live panel + controls + OLED power-save lock.
import { t, currentLang } from '../core/i18n';
import { get, set } from '../core/settings';
import { on, emit } from '../core/events';
import { rec, startRecording, pauseRecording, resumeRecording, stopRecording, continueTrip, findRecoverableTrip, createManualTrip, retryGeolocation, setRecordingActivity, flushBuffer } from '../core/recorder';
import { armKeepAlive, disarmKeepAlive, isKeepAliveActive } from '../core/keepalive';
import { requestWakeLock, releaseWakeLock } from '../core/wakelock';
import { setThemeColorOverride, setThemeModeOverride } from '../core/theme';
import { regionState } from '../core/region';
import { availableBasemaps } from '../core/providers';
import { fmtDistance, fmtDuration, fmtSpeed, fmtPace, fmtAltitude, signalLevel, haversine, bearing } from '../core/geo';
import { estimateCalories } from '../core/calories';
import { altSourceShortKey, altSourceTagClass } from '../core/elevation';
import { loadTripFull, updateTrip, getTrip, listWaypoints, addPhotoWaypoint, deletePhotoWaypoint } from '../core/store';
import { onBroadcast } from '../core/locks';
import { TrackMap } from './map';
import { WP_ICONS } from '../core/waypointMeta';
import { rewalk, stopRewalk, toggleMute, startSim, stopSim } from '../core/rewalk';
import { appState, setActiveTrip } from './state';
import { openWaypointModal, moveWaypoint, moveVertex, insertVertex, deleteVertex, undoEdit, redoEdit, histState } from './editor';
import { el, icon, toast, modal, promptModal } from './helpers';
import { confirmModal } from './helpers';
import { openCamera } from './camera';

export function createRecordView() {
  const view = el('div', { class: 'view', id: 'view-record' });
  const mapContainer = el('div', { id: 'map-container' });
  const layerPill = el('button', { class: 'map-layer-pill', onclick: openLayerSheet });
  const tools = el('div', { class: 'map-tools' });
  const controls = el('div', { class: 'rec-controls' });
  view.append(mapContainer, layerPill, tools, controls);

  let map = null;
  let psActive = false;
  let unlockGuardUntil = 0;
  let unlockReleaseTimer = 0;
  const swallowUnlockGhostClick = (e) => {
    if (performance.now() >= unlockGuardUntil) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const releaseUnlockGuard = () => {
    unlockGuardUntil = performance.now() + 500;
    document.removeEventListener('pointerup', releaseUnlockGuard, true);
    document.removeEventListener('pointercancel', releaseUnlockGuard, true);
    clearTimeout(unlockReleaseTimer);
  };
  function armUnlockGuard() {
    unlockGuardUntil = Infinity;
    document.addEventListener('pointerup', releaseUnlockGuard, true);
    document.addEventListener('pointercancel', releaseUnlockGuard, true);
    clearTimeout(unlockReleaseTimer);
    unlockReleaseTimer = window.setTimeout(releaseUnlockGuard, 6000);
  }
  document.addEventListener('click', swallowUnlockGhostClick, true);
  let oledThemeActive = false;
  let viewingTrip = null;
  let recoverable = null;
  let readOnly = false;

  // ---------- map ----------
  function initialCenter() {
    if (regionState.effective === 'cn') return { center: [116.4, 39.9], zoom: 9 };
    return { center: [10, 30], zoom: 3 };
  }
  function buildMap() {
    const { center, zoom } = initialCenter();
    map = new TrackMap(mapContainer, {
      fallbackText: t('map.fallback'),
      onWaypointClick: (wp) => openWaypointModal(wp, recEditOpts()),
      onWaypointMove: (wp, lon, lat) => moveWaypoint(wp, lon, lat),
      onMapClick: (lon, lat) => { if (appState.editMode && appState.activeTripId) openWaypointModal({ lat, lon }); },
      onVertexMove: (segId, idx, lon, lat) => moveVertex(segId, idx, lon, lat),
      onVertexInsert: (segId, idx, lon, lat) => insertVertex(segId, idx, lon, lat),
      onVertexDelete: (segId, idx) => deleteVertex(segId, idx)
    }).init(center, zoom);
    return map;
  }
  buildMap();

  // ---------- layers (one entry, bottom sheet) ----------
  function basemapLabel(b) {
    return get('language') === 'en' || (get('language') === 'auto' && !navigator.language.startsWith('zh')) ? b.nameEn : b.name;
  }
  function renderMapLayer() {
    const list = availableBasemaps();
    const cur = list.find((b) => b.id === map?.basemapId) || list[0];
    layerPill.innerHTML = '';
    if (cur) {
      layerPill.append(icon('layers', 16),
        el('span', { class: 'ml-name' }, basemapLabel(cur)),
        el('span', { class: 'ml-cs' }, cur.coordSystem === 'GCJ02' ? 'GCJ' : 'WGS'),
        el('span', { class: 'chev' }, icon('chevron', 14)));
      layerPill.title = `${t('map.layers')} · ${t('map.styleCs')}: ${cur.coordSystem}`;
    }
    if (map?.vectorFallback) layerPill.append(el('span', { class: 'ml-cs' }, t('map.vectorShort')));
  }
  renderMapLayer();

  function openLayerSheet() {
    let m;
    const list = availableBasemaps();
    const rows = list.map((b) => el('button', {
      class: 'sheet-row' + (map?.basemapId === b.id ? ' active' : ''),
      onclick: () => { map.setBasemap(b.id); m.close(); renderMapLayer(); }
    },
      el('span', { class: 's-ic' }, icon(b.kind === 'satellite' ? 'globe' : b.kind === 'terrain' ? 'mountain' : 'map', 18)),
      el('span', { class: 's-txt' },
        el('div', { class: 's-t' }, basemapLabel(b)),
        el('div', { class: 's-d' }, `${t(`map.${b.kind}`)} · ${b.coordSystem === 'GCJ02' ? 'GCJ-02' : 'WGS-84'}`)),
      map?.basemapId === b.id ? el('span', { class: 's-check' }, icon('check', 18)) : null
    ));
    m = modal({
      title: t('map.layers'),
      body: el('div', {},
        el('div', { class: 'sheet-list' }, rows),
        el('div', { class: 'sheet-note' }, t('map.layerNote')))
    });
  }

  on('region:changed', renderMapLayer);
  on('region:probed', renderMapLayer);
  on('settings:changed', ({ key }) => { if (['tiandituKey', 'customTileUrl', 'language'].includes(key)) renderMapLayer(); });
  on('map:basemap', renderMapLayer);

  // ---------- tools ----------
  const followBtn = el('button', {
    class: 'iconbtn', title: t('record.follow'),
    onclick: () => {
      if (!map.posMarker) { locateOnce({ follow: true }); return; }
      map.setFollow(!map.follow);
      followBtn.classList.toggle('active', map.follow);
    }
  }, icon('follow'));
  const fitBtn = el('button', { class: 'iconbtn', title: t('record.fit'), onclick: () => map.fitTrack() }, icon('fit'));
  const undoBtn = el('button', { class: 'iconbtn', title: t('edit.undo'), onclick: undoEdit, style: { display: 'none' } }, icon('undo'));
  const redoBtn = el('button', { class: 'iconbtn', title: t('edit.redo'), onclick: redoEdit, style: { display: 'none' } }, icon('redo'));
  const moreBtn = el('button', { class: 'iconbtn', title: t('record.moreTools'), onclick: openMoreSheet }, icon('more'));
  tools.append(followBtn, fitBtn, undoBtn, redoBtn, moreBtn);
  on('map:followoff', () => followBtn.classList.remove('active'));
  on('history:changed', (s) => {
    undoBtn.style.display = appState.editMode ? '' : 'none';
    redoBtn.style.display = appState.editMode ? '' : 'none';
    undoBtn.disabled = !s.canUndo;
    redoBtn.disabled = !s.canRedo;
  });

  function openMoreSheet() {
    const canEdit = rec.status !== 'recording';
    const canUndo = histState().canUndo;
    const canRedo = histState().canRedo;
    let m;
    const close = (fn) => { m.close(); fn(); };
    const row = (opts) => el('button', { class: 'sheet-row' + (opts.active ? ' active' : '') + (opts.danger ? ' danger' : ''), disabled: opts.disabled, onclick: opts.onclick },
      el('span', { class: 's-ic' }, icon(opts.iconKey, 18)),
      el('span', { class: 's-txt' }, el('div', { class: 's-t' }, opts.title), opts.desc ? el('div', { class: 's-d' }, opts.desc) : null),
      opts.active ? el('span', { class: 's-check' }, icon('check', 18)) : null);
    const body = el('div', { class: 'sheet-list' },
      row({
        iconKey: 'edit', title: t('record.editMode'), desc: t('record.editHint'),
        active: appState.editMode, disabled: !canEdit,
        onclick: () => close(() => toggleEdit())
      }),
      row({ iconKey: 'undo', title: t('edit.undo'), disabled: !appState.editMode || !canUndo, onclick: () => close(undoEdit) }),
      row({ iconKey: 'redo', title: t('edit.redo'), disabled: !appState.editMode || !canRedo, onclick: () => close(redoEdit) }),
      row({ iconKey: 'powerlock', title: t('record.powerLock'), desc: t('record.powerLockHint'), onclick: () => close(() => setPowerLock(true)) })
    );
    m = modal({ title: t('record.moreTools'), body });
  }

  function toggleEdit() {
    if (rec.status === 'recording') { toast(t('record.statusRecording'), 'warn'); return; }
    if (!appState.activeTripId) { toast(t('analysis.noTrip'), 'warn'); return; }
    appState.editMode = !appState.editMode;
    map.setEditMode(appState.editMode);
    moreBtn.classList.toggle('active', appState.editMode);
    undoBtn.style.display = appState.editMode ? '' : 'none';
    redoBtn.style.display = appState.editMode ? '' : 'none';
    if (appState.editMode) toast(t('record.editModeOn'), 'info', 3500);
  }

  // ---------- live panel ----------
  const panel = el('div', { class: 'live-panel' + (get('panelCollapsed') ? ' collapsed' : '') });
  const pStatus = el('span', { class: 'st idle' }, t('record.statusIdle'));
  const pSave = el('span', { class: 'lp-save' });
  pSave.onclick = (e) => {
    e.stopPropagation();
    if (!rec.saveState.error) return;
    if (rec.saveState.error === 'finalize') void onStop();
    else void retrySave();
  };
  const pHead = el('div', { class: 'lp-head', onclick: togglePanel },
    pStatus, pSave, el('span', { class: 'rec-dot', id: 'panel-rec-dot' }), el('span', { class: 'chev' }, icon('chevron', 16)));
  function togglePanel() {
    panel.classList.toggle('collapsed');
    set('panelCollapsed', panel.classList.contains('collapsed'));
  }
  const compact = el('div', { class: 'lp-compact' });
  function metric(key, hero = false) {
    const v = el('div', { class: 'v' }, '--');
    const k = el('div', { class: 'k' }, t(key));
    const c = el('div', { class: 'lp-metric' + (hero ? ' hero' : '') }, v, k);
    compact.append(c);
    return { v, k, c };
  }
  const cDist = metric('panel.distance', true);
  const cDur = metric('panel.duration');
  const cSpeed = metric('panel.speed');
  cSpeed.c.classList.add('tap');
  cSpeed.c.title = t('settings.speedDisplay');
  cSpeed.c.onclick = () => {
    const cur = speedMode();
    set('speedDisplay', cur === 'speed' ? 'pace' : 'speed');
    if (rec.live) renderPanel(rec.live);
  };
  const moreGrid = el('div', { class: 'lp-more' });
  function moreCell(key) {
    const v = el('div', { class: 'v' }, '--');
    const k = el('div', { class: 'k' }, t(key));
    const c = el('div', { class: 'lp-more-cell' }, v, k);
    moreGrid.append(c);
    return { v, k, c };
  }
  const cAvg = moreCell('panel.avgSpeed');
  const cCal = moreCell('panel.calories');
  const cAlt = moreCell('panel.altitude');
  const cAsc = moreCell('panel.ascent');
  const cDesc = moreCell('panel.descent');
  const cSig = moreCell('panel.signal');
  const detail = el('div', { class: 'lp-detail' });
  panel.append(pHead, compact, moreGrid, detail);

  const SIG_KEYS = ['', 'Weak', 'Fair', 'Good', 'Strong'];
  function renderSignal(host, acc) {
    const lv = signalLevel(acc);
    host.innerHTML = '';
    const bars = el('span', { class: `sig-bars lv${lv}` });
    for (let i = 0; i < 4; i++) bars.append(el('i'));
    host.append(bars, el('small', { class: 'sig-txt' }, lv ? t(`panel.sig${SIG_KEYS[lv]}`) : '--'));
  }

  let liveActivity = 'auto';
  function currentActivity() {
    if (rec.tripId && (rec.status === 'recording' || rec.status === 'paused')) return liveActivity;
    return appState.activeTripFull?.trip?.activity || get('activity');
  }
  function speedMode() {
    const s = get('speedDisplay');
    if (s === 'speed' || s === 'pace') return s;
    const a = currentActivity();
    return a === 'hike' || a === 'run' ? 'pace' : 'speed';
  }

  function renderPanel(L) {
    if (!L) return;
    const units = get('units');
    const d = fmtDistance(L.distance, units);
    cDist.v.innerHTML = `${d.v}<small>${d.u}</small>`;
    cDur.v.textContent = fmtDuration(L.duration);
    if (speedMode() === 'pace') {
      const p = fmtPace(L.speed, units);
      cSpeed.v.innerHTML = `${p.v}<small>${p.u}</small>`;
      cSpeed.k.textContent = t('panel.pace');
    } else {
      const s = fmtSpeed(L.speed, units);
      cSpeed.v.innerHTML = `${s.v}<small>${s.u}</small>`;
      cSpeed.k.textContent = t('panel.speed');
    }
    const avg = L.movingMs > 0 ? L.distance / (L.movingMs / 1000) : 0;
    const av = fmtSpeed(avg, units);
    cAvg.v.innerHTML = `${av.v}<small>${av.u}</small>`;
    const baseAct = currentActivity();
    const act = baseAct === 'auto' ? rec.activityGuess : baseAct;
    const cal = act ? estimateCalories(act, L.movingMs, avg, get('weightKg')) : null;
    cCal.v.innerHTML = cal != null ? `${cal}<small> kcal</small>` : '—';
    const a = fmtAltitude(L.alt, units);
    cAlt.v.innerHTML = `${a.v}<small>${a.u}</small> <span class="tag ${altSourceTagClass(L.altSrc)}">${t(altSourceShortKey(L.altSrc))}</span>`;
    cAsc.v.innerHTML = `${Math.round(L.ascent)}<small>m</small>`;
    cDesc.v.innerHTML = `${Math.round(L.descent)}<small>m</small>`;
    renderSignal(cSig.v, L.acc);
    cSig.k.textContent = L.acc != null ? `${t('panel.signal')} ±${Math.round(L.acc)}m` : t('panel.signal');
    const slopeTxt = L.slope != null ? `${L.slope > 0 ? '+' : ''}${L.slope.toFixed(1)}%` : '--';
    detail.innerHTML = '';
    const mx = fmtSpeed(L.maxSpeed || 0, units);
    const items = [
      el('span', {}, `${t('panel.slope')} ${slopeTxt}`),
      el('span', {}, `${t('panel.maxSpeed')} ${mx.v}${mx.u}`),
      el('span', {}, `${t('panel.moving')} ${fmtDuration(L.movingMs, { compact: true })}`),
      el('span', {}, `${t('panel.still')} ${fmtDuration(L.stillMs, { compact: true })}`),
      el('span', {}, `${t('panel.points')} ${L.pointCount}`)
    ];
    if (L.segCount > 1) items.push(el('span', {}, `${t('panel.segments')} ${L.segCount}`));
    if (L.lat != null) items.push(el('span', { class: 'lp-coords' }, `${L.lat.toFixed(5)}, ${L.lon.toFixed(5)}`));
    detail.append(...items);
  }

  function renderSaveChip() {
    const active = rec.status === 'recording' || rec.status === 'paused';
    pSave.style.display = active ? '' : 'none';
    const s = rec.saveState;
    pSave.className = 'lp-save';
    if (!active) return;
    if (s.error) {
      pSave.classList.add('bad');
      pSave.textContent = t('record.saveFailedShort');
      pSave.title = t('record.saveFailed', { n: s.pending });
    } else if (s.pending > 0) {
      pSave.classList.add('pending');
      pSave.textContent = t('record.savePendingShort', { n: s.pending });
      pSave.title = t('record.savePending', { n: s.pending });
    } else {
      pSave.textContent = t('record.saveOkShort');
      pSave.title = s.lastSavedAt
        ? `${t('record.saveOk')} · ${new Date(s.lastSavedAt).toLocaleTimeString()}`
        : t('record.saveOk');
    }
  }

  function renderStatus() {
    const dot = panel.querySelector('#panel-rec-dot');
    const mapSt = { idle: 'statusIdle', recording: 'statusRecording', paused: 'statusPaused', finished: 'statusFinished' };
    let extra = rec.simulated ? ` · ${t('record.simRecording')}` : '';
    if (!rec.simulated && rec.status === 'recording') {
      if (rec.geoError) extra += ` · ${t('record.statusGap')}`;
      else if (!rec.firstFixT) extra += ` · ${t('record.searching')}`;
    }
    pStatus.textContent = t(`record.${mapSt[rec.status] || 'statusIdle'}`) + extra;
    pStatus.className = `st ${rec.status}`;
    dot.className = `rec-dot ${rec.status}`;
    renderSaveChip();
    emit('recstatus:changed', rec.status);
  }

  // ---------- buttons ----------
  const actRow = el('div', { class: 'rec-activity' });
  const btnRow = el('div', { class: 'rec-buttons' });
  const activitySel = el('select', { class: 'btn sm', style: { maxWidth: '130px' } });
  for (const a of ['auto', 'hike', 'drive', 'bike', 'run', 'travel']) {
    activitySel.append(el('option', { value: a }, a === 'auto' ? t('record.activityAuto') : t(`record.activities.${a}`)));
  }
  activitySel.value = get('activity');
  activitySel.onchange = () => set('activity', activitySel.value);
  const autoTag = el('span', { class: 'live-auto-tag' });
  const liveActSel = el('select', { class: 'live-act-select' });
  for (const a of ['auto', 'hike', 'drive', 'bike', 'run', 'travel']) {
    liveActSel.append(el('option', { value: a }, a === 'auto' ? t('record.activityAuto') : t(`record.activities.${a}`)));
  }
  const liveActWrap = el('div', { class: 'live-act-mode' },
    icon('compass', 14),
    el('span', { class: 'la-k' }, t('record.activityLabel')),
    liveActSel,
    el('span', { class: 'la-chev' }, icon('chevron', 13)));
  liveActSel.onchange = async () => {
    liveActivity = liveActSel.value;
    if (rec.tripId) { await updateTrip(rec.tripId, { activity: liveActivity }); setRecordingActivity(liveActivity); }
    if (liveActivity !== 'auto') rec.activityGuess = null;
    renderAutoTag();
  };
  function renderAutoTag() {
    const mode = (rec.status === 'recording' || rec.status === 'paused') ? liveActivity : get('activity');
    if (mode !== 'auto') { autoTag.style.display = 'none'; return; }
    autoTag.style.display = '';
    autoTag.classList.toggle('detected', !!rec.activityGuess);
    autoTag.innerHTML = '';
    if (rec.activityGuess) {
      autoTag.append(icon('sparkles', 12),
        el('span', {}, t('record.autoDetectedShort', { a: t(`record.activities.${rec.activityGuess}`) })));
    } else {
      autoTag.append(el('span', { class: 'la-pulse' }), el('span', {}, t('record.autoDetecting')));
    }
  }
  renderAutoTag();

  const bannerBox = el('div', {});
  const viewBar = el('div', { class: 'view-trip-bar', style: { display: 'none' } });

  // ---------- re-walk navigation panel ----------
  let rwFollowOn = true;
  const rewalkBox = el('div', { class: 'rewalk-card', style: { display: 'none' } });
  const rwName = el('div', { class: 'rw-name' });
  const rwPhase = el('span', { class: 'rw-phase' }, t('rewalk.phaseLocating'));
  const rwPct = el('span', { class: 'rw-pct mono' }, '0%');
  const rwBarFill = el('div', { class: 'rw-fill' });
  const rwLeftK = el('span', { class: 'rw-k' }, t('rewalk.remaining'));
  const rwLeft = el('span', { class: 'mono' }, '--');
  const rwDir = el('span', { class: 'rw-dir', style: { display: 'none' } }, icon('chevronRight', 15));
  const rwOff = el('span', { class: 'rw-off' }, t('rewalk.onTrack'));
  const rwNext = el('div', { class: 'rw-next small' });
  const rwFollow = el('button', { class: 'btn sm active', onclick: () => { rwFollowOn = !rwFollowOn; rwFollow.classList.toggle('active', rwFollowOn); } }, icon('follow', 14), t('record.follow'));
  const rwMute = el('button', { class: 'btn sm', onclick: () => toggleMute() }, t('rewalk.mute'));
  const rwSim = el('button', { class: 'btn sm', onclick: () => (rewalk.sim ? stopSim() : startSim()) }, t('rewalk.simWalk'));
  const rwExit = el('button', { class: 'btn sm danger', onclick: () => { stopRewalk(); toast(t('rewalk.exited'), 'info', 2000); } }, icon('x', 14), t('rewalk.exit'));
  rewalkBox.append(
    el('div', { class: 'row rw-head', style: { alignItems: 'center', gap: '8px' } }, rwName, rwPhase, rwPct),
    el('div', { class: 'rw-bar' }, rwBarFill),
    el('div', { class: 'rw-stats small' }, el('span', {}, rwLeftK, ' ', rwLeft), rwDir, rwOff),
    rwNext,
    el('div', { class: 'row wrap', style: { gap: '8px', marginTop: '8px' } }, rwFollow, rwMute, rwSim, rwExit)
  );
  function targetLabel(type) {
    return t(type === 'start' ? 'wp.types.start' : 'wp.types.end');
  }
  function updateRewalk(f) {
    const phase = f.phase || 'follow';
    const done = phase === 'finished' || f.finished;
    rwPhase.textContent = t(done ? 'rewalk.phaseDone'
      : phase === 'locating' ? 'rewalk.phaseLocating'
        : phase === 'approach' ? 'rewalk.phaseApproach'
          : 'rewalk.phaseFollow');
    rwPhase.className = `rw-phase ${done ? 'done' : phase}`;
    const pct = done ? 100 : Math.round((f.progress || 0) * 100);
    rwBarFill.style.width = `${pct}%`;
    rwPct.textContent = `${pct}%`;
    if (phase === 'locating' && !done) {
      rwLeftK.textContent = t('rewalk.remaining');
      rwLeft.textContent = '--';
      rwOff.textContent = t('rewalk.waitingGps');
      rwOff.classList.remove('bad');
      rwDir.style.display = 'none';
      rwNext.textContent = '';
      return;
    }
    if (phase === 'approach' && !done) {
      const d = fmtDistance(f.navDist ?? f.remaining ?? 0, get('units'));
      const target = targetLabel(f.navTargetType || f.targetType);
      rwLeftK.textContent = t('rewalk.navDist');
      rwLeft.textContent = `${d.v}${d.u}`;
      rwOff.textContent = `${t('rewalk.navTo')} ${target}`;
      rwOff.classList.remove('bad');
      rwDir.style.display = '';
      const rel = (f.navBearing ?? 0) - (f.heading ?? 0);
      rwDir.style.transform = `rotate(${rel - 90}deg)`;
      rwNext.textContent = `${t('rewalk.target')} ${target}`;
      return;
    }
    rwDir.style.display = 'none';
    rwLeftK.textContent = t('rewalk.remaining');
    const d = fmtDistance(f.remaining, get('units'));
    rwLeft.textContent = `${d.v}${d.u}`;
    const off = (f.offTrack || 0) > 60;
    rwOff.textContent = done ? t('rewalk.phaseDone')
      : off ? t('rewalk.offTrack', { m: Math.round(f.offTrack) }) : t('rewalk.onTrack');
    rwOff.classList.toggle('bad', off && !done);
    rwNext.textContent = f.finished ? t('rewalk.finished')
      : f.nextWp ? `${t('rewalk.nextWp')} ${WP_ICONS[f.nextWp.type] || '📍'} ${f.nextWp.name || t(`wp.types.${f.nextWp.type}`)} · ${Math.round(f.nextWp.dist)} m`
        : t('rewalk.noWp');
  }
  function renderRewalk() {
    const on = rewalk.active;
    rewalkBox.style.display = on ? '' : 'none';
    panel.style.display = on ? 'none' : '';
    actRow.style.display = on ? 'none' : '';
    btnRow.style.display = on ? 'none' : '';
    if (!on) return;
    rwName.textContent = `${t('rewalk.title')} · ${rewalk.name}`;
    rwMute.textContent = rewalk.muted ? t('rewalk.unmute') : t('rewalk.mute');
    rwSim.textContent = rewalk.sim ? t('rewalk.simStop') : t('rewalk.simWalk');
    const along = rewalk.cum[rewalk.maxIdx] || 0;
    const span = Math.max(1e-6, rewalk.total - rewalk.entryAlong);
    const navTarget = rewalk.navTarget;
    let navDist = null;
    let navBearing = null;
    if (rewalk.phase === 'approach' && navTarget && rewalk.lastFix) {
      navDist = haversine(rewalk.lastFix.lat, rewalk.lastFix.lon, navTarget.lat, navTarget.lon);
      navBearing = bearing(rewalk.lastFix.lat, rewalk.lastFix.lon, navTarget.lat, navTarget.lon);
    }
    updateRewalk({
      progress: Math.max(0, Math.min(1, (along - rewalk.entryAlong) / span)),
      remaining: Math.max(0, rewalk.total - along),
      offTrack: rewalk.offTrack, nextWp: null, finished: rewalk.finished,
      phase: rewalk.phase, mode: rewalk.mode, targetType: rewalk.targetType,
      navTargetType: rewalk.navTargetType,
      navDist, navBearing, heading: null
    });
  }
  on('rewalk:started', ({ segments, waypoints }) => {
    viewingTrip = null;
    renderViewBar();
    if (map && !psActive) {
      map.clearNavGuide();
      map.setTrackData(segments, waypoints);
      setTimeout(() => map.fitTrack(), 300);
    }
    renderRewalk();
    toast(t('rewalk.hint'), 'info', 5000);
  });
  on('rewalk:fix', (f) => {
    if (map && !psActive) {
      map.updatePosition(f.lat, f.lon, f.acc, f.heading);
      if (f.phase === 'approach' && f.targetLat != null) {
        map.setNavGuide(f.lat, f.lon, f.targetLat, f.targetLon, targetLabel(f.navTargetType || f.targetType));
      } else {
        map.clearNavGuide();
      }
      if (rwFollowOn) map.setFollow(true);
    }
    updateRewalk(f);
  });
  on('rewalk:finished', () => {
    if (map && !psActive) map.clearNavGuide();
    toast(t('rewalk.finished'), 'ok', 4000);
    renderRewalk();
  });
  on('rewalk:stopped', () => {
    renderRewalk();
    if (map && !psActive) { map.clearNavGuide(); map.setTrackData([], []); map.clearPosition(); }
    renderButtons(); renderBanners();
  });
  on('rewalk:mute', () => renderRewalk());
  on('rewalk:sim', () => renderRewalk());
  on('rewalk:geoerror', ({ code }) => toast(geoErrorMsg(code), 'warn', 4500));

  controls.append(rewalkBox, viewBar, bannerBox, panel, actRow, btnRow);

  function renderViewBar() {
    viewBar.innerHTML = '';
    if (!viewingTrip || rec.status === 'recording' || rec.status === 'paused') { viewBar.style.display = 'none'; return; }
    viewBar.style.display = '';
    viewBar.append(
      el('span', { class: 'vt-name' }, icon('fit', 14), `${t('record.viewing')} ${viewingTrip.trip.name || t('record.newTripName')}`),
      el('button', { class: 'btn sm', onclick: exitView }, icon('x', 14), t('record.exitView'))
    );
  }
  function exitView() {
    viewingTrip = null;
    appState.showTripInRecord = false;
    map?.setTrackData([], []);
    map?.clearHover();
    renderViewBar();
    toast(t('record.exitViewOk'), 'ok', 2000);
  }

  function runRecAction(p) {
    p.catch((e) => {
      console.error(e);
      renderButtons();
      renderBanners();
    });
  }

  // ---------- embedded camera: quick photo waypoints ----------
  const CAMERA_FIX_MAX_AGE_MS = 15_000;
  let cameraFixRequest = null;
  let cameraFixMissUntil = 0;

  function liveCameraFix() {
    const L = rec.live;
    if (!L || L.lat == null || L.lon == null || Date.now() - rec.lastFixWall > CAMERA_FIX_MAX_AGE_MS) return null;
    return { lat: L.lat, lon: L.lon, alt: L.alt ?? null, acc: L.acc ?? null };
  }

  function locateCameraFix() {
    if (!navigator.geolocation) return Promise.resolve(null);
    if (Date.now() < cameraFixMissUntil) return Promise.resolve(null);
    if (cameraFixRequest) return cameraFixRequest;
    cameraFixRequest = new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition((pos) => {
        const c = pos.coords;
        const fresh = Date.now() - (pos.timestamp || Date.now()) <= 20_000;
        const valid = fresh && Number.isFinite(c.latitude) && Number.isFinite(c.longitude)
          && Math.abs(c.latitude) <= 90 && Math.abs(c.longitude) <= 180
          && (!Number.isFinite(c.accuracy) || c.accuracy <= 200);
        resolve(valid ? { lat: c.latitude, lon: c.longitude, alt: c.altitude ?? null, acc: c.accuracy ?? null } : null);
      }, () => resolve(null), { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 });
    }).then((fix) => {
      cameraFixRequest = null;
      if (!fix) cameraFixMissUntil = Date.now() + 5_000;
      return fix;
    });
    return cameraFixRequest;
  }

  function cameraFix() {
    if (rec.simulated) return Promise.resolve(liveCameraFix());
    if (rec.status === 'paused') return locateCameraFix();
    const live = liveCameraFix();
    return live ? Promise.resolve(live) : locateCameraFix();
  }

  function openQuickCamera() {
    if (!rec.tripId || (rec.status !== 'recording' && rec.status !== 'paused')) {
      toast(t('camera.noFix'), 'warn');
      return;
    }
    armKeepAlive();
    openCamera({ mode: 'quick', getFix: cameraFix, onQuickSave: saveCapturedPhoto });
  }

  async function saveCapturedPhoto(shot) {
    const tripId = rec.tripId;
    if (!tripId || !shot.fix) return { ok: false };
    try {
      const saved = await addPhotoWaypoint({
        tripId,
        photo: shot,
        fix: shot.fix,
        takenAt: shot.takenAt,
        nameFor: (n) => t('record.photoNodeName', { n })
      });
      await refreshRecordingWaypoints();
      const thumbUrl = URL.createObjectURL(shot.thumb);
      return {
        ok: true,
        label: t('record.photoSaved', { n: saved.number }),
        thumbUrl,
        undo: async () => {
          await deletePhotoWaypoint(saved.waypoint.id, tripId, saved.media.id);
          await refreshRecordingWaypoints();
        }
      };
    } catch (e) {
      console.error(e);
      return { ok: false };
    }
  }

  function openOledCamera() {
    if (psCamAct.hidden || !rec.tripId || (rec.status !== 'recording' && rec.status !== 'paused')) return;
    armKeepAlive();
    openCamera({
      mode: 'oled',
      idleCloseMs: 20_000,
      getFix: cameraFix,
      onQuickSave: saveCapturedPhoto
    });
  }

  function renderButtons() {
    btnRow.innerHTML = '';
    actRow.innerHTML = '';
    renderStatus();
    if (rec.status === 'idle' || rec.status === 'finished') {
      renderAutoTag();
      activitySel.className = 'rec-pill select';
      btnRow.append(
        activitySel,
        el('button', { class: 'rec-pill start', onclick: onStart }, icon('play', 17), t('record.start')),
        el('button', { class: 'rec-pill ghost', onclick: onManual }, icon('plus', 15), t('record.manualShort'))
      );
    } else if (rec.status === 'recording') {
      renderAutoTag();
      liveActSel.value = liveActivity;
      actRow.append(liveActWrap, autoTag);
      btnRow.append(
        el('button', { class: 'rec-btn node', onclick: openRecWaypoint }, icon('pin', 20), t('record.node')),
        el('button', { class: 'rec-btn pause', onclick: () => runRecAction(pauseRecording()) }, icon('pause', 22), t('record.pause')),
        el('button', { class: 'rec-btn stop', onclick: onStop }, icon('stop', 22), t('record.stop')),
        el('button', { class: 'rec-btn camera', onclick: openQuickCamera, title: t('camera.titleQuick') }, icon('camera', 22), t('record.photo'))
      );
    } else if (rec.status === 'paused') {
      renderAutoTag();
      liveActSel.value = liveActivity;
      actRow.append(liveActWrap, autoTag);
      btnRow.append(
        el('button', { class: 'rec-btn node', onclick: openRecWaypoint }, icon('pin', 20), t('record.node')),
        el('button', { class: 'rec-btn resume', onclick: () => { armKeepAlive(); runRecAction(resumeRecording()); } }, icon('play', 22), t('record.resume')),
        el('button', { class: 'rec-btn stop', onclick: onStop }, icon('stop', 22), t('record.stop')),
        el('button', { class: 'rec-btn camera', onclick: openQuickCamera, title: t('camera.titleQuick') }, icon('camera', 22), t('record.photo'))
      );
    }
    renderPsTop();
    updatePsCamera();
  }

  // One-shot fix when the view opens idle: triggers the permission prompt on first
  // visit (iOS) and centers the map on the current position.
  let locateSeq = 0;
  function locateOnce(opts: any = {}) {
    if (!navigator.geolocation) return;
    const seq = ++locateSeq;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (seq !== locateSeq) return;
        rec.permissionDenied = false;
        rec.geoError = null;
        const c = pos.coords;
        map.updatePosition(c.latitude, c.longitude, c.accuracy, c.heading);
        map.flyTo(c.latitude, c.longitude, Math.max(map.map.getZoom(), 15));
        if (opts.follow) { map.setFollow(true); followBtn.classList.add('active'); }
        renderBanners();
      },
      (err) => {
        if (seq !== locateSeq) return;
        if (err.code === 1) { rec.permissionDenied = true; renderBanners(); }
      },
      { enableHighAccuracy: true, maximumAge: 20000, timeout: 15000 }
    );
  }

  async function onStart() {
    // Keep iOS media playback armed while the tap gesture is still valid.
    armKeepAlive();
    if (navigator.permissions?.query) {
      try {
        const st = await navigator.permissions.query({ name: 'geolocation' });
        if (st.state === 'denied') {
          rec.permissionDenied = true;
          disarmKeepAlive();
          renderBanners();
          toast(t('record.permissionDenied'), 'warn', 5000);
          return;
        }
      } catch { /* query unsupported — watchPosition error path still covers it */ }
    }
    const ok = await startRecording({ activity: activitySel.value }).catch((e) => {
      console.error(e);
      toast(t('record.startFailed'), 'err', 4800);
      return false;
    });
    if (!ok) disarmKeepAlive();
  }
  async function onManual() {
    const trip = await createManualTrip();
    await setActiveTrip(trip.id);
    map.fitTrack();
    toast(t('record.permissionDenied'), 'info', 4000);
    renderButtons();
  }
  function suggestedTripName(full) {
    const tr = full?.trip;
    const activity = tr?.activity && tr.activity !== 'auto'
      ? t(`record.activities.${tr.activity}`)
      : t('record.newTripName');
    const locale = currentLang().startsWith('zh') ? 'zh-CN' : 'en-US';
    const when = new Date(tr?.createdAt || Date.now()).toLocaleString(locale, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    return `${activity} · ${when}`;
  }
  async function onStop() {
    const ok = await confirmModal({ title: t('record.stop'), message: t('record.stopConfirm'), confirmText: t('record.stop') });
    if (!ok) return;
    const id = await stopRecording();
    if (!id) {
      toast(t('record.stopSaveFailed'), 'err', 5200);
      renderButtons();
      renderBanners();
      return;
    }
    map.endLive();
    map.setTrackData([], []);
    const full = await loadTripFull(id);
    const defaultName = suggestedTripName(full);
    await updateTrip(id, { name: defaultName });
    await setActiveTrip(id);
    renderButtons();
    toast(t('record.stopped'), 'ok');
    const name = await promptModal({
      title: t('record.nameTrip'),
      label: t('record.tripName'),
      value: defaultName,
      hint: t('record.nameTripHint')
    });
    if (name && name !== defaultName) {
      await updateTrip(id, { name });
      await setActiveTrip(id);
      toast(t('record.tripNamed'), 'ok');
    }
  }

  // ---------- waypoints mid-recording ----------
  function recEditOpts() {
    return (rec.status === 'recording' || rec.status === 'paused') && rec.tripId
      ? { tripId: rec.tripId, onSaved: refreshRecordingWaypoints }
      : {};
  }
  async function refreshRecordingWaypoints() {
    if (!rec.tripId) return;
    try {
      const waypoints = await listWaypoints(rec.tripId);
      if (map && !psActive) map.setWaypoints(waypoints);
    } catch (e) {
      console.warn('waypoint refresh failed', e);
    }
  }
  function openRecWaypoint() {
    const L = rec.live;
    if (!L || L.lat == null || L.lon == null) { toast(t('record.nodeNoFix'), 'warn'); return; }
    openWaypointModal({ lat: L.lat, lon: L.lon }, recEditOpts());
  }

  // ---------- banners ----------
  function geoBanner(msg, onRetry, label = t('record.geoRetry')) {
    return el('div', { class: 'debug-banner', style: { display: 'flex', gap: '8px', alignItems: 'center' } },
      el('span', { class: 'grow' }, '⚠ ' + msg),
      el('button', { class: 'btn sm', onclick: onRetry }, label));
  }
  async function retrySave() {
    const ok = await flushBuffer();
    if (ok) toast(t('record.saveOk'), 'ok', 2200);
  }
  function geoErrorMsg(code) {
    return code === 'unavailable' ? t('record.geoUnavailable')
      : code === 'timeout' ? t('record.geoTimeout')
        : code === 'denied' ? t('record.permissionDenied')
          : t('record.geoSilent');
  }
  function renderBanners() {
    bannerBox.innerHTML = '';
    if (readOnly) {
      bannerBox.append(el('div', { class: 'debug-banner' }, t('record.tabLocked')));
    }
    if (rec.saveState.error) {
      bannerBox.append(geoBanner(
        t('record.saveFailed', { n: rec.saveState.pending }),
        rec.saveState.error === 'finalize' ? () => { void onStop(); } : () => { void retrySave(); },
        rec.saveState.error === 'finalize' ? t('record.stopRetry') : t('record.saveRetry')
      ));
    }
    if (rec.permissionDenied && rec.status !== 'recording') {
      bannerBox.append(geoBanner(t('record.permissionDenied'), rec.status === 'paused' ? () => resumeRecording() : onStart));
    } else if (rec.geoError && (rec.status === 'recording' || rec.status === 'idle')) {
      bannerBox.append(geoBanner(geoErrorMsg(rec.geoError), rec.status === 'idle' ? onStart : retryGeolocation));
    } else if (rec.geoError && rec.status === 'paused' && !rec.permissionDenied) {
      bannerBox.append(geoBanner(geoErrorMsg(rec.geoError), () => resumeRecording()));
    }
    if (recoverable && rec.status === 'idle') {
      bannerBox.append(el('div', { class: 'card', style: { pointerEvents: 'auto', display: 'flex', gap: '8px', alignItems: 'center', padding: '10px 12px' } },
        el('span', { class: 'grow small' }, `⏸ ${recoverable.name || t('record.newTripName')}`),
        el('button', { class: 'btn sm primary', onclick: async () => {
          const ok = await continueTrip(recoverable.id);
          if (ok) { recoverable = null; map.startLive(); map.setFollow(true); renderBanners(); renderButtons(); }
        } }, t('trips.continueRec')),
        el('button', { class: 'btn sm', onclick: async () => {
          await updateTrip(recoverable.id, { status: 'finished' });
          await setActiveTrip(recoverable.id);
          recoverable = null;
          renderBanners();
        } }, t('record.stop'))
      ));
    }
  }

  // ---------- power-save lock: dim dashboard + hold-to-unlock ----------
  const ps = el('div', { id: 'oled-dash', 'aria-hidden': 'true' });
  function enterOledTheme() {
    if (oledThemeActive) return;
    oledThemeActive = true;
    setThemeModeOverride('dark');
    setThemeColorOverride('#000000');
  }
  function leaveOledTheme() {
    if (!oledThemeActive) return;
    oledThemeActive = false;
    setThemeColorOverride(null);
    setThemeModeOverride(null);
  }
  const psTop = el('div', { class: 'od-top' });
  const odGrid = el('div', { class: 'od-grid' });
  const psBottom = el('div', { class: 'od-bottom' });
  function odCell(key, hero = false) {
    const v = el('div', { class: 'v' }, '--');
    const c = el('div', { class: 'od-cell' + (hero ? ' hero' : '') }, v, el('div', { class: 'k' }, t(key)));
    odGrid.append(c);
    return v;
  }
  const odDist = odCell('panel.distance', true);
  const odDur = odCell('panel.duration');
  const odSig = odCell('panel.signal');
  const odSpeed = odCell('panel.speed');
  const odAlt = odCell('panel.altitude');
  const odAsc = odCell('panel.ascent');
  const odDesc = odCell('panel.descent');
  psBottom.innerHTML = `
    <div class="ps-actions">
      <div class="ps-act">
        <div class="ps-ring ps-unlock" role="button" aria-label="${t('record.lockHint')}">
          <svg width="104" height="104" viewBox="0 0 104 104">
            <circle class="bgc" cx="52" cy="52" r="46" fill="none" stroke-width="6"/>
            <circle class="fgc" cx="52" cy="52" r="46" fill="none" stroke-width="6" stroke-linecap="round"/>
          </svg>
          <div class="ps-lock"><svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="currentColor" stroke-width="2" fill="none"/></svg></div>
        </div>
        <div class="ps-hint">${t('record.lockHint')}</div>
      </div>
    </div>
    <div class="ps-sub">${t('record.lockSub')}</div>`;
  const psCamAct = el('div', { class: 'ps-act ps-cam-act', hidden: true });
  psCamAct.innerHTML = `
    <div class="ps-cam-track" role="button" aria-label="${t('record.camSwipe')}" title="${t('record.camSwipeHint')}">
      <span class="ps-cam-arrow">‹</span>
      <span class="ps-cam-knob">
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4V8Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/><circle cx="12" cy="13" r="3.4" stroke="currentColor" stroke-width="2" fill="none"/></svg>
      </span>
    </div>
    <div class="ps-hint">${t('record.camSwipe')}</div>`;
  psBottom.querySelector('.ps-actions').append(psCamAct);
  ps.append(psTop, odGrid, psBottom);
  document.body.append(ps);

  function renderPsTop() {
    psTop.innerHTML = '';
    psTop.append(
      el('span', { class: `rec-dot ${rec.status}` }),
      el('span', {}, t(`record.${rec.status === 'recording' ? 'statusRecording' : rec.status === 'paused' ? 'statusPaused' : 'statusIdle'}`)),
      el('span', { class: 'grow' }),
      el('span', { class: 'ps-mode' }, icon('powerlock', 15), t('record.powerLock'))
    );
  }

  const unlockRing = psBottom.querySelector('.ps-unlock') as HTMLElement;
  const unlockFg = psBottom.querySelector('.ps-unlock .fgc') as SVGCircleElement;
  const psSub = psBottom.querySelector('.ps-sub') as HTMLElement;
  function updatePsSub() {
    psSub.textContent = isKeepAliveActive()
      ? `${t('record.lockSub')} · ${t('record.keepAliveOn')}`
      : t('record.lockSub');
  }
  const RING_C = 2 * Math.PI * 46;
  function bindHold(ringEl, fgEl, duration, onDone) {
    let start = 0;
    let raf = 0;
    function reset() {
      start = 0;
      ringEl.classList.remove('holding');
      cancelAnimationFrame(raf);
      raf = 0;
      fgEl.style.strokeDashoffset = String(RING_C);
    }
    function loop(ts) {
      if (!start) return;
      const p = Math.min(1, (ts - start) / duration);
      fgEl.style.strokeDashoffset = String(RING_C * (1 - p));
      if (p >= 1) { reset(); onDone(); return; }
      raf = requestAnimationFrame(loop);
    }
    ringEl.addEventListener('pointerdown', (e) => {
      if (!psActive) return;
      e.preventDefault();
      e.stopPropagation();
      reset();
      try { ringEl.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      ringEl.classList.add('holding');
      start = performance.now();
      raf = requestAnimationFrame(loop);
    });
    ringEl.addEventListener('pointerup', reset);
    ringEl.addEventListener('pointercancel', reset);
    ringEl.addEventListener('pointerleave', reset);
  }
  bindHold(unlockRing, unlockFg, 1500, () => setPowerLock(false));
  ps.addEventListener('contextmenu', (e) => e.preventDefault());

  function updatePsCamera() {
    psCamAct.hidden = !(rec.status === 'recording' || rec.status === 'paused');
  }

  const psCamTrack = psCamAct.querySelector('.ps-cam-track') as HTMLElement;
  let camGesture: { startX: number; startY: number; ready: boolean; invalid: boolean; target: number; current: number; raf: number } | null = null;
  const setCamProgress = (value: number) => {
    psCamTrack.style.setProperty('--cam-progress', String(Math.max(0, Math.min(1, value))));
  };
  function animateCam() {
    if (!camGesture) return;
    const delta = camGesture.target - camGesture.current;
    camGesture.current += delta * (Math.abs(delta) < 0.02 ? 0.55 : 0.34);
    if (Math.abs(camGesture.target - camGesture.current) < 0.004) camGesture.current = camGesture.target;
    setCamProgress(camGesture.current);
    camGesture.raf = camGesture.current !== camGesture.target ? requestAnimationFrame(animateCam) : 0;
  }
  const resetCamGesture = () => {
    if (!camGesture) return;
    cancelAnimationFrame(camGesture.raf);
    camGesture = null;
    psCamTrack.classList.remove('dragging', 'ready');
    setCamProgress(0);
  };
  psCamTrack.addEventListener('pointerdown', (e) => {
    if (!psActive || psCamAct.hidden) return;
    e.preventDefault();
    e.stopPropagation();
    try { psCamTrack.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    resetCamGesture();
    psCamTrack.classList.add('dragging');
    camGesture = { startX: e.clientX, startY: e.clientY, ready: false, invalid: false, target: 0, current: 0, raf: 0 };
    setCamProgress(0);
  });
  psCamTrack.addEventListener('pointermove', (e) => {
    if (!camGesture) return;
    e.preventDefault();
    const dx = e.clientX - camGesture.startX;
    const dy = e.clientY - camGesture.startY;
    if (Math.abs(dy) > Math.abs(dx) + 18) camGesture.invalid = true;
    camGesture.ready = dx <= -120 && Math.abs(dy) <= 90 && !camGesture.invalid;
    camGesture.target = Math.max(0, Math.min(1, -dx / 120));
    psCamTrack.classList.toggle('ready', camGesture.ready);
    if (!camGesture.raf) camGesture.raf = requestAnimationFrame(animateCam);
  });
  const endCamGesture = (e) => {
    if (!camGesture) return;
    const fire = e.type === 'pointerup' && camGesture.ready;
    resetCamGesture();
    if (fire) openOledCamera();
  };
  psCamTrack.addEventListener('pointerup', endCamGesture);
  psCamTrack.addEventListener('pointercancel', resetCamGesture);
  psCamTrack.addEventListener('lostpointercapture', resetCamGesture);

  function renderOled(L) {
    if (!L || !psActive) return;
    const units = get('units');
    const d = fmtDistance(L.distance, units);
    odDist.innerHTML = `${d.v}<small> ${d.u}</small>`;
    odDur.textContent = fmtDuration(L.duration);
    if (speedMode() === 'pace') {
      const p = fmtPace(L.speed, units);
      odSpeed.innerHTML = `${p.v}<small>${p.u}</small>`;
    } else {
      const s = fmtSpeed(L.speed, units);
      odSpeed.innerHTML = `${s.v}<small>${s.u}</small>`;
    }
    const a = fmtAltitude(L.alt, units);
    odAlt.innerHTML = `${a.v}<small>${a.u}</small>`;
    odAsc.innerHTML = `${Math.round(L.ascent)}<small>m</small>`;
    odDesc.innerHTML = `${Math.round(L.descent)}<small>m</small>`;
    renderSignal(odSig, L.acc);
  }

  async function setPowerLock(on) {
    if (on === psActive) return;
    psActive = on;
    if (on) {
      // Dark palette is applied before the black overlay so the transition reads
      // as a theme switch, not an abrupt flash; the CSS fade reveals it underneath.
      enterOledTheme();
      // truly stop WebGL rendering while in power saver
      const center = map.map.getCenter();
      const zoom = map.map.getZoom();
      const basemap = map.basemapId;
      map.destroy();
      map = null;
      mapContainer.style.display = 'none';
      ps._restore = { center, zoom, basemap };
      document.documentElement.classList.add('oled-lock');
      ps.setAttribute('aria-hidden', 'false');
      ps.classList.add('active');
      requestWakeLock();
      renderPsTop();
      updatePsCamera();
      renderOled(rec.live);
      updatePsSub();
      setTimeout(() => { if (psActive) updatePsSub(); }, 1200);
    } else {
      // A finger still on the glass can synthesize a click on whatever sits under
      // the ring after the overlay disappears; swallow that lift click, however
      // long the user keeps holding.
      armUnlockGuard();
      // Restore the saved theme first, then fade the overlay to reveal it.
      leaveOledTheme();
      document.documentElement.classList.remove('oled-lock');
      ps.setAttribute('aria-hidden', 'true');
      ps.classList.remove('active');
      if (rec.status !== 'recording') releaseWakeLock();
      mapContainer.style.display = '';
      buildMap();
      const r = ps._restore;
      if (r) {
        map.map.once('load', () => {
          if (r.basemap && map.basemapId !== r.basemap) map.setBasemap(r.basemap);
          map.map.jumpTo({ center: r.center, zoom: r.zoom });
          restoreTrackAfterRebuild();
        });
      }
      renderMapLayer();
    }
  }

  async function restoreTrackAfterRebuild() {
    if (rewalk.active) {
      const full = await loadTripFull(rewalk.tripId);
      if (full) map.setTrackData(full.segments, full.waypoints);
    } else if (rec.status === 'recording' || rec.status === 'paused') {
      const full = await loadTripFull(rec.tripId);
      if (full) {
        map.setTrackData(full.segments, full.waypoints);
        map.liveMode = true;
        map._liveFeats = new Map();
        const last = full.segments[full.segments.length - 1]?.points.slice(-1)[0];
        if (last) map.updatePosition(last.lat, last.lon, last.acc, null);
      }
    } else if (viewingTrip) {
      map.setTrackData(viewingTrip.segments, viewingTrip.waypoints);
    }
  }

  // ---------- recorder events ----------
  on('recorder:started', async ({ simulated }) => {
    liveActivity = (await getTrip(rec.tripId))?.activity || get('activity');
    viewingTrip = null;
    renderViewBar();
    map?.startLive();
    map?.setFollow(true);
    followBtn.classList.add('active');
    renderButtons();
    renderBanners();
    renderPanel(rec.live);
    if (!simulated) toast(t('record.bgHint'), 'info', 6000);
  });
  on('recorder:paused', () => { renderButtons(); renderBanners(); });
  on('recorder:resumed', async () => {
    liveActivity = (await getTrip(rec.tripId))?.activity || get('activity');
    renderButtons(); renderBanners(); renderPanel(rec.live);
  });
  on('recorder:stopped', () => { renderButtons(); renderBanners(); });
  on('recorder:busy', () => { readOnly = true; renderBanners(); toast(t('record.tabLocked'), 'warn', 4000); });
  const offBroadcast = onBroadcast((msg) => {
    if (msg.type === 'rec-state') {
      const other = msg.state === 'recording' || msg.state === 'paused';
      if (other !== readOnly) { readOnly = other; renderBanners(); }
    } else if (msg.type === 'rec-released' && readOnly) {
      readOnly = false;
      renderBanners();
    }
  });
  on('recorder:denied', () => { renderBanners(); renderButtons(); toast(t('record.permissionDenied'), 'warn', 5000); });
  on('recorder:geoerror', ({ code }) => {
    renderBanners();
    renderStatus();
    if (code && code !== 'denied') toast(geoErrorMsg(code), 'warn', 4500);
  });
  on('recorder:background', ({ gapMs }) => {
    toast(t('record.bgReturn', { s: Math.round(gapMs / 1000) }), 'warn', 6000);
  });
  on('recorder:point', ({ point, live }) => {
    if (map && !psActive) map.appendLive(point, rec.segmentId);
    renderPanel(live);
    renderOled(live);
    if (live.pointCount === 1 && !rec.simulated) { renderStatus(); toast(t('record.firstFix'), 'ok', 2500); }
  });
  on('recorder:tick', ({ live }) => { renderPanel(live); renderOled(live); });
  on('recorder:saved', () => { renderSaveChip(); renderBanners(); });
  on('recorder:persistence', () => { renderSaveChip(); });
  on('recorder:saveerror', () => { renderSaveChip(); renderBanners(); });
  on('recorder:starterror', () => { renderButtons(); renderBanners(); });
  on('recorder:filtered', ({ count }) => {
    if (count === 1 || count % 10 === 0) toast(t('record.invalidPoint', { n: count }), 'warn', 2000);
  });

  // ---------- active trip display ----------
  on('trip:active', (full) => {
    if (!map || psActive) return;
    if (rec.status === 'recording' || rec.status === 'paused') return;
    if (!full) { viewingTrip = null; renderViewBar(); map.setTrackData([], []); return; }
    // only explicit "open on map" from the trips list paints a finished trip here
    if (!appState.showTripInRecord) return;
    appState.showTripInRecord = false;
    viewingTrip = full;
    map.setTrackData(full.segments, full.waypoints);
    renderViewBar();
  });
  on('activity:guess', ({ activity }) => {
    renderAutoTag();
    toast(t('record.autoDetected', { a: t(`record.activities.${activity}`) }), 'info', 2500);
  });
  on('settings:changed', ({ key, keys }) => {
    if (key === 'activity' || keys?.includes('activity')) {
      activitySel.value = get('activity');
      renderAutoTag();
    }
  });

  // keyboard shortcuts
  function onKeydown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && appState.editMode) { e.preventDefault(); e.shiftKey ? redoEdit() : undoEdit(); }
    if (e.key === ' ' && appState.view === 'record') {
      e.preventDefault();
      if (rec.status === 'recording') runRecAction(pauseRecording());
      else if (rec.status === 'paused') runRecAction(resumeRecording());
    }
  }
  document.addEventListener('keydown', onKeydown);

  // ---------- init ----------
  (async () => {
    // proactive permission state: banner before the user even taps start
    if (navigator.permissions?.query) {
      try {
        const st = await navigator.permissions.query({ name: 'geolocation' });
        rec.permissionDenied = st.state === 'denied';
        st.onchange = () => {
          rec.permissionDenied = st.state === 'denied';
          if (!rec.permissionDenied && rec.geoError === 'denied') rec.geoError = null;
          renderBanners();
        };
      } catch { /* query unsupported */ }
    }
    // rebuilt while a recording is active (e.g. language switch): reattach to live trip
    if (rec.tripId && (rec.status === 'recording' || rec.status === 'paused')) {
      liveActivity = (await getTrip(rec.tripId))?.activity || get('activity');
      const full = await loadTripFull(rec.tripId);
      if (full) {
        map.setTrackData(full.segments, full.waypoints);
        map.liveMode = true;
        map._liveFeats = new Map();
        const last = full.segments[full.segments.length - 1]?.points.slice(-1)[0];
        if (last) { map.updatePosition(last.lat, last.lon, last.acc, null); map.fitTrack(); }
      }
      renderButtons();
      renderBanners();
      renderPanel(rec.live);
      return;
    }
    recoverable = await findRecoverableTrip();
    renderBanners();
    renderButtons();
    renderRewalk();
    if (rewalk.active) {
      const full = await loadTripFull(rewalk.tripId);
      if (full) { map.setTrackData(full.segments, full.waypoints); setTimeout(() => map.fitTrack(), 600); }
      return;
    }
    if (appState.showTripInRecord && appState.activeTripFull) {
      appState.showTripInRecord = false;
      const full = appState.activeTripFull;
      viewingTrip = full;
      map.setTrackData(full.segments, full.waypoints);
      renderViewBar();
      setTimeout(() => map.fitTrack(), 600);
    } else if (recoverable) {
      const full = await loadTripFull(recoverable.id);
      if (full) setTimeout(() => { viewingTrip = full; map.setTrackData(full.segments, full.waypoints); map.fitTrack(); renderViewBar(); }, 600);
    } else if (rec.status === 'idle' || rec.status === 'finished') {
      locateOnce();
    }
  })();

  // iOS PWAs often resume from suspension instead of reloading — locate on return,
  // but never yank the map away from a trip/re-walk the user is looking at.
  function onVisibility() {
    if (document.visibilityState !== 'visible') return;
    if (viewingTrip || recoverable || rewalk.active) return;
    if (map?.posMarker || !(rec.status === 'idle' || rec.status === 'finished')) return;
    locateOnce();
  }
  document.addEventListener('visibilitychange', onVisibility);

  return {
    view,
    getMap: () => map,
    resize: () => { map?.resize(); renderMapLayer(); },
    refresh: () => { renderButtons(); renderBanners(); renderViewBar(); renderRewalk(); },
    destroy: () => {
      document.removeEventListener('keydown', onKeydown);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('click', swallowUnlockGhostClick, true);
      document.removeEventListener('pointerup', releaseUnlockGuard, true);
      document.removeEventListener('pointercancel', releaseUnlockGuard, true);
      clearTimeout(unlockReleaseTimer);
      offBroadcast();
      leaveOledTheme();
      document.documentElement.classList.remove('oled-lock');
      if (psActive) {
        if (rec.status !== 'recording') releaseWakeLock();
      }
      map?.destroy();
      map = null;
      ps.remove();
    }
  };
}