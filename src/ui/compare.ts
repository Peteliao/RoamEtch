import { t } from '../core/i18n';
import { routeRepository } from '../core/routeRepository';
import { fmtAltitude, fmtDistance, fmtDuration, fmtPace, fmtSpeed, wgs84TrackBounds } from '../core/geo';
import { get } from '../core/settings';
import { compareTracksAsync } from '../core/workerBridge';
import { suggestHistoricalTrips } from '../core/trackComparison';
import { TrackMap } from './map';
import { el, icon, modal, toast } from './helpers';
import '../styles/compare.css';

function summaryCard(label, summary, units, selected) {
  const mean = summary.meanErrorM == null ? null : fmtDistance(summary.meanErrorM, units);
  const p95 = summary.p95ErrorM == null ? null : fmtDistance(summary.p95ErrorM, units);
  const matched = fmtDistance(summary.matchedDistanceM, units);
  const unmatched = fmtDistance(summary.unmatchedDistanceM, units);
  return el('article', { class: 'compare-summary' + (selected ? ' selected' : '') },
    el('h4', {}, label, selected ? el('span', { class: 'tag' }, t('compare.bestDirection')) : null),
    el('div', { class: 'compare-summary-grid' },
      el('div', {}, el('span', {}, t('compare.meanError')), el('strong', { class: 'mono' }, mean ? `${mean.v}${mean.u}` : '—')),
      el('div', {}, el('span', {}, t('compare.p95Error')), el('strong', { class: 'mono' }, p95 ? `${p95.v}${p95.u}` : '—')),
      el('div', {}, el('span', {}, t('compare.matchedRatio')), el('strong', { class: 'mono' }, `${(summary.matchedRatio * 100).toFixed(1)}%`)),
      el('div', {}, el('span', {}, t('compare.matchedDistance')), el('strong', { class: 'mono' }, `${matched.v}${matched.u}`)),
      el('div', {}, el('span', {}, t('compare.unmatchedDistance')), el('strong', { class: 'mono' }, `${unmatched.v}${unmatched.u}`)),
      el('div', {}, el('span', {}, t('compare.lengthRatio')), el('strong', { class: 'mono' }, `${(summary.lengthRatio * 100).toFixed(1)}%`))));
}

function errorChart(samples, units) {
  if (!samples.length) return el('div', { class: 'small faint' }, t('compare.noSamples'));
  const maxError = Math.max(1, ...samples.map((sample) => sample.errorM));
  const maxDistance = Math.max(1, ...samples.map((sample) => sample.distanceM));
  const points = samples.map((sample) => `${(sample.distanceM / maxDistance * 300).toFixed(2)},${(68 - sample.errorM / maxError * 60).toFixed(2)}`).join(' ');
  const distance = fmtDistance(maxDistance, units);
  return el('div', { class: 'compare-chart' },
    el('svg', { viewBox: '0 0 300 76', role: 'img', 'aria-label': t('compare.errorChart') },
      el('line', { x1: '0', y1: '8', x2: '300', y2: '8', class: 'compare-chart-grid' }),
      el('line', { x1: '0', y1: '68', x2: '300', y2: '68', class: 'compare-chart-grid' }),
      el('polyline', { points, class: 'compare-chart-line' })),
    el('div', { class: 'small faint compare-chart-labels' },
      el('span', {}, `0`), el('span', {}, `${Math.round(maxError)}m`), el('span', {}, `${distance.v}${distance.u}`)));
}

function distanceText(value, units) {
  const formatted = fmtDistance(value, units);
  return formatted === '--' || formatted.v === '--' ? '—' : `${formatted.v}${formatted.u}`;
}

function altitudeText(value, units) {
  const formatted = fmtAltitude(value, units);
  return formatted.v === '--' ? '—' : `${formatted.v}${formatted.u}`;
}

function durationText(value) {
  return Number.isFinite(value) && value > 0 ? fmtDuration(value, { compact: true }) : '—';
}

function speedText(split, units) {
  if (!split) return '—';
  const formatted = fmtSpeed(split.avgSpeedMps, units);
  return `${formatted.v}${formatted.u}`;
}

function paceText(split, units) {
  if (!split || !(split.paceSecPerKm > 0)) return '—';
  const formatted = fmtPace(1000 / split.paceSecPerKm, units);
  return `${formatted.v}${formatted.u}`;
}

function efficiencyText(value) {
  return Number.isFinite(value) ? `${value.toFixed(0)} m/h` : '—';
}

function pairText(left, right) {
  return `${left} / ${right}`;
}

function comparisonTable(headers: string[], rows: string[][]) {
  return el('div', { class: 'compare-table-wrap' },
    el('table', { class: 'compare-table' },
      el('thead', {}, el('tr', {}, ...headers.map((header) => el('th', { scope: 'col' }, header)))),
      el('tbody', {}, ...rows.map((row) => el('tr', {}, ...row.map((cell, index) =>
        index === 0 ? el('th', { scope: 'row' }, cell) : el('td', {}, cell)))))));
}

function splitTable(analysisA, analysisB, units) {
  const count = Math.max(analysisA.splits.length, analysisB.splits.length);
  const rows = Array.from({ length: count }, (_, index) => {
    const a = analysisA.splits[index];
    const b = analysisB.splits[index];
    const partial = a?.partial || b?.partial ? ` · ${t('compare.partial')}` : '';
    return [
      `#${index + 1}${partial}`,
      pairText(a ? distanceText(a.distanceM, units) : '—', b ? distanceText(b.distanceM, units) : '—'),
      pairText(a ? durationText(a.durationMs) : '—', b ? durationText(b.durationMs) : '—'),
      pairText(paceText(a, units), paceText(b, units)),
      pairText(speedText(a, units), speedText(b, units)),
      pairText(a ? altitudeText(a.ascentM, units) : '—', b ? altitudeText(b.ascentM, units) : '—'),
      pairText(a ? efficiencyText(a.climbEfficiencyMph) : '—', b ? efficiencyText(b.climbEfficiencyMph) : '—')
    ];
  });
  return comparisonTable([
    t('compare.segment'), t('compare.distance'), t('compare.duration'), t('compare.pace'),
    t('compare.speed'), t('compare.ascent'), t('compare.efficiency')
  ], rows);
}

function slopeBandLabel(band) {
  if (band.minSlopePct == null) return t('compare.slopeBelow', { n: band.maxSlopePct });
  if (band.maxSlopePct == null) return t('compare.slopeAbove', { n: band.minSlopePct });
  return t('compare.slopeRange', { min: band.minSlopePct, max: band.maxSlopePct });
}

function slopeTable(analysisA, analysisB, units) {
  const count = Math.max(analysisA.slopeBands.length, analysisB.slopeBands.length);
  const rows = Array.from({ length: count }, (_, index) => {
    const a = analysisA.slopeBands[index];
    const b = analysisB.slopeBands[index];
    return [
      slopeBandLabel(a || b),
      pairText(a ? distanceText(a.distanceM, units) : '—', b ? distanceText(b.distanceM, units) : '—'),
      pairText(a ? altitudeText(a.ascentM, units) : '—', b ? altitudeText(b.ascentM, units) : '—'),
      pairText(a ? efficiencyText(a.climbEfficiencyMph) : '—', b ? efficiencyText(b.climbEfficiencyMph) : '—')
    ];
  });
  return comparisonTable([
    t('compare.slopeBand'), t('compare.distance'), t('compare.ascent'), t('compare.efficiency')
  ], rows);
}

function chartPaths(coordinates: Array<{ x: number; y: number } | null>, top = 12, bottom = 92): string[] {
  const paths: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 1) paths.push(current.join(' '));
    current = [];
  };
  for (const coordinate of coordinates) {
    if (!coordinate) {
      flush();
      continue;
    }
    current.push(`${coordinate.x.toFixed(2)},${coordinate.y.toFixed(2)}`);
  }
  flush();
  return paths;
}

function elevationChart(analysisA, analysisB, units) {
  const points = [...analysisA.elevation.points, ...analysisB.elevation.points];
  const altitudes = points.map((point) => point.altM).filter((alt) => alt != null);
  if (!altitudes.length) return el('p', { class: 'small faint' }, t('compare.noElevation'));
  const minAlt = Math.min(...altitudes);
  const maxAlt = Math.max(...altitudes);
  const range = maxAlt - minAlt;
  const maxDistance = Math.max(1, ...points.map((point) => point.distanceM));
  const pathsFor = (analysis) => chartPaths(analysis.elevation.points.map((point) => point.altM == null ? null : ({
    x: point.distanceM / maxDistance * 300,
    y: range > 0 ? 92 - (point.altM - minAlt) / range * 80 : 52
  })));
  return el('div', { class: 'compare-profile-chart' },
    el('svg', { viewBox: '0 0 300 108', role: 'img', 'aria-label': t('compare.elevationCurve') },
      el('line', { x1: '0', y1: '12', x2: '300', y2: '12', class: 'compare-chart-grid' }),
      el('line', { x1: '0', y1: '92', x2: '300', y2: '92', class: 'compare-chart-grid' }),
      ...pathsFor(analysisA).map((points) => el('polyline', { points, class: 'compare-elevation-a' })),
      ...pathsFor(analysisB).map((points) => el('polyline', { points, class: 'compare-elevation-b' }))),
    el('div', { class: 'small faint compare-chart-labels' },
      el('span', {}, altitudeText(minAlt, units)),
      el('span', {}, altitudeText(maxAlt, units)),
      el('span', {}, distanceText(maxDistance, units))));
}

function timeAlignmentChart(result, units) {
  if (!result.timeAlignment.length) return el('p', { class: 'small faint' }, t('compare.noSamples'));
  const maxElapsed = Math.max(1, ...result.timeAlignment.map((sample) => sample.elapsedMs));
  const maxDistance = Math.max(1, ...result.timeAlignment.flatMap((sample) => [
    sample.a?.distanceM ?? 0, sample.b?.distanceM ?? 0
  ]));
  const pathsFor = (side) => chartPaths(result.timeAlignment.map((sample) => {
    const point = sample[side];
    return point ? {
      x: point.elapsedMs / maxElapsed * 300,
      y: 92 - point.distanceM / maxDistance * 80
    } : null;
  }));
  return el('div', { class: 'compare-profile-chart' },
    el('svg', { viewBox: '0 0 300 108', role: 'img', 'aria-label': t('compare.timeAlignment') },
      el('line', { x1: '0', y1: '12', x2: '300', y2: '12', class: 'compare-chart-grid' }),
      el('line', { x1: '0', y1: '92', x2: '300', y2: '92', class: 'compare-chart-grid' }),
      ...pathsFor('a').map((points) => el('polyline', { points, class: 'compare-elevation-a' })),
      ...pathsFor('b').map((points) => el('polyline', { points, class: 'compare-elevation-b' }))),
    el('div', { class: 'small faint compare-chart-labels' },
      el('span', {}, '0'),
      el('span', {}, durationText(maxElapsed)),
      el('span', {}, distanceText(maxDistance, units))));
}

function professionalSections(result, units) {
  if (!result.analysis) return [];
  const analysisA = result.analysis.a;
  const analysisB = result.analysis.b;
  return [
    el('section', { class: 'compare-section' },
      el('h3', {}, t('compare.segmentPace')),
      splitTable(analysisA, analysisB, units)),
    el('div', { class: 'compare-procharts' },
      el('section', { class: 'compare-section' },
        el('h3', {}, t('compare.elevationCurve')),
        elevationChart(analysisA, analysisB, units)),
      el('section', { class: 'compare-section' },
        el('h3', {}, t('compare.timeAlignment')),
        timeAlignmentChart(result, units),
        el('p', { class: 'small faint' }, t('compare.timeAlignmentNote')))),
    el('section', { class: 'compare-section' },
      el('h3', {}, t('compare.slopeBands')),
      slopeTable(analysisA, analysisB, units),
      el('p', { class: 'small faint' }, t('compare.slopeBandsNote')))
  ];
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Track comparison aborted.', 'AbortError');
}

function prepareTrack(full, signal: AbortSignal) {
  throwIfAborted(signal);
  const sourceSegments = full?.segments || [];
  const sourcePointCount = sourceSegments.reduce((sum, segment) => sum + (segment.points?.length || 0), 0);
  // Full source geometry goes directly to the local comparison worker. GPS
  // quality, resampling, and split analysis must all see the original fixes.
  return {
    id: full?.trip?.id,
    name: full?.trip?.name,
    activity: full?.trip?.activity || 'hike',
    segments: sourceSegments,
    stats: full?.trip?.statsCache,
    sourcePointCount
  };
}

export function openTrackComparison(trips, initialAId = null) {
  const usable = trips.filter((trip) => trip.status !== 'recording' && trip.status !== 'paused');
  if (usable.length < 2) { toast(t('compare.needTwo'), 'warn'); return null; }
  let aId = usable.some((trip) => trip.id === initialAId) ? initialAId : usable[0].id;
  const initialSuggestions = suggestHistoricalTrips(usable, usable.find((trip) => trip.id === aId), 3);
  let bId = initialSuggestions[0]?.id ?? usable.find((trip) => trip.id !== aId)?.id;
  let controller: AbortController | null = null;
  let busy = false;
  let closed = false;
  let map: TrackMap | null = null;
  const mapBox = el('div', { class: 'compare-map' });
  const status = el('div', { class: 'compare-status', role: 'status', 'aria-live': 'polite' });
  const resultBox = el('div', { class: 'compare-result' });
  const historyBox = el('section', { class: 'compare-history', 'aria-label': t('compare.historyTitle') });
  const select = (value, side) => el('select', { class: 'input compare-select', 'aria-label': t(`compare.track${side}`) },
    ...usable.map((trip) => el('option', { value: trip.id, selected: trip.id === value }, trip.name || new Date(trip.createdAt).toLocaleString())));
  const aSelect = select(aId, 'A');
  const bSelect = select(bId, 'B');
  aSelect.onchange = () => {
    if (busy) return;
    aId = aSelect.value;
    if (aId === bId) {
      bId = usable.find((trip) => trip.id !== aId).id;
      bSelect.value = bId;
    }
    applyHistorySuggestion();
  };
  bSelect.onchange = () => {
    if (busy) return;
    bId = bSelect.value;
    if (aId === bId) {
      aId = usable.find((trip) => trip.id !== bId).id;
      aSelect.value = aId;
      applyHistorySuggestion();
    } else renderHistory();
  };

  function renderHistory() {
    const current = usable.find((trip) => trip.id === aId);
    const suggestions = suggestHistoricalTrips(usable, current, 3);
    const units = get('units');
    historyBox.replaceChildren(
      el('h3', {}, t('compare.historyTitle')),
      el('p', { class: 'small faint' }, t('compare.historyNote')),
      suggestions.length ? el('div', { class: 'compare-history-list' },
        ...suggestions.map((trip) => {
          const timestamp = new Date(trip.createdAt).getTime();
          const date = Number.isFinite(timestamp) ? new Date(timestamp).toLocaleDateString() : '';
          const stats = trip.statsCache || trip.stats || {};
          const name = trip.name || date || t('compare.untitled');
          const detail = [date, distanceText(Number(stats.distance), units)].filter(Boolean).join(' · ');
          return el('button', {
            type: 'button',
            class: 'btn compare-history-item' + (trip.id === bId ? ' selected' : ''),
            title: t('compare.historyCompare', { name }),
            disabled: busy,
            onclick: () => {
              if (busy) return;
              bId = trip.id;
              bSelect.value = bId;
              renderHistory();
              void run();
            }
          }, el('span', {}, name), detail ? el('span', { class: 'small faint' }, detail) : null);
        })) : el('p', { class: 'small faint' }, t('compare.historyEmpty')));
  }

  function applyHistorySuggestion() {
    const current = usable.find((trip) => trip.id === aId);
    const suggestion = suggestHistoricalTrips(usable, current, 1)[0];
    if (suggestion && suggestion.id !== bId) {
      bId = suggestion.id;
      bSelect.value = bId;
    }
    renderHistory();
  }
  const runButton = el('button', { class: 'btn primary' }, icon('analysis', 15), t('compare.run'));
  const swapButton = el('button', { class: 'btn', title: t('compare.swap') }, icon('routeRev', 15), t('compare.swap'));
  runButton.onclick = () => void run();
  swapButton.onclick = () => {
    if (busy) return;
    [aId, bId] = [bId, aId];
    aSelect.value = aId;
    bSelect.value = bId;
    renderHistory();
    void run();
  };
  const body = el('div', { class: 'compare-view' },
    el('div', { class: 'compare-pickers' },
      el('label', {}, el('span', {}, 'A'), aSelect),
      el('label', {}, el('span', {}, 'B'), bSelect),
      swapButton, runButton),
    el('p', { class: 'small faint compare-intro' }, t('compare.intro')),
    historyBox, status, resultBox);
  const dialog = modal({ title: t('compare.title'), body, wide: true, onClose: () => {
    closed = true;
    controller?.abort();
    map?.destroy();
  } });

  function renderMap(trackA, trackB) {
    if (closed) return;
    const segments = [...(trackA.segments || []), ...(trackB.segments || [])];
    const bbox = wgs84TrackBounds(segments);
    if (!map) {
      const center = bbox
        ? [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]
        : [116.4, 39.9];
      map = new TrackMap(mapBox, { compact: true, preserveDrawingBuffer: false }).init(center, bbox ? 12 : 10);
    }
    map.setOverlayTracks([
      { id: trackA.id, name: trackA.name, color: '#5bb8ff', opacity: 0.95, segments: trackA.segments },
      { id: trackB.id, name: trackB.name, color: '#ffb454', opacity: 0.95, segments: trackB.segments }
    ]);
    if (bbox) {
      if (bbox[0] === bbox[2] && bbox[1] === bbox[3]) map.flyTo(bbox[1], bbox[0], 15);
      else map.fitWgs84Bounds(bbox);
    }
    requestAnimationFrame(() => map?.resize());
  }

  function renderResult(result, trackA, trackB) {
    const units = get('units');
    const ranked = [...result.samples].sort((left, right) => right.errorM - left.errorM);
    const worst = result.worstSample
      ? [result.worstSample, ...ranked.filter((sample) =>
        sample.distanceM !== result.worstSample.distanceM || sample.errorM !== result.worstSample.errorM)].slice(0, 5)
      : ranked.slice(0, 5);
    const quality = (side) => {
      const value = result.gpsQuality[side];
      return `${value.score == null ? '—' : value.score}/100 · ${value.avgAcc == null ? t('analysis.qualityNoAcc') : `${t('analysis.qualityAvgAcc')} ${value.avgAcc.toFixed(1)}m`}`;
    };
    const mapSection = el('section', { class: 'compare-section compare-map-section' },
      el('h3', {}, t('compare.overlayTitle')),
      el('p', { class: 'small faint compare-map-hint' }, t('compare.overlayHint')),
      mapBox);
    const content = [
      el('div', { class: 'compare-legend' },
        el('span', {}, el('i', { style: { background: '#5bb8ff' } }), `A · ${trackA.name || t('compare.untitled')}`),
        el('span', {}, el('i', { style: { background: '#ffb454' } }), `B · ${trackB.name || t('compare.untitled')}`)),
      mapSection,
      el('div', { class: 'compare-summaries' },
        summaryCard(t('compare.forward'), result.summaries.forward, units, result.direction === 'forward'),
        summaryCard(t('compare.reverse'), result.summaries.reverse, units, result.direction === 'reverse')),
      result.direction ? el('div', { class: 'compare-direction' }, icon('routeFwd', 16),
        el('div', {}, el('strong', {}, t('compare.direction', { direction: t(`compare.${result.direction}`) })),
          el('div', { class: 'small faint' }, t('compare.tolerance', { n: result.toleranceM })))) : null,
      el('section', { class: 'compare-section' },
        el('h3', {}, t('compare.errorChart')),
        errorChart(result.samples, units),
        el('p', { class: 'small faint' }, t('compare.sampling', {
          spacing: result.sampling.aEffectiveSpacingM.toFixed(1),
          samples: result.sampling.aSampleCount + result.sampling.bSampleCount,
          limited: result.sampling.limited ? t('common.yes') : t('common.no')
        }))),
      el('section', { class: 'compare-section' },
        el('h3', {}, t('compare.worstSamples')),
        worst.length ? el('div', { class: 'compare-sample-list' },
          ...worst.map((sample, index) => el('button', {
            type: 'button', class: 'compare-sample', onclick: () => map?.setSplitHighlight([{ points: [sample.a] }], true)
          }, el('span', { class: 'mono' }, `#${index + 1}`),
            el('span', { class: 'mono' }, `${fmtDistance(sample.distanceM, units).v}${fmtDistance(sample.distanceM, units).u}`),
            el('strong', { class: 'mono' }, `${sample.errorM.toFixed(1)}m`),
            icon('map', 14))))
          : el('p', { class: 'small faint' }, t('compare.noSamples'))),
      ...professionalSections(result, units),
      el('section', { class: 'compare-section compare-quality' },
        el('h3', {}, t('analysis.qualityTitle')),
        el('div', {}, el('span', {}, `A · ${trackA.name || t('compare.untitled')}`), el('strong', {}, quality('a'))),
        el('div', {}, el('span', {}, `B · ${trackB.name || t('compare.untitled')}`), el('strong', {}, quality('b'))),
        el('p', { class: 'small faint' }, t('analysis.qualityNote'))),
      el('p', { class: 'small faint compare-note' }, t('compare.note')),
      result.errors.length ? el('p', { class: 'small growth-warning' }, t('compare.invalidPoints', { n: result.errors.reduce((sum, error) => sum + error.count, 0) })) : null,
      el('div', { class: 'compare-track-meta' },
        el('span', {}, `A · ${fmtDistance(result.tracks.a.lengthM, units).v}${fmtDistance(result.tracks.a.lengthM, units).u} · ${result.tracks.a.pointCount} ${t('analysis.points')}`),
        el('span', {}, `B · ${fmtDistance(result.tracks.b.lengthM, units).v}${fmtDistance(result.tracks.b.lengthM, units).u} · ${result.tracks.b.pointCount} ${t('analysis.points')}`))
    ].filter((node): node is HTMLElement => Boolean(node));
    resultBox.replaceChildren(...content);
    const displayA = result.displayTracks?.a ? { ...trackA, segments: result.displayTracks.a } : trackA;
    const displayB = result.displayTracks?.b ? { ...trackB, segments: result.displayTracks.b } : trackB;
    renderMap(displayA, displayB);
  }

  function setBusy(value: boolean) {
    busy = value;
    aSelect.disabled = value;
    bSelect.disabled = value;
    runButton.disabled = value;
    swapButton.disabled = value;
    historyBox.querySelectorAll('button').forEach((button) => { button.disabled = value; });
  }

  async function run() {
    if (closed || busy || !aId || !bId || aId === bId) return;
    const requestedAId = aId;
    const requestedBId = bId;
    controller?.abort();
    const current = new AbortController();
    controller = current;
    setBusy(true);
    resultBox.replaceChildren();
    status.replaceChildren(icon('refresh', 16), t('compare.loading'));
    try {
      const loadedA = await routeRepository.load(requestedAId);
      throwIfAborted(current.signal);
      if (!loadedA) throw new Error('Trip A unavailable');
      status.replaceChildren(icon('refresh', 16), t('compare.preparing'));
      const trackA = await prepareTrack(loadedA, current.signal);
      throwIfAborted(current.signal);
      const loadedB = await routeRepository.load(requestedBId);
      throwIfAborted(current.signal);
      if (!loadedB) throw new Error('Trip B unavailable');
      const trackB = await prepareTrack(loadedB, current.signal);
      throwIfAborted(current.signal);
      status.replaceChildren(icon('refresh', 16), t('compare.calculating'));
      const result = await compareTracksAsync(trackA, trackB, { sampleSpacingM: 10, maxSamples: 2000 }, { signal: current.signal });
      throwIfAborted(current.signal);
      if (closed) return;
      status.replaceChildren();
      renderResult(result, trackA, trackB);
    } catch (error) {
      if (closed || current.signal.aborted || error?.name === 'AbortError') return;
      console.error(error);
      status.replaceChildren(el('span', { class: 'growth-warning' }, t('compare.failed')));
    } finally {
      if (!closed && controller === current) {
        controller = null;
        setBusy(false);
      }
    }
  }

  renderHistory();
  void run();
  return dialog;
}
