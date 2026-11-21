// App shell: top bar (region indicator), tab bar, view switching, language rebuild.
import { t } from '../core/i18n';
import { on, setScope, clearScope } from '../core/events';
import { regionState, regionLabel, setRegionMode } from '../core/region';
import { get } from '../core/settings';
import { rec } from '../core/recorder';
import { appState } from './state';
import { el, icon, modal } from './helpers';
import { createRecordView } from './record';
import { createMeetView } from './meet';
import { createTripsView } from './trips';
import { createAnalysisView } from './analysis';
import { createExportView } from './export';
import { createSettingsView } from './settings';

const TABS = [
  ['record', 'record'],
  ['meet', 'meet'],
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
  const fsBtn = el('button', { class: 'iconbtn fs-btn' });
  const fsDoc = document as any;
  function fsElement() { return fsDoc.fullscreenElement || fsDoc.webkitFullscreenElement || null; }
  function renderFsBtn() {
    const on = !!fsElement();
    fsBtn.innerHTML = '';
    fsBtn.append(icon(on ? 'compress' : 'expand'));
    fsBtn.title = t(on ? 'common.exitFullscreen' : 'common.fullscreen');
    fsBtn.setAttribute('aria-label', fsBtn.title);
  }
  fsBtn.onclick = async () => {
    try {
      if (fsElement()) await (fsDoc.exitFullscreen || fsDoc.webkitExitFullscreen)?.call(fsDoc);
      else {
        const de = document.documentElement as any;
        await (de.requestFullscreen || de.webkitRequestFullscreen)?.call(de);
      }
    } catch { /* browser refused */ }
    renderFsBtn();
  };
  document.addEventListener('fullscreenchange', renderFsBtn);
  document.addEventListener('webkitfullscreenchange', renderFsBtn);
  if (!(fsDoc.fullscreenEnabled || fsDoc.webkitFullscreenEnabled || document.documentElement.requestFullscreen || (document.documentElement as any).webkitRequestFullscreen)) {
    fsBtn.style.display = 'none';
  }
  renderFsBtn();
  topbar.append(brand, el('span', { class: 'spacer' }), recDot, fsBtn, regionChip);

  const viewsBox = el('div', { class: 'views' });
  const tabbar = el('div', { class: 'tabbar' });
  root.append(topbar, viewsBox, tabbar);

  let views: Record<string, any> = {};
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

  function navigate(name, intent = null) {
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
      if (intent) views[name].focus?.(intent);
    });
  }

  function buildViews() {
    setScope('views');
    const record = createRecordView();
    const meetV = createMeetView(navigate);
    const trips = createTripsView(navigate);
    const analysis = createAnalysisView();
    const exportV = createExportView(() => record.getMap());
    const settings = createSettingsView(navigate);
    setScope('core');
    views = { record, meet: meetV, trips, analysis, export: exportV, settings };
    viewsBox.innerHTML = '';
    for (const v of Object.values(views)) viewsBox.append(v.view);
    tabbar.innerHTML = '';
    for (const [name, iconKey] of TABS) {
      const b = el('button', { 'data-tab': name, onclick: () => navigate(name) },
        el('span', { class: 'tab-ic' }, icon(iconKey, 22)), t(`tabs.${name}`));
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
    renderFsBtn();
  });

  buildViews();

  // fit request from trips list
  window.addEventListener('map:fitrequest', () => views.record?.getMap()?.fitTrack());

  return { navigate, getViews: () => views };
}