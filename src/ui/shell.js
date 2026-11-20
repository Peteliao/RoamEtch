// App shell: top bar (region indicator), tab bar, view switching, language rebuild.
import { t } from '../core/i18n.js';
import { on, setScope, clearScope } from '../core/events.js';
import { regionState, regionLabel, setRegionMode } from '../core/region.js';
import { get } from '../core/settings.js';
import { rec } from '../core/recorder.js';
import { appState } from './state.js';
import { el, icon, modal } from './helpers.js';
import { createRecordView } from './record.js';
import { createTripsView } from './trips.js';
import { createAnalysisView } from './analysis.js';
import { createExportView } from './export.js';
import { createSettingsView } from './settings.js';

const TABS = [
  ['record', 'record'],
  ['trips', 'trips'],
  ['analysis', 'analysis'],
  ['export', 'export'],
  ['settings', 'settings']
];

export function createShell(root) {
  const topbar = el('div', { class: 'topbar' });
  const brand = el('span', { class: 'brand' });
  function renderBrand() {
    const name = t('app.name');
    const i = name.indexOf('迹刻');
    brand.innerHTML = '';
    brand.append(i >= 0 ? name.slice(0, i) : name, el('em', {}, i >= 0 ? name.slice(i) : ''));
  }
  renderBrand();
  const regionChip = el('button', { class: 'region-chip', title: t('region.title') });
  const recDot = el('span', { class: 'rec-dot' });
  topbar.append(brand, el('span', { class: 'spacer' }), recDot, regionChip);

  const viewsBox = el('div', { class: 'views' });
  const tabbar = el('div', { class: 'tabbar' });
  root.append(topbar, viewsBox, tabbar);

  let views = {};
  let current = 'record';

  function renderRegionChip() {
    const s = regionState;
    const dotClass = s.probing ? 'probing' : (s.probe[s.effective] === 'ok' ? 'ok' : s.probe[s.effective] === 'fail' ? 'bad' : '');
    regionChip.innerHTML = '';
    regionChip.append(el('span', { class: `dot ${dotClass}` }), regionLabel());
  }
  renderRegionChip();
  on('region:changed', renderRegionChip);
  on('region:probed', renderRegionChip);
  on('region:probing', renderRegionChip);

  regionChip.onclick = () => {
    const m = modal({
      title: t('region.title'),
      body: el('div', {},
        el('p', { class: 'small muted', style: { marginTop: 0 } }, t('region.switchHint')),
        ...[['auto', t('region.modeAuto')], ['cn', t('region.modeCn')], ['global', t('region.modeGlobal')]].map(([v, label]) =>
          el('button', {
            class: 'btn block', style: { marginBottom: '8px', justifyContent: 'flex-start', borderColor: get('regionMode') === v ? 'var(--accent)' : '' },
            onclick: () => { setRegionMode(v); m.close(); renderRegionChip(); }
          }, get('regionMode') === v ? '● ' : '○ ', label)),
        el('div', { class: 'small faint' }, t('region.coordNote'))
      )
    });
  };

  on('recstatus:changed', (status) => {
    recDot.className = `rec-dot ${status === 'recording' ? 'recording' : status === 'paused' ? 'paused' : ''}`;
  });

  function navigate(name) {
    if (!views[name]) return;
    current = name;
    appState.view = name;
    for (const [n, v] of Object.entries(views)) {
      v.view.classList.toggle('active', n === name);
    }
    tabbar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    requestAnimationFrame(() => {
      views[name].resize?.();
      views[name].refresh?.();
    });
  }

  function buildViews() {
    setScope('views');
    const record = createRecordView();
    const trips = createTripsView(navigate);
    const analysis = createAnalysisView();
    const exportV = createExportView(() => record.getMap());
    const settings = createSettingsView(navigate);
    setScope('core');
    views = { record, trips, analysis, export: exportV, settings };
    viewsBox.innerHTML = '';
    for (const v of Object.values(views)) viewsBox.append(v.view);
    tabbar.innerHTML = '';
    for (const [name, iconKey] of TABS) {
      const b = el('button', { 'data-tab': name, onclick: () => navigate(name) }, icon(iconKey, 22), t(`tabs.${name}`));
      tabbar.append(b);
    }
    navigate(current);
  }

  function destroyViews() {
    for (const v of Object.values(views)) v.destroy?.();
    clearScope('views');
    views = {};
  }

  on('language:changed', () => {
    destroyViews();
    buildViews();
    renderRegionChip();
    renderBrand();
  });

  buildViews();

  // fit request from trips list
  window.addEventListener('map:fitrequest', () => views.record?.getMap()?.fitTrack());

  return { navigate, getViews: () => views };
}