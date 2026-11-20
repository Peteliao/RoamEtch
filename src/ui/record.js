// Record view: map + live panel + controls + OLED power saver + touch lock.
import { t } from '../core/i18n.js';
import { get, set } from '../core/settings.js';
import { on, emit } from '../core/events.js';
import { rec, startRecording, pauseRecording, resumeRecording, stopRecording, continueTrip, findRecoverableTrip, createManualTrip, retryGeolocation } from '../core/recorder.js';
import { regionState } from '../core/region.js';
import { availableBasemaps } from '../core/providers.js';
import { fmtDistance, fmtDuration, fmtSpeed, fmtPace, fmtAltitude } from '../core/geo.js';
import { altSourceShortKey, altSourceTagClass } from '../core/elevation.js';
import { loadTripFull, updateTrip, getTrip } from '../core/store.js';
import { onBroadcast } from '../core/locks.js';
import { TrackMap, WP_ICONS } from './map.js';
import { rewalk, stopRewalk, toggleMute, startSim, stopSim } from '../core/rewalk.js';
import { appState, setActiveTrip } from './state.js';
import { openWaypointModal, moveWaypoint, moveVertex, insertVertex, deleteVertex, undoEdit, redoEdit } from './editor.js';
import { el, icon, toast } from './helpers.js';
import { confirmModal } from './helpers.js';

export function createRecordView() {
  const view = el('div', { class: 'view', id: 'view-record' });
  const mapContainer = el('div', { id: 'map-container' });
  const styleBar = el('div', { class: 'map-style-bar' });
  const tools = el('div', { class: 'map-tools' });
  const controls = el('div', { class: 'rec-controls' });
  view.append(mapContainer, styleBar, tools, controls);

  let map = null;
  let oledActive = false;
  let viewingTrip = null;
  let locked = false;
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
      onWaypointClick: (wp) => openWaypointModal(wp),
      onWaypointMove: (wp, lon, lat) => moveWaypoint(wp, lon, lat),
      onMapClick: (lon, lat) => { if (appState.editMode && appState.activeTripId) openWaypointModal({ lat, lon }); },
      onVertexMove: (segId, idx, lon, lat) => moveVertex(segId, idx, lon, lat),
      onVertexInsert: (segId, idx, lon, lat) => insertVertex(segId, idx, lon, lat),
      onVertexDelete: (segId, idx) => deleteVertex(segId, idx)
    }).init(center, zoom);
    return map;
  }
  buildMap();

  // ---------- style bar ----------
  function renderStyleBar() {
    styleBar.innerHTML = '';
    for (const b of availableBasemaps()) {
      const label = get('language') === 'en' || (get('language') === 'auto' && !navigator.language.startsWith('zh')) ? b.nameEn : b.name;
      const btn = el('button', {
        class: map?.basemapId === b.id ? 'active' : '',
        title: `${t('map.styleCs')}: ${b.coordSystem}`,
        onclick: () => { map.setBasemap(b.id); renderStyleBar(); }
      }, label, el('span', { class: 'cs' }, b.coordSystem === 'GCJ02' ? 'GCJ' : 'WGS'));
      styleBar.append(btn);
    }
  }
  renderStyleBar();
  on('region:changed', renderStyleBar);
  on('region:probed', renderStyleBar);
  on('settings:changed', ({ key }) => { if (['tiandituKey', 'customTileUrl', 'language'].includes(key)) renderStyleBar(); });
  on('map:basemap', renderStyleBar);

  // ---------- tools ----------
  const followBtn = el('button', { class: 'iconbtn', title: t('record.follow'), onclick: () => { map.setFollow(!map.follow); followBtn.classList.toggle('active', map.follow); } }, icon('follow'));
  const fitBtn = el('button', { class: 'iconbtn', title: t('record.fit'), onclick: () => map.fitTrack() }, icon('fit'));
  const editBtn = el('button', { class: 'iconbtn', title: t('record.editMode'), onclick: toggleEdit }, icon('edit'));
  const undoBtn = el('button', { class: 'iconbtn', title: t('edit.undo'), onclick: undoEdit, style: { display: 'none' } }, icon('undo'));
  const redoBtn = el('button', { class: 'iconbtn', title: t('edit.redo'), onclick: redoEdit, style: { display: 'none' } }, icon('redo'));
  const oledBtn = el('button', { class: 'iconbtn', title: t('record.oled'), onclick: () => setOled(true) }, icon('oled'));
  const lockBtn = el('button', { class: 'iconbtn', title: t('record.lock'), onclick: () => setLocked(true) }, icon('lock'));
  tools.append(followBtn, fitBtn, editBtn, undoBtn, redoBtn, oledBtn, lockBtn);
  on('map:followoff', () => followBtn.classList.remove('active'));
  on('history:changed', (s) => {
    undoBtn.style.display = appState.editMode ? '' : 'none';
    redoBtn.style.display = appState.editMode ? '' : 'none';
    undoBtn.disabled = !s.canUndo;
    redoBtn.disabled = !s.canRedo;
  });

  function toggleEdit() {
    if (rec.status === 'recording') { toast(t('record.statusRecording'), 'warn'); return; }
    if (!appState.activeTripId) { toast(t('analysis.noTrip'), 'warn'); return; }
    appState.editMode = !appState.editMode;
    map.setEditMode(appState.editMode);
    editBtn.classList.toggle('active', appState.editMode);
    undoBtn.style.display = appState.editMode ? '' : 'none';
    redoBtn.style.display = appState.editMode ? '' : 'none';
    if (appState.editMode) toast(t('record.editModeOn'), 'info', 3500);
  }

  // ---------- live panel ----------
  const panel = el('div', { class: 'live-panel' + (get('panelCollapsed') ? ' collapsed' : '') });
  const pStatus = el('span', { class: 'st idle' }, t('record.statusIdle'));
  const pAcc = el('span', { class: 'acc' }, '');
  const pHead = el('div', { class: 'lp-head', onclick: () => { panel.classList.toggle('collapsed'); set('panelCollapsed', panel.classList.contains('collapsed')); } },
    pStatus, el('span', { class: 'rec-dot', id: 'panel-rec-dot' }), pAcc, icon('chevron', 16));
  const grid = el('div', { class: 'live-grid' });
  function cell(key, hero = false) {
    const v = el('div', { class: 'v' }, '--');
    const k = el('div', { class: 'k' }, t(key));
    const c = el('div', { class: 'live-cell' + (hero ? ' hero' : '') }, v, k);
    grid.append(c);
    return { v, k, c };
  }
  const cDist = cell('panel.distance', true);
  const cDur = cell('panel.duration');
  const cSpeed = cell('panel.speed');
  const cAlt = cell('panel.altitude');
  const cAsc = cell('panel.ascent');
  const cDesc = cell('panel.descent');
  cSpeed.c.style.cursor = 'pointer';
  cSpeed.c.title = t('settings.speedDisplay');
  cSpeed.c.onclick = () => {
    const cur = speedMode();
    set('speedDisplay', cur === 'speed' ? 'pace' : 'speed');
    if (rec.live) renderPanel(rec.live);
  };
  const detail = el('div', { class: 'small muted', style: { padding: '6px 12px', display: 'flex', gap: '12px', flexWrap: 'wrap', fontFamily: 'var(--mono)', fontSize: '11px' } });
  panel.append(pHead, grid, detail);

  function currentActivity() {
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
    const a = fmtAltitude(L.alt, units);
    cAlt.v.innerHTML = `${a.v}<small>${a.u}</small> <span class="tag ${altSourceTagClass(L.altSrc)}">${t(altSourceShortKey(L.altSrc))}</span>`;
    cAsc.v.innerHTML = `${Math.round(L.ascent)}<small>m</small>`;
    cDesc.v.innerHTML = `${Math.round(L.descent)}<small>m</small>`;
    pAcc.textContent = L.acc != null ? `±${Math.round(L.acc)}m` : '';
    const slopeTxt = L.slope != null ? `${L.slope > 0 ? '+' : ''}${L.slope.toFixed(1)}%` : '--';
    detail.innerHTML = '';
    detail.append(...[
      el('span', {}, `${t('panel.slope')} ${slopeTxt}`),
      el('span', {}, `${t('panel.moving')} ${fmtDuration(L.movingMs, { compact: true })}`),
      el('span', {}, `${t('panel.still')} ${fmtDuration(L.stillMs, { compact: true })}`),
      el('span', {}, `${t('panel.points')} ${L.pointCount}`),
      el('span', {}, `${t('panel.segments')} ${L.segCount}`),
      L.lat != null ? el('span', {}, `${L.lat.toFixed(5)}, ${L.lon.toFixed(5)}`) : null
    ].filter(Boolean));
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
    emit('recstatus:changed', rec.status);
  }

  // ---------- buttons ----------
  const btnRow = el('div', { class: 'rec-buttons' });
  const activitySel = el('select', { class: 'btn sm', style: { maxWidth: '130px' } });
  for (const a of ['auto', 'hike', 'drive', 'bike', 'run', 'travel']) {
    activitySel.append(el('option', { value: a }, a === 'auto' ? t('record.activityAuto') : t(`record.activities.${a}`)));
  }
  activitySel.value = get('activity');
  activitySel.onchange = () => set('activity', activitySel.value);
  const autoTag = el('span', { class: 'small faint', style: { maxWidth: '110px' } });
  let liveActivity = 'auto';
  const liveActSel = el('select', { class: 'btn sm', style: { maxWidth: '110px' } });
  for (const a of ['auto', 'hike', 'drive', 'bike', 'run', 'travel']) {
    liveActSel.append(el('option', { value: a }, a === 'auto' ? t('record.activityAuto') : t(`record.activities.${a}`)));
  }
  liveActSel.onchange = async () => {
    liveActivity = liveActSel.value;
    if (rec.tripId) await updateTrip(rec.tripId, { activity: liveActivity });
    if (liveActivity !== 'auto') rec.activityGuess = null;
    renderAutoTag();
  };
  function renderAutoTag() {
    const mode = (rec.status === 'recording' || rec.status === 'paused') ? liveActivity : get('activity');
    if (mode !== 'auto') { autoTag.style.display = 'none'; return; }
    autoTag.style.display = '';
    autoTag.textContent = rec.activityGuess
      ? t('record.autoDetected', { a: t(`record.activities.${rec.activityGuess}`) })
      : t('record.autoDetecting');
  }
  renderAutoTag();

  const bannerBox = el('div', {});
  const viewBar = el('div', { class: 'view-trip-bar', style: { display: 'none' } });

  // ---------- re-walk navigation panel ----------
  let rwFollowOn = true;
  const rewalkBox = el('div', { class: 'rewalk-card', style: { display: 'none' } });
  const rwName = el('div', { class: 'rw-name' });
  const rwPct = el('span', { class: 'rw-pct mono' }, '0%');
  const rwBarFill = el('div', { class: 'rw-fill' });
  const rwLeft = el('span', { class: 'mono' }, '--');
  const rwOff = el('span', { class: 'rw-off' }, t('rewalk.onTrack'));
  const rwNext = el('div', { class: 'rw-next small' });
  const rwFollow = el('button', { class: 'btn sm active', onclick: () => { rwFollowOn = !rwFollowOn; rwFollow.classList.toggle('active', rwFollowOn); } }, icon('follow', 14), t('record.follow'));
  const rwMute = el('button', { class: 'btn sm', onclick: () => toggleMute() }, t('rewalk.mute'));
  const rwSim = el('button', { class: 'btn sm', onclick: () => (rewalk.sim ? stopSim() : startSim()) }, t('rewalk.simWalk'));
  const rwExit = el('button', { class: 'btn sm danger', onclick: () => { stopRewalk(); toast(t('rewalk.exited'), 'info', 2000); } }, icon('x', 14), t('rewalk.exit'));
  rewalkBox.append(
    el('div', { class: 'row', style: { alignItems: 'center', gap: '8px' } }, rwName, rwPct),
    el('div', { class: 'rw-bar' }, rwBarFill),
    el('div', { class: 'rw-stats small' }, el('span', {}, `${t('rewalk.remaining')} `, rwLeft), rwOff),
    rwNext,
    el('div', { class: 'row wrap', style: { gap: '8px', marginTop: '8px' } }, rwFollow, rwMute, rwSim, rwExit)
  );
  function updateRewalk(f) {
    const pct = Math.round((f.progress || 0) * 100);
    rwBarFill.style.width = `${pct}%`;
    rwPct.textContent = `${pct}%`;
    const d = fmtDistance(f.remaining, get('units'));
    rwLeft.textContent = `${d.v}${d.u}`;
    const off = f.offTrack > 60;
    rwOff.textContent = off ? t('rewalk.offTrack', { m: Math.round(f.offTrack) }) : t('rewalk.onTrack');
    rwOff.classList.toggle('bad', off);
    rwNext.textContent = f.finished ? t('rewalk.finished')
      : f.nextWp ? `${t('rewalk.nextWp')} ${WP_ICONS[f.nextWp.type] || '📍'} ${f.nextWp.name || t(`wp.types.${f.nextWp.type}`)} · ${Math.round(f.nextWp.dist)} m`
        : t('rewalk.noWp');
  }
  function renderRewalk() {
    const on = rewalk.active;
    rewalkBox.style.display = on ? '' : 'none';
    panel.style.display = on ? 'none' : '';
    btnRow.style.display = on ? 'none' : '';
    if (!on) return;
    rwName.textContent = `${t('rewalk.title')} · ${rewalk.name}`;
    rwMute.textContent = rewalk.muted ? t('rewalk.unmute') : t('rewalk.mute');
    rwSim.textContent = rewalk.sim ? t('rewalk.simStop') : t('rewalk.simWalk');
    updateRewalk({
      progress: rewalk.total ? rewalk.cum[rewalk.maxIdx] / rewalk.total : 0,
      remaining: Math.max(0, rewalk.total - rewalk.cum[rewalk.maxIdx]),
      offTrack: rewalk.offTrack, nextWp: null, finished: rewalk.finished
    });
  }
  on('rewalk:started', ({ segments, waypoints }) => {
    viewingTrip = null;
    renderViewBar();
    if (map && !oledActive) { map.setTrackData(segments, waypoints); setTimeout(() => map.fitTrack(), 300); }
    renderRewalk();
    toast(t('rewalk.hint'), 'info', 5000);
  });
  on('rewalk:fix', (f) => {
    if (map && !oledActive) {
      map.updatePosition(f.lat, f.lon, f.acc, f.heading);
      if (rwFollowOn) map.setFollow(true);
    }
    updateRewalk(f);
  });
  on('rewalk:finished', () => { toast(t('rewalk.finished'), 'ok', 4000); renderRewalk(); });
  on('rewalk:stopped', () => {
    renderRewalk();
    if (map && !oledActive) { map.setTrackData([], []); map.clearPosition(); }
    renderButtons(); renderBanners();
  });
  on('rewalk:mute', () => renderRewalk());
  on('rewalk:sim', () => renderRewalk());
  on('rewalk:geoerror', ({ code }) => toast(geoErrorMsg(code), 'warn', 4500));

  controls.append(rewalkBox, viewBar, bannerBox, panel, btnRow);

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

  function renderButtons() {
    btnRow.innerHTML = '';
    renderStatus();
    if (rec.status === 'idle' || rec.status === 'finished') {
      renderAutoTag();
      btnRow.append(
        activitySel, autoTag,
        el('button', { class: 'rec-btn start', onclick: onStart }, icon('play', 26), t('record.start')),
        el('button', { class: 'rec-btn small', onclick: onManual }, icon('plus', 18), t('record.manualCreate'))
      );
    } else if (rec.status === 'recording') {
      renderAutoTag();
      liveActSel.value = liveActivity;
      btnRow.append(
        liveActSel, autoTag,
        el('button', { class: 'rec-btn pause', onclick: () => pauseRecording() }, icon('pause', 22), t('record.pause')),
        el('button', { class: 'rec-btn stop', onclick: onStop }, icon('stop', 22), t('record.stop'))
      );
    } else if (rec.status === 'paused') {
      renderAutoTag();
      liveActSel.value = liveActivity;
      btnRow.append(
        liveActSel, autoTag,
        el('button', { class: 'rec-btn start', onclick: () => resumeRecording() }, icon('play', 24), t('record.resume')),
        el('button', { class: 'rec-btn stop', onclick: onStop }, icon('stop', 22), t('record.stop'))
      );
    }
    renderOledButtons();
  }

  async function onStart() {
    if (navigator.permissions?.query) {
      try {
        const st = await navigator.permissions.query({ name: 'geolocation' });
        if (st.state === 'denied') {
          rec.permissionDenied = true;
          renderBanners();
          toast(t('record.permissionDenied'), 'warn', 5000);
          return;
        }
      } catch { /* query unsupported — watchPosition error path still covers it */ }
    }
    await startRecording({ activity: activitySel.value });
  }
  async function onManual() {
    const trip = await createManualTrip();
    await setActiveTrip(trip.id);
    map.fitTrack();
    toast(t('record.permissionDenied'), 'info', 4000);
    renderButtons();
  }
  async function onStop() {
    const ok = await confirmModal({ title: t('record.stop'), message: t('record.stopConfirm'), confirmText: t('record.stop') });
    if (!ok) return;
    const id = await stopRecording();
    map.endLive();
    map.setTrackData([], []);
    if (id) await setActiveTrip(id);
    renderButtons();
    toast(t('record.stopped'), 'ok');
  }

  // ---------- banners ----------
  function geoBanner(msg, onRetry) {
    return el('div', { class: 'debug-banner', style: { display: 'flex', gap: '8px', alignItems: 'center' } },
      el('span', { class: 'grow' }, '⚠ ' + msg),
      el('button', { class: 'btn sm', onclick: onRetry }, t('record.geoRetry')));
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
    if (rec.permissionDenied && rec.status !== 'recording') {
      bannerBox.append(geoBanner(t('record.permissionDenied'), rec.status === 'paused' ? () => resumeRecording() : onStart));
    } else if (rec.geoError && rec.status === 'recording') {
      bannerBox.append(geoBanner(geoErrorMsg(rec.geoError), retryGeolocation));
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

  // ---------- OLED power saver ----------
  const oled = el('div', { id: 'oled-dash' });
  const odTop = el('div', { class: 'od-top' });
  const odGrid = el('div', { class: 'od-grid' });
  const odBottom = el('div', { class: 'od-bottom' });
  function odCell(key, hero = false) {
    const v = el('div', { class: 'v' }, '--');
    const c = el('div', { class: 'od-cell' + (hero ? ' hero' : '') }, v, el('div', { class: 'k' }, t(key)));
    odGrid.append(c);
    return v;
  }
  const odDist = odCell('panel.distance', true);
  const odDur = odCell('panel.duration');
  const odSpeed = odCell('panel.speed');
  const odAlt = odCell('panel.altitude');
  const odAsc = odCell('panel.ascent');
  const odDesc = odCell('panel.descent');
  oled.append(odTop, odGrid, odBottom);
  document.body.append(oled);

  function renderOledButtons() {
    odBottom.innerHTML = '';
    if (rec.status === 'recording') {
      odBottom.append(el('button', { class: 'rec-btn pause', onclick: () => pauseRecording() }, icon('pause', 20), t('record.pause')));
    } else if (rec.status === 'paused') {
      odBottom.append(el('button', { class: 'rec-btn start', onclick: () => resumeRecording() }, icon('play', 20), t('record.resume')));
    }
    if (rec.status === 'recording' || rec.status === 'paused') {
      odBottom.append(el('button', { class: 'rec-btn stop', onclick: onStop }, icon('stop', 20), t('record.stop')));
    }
    odBottom.append(el('button', { class: 'rec-btn small', onclick: () => setOled(false) }, t('record.oledExit')));
    odTop.innerHTML = '';
    odTop.append(
      el('span', { class: `rec-dot ${rec.status}` }),
      el('span', {}, t(`record.${rec.status === 'recording' ? 'statusRecording' : rec.status === 'paused' ? 'statusPaused' : 'statusIdle'}`)),
      el('span', { class: 'grow' }),
      el('span', {}, 'OLED')
    );
  }

  function renderOled(L) {
    if (!L || !oledActive) return;
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
  }

  async function setOled(on) {
    if (on === oledActive) return;
    oledActive = on;
    if (on) {
      // truly stop WebGL rendering while in power saver
      const center = map.map.getCenter();
      const zoom = map.map.getZoom();
      const basemap = map.basemapId;
      map.destroy();
      map = null;
      mapContainer.style.display = 'none';
      oled.classList.add('active');
      renderOledButtons();
      renderOled(rec.live);
      oled._restore = { center, zoom, basemap };
    } else {
      oled.classList.remove('active');
      mapContainer.style.display = '';
      buildMap();
      const r = oled._restore;
      if (r) {
        map.map.once('load', () => {
          if (r.basemap && map.basemapId !== r.basemap) map.setBasemap(r.basemap);
          map.map.jumpTo({ center: r.center, zoom: r.zoom });
          restoreTrackAfterRebuild();
        });
      }
      renderStyleBar();
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

  // ---------- touch lock ----------
  const lockOverlay = el('div', { id: 'touch-lock' });
  const RING_C = 2 * Math.PI * 54;
  lockOverlay.innerHTML = `
    <div class="lock-ring">
      <svg width="120" height="120" viewBox="0 0 120 120">
        <circle class="bgc" cx="60" cy="60" r="54" fill="none" stroke-width="7"/>
        <circle class="fgc" cx="60" cy="60" r="54" fill="none" stroke-width="7" stroke-linecap="round"/>
      </svg>
      <div class="lock-icon">🔒</div>
    </div>
    <div class="hint">${t('record.lockHint')}</div>
    <div class="sub">${t('record.lockSub')}</div>`;
  document.body.append(lockOverlay);
  const ringFg = lockOverlay.querySelector('.fgc');
  let lockStart = 0;
  let lockRaf = 0;

  function lockLoop(ts) {
    if (!lockStart) return;
    const p = Math.min(1, (ts - lockStart) / 1500);
    ringFg.style.strokeDashoffset = String(RING_C * (1 - p));
    if (p >= 1) { setLocked(false); return; }
    lockRaf = requestAnimationFrame(lockLoop);
  }
  lockOverlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    lockStart = performance.now();
    lockRaf = requestAnimationFrame(lockLoop);
  });
  const cancelLock = () => {
    lockStart = 0;
    cancelAnimationFrame(lockRaf);
    ringFg.style.strokeDashoffset = String(RING_C);
  };
  lockOverlay.addEventListener('pointerup', cancelLock);
  lockOverlay.addEventListener('pointercancel', cancelLock);
  lockOverlay.addEventListener('pointerleave', cancelLock);
  lockOverlay.addEventListener('contextmenu', (e) => e.preventDefault());

  function setLocked(on) {
    locked = on;
    lockOverlay.classList.toggle('active', on);
    lockBtn.classList.toggle('active', on);
    if (on) { cancelLock(); toast(t('toast.lockEngaged'), 'info', 1800); }
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
    if (map && !oledActive) map.appendLive(point, rec.segmentId);
    renderPanel(live);
    renderOled(live);
    if (live.pointCount === 1 && !rec.simulated) { renderStatus(); toast(t('record.firstFix'), 'ok', 2500); }
  });
  on('recorder:tick', ({ live }) => { renderPanel(live); renderOled(live); });
  on('recorder:saved', () => { /* incremental persistence indicator could go here */ });
  on('recorder:filtered', ({ count }) => {
    if (count === 1 || count % 10 === 0) toast(t('record.invalidPoint', { n: count }), 'warn', 2000);
  });

  // ---------- active trip display ----------
  on('trip:active', (full) => {
    if (!map || oledActive) return;
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
      if (rec.status === 'recording') pauseRecording();
      else if (rec.status === 'paused') resumeRecording();
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
    }
  })();

  return {
    view,
    getMap: () => map,
    resize: () => { map?.resize(); renderStyleBar(); },
    refresh: () => { renderButtons(); renderBanners(); renderViewBar(); renderRewalk(); },
    destroy: () => {
      document.removeEventListener('keydown', onKeydown);
      offBroadcast();
      map?.destroy();
      map = null;
      oled.remove();
      lockOverlay.remove();
    }
  };
}