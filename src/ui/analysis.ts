// Analysis view: stats grid, combined elevation/speed chart linked with a mini map,
// slope distribution, segment table, timeline, difficulty & fatigue advisories.
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { t } from '../core/i18n';
import { get } from '../core/settings';
import { on } from '../core/events';
import { getTrackSnapshotSummary, listTrackRepairVersions, listTrips } from '../core/store';
import { fmtDistance, fmtDuration, fmtSpeed, fmtPace, fmtAltitude, usableTrackPoints } from '../core/geo';
import { findTrackGaps, repairTrackGaps } from '../core/gapRepair';
import { assessTrackGpsQuality } from '../core/gpsQuality';
import { applyTrackRepair, restoreGpsTrack, restoreTrackRepairVersion } from '../core/trackCleanup';
import { TrackMap } from './map';
import { WP_ICONS } from '../core/waypointMeta';
import { canvasPalette } from '../core/palette';
import { effectiveTheme } from '../core/theme';
import { buildProfile, altitudeUnit, distanceInUnit, distanceUnit, speedUnit } from '../core/profileChart';
import { computeDistanceSplitsAsync, previewTrackRepairAsync } from '../core/workerBridge';
import { appState, setActiveTrip, refreshActiveTrip, isTripSectionActive } from './state';
import { el, icon, confirmModal, toast } from './helpers';
import { renderTripEmptyState } from './tripEmptyState';
import { openTrackComparison } from './compare';

export function createAnalysisView(navigate, { embedded = false } = {}) {
  const view = el('div', { class: 'view', id: 'view-analysis' });
  const scroll = el('div', { class: 'view-scroll' });
  view.append(scroll);

  const tripSel = el('select', { 'aria-label': t('analysis.selectTrip') });
  const shareBtn = el('button', { class: 'btn sm', onclick: () => navigate('export') }, icon('share', 14), t('tabs.export'));
  const compareBtn = el('button', {
    class: 'btn sm', onclick: async () => {
      compareBtn.disabled = true;
      try { openTrackComparison(await listTrips(), appState.activeTripId); }
      finally { compareBtn.disabled = false; }
    }
  }, icon('analysis', 14), t('compare.open'));
  const head = el('div', { class: 'page-head analysis-head' },
    el('div', { class: 'page-head-row' },
      el('h2', { class: 'page-title' }, t('analysis.title')),
      el('div', { class: 'analysis-actions' }, compareBtn, embedded ? null : shareBtn)),
    embedded ? null : el('div', { class: 'search-bar', style: { margin: '10px 0 14px' } }, icon('analysis', 18), tripSel));
  tripSel.onchange = async () => { if (tripSel.value) await setActiveTrip(tripSel.value); };
  const emptyBox = el('div', { class: 'empty-state analysis-empty', style: { display: 'none' } });

  const statsBox = el('div', { class: 'stat-summary card analysis-overview' });
  const qualityBox = el('div', { class: 'analysis-data' });
  const advisory = el('div', { class: 'analysis-overview' });
  const gapBody = el('div', {});
  const gapCard = el('div', { class: 'card analysis-data', style: { display: 'none' } },
    el('h3', {}, icon('routeFwd', 18), t('analysis.gapTitle')), gapBody);
  const miniMapBox = el('div', { class: 'analysis-map analysis-overview' });
  const chartWrap = el('div', { class: 'chart-wrap', 'aria-label': t('analysis.chartTitle') });
  const scrubBubble = el('div', { class: 'chart-scrub-bubble', role: 'status', 'aria-live': 'polite', style: { display: 'none' } });
  const chartLegend = el('div', { class: 'chart-legend', role: 'group', 'aria-label': t('analysis.chartTitle') });
  const chartCard = el('div', { class: 'card chart-card analysis-overview' },
    el('div', { class: 'chart-head' }, el('h3', {}, t('analysis.chartTitle')), chartLegend),
    el('div', { class: 'small faint', style: { marginBottom: '2px' } }, t('analysis.hoverHint')),
    chartWrap);
  const splitBody = el('div', { class: 'split-body' });
  const splitDetail = el('div', { class: 'split-detail', hidden: true });
  const splitSelect = el('select', { 'aria-label': t('analysis.splitsInterval') });
  for (const interval of [500, 1000, 2000, 5000]) {
    splitSelect.append(el('option', { value: String(interval) }, interval < 1000 ? `${interval} m` : `${interval / 1000} km`));
  }
  splitSelect.value = '1000';
  const splitCard = el('div', { class: 'card split-card analysis-overview' },
    el('div', { class: 'split-head' },
      el('h3', {}, icon('analysis', 18), t('analysis.splitsTitle')),
      splitSelect),
    el('div', { class: 'small faint split-hint' }, t('analysis.splitsHint')),
    splitBody, splitDetail);
  const slopeCard = el('div', { class: 'card analysis-data' }, el('h3', {}, t('analysis.slopeDist')), el('canvas', { id: 'slope-canvas', style: { width: '100%', height: '120px' } }));
  const segCard = el('div', { class: 'card analysis-data' }, el('h3', {}, t('analysis.segTable')), el('div', { id: 'seg-table' }));
  const tlCard = el('div', { class: 'card analysis-data' }, el('h3', {}, t('analysis.timeline')), el('div', { id: 'timeline' }));
  const disclaimer = el('div', { class: 'small faint', style: { padding: '4px 2px 20px' } }, '⚠ ' + t('analysis.disclaimer'));

  scroll.append(head, emptyBox, advisory, statsBox, miniMapBox, chartCard, splitCard, gapCard, qualityBox, slopeCard, segCard, tlCard, disclaimer);

  let miniMap = null;
  let chart = null;
  let flatPoints = [];
  let mapTrackKey = '';
  let renderSequence = 0;
  let qualitySequence = 0;
  let qualityTrackKey = '';
  let qualityController: AbortController | null = null;
  let repairSequence = 0;
  let repairController: AbortController | null = null;
  let splitSequence = 0;
  let splitComputeKey = '';
  let splitResult = [];
  let splitTrackKey = '';
  let selectedSplitIndex: number | null = null;
  let splitSelectionSyncing = false;
  let chartSeries = { altitude: true, speed: true };
  let chartProfile = null;
  let chartStats = null;
  let chartRenderKey = '';
  const legendButtons = {};

  function analysisActive() {
    return isTripSectionActive('overview') || isTripSectionActive('data');
  }

  function renderEmpty() {
    renderTripEmptyState(emptyBox, navigate, {
      iconKey: 'analysis', titleKey: 'analysis.emptyTitle', hintKey: 'analysis.emptyHint'
    });
    shareBtn.disabled = true;
  }

  function ensureMiniMap() {
    if (miniMap) return;
    miniMap = new TrackMap(miniMapBox, {
      compact: true,
      preserveDrawingBuffer: false,
      onTrackClick: (lon, lat) => {
        const full = appState.activeTripFull;
        const trackKey = full ? `${full.trip.id}:${full.trip.updatedAt || 0}` : '';
        if (trackKey !== splitTrackKey) return;
        selectSplit(splitIndexAtMapPoint(lat, lon), 'map');
      }
    }).init([116.4, 39.9], 10);
  }

  async function refreshTripList() {
    const trips = await listTrips();
    tripSel.innerHTML = '';
    tripSel.append(el('option', { value: '' }, '—'));
    for (const tr of trips) {
      tripSel.append(el('option', { value: tr.id }, tr.name || new Date(tr.createdAt).toLocaleString()));
    }
    tripSel.value = appState.activeTripId || '';
  }

  function heroStat(label, valueHtml, accent = false) {
    return el('div', { class: 'stat-hero-item' + (accent ? ' accent' : '') },
      el('div', { class: 'v', html: valueHtml }),
      el('div', { class: 'k' }, label));
  }

  function miniStat(label, value) {
    return el('div', { class: 'stat-mini' }, el('div', { class: 'v' }, value), el('div', { class: 'k' }, label));
  }

  function repairMetricText(key, value, units) {
    if (value == null) return '—';
    if (key === 'distance') {
      const formatted = fmtDistance(value, units);
      return `${formatted.v}${formatted.u}`;
    }
    if (key === 'duration' || key === 'movingMs' || key === 'stillMs' || key === 'breakMs') {
      return fmtDuration(value, { compact: true });
    }
    if (key === 'ascent' || key === 'descent') {
      const formatted = fmtAltitude(value, units);
      return `${formatted.v}${formatted.u}`;
    }
    return String(value);
  }

  function renderRepairVersions(versions, full, expectedUpdatedAt) {
    if (!versions.length) return null;
    const tripId = full.trip.id;
    const units = get('units');
    const rows = el('div', { class: 'repair-version-list' });
    const addRow = (label, metrics, version = null) => {
      const actions = el('div', { class: 'repair-version-actions' });
      if (version) {
        const restore = el('button', {
          type: 'button', class: 'btn sm', disabled: full.trip.status === 'recording'
        }, icon('undo', 14), t('analysis.repairVersionRestore'));
        restore.onclick = async () => {
          const ok = await confirmModal({
            title: t('analysis.repairVersionRestoreTitle', { n: version.version }),
            message: t('analysis.repairVersionRestoreConfirm', { n: version.version, points: version.points }),
            confirmText: t('analysis.repairVersionRestore'), danger: true
          });
          if (!ok || appState.activeTripId !== tripId) return;
          restore.disabled = true;
          try {
            await restoreTrackRepairVersion(tripId, version.versionId, { expectedUpdatedAt });
            await refreshActiveTrip(tripId);
            toast(t('analysis.repairVersionRestoreDone', { n: version.version }), 'ok', 4500);
          } catch (e) {
            console.error(e);
            toast(t(e?.message === 'track-changed' ? 'analysis.qualityChanged' : 'analysis.repairVersionRestoreFail'), 'warn');
            restore.disabled = false;
          }
        };
        actions.append(restore);
      }
      const row = el('div', { class: 'repair-version-row' },
        el('strong', { class: 'mono' }, label),
        el('span', {}, `${metrics.pointCount ?? '—'} ${t('analysis.points')}`),
        el('span', { class: 'mono' }, repairMetricText('distance', metrics.distance, units)),
        el('span', { class: 'mono' }, repairMetricText('duration', metrics.duration, units)),
        actions);
      rows.append(row);
      return row;
    };
    addRow(t('analysis.repairVersionCurrent'), appState.stats || {});
    for (const version of versions.slice(0, 20)) {
      const categories = version.selectedCategories.map((id) => t(`analysis.repairCategory.${id}`)).join(' · ');
      const row = addRow(t('analysis.repairVersionLabel', {
        n: version.version, date: new Date(version.createdAt).toLocaleString()
      }), version.metrics || {}, version);
      row.classList.add('repair-version-saved');
      row.title = categories;
      row.setAttribute('aria-label', `${t('analysis.repairVersionLabel', { n: version.version, date: new Date(version.createdAt).toLocaleString() })} · ${categories}`);
    }
    return el('div', { class: 'gps-snapshot repair-versions' },
      el('strong', {}, t('analysis.repairVersionsTitle')),
      el('div', { class: 'small faint' }, t('analysis.repairVersionsHint')),
      rows);
  }

  function renderRepairPanel(full, initialPreview, ownerSequence, expectedUpdatedAt) {
    const tripId = full.trip.id;
    const activity = full.trip.activity || 'hike';
    const units = get('units');
    const body = el('div', { class: 'gps-repair' });
    let current = initialPreview;
    let applying = false;
    const isCurrent = () => ownerSequence === qualitySequence && appState.activeTripId === tripId
      && appState.activeTripFull?.trip.updatedAt === expectedUpdatedAt;
    const focusPoint = (point) => {
      if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return;
      ensureMiniMap();
      if (embedded && appState.tripDetail.open && appState.tripDetail.section !== 'overview') navigate('analysis');
      requestAnimationFrame(() => {
        miniMap?.resize();
        miniMap?.flyTo(point.lat, point.lon, 16);
        miniMap?.showHover(point.lat, point.lon, t('analysis.repairIssueLocation'));
        miniMapBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    };
    const render = () => {
      const selected = new Set(current.selected);
      const selectedImpact = current.categories.filter((category) => selected.has(category.id))
        .reduce((sum, category) => sum + category.impactDistance, 0);
      const impact = fmtDistance(selectedImpact, units);
      const metricRows = [
        ['distance', t('analysis.distance')],
        ['duration', t('analysis.duration')],
        ['movingMs', t('analysis.movingTime')],
        ['stillMs', t('analysis.stillTime')],
        ['breakMs', t('analysis.breakTime')],
        ['ascent', t('analysis.ascent')],
        ['pointCount', t('analysis.points')]
      ];
      const metrics = el('table', { class: 'repair-metrics' },
        el('tr', {}, el('th', {}, t('analysis.repairMetric')),
          el('th', {}, t('analysis.repairBefore')), el('th', {}, t('analysis.repairAfter'))));
      for (const [key, label] of metricRows) {
        metrics.append(el('tr', {},
          el('th', { scope: 'row' }, label),
          el('td', { class: 'mono' }, repairMetricText(key, current.metrics.before[key], units)),
          el('td', { class: 'mono' }, repairMetricText(key, current.metrics.after[key], units))));
      }
      const categories = el('div', { class: 'repair-categories', role: 'group', 'aria-label': t('analysis.repairCategories') });
      for (const category of current.categories) {
        const checkbox = el('input', { type: 'checkbox', checked: selected.has(category.id) });
        checkbox.onchange = () => {
          const next = new Set(selected);
          if (checkbox.checked) next.add(category.id); else next.delete(category.id);
          void update([...next]);
        };
        const categoryImpact = fmtDistance(category.impactDistance, units);
        const row = el('div', { class: 'repair-category' },
          el('label', { class: 'repair-category-label' },
            checkbox,
            el('span', { class: 'repair-category-name' }, t(`analysis.repairCategory.${category.id}`)),
            el('span', { class: 'tag' }, t('analysis.repairCategoryCount', { n: category.count })),
            el('span', { class: 'repair-category-impact mono' }, `${categoryImpact.v}${categoryImpact.u}`)));
        const suggestions = current.suggestions.filter((item) => item.category === category.id);
        if (suggestions.length) {
          const details = el('details', { class: 'repair-reasons' },
            el('summary', {}, t('analysis.repairReasons', { n: suggestions.length })));
          for (const item of suggestions.slice(0, 20)) {
            const point = item.firstPoint;
            details.append(el('button', {
              type: 'button', class: 'repair-reason',
              onclick: () => focusPoint(point)
            },
              el('span', {}, t(`analysis.repairReason.${item.reason}`)),
              el('span', { class: 'small faint' }, `${t('analysis.qualitySegment', { n: item.segmentIndex + 1 })} · ${t('analysis.repairPoints', { n: item.indexes.length })}`)));
          }
          if (suggestions.length > 20) details.append(el('div', { class: 'small faint' }, t('analysis.repairMoreReasons', { n: suggestions.length - 20 })));
          row.append(details);
        }
        categories.append(row);
      }
      const safe = el('button', { type: 'button', class: 'btn sm' }, t('analysis.repairSafeSelection'));
      safe.onclick = () => void update(current.categories.filter((category) => category.defaultSelected).map((category) => category.id));
      const clear = el('button', { type: 'button', class: 'btn sm' }, t('analysis.repairClearSelection'));
      clear.onclick = () => void update([]);
      const apply = el('button', { type: 'button', class: 'btn primary sm', disabled: !current.selected.length },
        icon('shield', 15), t('analysis.repairApply'));
      apply.onclick = async () => {
        if (applying) return;
        const preview = current;
        const ok = await confirmModal({
          title: t('analysis.repairApplyTitle'),
          message: t('analysis.repairApplyConfirm', {
            removed: preview.summary.removed,
            altitude: preview.summary.altitudeCleared,
            gaps: preview.summary.classifiedGaps,
            impact: `${impact.v}${impact.u}`
          }),
          confirmText: t('analysis.repairApply')
        });
        if (!ok || !isCurrent() || current !== preview) return;
        applying = true;
        body.classList.add('is-busy');
        apply.disabled = true;
        const operation = new AbortController();
        repairController?.abort();
        repairController = operation;
        try {
          const result = await applyTrackRepair(tripId, {
            activity, preview, expectedUpdatedAt, signal: operation.signal
          });
          await refreshActiveTrip(tripId);
          toast(t('analysis.repairApplyDone', {
            removed: result.removed, altitude: result.altitudeCleared, version: result.version?.version || '—'
          }), 'ok', 4500);
        } catch (e) {
          if (e?.name === 'AbortError') return;
          console.error(e);
          toast(t(e?.message === 'track-changed' ? 'analysis.qualityChanged' : 'analysis.repairApplyFail'), 'warn');
          applying = false;
          body.classList.remove('is-busy');
          apply.disabled = !current.selected.length;
        } finally {
          if (repairController === operation) repairController = null;
        }
      };
      const semantics = el('details', { class: 'repair-semantics' },
        el('summary', {}, t('analysis.repairSemanticsTitle')),
        el('ul', {},
          el('li', {}, t('analysis.repairSemanticDistance')),
          el('li', {}, t('analysis.repairSemanticDuration')),
          el('li', {}, t('analysis.repairSemanticMoving')),
          el('li', {}, t('analysis.repairSemanticGaps')),
          el('li', {}, t('analysis.repairSemanticAscent'))));
      body.replaceChildren(
        el('div', { class: 'gps-preview-head' },
          el('strong', {}, t('analysis.repairTitle')),
          el('span', { class: 'tag' }, t('analysis.repairImpact', { d: `${impact.v}${impact.u}` }))),
        el('div', { class: 'repair-legend' },
          el('span', {}, el('i', { class: 'before', 'aria-hidden': 'true' }), t('analysis.repairBefore')),
          el('span', {}, el('i', { class: 'after', 'aria-hidden': 'true' }), t('analysis.repairAfter'))),
        el('div', { class: 'small faint' }, t('analysis.repairHint')),
        metrics, semantics,
        el('div', { class: 'repair-selection-head' },
          el('strong', {}, t('analysis.repairCategories')),
          el('div', {}, safe, clear)),
        categories,
        el('div', { class: 'repair-actions' }, apply,
          el('span', { class: 'small faint' }, t('analysis.repairSummary', {
            removed: current.summary.removed,
            altitude: current.summary.altitudeCleared,
            gaps: current.summary.classifiedGaps
          }))));
    };
    const update = async (selected) => {
      const sequence = ++repairSequence;
      repairController?.abort();
      const controller = new AbortController();
      repairController = controller;
      body.classList.add('is-busy');
      body.setAttribute('aria-busy', 'true');
      try {
        const next = await previewTrackRepairAsync(full.segments, activity, { selected }, { signal: controller.signal });
        if (sequence !== repairSequence || !isCurrent() || controller.signal.aborted) return;
        current = next;
        miniMap?.setRepairPreview(next.overlay);
        render();
      } catch (e) {
        if (e?.name !== 'AbortError' && isCurrent()) {
          console.error(e);
          toast(t('analysis.qualityPreviewFail'), 'warn');
        }
      } finally {
        if (repairController === controller) repairController = null;
        body.classList.remove('is-busy');
        body.removeAttribute('aria-busy');
      }
    };
    miniMap?.setRepairPreview(current.overlay);
    render();
    return body;
  }

  async function renderQuality() {
    const full = appState.activeTripFull;
    if (!full) {
      qualityTrackKey = '';
      qualitySequence++;
      repairSequence++;
      qualityController?.abort();
      repairController?.abort();
      qualityBox.innerHTML = '';
      miniMap?.setRepairPreview(null);
      return;
    }
    const trackKey = `${full.trip.id}:${full.trip.updatedAt || 0}:${full.trip.status || ''}`;
    if (trackKey === qualityTrackKey) return;
    qualityTrackKey = trackKey;
    const sequence = ++qualitySequence;
    const previousRepairSequence = ++repairSequence;
    qualityController?.abort();
    repairController?.abort();
    const controller = new AbortController();
    qualityController = controller;
    qualityBox.innerHTML = '';
    miniMap?.setRepairPreview(null);
    const tripId = full.trip.id;
    const updatedAt = full.trip.updatedAt;
    const activity = full.trip.activity || 'hike';
    const q = assessTrackGpsQuality(full.segments, { activity });
    const recording = full.trip.status === 'recording';
    let snapshot, previewResult, versions;
    try {
      [snapshot, previewResult, versions] = await Promise.all([
        getTrackSnapshotSummary(tripId),
        recording ? null : previewTrackRepairAsync(full.segments, activity, {}, { signal: controller.signal }),
        listTrackRepairVersions(tripId).catch((error) => { console.error(error); return []; })
      ]);
    } catch (e) {
      if (controller.signal.aborted || e?.name === 'AbortError') return;
      if (sequence !== qualitySequence || appState.activeTripId !== tripId
        || appState.activeTripFull?.trip.updatedAt !== updatedAt) return;
      qualityTrackKey = '';
      console.error(e);
      qualityBox.append(el('div', { class: 'card quality-card' },
        el('div', { class: 'small muted', 'aria-live': 'polite' }, t('analysis.qualityPreviewFail'))));
      return;
    }
    if (sequence !== qualitySequence || previousRepairSequence !== repairSequence || appState.activeTripId !== tripId
      || appState.activeTripFull?.trip.updatedAt !== updatedAt || controller.signal.aborted) return;
    if (q.score == null && !snapshot && !previewResult?.categories?.length && !versions.length) return;
    const tone = q.rating === 'excellent' || q.rating === 'good'
      ? 'var(--accent)' : q.rating === 'fair' ? 'var(--warn)' : 'var(--danger)';
    const metric = (label, value) => el('div', { class: 'quality-metric' },
      el('div', { class: 'v' }, value), el('div', { class: 'k' }, label));
    const children = [
      el('div', { class: 'quality-head' },
        el('h3', {}, icon('shield', 18), t('analysis.qualityTitle')),
        q.score == null ? null : el('span', { class: `quality-rating ${q.rating}` },
          t(`analysis.quality${q.rating[0].toUpperCase()}${q.rating.slice(1)}`)))
    ];
    if (q.score != null) {
      children.push(
        el('div', { class: 'quality-top' },
          el('div', { class: 'quality-score' }, el('b', { style: { color: tone } }, String(q.score)), el('small', {}, '/100')),
          el('div', { class: 'quality-meter' },
            el('div', { class: 'quality-fill', style: { width: `${q.score}%`, background: tone } }))),
        el('div', { class: 'quality-metrics' },
          metric(t('analysis.qualityAvgAcc'), q.avgAcc == null ? '—' : `±${q.avgAcc.toFixed(1)} m`),
          metric(t('analysis.qualityPoorFixes'), q.poorRatio == null ? '—' : `${q.poorFixes} (${Math.round(q.poorRatio * 100)}%)`),
          metric(t('analysis.qualityGaps'), q.gaps ? `${q.gaps} · ${fmtDuration(q.gapMs, { compact: true })}` : '0'),
          metric(t('analysis.qualityAltJumps'), String(q.altJumps)),
          metric(t('analysis.qualityReversals'), String(q.reversals))));
    }
    if (q.avgAcc == null && q.score != null) children.push(el('div', { class: 'small faint', style: { marginTop: '8px' } }, t('analysis.qualityNoAcc')));
    if (q.duplicateFixes || q.invalidTimes) {
      children.push(el('div', { class: 'small faint quality-diagnostics', style: { marginTop: '8px' } },
        t('analysis.qualityDiagnostics', { duplicates: q.duplicateFixes, times: q.invalidTimes })));
    }
    children.push(el('div', { class: 'small faint quality-note' },
      `${q.fixes} ${t('analysis.qualityFixes')} · ${t('analysis.qualityNote')}`));

    if (!recording && previewResult?.categories?.length) {
      children.push(renderRepairPanel(full, previewResult, sequence, updatedAt));
    } else if (!recording) {
      children.push(el('div', { class: 'small faint gps-preview' }, t('analysis.repairEmpty')));
    }

    if (snapshot) {
      const restore = el('button', { class: 'btn sm', disabled: recording }, icon('undo', 14), t('analysis.qualityRestore'));
      restore.onclick = async () => {
        const ok = await confirmModal({
          title: t('analysis.qualityRestoreTitle'),
          message: t('analysis.qualityRestoreConfirm', { n: snapshot.points }),
          confirmText: t('analysis.qualityRestore'), danger: true
        });
        if (!ok || appState.activeTripId !== tripId) return;
        restore.disabled = true;
        try {
          const result = await restoreGpsTrack(tripId, { expectedUpdatedAt: updatedAt });
          await refreshActiveTrip(tripId);
          if (result.restored) toast(t('analysis.qualityRestoreDone', { n: result.restored }), 'ok', 4500);
        } catch (e) {
          console.error(e);
          toast(t(e?.message === 'track-changed' ? 'analysis.qualityChanged' : 'analysis.qualityRestoreFail'), 'warn');
          restore.disabled = false;
        }
      };
      children.push(el('div', { class: 'gps-snapshot' },
        el('div', {},
          el('strong', {}, t('analysis.qualityOriginalSnapshot')),
          el('div', { class: 'small faint' }, t('analysis.qualitySnapshotInfo', {
            n: snapshot.points, segments: snapshot.segments,
            date: new Date(snapshot.createdAt).toLocaleString()
          }))),
        restore,
        recording ? el('div', { class: 'small faint' }, t('analysis.qualityRestoreRecording')) : null));
    }
    const versionBox = renderRepairVersions(versions, full, updatedAt);
    if (versionBox) children.push(versionBox);
    qualityBox.append(el('div', { class: 'card quality-card' }, children));
  }

  function renderStats(stats) {
    const units = get('units');
    statsBox.innerHTML = '';
    if (!stats) return;
    const d = fmtDistance(stats.distance, units);
    const sp = fmtSpeed(stats.avgSpeed, units);
    const mx = fmtSpeed(stats.maxSpeed, units);
    const pc = fmtPace(stats.avgSpeed, units);
    const ha = fmtAltitude(stats.maxAlt, units);
    const la = fmtAltitude(stats.minAlt, units);
    const asc = fmtAltitude(stats.ascent, units);
    const desc = fmtAltitude(stats.descent, units);
    const score = Math.max(1, Math.min(5, Math.round(stats.distance / 8000 + stats.ascent / 600)));
    statsBox.append(
      el('div', { class: 'stat-hero' },
        heroStat(t('analysis.distance'), `${d.v}<small>${d.u}</small>`, true),
        heroStat(t('analysis.duration'), fmtDuration(stats.duration)),
        heroStat(t('analysis.avgSpeed'), `${sp.v}<small>${sp.u}</small>`),
        heroStat(t('analysis.ascent'), `↑${asc.v}<small>${asc.u}</small>`)),
      el('div', { class: 'stat-more' },
        el('div', { class: 'stat-more-row' },
          miniStat(t('analysis.movingTime'), fmtDuration(stats.movingMs, { compact: true })),
          miniStat(t('analysis.stillTime'), fmtDuration(stats.stillMs, { compact: true })),
          miniStat(t('analysis.maxSpeed'), `${mx.v} ${mx.u}`)),
        el('div', { class: 'stat-more-row' },
          miniStat(t('analysis.avgPace'), `${pc.v} ${pc.u}`),
          miniStat(t('analysis.descent'), `↓${desc.v}${desc.u}`),
          miniStat(t('analysis.calories'), stats.calories != null ? `${Math.round(stats.calories)} kcal` : '—')),
        el('div', { class: 'stat-more-row' },
          miniStat(t('analysis.maxAlt'), `${ha.v} ${ha.u}`),
          miniStat(t('analysis.minAlt'), `${la.v} ${la.u}`),
          miniStat(t('analysis.points'), String(stats.pointCount)))),
      el('div', { class: 'stat-foot' },
        el('span', { class: 'stat-diff' }, t('analysis.difficulty'),
          el('span', { class: 'stat-stars' }, '★'.repeat(score) + '☆'.repeat(5 - score))),
        el('span', { class: 'stat-note' }, t('analysis.difficultyNote')),
        stats.hasTime ? el('span', { class: 'stat-time' }, t('analysis.timeBreakdown', {
          active: fmtDuration(stats.activeMs, { compact: true }),
          gap: fmtDuration(stats.breakMs, { compact: true })
        })) : null,
        el('span', { class: 'stat-seg' }, `${stats.segCount} ${t('analysis.segShort')}`))
    );
    // fatigue advisory for driving
    advisory.innerHTML = '';
    const act = appState.activeTripFull?.trip?.activity;
    if (act === 'drive' && stats.movingMs > 4 * 3600_000) {
      advisory.append(el('div', { class: 'debug-banner' }, '⚠ ' + t('analysis.fatige')));
    }
    if (!stats.hasTime) {
      advisory.append(el('div', { class: 'debug-banner', style: { borderColor: 'var(--info)', color: 'var(--info)', background: 'rgba(90,167,240,0.08)' } }, t('analysis.noTimeData')));
    }
  }

  function chartWidth() {
    return Math.max(1, Math.round(chartWrap.clientWidth || scroll.clientWidth - 24));
  }

  function chartOpts(height, profile, visible): any {
    const P = canvasPalette();
    const speedColor = `rgb(${P.lut[1].join(',')})`;
    const series: any[] = [{ label: distanceUnit(profile.units) }];
    const axes: any[] = [
      { stroke: P.muted, grid: { stroke: P.grid }, size: 36, font: '12px system-ui', label: [] }
    ];
    if (visible.altitude) {
      series.push({ label: `${t('panel.altitude')} (${altitudeUnit(profile.units)})`, stroke: P.accent, width: 1.8, fill: P.accentSoft, points: { show: false } });
      axes.push({ scale: 'y', stroke: P.accent, grid: { stroke: P.grid }, size: 38, font: '12px system-ui', label: [] });
    }
    if (visible.speed) {
      series.push({ label: `${t('panel.speed')} (${speedUnit(profile.units)})`, stroke: speedColor, width: 2, scale: 'y1', fill: null, points: { show: false } });
      axes.push({ scale: 'y1', stroke: speedColor, grid: { show: false }, size: 44, font: '12px system-ui', side: 1, label: [] });
    }
    return {
      width: chartWidth(),
      height,
      scales: {
        x: { time: false, range: () => [0, profile.maxX] },
        ...(visible.altitude ? { y: { range: () => [profile.altRange.min, profile.altRange.max] } } : {}),
        ...(visible.speed ? { y1: { range: () => [profile.speedRange.min, profile.speedRange.max] } } : {})
      },
      series,
      axes,
      cursor: { drag: { x: false, y: false }, points: { show: false } },
      legend: { show: false }
    };
  }

  function cursorReadout(stats, profile, units, idx, visible, includeDistance = false) {
    const sourceIdx = idx == null ? null : profile.sourceIndices[idx];
    if (sourceIdx == null) return '';
    const parts = [];
    if (includeDistance) {
      const d = fmtDistance(stats?.series?.d?.[sourceIdx], units);
      parts.push(`${t('analysis.segDist')} ${typeof d === 'string' ? d : `${d.v} ${d.u}`}`);
    }
    if (visible.altitude) {
      const rawAlt = stats?.series?.alt?.[sourceIdx];
      if (rawAlt != null) {
        const a = fmtAltitude(rawAlt, units);
        parts.push(`${t('panel.altitude')} ${a.v} ${a.u}`);
      }
    }
    if (visible.speed) {
      const rawSpeed = stats?.series?.speed?.[sourceIdx];
      if (rawSpeed != null) {
        const s = fmtSpeed(rawSpeed, units);
        parts.push(`${t('panel.speed')} ${s.v} ${s.u}`);
      }
    }
    return parts.join(' · ');
  }

  function hoverHook(stats, profile, units, visible) {
    return (u) => {
      const idx = u.cursor.idx;
      const sourceIdx = idx == null ? null : profile.sourceIndices[idx];
      if (sourceIdx == null || !flatPoints[sourceIdx] || !miniMap) { miniMap?.clearHover(); return; }
      const label = cursorReadout(stats, profile, units, idx, visible);
      miniMap.showHover(flatPoints[sourceIdx].lat, flatPoints[sourceIdx].lon, label || null);
    };
  }

  function splitIndexAtDistance(distance) {
    if (!Number.isFinite(distance)) return null;
    const index = splitResult.findIndex((split) => distance < split.endDistance
      || (split === splitResult.at(-1) && distance <= split.endDistance + 1e-6));
    return index < 0 ? null : index;
  }

  function splitIndexAtMapPoint(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const rad = (value) => value * Math.PI / 180;
    const radius = 6371008.8;
    const lonScale = radius * Math.max(1e-6, Math.cos(rad(lat)));
    const local = (point) => {
      const deltaLon = ((point.lon - lon + 540) % 360) - 180;
      return [rad(deltaLon) * lonScale, rad(point.lat - lat) * radius];
    };
    let nearest = Infinity;
    let selected = null;
    for (const split of splitResult) {
      for (const part of split.parts) {
        const points = part.points || [];
        for (let index = 0; index < points.length; index++) {
          const [ax, ay] = local(points[index]);
          if (index + 1 >= points.length) {
            nearest = Math.min(nearest, ax * ax + ay * ay);
            if (ax * ax + ay * ay === nearest) selected = split.index;
            continue;
          }
          const [bx, by] = local(points[index + 1]);
          const dx = bx - ax, dy = by - ay;
          const lengthSquared = dx * dx + dy * dy;
          const fraction = lengthSquared > 1e-12 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared)) : 0;
          const px = ax + dx * fraction, py = ay + dy * fraction;
          const distanceSquared = px * px + py * py;
          if (distanceSquared < nearest) {
            nearest = distanceSquared;
            selected = split.index;
          }
        }
      }
    }
    return selected;
  }

  function selectSplit(index: number | null, source: 'row' | 'chart' | 'map') {
    if (splitSelectionSyncing) return;
    const next = index != null && splitResult[index]
      ? (selectedSplitIndex === index ? null : index)
      : null;
    splitSelectionSyncing = true;
    try {
      selectedSplitIndex = next;
      splitDetail.dataset.source = source;
      updateSplitSelection();
      const selected = next == null ? null : splitResult[next];
      miniMap?.setSplitHighlight(selected?.parts || [], !!selected);
      chart?.redraw();
      if (selected && chart && chartProfile) {
        const middle = distanceInUnit((selected.startDistance + selected.endDistance) / 2, chartProfile.units);
        let nearest = 0;
        for (let i = 1; i < chartProfile.x.length; i++) {
          if (Math.abs(chartProfile.x[i] - middle) < Math.abs(chartProfile.x[nearest] - middle)) nearest = i;
        }
        chart.setCursor({ left: chart.valToPos(chartProfile.x[nearest], 'x'), top: chart.bbox.top + chart.bbox.height / 2 });
      } else if (chart) {
        chart.setCursor({ left: -20, top: -20 });
      }
    } finally {
      splitSelectionSyncing = false;
    }
  }

  function attachScrub(u, stats, profile, units, visible) {
    const over = u.over;
    let pointerId = null;
    chartWrap.append(scrubBubble);
    scrubBubble.textContent = '';
    scrubBubble.style.display = 'none';

    const showReadout = (e) => {
      const text = cursorReadout(stats, profile, units, u.cursor.idx, visible, true);
      if (!text) { scrubBubble.style.display = 'none'; return; }
      scrubBubble.textContent = text;
      scrubBubble.style.display = 'block';
      const rect = chartWrap.getBoundingClientRect();
      const edge = 8, gap = 12;
      const maxLeft = Math.max(edge, rect.width - scrubBubble.offsetWidth - edge);
      const maxTop = Math.max(edge, rect.height - scrubBubble.offsetHeight - edge);
      const left = Math.max(edge, Math.min(maxLeft, e.clientX - rect.left + gap));
      let top = e.clientY - rect.top - scrubBubble.offsetHeight - gap;
      if (top < edge) top = e.clientY - rect.top + gap;
      scrubBubble.style.left = `${left}px`;
      scrubBubble.style.top = `${Math.max(edge, Math.min(maxTop, top))}px`;
    };
    const scrub = (e) => {
      const rect = over.getBoundingClientRect();
      const left = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const top = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
      u.setCursor({ left, top });
      showReadout(e);
    };
    const selectFromChart = (e) => {
      scrub(e);
      const idx = u.cursor.idx;
      const sourceIdx = idx == null ? null : profile.sourceIndices[idx];
      const distance = sourceIdx == null ? null : stats?.series?.d?.[sourceIdx];
      selectSplit(splitIndexAtDistance(distance), 'chart');
    };
    over.addEventListener('click', (e) => {
      if (e.pointerType === 'mouse') selectFromChart(e);
    });
    over.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || pointerId != null) return;
      pointerId = e.pointerId;
      try { over.setPointerCapture(pointerId); } catch { /* capture unsupported */ }
      scrub(e);
    });
    over.addEventListener('pointermove', (e) => {
      if (e.pointerId === pointerId) scrub(e);
    });
    const end = (e) => {
      if (e.pointerId !== pointerId) return;
      selectFromChart(e);
      pointerId = null;
      scrubBubble.style.display = 'none';
      try { over.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };
    over.addEventListener('pointerup', end);
    over.addEventListener('pointercancel', end);
    over.addEventListener('pointerleave', end);
    over.addEventListener('lostpointercapture', end);
  }

  function destroyChart() {
    chart?.destroy();
    chart = null;
    chartStats = null;
    chartRenderKey = '';
    chartWrap.replaceChildren();
  }

  function syncSeriesVisibility(profile) {
    if (!profile.hasAlt) chartSeries.altitude = false;
    if (!profile.hasSpeed) chartSeries.speed = false;
    if (!chartSeries.altitude && !chartSeries.speed) {
      chartSeries.altitude = profile.hasAlt;
      chartSeries.speed = profile.hasSpeed;
    }
  }

  function toggleSeries(key) {
    if (!chartProfile || !(key === 'altitude' ? chartProfile.hasAlt : chartProfile.hasSpeed)) return;
    const other = key === 'altitude' ? 'speed' : 'altitude';
    if (chartSeries[key] && !chartSeries[other]) return;
    chartSeries[key] = !chartSeries[key];
    renderCharts(appState.stats);
  }

  function renderLegend(profile, units) {
    const P = canvasPalette();
    const specs = [
      { key: 'altitude', label: t('panel.altitude'), unit: altitudeUnit(units), color: P.accent, available: profile.hasAlt, hint: t('analysis.noAlt') },
      { key: 'speed', label: t('panel.speed'), unit: speedUnit(units), color: `rgb(${P.lut[1].join(',')})`, available: profile.hasSpeed, hint: t('analysis.noTimeData') }
    ];
    for (const spec of specs) {
      let button = legendButtons[spec.key];
      if (!button) {
        button = el('button', {
          type: 'button', class: 'chart-legend-toggle', 'data-series': spec.key,
          'aria-pressed': 'false', disabled: true
        }, el('span', {}, el('i', { 'aria-hidden': 'true' }), el('span', { class: 'chart-legend-label' })));
        button.onclick = () => toggleSeries(spec.key);
        legendButtons[spec.key] = button;
        chartLegend.append(button);
      }
      button.disabled = !spec.available;
      button.setAttribute('aria-pressed', String(spec.available && chartSeries[spec.key]));
      button.title = spec.available ? '' : spec.hint;
      button.querySelector('i').style.background = spec.color;
      button.querySelector('.chart-legend-label').textContent = `${spec.label} · ${spec.unit}`;
    }
  }

  function renderCharts(stats) {
    const full = appState.activeTripFull;
    flatPoints = full?.segments.flatMap((s) => usableTrackPoints(s.points || [])) || [];
    const trackKey = full ? `${full.trip.id}:${full.trip.updatedAt || 0}` : '';
    const units = get('units');
    if (!stats || !flatPoints.length) {
      destroyChart();
      chartProfile = null;
      renderLegend({ hasAlt: false, hasSpeed: false }, units);
      chartCard.style.display = 'none';
      return;
    }

    const profile = buildProfile(stats, units, 1800);
    syncSeriesVisibility(profile);
    const visible = {
      altitude: profile.hasAlt && chartSeries.altitude,
      speed: profile.hasSpeed && chartSeries.speed
    };
    chartProfile = profile;
    renderLegend(profile, units);
    if (!visible.altitude && !visible.speed) {
      destroyChart();
      chartCard.style.display = 'none';
      renderSlope(stats);
      return;
    }

    const renderKey = `${trackKey}:${units}:${effectiveTheme()}:${visible.altitude ? 1 : 0}${visible.speed ? 1 : 0}`;
    if (chart && chartStats === stats && chartRenderKey === renderKey) {
      chartCard.style.display = '';
      return;
    }
    destroyChart();
    chartCard.style.display = '';
    const opts = chartOpts(220, profile, visible);
    const data: any[] = [profile.x];
    if (visible.altitude) data.push(profile.alt);
    if (visible.speed) data.push(profile.speed);
    opts.hooks = { setCursor: [hoverHook(stats, profile, units, visible)], draw: [drawSelectedSplit] };
    chart = new uPlot(opts, data, chartWrap);
    chartStats = stats;
    chartRenderKey = renderKey;
    attachScrub(chart, stats, profile, units, visible);
    renderSlope(stats);
  }

  function renderSlope(stats) {
    const P = canvasPalette();
    const canvas = slopeCard.querySelector('#slope-canvas');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 300, h = 120;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const buckets = new Array(13).fill(0); // -30..30 step 5
    for (const s of stats.series.slope) {
      if (s == null) continue;
      const b = Math.max(0, Math.min(12, Math.floor((s + 30) / 5)));
      buckets[b]++;
    }
    const max = Math.max(1, ...buckets);
    const bw = w / 13;
    ctx.font = '10px system-ui';
    ctx.textAlign = 'center';
    buckets.forEach((n, i) => {
      const bh = (n / max) * (h - 26);
      const x = i * bw + 3;
      ctx.fillStyle = i < 6 ? `rgb(${P.lut[1].join(',')})` : i === 6 ? P.faint : P.amber;
      ctx.fillRect(x, h - 18 - bh, bw - 6, bh);
      ctx.fillStyle = P.muted;
      ctx.fillText(`${i * 5 - 30}`, i * bw + bw / 2, h - 5);
    });
  }

  function renderSegments(stats) {
    const box = segCard.querySelector('#seg-table');
    box.innerHTML = '';
    if (!stats?.segments?.length) { segCard.style.display = 'none'; return; }
    segCard.style.display = '';
    const units = get('units');
    const table = el('table', { style: { width: '100%', fontSize: '12.5px', borderCollapse: 'collapse' } });
    table.append(el('tr', { style: { color: 'var(--text-faint)', textAlign: 'left' } },
      el('th', { style: { padding: '4px' } }, '#'),
      el('th', {}, t('analysis.segDist')),
      el('th', {}, t('analysis.segTime')),
      el('th', {}, t('analysis.segAsc')),
      el('th', {}, t('analysis.points'))));
    stats.segments.forEach((s, i) => {
      const d = fmtDistance(s.distance, units);
      table.append(el('tr', { style: { borderTop: '1px solid var(--border)' } },
        el('td', { style: { padding: '5px 4px' } }, i + 1),
        el('td', { class: 'mono' }, `${d.v}${d.u}`),
        el('td', { class: 'mono' }, fmtDuration(s.duration, { compact: true })),
        el('td', { class: 'mono' }, `↑${Math.round(s.ascent)}m`),
        el('td', { class: 'mono' }, s.pointCount)));
    });
    box.append(table);
  }

  function renderTimeline() {
    const box = tlCard.querySelector('#timeline');
    box.innerHTML = '';
    const wps = (appState.activeTripFull?.waypoints || []).slice().sort((a, b) => (a.time || 0) - (b.time || 0));
    if (!wps.length) { tlCard.style.display = 'none'; return; }
    tlCard.style.display = '';
    const detail = (label, value) => el('div', { class: 'timeline-detail small' },
      el('strong', {}, label), el('span', {}, value));
    wps.forEach((w, i) => {
      const detailsId = `timeline-details-${w.id || i}`;
      const row = el('button', {
        type: 'button', class: 'setting-row timeline-row',
        'aria-expanded': 'false', 'aria-controls': detailsId
      },
      el('span', { style: { fontSize: '18px' }, 'aria-hidden': 'true' }, WP_ICONS[w.type] || '📍'),
      el('div', { class: 'txt' },
        el('div', { class: 't' }, w.name || t(`wp.types.${w.type}`)),
        el('div', { class: 'd' }, [w.time ? new Date(w.time).toLocaleString() : '', w.desc].filter(Boolean).join(' · '))),
      w.hidden ? el('span', { class: 'tag', title: t('wp.hidden'), 'aria-label': t('wp.hidden') }, '🚫') : null);
      const details = el('div', { class: 'timeline-details', id: detailsId, hidden: true },
        detail(t('wp.desc'), w.desc || t('common.none')),
        detail(t('wp.time'), w.time ? new Date(w.time).toLocaleString() : t('common.none')),
        detail(t('wp.hidden'), t(w.hidden ? 'common.yes' : 'common.no')),
        el('button', {
          type: 'button', class: 'btn sm timeline-view-map',
          onclick: () => {
            ensureMiniMap();
            if (embedded && appState.tripDetail.open && appState.tripDetail.section !== 'overview') navigate('analysis');
            requestAnimationFrame(() => {
              miniMap?.resize();
              miniMap?.flyTo(w.lat, w.lon, 15);
            });
          }
        }, icon('map', 14), t('trips.viewOnMap')));
      row.onclick = () => {
        const expanded = row.getAttribute('aria-expanded') === 'true';
        row.setAttribute('aria-expanded', String(!expanded));
        details.hidden = expanded;
      };
      box.append(el('div', { class: 'timeline-item' }, row, details));
    });
  }

  function drawSelectedSplit(u) {
    const selected = selectedSplitIndex == null ? null : splitResult[selectedSplitIndex];
    if (!selected || !chartProfile) return;
    const P = canvasPalette();
    const start = u.valToPos(distanceInUnit(selected.startDistance, chartProfile.units), 'x');
    const end = u.valToPos(distanceInUnit(selected.endDistance, chartProfile.units), 'x');
    const left = Math.min(start, end), width = Math.max(1, Math.abs(end - start));
    const ctx = u.ctx;
    ctx.save();
    ctx.fillStyle = P.accentSoft;
    ctx.fillRect(left, u.bbox.top, width, u.bbox.height);
    ctx.strokeStyle = P.amber;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(left, u.bbox.top); ctx.lineTo(left, u.bbox.top + u.bbox.height);
    ctx.moveTo(left + width, u.bbox.top); ctx.lineTo(left + width, u.bbox.top + u.bbox.height);
    ctx.stroke();
    ctx.restore();
  }

  function updateSplitSelection() {
    const rows = splitBody.querySelectorAll('.split-row');
    rows.forEach((row, index) => {
      const selected = index === selectedSplitIndex;
      row.classList.toggle('selected', selected);
      row.setAttribute('aria-pressed', String(selected));
    });
    const split = selectedSplitIndex == null ? null : splitResult[selectedSplitIndex];
    splitDetail.hidden = !split;
    splitDetail.replaceChildren();
    if (!split) return;
    const units = get('units');
    const net = fmtAltitude(split.netElevation, units);
    const efficiency = split.climbEfficiency == null ? null : fmtAltitude(split.climbEfficiency, units);
    const metric = (label, value) => el('div', { class: 'split-detail-metric' },
      el('span', {}, label), el('strong', { class: 'mono' }, value));
    const variation = (value) => value == null ? '—' : `${Math.round(value * 100)}%`;
    splitDetail.append(
      el('div', { class: 'split-detail-head' },
        el('strong', {}, t('analysis.splitsSelected', { n: selectedSplitIndex + 1 })),
        split.startAlt != null && split.endAlt != null
          ? el('span', { class: 'small faint mono' }, `${t('analysis.splitsStartAlt')} ${fmtAltitude(split.startAlt, units).v}${fmtAltitude(split.startAlt, units).u} → ${t('analysis.splitsEndAlt')} ${fmtAltitude(split.endAlt, units).v}${fmtAltitude(split.endAlt, units).u}`)
          : null),
      el('div', { class: 'split-detail-grid' },
        metric(t('analysis.splitsNetElevation'), split.netElevation == null ? '—' : `${split.netElevation >= 0 ? '↑' : '↓'}${net.v}${net.u}`),
        metric(t('analysis.splitsAvgSlope'), split.avgSlope == null ? '—' : `${split.avgSlope.toFixed(1)}%`),
        metric(t('analysis.splitsStill'), fmtDuration(split.stillMs, { compact: true })),
        metric(t('analysis.splitsBreak'), fmtDuration(split.breakMs, { compact: true })),
        metric(t('analysis.splitsSpeedCv'), variation(split.speedCv)),
        metric(t('analysis.splitsPaceCv'), variation(split.paceCv)),
        metric(t('analysis.splitsEfficiency'), efficiency ? `${efficiency.v}${efficiency.u}/h` : '—')),
      el('div', { class: 'small faint split-detail-note' }, t('analysis.splitsMetricNote')));
  }

  function renderSplitRows() {
    splitBody.innerHTML = '';
    if (!splitResult.length) {
      splitBody.append(el('div', { class: 'small faint' }, t('analysis.splitsEmpty')));
      updateSplitSelection();
      return;
    }
    const units = get('units');
    const list = el('div', { class: 'split-list', role: 'group', 'aria-label': t('analysis.splitsTitle') });
    splitResult.forEach((split, index) => {
      const distance = fmtDistance(split.distance, units);
      const speed = fmtSpeed(split.avgSpeed, units);
      const pace = fmtPace(split.avgSpeed, units);
      const ascent = fmtAltitude(split.ascent, units);
      const row = el('button', {
        type: 'button', class: 'split-row' + (selectedSplitIndex === index ? ' selected' : ''),
        'aria-pressed': String(selectedSplitIndex === index),
        'aria-label': t('analysis.splitsRowLabel', { n: index + 1, d: `${distance.v}${distance.u}`, time: fmtDuration(split.duration) })
      },
      el('span', { class: 'split-index mono' }, String(index + 1).padStart(2, '0')),
      el('span', { class: 'split-main' },
        el('span', { class: 'split-primary' },
          el('strong', { class: 'mono' }, `${distance.v}${distance.u}`),
          el('span', { class: 'mono' }, fmtDuration(split.duration)),
          split.partial ? el('span', { class: 'tag' }, t('analysis.splitsPartial')) : null),
        el('span', { class: 'split-secondary' },
          `${t('analysis.splitsMoving')} ${fmtDuration(split.movingMs, { compact: true })}`,
          ` · ${t('analysis.splitsAvgSpeed')} ${speed.v} ${speed.u}`,
          ` · ${t('analysis.splitsAvgPace')} ${pace.v}${pace.u}`,
          ` · ↑${ascent.v}${ascent.u}`)));
      row.onclick = () => selectSplit(index, 'row');
      list.append(row);
    });
    splitBody.append(list);
    updateSplitSelection();
  }

  async function renderSplits() {
    const sequence = ++splitSequence;
    const full = appState.activeTripFull;
    const trackKey = full ? `${full.trip.id}:${full.trip.updatedAt || 0}` : '';
    const computeKey = `${trackKey}:${Number(splitSelect.value)}`;
    if (!full?.segments.some((segment) => segment.points?.length)) {
      splitResult = [];
      selectedSplitIndex = null;
      splitTrackKey = trackKey;
      splitComputeKey = computeKey;
      splitCard.style.display = 'none';
      miniMap?.setSplitHighlight([]);
      return;
    }
    if (computeKey === splitComputeKey) return;
    splitComputeKey = computeKey;
    splitCard.style.display = '';
    if (trackKey !== splitTrackKey) {
      splitResult = [];
      selectedSplitIndex = null;
      splitTrackKey = trackKey;
      renderSplitRows();
    }
    try {
      const result = await computeDistanceSplitsAsync(
        full.segments.map((segment) => ({ id: segment.id, points: segment.points })),
        Number(splitSelect.value),
        { activity: full.trip.activity || 'hike' }
      );
      if (sequence !== splitSequence || trackKey !== splitTrackKey) return;
      splitResult = result;
      if (selectedSplitIndex != null && !splitResult[selectedSplitIndex]) selectedSplitIndex = null;
      renderSplitRows();
      if (selectedSplitIndex != null) miniMap?.setSplitHighlight(splitResult[selectedSplitIndex].parts);
    } catch (e) {
      if (sequence !== splitSequence) return;
      splitComputeKey = '';
      console.error(e);
      selectedSplitIndex = null;
      miniMap?.setSplitHighlight([]);
      chart?.redraw();
      splitBody.innerHTML = '';
      splitBody.append(el('div', { class: 'small', style: { color: 'var(--danger)' } }, t('analysis.splitsComputeFail')));
    }
  }

  splitSelect.onchange = () => {
    selectSplit(null, 'row');
    void renderSplits();
  };

  function renderGaps() {
    gapBody.innerHTML = '';
    const full = appState.activeTripFull;
    if (!full || full.segments.length < 2) { gapCard.style.display = 'none'; return; }
    const gaps = findTrackGaps(full.segments);
    if (!gaps.length) { gapCard.style.display = 'none'; return; }
    gapCard.style.display = '';
    const total = gaps.reduce((sum, g) => sum + g.distance, 0);
    const d = fmtDistance(total, get('units'));
    const btn = el('button', { class: 'btn primary sm' }, icon('routeFwd', 15), t('analysis.gapFill'));
    btn.onclick = async () => {
      const ok = await confirmModal({
        title: t('analysis.gapTitle'),
        message: t('analysis.gapConfirm', { n: gaps.length }),
        confirmText: t('analysis.gapFill')
      });
      if (!ok) return;
      if (!navigator.onLine) { toast(t('analysis.gapOffline'), 'warn'); return; }
      btn.disabled = true;
      try {
        const r = await repairTrackGaps(full.trip.id, {
          onProgress: ({ done, total: all }) => {
            btn.textContent = t('analysis.gapProgress', { done, total: all });
          }
        });
        if (r.repaired) {
          await refreshActiveTrip();
          const added = fmtDistance(r.distance, get('units'));
          toast(t('analysis.gapDone', { n: r.repaired, d: `${added.v}${added.u}` }), 'ok', 4500);
        }
        if (r.failed) toast(t('analysis.gapFail', { n: r.failed }), 'warn', 4500);
      } catch (e) {
        console.error(e);
        toast(t('analysis.gapFail', { n: gaps.length }), 'warn', 4500);
      }
      btn.disabled = false;
      btn.innerHTML = '';
      btn.append(icon('routeFwd', 15), t('analysis.gapFill'));
    };
    gapBody.append(
      el('div', { class: 'small muted' }, t('analysis.gapCount', { n: gaps.length, d: `${d.v}${d.u}` })),
      el('div', { class: 'small faint', style: { margin: '4px 0 10px' } }, t('analysis.gapNote')),
      btn
    );
  }

  async function renderAll() {
    const sequence = ++renderSequence;
    if (!embedded) await refreshTripList();
    if (!appState.activeTripId && tripSel.options.length > 1) await setActiveTrip(tripSel.options[1].value);
    if (sequence !== renderSequence) return;
    const full = appState.activeTripFull;
    const stats = appState.stats;
    if (!full || full.trip.id !== appState.activeTripId) {
      renderEmpty();
      return;
    }
    emptyBox.style.display = 'none';
    shareBtn.disabled = false;
    chartCard.style.display = '';
    slopeCard.style.display = '';
    miniMapBox.style.display = '';
    ensureMiniMap();
    const trackKey = `${full.trip.id}:${full.trip.updatedAt || 0}`;
    if (trackKey !== mapTrackKey) {
      mapTrackKey = trackKey;
      miniMap.setTrackData(full.segments, full.waypoints);
      setTimeout(() => { if (mapTrackKey === trackKey) miniMap?.fitTrack(30); }, 120);
    }
    renderGaps();
    renderStats(stats);
    renderQuality();
    renderCharts(stats);
    void renderSplits();
    renderSegments(stats);
    renderTimeline();
  }

  on('trip:active', () => { if (analysisActive()) void renderAll(); });
  on('trip:stats', (stats) => {
    if (!analysisActive()) return;
    renderStats(stats);
    renderQuality();
    renderCharts(stats);
    void renderSplits();
    renderSegments(stats);
  });
  on('theme:applied', () => {
    if (analysisActive() && appState.stats) { renderCharts(appState.stats); }
  });

  return {
    view,
    refresh: renderAll,
    resize: () => {
      miniMap?.resize();
      const w = chartWidth();
      chart?.setSize({ width: w, height: 220 });
      if (appState.stats) renderSlope(appState.stats);
    },
    destroy: () => {
      qualitySequence++;
      qualityTrackKey = '';
      repairSequence++;
      qualityController?.abort();
      repairController?.abort();
      splitSequence++;
      splitComputeKey = '';
      miniMap?.destroy();
      miniMap = null;
      chart?.destroy();
    }
  };
}