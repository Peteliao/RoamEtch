// Analysis view: stats grid, combined elevation/speed chart linked with a mini map,
// slope distribution, segment table, timeline, difficulty & fatigue advisories.
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { t } from '../core/i18n';
import { get } from '../core/settings';
import { on } from '../core/events';
import { getTrackSnapshotSummary, listTrips } from '../core/store';
import { fmtDistance, fmtDuration, fmtSpeed, fmtPace, fmtAltitude, usableTrackPoints } from '../core/geo';
import { findTrackGaps, repairTrackGaps } from '../core/gapRepair';
import { assessGpsQuality, cleanTrackSegments } from '../core/gpsQuality';
import { cleanGpsTrack, restoreGpsTrack } from '../core/trackCleanup';
import { TrackMap } from './map';
import { WP_ICONS } from '../core/waypointMeta';
import { canvasPalette } from '../core/palette';
import { effectiveTheme } from '../core/theme';
import { buildProfile, altitudeUnit, distanceInUnit, distanceUnit, speedUnit } from '../core/profileChart';
import { computeDistanceSplitsAsync } from '../core/workerBridge';
import { appState, setActiveTrip, refreshActiveTrip, isTripSectionActive } from './state';
import { el, icon, confirmModal, toast } from './helpers';
import { renderTripEmptyState } from './tripEmptyState';

export function createAnalysisView(navigate, { embedded = false } = {}) {
  const view = el('div', { class: 'view', id: 'view-analysis' });
  const scroll = el('div', { class: 'view-scroll' });
  view.append(scroll);

  const tripSel = el('select', { 'aria-label': t('analysis.selectTrip') });
  const shareBtn = el('button', { class: 'btn sm', onclick: () => navigate('export') }, icon('share', 14), t('tabs.export'));
  const head = el('div', { class: 'page-head analysis-head' },
    el('div', { class: 'page-head-row' },
      el('h2', { class: 'page-title' }, t('analysis.title')),
      embedded ? null : shareBtn),
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
    splitBody);
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
  let splitSequence = 0;
  let splitResult = [];
  let splitTrackKey = '';
  let selectedSplitIndex: number | null = null;
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
    miniMap = new TrackMap(miniMapBox, { compact: true, preserveDrawingBuffer: false }).init([116.4, 39.9], 10);
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

  async function renderQuality() {
    const sequence = ++qualitySequence;
    qualityBox.innerHTML = '';
    const full = appState.activeTripFull;
    if (!full) return;
    const tripId = full.trip.id;
    const updatedAt = full.trip.updatedAt;
    const points = full.segments.flatMap((s) => s.points) || [];
    const activity = full.trip.activity || 'hike';
    const q = assessGpsQuality(points, { activity });
    const snapshot = await getTrackSnapshotSummary(tripId);
    if (sequence !== qualitySequence || appState.activeTripId !== tripId || appState.activeTripFull?.trip.updatedAt !== updatedAt) return;
    if (q.score == null && !snapshot) return;
    const recording = full.trip.status === 'recording';
    const tone = q.rating === 'excellent' || q.rating === 'good'
      ? 'var(--accent)' : q.rating === 'fair' ? 'var(--warn)' : 'var(--danger)';
    const metric = (label, value) => el('div', { class: 'quality-metric' },
      el('div', { class: 'v' }, value), el('div', { class: 'k' }, label));
    const preview = recording ? { removed: 0, issues: [], impactDistance: 0 } : cleanTrackSegments(full.segments, activity);
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

    if (preview.removed) {
      const impact = fmtDistance(preview.impactDistance || 0, get('units'));
      const issues = el('div', { class: 'gps-issues' });
      for (const issue of preview.issues) {
        const distance = fmtDistance(issue.distance, get('units'));
        const first = issue.firstPoint;
        const view = el('button', {
          type: 'button', class: 'gps-issue', 'aria-label': t('analysis.qualityIssueView', { segment: issue.segmentIndex + 1 }),
          onclick: () => {
            ensureMiniMap();
            if (embedded && appState.tripDetail.open && appState.tripDetail.section !== 'overview') navigate('analysis');
            requestAnimationFrame(() => {
              miniMap?.resize();
              miniMap?.flyTo(first.lat, first.lon, 16);
              miniMap?.showHover(first.lat, first.lon, t(`analysis.qualityReason.${issue.reason}`));
              miniMapBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
          }
        },
        el('span', { class: 'gps-issue-reason' }, t(`analysis.qualityReason.${issue.reason}`)),
        el('span', { class: 'gps-issue-meta' },
          `${t('analysis.qualitySegment', { n: issue.segmentIndex + 1 })} · ${t('analysis.qualityIssuePoints', { n: issue.count })} · ${distance.v}${distance.u}`));
        issues.append(view);
      }
      const btn = el('button', { class: 'btn primary sm' }, icon('shield', 15), t('analysis.qualityClean'));
      btn.onclick = async () => {
        const ok = await confirmModal({
          title: t('analysis.qualityCleanTitle'),
          message: t('analysis.qualityCleanConfirm', { n: preview.removed }),
          confirmText: t('analysis.qualityClean')
        });
        if (!ok) return;
        btn.disabled = true;
        try {
          const result = await cleanGpsTrack(tripId, { activity, preview, expectedUpdatedAt: updatedAt });
          await refreshActiveTrip(tripId);
          if (result.removed) toast(t('analysis.qualityCleanDone', { n: result.removed }), 'ok', 4500);
        } catch (e) {
          console.error(e);
          toast(t(e?.message === 'track-changed' ? 'analysis.qualityChanged' : 'analysis.qualityCleanFail'), 'warn');
          btn.disabled = false;
        }
      };
      children.push(
        el('div', { class: 'gps-preview' },
          el('div', { class: 'gps-preview-head' },
            el('strong', {}, t('analysis.qualityPreviewTitle', { n: preview.removed })),
            el('span', { class: 'tag' }, t('analysis.qualityImpact', { d: `${impact.v}${impact.u}` }))),
          issues, btn,
          el('div', { class: 'small faint' }, t('analysis.qualityCleanHint'))));
    }

    if (snapshot) {
      const restore = el('button', { class: 'btn sm', disabled: recording }, icon('undo', 14), t('analysis.qualityRestore'));
      restore.onclick = async () => {
        const ok = await confirmModal({
          title: t('analysis.qualityRestoreTitle'),
          message: t('analysis.qualityRestoreConfirm', { n: snapshot.points }),
          confirmText: t('analysis.qualityRestore'), danger: true
        });
        if (!ok) return;
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

  function renderSplitRows() {
    splitBody.innerHTML = '';
    if (!splitResult.length) {
      splitBody.append(el('div', { class: 'small faint' }, t('analysis.splitsEmpty')));
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
      row.onclick = () => {
        selectedSplitIndex = selectedSplitIndex === index ? null : index;
        renderSplitRows();
        const selected = selectedSplitIndex == null ? null : splitResult[selectedSplitIndex];
        miniMap?.setSplitHighlight(selected?.parts || [], !!selected);
        chart?.redraw();
      };
      list.append(row);
    });
    splitBody.append(list);
  }

  async function renderSplits() {
    const sequence = ++splitSequence;
    const full = appState.activeTripFull;
    const trackKey = full ? `${full.trip.id}:${full.trip.updatedAt || 0}` : '';
    if (!full?.segments.some((segment) => segment.points?.length)) {
      splitResult = [];
      selectedSplitIndex = null;
      splitTrackKey = trackKey;
      splitCard.style.display = 'none';
      miniMap?.setSplitHighlight([]);
      return;
    }
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
      console.error(e);
      selectedSplitIndex = null;
      miniMap?.setSplitHighlight([]);
      chart?.redraw();
      splitBody.innerHTML = '';
      splitBody.append(el('div', { class: 'small', style: { color: 'var(--danger)' } }, t('analysis.splitsComputeFail')));
    }
  }

  splitSelect.onchange = () => {
    selectedSplitIndex = null;
    miniMap?.setSplitHighlight([]);
    chart?.redraw();
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
      splitSequence++;
      miniMap?.destroy();
      miniMap = null;
      chart?.destroy();
    }
  };
}