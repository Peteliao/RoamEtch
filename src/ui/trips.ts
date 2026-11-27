// Trips list: open/edit/analyze, GPX import, full backup/restore, storage monitor.
import { t } from '../core/i18n';
import { on } from '../core/events';
import { listTrips, deleteTrip, updateTrip, loadTripPreview, storageEstimate } from '../core/store';
import { routeRepository } from '../core/routeRepository';
import { exportTripsZip, importTripFiles } from '../core/batch';
import { startRewalk } from '../core/rewalk';
import { importDemoTrip } from '../core/demo';
import { aggregateCityFootprints, buildFootprints, cityFootprintKey, footprintCacheKey, withFootprintCities } from '../core/footprint';
import { generateFootprintImage, generateFootprintVideo, footprintCaption } from '../core/footprintShare';
import { resolveTripCities } from '../core/shareInfo';
import { paintTrack, prepareMap } from '../core/mapPaint';
import { videoSupported, videoIsWebmOnly } from '../core/videoCapture';
import { exportBackupFlow, lastBackupLabel, backupDue } from './backupFlow';
import { openInstallGuide, isIOS, isStandaloneMode } from './install';
import { triggerDownload } from '../core/gpx';
import { fmtAltitude, fmtDistance, fmtDuration, simplify } from '../core/geo';
import { migrateLegacyKey } from '../core/storageKeys';
import { get } from '../core/settings';
import { exportImage, exportFile, isWeChat, wechatFileGuidance } from '../core/shareEnv';
import { appState, setActiveTrip, refreshActiveTrip, recalcNow } from './state';
import { TrackMap } from './map';
import { el, icon, toast, confirmModal, filePickerMulti, modal } from './helpers';
import { createAnalysisView } from './analysis';
import { createStoryView } from './story';
import { openGrowthReport } from './growth';
import { openMapTools } from './mapTools';
import { createExportView } from './export';
import { backFromUIState, currentUIState } from './history';
import { buildTripFilterIndex } from '../core/tripLibrary';
import { activeTripFilterCount, canonicalTripFilterValue, emptyTripFilters, filterTripIndexes, hasActiveTripFilters, indexTripForFilters, placeKey, tripFilterDisplayValue, tripFilterRouteOptions } from '../core/tripFilters';
import { buildHeatmapAsync } from '../core/workerBridge';
import { buildHeatmapBatchAsync, mergeHeatmaps } from '../core/heatmap';

function thumbnailPoints(segments) {
  const total = segments.reduce((sum, segment) => sum + (segment.points?.length || 0), 0);
  if (!total) return [];
  const sampleCount = Math.min(total, 4000);
  const points = [];
  let segmentIndex = 0;
  let segmentStart = 0;
  for (let sample = 0; sample < sampleCount; sample++) {
    const target = sampleCount === 1 ? 0 : Math.floor(sample * (total - 1) / (sampleCount - 1));
    while (segmentIndex < segments.length - 1 && target >= segmentStart + segments[segmentIndex].points.length) {
      segmentStart += segments[segmentIndex].points.length;
      segmentIndex++;
    }
    const point = segments[segmentIndex].points[target - segmentStart];
    if (point) points.push(point);
  }
  return simplify(points, 40).slice(0, 160).map((p) => ({ lat: p.lat, lon: p.lon }));
}

function copyFootprintCaption(fp) {
  const text = footprintCaption(fp);
  const fallback = () => {
    const area = el('textarea', { readonly: true, rows: '10' });
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
      if (ok) { toast(t('settings.promoCopied'), 'ok'); return; }
    } catch { /* fall through */ }
    fallback();
  };
  paste();
}

function openFootprintImagePreview(result, fp) {
  const file = new File([result.blob], result.filename, { type: 'image/png' });
  const canShare = !!navigator.share && !!navigator.canShare?.({ files: [file] });
  const url = URL.createObjectURL(result.blob);
  const img = el('img', { class: 'promo-preview-img', src: url, alt: t('trips.footprintImageTitle') });
  const copyBtn = el('button', { class: 'btn' }, icon('copy', 16), t('trips.footprintCopy'));
  const saveBtn = el('button', { class: `btn ${canShare ? '' : 'primary'}` }, icon('download', 16), t('settings.promoDownload'));
  const shareBtn = canShare
    ? el('button', { class: 'btn primary' }, icon('share', 16), t('export.shareImage'))
    : null;
  const m = modal({
    title: t('trips.footprintImageTitle'),
    body: el('div', {},
      el('div', { class: 'small muted promo-preview-note' }, t('trips.footprintShareHint')),
      img),
    footer: [copyBtn, saveBtn, shareBtn].filter(Boolean),
    onClose: () => URL.revokeObjectURL(url)
  });
  copyBtn.onclick = () => copyFootprintCaption(fp);
  saveBtn.onclick = async () => {
    const res = await exportImage(result.blob, result.filename);
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
        await navigator.share({ title: t('trips.footprintTitle'), text: footprintCaption(fp), files: [file] });
      } catch (e) {
        if (e?.name !== 'AbortError') saveBtn.click();
      }
    };
  }
}

function openFootprintVideoPreview(fp) {
  const caption = footprintCaption(fp);
  const controller = new AbortController();
  const webmOnly = videoIsWebmOnly(true);
  let closed = false;
  let url = null;
  let blob = null;
  const stage = el('div', { class: 'fp-video-stage' },
    el('div', { class: 'fp-spinner' }),
    el('div', { class: 'small muted fp-video-progress' }, t('trips.footprintGenerating', { p: 0 })));
  const note = el('div', { class: 'small muted promo-preview-note' }, t('trips.footprintVideoKeep'));
  const formatWarn = webmOnly
    ? el('div', { class: 'debug-banner' }, '⚠ ' + t('export.videoWebmWarn'))
    : null;
  const copyBtn = el('button', { class: 'btn', style: { display: 'none' } }, icon('copy', 16), t('trips.footprintCopy'));
  const saveBtn = el('button', { class: 'btn', style: { display: 'none' } }, icon('download', 16), t('trips.footprintSaveVideo'));
  const shareBtn = el('button', { class: 'btn primary', style: { display: 'none' } }, icon('share', 16), t('export.shareVideo'));
  const m = modal({
    title: t('trips.footprintVideoTitle'),
    body: el('div', {}, formatWarn, note, stage),
    footer: [copyBtn, saveBtn, shareBtn],
    onClose: () => {
      closed = true;
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    }
  });
  copyBtn.onclick = () => copyFootprintCaption(fp);
  saveBtn.onclick = () => {
    if (!blob) return;
    exportFile(blob, `roametch-footprint-${fp.year}-${Date.now()}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`);
    toast(t('export.exported'), 'ok');
  };
  shareBtn.onclick = async () => {
    if (!blob) return;
    const file = new File([blob], `roametch-footprint-${fp.year}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`, { type: blob.type });
    try {
      await navigator.share({ title: t('trips.footprintTitle'), text: caption, files: [file] });
    } catch (e) {
      if (e?.name !== 'AbortError') saveBtn.click();
    }
  };

  generateFootprintVideo(fp, {
    signal: controller.signal,
    onProgress: (p) => {
      if (!closed) stage.querySelector('.fp-video-progress').textContent = t('trips.footprintGenerating', { p: Math.round(p * 100) });
    }
  }).then((result) => {
    if (closed) return;
    blob = result.blob;
    url = URL.createObjectURL(blob);
    const video = el('video', {
      controls: true, playsinline: true, autoplay: true, loop: true, muted: true,
      poster: result.cover || '', src: url, class: 'fp-video'
    });
    stage.replaceChildren(video);
    note.textContent = t('trips.footprintVideoReady', { size: (blob.size / 1048576).toFixed(1) + ' MB' }) +
      (blob.type.includes('webm') ? ` · ${t('export.videoWebmShort')}` : '');
    copyBtn.style.display = '';
    saveBtn.style.display = '';
    if (navigator.share && navigator.canShare?.({ files: [new File([blob], 'a', { type: blob.type })] })) {
      shareBtn.style.display = '';
    }
  }).catch((err) => {
    if (err?.name === 'AbortError' || closed) return;
    console.error(err);
    note.textContent = err?.message === 'video-unsupported' ? t('export.videoUnsupported') : '';
    stage.replaceChildren(el('div', { class: 'fp-video-fail' }, icon('warn', 22), el('div', {}, t('trips.footprintVideoFailed'))));
    toast(t('trips.footprintVideoFailed'), 'err');
  });
}

export function createTripsView(navigate, getRecordMap = () => null) {
  const view = el('div', { class: 'view', id: 'view-trips' });
  const scroll = el('div', { class: 'view-scroll' });
  const analysisView = createAnalysisView(navigate, { embedded: true });
  const storyView = createStoryView(navigate, { embedded: true });
  const exportView = createExportView(getRecordMap, navigate);
  for (const panel of [analysisView, storyView, exportView]) {
    panel.view.classList.remove('view');
    panel.view.classList.add('trip-detail-panel');
  }
  const detailTitle = el('h2', { class: 'page-title trip-detail-title' });
  const detailDate = el('div', { class: 'small faint trip-detail-date' });
  const detailSelect = el('select', { class: 'trip-detail-select', 'aria-label': t('trips.switchTrip') });
  const detailTabs = el('div', { class: 'trip-detail-tabs', role: 'tablist' });
  const detailActions = el('div', { class: 'trip-detail-actions' });
  const detail = el('div', { class: 'trip-detail', id: 'trip-detail', 'data-section': 'overview' },
    el('div', { class: 'trip-detail-head' },
      el('div', { class: 'page-head-row' },
        el('button', { class: 'iconbtn trip-detail-back', 'aria-label': t('common.back'), onclick: () => closeDetail() }, icon('chevronRight', 18)),
        el('div', { class: 'trip-detail-heading' }, detailTitle, detailDate)),
      el('div', { class: 'trip-detail-tools' }, detailSelect,
        el('button', { class: 'btn sm primary', onclick: () => navigate('trips', { detail: true, tripId: appState.tripDetail.tripId, section: 'share' }) }, icon('share', 14), t('trips.detailShare'))),
      detailTabs,
      detailActions),
    el('div', { class: 'trip-detail-panels' }, analysisView.view, storyView.view, exportView.view));
  for (const section of ['overview', 'data', 'story', 'share']) {
    detailTabs.append(el('button', {
      role: 'tab', 'data-section': section,
      'aria-controls': section === 'share' ? 'view-export' : section === 'story' ? 'view-story' : 'view-analysis',
      onclick: () => navigate('trips', { detail: true, tripId: appState.tripDetail.tripId, section })
    }, t(`trips.detail${section[0].toUpperCase()}${section.slice(1)}`)));
  }
  detailSelect.onchange = () => {
    const trip = allTrips.find((item) => item.id === detailSelect.value);
    if (trip) void openTrip(trip, appState.tripDetail.section);
  };
  view.append(scroll, detail);

  const header = el('div', { class: 'page-head' },
    el('div', { class: 'page-head-row' },
      el('h2', { class: 'page-title' }, t('trips.title')),
      el('div', { class: 'page-actions' },
        el('button', { class: 'btn sm primary', onclick: onImport }, icon('plus', 14), t('trips.importShort')),
        el('button', { class: 'iconbtn', title: t('trips.more'), onclick: openMoreSheet }, icon('more'))
      )
    )
  );

  function sumCell() {
    const v = el('div', { class: 'v' }, '--');
    const k = el('div', { class: 'k' }, '');
    const c = el('div', { class: 'sum-cell' }, v, k);
    return { v, k, c };
  }
  const sTrips = sumCell();
  const sDist = sumCell();
  const sDays = sumCell();
  const summary = el('div', { class: 'summary-strip' }, sTrips.c, sDist.c, sDays.c);

  const searchInput = el('input', { type: 'search', placeholder: t('trips.searchPh'), 'aria-label': t('trips.searchPh') });
  searchInput.oninput = () => { filters.query = searchInput.value.trim().toLowerCase(); renderList(); };
  const searchBar = el('div', { class: 'search-bar' }, icon('search', 18), searchInput);

  const ACTIVITIES = ['all', 'hike', 'drive', 'bike', 'run', 'travel'];
  let filters = emptyTripFilters();
  let filterIndexes = [];
  let filterIndexLoading = false;
  let filterIndexController = null;
  let filterIndexVersion = 0;
  let sortMode = 'recent';
  let allTrips = [];
  let detailTrip = null;
  let footprintYear: number | 'all' = new Date().getFullYear();
  let footprintActivity = 'all';
  let footprintLayer = 'heatmap';
  let footprintExpanded = false;
  const thumbNodes = new Map();
  let thumbRun = 0;
  const activityFilter = el('select', { class: 'trip-sort trip-filter-select', 'aria-label': t('trips.filterLabel') },
    ...ACTIVITIES.map((a) => el('option', { value: a }, a === 'all' ? t('trips.filterAll') : t(`record.activities.${a}`))),
    el('option', { value: 'favorite' }, t('trips.favorite')));
  activityFilter.value = 'all';
  activityFilter.onchange = () => {
    filters.favoriteOnly = activityFilter.value === 'favorite';
    filters.activity = filters.favoriteOnly ? 'all' : activityFilter.value;
    renderList();
  };
  const sortSel = el('select', { class: 'trip-sort', 'aria-label': t('trips.sort') },
    el('option', { value: 'recent' }, t('trips.sortRecent')),
    el('option', { value: 'created' }, t('trips.sortCreated')),
    el('option', { value: 'distance' }, t('trips.sortDistance')),
    el('option', { value: 'name' }, t('trips.sortName')));
  sortSel.value = sortMode;
  sortSel.onchange = () => { sortMode = sortSel.value; renderList(); };
  const filterBtn = el('button', { class: 'btn sm trip-filter-btn', onclick: openFilterPanel }, icon('filter', 14), t('trips.advancedFilters'));
  const toolbar = el('div', { class: 'trips-toolbar' }, activityFilter, filterBtn, sortSel);

  const CITY_CONSENT_KEY = 'roametch.cityFootprintConsent.v1';
  const footprintStates = new Map();
  const footprintJobs = new Map();
  const footprintAborts = new Map();
  const heatmapStates = new Map();
  const heatmapJobs = new Map();
  const heatmapAborts = new Map();
  let heatmapVersion = 0;
  let footprintVersion = 0;
  let renderedFootprintKey = '';
  let footprintMap = null;
  let footprintMapKey = '';
  let viewDestroyed = false;
  const footprintMapBox = el('div', { class: 'footprint-map', 'aria-label': t('trips.footprintCityMap') });
  const footprintMapStatus = el('div', { class: 'footprint-map-status' });
  const footprintBody = el('div', {});
  const footprintToggle = el('button', { type: 'button', class: 'footprint-toggle', 'aria-controls': 'yearly-footprint-content' });
  const footprintContent = el('div', { class: 'footprint-content', id: 'yearly-footprint-content' });
  footprintToggle.onclick = () => { footprintExpanded = !footprintExpanded; renderFootprint(); };
  footprintContent.append(footprintBody);
  const footprintCard = el('div', { class: 'card footprint-card' }, footprintToggle, footprintContent);
  const nudge = el('div', { class: 'backup-nudge', style: { display: 'none' } });
  const iosNudge = el('div', { class: 'backup-nudge ios-storage-nudge', style: { display: 'none' } });
  const IOS_NUDGE_KEY = 'roametch.iosStorageNudge.v1';
  migrateLegacyKey('trackmint.cityFootprintConsent.v1', CITY_CONSENT_KEY);
  migrateLegacyKey('trackmint.iosStorageNudge.v1', IOS_NUDGE_KEY);
  let iosNudgeBuilt = false;
  function iosNudgeDismissed() {
    try { return !!localStorage.getItem(IOS_NUDGE_KEY); } catch { return true; }
  }
  function renderIosNudge() {
    const show = allTrips.length > 0 && isIOS() && !isStandaloneMode() && !iosNudgeDismissed();
    iosNudge.style.display = show ? '' : 'none';
    if (!show || iosNudgeBuilt) return;
    iosNudgeBuilt = true;
    const installBtn = el('button', { class: 'btn sm' }, icon('download', 14), t('trips.iosStorageInstall'));
    installBtn.onclick = () => openInstallGuide();
    const backupBtn = el('button', { class: 'btn sm' }, icon('shield', 14), t('trips.iosStorageBackup'));
    backupBtn.onclick = async () => {
      try { await exportBackupFlow(); renderNudge(); } catch { toast(t('backup.exportErr'), 'err'); }
    };
    const closeBtn = el('button', {
      class: 'iconbtn ios-nudge-close', title: t('common.close'), 'aria-label': t('common.close')
    }, icon('x', 15));
    closeBtn.onclick = () => {
      try { localStorage.setItem(IOS_NUDGE_KEY, String(Date.now())); } catch { /* storage unavailable */ }
      iosNudge.style.display = 'none';
    };
    iosNudge.append(
      icon('warn', 18),
      el('div', { class: 'nudge-txt' },
        el('div', { class: 'nudge-t' }, t('trips.iosStorageTitle')),
        el('div', { class: 'nudge-d' }, t('trips.iosStorageDesc'))),
      el('div', { class: 'ios-nudge-actions' }, installBtn, backupBtn),
      closeBtn);
  }
  const storageBar = el('div', { class: 'small faint', style: { marginTop: '14px', textAlign: 'center' } });
  const listBox = el('div', {});
  scroll.append(header, footprintCard, searchBar, toolbar, listBox, summary, nudge, iosNudge, storageBar);

  function thumbSVG(points) {
    if (!points || points.length < 2) return '<svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="4" fill="var(--text-faint)"/></svg>';
    const pts = simplify(points, 30).slice(0, 200);
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const p of pts) {
      if (p.lon < minx) minx = p.lon;
      if (p.lon > maxx) maxx = p.lon;
      if (p.lat < miny) miny = p.lat;
      if (p.lat > maxy) maxy = p.lat;
    }
    const sx = 44 / Math.max(1e-6, maxx - minx);
    const sy = 44 / Math.max(1e-6, maxy - miny);
    const s = Math.min(sx, sy);
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${(4 + (p.lon - minx) * s).toFixed(1)},${(48 - (p.lat - miny) * s).toFixed(1)}`).join('');
    return `<svg viewBox="0 0 52 52"><path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"/></svg>`;
  }

  async function hydrateThumbnails(trips) {
    const run = ++thumbRun;
    for (const trip of trips) {
      if (run !== thumbRun || viewDestroyed) return;
      try {
        let points = trip.thumbPoints;
        if (!points || points.length < 2) {
          const track = await loadTripPreview(trip.id);
          points = track ? thumbnailPoints(track.segments) : [];
          if (points.length < 2 || run !== thumbRun) continue;
          await updateTrip(trip.id, { thumbPoints: points }, { touch: false });
          if (run !== thumbRun) continue;
          trip.thumbPoints = points;
        }
        const thumb = thumbNodes.get(trip.id);
        if (!thumb) continue;
        thumb.innerHTML = thumbSVG(points);
        const map = await prepareMap({
          w: 108, h: 108, pad: 8,
          segments: [{ id: trip.id, points }], waypoints: []
        });
        if (run !== thumbRun || thumbNodes.get(trip.id) !== thumb || viewDestroyed) continue;
        const canvas = document.createElement('canvas');
        canvas.width = 108; canvas.height = 108;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(map.bg, 0, 0);
        paintTrack(ctx, map.fit, map.segments, [], { lineWidth: 3.2, dotRadius: 3.5, wpRadius: 2, darkBg: map.darkBg });
        const img = el('img', { src: canvas.toDataURL('image/webp', 0.84), alt: '', draggable: false });
        thumb.replaceChildren(img);
      } catch (e) {
        console.warn('thumbnail hydration failed', trip.id, e);
      }
    }
  }

  function syncBasicFilterControls() {
    activityFilter.value = filters.favoriteOnly ? 'favorite' : filters.activity;
    searchInput.value = filters.query;
    updateFilterButton();
  }

  function updateFilterButton() {
    const count = activeTripFilterCount(filters);
    const active = hasActiveTripFilters(filters);
    filterBtn.classList.toggle('active', active);
    filterBtn.setAttribute('aria-pressed', String(active));
    filterBtn.replaceChildren(icon('filter', 14), t('trips.advancedFilters') + (count ? ` (${count})` : ''));
  }

  function clearTripFilters() {
    filters = emptyTripFilters();
    syncBasicFilterControls();
    renderList();
  }

  function filteredTrips() {
    const entries = filterIndexes.length ? filterIndexes : allTrips.map((trip) => indexTripForFilters(trip));
    return filterTripIndexes(entries, filters).map((entry) => entry.trip);
  }

  async function refreshFilterIndex() {
    filterIndexController?.abort();
    const controller = new AbortController();
    const version = ++filterIndexVersion;
    filterIndexController = controller;
    filterIndexLoading = true;
    updateFilterButton();
    try {
      const entries = await buildTripFilterIndex(allTrips, controller.signal);
      if (version !== filterIndexVersion || controller.signal.aborted || viewDestroyed) return;
      filterIndexes = entries;
      renderList();
    } catch (error) {
      if (error?.name !== 'AbortError') toast(t('trips.filterIndexLoading'), 'warn');
    } finally {
      if (version === filterIndexVersion) {
        filterIndexLoading = false;
        updateFilterButton();
      }
    }
  }

  function openFilterPanel() {
    const units = get('units');
    const distanceUnit = units === 'imperial' ? 'mi' : 'km';
    const ascentUnit = units === 'imperial' ? 'ft' : 'm';
    const field = (label, input) => el('label', { class: 'filter-field' }, el('span', { class: 'filter-label' }, label), input);
    const numberInput = (key, min = 0, max = null, measurement = null) => el('input', {
      type: 'number', class: 'input', inputmode: 'decimal', min: String(min),
      ...(max != null ? { max: String(max) } : {}), step: 'any',
      value: measurement ? tripFilterDisplayValue(filters[key], measurement, units)
        : (filters[key] == null ? '' : String(filters[key])),
      'data-filter': key
    });
    const dateInput = (key) => el('input', {
      type: 'date', class: 'input', value: filters[key], 'data-filter': key
    });
    const from = dateInput('fromDate');
    const to = dateInput('toDate');
    const minDistance = numberInput('minDistance', 0, null, 'distance');
    const maxDistance = numberInput('maxDistance', 0, null, 'distance');
    const minAscent = numberInput('minAscent', 0, null, 'ascent');
    const maxAscent = numberInput('maxAscent', 0, null, 'ascent');
    const waypoints = numberInput('minWaypoints', 0, 100_000);
    const completeness = numberInput('minCompleteness', 0, 100);
    const photos = el('select', { class: 'input', 'data-filter': 'hasPhotos' },
      el('option', { value: 'any' }, t('trips.filterAny')),
      el('option', { value: 'yes' }, t('trips.filterHasPhotos')),
      el('option', { value: 'no' }, t('trips.filterNoPhotos')));
    photos.value = filters.hasPhotos;
    const placeOptions = new Map();
    const entries = filterIndexes.length ? filterIndexes : allTrips.map((trip) => indexTripForFilters(trip));
    for (const entry of entries) {
      for (const place of entry.places) {
        const key = placeKey(place);
        if (!key || placeOptions.has(key)) continue;
        placeOptions.set(key, `${place.name}${place.countryCode ? ` · ${place.countryCode}` : ''}${place.admin ? ` · ${place.admin}` : ''}`);
      }
    }
    if (filters.place && !placeOptions.has(filters.place)) placeOptions.set(filters.place, filters.place);
    const place = el('select', { class: 'input', 'data-filter': 'place' },
      el('option', { value: '' }, t('trips.filterAnyPlace')),
      ...[...placeOptions].map(([value, label]) => el('option', { value }, label)));
    place.value = filters.place;
    const routeOptions = tripFilterRouteOptions(entries);
    if (filters.routeId && !routeOptions.some(([routeId]) => routeId === filters.routeId)) {
      routeOptions.push([filters.routeId, filters.routeId]);
    }
    const route = el('select', { class: 'input', 'data-filter': 'routeId' },
      el('option', { value: '' }, t('trips.filterAnyRoute')),
      ...routeOptions.map(([value, label]) => el('option', { value }, label)));
    route.value = filters.routeId;
    const body = el('div', { class: 'filter-panel' },
      el('div', { class: 'filter-group' }, el('h3', {}, t('trips.filterDate')),
        el('div', { class: 'filter-grid' }, field(t('trips.filterFrom'), from), field(t('trips.filterTo'), to))),
      el('div', { class: 'filter-group' }, el('h3', {}, t('trips.filterDistance', { unit: distanceUnit })),
        el('div', { class: 'filter-grid' }, field(t('trips.filterMin'), minDistance), field(t('trips.filterMax'), maxDistance))),
      el('div', { class: 'filter-group' }, el('h3', {}, t('trips.filterAscent', { unit: ascentUnit })),
        el('div', { class: 'filter-grid' }, field(t('trips.filterMin'), minAscent), field(t('trips.filterMax'), maxAscent))),
      el('div', { class: 'filter-group' },
        el('div', { class: 'filter-grid' },
          field(t('trips.filterPhotos'), photos),
          field(t('trips.filterWaypoints'), waypoints),
          field(t('trips.filterCompleteness'), completeness),
          field(t('trips.filterPlace'), place)),
        el('p', { class: 'small faint filter-hint' }, t('trips.filterCompletenessHint'))),
      el('div', { class: 'filter-group' }, el('h3', {}, t('trips.filterRoute')), route));
    const clear = el('button', { class: 'btn', onclick: () => { m.close(); clearTripFilters(); } }, t('trips.clearFilters'));
    const apply = el('button', { class: 'btn primary', onclick: () => {
      const read = (input) => input.value.trim() === '' ? null : Number(input.value);
      const nextDistanceMin = read(minDistance), nextDistanceMax = read(maxDistance);
      const nextAscentMin = read(minAscent), nextAscentMax = read(maxAscent);
      const nextWaypoints = read(waypoints), nextCompleteness = read(completeness);
      const numericValues = [nextDistanceMin, nextDistanceMax, nextAscentMin, nextAscentMax, nextWaypoints, nextCompleteness];
      if (numericValues.some((value) => value != null && (!Number.isFinite(value) || value < 0)) ||
          (nextWaypoints != null && !Number.isInteger(nextWaypoints)) ||
          (nextCompleteness != null && nextCompleteness > 100) ||
          (nextDistanceMin != null && nextDistanceMax != null && nextDistanceMin > nextDistanceMax) ||
          (nextAscentMin != null && nextAscentMax != null && nextAscentMin > nextAscentMax) ||
          (from.value && to.value && from.value > to.value)) {
        toast(t('trips.filterRangeError'), 'warn');
        return;
      }
      filters = {
        ...filters, fromDate: from.value, toDate: to.value,
        minDistance: canonicalTripFilterValue(nextDistanceMin, 'distance', units),
        maxDistance: canonicalTripFilterValue(nextDistanceMax, 'distance', units),
        minAscent: canonicalTripFilterValue(nextAscentMin, 'ascent', units),
        maxAscent: canonicalTripFilterValue(nextAscentMax, 'ascent', units),
        hasPhotos: photos.value, minWaypoints: nextWaypoints,
        minCompleteness: nextCompleteness, place: place.value, routeId: route.value
      };
      m.close();
      updateFilterButton();
      renderList();
    } }, t('common.apply'));
    const m = modal({ title: t('trips.filterTitle'), body, footer: [clear, apply], wide: true });
  }

  function renderList() {
    const units = get('units');
    thumbRun++;
    thumbNodes.clear();
    listBox.innerHTML = '';
    if (!allTrips.length) {
      renderSummary([]);
      listBox.append(el('div', { class: 'empty-state' },
        el('div', { class: 'empty-ic' }, icon('mountain', 28)),
        el('div', { class: 'empty-title' }, t('trips.empty')),
        el('div', { class: 'small' }, t('trips.emptyHint')),
        el('button', { class: 'btn sm primary', style: { marginTop: '14px' }, onclick: () => navigate('record') }, icon('record', 14), t('trips.goRecord')),
        el('button', { class: 'btn sm', style: { marginTop: '8px' }, onclick: onLoadDemo }, icon('analysis', 14), t('demo.load')),
        el('div', { class: 'small faint', style: { marginTop: '8px' } }, t('demo.hint'))));
      return;
    }
    const trips = filteredTrips();
    trips.sort((a, b) => {
      if (sortMode === 'recent') {
        return (Number(b.favorite) - Number(a.favorite)) || (b.updatedAt - a.updatedAt);
      }
      if (sortMode === 'created') return b.createdAt - a.createdAt;
      if (sortMode === 'distance') return (b.statsCache?.distance || 0) - (a.statsCache?.distance || 0);
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    if (!trips.length) {
      renderSummary(trips);
      const indexing = filterIndexLoading && (filters.hasPhotos !== 'any' || filters.minWaypoints != null);
      listBox.append(el('div', { class: 'empty-state' },
        el('div', { class: 'empty-title' }, indexing ? t('common.loading') : t('trips.noMatch')),
        el('div', { class: 'small' }, indexing ? t('trips.filterIndexLoading') : t('trips.noMatchHint')),
        indexing ? null : el('button', {
          class: 'btn sm', style: { marginTop: '12px' }, onclick: clearTripFilters
        }, t('trips.clearFilters'))));
      return;
    }
    for (const trip of trips) {
      const st = trip.statsCache;
      const d = st ? fmtDistance(st.distance, units) : null;
      const ascent = st ? fmtAltitude(st.ascent, units) : null;
      const statusKey = trip.status === 'recording' ? 'statusRecording' : trip.status === 'paused' ? 'statusPaused' : 'statusFinished';
      const thumb = el('div', { class: 'thumb', html: thumbSVG(trip.thumbPoints) });
      thumbNodes.set(trip.id, thumb);
      const item = el('div', {
        class: 'trip-item', role: 'button', tabindex: '0', onclick: () => openTrip(trip),
        onkeydown: (e) => {
          if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          openTrip(trip);
        }
      },
        el('div', { class: 'ti-row' },
          thumb,
          el('div', { class: 'info' },
            el('div', { class: 'name' },
              el('button', {
                class: 'fav-toggle' + (trip.favorite ? ' active' : ''),
                title: trip.favorite ? t('trips.unfavorite') : t('trips.favoriteHint'),
                'aria-label': t('trips.favorite'),
                onclick: (e) => { e.stopPropagation(); toggleFavorite(trip); }
              }, icon('star', 15)),
              el('span', { class: 'name-text' }, trip.name || t('record.newTripName'))),
            el('div', { class: 'meta' },
              new Date(trip.createdAt).toLocaleDateString(),
              el('span', {}, t(`record.activities.${trip.activity}`)),
              el('span', { class: 'tag' }, t(`trips.${statusKey}`))),
            trip.tags?.length ? el('div', { class: 'trip-tags' }, trip.tags.map((tag) => el('span', { class: 'trip-tag' }, `#${tag}`))) : null),
          el('span', { class: 'ti-chev' }, icon('chevronRight', 16))),
        el('div', { class: 'ti-stats' },
          el('div', { class: 'ti-stat' }, el('div', { class: 'v' }, d ? `${d.v}${d.u}` : '--'), el('div', { class: 'k' }, t('analysis.distance'))),
          el('div', { class: 'ti-stat' }, el('div', { class: 'v' }, st ? fmtDuration(st.duration, { compact: true }) : '--'), el('div', { class: 'k' }, t('analysis.duration'))),
          el('div', { class: 'ti-stat' }, el('div', { class: 'v' }, ascent ? `↑${ascent.v}${ascent.u}` : '--'), el('div', { class: 'k' }, t('analysis.ascent'))))
      );
      listBox.append(item);
    }
    void hydrateThumbnails(trips);
    renderSummary(trips);
  }

  function renderSummary(trips = allTrips) {
    const units = get('units');
    const totalDist = trips.reduce((a, tr) => a + (tr.statsCache?.distance || 0), 0);
    const d = fmtDistance(totalDist, units);
    const days = new Set(trips.map((tr) => new Date(tr.createdAt).toDateString())).size;
    sTrips.v.textContent = String(trips.length);
    sTrips.k.textContent = t('trips.sumTrips');
    sDist.v.innerHTML = `${d.v}<small>${d.u}</small>`;
    sDist.k.textContent = t('trips.sumDistance');
    sDays.v.innerHTML = `${days}<small>${t('common.days')}</small>`;
    sDays.k.textContent = t('trips.sumDays');
  }

  function renderNudge() {
    nudge.innerHTML = '';
    if (!allTrips.length || !backupDue()) { nudge.style.display = 'none'; return; }
    nudge.style.display = '';
    const btn = el('button', { class: 'btn sm' }, icon('download', 14), t('backup.now'));
    btn.onclick = async () => {
      try { await exportBackupFlow(); renderNudge(); }
      catch { toast(t('backup.exportErr'), 'err'); }
    };
    nudge.append(icon('shield', 18),
      el('div', { class: 'nudge-txt' },
        el('div', { class: 'nudge-t' }, t('backup.nudge', { n: allTrips.length })),
        el('div', { class: 'nudge-d' }, t('backup.lastBackup', { when: lastBackupLabel() }))),
      btn);
  }

  function hasCityConsent() {
    try { return localStorage.getItem(CITY_CONSENT_KEY) === 'yes'; } catch { return false; }
  }

  function yearTrips(year: number | 'all' = footprintYear) {
    return allTrips.filter((trip) => {
      if (trip.status === 'recording' || trip.status === 'paused') return false;
      const date = new Date(trip.createdAt);
      if (!Number.isFinite(date.getTime())) return false;
      return (year === 'all' || date.getFullYear() === Number(year))
        && (footprintActivity === 'all' || trip.activity === footprintActivity);
    });
  }

  function currentPrivacyRadius() {
    const radius = Number(get('privacyRadius'));
    return Number.isFinite(radius) && radius >= 0 ? radius : 0;
  }

  function footprintScopeKey(year = footprintYear, trips = yearTrips(year), activity = footprintActivity) {
    return footprintCacheKey({ year, activity, privacyRadius: currentPrivacyRadius(), trips });
  }

  function cancelFootprintJobs() {
    for (const controller of footprintAborts.values()) controller.abort();
    footprintAborts.clear();
    for (const jobKey of footprintJobs.keys()) footprintJobs.delete(jobKey);
  }

  function cancelHeatmapJobs() {
    for (const controller of heatmapAborts.values()) controller.abort();
    heatmapAborts.clear();
    for (const jobKey of heatmapJobs.keys()) heatmapJobs.delete(jobKey);
  }

  async function loadHistoryHeatmap(year, activity, trips, retryTripIds: string[] | null = null) {
    const key = footprintScopeKey(year, trips, activity);
    if (heatmapJobs.has(key) || viewDestroyed) return;
    cancelHeatmapJobs();
    const version = ++heatmapVersion;
    const previous = heatmapStates.get(key);
    const retrySet = retryTripIds ? new Set(retryTripIds) : null;
    const selectedTrips = retrySet ? trips.filter((trip) => retrySet.has(trip.id)) : trips;
    const initialData = retrySet && previous?.key === key ? previous.data : null;
    const priorFailed = retrySet && previous?.key === key ? [...(previous.failedTripIds || [])] : [];
    const failedFor = (succeededIds: string[], failedIds: string[]) => {
      const failed = new Set(priorFailed);
      for (const id of succeededIds) failed.delete(id);
      for (const id of failedIds) failed.add(id);
      return trips.filter((trip) => failed.has(trip.id)).map((trip) => trip.id);
    };
    if (!selectedTrips.length) {
      heatmapStates.set(key, {
        key, version, status: priorFailed.length ? 'error' : 'ready', progress: 100,
        data: initialData || mergeHeatmaps([]), failedTripIds: priorFailed
      });
      renderFootprint();
      return;
    }
    heatmapStates.set(key, {
      key, version, status: 'loading', progress: 0, data: initialData, failedTripIds: priorFailed
    });
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && heatmapStates.get(key)?.version === version;
    const privacyRadius = currentPrivacyRadius();
    heatmapAborts.set(key, controller);
    const job = (async () => {
      try {
        const batch = await buildHeatmapBatchAsync(selectedTrips, async (trip) => {
          const track = await routeRepository.load(trip.id);
          if (!track) return null;
          return buildHeatmapAsync([track], { maxPoints: 1200, gridSize: 0.001, privacyRadius }, { signal: controller.signal });
        }, {
          signal: controller.signal,
          initial: initialData,
          onProgress: ({ completed, total, result, succeededIds, failedIds }) => {
            if (viewDestroyed || !isCurrent()) return;
            const state = heatmapStates.get(key);
            if (state?.status === 'loading') {
              state.data = result;
              state.progress = Math.round((completed / total) * 100);
              state.failedTripIds = failedFor(succeededIds, failedIds);
            }
            if (completed === 1 || completed % 10 === 0 || completed === total) renderFootprint();
          }
        });
        if (controller.signal.aborted || viewDestroyed || !isCurrent()) return;
        const failedTripIds = failedFor(batch.succeededIds, batch.failedIds);
        heatmapStates.set(key, {
          key, version, progress: 100, data: batch.result, failedTripIds,
          status: failedTripIds.length ? (batch.result.stats.tripCount > 0 ? 'partial' : 'error') : 'ready'
        });
      } catch (error) {
        if (controller.signal.aborted || viewDestroyed || !isCurrent()) return;
        console.warn('heatmap aggregation failed', error);
        const state = heatmapStates.get(key);
        heatmapStates.set(key, {
          key, version, status: 'error', progress: 0,
          data: state?.data || null, failedTripIds: state?.failedTripIds || []
        });
      } finally {
        if (heatmapJobs.get(key) === job) heatmapJobs.delete(key);
        if (heatmapAborts.get(key) === controller) heatmapAborts.delete(key);
        if (!viewDestroyed && isCurrent()) renderFootprint();
      }
    })();
    heatmapJobs.set(key, job);
    renderFootprint();
    await job;
  }

  function ensureFootprintMap() {
    if (footprintMap || viewDestroyed) return;
    footprintMap = new TrackMap(footprintMapBox, {
      onHeatmapClick: (properties, lngLat) => footprintMap.showHeatmapPopup(properties, lngLat)
    });
    footprintMap.init([105, 35], 3);
    footprintMapBox.append(footprintMapStatus);
  }

  async function requestCityConsent(trips) {
    if (hasCityConsent()) return true;
    const ok = await confirmModal({
      title: t('trips.footprintCityConsentTitle'),
      message: t('trips.footprintCityConsent'),
      confirmText: t('trips.footprintCityConsentConfirm')
    });
    if (!ok) return false;
    try { localStorage.setItem(CITY_CONSENT_KEY, 'yes'); } catch { /* consent lasts for this view */ }
    return true;
  }

  async function loadFootprintCities(year, activity, trips) {
    const key = footprintScopeKey(year, trips, activity);
    if (footprintJobs.has(key) || viewDestroyed) return;
    cancelFootprintJobs();
    const version = ++footprintVersion;
    const previous = footprintStates.get(key);
    const previousCities = previous?.key === key ? previous.cities || [] : [];
    if (!navigator.onLine) {
      footprintStates.set(key, { key, version, status: 'offline', cities: previousCities, progress: 0 });
      renderFootprint();
      return;
    }
    footprintStates.set(key, { key, version, status: 'loading', progress: 0, cities: previousCities });
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && footprintStates.get(key)?.version === version;
    const privacyRadius = currentPrivacyRadius();
    footprintAborts.set(key, controller);
    const job = (async () => {
      const entries = [];
      try {
        for (let i = 0; i < trips.length; i++) {
          if (controller.signal.aborted || viewDestroyed || !isCurrent()) return;
          const trip = trips[i];
          const track = await routeRepository.load(trip.id);
          if (!track || controller.signal.aborted || viewDestroyed || !isCurrent()) continue;
          const cities = await resolveTripCities(track, { radius: privacyRadius }, {
            signal: controller.signal,
            onProgress: (p) => {
              if (viewDestroyed || !isCurrent()) return;
              const state = footprintStates.get(key);
              if (state?.status === 'loading') state.progress = Math.round(((i + p) / trips.length) * 100);
              renderFootprint();
            }
          });
          if (controller.signal.aborted || viewDestroyed || !isCurrent()) return;
          if (cities.length) {
            const places = cities.map(({ name, countryCode, admin }) => ({ name, countryCode, admin }));
            if (JSON.stringify(places) !== JSON.stringify(track.trip.places || [])) {
              await updateTrip(trip.id, { places }, { touch: false });
              track.trip = { ...track.trip, places };
              Object.assign(trip, { places });
            }
          }
          entries.push({ trip: track.trip, cities });
          const citiesSoFar = aggregateCityFootprints(entries);
          const state = footprintStates.get(key);
          if (state?.status === 'loading') {
            state.cities = citiesSoFar;
            state.progress = Math.round(((i + 1) / trips.length) * 100);
          }
          renderFootprint();
        }
        if (controller.signal.aborted || viewDestroyed || !isCurrent()) return;
        footprintStates.set(key, {
          key, version, status: 'ready', progress: 100,
          cities: aggregateCityFootprints(entries)
        });
        void refreshFilterIndex();
      } catch (err) {
        if (controller.signal.aborted || viewDestroyed || !isCurrent()) return;
        console.warn('city footprint aggregation failed', err);
        const state = footprintStates.get(key);
        footprintStates.set(key, {
          key, version, status: 'error', progress: 0, cities: state?.cities || previousCities
        });
      } finally {
        if (footprintAborts.get(key) === controller) footprintAborts.delete(key);
        if (footprintJobs.get(key) === job) footprintJobs.delete(key);
        if (!viewDestroyed && isCurrent()) renderFootprint();
      }
    })();
    footprintJobs.set(key, job);
    renderFootprint();
    await job;
  }

  async function lightUpCities(year, activity, trips) {
    if (!await requestCityConsent(trips)) return;
    await loadFootprintCities(year, activity, trips);
  }

  function renderFootprintCities(year, activity, trips, cities) {
    ensureFootprintMap();
    const key = footprintScopeKey(year, trips, activity);
    const state = footprintStates.get(key);
    const mapKey = `${key}:cities:${cities.map((city) => `${cityFootprintKey(city)}:${city.lat}:${city.lon}:${city.trips}`).join('|')}`;
    if (footprintMap && mapKey !== footprintMapKey) {
      footprintMap.setCityMarkers(cities.map((city) => ({
        ...city,
        label: `${city.name} · ${t('trips.footprintCityTrips', { trips: city.trips })}`
      })));
      footprintMapKey = mapKey;
    }
    footprintMapStatus.classList.remove('warn');
    footprintMapStatus.style.display = state?.status === 'ready' && cities.length ? 'none' : '';
    footprintMapStatus.replaceChildren();
    if (state?.status === 'loading') {
      footprintMapStatus.append(t('trips.footprintCityLoading', { p: state.progress || 0 }));
      return;
    }
    if (state?.status === 'error' || state?.status === 'offline') {
      const message = state.status === 'offline' ? t('trips.footprintCityOffline') : t('trips.footprintCityFail');
      const retry = el('button', { class: 'btn sm', onclick: () => lightUpCities(year, activity, trips) }, t('common.retry'));
      footprintMapStatus.append(el('span', {}, message), retry);
      return;
    }
    if (state?.status === 'ready' && !cities.length) {
      const retry = el('button', { class: 'btn sm', onclick: () => lightUpCities(year, activity, trips) }, t('common.retry'));
      footprintMapStatus.append(el('span', {}, t('trips.footprintCityEmpty')), retry);
      return;
    }
    const load = el('button', {
      class: 'btn sm primary', onclick: () => lightUpCities(year, activity, trips)
    }, icon('pin', 14), t('trips.footprintCityLoad'));
    footprintMapStatus.append(el('span', {}, t('trips.footprintCityEmpty')), load);
  }

  function renderHistoryHeatmap(year, activity, trips) {
    ensureFootprintMap();
    const key = footprintScopeKey(year, trips, activity);
    const state = heatmapStates.get(key);
    const failedKey = (state?.failedTripIds || []).join(',');
    const dataKey = `${key}:${state?.status || 'empty'}:${state?.data?.features?.length || 0}:${state?.data?.stats?.sampledPoints || 0}:${state?.data?.stats?.maxWeight || 0}:${failedKey}`;
    if (footprintMap && dataKey !== footprintMapKey) {
      footprintMap.setCityMarkers([]);
      footprintMap.setOverlayTracks([]);
      footprintMap.setHeatmap(state?.data || null, true);
      footprintMapKey = dataKey;
    }
    footprintMapStatus.classList.toggle('warn', state?.status === 'partial');
    footprintMapStatus.style.display = '';
    footprintMapStatus.replaceChildren();
    if (state?.status === 'loading') {
      footprintMapStatus.append(t('trips.heatmapLoading', { p: state.progress || 0 }));
      return;
    }
    if (state?.status === 'error') {
      const retry = el('button', {
        class: 'btn sm',
        onclick: () => loadHistoryHeatmap(year, activity, trips, state.failedTripIds?.length ? state.failedTripIds : null)
      }, t('common.retry'));
      footprintMapStatus.append(el('span', {}, t('trips.heatmapError')), retry);
      return;
    }
    const stats = state?.data?.stats;
    const summary = stats ? el('div', { class: 'small faint' }, t('trips.heatmapStats', {
      trips: stats.tripCount, cells: stats.gridCells, cropped: stats.croppedPoints
    })) : null;
    if (state?.status === 'partial') {
      const failed = state.failedTripIds?.length || 0;
      const retry = el('button', { class: 'btn sm', onclick: () => loadHistoryHeatmap(year, activity, trips, state.failedTripIds) }, t('common.retry'));
      footprintMapStatus.append(summary,
        el('span', { role: 'alert' }, t('trips.heatmapPartial', { ok: trips.length - failed, fail: failed })), retry);
      return;
    }
    if (!state?.data?.features.length) {
      footprintMapStatus.append(el('span', {}, t('trips.heatmapEmpty')));
      return;
    }
    footprintMapStatus.append(summary);
  }

  function footprintSummary(year, selectedTrips = yearTrips(year)) {
    const trips = selectedTrips;
    if (year !== 'all') {
      return buildFootprints(trips, new Date(Number(year), 0, 1)).current;
    }
    const months = Array.from({ length: 12 }, (_, index) => ({ month: index + 1, trips: 0, distance: 0, ascent: 0, days: new Set() }));
    const days = new Set();
    const summary: any = { year: 'all', trips: trips.length, distance: 0, ascent: 0, duration: 0, days: 0, cities: [], months };
    for (const trip of trips) {
      const date = new Date(trip.createdAt);
      const day = date.toDateString();
      const distance = Number(trip.statsCache?.distance) || 0;
      const ascent = Number(trip.statsCache?.ascent) || 0;
      summary.distance += distance;
      summary.ascent += ascent;
      summary.duration += Number(trip.statsCache?.duration) || 0;
      days.add(day);
      const month = months[date.getMonth()];
      month.trips++;
      month.distance += distance;
      month.ascent += ascent;
      month.days.add(day);
    }
    summary.days = days.size;
    summary.months = months.map((month) => ({ ...month, days: month.days.size }));
    return summary;
  }

  function renderFootprint() {
    if (viewDestroyed || appState.tripDetail.open) { footprintCard.style.display = 'none'; return; }
    if (!allTrips.length) { footprintCard.style.display = 'none'; return; }
    const { years } = buildFootprints(allTrips);
    if (!years.length) { footprintCard.style.display = 'none'; return; }
    if (footprintYear !== 'all' && !years.some((year) => year.year === footprintYear)) footprintYear = years[0].year;
    const trips = yearTrips(footprintYear);
    const scopeKey = footprintScopeKey(footprintYear, trips, footprintActivity);
    if (renderedFootprintKey && renderedFootprintKey !== scopeKey) {
      cancelFootprintJobs();
      cancelHeatmapJobs();
    }
    renderedFootprintKey = scopeKey;
    const cityState = footprintStates.get(scopeKey);
    const cities = cityState?.key === scopeKey ? cityState.cities || [] : [];
    const fp = withFootprintCities({ ...footprintSummary(footprintYear, trips), activity: footprintActivity }, cities);
    const units = get('units');
    const d = fmtDistance(fp.distance, units);
    const ascent = fmtAltitude(fp.ascent, units);
    const yearLabel = footprintYear === 'all' ? t('trips.heatmapAllYears') : String(footprintYear);
    footprintToggle.replaceChildren(icon('calendar', 18),
      el('span', { class: 'footprint-toggle-copy' },
        el('strong', {}, `${yearLabel} · ${t('trips.footprintTitle')}`),
        el('span', {}, `${fp.trips} ${t('trips.sumTrips')} · ${d.v}${d.u}`)),
      icon(footprintExpanded ? 'chevron' : 'chevronRight', 16));
    footprintToggle.setAttribute('aria-expanded', String(footprintExpanded));
    footprintContent.hidden = !footprintExpanded;
    footprintContent.style.display = footprintExpanded ? '' : 'none';
    footprintCard.classList.toggle('expanded', footprintExpanded);
    footprintCard.style.display = '';
    if (!footprintExpanded) return;
    const yearSel = el('select', { class: 'footprint-year', 'aria-label': t('trips.footprintTitle') },
      el('option', { value: 'all' }, t('trips.heatmapAllYears')),
      ...years.map((year) => el('option', { value: String(year.year) }, String(year.year))));
    yearSel.value = String(footprintYear);
    yearSel.onchange = () => {
      footprintYear = yearSel.value === 'all' ? 'all' : Number(yearSel.value);
      if (footprintYear === 'all') footprintLayer = 'heatmap';
      renderFootprint();
    };
    const activitySel = el('select', { class: 'footprint-year', 'aria-label': t('trips.heatmapActivity') },
      ...ACTIVITIES.map((activity) => el('option', { value: activity }, activity === 'all' ? t('trips.filterAll') : t(`record.activities.${activity}`))));
    activitySel.value = footprintActivity;
    activitySel.onchange = () => { footprintActivity = activitySel.value; renderFootprint(); };
    const layerButtons = el('div', { class: 'footprint-layers', role: 'group', 'aria-label': t('trips.footprintCityMap') },
      el('button', { class: 'chip' + (footprintLayer === 'heatmap' ? ' active' : ''), onclick: () => { footprintLayer = 'heatmap'; renderFootprint(); } }, t('trips.heatmapCoverage')),
      el('button', { class: 'chip' + (footprintLayer === 'cities' ? ' active' : ''), onclick: () => { footprintLayer = 'cities'; renderFootprint(); } }, t('trips.footprintCityMap')));
    const max = Math.max(1, ...fp.months.map((month) => month.distance));
    const growthBtn = el('button', {
      class: 'btn sm', onclick: () => openGrowthReport(allTrips, {
        initialYear: footprintYear === 'all' ? years[0]?.year : footprintYear,
        onOpenTrip: (tripId) => {
          void setActiveTrip(tripId);
          navigate('trips', { detail: true, tripId, section: 'overview' });
        }
      })
    }, icon('analysis', 14), t('growth.openReport'));
    const shareButtons = footprintYear === 'all' ? [] : [
      el('button', { class: 'btn sm', onclick: async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.replaceChildren(icon('refresh', 14), t('common.loading'));
        try {
          if (scopeKey !== footprintScopeKey()) {
            toast(t('export.tripChanged'), 'warn');
            return;
          }
          const result = await generateFootprintImage(fp);
          if (scopeKey !== footprintScopeKey()) {
            toast(t('export.tripChanged'), 'warn');
            return;
          }
          openFootprintImagePreview(result, fp);
        } catch (error) {
          console.error(error);
          toast(t('trips.footprintImageFailed'), 'err');
        } finally {
          button.disabled = false;
          button.replaceChildren(icon('photo', 14), t('trips.footprintShareImage'));
        }
      } }, icon('photo', 14), t('trips.footprintShareImage'))
    ];
    if (videoSupported() && footprintYear !== 'all') {
      shareButtons.push(el('button', { class: 'btn sm', onclick: () => openFootprintVideoPreview(fp) }, icon('play', 14), t('trips.footprintShareVideo')));
    }
    footprintBody.innerHTML = '';
    footprintBody.append(
      el('div', { class: 'footprint-head' },
        el('div', { class: 'footprint-title' }, icon('calendar', 17), t('trips.footprintTitle')),
        el('div', { class: 'footprint-controls' }, activitySel, yearSel, growthBtn)),
      el('div', { class: 'footprint-map-head' },
        el('span', {}, footprintLayer === 'heatmap' ? t('trips.heatmapTitle') : t('trips.footprintCityMap')),
        footprintLayer === 'cities' && fp.cities.length ? el('span', { class: 'tag' }, t('trips.footprintCities', { n: fp.cities.length })) : null),
      layerButtons,
      el('p', { class: 'small faint footprint-map-note' }, footprintLayer === 'heatmap' ? t('trips.heatmapPrivacy') : t('trips.footprintPrivacy')),
      footprintMapBox,
      footprintLayer === 'cities' && fp.cities.length ? el('div', { class: 'footprint-city-list' },
        ...fp.cities.slice(0, 12).map((city) => el('span', {
          class: 'trip-tag', title: t('trips.footprintCityTrips', { trips: city.trips })
        }, `${city.name}${city.countryCode ? ` · ${city.countryCode}` : ''} · ${city.trips}`))) : [],
      el('div', { class: 'footprint-kpis' },
        el('div', { class: 'fp-kpi' }, el('div', { class: 'v' }, String(fp.trips)), el('div', { class: 'k' }, t('trips.sumTrips'))),
        el('div', { class: 'fp-kpi' }, el('div', { class: 'v', html: `${d.v}<small>${d.u}</small>` }), el('div', { class: 'k' }, t('analysis.distance'))),
        el('div', { class: 'fp-kpi' }, el('div', { class: 'v', html: `${ascent.v}<small>${ascent.u}</small>` }), el('div', { class: 'k' }, t('analysis.ascent'))),
        el('div', { class: 'fp-kpi' }, el('div', { class: 'v' }, String(fp.days)), el('div', { class: 'k' }, t('trips.sumDays')))),
      el('div', { class: 'footprint-bars' },
        ...fp.months.map((month) => {
          const monthDistance = fmtDistance(month.distance, units);
          return el('div', { class: 'fp-col', title: `${month.month} · ${month.trips} ${t('trips.sumTrips')} · ${monthDistance.v}${monthDistance.u}` },
            el('div', { class: 'bar-wrap' },
              el('div', { class: 'bar' + (month.month === new Date().getMonth() + 1 && fp.year === new Date().getFullYear() ? ' current' : ''), style: { height: `${Math.round((month.distance / max) * 100)}%` } })),
            el('span', { class: 'm' }, String(month.month)));
        })),
      shareButtons.length ? el('div', { class: 'footprint-actions' },
        ...shareButtons,
        el('div', { class: 'fp-share-note small faint' }, icon('shield', 12), t('trips.footprintShareHint'))) : null);
    if (footprintLayer === 'heatmap') {
      renderHistoryHeatmap(footprintYear, footprintActivity, trips);
      const heatState = heatmapStates.get(scopeKey);
      if (!heatmapJobs.has(scopeKey) && (!heatState || heatState.status === 'loading')) {
        void loadHistoryHeatmap(footprintYear, footprintActivity, trips);
      }
    } else {
      renderFootprintCities(footprintYear, footprintActivity, trips, cities);
      if (hasCityConsent() && !footprintJobs.has(scopeKey)
        && (!cityState || cityState.key !== scopeKey || cityState.status === 'loading')) {
        if (navigator.onLine) void loadFootprintCities(footprintYear, footprintActivity, trips);
        else {
          footprintStates.set(scopeKey, {
            key: scopeKey, version: ++footprintVersion, status: 'offline', cities, progress: 0
          });
          renderFootprintCities(footprintYear, footprintActivity, trips, cities);
        }
      }
    }
  }

  async function render() {
    allTrips = await listTrips();
    if (viewDestroyed) return;
    renderSummary();
    renderNudge();
    renderIosNudge();
    renderFootprint();
    filterIndexes = [];
    renderList();
    void refreshFilterIndex();
    detailTrip = appState.tripDetail.open
      ? appState.activeTripFull?.trip || allTrips.find((trip) => trip.id === appState.tripDetail.tripId) || null
      : null;
    syncDetail();
    if (!allTrips.length) { storageBar.textContent = ''; return; }
    storageBar.style.color = '';
    const est = await storageEstimate();
    if (est.quota) {
      const pct = (est.usage / est.quota) * 100;
      storageBar.textContent = `${t('trips.storage')}: ${(est.usage / 1048576).toFixed(1)} MB / ${(est.quota / 1048576).toFixed(0)} MB (${pct.toFixed(1)}%)`;
      if (pct > 80) {
        storageBar.style.color = 'var(--warn)';
        storageBar.textContent += ' ⚠ ' + t('trips.storageWarn');
      }
    }
  }

  function openMoreSheet() {
    let m;
    const close = (fn) => { m.close(); fn(); };
    const row = (iconKey, title, desc, onclick) => el('button', { class: 'sheet-row', onclick },
      el('span', { class: 's-ic' }, icon(iconKey, 18)),
      el('span', { class: 's-txt' }, el('div', { class: 's-t' }, title), desc ? el('div', { class: 's-d' }, desc) : null));
    m = modal({
      title: t('trips.more'),
      body: el('div', { class: 'sheet-list' },
        row('layers', t('mapTools.title'), t('mapTools.trackOverlayHint'), () => close(() => openMapTools(allTrips))),
        row('download', t('trips.batchExport'), t('trips.batchExportHint'), () => close(onBatchExport)))
    });
  }

  function activeDetailPanel() {
    if (appState.tripDetail.section === 'share') return exportView;
    if (appState.tripDetail.section === 'story') return storyView;
    return analysisView;
  }

  function refreshDetailPanel() {
    if (!appState.tripDetail.open || appState.view !== 'trips') return;
    requestAnimationFrame(() => {
      activeDetailPanel().resize?.();
      activeDetailPanel().refresh?.();
    });
  }

  function setDetailSection(section) {
    if (!appState.tripDetail.open) return;
    appState.tripDetail.section = section;
    detail.dataset.section = section;
    analysisView.view.classList.toggle('active', section !== 'share' && section !== 'story');
    storyView.view.classList.toggle('active', section === 'story');
    exportView.view.classList.toggle('active', section === 'share');
    detailTabs.querySelectorAll('button').forEach((button) => {
      const selected = button.dataset.section === section;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
    });
    refreshDetailPanel();
  }

  function syncDetail() {
    const open = appState.tripDetail.open && !!detailTrip;
    detail.classList.toggle('active', open);
    scroll.style.display = open ? 'none' : '';
    if (!open) return;
    detailTitle.textContent = detailTrip.name || t('record.newTripName');
    detailDate.textContent = `${new Date(detailTrip.createdAt).toLocaleDateString()} · ${t(`record.activities.${detailTrip.activity}`)}`;
    detailSelect.replaceChildren(...allTrips.map((trip) => el('option', { value: trip.id }, trip.name || t('record.newTripName'))));
    detailSelect.value = detailTrip.id;
    detailActions.replaceChildren(
      el('button', { class: 'btn sm', onclick: () => onRewalk(detailTrip) }, icon('follow', 14), t('trips.rewalk')),
      el('button', { class: 'btn sm', onclick: () => openOnMap(detailTrip) }, icon('map', 14), t('trips.viewOnMap')),
      el('button', { class: 'btn sm icon-only', title: t('common.edit'), 'aria-label': t('common.edit'), onclick: () => editTrip(detailTrip) }, icon('edit', 15)),
      el('button', { class: 'btn sm icon-only danger', title: t('common.delete'), 'aria-label': t('common.delete'), onclick: () => removeTrip(detailTrip) }, icon('trash', 15)));
    setDetailSection(appState.tripDetail.section);
  }

  function closeDetail(options: { history?: boolean } = {}) {
    const state = currentUIState();
    if (options.history !== false && state?.type === 'view' && state.view === 'trips' && state.detail) {
      if (state.previous?.type === 'view' && state.previous.view === 'trips' && !state.previous.detail) {
        backFromUIState(state.id);
      } else {
        navigate('trips', { detail: false });
      }
    }
    appState.tripDetail = { open: false, tripId: null, section: 'overview' };
    detailTrip = null;
    syncDetail();
    renderFootprint();
  }

  async function openTrip(trip, section = 'overview') {
    const full = await setActiveTrip(trip.id);
    if (!full) return;
    detailTrip = full.trip;
    appState.tripDetail = { open: true, tripId: full.trip.id, section };
    syncDetail();
    navigate('trips', { detail: true, tripId: full.trip.id, section });
  }

  async function openOnMap(trip) {
    const full = await setActiveTrip(trip.id, { fit: true });
    if (!full || appState.activeTripId !== trip.id) return;
    navigate('record', { tripId: trip.id, fit: true });
  }

  async function toggleFavorite(trip) {
    await updateTrip(trip.id, { favorite: !trip.favorite });
    render();
  }
  function parseTags(value) {
    return [...new Set(String(value || '').split(/[,，;；]+/)
      .map((tag) => tag.trim().replace(/^#+/, '').slice(0, 16))
      .filter(Boolean))].slice(0, 8);
  }
  function editTrip(trip) {
    const activities = ['hike', 'drive', 'bike', 'run', 'travel'];
    const nameInput = el('input', { type: 'text', value: trip.name || '', maxlength: '60' });
    const tagsInput = el('input', {
      type: 'text', value: (trip.tags || []).join('，'),
      placeholder: t('trips.tagsPlaceholder')
    });
    const activityInput = el('select', { 'aria-label': t('record.activityLabel') },
      ...activities.map((activity) => el('option', { value: activity }, t(`record.activities.${activity}`))));
    activityInput.value = activities.includes(trip.activity) ? trip.activity : 'hike';
    const error = el('div', { class: 'hint', role: 'alert', style: { color: 'var(--danger)', display: 'none' } });
    let saving = false;
    let persisted = false;
    let persistedActivity = trip.activity;
    const save = async () => {
      if (saving) return;
      saving = true;
      saveButton.disabled = true;
      for (const input of [nameInput, tagsInput, activityInput]) input.disabled = true;
      error.style.display = 'none';
      const patch = { name: nameInput.value.trim(), tags: parseTags(tagsInput.value), activity: activityInput.value };
      const activityChanged = patch.activity !== persistedActivity;
      try {
        await updateTrip(trip.id, patch);
        persisted = true;
        persistedActivity = patch.activity;
        // Recalculate only for a genuine activity change. Name/tag-only saves
        // keep the existing cache and reported distance intact.
        if (!await refreshActiveTrip(trip.id, { recalc: false, metadataOnly: true })) throw new Error(t('common.unavailable'));
        if (activityChanged) {
          if (!await recalcNow()) throw new Error(t('common.unavailable'));
          // Publish the recalculated cache/version to analysis and export.
          if (!await refreshActiveTrip(trip.id, { recalc: false, metadataOnly: true })) throw new Error(t('common.unavailable'));
        }
        await render();
        refreshDetailPanel();
        m.close();
        toast(t('trips.renamed'), 'ok');
      } catch (e) {
        console.error('trip edit failed', e);
        if (persisted) {
          // The edit is durable even if recalculation or snapshot refresh failed.
          // Show that state immediately and leave the editor open for retry.
          try {
            await refreshActiveTrip(trip.id, { recalc: false, metadataOnly: true });
            await render();
            refreshDetailPanel();
          } catch (refreshError) { console.error('trip snapshot refresh failed', refreshError); }
        }
        error.textContent = persisted
          ? `${t('trips.renamed')} · ${String(e?.message || e)}`
          : t('record.resultNameFail');
        error.style.display = '';
        toast(error.textContent, 'err', 4200);
      } finally {
        saving = false;
        saveButton.disabled = false;
        for (const input of [nameInput, tagsInput, activityInput]) input.disabled = false;
      }
    };
    const saveButton = el('button', { class: 'btn primary', onclick: save }, t('common.save'));
    const m = modal({
      title: t('trips.editTitle'),
      body: el('div', {},
        el('div', { class: 'field' }, el('label', {}, t('wp.name')), nameInput),
        el('div', { class: 'field', style: { marginTop: '12px' } },
          el('label', {}, t('record.activityLabel')), activityInput),
        el('div', { class: 'field', style: { marginTop: '12px' } },
          el('label', {}, t('trips.tagsLabel')), tagsInput,
          el('div', { class: 'hint' }, t('trips.tagsHint'))),
        error),
      footer: [
        el('button', { class: 'btn ghost', onclick: () => m.close() }, t('common.cancel')),
        saveButton
      ]
    });
    for (const input of [nameInput, tagsInput]) {
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void save(); });
    }
    setTimeout(() => { nameInput.focus(); nameInput.select(); }, 60);
  }
  async function removeTrip(trip) {
    const ok = await confirmModal({ title: t('common.delete'), message: t('trips.deleteConfirm'), danger: true, confirmText: t('common.delete') });
    if (!ok) return;
    await deleteTrip(trip.id);
    if (appState.activeTripId === trip.id) await setActiveTrip(null);
    if (detailTrip?.id === trip.id) closeDetail();
    toast(t('trips.deleted'), 'ok');
    render();
  }

  let loadingDemo = false;
  async function onLoadDemo() {
    if (loadingDemo) return;
    loadingDemo = true;
    try {
      const trip = await importDemoTrip();
      await openTrip(trip, 'overview');
      toast(t('demo.loaded'), 'ok');
    } catch (e) {
      console.error(e);
      toast(t('trips.importErr'), 'err');
    } finally {
      loadingDemo = false;
    }
  }

  async function onImport() {
    const files = await filePickerMulti('.gpx,.xml,.zip,application/gpx+xml,application/xml,application/zip');
    if (!files.length) return;
    try {
      const before = new Set(allTrips.map((trip) => trip.id));
      const { ok, fail } = await importTripFiles(files);
      if (ok) toast(fail ? t('trips.batchImportPartial', { ok, fail }) : t('trips.batchImportOk', { ok }), fail ? 'warn' : 'ok');
      else toast(t('trips.importErr'), 'err');
      const trips = await listTrips();
      const imported = trips.find((trip) => !before.has(trip.id));
      if (imported) await openTrip(imported, 'overview');
      else await render();
    } catch (e) {
      console.error(e);
      toast(t('trips.importErr'), 'err');
    }
  }

  function onRewalk(trip) {
    let m;
    const modes = [
      ['full-fwd', 'routeFwd', 'modeFullFwd', 'modeFullFwdHint'],
      ['full-rev', 'routeRev', 'modeFullRev', 'modeFullRevHint'],
      ['near-end', 'flag', 'modeToEnd', 'modeToEndHint'],
      ['near-start', 'pin', 'modeToStart', 'modeToStartHint']
    ];
    m = modal({
      title: t('rewalk.modeTitle'),
      body: el('div', {},
        el('div', { class: 'small faint', style: { margin: '0 2px 10px' } }, t('rewalk.hint')),
        el('div', { class: 'sheet-list' },
          ...modes.map(([mode, ic, label, hint]) => el('button', {
            class: 'sheet-row',
            onclick: async () => { m.close(); await onRewalkStart(trip, mode); }
          },
          el('span', { class: 's-ic' }, icon(ic, 18)),
          el('span', { class: 's-txt' }, el('div', { class: 's-t' }, t(`rewalk.${label}`)), el('div', { class: 's-d' }, t(`rewalk.${hint}`)))))
      ))
    });
  }
  async function onRewalkStart(trip, mode) {
    const res = await startRewalk(trip.id, mode);
    if (res === 'busy') { toast(t('rewalk.busy'), 'warn'); return; }
    if (res === 'empty') { toast(t('rewalk.empty'), 'warn'); return; }
    if (res !== true) return;
    navigate('record');
  }

  async function onBatchExport() {
    const trips = await listTrips();
    if (!trips.length) { toast(t('trips.empty'), 'info'); return; }
    const checks = new Map();
    const listBox = el('div', { style: { maxHeight: '46vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' } });
    const units = get('units');
    for (const tr of trips) {
      const cb = el('input', { type: 'checkbox', checked: true });
      checks.set(tr.id, cb);
      const d = tr.statsCache ? fmtDistance(tr.statsCache.distance, units) : null;
      listBox.append(el('label', { class: 'setting-row', style: { cursor: 'pointer', margin: 0 } },
        cb,
        el('div', { class: 'txt' },
          el('div', { class: 't' }, tr.name || t('record.newTripName')),
          el('div', { class: 'd' }, `${new Date(tr.createdAt).toLocaleDateString()}${d ? ` · ${d.v}${d.u}` : ''}`))));
    }
    const fmtSel = el('select', {}, el('option', { value: 'gpx' }, 'GPX'), el('option', { value: 'geojson' }, 'GeoJSON'));
    const m = modal({
      title: t('trips.batchExportTitle'),
      body: el('div', {},
        el('p', { class: 'muted small', style: { margin: '0 0 8px' } }, t('trips.batchExportHint')),
        listBox,
        el('div', { class: 'row', style: { gap: '8px', marginTop: '10px', alignItems: 'center' } },
          el('span', { class: 'small muted' }, t('trips.format')), fmtSel)),
      footer: [
        el('button', { class: 'btn ghost', onclick: () => checks.forEach((c) => { c.checked = true; }) }, t('trips.selectAll')),
        el('button', { class: 'btn ghost', onclick: () => checks.forEach((c) => { c.checked = false; }) }, t('trips.selectNone')),
        el('button', {
          class: 'btn primary', onclick: async () => {
            const ids = [...checks].filter(([, c]) => c.checked).map(([id]) => id);
            if (!ids.length) { toast(t('trips.batchNone'), 'warn'); return; }
            const { blob, filename, count } = await exportTripsZip(ids, fmtSel.value);
            m.close();
            if (isWeChat()) { wechatFileGuidance(); return; }
            triggerDownload(blob, filename);
            toast(t('trips.batchExportOk', { n: count }), 'ok');
          }
        }, t('trips.exportZip'))
      ]
    });
  }

  on('trip:active', (full) => {
    if (appState.tripDetail.open && full?.trip.id === appState.tripDetail.tripId) {
      detailTrip = full.trip;
      syncDetail();
    }
  });

  on('trip:stats', async (stats) => {
    const full = appState.activeTripFull;
    if (full && stats) {
      const points = thumbnailPoints(full.segments);
      await updateTrip(full.trip.id, { thumbPoints: points }, { touch: false });
      const current = allTrips.find((trip) => trip.id === full.trip.id);
      if (current) current.thumbPoints = points;
      const thumb = thumbNodes.get(full.trip.id);
      if (thumb) thumb.innerHTML = thumbSVG(points);
      if (current) void hydrateThumbnails([current]);
    }
  });
  on('theme:applied', renderList);
  on('backup:restored', render);
  on('sync:completed', render);
  on('backup:exported', renderNudge);
  on('recorder:stopped', render);

  const onTripsOnline = () => {
    if (viewDestroyed) return;
    renderList();
    const trips = yearTrips(footprintYear);
    const key = footprintScopeKey(footprintYear, trips, footprintActivity);
    const state = footprintStates.get(key);
    if (!hasCityConsent() || footprintJobs.has(key)) return;
    if (state?.status === 'offline' || state?.status === 'error') {
      void loadFootprintCities(footprintYear, footprintActivity, trips);
    }
    const heatState = heatmapStates.get(key);
    if (footprintLayer === 'heatmap' && heatState?.status === 'error' && !heatmapJobs.has(key)) {
      void loadHistoryHeatmap(footprintYear, footprintActivity, trips, heatState.failedTripIds?.length ? heatState.failedTripIds : null);
    }
  };
  window.addEventListener('online', onTripsOnline);

  return {
    view,
    refresh: render,
    closeDetail,
    setSection: (section) => setDetailSection(section),
    resize: () => {
      if (appState.tripDetail.open) activeDetailPanel().resize?.();
      else footprintMap?.resize();
    },
    focus: async (intent) => {
      if (!intent?.detail && !intent?.tripId) return;
      let trip = null;
      if (intent.tripId) {
        if (!allTrips.length) allTrips = await listTrips();
        trip = allTrips.find((item) => item.id === intent.tripId) || null;
        if (!trip) {
          toast(t('trips.openNotFound'), 'err');
          return;
        }
      } else {
        trip = appState.activeTripFull?.trip || allTrips[0] || null;
      }
      if (trip) await openTrip(trip, intent.section || 'overview');
    },
    destroy: () => {
      viewDestroyed = true;
      analysisView.destroy();
      storyView.destroy();
      exportView.destroy();
      window.removeEventListener('online', onTripsOnline);
      cancelFootprintJobs();
      cancelHeatmapJobs();
      filterIndexController?.abort();
      footprintAborts.clear();
      heatmapAborts.clear();
      footprintJobs.clear();
      heatmapJobs.clear();
      footprintMap?.destroy();
      footprintMap = null;
    }
  };
}