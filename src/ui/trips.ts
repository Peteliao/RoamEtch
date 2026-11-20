// Trips list: open/edit/analyze, GPX import, full backup/restore, storage monitor.
import { t } from '../core/i18n';
import { on } from '../core/events';
import { listTrips, deleteTrip, updateTrip, storageEstimate } from '../core/store';
import { importGPX } from '../core/gpx';
import { exportTripsZip, importTripFiles } from '../core/batch';
import { startRewalk } from '../core/rewalk';
import { exportBackup, restoreBackup, inspectBackup } from '../core/backup';
import { triggerDownload } from '../core/gpx';
import { fmtDistance, fmtDuration, simplify } from '../core/geo';
import { get } from '../core/settings';
import { isWeChat, wechatFileGuidance } from '../core/shareEnv';
import { appState, setActiveTrip } from './state';
import { el, icon, toast, confirmModal, promptModal, filePicker, filePickerMulti, modal } from './helpers';

export function createTripsView(navigate) {
  const view = el('div', { class: 'view', id: 'view-trips' });
  const scroll = el('div', { class: 'view-scroll' });
  view.append(scroll);

  const header = el('div', { class: 'row wrap', style: { marginBottom: '12px', gap: '8px' } },
    el('h2', { style: { margin: 0, fontSize: '18px', flex: '1' } }, t('trips.title')),
    el('button', { class: 'btn sm', onclick: onImport }, icon('plus', 14), t('trips.importGpx')),
    el('button', { class: 'btn sm', onclick: onBatchImport }, icon('batch', 14), t('trips.batchImport')),
    el('button', { class: 'btn sm', onclick: onBatchExport }, icon('batch', 14), t('trips.batchExport')),
    el('button', { class: 'btn sm', onclick: onBackup }, icon('download', 14), t('trips.backup')),
    el('button', { class: 'btn sm', onclick: onRestore }, icon('export', 14), t('trips.restore'))
  );
  const storageBar = el('div', { class: 'small muted', style: { marginBottom: '10px' } });
  const listBox = el('div', {});
  scroll.append(header, storageBar, listBox);

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

  async function render() {
    const trips = await listTrips();
    listBox.innerHTML = '';
    if (!trips.length) {
      listBox.append(el('div', { class: 'empty-state' },
        el('div', { class: 'big' }, '🥾'),
        el('div', {}, t('trips.empty')),
        el('div', { class: 'small', style: { marginTop: '6px' } }, t('trips.emptyHint'))));
    }
    const units = get('units');
    for (const trip of trips) {
      const st = trip.statsCache;
      const d = st ? fmtDistance(st.distance, units) : null;
      const statusKey = trip.status === 'recording' ? 'statusRecording' : trip.status === 'paused' ? 'statusPaused' : 'statusFinished';
      const item = el('div', { class: 'trip-item', onclick: () => openTrip(trip) },
        el('div', { class: 'thumb', html: thumbSVG(trip.thumbPoints) }),
        el('div', { class: 'info' },
          el('div', { class: 'name' }, trip.name || t('record.newTripName')),
          el('div', { class: 'meta' },
            new Date(trip.createdAt).toLocaleString(),
            ' · ', t(`record.activities.${trip.activity}`),
            ' · ', el('span', { class: 'tag' }, t(`trips.${statusKey}`))),
          el('div', { class: 'stats' },
            d ? `${d.v}${d.u}` : '--', ' · ',
            st ? fmtDuration(st.duration, { compact: true }) : '--', ' · ',
            st ? `↑${Math.round(st.ascent)}m` : '', ' · ',
            t('trips.points', { n: st?.pointCount ?? 0 }))),
        el('div', { class: 'acts' },
          el('button', { class: 'btn sm', title: t('trips.rewalk'), onclick: (e) => { e.stopPropagation(); onRewalk(trip); } }, icon('follow', 14)),
          el('button', { class: 'btn sm', title: t('trips.viewAnalysis'), onclick: (e) => { e.stopPropagation(); openAnalysis(trip); } }, icon('analysis', 14)),
          el('button', { class: 'btn sm', title: t('common.edit'), onclick: (e) => { e.stopPropagation(); renameTrip(trip); } }, icon('edit', 14)),
          el('button', { class: 'btn sm', title: t('common.delete'), onclick: (e) => { e.stopPropagation(); removeTrip(trip); } }, icon('trash', 14)))
      );
      listBox.append(item);
    }
    // storage
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

  async function openTrip(trip) {
    appState.showTripInRecord = true;
    await setActiveTrip(trip.id);
    navigate('record');
    setTimeout(() => {
      const full = appState.activeTripFull;
      if (full) {
        const ev = new CustomEvent('map:fitrequest');
        window.dispatchEvent(ev);
      }
    }, 150);
  }
  async function openAnalysis(trip) {
    await setActiveTrip(trip.id);
    navigate('analysis');
  }
  async function renameTrip(trip) {
    const name = await promptModal({ title: t('trips.rename'), label: t('wp.name'), value: trip.name });
    if (name == null) return;
    await updateTrip(trip.id, { name });
    toast(t('trips.renamed'), 'ok');
    render();
  }
  async function removeTrip(trip) {
    const ok = await confirmModal({ title: t('common.delete'), message: t('trips.deleteConfirm'), danger: true, confirmText: t('common.delete') });
    if (!ok) return;
    await deleteTrip(trip.id);
    if (appState.activeTripId === trip.id) await setActiveTrip(null);
    toast(t('trips.deleted'), 'ok');
    render();
  }

  async function onImport() {
    const file = await filePicker('.gpx,application/gpx+xml,application/xml,text/xml');
    if (!file) return;
    try {
      const text = await file.text();
      const trip = await importGPX(text, file.name.replace(/\.gpx$/i, ''));
      toast(t('trips.importOk', { name: trip.name }), 'ok');
      await setActiveTrip(trip.id);
      render();
    } catch (e) {
      console.error(e);
      toast(t('trips.importErr'), 'err');
    }
  }

  async function onRewalk(trip) {
    const res = await startRewalk(trip.id);
    if (res === 'busy') { toast(t('rewalk.busy'), 'warn'); return; }
    if (res === 'empty') { toast(t('rewalk.empty'), 'warn'); return; }
    navigate('record');
  }

  async function onBatchImport() {
    const files = await filePickerMulti('.gpx,.xml,.zip,application/gpx+xml,application/xml,application/zip');
    if (!files.length) return;
    const { ok, fail } = await importTripFiles(files);
    if (ok) toast(fail ? t('trips.batchImportPartial', { ok, fail }) : t('trips.batchImportOk', { ok }), fail ? 'warn' : 'ok');
    else toast(t('trips.importErr'), 'err');
    render();
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

  async function onBackup() {
    try {
      const { blob, filename, tripCount } = await exportBackup();
      if (isWeChat()) { wechatFileGuidance(); return; }
      triggerDownload(blob, filename);
      toast(t('trips.backupOk', { n: tripCount }), 'ok');
    } catch (e) {
      console.error(e);
      toast(String(e.message || e), 'err');
    }
  }

  async function onRestore() {
    const file = await filePicker('.trip,.zip,application/zip');
    if (!file) return;
    try {
      const { conflicts } = await inspectBackup(file);
      let strategy = 'skip';
      if (conflicts.length) {
        strategy = await new Promise((resolve) => {
          let settled = false;
          const done = (v) => { if (!settled) { settled = true; resolve(v); } };
          const m = modal({
            title: t('trips.restoreConflict', { n: conflicts.length }),
            body: el('p', { class: 'muted small' }, t('trips.restoreConflict', { n: conflicts.length })),
            footer: [
              el('button', { class: 'btn', onclick: () => { done('skip'); m.close(); } }, t('trips.conflictSkip')),
              el('button', { class: 'btn warn', onclick: () => { done('overwrite'); m.close(); } }, t('trips.conflictOverwrite')),
              el('button', { class: 'btn ghost', onclick: () => { done(null); m.close(); } }, t('common.cancel'))
            ],
            onClose: () => done(null)
          });
        });
        if (!strategy) return;
      }
      const n = await restoreBackup(file, strategy);
      toast(t('trips.restoreOk', { n }), 'ok');
      render();
    } catch (e) {
      console.error(e);
      toast(t('trips.restoreErr'), 'err');
    }
  }

  on('trip:stats', async (stats) => {
    // keep a lightweight thumbnail on the trip row
    const full = appState.activeTripFull;
    if (full && stats) {
      const pts = full.segments.flatMap((s) => s.points);
      await updateTrip(full.trip.id, { thumbPoints: simplify(pts, 40).slice(0, 160).map((p) => ({ lat: p.lat, lon: p.lon })) });
    }
  });
  on('backup:restored', render);
  on('recorder:stopped', render);

  return { view, refresh: render, resize: () => {} };
}