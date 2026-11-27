// Waypoint & track-point editing with undo/redo and async stat recalculation.
// All write-backs are WGS-84 (map layer already inverse-transforms GCJ-02 picks).
import { t } from '../core/i18n';
import { emit } from '../core/events';
import * as store from '../core/store';
import { processPhoto } from '../core/photos';
import { readLocalImageHeader } from '../core/chatImage';
import { resolveAltitude } from '../core/elevation';
import { pushAction, undo, redo, state as histState, type EditScope } from '../core/history';
import { appState, refreshActiveTrip, scheduleAltBackfill } from './state';
import { el, icon, modal, toast, confirmModal, filePickerMulti } from './helpers';
import { openCamera } from './camera';
import { WP_ICONS } from '../core/waypointMeta';

const WP_TYPES = ['start', 'end', 'view', 'photo', 'stay', 'food', 'supply', 'danger', 'fuel', 'custom'];

function segById(id) {
  return appState.activeTripFull?.segments.find((s) => s.id === id);
}

type EditContext = EditScope & { view: string; scopeCurrent?: () => boolean };

function captureEdit(tripId = appState.activeTripId, scopeCurrent?: () => boolean): EditContext | null {
  return tripId ? { tripId, session: appState.tripSession, view: appState.view, scopeCurrent } : null;
}

function isCurrentEdit(context: EditContext | null) {
  return !!context && context.session === appState.tripSession && context.view === appState.view
    && (context.scopeCurrent ? context.scopeCurrent() : context.tripId === appState.activeTripId);
}

async function afterEdit(context: EditContext | null) {
  if (!isCurrentEdit(context)) return null;
  const full = await refreshActiveTrip(context.tripId, { session: context.session, view: context.view });
  return isCurrentEdit(context) ? full : null;
}

function pushEditAction(context: EditContext, action: { label: string; undo: () => unknown; redo: () => unknown }) {
  pushAction({ ...context, ...action });
}

async function replaceSegmentPointsEdit(context: EditContext, segmentId: string, points: any[], expectedPoints: any[]) {
  try {
    await store.replaceSegmentPoints(segmentId, context.tripId, points, expectedPoints);
    return true;
  } catch (error) {
    if (error?.message !== 'track-changed') throw error;
    await afterEdit(context);
    if (isCurrentEdit(context)) toast(t('analysis.qualityChanged'), 'warn');
    return false;
  }
}

// ---------------- waypoints ----------------
export function openWaypointModal(wpOrPos, opts: any = {}) {
  const isNew = !wpOrPos.id;
  const tripId = opts.tripId || appState.activeTripId;
  if (!tripId) { toast(t('analysis.noTrip'), 'warn'); return; }
  const context = captureEdit(tripId, opts.scopeCurrent);
  const wp = isNew
    ? {
      lat: wpOrPos.lat, lon: wpOrPos.lon, name: '', desc: '', type: 'custom',
      time: Number.isFinite(wpOrPos.time) ? wpOrPos.time : Date.now(),
      hidden: false, mediaIds: [], alt: null
    }
    : { ...wpOrPos };
  let pendingPhotos = [];   // {key, blob, thumb, width, height}
  let removedMedia = [];
  let photoKey = 0;
  let photoRenderSeq = 0;
  const stripUrls = new Set<string>();

  const nameInput = el('input', { type: 'text', value: wp.name, placeholder: t('wp.name') });
  const descInput = el('textarea', {}, wp.desc || '');
  const timeInput = el('input', { type: 'datetime-local', value: toLocalInput(wp.time) });
  const hiddenCb = el('input', { type: 'checkbox' });
  hiddenCb.checked = !!wp.hidden;

  const typeGrid = el('div', { class: 'wp-type-grid' });
  for (const ty of WP_TYPES) {
    const b = el('button', { class: ty === wp.type ? 'active' : '', type: 'button' },
      el('span', { class: 'ic' }, WP_ICONS[ty]), t(`wp.types.${ty}`));
    b.onclick = () => {
      wp.type = ty;
      typeGrid.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    };
    typeGrid.append(b);
  }

  const strip = el('div', { class: 'photo-strip' });
  const clearStripUrls = () => {
    for (const url of stripUrls) {
      try { URL.revokeObjectURL(url); } catch { /* already revoked */ }
    }
    stripUrls.clear();
  };
  async function renderPhotos() {
    const seq = ++photoRenderSeq;
    clearStripUrls();
    strip.innerHTML = '';
    const stored = [];
    for (const mid of wp.mediaIds || []) {
      const m = await store.getMedia(mid);
      if (seq !== photoRenderSeq) return;
      if (m) stored.push({ mid, m });
    }
    if (seq !== photoRenderSeq) return;
    for (const { mid, m } of stored) {
      const url = URL.createObjectURL(m.thumb || m.blob);
      stripUrls.add(url);
      const ph = el('div', { class: 'ph' },
        el('img', { src: url }),
        el('button', { class: 'rm', onclick: () => { wp.mediaIds = wp.mediaIds.filter((x) => x !== mid); removedMedia.push(mid); renderPhotos(); } }, '✕'));
      strip.append(ph);
    }
    for (const p of pendingPhotos) {
      const url = URL.createObjectURL(p.thumb);
      stripUrls.add(url);
      const ph = el('div', { class: 'ph' },
        el('img', { src: url }),
        el('button', { class: 'rm', onclick: () => { pendingPhotos = pendingPhotos.filter((x) => x !== p); renderPhotos(); } }, '✕'));
      strip.append(ph);
    }
  }
  renderPhotos();

  const pickPhotoBtn = el('button', { class: 'btn sm', type: 'button' }, icon('photo', 15), t('wp.selectPhotos'));
  const takePhotoBtn = el('button', { class: 'btn sm', type: 'button' }, icon('camera', 15), t('wp.takePhotos'));
  const photoActions = el('div', { class: 'row wrap', style: { marginTop: '8px', gap: '8px' } }, pickPhotoBtn, takePhotoBtn);

  function setPhotoBusy(on: boolean) {
    pickPhotoBtn.disabled = on;
    takePhotoBtn.disabled = on;
  }

  function addPendingPhoto(photo) {
    const entry = { key: ++photoKey, ...photo };
    pendingPhotos.push(entry);
    if (photo.exif?.lat != null && isNew && !wpOrPos.lat) {
      wp.lat = photo.exif.lat; wp.lon = photo.exif.lon;
    }
    if (photo.exif?.time && !wp.time) wp.time = photo.exif.time;
    renderPhotos();
    return entry;
  }

  pickPhotoBtn.onclick = async () => {
    const files = await filePickerMulti('image/*');
    if (!files.length) return;
    setPhotoBusy(true);
    let added = 0;
    let failed = 0;
    try {
      for (const file of files) {
        if (!(await readLocalImageHeader(file))) { failed++; continue; }
        try {
          addPendingPhoto(await processPhoto(file));
          added++;
        } catch {
          failed++;
        }
      }
      if (added) toast(t('wp.photoBatchOk', { n: added }), 'ok');
      if (failed) toast(t('wp.photoBatchFail', { n: failed }), 'warn', 3200);
    } finally {
      setPhotoBusy(false);
    }
  };

  takePhotoBtn.onclick = () => {
    if (!Number.isFinite(Number(wp.lat)) || !Number.isFinite(Number(wp.lon))) {
      toast(t('wp.photoNoCoord'), 'warn');
      return;
    }
    openCamera({
      mode: 'quick',
      getFix: () => ({ lat: wp.lat, lon: wp.lon, alt: wp.alt ?? null, acc: null }),
      onQuickSave: async (shot) => {
        const entry = { key: ++photoKey, blob: shot.blob, thumb: shot.thumb, width: shot.width, height: shot.height };
        pendingPhotos.push(entry);
        renderPhotos();
        const thumbUrl = URL.createObjectURL(shot.thumb);
        return {
          ok: true,
          label: t('wp.photoAdded'),
          thumbUrl,
          undo: async () => {
            const before = pendingPhotos.length;
            pendingPhotos = pendingPhotos.filter((p) => p !== entry);
            renderPhotos();
            return pendingPhotos.length < before;
          }
        };
      }
    });
  };

  const body = el('div', {},
    el('div', { class: 'field' }, el('label', {}, t('wp.name')), nameInput),
    el('div', { class: 'field' }, el('label', {}, t('wp.type')), typeGrid),
    el('div', { class: 'field' }, el('label', {}, t('wp.desc')), descInput),
    el('div', { class: 'field' }, el('label', {}, t('wp.time')), timeInput),
    el('div', { class: 'field' }, el('label', {}, t('wp.photos')), strip, photoActions,
      el('div', { class: 'hint' }, t('wp.photoExif'))),
    el('label', { class: 'row', style: { cursor: 'pointer', fontSize: '13px' } }, hiddenCb, t('wp.hidden')),
    el('div', { class: 'hint mono', style: { marginTop: '10px' } }, `${wp.lat?.toFixed(5)}, ${wp.lon?.toFixed(5)} (WGS-84)`)
  );

  const m = modal({
    title: isNew ? t('wp.add') : t('wp.edit'),
    body,
    footer: [
      !isNew ? el('button', { class: 'btn danger', onclick: async () => { m.close(); const full = await deleteWaypointAction(wp, opts); await opts.onSaved?.(full); } }, icon('trash', 15), t('common.delete')) : null,
      el('button', { class: 'btn ghost', onclick: () => m.close() }, t('common.cancel')),
      el('button', { class: 'btn primary', onclick: save }, t('common.save'))
    ],
    onClose: () => {
      photoRenderSeq++;
      clearStripUrls();
    }
  });

  async function save() {
    wp.name = nameInput.value.trim();
    wp.desc = descInput.value.trim();
    wp.time = timeInput.value ? new Date(timeInput.value).getTime() : Date.now();
    wp.hidden = hiddenCb.checked;
    if (!isCurrentEdit(context)) { m.close(); return; }
    if (wp.alt == null) {
      const r = await resolveAltitude(wp.lat, wp.lon, null, null);
      wp.alt = r.alt;
    }
    if (!isCurrentEdit(context)) { m.close(); return; }
    const prev = isNew ? null : await store.getWaypoint(wp.id);
    if (!isCurrentEdit(context)) { m.close(); return; }
    const saved = await store.saveWaypointWithMedia({
      waypoint: wp, tripId, photos: pendingPhotos, removedMediaIds: removedMedia, isNew
    });
    if (!isCurrentEdit(context)) { m.close(); return; }
    if (isNew) {
      pushEditAction(context, {
        label: 'wp-add',
        undo: async () => { await store.deleteWaypoint(saved.id); await afterEdit(context); },
        redo: async () => { await store.putWaypoint(saved); await afterEdit(context); }
      });
    } else {
      pushEditAction(context, {
        label: 'wp-edit',
        undo: async () => { await store.putWaypoint(prev); await afterEdit(context); },
        redo: async () => { await store.putWaypoint(saved); await afterEdit(context); }
      });
    }
    m.close();
    toast(t('wp.saved'), 'ok');
    const full = await afterEdit(context);
    await opts.onSaved?.(full);
  }
}

export async function moveWaypoint(wp, lon, lat, opts: any = {}) {
  const tripId = wp.tripId || opts.tripId || appState.activeTripId;
  const context = captureEdit(tripId, opts.scopeCurrent);
  if (!isCurrentEdit(context)) return;
  const prev = { lon: wp.lon, lat: wp.lat, alt: wp.alt };
  await store.updateWaypoint(wp.id, { lon, lat, alt: null });
  if (!isCurrentEdit(context)) return;
  pushEditAction(context, {
    label: 'wp-move',
    undo: async () => { await store.updateWaypoint(wp.id, prev); await afterEdit(context); },
    redo: async () => { await store.updateWaypoint(wp.id, { lon, lat, alt: null }); await afterEdit(context); }
  });
  toast(t('wp.dragHint'), 'info', 1500);
  await afterEdit(context);
  scheduleAltBackfill(tripId);
}

export async function deleteWaypointAction(wp, opts: any = {}) {
  const tripId = wp.tripId || opts.tripId || appState.activeTripId;
  const context = captureEdit(tripId, opts.scopeCurrent);
  const ok = await confirmModal({ title: t('common.delete'), message: t('wp.deleteConfirm'), danger: true, confirmText: t('common.delete') });
  if (!ok || !context) return null;
  const waypoint = await store.getWaypoint(wp.id);
  if (!waypoint || waypoint.tripId !== tripId || !isCurrentEdit(context)) return null;
  await store.deleteWaypoint(wp.id);
  if (!isCurrentEdit(context)) return null;
  pushEditAction(context, {
    label: 'wp-del',
    undo: async () => { await store.putWaypoint(waypoint); await afterEdit(context); },
    redo: async () => { await store.deleteWaypoint(wp.id); await afterEdit(context); }
  });
  toast(t('wp.deleted'), 'ok');
  return afterEdit(context);
}

// ---------------- track vertices ----------------
export async function moveVertex(segId, idx, lon, lat) {
  const tripId = appState.activeTripId;
  const context = captureEdit(tripId);
  const seg = segById(segId);
  if (!context || !seg || !seg.points[idx]) return;
  const before = seg.points.map((p) => ({ ...p }));
  const pts = seg.points.map((p, i) => (i === idx ? { ...p, lon, lat, alt: null, altSrc: null } : p));
  if (!await replaceSegmentPointsEdit(context, segId, pts, before)) return;
  if (!isCurrentEdit(context)) return;
  pushEditAction(context, {
    label: 'v-move',
    undo: async () => {
      if (!isCurrentEdit(context)) return;
      await store.replaceSegmentPoints(segId, context.tripId, before, pts);
      await afterEdit(context);
    },
    redo: async () => {
      if (!isCurrentEdit(context)) return;
      await store.replaceSegmentPoints(segId, context.tripId, pts, before);
      await afterEdit(context);
    }
  });
  toast(t('wp.pointMoved'), 'info', 2000);
  await afterEdit(context);
  scheduleAltBackfill(tripId);
}

export async function insertVertex(segId, afterIdx, lon, lat) {
  const tripId = appState.activeTripId;
  const context = captureEdit(tripId);
  const seg = segById(segId);
  if (!context || !seg) return;
  const before = seg.points.map((p) => ({ ...p }));
  const a = seg.points[afterIdx], b = seg.points[afterIdx + 1];
  const t = a?.t && b?.t ? Math.round((a.t + b.t) / 2) : (a?.t || Date.now());
  const np = { lat, lon, t, alt: null, altSrc: null, acc: null, speed: null };
  const pts = [...seg.points.slice(0, afterIdx + 1), np, ...seg.points.slice(afterIdx + 1)];
  if (!await replaceSegmentPointsEdit(context, segId, pts, before)) return;
  if (!isCurrentEdit(context)) return;
  pushEditAction(context, {
    label: 'v-insert',
    undo: async () => {
      if (!isCurrentEdit(context)) return;
      await store.replaceSegmentPoints(segId, context.tripId, before, pts);
      await afterEdit(context);
    },
    redo: async () => {
      if (!isCurrentEdit(context)) return;
      await store.replaceSegmentPoints(segId, context.tripId, pts, before);
      await afterEdit(context);
    }
  });
  await afterEdit(context);
  scheduleAltBackfill(tripId);
}

export async function deleteVertex(segId, idx) {
  const tripId = appState.activeTripId;
  const context = captureEdit(tripId);
  const seg = segById(segId);
  if (!context || !seg || seg.points.length <= 2) return;
  const before = seg.points.map((p) => ({ ...p }));
  const pts = seg.points.filter((_, i) => i !== idx);
  if (!await replaceSegmentPointsEdit(context, segId, pts, before)) return;
  if (!isCurrentEdit(context)) return;
  pushEditAction(context, {
    label: 'v-del',
    undo: async () => {
      if (!isCurrentEdit(context)) return;
      await store.replaceSegmentPoints(segId, context.tripId, before, pts);
      await afterEdit(context);
    },
    redo: async () => {
      if (!isCurrentEdit(context)) return;
      await store.replaceSegmentPoints(segId, context.tripId, pts, before);
      await afterEdit(context);
    }
  });
  await afterEdit(context);
}

export async function splitSegmentAt(segId, idx) {
  const tripId = appState.activeTripId;
  const context = captureEdit(tripId);
  const seg = segById(segId);
  if (!context || !seg || idx <= 0 || idx >= seg.points.length - 1) return;
  const before = seg.points.map((p) => ({ ...p }));
  const left = seg.points.slice(0, idx + 1);
  const right = seg.points.slice(idx + 1);
  const newSeg = await store.addSegment(tripId, right[0]?.t);
  if (!await replaceSegmentPointsEdit(context, segId, left, before)) return;
  if (!await replaceSegmentPointsEdit(context, newSeg.id, right, [])) return;
  if (!isCurrentEdit(context)) return;
  pushEditAction(context, {
    label: 'seg-split',
    undo: async () => {
      if (!isCurrentEdit(context)) return;
      await store.replaceSegmentPoints(segId, context.tripId, before, left);
      await store.deleteSegment(newSeg.id);
      await afterEdit(context);
    },
    redo: async () => {
      if (!isCurrentEdit(context)) return;
      await store.replaceSegmentPoints(segId, context.tripId, left, before);
      await store.restoreSegment(newSeg);
      await store.replaceSegmentPoints(newSeg.id, context.tripId, right, []);
      await afterEdit(context);
    }
  });
  toast(t('wp.segSplit'), 'ok');
  await afterEdit(context);
}

// ---------------- undo / redo ----------------
export async function undoEdit(opts: any = {}) {
  const context = captureEdit(opts.tripId || appState.activeTripId, opts.scopeCurrent);
  if (!context) return;
  const changed = await undo(context);
  if (!isCurrentEdit(context)) return;
  if (!changed) { toast(t('edit.nothingUndo'), 'info', 1500); return; }
  toast(t('edit.undone'), 'ok', 1400);
}
export async function redoEdit(opts: any = {}) {
  const context = captureEdit(opts.tripId || appState.activeTripId, opts.scopeCurrent);
  if (!context) return;
  const changed = await redo(context);
  if (!changed || !isCurrentEdit(context)) return;
  toast(t('edit.redone'), 'ok', 1400);
}
export { histState };

function toLocalInput(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}