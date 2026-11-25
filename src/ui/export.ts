// Share & export view: privacy sanitization, poster (WeChat-aware), GPX/GeoJSON/KML,
// self-contained HTML, lightweight share link.
import { t } from '../core/i18n';
import { get, set } from '../core/settings';
import { on } from '../core/events';
import { applyPrivacy } from '../core/privacy';
import { generatePoster } from '../core/poster';
import { buildGPX, buildGeoJSON, buildKML } from '../core/gpx';
import { buildSelfContainedHTML, estimateHTMLSize } from '../core/htmlExport';
import { buildShareLink } from '../core/shareLink';
import { generateTrackVideo, videoSupported } from '../core/trackVideo';
import { MUSIC_TRACKS, MUSIC_PREF_RANDOM, isMusicTrackId, musicSupported } from '../core/music';
import { videoIsWebmOnly } from '../core/videoCapture';
import { exportImage, exportFile, isWeChat, nativeShare } from '../core/shareEnv';
import { listTrips, loadTripFull } from '../core/store';
import { prepareMap } from '../core/mapPaint';
import { routePlaceNames } from '../core/shareInfo';
import { loadBrandFonts } from '../core/brand';
import { appState, setActiveTrip, isTripSectionActive } from './state';
import { el, icon, toast, modal } from './helpers';
import { renderTripEmptyState } from './tripEmptyState';

export function createExportView(getRecordMap: () => any, navigate = () => {}) {
  const view: HTMLElement = el('div', { class: 'view', id: 'view-export' });
  const scroll = el('div', { class: 'view-scroll' });
  view.append(scroll);

  const head = el('div', { class: 'page-head' },
    el('h2', { class: 'page-title' }, t('export.title')),
    el('div', { class: 'small muted', style: { marginTop: '3px' } }, t('export.subtitle')));

  // Selection belongs to appState. curFull is only the latest snapshot cache.
  let curFull = null;
  let selectedId = '';
  let snapshotRequest = 0;
  let tripListRequest = 0;
  let outputVersion = 0;
  let destroyed = false;
  let posterBusy = false;
  let videoBusy = false;
  let htmlBusy = false;

  const tripSel = el('select', { style: { width: '100%' } });
  const tripLabel = el('div', { class: 'small muted', style: { marginTop: '6px' } });
  const tripCard = el('div', { class: 'card share-trip-card' }, el('h3', {}, icon('pin', 18), t('export.tripPick')), tripSel, tripLabel);
  tripSel.onchange = async () => {
    const id = tripSel.value;
    try {
      const pending = setActiveTrip(id);
      // setActiveTrip changes activeTripId synchronously. Drop the old cache/output
      // immediately, then adopt the database snapshot emitted by the active event.
      syncActiveSelection();
      await pending;
    } catch (e) {
      console.error(e);
      toast(String(e?.message || e), 'err');
    }
    if (!destroyed) {
      syncActiveSelection();
      syncTripSelector();
      syncAvailability();
    }
  };

  // ---- privacy ----
  const radiusInput = el('input', { type: 'number', min: '0', max: '5000', step: '50', value: get('privacyRadius') });
  radiusInput.onchange = () => {
    radiusInput.value = String(Math.max(0, +radiusInput.value || 0));
    set('privacyRadius', +radiusInput.value);
    updatePrivacySummary(); updateLink(true); updateHtmlEstimate(); warmExport(curFull);
  };
  radiusInput.oninput = () => updatePrivacySummary();
  const hideCb = el('input', { type: 'checkbox' });
  hideCb.checked = true;
  hideCb.onchange = () => { updatePrivacySummary(); updateLink(true); updateHtmlEstimate(); warmExport(curFull); };
  const vectorCb = el('input', { type: 'checkbox' });
  vectorCb.onchange = () => { updatePrivacySummary(); warmExport(curFull); };
  const privacySummary = el('div', { class: 'privacy-summary small muted', role: 'status', 'aria-live': 'polite' });
  const privacyCrop = el('div', { class: 'privacy-crop small faint', style: { marginTop: '8px' } });
  const privacyControls = el('div', { class: 'privacy-controls', id: 'export-privacy-controls', hidden: true, style: { display: 'none' } },
    el('div', { class: 'setting-row' },
      el('div', { class: 'txt' }, el('div', { class: 't' }, t('export.privacyRadius')), el('div', { class: 'd' }, t('export.privacyRadiusHint'))),
      el('div', { class: 'inline-num' }, radiusInput, el('span', { class: 'small faint' }, 'm'))),
    el('div', { class: 'setting-row' }, el('div', { class: 'txt' }, el('div', { class: 't' }, t('export.hideSensitive'))), labelSwitch(hideCb)),
    el('div', { class: 'setting-row' }, el('div', { class: 'txt' }, el('div', { class: 't' }, t('export.vectorOnly'))), labelSwitch(vectorCb)),
    privacyCrop
  );
  const privacyAdjust = el('button', {
    type: 'button', class: 'btn ghost sm privacy-adjust',
    'aria-expanded': 'false', 'aria-controls': privacyControls.id
  }, t('export.privacyAdjust'));
  privacyAdjust.onclick = () => {
    const expanded = privacyAdjust.getAttribute('aria-expanded') !== 'true';
    privacyAdjust.setAttribute('aria-expanded', String(expanded));
    privacyControls.hidden = !expanded;
    privacyControls.style.display = expanded ? '' : 'none';
  };
  const privacyCard = el('div', { class: 'card privacy-card' },
    el('div', { class: 'privacy-summary-row', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } },
      el('div', { class: 'privacy-summary-copy', style: { flex: '1', minWidth: '0' } },
        el('h3', { style: { margin: '0 0 4px' } }, icon('shield', 18), t('export.privacy')),
        privacySummary),
      privacyAdjust),
    privacyControls
  );

  function labelSwitch(input) {
    return el('label', { class: 'switch' }, input, el('span', { class: 'slider' }));
  }
  async function shareMedia(blob, filename, kind) {
    const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ title: curFull?.trip.name || t('app.name'), text: t('app.tagline'), files: [file] });
        return;
      } catch (e) {
        if (e?.name === 'AbortError') return;
      }
    }
    if (kind === 'image' && window.ClipboardItem && navigator.clipboard?.write) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        toast(t('export.shareFallbackCopy'), 'ok');
        return;
      } catch { /* clipboard denied → guidance below */ }
    }
    toast(isWeChat() ? t('export.shareWechat') : t('export.shareUnsupported'), 'warn');
  }
  function privacyOpts() {
    return { radius: Math.max(0, +radiusInput.value || 0), hideSensitive: hideCb.checked };
  }
  function updatePrivacySummary() {
    const full = curFull;
    if (!full || full.trip.id !== appState.activeTripId) {
      privacySummary.textContent = '';
      privacyCrop.textContent = '';
      return;
    }
    const privacy = privacyOpts();
    const c = applyPrivacy(full, privacy);
    privacySummary.textContent = [
      privacy.radius > 0 ? `${t('export.checkCircle')} · ${privacy.radius} m` : t('export.privacyRadiusOff'),
      hideCb.checked ? t('export.sensitiveHidden') : t('export.sensitiveVisible'),
      t(vectorCb.checked ? 'export.vectorOnlyOn' : 'export.vectorOnlyOff')
    ].join(' · ');
    privacyCrop.textContent = t('export.cropNote', { n: c.croppedPoints, m: c.croppedWaypoints });
  }

  function shareSectionActive() {
    return appState.view === 'export' || isTripSectionActive('share');
  }

  // Warm tiles / place names / fonts only while Share is actually visible.
  let warmTimer = 0;
  let warmKey = '';
  function warmExport(full) {
    if (destroyed || !shareSectionActive() || !full || !navigator.onLine) {
      clearTimeout(warmTimer);
      warmTimer = 0;
      warmKey = '';
      return;
    }
    if (full.trip.id !== appState.activeTripId || curFull?.trip.id !== full.trip.id || curFull.trip.updatedAt !== full.trip.updatedAt) return;
    const privacy = privacyOpts();
    const base = getRecordMap?.()?.basemapId || '';
    const key = [full.trip.id, full.trip.updatedAt, base, privacy.radius, privacy.hideSensitive, vectorCb.checked].join('|');
    if (key === warmKey) return;
    warmKey = key;
    clearTimeout(warmTimer);
    warmTimer = window.setTimeout(async () => {
      warmTimer = 0;
      if (destroyed || !shareSectionActive()) {
        warmKey = '';
        return;
      }
      if (key !== warmKey || curFull?.trip.id !== full.trip.id || curFull.trip.updatedAt !== full.trip.updatedAt) return;
      try {
        const cropped = applyPrivacy(full, privacy);
        const common = {
          segments: cropped.segments, waypoints: cropped.waypoints,
          basemapId: base, vectorOnly: vectorCb.checked, onProgress: undefined
        };
        await Promise.all([
          loadBrandFonts(),
          routePlaceNames(cropped.segments, { max: 6 }),
          prepareMap({ w: 1080, h: 1150, pad: 90, ...common }),
          prepareMap({ w: 1080, h: 1080, pad: 80, ...common })
        ]);
      } catch { /* prewarm is best-effort */ }
    }, 550);
  }

  // ---- poster ----
  let posterBlob = null;
  let posterUrl = null;
  let posterSize = 'vertical';
  const sizeButtons = [];
  const sizeToggle = el('div', { class: 'seg-toggle sm' });
  for (const s of ['vertical', 'square']) {
    const b = el('button', { class: s === posterSize ? 'active' : '' }, t(s === 'vertical' ? 'export.posterVShort' : 'export.posterSShort'));
    b.onclick = () => {
      posterSize = s;
      sizeToggle.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    };
    sizeToggle.append(b);
    sizeButtons.push(b);
  }
  const previewBox = el('div', { class: 'poster-preview', style: { display: 'none' } });
  const genBtn = el('button', { class: 'btn primary sm' }, icon('photo', 15), t('export.generateShort'));
  const dlBtn = el('button', { class: 'btn sm icon-only', title: t('export.downloadPoster'), 'aria-label': t('export.downloadPoster'), style: { display: 'none' } }, icon('download', 16));
  const posterShareBtn = el('button', { class: 'btn sm icon-only', title: t('export.shareImage'), 'aria-label': t('export.shareImage'), style: { display: 'none' } }, icon('share', 16));
  posterShareBtn.onclick = () => { if (posterBlob) shareMedia(posterBlob, `roametch-poster-${Date.now()}.png`, 'image'); };
  const posterNote = el('div', { class: 'small faint', style: { marginTop: '6px' } });
  genBtn.onclick = async () => {
    if (!hasCurrentTrip() || posterBusy || videoBusy || htmlBusy) return;
    const startId = appState.activeTripId;
    const startVersion = outputVersion;
    let generating = null;
    posterBusy = true;
    syncAvailability();
    genBtn.textContent = t('common.loading');
    try {
      const loaded = await reloadCurrentTrip();
      if (!loaded) return;
      const { full, version } = loaded;
      generating = { full, version };
      const { blob, usedVectorFallback } = await generatePoster(full, {
        size: posterSize,
        privacy: privacyOpts(),
        vectorOnly: vectorCb.checked,
        basemapId: getRecordMap?.()?.basemapId || '',
        onProgress: (p) => {
          if (isSnapshotCurrent(generating)) genBtn.textContent = `${t('common.loading')} ${Math.round(p * 100)}%`;
        }
      });
      if (!isSnapshotCurrent(generating)) { notifyStale(); return; }
      const url = URL.createObjectURL(blob);
      revokePosterUrl();
      posterBlob = blob;
      posterUrl = url;
      previewBox.innerHTML = '';
      previewBox.append(el('img', { src: url }));
      previewBox.style.display = '';
      dlBtn.style.display = '';
      posterShareBtn.style.display = '';
      posterNote.textContent = usedVectorFallback && !vectorCb.checked ? '⚠ ' + t('export.posterVectorFallback') : '';
    } catch (e) {
      if (destroyed) return;
      if (generating ? !isSnapshotCurrent(generating) : appState.activeTripId !== startId || outputVersion !== startVersion) notifyStale();
      else { console.error(e); toast(String(e?.message || e), 'err'); }
    } finally {
      posterBusy = false;
      if (!destroyed) {
        genBtn.innerHTML = '';
        genBtn.append(icon('photo', 15), t('export.generateShort'));
        syncAvailability();
      }
    }
  };
  dlBtn.onclick = async () => {
    if (!posterBlob) return;
    const name = `roametch-poster-${Date.now()}.png`;
    const r = await exportImage(posterBlob, name);
    if (r.mode === 'longpress') {
      const m = modal({
        title: t('export.poster'),
        body: el('div', { class: 'wechat-save-overlay' },
          el('img', { src: r.dataUrl }),
          el('div', { class: 'hint' }, '👆 ' + t('export.wechatHint'))),
        footer: [el('button', { class: 'btn ghost', onclick: () => m.close() }, t('common.close'))]
      });
    } else {
      toast(t('export.exported'), 'ok');
    }
  };
  const posterCard = el('div', { class: 'card' },
    el('h3', {}, icon('photo', 18), t('export.poster')),
    el('div', { class: 'card-line' }, sizeToggle, genBtn, dlBtn, posterShareBtn),
    posterNote,
    el('div', { style: { marginTop: '10px' } }, previewBox)
  );

  // ---- track video ----
  const videoOk = videoSupported();
  const videoWebmOnly = videoOk && videoIsWebmOnly(musicSupported());
  let videoBlob = null, videoExt = 'webm', videoAbort = null, videoUrl = null;
  let videoReadyNote = '';
  let videoSeconds = 15;
  const durToggle = el('div', { class: 'seg-toggle sm' });
  const durationButtons = [];
  for (const s of [10, 15, 30]) {
    const b = el('button', { class: s === videoSeconds ? 'active' : '' }, t('export.videoSeconds', { s }));
    b.onclick = () => {
      videoSeconds = s;
      durToggle.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    };
    durToggle.append(b);
    durationButtons.push(b);
  }
  const vGenBtn = el('button', { class: 'btn primary sm' }, icon('play', 15), t('export.generateShort'));
  const vCancelBtn = el('button', { class: 'btn ghost sm icon-only', title: t('common.cancel'), 'aria-label': t('common.cancel'), style: { display: 'none' } }, icon('x', 16));
  const vDlBtn = el('button', { class: 'btn sm icon-only', title: t('export.videoDownload'), 'aria-label': t('export.videoDownload'), style: { display: 'none' } }, icon('download', 16));
  const vShareBtn = el('button', { class: 'btn sm icon-only', title: t('export.shareVideo'), 'aria-label': t('export.shareVideo'), style: { display: 'none' } }, icon('share', 16));
  vShareBtn.onclick = () => { if (videoBlob) shareMedia(videoBlob, `roametch-video-${Date.now()}.${videoExt}`, 'video'); };
  const vPreview = el('video', { controls: true, playsinline: true, 'webkit-playsinline': '', preload: 'metadata', style: { width: '100%', display: 'none', marginTop: '10px', borderRadius: '10px', background: '#000' } });
  const vNote = el('div', { class: 'small faint', style: { marginTop: '6px' } });
  const musicPref = get('videoMusic');
  const musicSel = el('select', { class: 'trip-sort video-music', 'aria-label': t('export.videoMusic') },
    el('option', { value: MUSIC_PREF_RANDOM }, t('music.random')),
    ...MUSIC_TRACKS.map((track) => el('option', { value: track.id }, t(track.labelKey))));
  musicSel.value = musicPref === MUSIC_PREF_RANDOM || isMusicTrackId(musicPref) ? musicPref : MUSIC_PREF_RANDOM;
  musicSel.onchange = () => set('videoMusic', musicSel.value);
  const musicRow = musicSupported()
    ? el('label', { class: 'video-music-row' }, icon('music', 16),
      el('span', {}, t('export.videoMusic')),
      musicSel)
    : null;
  vCancelBtn.onclick = () => videoAbort?.abort();
  vGenBtn.onclick = async () => {
    if (!hasCurrentTrip() || videoBusy || posterBusy || htmlBusy) return;
    const startId = appState.activeTripId;
    const startVersion = outputVersion;
    let generating = null;
    const abort = new AbortController();
    videoAbort = abort;
    videoBusy = true;
    syncAvailability();
    vNote.textContent = t('export.videoKeepVisible');
    try {
      const loaded = await reloadCurrentTrip(abort.signal);
      if (!loaded) return;
      const { full, version } = loaded;
      generating = { full, version };
      vNote.textContent = t('export.videoKeepVisible');
      const r = await generateTrackVideo(full, {
        privacy: privacyOpts(),
        vectorOnly: vectorCb.checked,
        basemapId: getRecordMap?.()?.basemapId || '',
        seconds: videoSeconds,
        music: musicSel.value,
        signal: abort.signal,
        onProgress: (p) => {
          if (isSnapshotCurrent(generating)) vGenBtn.textContent = t('export.videoRendering', { p: Math.round(p * 100) });
        }
      });
      if (!isSnapshotCurrent(generating)) { notifyStale(); return; }
      const url = URL.createObjectURL(r.blob);
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      videoBlob = r.blob;
      videoExt = r.mime.includes('mp4') ? 'mp4' : 'webm';
      videoUrl = url;
      if (r.cover) vPreview.poster = r.cover; else vPreview.removeAttribute('poster');
      vPreview.src = videoUrl;
      vPreview.style.display = '';
      vDlBtn.style.display = '';
      vShareBtn.style.display = '';
      const usedTrack = MUSIC_TRACKS.find((track) => track.id === r.musicTrack);
      const musicLabel = usedTrack ? ` · ${t('export.videoMusicUsed', { name: t(usedTrack.labelKey) })}` : '';
      const webmLabel = videoExt === 'webm' ? ` · ${t('export.videoWebmShort')}` : '';
      vNote.textContent = (r.usedVectorFallback && !vectorCb.checked ? '⚠ ' + t('export.posterVectorFallback') + ' · ' : '') +
        t('export.videoReady', { size: (r.blob.size / 1048576).toFixed(1) + 'MB' }) + musicLabel + webmLabel;
      videoReadyNote = vNote.textContent;
    } catch (e) {
      if (destroyed) return;
      const stale = generating ? !isSnapshotCurrent(generating) : appState.activeTripId !== startId || outputVersion !== startVersion;
      if (stale) notifyStale();
      else if (e?.name === 'AbortError') vNote.textContent = videoBlob ? videoReadyNote : '';
      else if (e?.message === 'no-track') toast(t('export.videoNoTrack'), 'warn');
      else if (e?.message === 'video-unsupported') toast(t('export.videoUnsupported'), 'warn');
      else { console.error(e); toast(String(e?.message || e), 'err'); }
    } finally {
      if (videoAbort === abort) {
        videoAbort = null;
        videoBusy = false;
        if (!destroyed) {
          vGenBtn.innerHTML = '';
          vGenBtn.append(icon('play', 15), t('export.generateShort'));
          syncAvailability();
        }
      }
    }
  };
  vDlBtn.onclick = () => {
    if (!videoBlob) return;
    exportFile(videoBlob, `roametch-video-${Date.now()}.${videoExt}`);
    toast(t('export.exported'), 'ok');
  };
  const videoCard = el('div', { class: 'card' },
    el('h3', {}, icon('play', 18), t('export.video')),
    el('div', { class: 'small faint', style: { marginBottom: '8px' } }, t('export.videoHint')),
    videoOk ? null : el('div', { class: 'debug-banner' }, '⚠ ' + t('export.videoUnsupported')),
    videoWebmOnly ? el('div', { class: 'debug-banner' }, '⚠ ' + t('export.videoWebmWarn')) : null,
    isWeChat() ? el('div', { class: 'small', style: { color: 'var(--warn)', marginBottom: '8px' } }, t('export.videoWechatHint')) : null,
    musicRow,
    el('div', { class: 'card-line' }, durToggle, vGenBtn, vCancelBtn, vDlBtn, vShareBtn),
    vNote,
    vPreview
  );

  // ---- standard files ----
  async function croppedFull() {
    const loaded = await reloadCurrentTrip();
    if (!loaded) return null;
    const c = applyPrivacy(loaded.full, privacyOpts());
    return { full: { ...loaded.full, segments: c.segments, waypoints: c.waypoints }, snapshot: loaded };
  }
  const fileButtons = [];
  const fileBtn = (label, hint, fn) => {
    const b = el('button', { class: 'btn block', style: { justifyContent: 'flex-start', marginBottom: '8px' } }, icon('download', 16),
      el('span', { style: { textAlign: 'left' } }, el('div', {}, label), el('div', { class: 'small faint', style: { fontWeight: 400 } }, hint)));
    b.onclick = fn;
    fileButtons.push(b);
    return b;
  };
  const filesCard = el('div', { class: 'card' },
    el('h3', {}, icon('download', 18), t('common.export')),
    fileBtn(t('export.gpx'), t('export.gpxHint'), async () => {
      const result = await croppedFull();
      if (!result || !requireCurrentSnapshot(result.snapshot)) return;
      const f = result.full;
      exportFile(new Blob([buildGPX(f)], { type: 'application/gpx+xml' }), `${f.trip.name || 'trip'}.gpx`);
      toast(t('export.exported'), 'ok');
    }),
    fileBtn(t('export.geojson'), t('export.geojsonHint'), async () => {
      const result = await croppedFull();
      if (!result || !requireCurrentSnapshot(result.snapshot)) return;
      const f = result.full;
      exportFile(new Blob([JSON.stringify(buildGeoJSON(f), null, 1)], { type: 'application/geo+json' }), `${f.trip.name || 'trip'}.geojson`);
      toast(t('export.exported'), 'ok');
    }),
    fileBtn(t('export.kml'), t('export.kmlHint'), async () => {
      const result = await croppedFull();
      if (!result || !requireCurrentSnapshot(result.snapshot)) return;
      const f = result.full;
      exportFile(new Blob([buildKML(f)], { type: 'application/vnd.google-earth.kml+xml' }), `${f.trip.name || 'trip'}.kml`);
      toast(t('export.exported'), 'ok');
    })
  );

  // ---- self-contained HTML ----
  let htmlTier = 'clear';
  let htmlPhotosPref = true;
  const tierToggle = el('div', { class: 'seg-toggle' });
  const tierButtons = [];
  for (const [k, label] of [['clear', t('export.htmlClear')], ['light', t('export.htmlLight')], ['none', t('export.htmlNone')]]) {
    const b = el('button', { class: k === htmlTier ? 'active' : '' }, label);
    b.onclick = () => {
      htmlTier = k;
      tierToggle.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      syncHtmlTierControls();
      syncAvailability();
    };
    tierToggle.append(b);
    tierButtons.push(b);
  }
  const htmlPhotosCb = el('input', { type: 'checkbox' });
  const htmlPhotosRow = el('label', { class: 'row', style: { cursor: 'pointer', fontSize: '13px', marginTop: '8px' } }, htmlPhotosCb, t('export.htmlPhotos'));
  const htmlEstimate = el('div', { class: 'small faint', style: { marginTop: '6px' } });
  const htmlBtn = el('button', { class: 'btn' }, icon('export', 16), t('export.html'));
  function syncHtmlTierControls() {
    const none = htmlTier === 'none';
    htmlPhotosCb.checked = none ? false : htmlPhotosPref;
    htmlPhotosRow.style.opacity = none ? '0.55' : '';
    updateHtmlEstimate();
  }
  function updateHtmlEstimate() {
    if (!curFull) { htmlEstimate.textContent = ''; return; }
    const bytes = estimateHTMLSize(curFull, {
      tier: htmlTier,
      privacy: privacyOpts(),
      includePhotos: htmlTier !== 'none' && htmlPhotosCb.checked
    });
    const size = bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
    htmlEstimate.textContent = t('export.htmlEstimate', { size });
  }
  htmlPhotosCb.onchange = () => { htmlPhotosPref = htmlPhotosCb.checked; updateHtmlEstimate(); };
  htmlBtn.onclick = async () => {
    if (!hasCurrentTrip() || htmlBusy || posterBusy || videoBusy) return;
    const startId = appState.activeTripId;
    const startVersion = outputVersion;
    let generating = null;
    htmlBusy = true;
    syncAvailability();
    htmlBtn.textContent = t('export.htmlBuilding');
    try {
      const loaded = await reloadCurrentTrip();
      if (!loaded) return;
      const { full, version } = loaded;
      generating = { full, version };
      const { html, size, photos } = await buildSelfContainedHTML(full, {
        tier: htmlTier,
        privacy: privacyOpts(),
        includePhotos: htmlTier !== 'none' && htmlPhotosCb.checked,
        onProgress: (p) => {
          if (isSnapshotCurrent(generating)) htmlBtn.textContent = `${t('export.htmlBuilding')} ${Math.round(p * 100)}%`;
        }
      });
      if (!requireCurrentSnapshot(generating)) return;
      if (size > 1_500_000) toast(t('export.htmlWarn', { size: (size / 1048576).toFixed(1) + 'MB' }), 'warn', 4000);
      exportFile(new Blob([html], { type: 'text/html' }), `${full.trip.name || 'trip'}.html`);
      toast(`${t('export.exported')} · ${(size / 1024).toFixed(0)} KB${photos ? ` · ${photos} ${t('wp.photos')}` : ''}`, 'ok');
    } catch (e) {
      if (destroyed) return;
      if (generating ? !isSnapshotCurrent(generating) : appState.activeTripId !== startId || outputVersion !== startVersion) notifyStale();
      else { console.error(e); toast(String(e?.message || e), 'err'); }
    } finally {
      htmlBusy = false;
      if (!destroyed) {
        htmlBtn.innerHTML = '';
        htmlBtn.append(icon('export', 16), t('export.html'));
        syncAvailability();
        updateHtmlEstimate();
      }
    }
  };
  const htmlCard = el('div', { class: 'card' },
    el('h3', {}, icon('globe', 18), t('export.html')),
    el('div', { class: 'small faint', style: { marginBottom: '8px' } }, t('export.htmlHint')),
    el('div', { class: 'row wrap' }, tierToggle, htmlBtn),
    htmlPhotosRow,
    htmlEstimate
  );
  syncHtmlTierControls();

  // ---- share link (compact import URL, fragment only) ----
  // The link is rebuilt automatically on refresh/options changes and by Copy or
  // Share, so a separate Generate button would duplicate those actions.
  const linkInput = el('input', { type: 'text', readonly: true, class: 'link-input' });
  const copyBtn = el('button', { class: 'btn sm' }, t('common.copy'));
  const linkNote = el('div', { class: 'small faint', style: { marginTop: '6px' } });
  function updateLink(quiet = true) {
    const full = curFull;
    linkInput.value = '';
    linkNote.textContent = '';
    if (!full || full.trip.id !== appState.activeTripId) return false;
    try {
      const { url, size } = buildShareLink(full, privacyOpts());
      linkInput.value = url;
      linkNote.textContent = t('export.linkNote', { size });
      return true;
    } catch (e) {
      if (e?.message === 'too-big') {
        linkNote.textContent = t('export.linkTooBig');
        if (!quiet) toast(t('export.linkTooBig'), 'warn', 5000);
      } else {
        linkNote.textContent = String(e?.message || e);
        if (!quiet) toast(linkNote.textContent, 'err');
      }
      return false;
    }
  }
  copyBtn.onclick = async () => {
    let loaded = null;
    try {
      loaded = await reloadCurrentTrip();
      if (!loaded || !requireCurrentSnapshot(loaded) || !updateLink(true)) return;
      await navigator.clipboard.writeText(linkInput.value);
      if (!requireCurrentSnapshot(loaded)) return;
      toast(t('common.copied'), 'ok');
    } catch {
      if (destroyed) return;
      if (loaded ? !isSnapshotCurrent(loaded) : appState.activeTripId && !curFull) notifyStale();
      else {
        linkInput.select();
        toast(t('toast.copyFail'), 'warn');
      }
    }
  };
  const shareBtn = el('button', { class: 'btn sm' }, icon('share', 14), t('export.shareNative'));
  shareBtn.style.display = navigator.share ? '' : 'none';
  shareBtn.onclick = async () => {
    const loaded = await reloadCurrentTrip();
    if (!loaded || !requireCurrentSnapshot(loaded)) return;
    updateLink(true);
    const ok = await nativeShare({
      title: loaded.full.trip.name,
      text: t('app.tagline'),
      url: linkInput.value || undefined
    });
    if (!ok) toast(t('toast.copyFail'), 'warn');
  };
  const linkCard = el('div', { class: 'card' },
    el('h3', {}, icon('share', 18), t('export.link')),
    el('div', { class: 'small faint', style: { marginBottom: '9px', lineHeight: 1.5 } }, t('export.linkHint')),
    el('div', { class: 'row wrap', style: { marginBottom: '8px' } }, copyBtn, shareBtn),
    linkInput, linkNote
  );

  const wechatBanner = isWeChat()
    ? el('div', { class: 'debug-banner' }, '⚠ ' + t('export.openInBrowser'))
    : null;
  const emptyState = el('div', { class: 'empty-state export-empty', style: { display: 'none' } });

  const secPrivacy = el('div', { class: 'section-label' }, t('export.groupPrivacy'));
  const secShare = el('div', { class: 'section-label' }, t('export.groupShare'));
  const secFiles = el('div', { class: 'section-label' }, t('export.groupFiles'));
  const outputSections = [secPrivacy, secShare, secFiles];
  const outputCards = [privacyCard, posterCard, videoCard, linkCard, filesCard, htmlCard];
  scroll.append(...[
    head, tripCard, wechatBanner, emptyState,
    secPrivacy, privacyCard,
    secShare, posterCard, videoCard, linkCard,
    secFiles, filesCard, htmlCard
  ].filter(Boolean));

  function revokePosterUrl() {
    if (posterUrl) { URL.revokeObjectURL(posterUrl); posterUrl = null; }
  }
  function resetOutputs(preserveSignal = null) {
    outputVersion++;
    if (videoAbort && videoAbort.signal !== preserveSignal) videoAbort.abort();
    posterBlob = null;
    videoBlob = null;
    videoReadyNote = '';
    revokePosterUrl();
    previewBox.innerHTML = '';
    previewBox.style.display = 'none';
    dlBtn.style.display = 'none';
    posterShareBtn.style.display = 'none';
    posterNote.textContent = '';
    if (videoUrl) { URL.revokeObjectURL(videoUrl); videoUrl = null; }
    vPreview.removeAttribute('src');
    vPreview.removeAttribute('poster');
    vPreview.style.display = 'none';
    vDlBtn.style.display = 'none';
    vShareBtn.style.display = 'none';
    vNote.textContent = '';
    linkInput.value = '';
    linkNote.textContent = '';
  }
  function currentTripId() {
    return appState.activeTripId || '';
  }
  function hasCurrentTrip() {
    return !destroyed && !!currentTripId() && selectedId === currentTripId() && curFull?.trip.id === currentTripId();
  }
  function isSnapshotCurrent(snapshot) {
    return !!snapshot && hasCurrentTrip() && snapshot.full.trip.id === currentTripId() &&
      curFull.trip.updatedAt === snapshot.full.trip.updatedAt && snapshot.version === outputVersion;
  }
  function notifyStale() {
    if (!destroyed) toast(t('export.tripChanged'), 'warn');
  }
  function requireCurrentSnapshot(snapshot) {
    if (isSnapshotCurrent(snapshot)) return true;
    notifyStale();
    return false;
  }
  function syncTripSelector() {
    const id = currentTripId();
    if (!id || [...tripSel.options].some((option) => option.value === id)) tripSel.value = id;
  }
  function adoptSnapshot(full, preserveSignal = null) {
    if (destroyed) return;
    const id = currentTripId();
    const previous = curFull;
    const changed = selectedId !== id ||
      (!!full && previous?.trip.id === id && previous.trip.updatedAt !== full.trip.updatedAt) ||
      (!!previous && !full);
    selectedId = id;
    curFull = full;
    snapshotRequest++;
    if (changed) resetOutputs(preserveSignal);
    syncTripSelector();
    refresh();
  }
  function syncActiveSelection(full = appState.activeTripFull) {
    const id = currentTripId();
    adoptSnapshot(full?.trip.id === id ? full : null);
  }
  async function reloadCurrentTrip(signal = null) {
    const id = currentTripId();
    if (!id) return null;
    const request = ++snapshotRequest;
    const version = outputVersion;
    const full = await loadTripFull(id);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (destroyed) return null;
    if (appState.activeTripId !== id || version !== outputVersion) { notifyStale(); return null; }
    if (!full) {
      if (request === snapshotRequest) adoptSnapshot(null);
      notifyStale();
      return null;
    }
    if (full.trip.id !== id) { notifyStale(); return null; }
    if (curFull?.trip.id === id && (curFull.trip.updatedAt || 0) > (full.trip.updatedAt || 0)) { notifyStale(); return null; }
    // Only the newest response may replace the cache. A same-identity event or
    // action must not invalidate this generation, however.
    if (request === snapshotRequest) adoptSnapshot(full, signal);
    if (curFull && (curFull.trip.id !== id || curFull.trip.updatedAt !== full.trip.updatedAt)) { notifyStale(); return null; }
    return { full, version: outputVersion };
  }
  async function refreshTripList() {
    if (destroyed) return;
    const request = ++tripListRequest;
    const trips = await listTrips();
    if (destroyed || request !== tripListRequest) return;
    const active = currentTripId();
    const activeExists = trips.some((tr) => tr.id === active);
    tripSel.innerHTML = '';
    tripSel.append(el('option', { value: '' }, '—'));
    for (const tr of trips) tripSel.append(el('option', { value: tr.id }, tr.name || new Date(tr.createdAt).toLocaleString()));
    tripSel.value = activeExists ? active : '';
    if (active && !activeExists) {
      await setActiveTrip(null);
      return;
    }
    if (!active && trips[0]?.id) {
      await setActiveTrip(trips[0]?.id);
      return;
    }
    if (curFull?.trip.id !== active) {
      if (appState.activeTripFull?.trip.id === active) syncActiveSelection(appState.activeTripFull);
      else if (active) await reloadCurrentTrip();
      else syncActiveSelection(null);
    } else {
      syncTripSelector();
      refresh();
      syncAvailability();
    }
  }
  function refresh() {
    if (destroyed) return;
    tripLabel.textContent = curFull
      ? `${curFull.trip.name || t('record.newTripName')} · ${t(`record.activities.${curFull.trip.activity}`)}`
      : t('analysis.noTrip');
    updatePrivacySummary();
    updateLink(true);
    updateHtmlEstimate();
    syncAvailability();
    warmExport(curFull);
  }
  function syncAvailability() {
    const available = hasCurrentTrip();
    const generating = posterBusy || videoBusy || htmlBusy;
    if (!available && !emptyState.childElementCount) {
      renderTripEmptyState(emptyState, navigate, {
        iconKey: 'share', titleKey: 'export.emptyTitle', hintKey: 'export.emptyHint'
      });
    }
    emptyState.style.display = available ? 'none' : '';
    outputSections.forEach((node) => { node.style.display = available ? '' : 'none'; });
    outputCards.forEach((node) => { node.style.display = available ? '' : 'none'; });
    tripSel.disabled = videoBusy;
    radiusInput.disabled = !available || generating;
    hideCb.disabled = !available || generating;
    vectorCb.disabled = !available || generating;
    privacyAdjust.disabled = !available || generating;
    sizeButtons.forEach((b) => { b.disabled = !available || generating; });
    genBtn.disabled = !available || generating;
    dlBtn.disabled = !posterBlob;
    posterShareBtn.disabled = !posterBlob;
    durationButtons.forEach((b) => { b.disabled = !available || generating; });
    musicSel.disabled = !available || generating;
    vGenBtn.disabled = !available || !videoOk || generating;
    vCancelBtn.disabled = !videoBusy;
    vCancelBtn.style.display = videoBusy ? '' : 'none';
    vDlBtn.disabled = !videoBlob;
    vShareBtn.disabled = !videoBlob;
    fileButtons.forEach((b) => { b.disabled = !available || generating; });
    tierButtons.forEach((b) => { b.disabled = !available || generating; });
    htmlPhotosCb.disabled = !available || generating || htmlTier === 'none';
    htmlBtn.disabled = !available || generating;
    copyBtn.disabled = !available || videoBusy;
    shareBtn.disabled = !available || videoBusy;
    linkInput.disabled = !available;
  }
  const unsubscribe = on('trip:active', (full) => {
    if (destroyed) return;
    if (full && full.trip.id !== currentTripId()) return;
    if (!full && currentTripId()) return;
    adoptSnapshot(full);
    if (full && ![...tripSel.options].some((option) => option.value === full.trip.id)) void refreshTripList();
  });
  syncAvailability();
  refreshTripList();

  return {
    view,
    refresh: refreshTripList,
    resize: () => {},
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      snapshotRequest++;
      tripListRequest++;
      clearTimeout(warmTimer);
      warmKey = '';
      unsubscribe();
      videoAbort?.abort();
      videoAbort = null;
      posterBusy = false;
      videoBusy = false;
      htmlBusy = false;
      resetOutputs();
    }
  };
}
