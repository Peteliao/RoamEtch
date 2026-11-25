import { t } from '../core/i18n';
import { importDemoTrip } from '../core/demo';
import { importTripFiles } from '../core/batch';
import { listTrips } from '../core/store';
import { setActiveTrip } from './state';
import { el, icon, toast, filePickerMulti } from './helpers';

export function renderTripEmptyState(container, navigate, { iconKey, titleKey, hintKey }) {
  const recordBtn = el('button', { class: 'btn primary', onclick: () => navigate('record') }, icon('record', 15), t('analysis.goRecord'));
  const demoBtn = el('button', { class: 'btn' }, icon('sparkles', 15), t('analysis.loadDemo'));
  demoBtn.onclick = async () => {
    demoBtn.disabled = true;
    try {
      const trip = await importDemoTrip();
      await setActiveTrip(trip.id);
      navigate('trips', { detail: true, tripId: trip.id, section: 'overview' });
    } catch {
      toast(t('trips.importErr'), 'err');
      demoBtn.disabled = false;
    }
  };
  const importBtn = el('button', { class: 'btn' }, icon('batch', 15), t('trips.importShort'));
  importBtn.onclick = async () => {
    const files = await filePickerMulti('.gpx,.xml,.zip,application/gpx+xml,application/xml,application/zip');
    if (!files.length) return;
    importBtn.disabled = true;
    try {
      const before = new Set((await listTrips()).map((trip) => trip.id));
      const { ok, fail } = await importTripFiles(files);
      if (ok) toast(t(fail ? 'trips.batchImportPartial' : 'trips.batchImportOk', { ok, fail }), fail ? 'warn' : 'ok');
      else toast(t('trips.importErr'), 'err');
      const imported = (await listTrips()).find((trip) => !before.has(trip.id));
      if (imported) {
        await setActiveTrip(imported.id);
        navigate('trips', { detail: true, tripId: imported.id, section: 'overview' });
      }
    } catch {
      toast(t('trips.importErr'), 'err');
    } finally {
      importBtn.disabled = false;
    }
  };
  container.replaceChildren(
    el('div', { class: 'empty-ic' }, icon(iconKey, 28)),
    el('div', { class: 'empty-title' }, t(titleKey)),
    el('div', { class: 'small' }, t(hintKey)),
    el('div', { class: 'row wrap empty-actions', style: { justifyContent: 'center', marginTop: '14px' } }, recordBtn, demoBtn, importBtn)
  );
  container.style.display = '';
}
