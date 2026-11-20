// Waypoint & track-point editing with undo/redo and async stat recalculation.
// All write-backs are WGS-84 (map layer already inverse-transforms GCJ-02 picks).
import { t } from '../core/i18n';
import { emit } from '../core/events';
import * as store from '../core/store';
import { processPhoto } from '../core/photos';
import { resolveAltitude } from '../core/elevation';
import { pushAction, undo, redo, state as histState } from '../core/history';
import { appState, refreshActiveTrip, scheduleAltBackfill } from './state';
import { el, icon, modal, toast, confirmModal, filePicker } from './helpers';
import { WP_ICONS } from './map';

const WP_TYPES = ['start', 'end', 'view', 'photo', 'stay', 'food', 'supply', 'danger', 'fuel', 'custom'];

function segById(id) {
  return appState.activeTripFull?.segments.find((s) => s.id === id);
}

async function afterEdit() {
  await refreshActiveTrip();
}

// ---------------- waypoints ----------------
export function openWaypointModal(wpOrPos, opts: any = {}) {
  const isNew = !wpOrPos.id;
  const tripId = opts.tripId || appState.activeTripId;
  if (!tripId) { toast(t('analysis.noTrip'), 'warn'); return; }
  const wp = isNew
    ? { lat: wpOrPos.lat, lon: wpOrPos.lon, name: '', desc: '', type: 'custom', time: Date.now(), hidden: false, mediaIds: [], alt: null }
    : { ...wpOrPos };
  let pendingPhotos = [];   // {blob, thumb, width, height}
  let removedMedia = [];

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
  async function renderPhotos() {
    strip.innerHTML = '';
    for (const mid of wp.mediaIds || []) {
      const m = await store.getMedia(mid);
      if (!m) continue;
      const url = URL.createObjectURL(m.thumb || m.blob);
      const ph = el('div', { class: 'ph' },
        el('img', { src: url }),
        el('button', { class: 'rm', onclick: () => { wp.mediaIds = wp.mediaIds.filter((x) => x !== mid); removedMedia.push(mid); renderPhotos(); } }, '✕'));
      strip.append(ph);
    }
    for (const p of pendingPhotos) {
      const url = URL.createObjectURL(p.thumb);
      const ph = el('div', { class: 'ph' },
        el('img', { src: url }),
        el('button', { class: 'rm', onclick: () => { pendingPhotos = pendingPhotos.filter((x) => x !== p); renderPhotos(); } }, '✕'));
      strip.append(ph);
    }
  }
  renderPhotos();

  const addPhotoBtn = el('button', { class: 'btn sm', type: 'button' }, icon('camera', 15), t('wp.addPhoto'));
  addPhotoBtn.onclick = async () => {
    const file = await filePicker('image/*');
    if (!file) return;
    try {
      const processed = await processPhoto(file);
      pendingPhotos.push(processed);
      if (processed.exif?.lat != null && isNew && !wpOrPos.lat) {
        wp.lat = processed.exif.lat; wp.lon = processed.exif.lon;
      }
      if (processed.exif?.time && !wp.time) wp.time = processed.exif.time;
      toast(t('wp.photoRotated'), 'ok');
      renderPhotos();
    } catch (e) {
      console.error(e);
      toast(t('wp.photoErr'), 'err');
    }
  };

  const body = el('div', {},
    el('div', { class: 'field' }, el('label', {}, t('wp.name')), nameInput),
    el('div', { class: 'field' }, el('label', {}, t('wp.type')), typeGrid),
    el('div', { class: 'field' }, el('label', {}, t('wp.desc')), descInput),
    el('div', { class: 'field' }, el('label', {}, t('wp.time')), timeInput),
    el('div', { class: 'field' }, el('label', {}, t('wp.photos')), strip, el('div', { style: { marginTop: '8px' } }, addPhotoBtn),
      el('div', { class: 'hint' }, t('wp.photoExif'))),
    el('label', { class: 'row', style: { cursor: 'pointer', fontSize: '13px' } }, hiddenCb, t('wp.hidden')),
    el('div', { class: 'hint mono', style: { marginTop: '10px' } }, `${wp.lat?.toFixed(5)}, ${wp.lon?.toFixed(5)} (WGS-84)`)
  );

  const m = modal({
    title: isNew ? t('wp.add') : t('wp.edit'),
    body,
    footer: [
      !isNew ? el('button', { class: 'btn danger', onclick: async () => { m.close(); await deleteWaypointAction(wp); opts.onSaved?.(); } }, icon('trash', 15), t('common.delete')) : null,
      el('button', { class: 'btn ghost', onclick: () => m.close() }, t('common.cancel')),
      el('button', { class: 'btn primary', onclick: save }, t('common.save'))
    ]
  });

  async function save() {
    wp.name = nameInput.value.trim();
    wp.desc = descInput.value.trim();
    wp.time = timeInput.value ? new Date(timeInput.value).getTime() : Date.now();
    wp.hidden = hiddenCb.checked;
    // persist new photos (EXIF already stripped by re-encode)
    for (const p of pendingPhotos) {
      const mrec = await store.addMedia({ tripId, blob: p.blob, thumb: p.thumb, width: p.width, height: p.height });
      wp.mediaIds = [...(wp.mediaIds || []), mrec.id];
    }
    for (const mid of removedMedia) await store.deleteMedia(mid);
    if (wp.alt == null) {
      const r = await resolveAltitude(wp.lat, wp.lon, null, null);
      wp.alt = r.alt;
    }
    if (isNew) {
      const before = { ...wp };
      const created = await store.addWaypoint({ ...wp, tripId });
      pushAction({
        label: 'wp-add',
        undo: async () => { await store.deleteWaypoint(created.id); await afterEdit(); },
        redo: async () => { await store.db.waypoints.put(created); await afterEdit(); }
      });
    } else {
      const prev = await store.getWaypoint(wp.id);
      await store.updateWaypoint(wp.id, wp);
      pushAction({
        label: 'wp-edit',
        undo: async () => { await store.db.waypoints.put(prev); await afterEdit(); },
        redo: async () => { await store.db.waypoints.put({ ...wp }); await afterEdit(); }
      });
    }
    m.close();
    toast(t('wp.saved'), 'ok');
    await afterEdit();
    opts.onSaved?.();
  }
}

export async function moveWaypoint(wp, lon, lat) {
  const prev = { lon: wp.lon, lat: wp.lat, alt: wp.alt };
  await store.updateWaypoint(wp.id, { lon, lat, alt: null });
  pushAction({
    label: 'wp-move',
    undo: async () => { await store.updateWaypoint(wp.id, prev); await afterEdit(); },
    redo: async () => { await store.updateWaypoint(wp.id, { lon, lat, alt: null }); await afterEdit(); }
  });
  toast(t('wp.dragHint'), 'info', 1500);
  await afterEdit();
  scheduleAltBackfill();
}

export async function deleteWaypointAction(wp) {
  const ok = await confirmModal({ title: t('common.delete'), message: t('wp.deleteConfirm'), danger: true, confirmText: t('common.delete') });
  if (!ok) return;
  const full = await store.getWaypoint(wp.id);
  await store.deleteWaypoint(wp.id);
  pushAction({
    label: 'wp-del',
    undo: async () => { await store.db.waypoints.put(full); await afterEdit(); },
    redo: async () => { await store.deleteWaypoint(wp.id); await afterEdit(); }
  });
  toast(t('wp.deleted'), 'ok');
  await afterEdit();
}

// ---------------- track vertices ----------------
export async function moveVertex(segId, idx, lon, lat) {
  const seg = segById(segId);
  if (!seg || !seg.points[idx]) return;
  const before = seg.points.map((p) => ({ ...p }));
  const pts = seg.points.map((p, i) => (i === idx ? { ...p, lon, lat, alt: null, altSrc: null } : p));
  await store.replaceSegmentPoints(segId, appState.activeTripId, pts);
  pushAction({
    label: 'v-move',
    undo: async () => { await store.replaceSegmentPoints(segId, appState.activeTripId, before); await afterEdit(); },
    redo: async () => { await store.replaceSegmentPoints(segId, appState.activeTripId, pts); await afterEdit(); }
  });
  toast(t('wp.pointMoved'), 'info', 2000);
  await afterEdit();
  scheduleAltBackfill();
}

export async function insertVertex(segId, afterIdx, lon, lat) {
  const seg = segById(segId);
  if (!seg) return;
  const before = seg.points.map((p) => ({ ...p }));
  const a = seg.points[afterIdx], b = seg.points[afterIdx + 1];
  const t = a?.t && b?.t ? Math.round((a.t + b.t) / 2) : (a?.t || Date.now());
  const np = { lat, lon, t, alt: null, altSrc: null, acc: null, speed: null };
  const pts = [...seg.points.slice(0, afterIdx + 1), np, ...seg.points.slice(afterIdx + 1)];
  await store.replaceSegmentPoints(segId, appState.activeTripId, pts);
  pushAction({
    label: 'v-insert',
    undo: async () => { await store.replaceSegmentPoints(segId, appState.activeTripId, before); await afterEdit(); },
    redo: async () => { await store.replaceSegmentPoints(segId, appState.activeTripId, pts); await afterEdit(); }
  });
  await afterEdit();
  scheduleAltBackfill();
}

export async function deleteVertex(segId, idx) {
  const seg = segById(segId);
  if (!seg || seg.points.length <= 2) return;
  const before = seg.points.map((p) => ({ ...p }));
  const pts = seg.points.filter((_, i) => i !== idx);
  await store.replaceSegmentPoints(segId, appState.activeTripId, pts);
  pushAction({
    label: 'v-del',
    undo: async () => { await store.replaceSegmentPoints(segId, appState.activeTripId, before); await afterEdit(); },
    redo: async () => { await store.replaceSegmentPoints(segId, appState.activeTripId, pts); await afterEdit(); }
  });
  await afterEdit();
}

export async function splitSegmentAt(segId, idx) {
  const seg = segById(segId);
  if (!seg || idx <= 0 || idx >= seg.points.length - 1) return;
  const tripId = appState.activeTripId;
  const before = seg.points.map((p) => ({ ...p }));
  const left = seg.points.slice(0, idx + 1);
  const right = seg.points.slice(idx + 1);
  const newSeg = await store.addSegment(tripId, right[0]?.t);
  await store.replaceSegmentPoints(segId, tripId, left);
  await store.replaceSegmentPoints(newSeg.id, tripId, right);
  pushAction({
    label: 'seg-split',
    undo: async () => {
      await store.replaceSegmentPoints(segId, tripId, before);
      await store.db.trackChunks.where('segmentId').equals(newSeg.id).delete();
      await store.db.segments.delete(newSeg.id);
      await afterEdit();
    },
    redo: async () => {
      await store.replaceSegmentPoints(segId, tripId, left);
      await store.db.segments.put(newSeg);
      await store.replaceSegmentPoints(newSeg.id, tripId, right);
      await afterEdit();
    }
  });
  toast(t('wp.segSplit'), 'ok');
  await afterEdit();
}

// ---------------- undo / redo ----------------
export async function undoEdit() {
  if (!(await undo())) { toast(t('edit.nothingUndo'), 'info', 1500); return; }
  toast(t('edit.undone'), 'ok', 1400);
  await afterEdit();
}
export async function redoEdit() {
  if (!(await redo())) return;
  toast(t('edit.redone'), 'ok', 1400);
  await afterEdit();
}
export { histState };

function toLocalInput(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}