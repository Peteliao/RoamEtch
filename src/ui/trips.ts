// Trips list: open/edit/analyze, GPX import, full backup/restore, storage monitor.
import { t } from '../core/i18n';
import { on } from '../core/events';
import { listTrips, deleteTrip, updateTrip, loadTripFull, storageEstimate } from '../core/store';
import { exportTripsZip, importTripFiles } from '../core/batch';
import { startRewalk } from '../core/rewalk';
import { importDemoTrip } from '../core/demo';
import { aggregateCityFootprints, buildFootprints, withFootprintCities } from '../core/footprint';
import { generateFootprintImage, generateFootprintVideo, footprintCaption } from '../core/footprintShare';
import { resolveTripCities } from '../core/shareInfo';
import { paintTrack, prepareMap } from '../core/mapPaint';
import { videoSupported, videoIsWebmOnly } from '../core/videoCapture';
import { exportBackupFlow, lastBackupLabel, backupDue } from './backupFlow';
import { openInstallGuide, isIOS, isStandaloneMode } from './install';
import { triggerDownload } from '../core/gpx';
import { fmtDistance, fmtDuration, simplify } from '../core/geo';
import { migrateLegacyKey } from '../core/storageKeys';
import { get } from '../core/settings';
import { exportImage, exportFile, isWeChat, wechatFileGuidance } from '../core/shareEnv';
import { appState, setActiveTrip } from './state';
import { TrackMap } from './map';
import { el, icon, toast, confirmModal, filePickerMulti, modal } from './helpers';
import { createAnalysisView } from './analysis';
import { createExportView } from './export';
import { backFromUIState, currentUIState } from './history';

function thumbnailPoints(segments) {
  const points = segments.flatMap((segment) => segment.points);
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
  const exportView = createExportView(getRecordMap, navigate);
  for (const panel of [analysisView, exportView]) {
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
    el('div', { class: 'trip-detail-panels' }, analysisView.view, exportView.view));
  for (const section of ['overview', 'data', 'share']) {
    detailTabs.append(el('button', {
      role: 'tab', 'data-section': section, 'aria-controls': section === 'share' ? 'view-export' : 'view-analysis',
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
  searchInput.oninput = () => { searchTerm = searchInput.value.trim().toLowerCase(); renderList(); };
  const searchBar = el('div', { class: 'search-bar' }, icon('search', 18), searchInput);

  const ACTIVITIES = ['all', 'hike', 'drive', 'bike', 'run', 'travel'];
  let activityFilter = 'all';
  let favoriteOnly = false;
  let searchTerm = '';
  let sortMode = 'recent';
  let allTrips = [];
  let detailTrip = null;
  let footprintYear = new Date().getFullYear();
  let footprintExpanded = false;
  const thumbNodes = new Map();
  let thumbRun = 0;
  const chipBar = el('div', { class: 'chip-bar' });
  const chipButtons = new Map();
  for (const a of ACTIVITIES) {
    const label = a === 'all' ? t('trips.filterAll') : t(`record.activities.${a}`);
    const b = el('button', { class: 'chip' + (a === 'all' ? ' active' : ''), onclick: () => {
      activityFilter = a;
      for (const [key, btn] of chipButtons) btn.classList.toggle('active', key === a);
      renderList();
    } }, label);
    chipButtons.set(a, b);
    chipBar.append(b);
  }
  const favoriteChip = el('button', {
    class: 'chip chip-fav', title: t('trips.favoriteHint'),
    onclick: () => {
      favoriteOnly = !favoriteOnly;
      favoriteChip.classList.toggle('active', favoriteOnly);
      renderList();
    }
  }, icon('star', 13), t('trips.favorite'));
  chipBar.append(favoriteChip);
  const sortSel = el('select', { class: 'trip-sort', 'aria-label': t('trips.sort') },
    el('option', { value: 'recent' }, t('trips.sortRecent')),
    el('option', { value: 'created' }, t('trips.sortCreated')),
    el('option', { value: 'distance' }, t('trips.sortDistance')),
    el('option', { value: 'name' }, t('trips.sortName')));
  sortSel.value = sortMode;
  sortSel.onchange = () => { sortMode = sortSel.value; renderList(); };
  const toolbar = el('div', { class: 'trips-toolbar' }, chipBar, sortSel);

  const CITY_CONSENT_KEY = 'roametch.cityFootprintConsent.v1';
  const footprintStates = new Map();
  const footprintJobs = new Map();
  const footprintAborts = new Map();
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
          const full = await loadTripFull(trip.id);
          points = full ? thumbnailPoints(full.segments) : [];
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

  function renderList() {
    const units = get('units');
    thumbRun++;
    thumbNodes.clear();
    listBox.innerHTML = '';
    if (!allTrips.length) {
      listBox.append(el('div', { class: 'empty-state' },
        el('div', { class: 'empty-ic' }, icon('mountain', 28)),
        el('div', { class: 'empty-title' }, t('trips.empty')),
        el('div', { class: 'small' }, t('trips.emptyHint')),
        el('button', { class: 'btn sm primary', style: { marginTop: '14px' }, onclick: () => navigate('record') }, icon('record', 14), t('trips.goRecord')),
        el('button', { class: 'btn sm', style: { marginTop: '8px' }, onclick: onLoadDemo }, icon('analysis', 14), t('demo.load')),
        el('div', { class: 'small faint', style: { marginTop: '8px' } }, t('demo.hint'))));
      return;
    }
    const trips = allTrips.filter((tr) => {
      if (activityFilter !== 'all' && tr.activity !== activityFilter) return false;
      if (favoriteOnly && !tr.favorite) return false;
      if (!searchTerm) return true;
      const haystack = [tr.name || t('record.newTripName'), ...(tr.tags || [])].join(' ').toLowerCase();
      return haystack.includes(searchTerm);
    });
    trips.sort((a, b) => {
      if (sortMode === 'recent') {
        return (Number(b.favorite) - Number(a.favorite)) || (b.updatedAt - a.updatedAt);
      }
      if (sortMode === 'created') return b.createdAt - a.createdAt;
      if (sortMode === 'distance') return (b.statsCache?.distance || 0) - (a.statsCache?.distance || 0);
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    if (!trips.length) {
      listBox.append(el('div', { class: 'empty-state' },
        el('div', { class: 'empty-title' }, t('trips.noMatch')),
        el('div', { class: 'small' }, t('trips.noMatchHint')),
        el('button', {
          class: 'btn sm', style: { marginTop: '12px' }, onclick: () => {
            searchTerm = ''; activityFilter = 'all'; favoriteOnly = false; searchInput.value = '';
            for (const [key, btn] of chipButtons) btn.classList.toggle('active', key === 'all');
            favoriteChip.classList.remove('active'); renderList();
          }
        }, t('trips.clearFilters'))));
      return;
    }
    for (const trip of trips) {
      const st = trip.statsCache;
      const d = st ? fmtDistance(st.distance, units) : null;
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
          el('div', { class: 'ti-stat' }, el('div', { class: 'v' }, st ? `↑${Math.round(st.ascent)}m` : '--'), el('div', { class: 'k' }, t('analysis.ascent'))))
      );
      listBox.append(item);
    }
    void hydrateThumbnails(trips);
  }

  function renderSummary() {
    const units = get('units');
    const totalDist = allTrips.reduce((a, tr) => a + (tr.statsCache?.distance || 0), 0);
    const d = fmtDistance(totalDist, units);
    const days = new Set(allTrips.map((tr) => new Date(tr.createdAt).toDateString())).size;
    sTrips.v.textContent = String(allTrips.length);
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

  function yearTrips(year) {
    return allTrips.filter((trip) => trip.status !== 'recording' && trip.status !== 'paused'
      && new Date(trip.createdAt).getFullYear() === year);
  }

  function ensureFootprintMap() {
    if (footprintMap || viewDestroyed) return;
    footprintMap = new TrackMap(footprintMapBox);
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

  async function loadFootprintCities(year, trips) {
    if (footprintJobs.has(year) || viewDestroyed) return;
    if (!navigator.onLine) {
      footprintStates.set(year, { ...(footprintStates.get(year) || {}), status: 'offline', ids: trips.map((tr) => tr.id).sort().join(',') });
      renderFootprint();
      return;
    }
    const previous = footprintStates.get(year);
    footprintStates.set(year, {
      status: 'loading', progress: 0, cities: previous?.cities || [],
      ids: trips.map((tr) => tr.id).sort().join(',')
    });
    renderFootprint();
    const controller = new AbortController();
    footprintAborts.set(year, controller);
    const job = (async () => {
      const entries = [];
      try {
        for (let i = 0; i < trips.length; i++) {
          if (controller.signal.aborted || viewDestroyed) return;
          const trip = trips[i];
          const full = await loadTripFull(trip.id);
          if (!full || controller.signal.aborted || viewDestroyed) continue;
          const cities = await resolveTripCities(full, { radius: get('privacyRadius') }, {
            signal: controller.signal,
            onProgress: (p) => {
              if (viewDestroyed || controller.signal.aborted) return;
              const state = footprintStates.get(year);
              if (state?.status === 'loading') state.progress = Math.round(((i + p) / trips.length) * 100);
              renderFootprint();
            }
          });
          entries.push({ trip: full.trip, cities });
          const citiesSoFar = aggregateCityFootprints(entries);
          const state = footprintStates.get(year);
          if (state?.status === 'loading') {
            state.cities = citiesSoFar;
            state.progress = Math.round(((i + 1) / trips.length) * 100);
          }
          renderFootprint();
        }
        if (controller.signal.aborted || viewDestroyed) return;
        footprintStates.set(year, {
          status: 'ready', cities: aggregateCityFootprints(entries),
          ids: trips.map((tr) => tr.id).sort().join(',')
        });
      } catch (err) {
        if (err?.name !== 'AbortError' && !viewDestroyed) {
          footprintStates.set(year, { status: 'error', cities: previous?.cities || [], progress: 0 });
        }
      } finally {
        footprintAborts.delete(year);
        footprintJobs.delete(year);
        if (!viewDestroyed) renderFootprint();
      }
    })();
    footprintJobs.set(year, job);
    await job;
  }

  async function lightUpCities(year, trips) {
    if (!await requestCityConsent(trips)) return;
    await loadFootprintCities(year, trips);
  }

  function renderFootprintCities(year, trips, cities) {
    ensureFootprintMap();
    const state = footprintStates.get(year);
    const key = `${year}:${cities.map((city) => `${city.name}:${city.lat}:${city.lon}:${city.trips}`).join('|')}`;
    if (footprintMap && key !== footprintMapKey) {
      footprintMap.setCityMarkers(cities.map((city) => ({
        ...city,
        label: `${city.name} · ${t('trips.footprintCityTrips', { trips: city.trips })}`
      })));
      footprintMapKey = key;
    }
    footprintMapStatus.style.display = state?.status === 'ready' && cities.length ? 'none' : '';
    footprintMapStatus.replaceChildren();
    if (state?.status === 'loading') {
      footprintMapStatus.append(t('trips.footprintCityLoading', { p: state.progress || 0 }));
      return;
    }
    if (state?.status === 'error' || state?.status === 'offline') {
      const message = state.status === 'offline' ? t('trips.footprintCityOffline') : t('trips.footprintCityFail');
      const retry = el('button', { class: 'btn sm', onclick: () => lightUpCities(year, trips) }, t('common.retry'));
      footprintMapStatus.append(el('span', {}, message), retry);
      return;
    }
    if (state?.status === 'ready' && !cities.length) {
      const retry = el('button', { class: 'btn sm', onclick: () => lightUpCities(year, trips) }, t('common.retry'));
      footprintMapStatus.append(el('span', {}, t('trips.footprintCityEmpty')), retry);
      return;
    }
    const load = el('button', {
      class: 'btn sm primary', onclick: () => lightUpCities(year, trips)
    }, icon('pin', 14), t('trips.footprintCityLoad'));
    footprintMapStatus.append(el('span', {}, t('trips.footprintCityEmpty')), load);
  }

  function renderFootprint() {
    if (viewDestroyed || appState.tripDetail.open) { footprintCard.style.display = 'none'; return; }
    if (!allTrips.length) { footprintCard.style.display = 'none'; return; }
    const { years } = buildFootprints(allTrips);
    if (!years.length) { footprintCard.style.display = 'none'; return; }
    if (!years.some((y) => y.year === footprintYear)) footprintYear = years[0].year;
    const baseFp = years.find((y) => y.year === footprintYear) || years[0];
    const units = get('units');
    const baseDistance = fmtDistance(baseFp.distance, units);
    footprintToggle.replaceChildren(icon('calendar', 18),
      el('span', { class: 'footprint-toggle-copy' },
        el('strong', {}, `${baseFp.year} · ${t('trips.footprintTitle')}`),
        el('span', {}, `${baseFp.trips} ${t('trips.sumTrips')} · ${baseDistance.v}${baseDistance.u}`)),
      icon(footprintExpanded ? 'chevron' : 'chevronRight', 16));
    footprintToggle.setAttribute('aria-expanded', String(footprintExpanded));
    footprintContent.hidden = !footprintExpanded;
    footprintContent.style.display = footprintExpanded ? '' : 'none';
    footprintCard.classList.toggle('expanded', footprintExpanded);
    footprintCard.style.display = '';
    if (!footprintExpanded) return;
    const trips = yearTrips(baseFp.year);
    const cityState = footprintStates.get(baseFp.year);
    const fp = withFootprintCities(baseFp, cityState?.cities || []);
    const d = fmtDistance(fp.distance, units);
    const yearSel = el('select', { class: 'footprint-year', 'aria-label': t('trips.footprintTitle') },
      ...years.map((y) => el('option', { value: String(y.year) }, String(y.year))));
    yearSel.value = String(fp.year);
    yearSel.onchange = () => { footprintYear = Number(yearSel.value); renderFootprint(); };
    const max = Math.max(1, ...fp.months.map((m) => m.distance));
    const imageBtn = el('button', { class: 'btn sm' }, icon('photo', 14), t('trips.footprintShareImage'));
    imageBtn.onclick = async () => {
      imageBtn.disabled = true;
      imageBtn.replaceChildren(icon('refresh', 14), t('common.loading'));
      try {
        const result = await generateFootprintImage(fp);
        openFootprintImagePreview(result, fp);
      } catch (err) {
        console.error(err);
        toast(t('trips.footprintImageFailed'), 'err');
      } finally {
        imageBtn.disabled = false;
        imageBtn.replaceChildren(icon('photo', 14), t('trips.footprintShareImage'));
      }
    };
    const videoOk = videoSupported();
    const videoBtn = el('button', {
      class: 'btn sm', disabled: !videoOk,
      title: videoOk ? '' : t('export.videoUnsupported')
    }, icon('play', 14), t('trips.footprintShareVideo'));
    if (videoOk) videoBtn.onclick = () => openFootprintVideoPreview(fp);
    footprintBody.innerHTML = '';
    footprintBody.append(
      el('div', { class: 'footprint-head' },
        el('div', { class: 'footprint-title' }, icon('calendar', 17), t('trips.footprintTitle')),
        yearSel),
      el('div', { class: 'footprint-kpis' },
        el('div', { class: 'fp-kpi' }, el('div', { class: 'v' }, String(fp.trips)), el('div', { class: 'k' }, t('trips.sumTrips'))),
        el('div', { class: 'fp-kpi' }, el('div', { class: 'v', html: `${d.v}<small>${d.u}</small>` }), el('div', { class: 'k' }, t('analysis.distance'))),
        el('div', { class: 'fp-kpi' }, el('div', { class: 'v', html: `${Math.round(fp.ascent)}<small>m</small>` }), el('div', { class: 'k' }, t('analysis.ascent'))),
        el('div', { class: 'fp-kpi' }, el('div', { class: 'v' }, String(fp.days)), el('div', { class: 'k' }, t('trips.sumDays')))),
      el('div', { class: 'footprint-city-head' },
        el('span', {}, t('trips.footprintCityMap')),
        fp.cities.length ? el('span', { class: 'tag' }, t('trips.footprintCities', { n: fp.cities.length })) : null),
      footprintMapBox,
      fp.cities.length ? el('div', { class: 'footprint-city-list' },
        ...fp.cities.slice(0, 12).map((city) => el('span', {
          class: 'trip-tag', title: t('trips.footprintCityTrips', { trips: city.trips })
        }, `${city.name} · ${city.trips}`))) : [],
      el('div', { class: 'footprint-bars' },
        ...fp.months.map((m) => {
          const md = fmtDistance(m.distance, units);
          return el('div', { class: 'fp-col', title: `${m.month} · ${m.trips} ${t('trips.sumTrips')} · ${md.v}${md.u}` },
            el('div', { class: 'bar-wrap' },
              el('div', { class: 'bar' + (m.month === new Date().getMonth() + 1 && fp.year === new Date().getFullYear() ? ' current' : ''), style: { height: `${Math.round((m.distance / max) * 100)}%` } })),
            el('span', { class: 'm' }, String(m.month)));
        })),
      el('div', { class: 'footprint-actions' },
        imageBtn, videoBtn,
        el('div', { class: 'fp-share-note small faint' }, icon('shield', 12), t('trips.footprintShareHint'))));
    footprintCard.style.display = '';
    renderFootprintCities(fp.year, trips, fp.cities);
    const ids = trips.map((trip) => trip.id).sort().join(',');
    if (hasCityConsent() && !footprintJobs.has(fp.year)
      && (!cityState || (cityState.ids && cityState.ids !== ids))) {
      if (navigator.onLine) void loadFootprintCities(fp.year, trips);
      else {
        footprintStates.set(fp.year, { status: 'offline', cities: fp.cities, ids });
        renderFootprintCities(fp.year, trips, fp.cities);
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
    renderList();
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
        row('download', t('trips.batchExport'), t('trips.batchExportHint'), () => close(onBatchExport)))
    });
  }

  function activeDetailPanel() {
    return appState.tripDetail.section === 'share' ? exportView : analysisView;
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
    analysisView.view.classList.toggle('active', section !== 'share');
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
    await setActiveTrip(trip.id, { fit: true });
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
    const nameInput = el('input', { type: 'text', value: trip.name || '', maxlength: '60' });
    const tagsInput = el('input', {
      type: 'text', value: (trip.tags || []).join('，'),
      placeholder: t('trips.tagsPlaceholder')
    });
    const save = async () => {
      await updateTrip(trip.id, { name: nameInput.value.trim(), tags: parseTags(tagsInput.value) });
      m.close();
      toast(t('trips.renamed'), 'ok');
      render();
    };
    const m = modal({
      title: t('trips.editTitle'),
      body: el('div', {},
        el('div', { class: 'field' }, el('label', {}, t('wp.name')), nameInput),
        el('div', { class: 'field', style: { marginTop: '12px' } },
          el('label', {}, t('trips.tagsLabel')), tagsInput,
          el('div', { class: 'hint' }, t('trips.tagsHint')))),
      footer: [
        el('button', { class: 'btn ghost', onclick: () => m.close() }, t('common.cancel')),
        el('button', { class: 'btn primary', onclick: save }, t('common.save'))
      ]
    });
    for (const input of [nameInput, tagsInput]) {
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
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
  on('backup:exported', renderNudge);
  on('recorder:stopped', render);

  const onTripsOnline = () => {
    if (viewDestroyed) return;
    renderList();
    const state = footprintStates.get(footprintYear);
    if (!hasCityConsent() || footprintJobs.has(footprintYear)) return;
    if (state?.status === 'offline' || state?.status === 'error') {
      void loadFootprintCities(footprintYear, yearTrips(footprintYear));
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
      exportView.destroy();
      window.removeEventListener('online', onTripsOnline);
      for (const controller of footprintAborts.values()) controller.abort();
      footprintAborts.clear();
      footprintJobs.clear();
      footprintMap?.destroy();
      footprintMap = null;
    }
  };
}