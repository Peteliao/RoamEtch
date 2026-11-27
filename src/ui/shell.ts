// App shell: top bar (region indicator), tab bar, view switching, language rebuild.
import { t } from '../core/i18n';
import { on, setScope, clearScope } from '../core/events';
import { regionState, regionLabel, setRegionMode } from '../core/region';
import { get } from '../core/settings';
import { rec } from '../core/recorder';
import { getMeetSnapshot } from '../core/meet';
import { appState, cancelAltBackfill } from './state';
import { el, icon, modal, toast } from './helpers';
import { createRecordView } from './record';
import { createMeetView } from './meet';
import { createTripsView } from './trips';
import { createSettingsView } from './settings';
import { currentUIState, onUIPop, pushUIState, replaceUIState } from './history';

const TABS = [
  ['record', 'record'],
  ['trips', 'trips'],
  ['meet', 'meet'],
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
  const recButton = el('button', { class: 'rec-chip', onclick: () => navigate('record') }, recDot);
  const teamDot = el('span', { class: 'team-status-dot idle' });
  const teamButton = el('button', { class: 'team-status', onclick: () => navigate('meet') }, teamDot);
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
  topbar.append(brand, el('span', { class: 'spacer' }), teamButton, recButton, fsBtn, regionChip);

  const viewsBox = el('div', { class: 'views' });
  const tabbar = el('div', { class: 'tabbar', role: 'tablist' });
  root.append(topbar, viewsBox, tabbar);

  let views: Record<string, any> = {};
  let current = 'record';
  let chatNoticeUntil = 0;

  function renderRegionChip() {
    const s = regionState;
    const dotClass = s.probing ? 'probing' : (s.probe[s.effective] === 'ok' ? 'ok' : s.probe[s.effective] === 'fail' ? 'bad' : '');
    const unread = Number(getMeetSnapshot().chatUnread) || 0;
    const chatNotice = unread > 0 || Date.now() < chatNoticeUntil;
    regionChip.innerHTML = '';
    regionChip.append(el('span', { class: `dot ${dotClass}${chatNotice ? ' chat-alert' : ''}` }), regionLabel());
  }
  renderRegionChip();
  on('region:changed', renderRegionChip);
  on('region:probed', renderRegionChip);
  on('region:probing', renderRegionChip);
  on('meet:chat', renderRegionChip);
  on('meet:chat:received', () => {
    chatNoticeUntil = Date.now() + 2400;
    renderRegionChip();
    window.setTimeout(renderRegionChip, 2450);
  });
  on('meet:state', () => {
    if (!getMeetSnapshot().active) chatNoticeUntil = 0;
    renderRegionChip();
  });

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
    const active = status === 'recording' || status === 'paused';
    recButton.classList.toggle('show', active);
    const label = t(`record.status${status === 'recording' ? 'Recording' : status === 'paused' ? 'Paused' : 'Idle'}`);
    recButton.title = label;
    recButton.setAttribute('aria-label', label);
  });

  function renderTeamStatus() {
    const snapshot = getMeetSnapshot();
    const status = snapshot.active ? snapshot.status : 'idle';
    const tone = status === 'live' ? 'live' : status === 'error' ? 'error' : status === 'idle' ? 'idle' : 'connecting';
    const label = status === 'idle' ? t('tabs.meet') : t(`meet.status${status[0].toUpperCase()}${status.slice(1)}`);
    teamDot.className = `team-status-dot ${tone}`;
    teamButton.title = `${t('tabs.meet')} · ${label}`;
    teamButton.setAttribute('aria-label', teamButton.title);
  }
  on('meet:state', renderTeamStatus);
  on('meet:self', renderTeamStatus);

  function renderMeetBadge() {
    const button = tabbar.querySelector('button[data-tab="meet"]');
    if (!button) return;
    let badge = button.querySelector('.badge');
    const unread = Math.min(999, Number(getMeetSnapshot().chatUnread) || 0);
    button.setAttribute('aria-label', unread ? `${t('tabs.meet')} · ${unread}` : t('tabs.meet'));
    if (!unread) { badge?.remove(); return; }
    if (!badge) {
      badge = el('span', { class: 'badge' });
      button.querySelector('.tab-ic')?.append(badge);
    }
    badge.textContent = unread > 99 ? '99+' : String(unread);
  }
  on('meet:chat', renderMeetBadge);
  on('meet:state', renderMeetBadge);
  renderTeamStatus();

  function navigationIntent(name, intent) {
    const normalized = typeof intent === 'string' ? { anchor: intent } : (intent || {});
    const validated: Record<string, any> = {};
    if (typeof normalized.detail === 'boolean') validated.detail = normalized.detail;
    if (typeof normalized.tripId === 'string' && normalized.tripId) validated.tripId = normalized.tripId;
    if (['overview', 'data', 'story', 'share'].includes(normalized.section)) validated.section = normalized.section;
    if (normalized.fit === true) validated.fit = true;
    if (typeof normalized.anchor === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(normalized.anchor)) validated.anchor = normalized.anchor;
    if (name === 'analysis' || name === 'export') {
      return { ...validated, detail: true, section: name === 'analysis' ? 'overview' : 'share' };
    }
    return validated;
  }

  function navigationState(target, intent) {
    if (target === 'trips') {
      const detail = intent?.detail ?? appState.tripDetail.open;
      const tripId = detail ? (intent?.tripId || appState.tripDetail.tripId || appState.activeTripId) : null;
      return {
        type: 'view', view: target, detail: !!detail, tripId,
        section: detail ? (intent?.section || appState.tripDetail.section || 'overview') : null,
        fit: !!intent?.fit, anchor: intent?.anchor || null
      };
    }
    return { type: 'view', view: target, tripId: intent?.tripId || null, fit: !!intent?.fit, anchor: intent?.anchor || null };
  }

  function sameNavigation(a, b) {
    return !!a && !!b && a.type === b.type && a.view === b.view && a.detail === b.detail
      && a.tripId === b.tripId && a.section === b.section && a.fit === b.fit && a.anchor === b.anchor;
  }

  function applyNavigation(target, intent) {
    if (!views[target]) return;
    if (target !== current) cancelAltBackfill();
    current = target;
    appState.view = target;
    for (const [n, v] of Object.entries(views)) v.view.classList.toggle('active', n === target);
    tabbar.querySelectorAll('button').forEach((b) => {
      const selected = b.dataset.tab === target;
      b.classList.toggle('active', selected);
      b.setAttribute('aria-selected', String(selected));
    });
    requestAnimationFrame(() => {
      views[target].resize?.();
      views[target].refresh?.();
      if (target === 'trips') {
        if (intent?.detail) {
          const tripId = intent.tripId || appState.tripDetail.tripId || appState.activeTripId;
          if (appState.tripDetail.open && appState.tripDetail.tripId === tripId) {
            views.trips.setSection?.(intent.section || 'overview');
          } else {
            views.trips.focus?.({ ...intent, tripId });
          }
        } else {
          views.trips.closeDetail?.({ history: false });
        }
      } else if (intent && Object.keys(intent).length) {
        views[target].focus?.(intent);
      }
    });
  }

  function navigate(name, intent = null, options: { history?: boolean } = {}) {
    const target = name === 'analysis' || name === 'export' ? 'trips' : name;
    if (!views[target]) return;
    const targetIntent = navigationIntent(name, intent);
    const state = navigationState(target, targetIntent);
    if (options.history !== false && !sameNavigation(currentUIState(), state)) {
      const previous = currentUIState();
      const enteringTripDetail = target === 'trips' && state.detail
        && !(previous?.type === 'view' && previous.view === 'trips' && previous.detail);
      const changingDetailTrip = target === 'trips' && state.detail
        && previous?.type === 'view' && previous.view === 'trips' && previous.detail
        && previous.tripId !== state.tripId;
      if (target === current && !enteringTripDetail && !changingDetailTrip) replaceUIState(state);
      else pushUIState(state);
    }
    const applyIntent = target === 'trips' && state.detail
      ? { ...targetIntent, detail: true, tripId: state.tripId, section: state.section, fit: state.fit, anchor: state.anchor }
      : targetIntent;
    applyNavigation(target, applyIntent);
  }

  onUIPop((state) => {
    if (views.record?.isPowerLockActive?.()) {
      pushUIState({ type: 'oled' });
      toast(t('record.lockHint'), 'info', 2200);
      return true;
    }
    if (state?.type === 'view' && views[state.view]) {
      applyNavigation(state.view, state.view === 'trips'
        ? { detail: state.detail, tripId: state.tripId, section: state.section, fit: state.fit, anchor: state.anchor }
        : { tripId: state.tripId, fit: state.fit, anchor: state.anchor });
      return true;
    }
    return false;
  });

  function buildViews() {
    setScope('views');
    const record = createRecordView(navigate);
    const meetV = createMeetView(navigate);
    const trips = createTripsView(navigate, () => record.getMap());
    const settings = createSettingsView(navigate);
    setScope('core');
    views = { record, meet: meetV, trips, settings };
    viewsBox.innerHTML = '';
    for (const v of Object.values(views)) viewsBox.append(v.view);
    tabbar.innerHTML = '';
    for (const [name, iconKey] of TABS) {
      const b = el('button', {
        role: 'tab', 'data-tab': name, 'aria-controls': `view-${name}`,
        onclick: () => {
          if (name === 'trips' && current === 'trips' && appState.tripDetail.open) {
            views.trips.closeDetail();
            return;
          }
          navigate(name);
        }
      }, el('span', { class: 'tab-ic' }, icon(iconKey, 22)), t(`tabs.${name}`));
      tabbar.append(b);
    }
    renderMeetBadge();
    recDot.className = `rec-dot ${rec.status === 'recording' ? 'recording' : rec.status === 'paused' ? 'paused' : ''}`;
    recButton.classList.toggle('show', rec.status === 'recording' || rec.status === 'paused');
    replaceUIState(navigationState(current, null));
    navigate(current, null, { history: false });
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
    renderTeamStatus();
  });

  buildViews();

  return { navigate, getViews: () => views };
}