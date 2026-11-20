// Share & export view: privacy sanitization, poster (WeChat-aware), GPX/GeoJSON/KML,
// self-contained HTML, lightweight share link.
import { t } from '../core/i18n';
import { get, set } from '../core/settings';
import { on } from '../core/events';
import { applyPrivacy } from '../core/privacy';
import { generatePoster } from '../core/poster';
import { buildGPX, buildGeoJSON, buildKML } from '../core/gpx';
import { buildSelfContainedHTML } from '../core/htmlExport';
import { buildShareLink } from '../core/shareLink';
import { generateTrackVideo, videoSupported } from '../core/trackVideo';
import { exportImage, exportFile, isWeChat, nativeShare } from '../core/shareEnv';
import { listTrips, loadTripFull } from '../core/store';
import { appState } from './state';
import { el, icon, toast, modal } from './helpers';

export function createExportView(getRecordMap) {
  const view = el('div', { class: 'view', id: 'view-export' });
  const scroll = el('div', { class: 'view-scroll' });
  view.append(scroll);

  const title = el('h2', { class: 'page-title' }, t('export.title'));
  let curFull = null;
  const tripSel = el('select', { style: { width: '100%' } });
  const tripLabel = el('div', { class: 'small muted', style: { marginTop: '6px' } });
  const tripCard = el('div', { class: 'card' }, el('h3', {}, t('export.tripPick')), tripSel, tripLabel);
  tripSel.onchange = () => pickTrip(tripSel.value);

  // ---- privacy ----
  const radiusInput = el('input', { type: 'number', min: '0', max: '5000', step: '50', value: get('privacyRadius') });
  radiusInput.onchange = () => { set('privacyRadius', Math.max(0, +radiusInput.value || 0)); updateCropInfo(); };
  const hideCb = el('input', { type: 'checkbox' });
  hideCb.checked = true;
  hideCb.onchange = updateCropInfo;
  const vectorCb = el('input', { type: 'checkbox' });
  const cropInfo = el('div', { class: 'small', style: { color: 'var(--warn)', marginTop: '8px' } });
  const privacyCard = el('div', { class: 'card' },
    el('h3', {}, '🛡 ' + t('export.privacy')),
    el('div', { class: 'field' }, el('label', {}, t('export.privacyRadius')), radiusInput,
      el('div', { class: 'hint' }, t('export.privacyRadiusHint'))),
    el('div', { class: 'setting-row' }, el('div', { class: 'txt' }, el('div', { class: 't' }, t('export.hideSensitive'))), labelSwitch(hideCb)),
    el('div', { class: 'setting-row' }, el('div', { class: 'txt' }, el('div', { class: 't' }, t('export.vectorOnly'))), labelSwitch(vectorCb)),
    cropInfo,
    el('div', { class: 'sep' }),
    el('div', { class: 'small muted' },
      el('div', { class: 'privacy-check' }, el('span', { class: 'ok' }, '✓'), t('export.checkCircle')),
      el('div', { class: 'privacy-check' }, el('span', { class: 'ok' }, '✓'), t('export.checkNodes')),
      el('div', { class: 'privacy-check' }, el('span', { class: 'ok' }, '✓'), t('export.checkExif')),
      el('div', { class: 'privacy-check' }, el('span', { class: 'ok' }, '✓'), t('export.checkCoords')))
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
  function updateCropInfo() {
    const full = curFull;
    if (!full) { cropInfo.textContent = ''; return; }
    const c = applyPrivacy(full, privacyOpts());
    cropInfo.textContent = t('export.cropNote', { n: c.croppedPoints, m: c.croppedWaypoints });
  }

  // ---- poster ----
  let posterBlob = null;
  let posterSize = 'vertical';
  const sizeToggle = el('div', { class: 'seg-toggle sm' });
  for (const s of ['vertical', 'square']) {
    const b = el('button', { class: s === posterSize ? 'active' : '' }, t(s === 'vertical' ? 'export.posterVShort' : 'export.posterSShort'));
    b.onclick = () => {
      posterSize = s;
      sizeToggle.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    };
    sizeToggle.append(b);
  }
  const previewBox = el('div', { class: 'poster-preview', style: { display: 'none' } });
  const genBtn = el('button', { class: 'btn primary sm' }, icon('photo', 15), t('export.generateShort'));
  const dlBtn = el('button', { class: 'btn sm icon-only', title: t('export.downloadPoster'), 'aria-label': t('export.downloadPoster'), style: { display: 'none' } }, icon('download', 16));
  const posterShareBtn = el('button', { class: 'btn sm icon-only', title: t('export.shareImage'), 'aria-label': t('export.shareImage'), style: { display: 'none' } }, icon('share', 16));
  posterShareBtn.onclick = () => { if (posterBlob) shareMedia(posterBlob, `localtrace-poster-${Date.now()}.png`, 'image'); };
  const posterNote = el('div', { class: 'small faint', style: { marginTop: '6px' } });
  genBtn.onclick = async () => {
    const full = curFull;
    if (!full) { toast(t('analysis.noTrip'), 'warn'); return; }
    genBtn.disabled = true;
    genBtn.textContent = t('common.loading');
    try {
      const { blob, usedVectorFallback } = await generatePoster(full, {
        size: posterSize,
        privacy: privacyOpts(),
        vectorOnly: vectorCb.checked,
        basemapId: getRecordMap?.()?.basemapId || '',
        onProgress: (p) => { genBtn.textContent = `${t('common.loading')} ${Math.round(p * 100)}%`; }
      });
      posterBlob = blob;
      const url = URL.createObjectURL(blob);
      previewBox.innerHTML = '';
      previewBox.append(el('img', { src: url }));
      previewBox.style.display = '';
      dlBtn.style.display = '';
      posterShareBtn.style.display = '';
      posterNote.textContent = usedVectorFallback && !vectorCb.checked ? '⚠ ' + t('export.posterVectorFallback') : '';
    } catch (e) {
      console.error(e);
      toast(String(e.message || e), 'err');
    }
    genBtn.disabled = false;
    genBtn.innerHTML = '';
    genBtn.append(icon('photo', 15), t('export.generateShort'));
  };
  dlBtn.onclick = async () => {
    if (!posterBlob) return;
    const name = `localtrace-poster-${Date.now()}.png`;
    const r = await exportImage(posterBlob, name);
    if (r.mode === 'longpress') {
      modal({
        title: t('export.poster'),
        body: el('div', { class: 'wechat-save-overlay' },
          el('img', { src: r.dataUrl }),
          el('div', { class: 'hint' }, '👆 ' + t('export.wechatHint'))),
        footer: [el('button', { class: 'btn ghost', onclick: (e) => e.target.closest('.modal-backdrop').remove() }, t('common.close'))]
      });
    } else {
      toast(t('export.exported'), 'ok');
    }
  };
  const posterCard = el('div', { class: 'card' },
    el('h3', {}, '🖼 ' + t('export.poster')),
    el('div', { class: 'card-line' }, sizeToggle, genBtn, dlBtn, posterShareBtn),
    posterNote,
    el('div', { style: { marginTop: '10px' } }, previewBox)
  );

  // ---- track video ----
  const videoOk = videoSupported();
  let videoBlob = null, videoExt = 'webm', videoAbort = null, videoUrl = null;
  let videoSeconds = 15;
  const durToggle = el('div', { class: 'seg-toggle sm' });
  for (const s of [10, 15, 30]) {
    const b = el('button', { class: s === videoSeconds ? 'active' : '' }, t('export.videoSeconds', { s }));
    b.onclick = () => {
      videoSeconds = s;
      durToggle.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    };
    durToggle.append(b);
  }
  const vGenBtn = el('button', { class: 'btn primary sm' }, icon('play', 15), t('export.generateShort'));
  const vCancelBtn = el('button', { class: 'btn ghost sm icon-only', title: t('common.cancel'), 'aria-label': t('common.cancel'), style: { display: 'none' } }, icon('x', 16));
  const vDlBtn = el('button', { class: 'btn sm icon-only', title: t('export.videoDownload'), 'aria-label': t('export.videoDownload'), style: { display: 'none' } }, icon('download', 16));
  const vShareBtn = el('button', { class: 'btn sm icon-only', title: t('export.shareVideo'), 'aria-label': t('export.shareVideo'), style: { display: 'none' } }, icon('share', 16));
  vShareBtn.onclick = () => { if (videoBlob) shareMedia(videoBlob, `localtrace-video-${Date.now()}.${videoExt}`, 'video'); };
  const vPreview = el('video', { controls: true, playsinline: true, 'webkit-playsinline': '', preload: 'metadata', style: { width: '100%', display: 'none', marginTop: '10px', borderRadius: '10px', background: '#000' } });
  const vNote = el('div', { class: 'small faint', style: { marginTop: '6px' } });
  vCancelBtn.onclick = () => videoAbort?.abort();
  vGenBtn.onclick = async () => {
    const full = curFull;
    if (!full) { toast(t('analysis.noTrip'), 'warn'); return; }
    videoAbort = new AbortController();
    vGenBtn.disabled = true;
    tripSel.disabled = true;
    durToggle.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    vCancelBtn.style.display = '';
    vDlBtn.style.display = 'none';
    vShareBtn.style.display = 'none';
    vPreview.style.display = 'none';
    vNote.textContent = t('export.videoKeepVisible');
    try {
      const r = await generateTrackVideo(full, {
        privacy: privacyOpts(),
        vectorOnly: vectorCb.checked,
        basemapId: getRecordMap?.()?.basemapId || '',
        seconds: videoSeconds,
        signal: videoAbort.signal,
        onProgress: (p) => { vGenBtn.textContent = t('export.videoRendering', { p: Math.round(p * 100) }); }
      });
      videoBlob = r.blob;
      videoExt = r.mime.includes('mp4') ? 'mp4' : 'webm';
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      videoUrl = URL.createObjectURL(r.blob);
      if (r.cover) vPreview.poster = r.cover; else vPreview.removeAttribute('poster');
      vPreview.src = videoUrl;
      vPreview.style.display = '';
      vDlBtn.style.display = '';
      vShareBtn.style.display = '';
      vNote.textContent = (r.usedVectorFallback && !vectorCb.checked ? '⚠ ' + t('export.posterVectorFallback') + ' · ' : '') +
        t('export.videoReady', { size: (r.blob.size / 1048576).toFixed(1) + 'MB' });
    } catch (e) {
      if (e.name === 'AbortError') vNote.textContent = '';
      else if (e.message === 'no-track') toast(t('export.videoNoTrack'), 'warn');
      else if (e.message === 'video-unsupported') toast(t('export.videoUnsupported'), 'warn');
      else { console.error(e); toast(String(e.message || e), 'err'); }
    }
    videoAbort = null;
    vGenBtn.disabled = !videoOk;
    tripSel.disabled = false;
    vGenBtn.innerHTML = '';
    vGenBtn.append(icon('play', 15), t('export.generateShort'));
    vCancelBtn.style.display = 'none';
    durToggle.querySelectorAll('button').forEach((x) => { x.disabled = false; });
  };
  vDlBtn.onclick = () => {
    if (!videoBlob) return;
    exportFile(videoBlob, `localtrace-video-${Date.now()}.${videoExt}`);
    toast(t('export.exported'), 'ok');
  };
  if (!videoOk) vGenBtn.disabled = true;
  const videoCard = el('div', { class: 'card' },
    el('h3', {}, '🎬 ' + t('export.video')),
    el('div', { class: 'small faint', style: { marginBottom: '8px' } }, t('export.videoHint')),
    videoOk ? null : el('div', { class: 'debug-banner' }, '⚠ ' + t('export.videoUnsupported')),
    isWeChat() ? el('div', { class: 'small', style: { color: 'var(--warn)', marginBottom: '8px' } }, t('export.videoWechatHint')) : null,
    el('div', { class: 'card-line' }, durToggle, vGenBtn, vCancelBtn, vDlBtn, vShareBtn),
    vNote,
    vPreview
  );

  // ---- standard files ----
  function croppedFull() {
    const full = curFull;
    if (!full) return null;
    const c = applyPrivacy(full, privacyOpts());
    return { ...full, segments: c.segments, waypoints: c.waypoints };
  }
  const fileBtn = (label, hint, fn) => {
    const b = el('button', { class: 'btn block', style: { justifyContent: 'flex-start', marginBottom: '8px' } }, icon('download', 16),
      el('span', { style: { textAlign: 'left' } }, el('div', {}, label), el('div', { class: 'small faint', style: { fontWeight: 400 } }, hint)));
    b.onclick = fn;
    return b;
  };
  const filesCard = el('div', { class: 'card' },
    el('h3', {}, '📁 ' + t('common.export')),
    fileBtn(t('export.gpx'), t('export.gpxHint'), () => {
      const f = croppedFull();
      if (!f) return toast(t('analysis.noTrip'), 'warn');
      exportFile(new Blob([buildGPX(f)], { type: 'application/gpx+xml' }), `${f.trip.name || 'trip'}.gpx`);
      toast(t('export.exported'), 'ok');
    }),
    fileBtn(t('export.geojson'), 'WGS-84 · RFC 7946', () => {
      const f = croppedFull();
      if (!f) return toast(t('analysis.noTrip'), 'warn');
      exportFile(new Blob([JSON.stringify(buildGeoJSON(f), null, 1)], { type: 'application/geo+json' }), `${f.trip.name || 'trip'}.geojson`);
      toast(t('export.exported'), 'ok');
    }),
    fileBtn(t('export.kml'), 'Google Earth / 奥维', () => {
      const f = croppedFull();
      if (!f) return toast(t('analysis.noTrip'), 'warn');
      exportFile(new Blob([buildKML(f)], { type: 'application/vnd.google-earth.kml+xml' }), `${f.trip.name || 'trip'}.kml`);
      toast(t('export.exported'), 'ok');
    })
  );

  // ---- self-contained HTML ----
  let htmlTier = 'clear';
  const tierToggle = el('div', { class: 'seg-toggle' });
  for (const [k, label] of [['clear', t('export.htmlClear')], ['light', t('export.htmlLight')], ['none', t('export.htmlNone')]]) {
    const b = el('button', { class: k === htmlTier ? 'active' : '' }, label);
    b.onclick = () => { htmlTier = k; tierToggle.querySelectorAll('button').forEach((x) => x.classList.remove('active')); b.classList.add('active'); };
    tierToggle.append(b);
  }
  const htmlBtn = el('button', { class: 'btn' }, icon('export', 16), t('export.html'));
  htmlBtn.onclick = () => {
    const f = croppedFull();
    if (!f) return toast(t('analysis.noTrip'), 'warn');
    const { html, size } = buildSelfContainedHTML(f, { tier: htmlTier, privacy: privacyOpts() });
    if (size > 1_500_000) toast(t('export.htmlWarn', { size: (size / 1048576).toFixed(1) + 'MB' }), 'warn', 4000);
    exportFile(new Blob([html], { type: 'text/html' }), `${f.trip.name || 'trip'}.html`);
    toast(`${t('export.exported')} · ${(size / 1024).toFixed(0)} KB`, 'ok');
  };
  const htmlCard = el('div', { class: 'card' },
    el('h3', {}, '📄 ' + t('export.html')),
    el('div', { class: 'small faint', style: { marginBottom: '8px' } }, t('export.htmlHint')),
    el('div', { class: 'row wrap' }, tierToggle, htmlBtn)
  );

  // ---- share link ----
  const linkInput = el('input', { type: 'text', readonly: true, style: { width: '100%', fontSize: '11px' } });
  const linkBtn = el('button', { class: 'btn sm' }, icon('share', 14), t('export.link'));
  const copyBtn = el('button', { class: 'btn sm' }, t('common.copy'));
  const linkNote = el('div', { class: 'small faint', style: { marginTop: '6px' } });
  linkBtn.onclick = () => {
    const full = curFull;
    if (!full) return toast(t('analysis.noTrip'), 'warn');
    try {
      const { url, size } = buildShareLink(full, privacyOpts());
      linkInput.value = url;
      linkNote.textContent = `${size} B / 1500 B · fragment only, no server`;
    } catch (e) {
      if (e.message === 'too-big') toast(t('export.qrTooBig'), 'warn');
      else toast(String(e.message), 'err');
    }
  };
  copyBtn.onclick = async () => {
    if (!linkInput.value) return;
    try {
      await navigator.clipboard.writeText(linkInput.value);
      toast(t('common.copied'), 'ok');
    } catch {
      linkInput.select();
      toast(t('toast.copyFail'), 'warn');
    }
  };
  const shareBtn = el('button', { class: 'btn sm' }, icon('share', 14), t('export.shareNative'));
  shareBtn.style.display = navigator.share ? '' : 'none';
  shareBtn.onclick = async () => {
    const full = curFull;
    if (!full) return;
    const ok = await nativeShare({ title: full.trip.name, text: t('app.tagline'), url: linkInput.value || undefined });
    if (!ok) toast(t('toast.copyFail'), 'warn');
  };
  const linkCard = el('div', { class: 'card' },
    el('h3', {}, '🔗 ' + t('export.link')),
    el('div', { class: 'row wrap', style: { marginBottom: '8px' } }, linkBtn, copyBtn, shareBtn),
    linkInput, linkNote
  );

  const wechatBanner = isWeChat()
    ? el('div', { class: 'debug-banner' }, '⚠ ' + t('export.openInBrowser'))
    : null;

  scroll.append(...[title, tripCard, wechatBanner, privacyCard, posterCard, videoCard, filesCard, htmlCard, linkCard].filter(Boolean));

  function resetOutputs() {
    posterBlob = null;
    videoBlob = null;
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
  async function pickTrip(id) {
    curFull = id ? await loadTripFull(id) : null;
    resetOutputs();
    refresh();
  }
  async function refreshTripList() {
    const trips = await listTrips();
    const keep = tripSel.value || appState.activeTripId || trips[0]?.id || '';
    tripSel.innerHTML = '';
    tripSel.append(el('option', { value: '' }, '—'));
    for (const tr of trips) tripSel.append(el('option', { value: tr.id }, tr.name || new Date(tr.createdAt).toLocaleString()));
    tripSel.value = trips.some((tr) => tr.id === keep) ? keep : '';
    if (tripSel.value !== (curFull?.trip.id || '')) await pickTrip(tripSel.value);
    else refresh();
  }
  function refresh() {
    tripLabel.textContent = curFull
      ? `${curFull.trip.name || t('record.newTripName')} · ${t(`record.activities.${curFull.trip.activity}`)}`
      : t('analysis.noTrip');
    updateCropInfo();
  }
  on('trip:active', (full) => {
    if (full && full.trip.id !== curFull?.trip.id) {
      tripSel.value = full.trip.id;
      pickTrip(full.trip.id);
    } else refresh();
  });
  refreshTripList();

  return { view, refresh: refreshTripList, resize: () => {} };
}