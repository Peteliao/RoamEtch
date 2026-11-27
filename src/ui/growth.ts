import { t } from '../core/i18n';
import { get } from '../core/settings';
import { routeRepository } from '../core/routeRepository';
import { fmtAltitude, fmtDistance, fmtDuration, fmtPace, fmtSpeed } from '../core/geo';
import {
  buildAnnualReport,
  buildPersonalRecords,
  DEFAULT_RECORD_DISTANCES,
  type AnnualReport,
  type AnnualTotals,
  type PersonalRecord
} from '../core/annualReport';
import { buildAnnualReportAsync, computeDistanceSplitsAsync } from '../core/workerBridge';
import { generateFootprintImage } from '../core/footprintShare';
import { exportImage, nativeShare } from '../core/shareEnv';
import { el, icon, modal, toast } from './helpers';
import '../styles/growth.css';

export const GROWTH_ALL_ACTIVITIES = 'all';

const KNOWN_ACTIVITIES = new Set(['auto', 'hike', 'drive', 'bike', 'run', 'travel']);
const COMPARE_KEYS = ['distance', 'duration', 'movingMs', 'tripCount', 'activeDays'] as const;

type CompareKey = typeof COMPARE_KEYS[number];

export interface AnnualComparison {
  key: CompareKey;
  current: number;
  previous: number;
  delta: number;
  /** Null when the previous value is zero and the current value is positive. */
  percent: number | null;
}

export interface AnnualShareFootprint {
  year: number;
  trips: number;
  distance: number;
  ascent: number;
  duration: number;
  days: number;
  cities: [];
  months: Array<{ month: number; trips: number; distance: number; ascent: number }>;
}

function validYear(value: any): value is number {
  return Number.isInteger(value) && value >= 1 && value <= 9999;
}

export function normalizeGrowthActivity(value: any): string {
  return String(value || '').trim() || 'unknown';
}

export function completedGrowthTrips(trips: any[]): any[] {
  return (Array.isArray(trips) ? trips : [])
    .filter((trip) => trip && trip.status !== 'recording' && trip.status !== 'paused');
}

export function growthTripYear(trip: any): number | null {
  const timestamp = new Date(trip?.createdAt).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const year = new Date(timestamp).getFullYear();
  return validYear(year) ? year : null;
}

/** Whether a recording can contain an effort that starts in the requested local year. */
export function growthTripOverlapsYear(trip: any, year: number): boolean {
  if (!validYear(year)) return false;
  const timestamp = new Date(trip?.createdAt).getTime();
  if (!Number.isFinite(timestamp)) return false;
  const duration = Number(trip?.statsCache?.duration);
  const recordedMs = Number.isFinite(duration) && duration > 0 ? duration : 0;
  return timestamp < new Date(year + 1, 0, 1).getTime()
    && timestamp + recordedMs >= new Date(year, 0, 1).getTime();
}

export function buildGrowthYearOptions(trips: any[], initialYear?: number, now = new Date()): number[] {
  const years = new Set<number>();
  for (const trip of completedGrowthTrips(trips)) {
    const year = growthTripYear(trip);
    if (year != null) years.add(year);
  }
  if (validYear(initialYear)) years.add(initialYear);
  const currentYear = now.getFullYear();
  if (validYear(currentYear)) years.add(currentYear);
  // Include empty years between the first trip/request and the present so the
  // selector can show a genuine zero-report without manufacturing any metrics.
  const sorted = [...years].sort((a, b) => a - b);
  if (sorted.length > 1 && sorted[sorted.length - 1] - sorted[0] <= 100) {
    for (let year = sorted[0]; year <= sorted[sorted.length - 1]; year++) years.add(year);
  }
  return [...years].sort((a, b) => b - a);
}

export function filterGrowthEntries(trips: any[], year: number, activity = GROWTH_ALL_ACTIVITIES): Array<{ trip: any; stats: any }> {
  if (!validYear(year)) return [];
  return completedGrowthTrips(trips)
    .filter((trip) => growthTripYear(trip) === year)
    .filter((trip) => activity === GROWTH_ALL_ACTIVITIES || normalizeGrowthActivity(trip.activity) === activity)
    .map((trip) => ({ trip, stats: trip.statsCache || {} }));
}

/**
 * Privacy boundary for the existing aggregate poster renderer. Copy only
 * numeric annual/monthly totals; never pass trips, tracks, names or cities.
 */
export function buildAnnualShareFootprint(report: AnnualReport): AnnualShareFootprint {
  return {
    year: report.year,
    trips: report.totals.tripCount,
    distance: report.totals.distance,
    ascent: report.totals.ascent,
    duration: report.totals.duration,
    days: report.totals.activeDays,
    cities: [],
    months: report.months.map((month) => ({
      month: month.month,
      trips: month.tripCount,
      distance: month.distance,
      ascent: month.ascent
    }))
  };
}

function shareActivityLabel(activity: string): string {
  if (activity === GROWTH_ALL_ACTIVITIES) return t('growth.allActivities');
  return KNOWN_ACTIVITIES.has(activity)
    ? t(`record.activities.${activity}`)
    : t('record.activities.unknown');
}

export function buildAnnualShareText(report: AnnualReport, activity = GROWTH_ALL_ACTIVITIES, units = get('units')): string {
  const distance = fmtDistance(report.totals.distance, units);
  const ascent = fmtAltitude(report.totals.ascent, units);
  return t('growth.shareText', {
    year: report.year,
    activity: shareActivityLabel(activity),
    trips: report.totals.tripCount,
    distance: `${distance.v}${distance.u}`,
    ascent: `${ascent.v}${ascent.u}`,
    duration: fmtDuration(report.totals.duration, { compact: true }),
    moving: fmtDuration(report.totals.movingMs, { compact: true }),
    days: report.totals.activeDays,
    months: report.months.filter((month) => month.tripCount > 0).length
  });
}

export function compareAnnualTotals(current: AnnualTotals, previous: AnnualTotals): AnnualComparison[] {
  return COMPARE_KEYS.map((key) => {
    const currentValue = Number(current?.[key]) || 0;
    const previousValue = Number(previous?.[key]) || 0;
    const delta = currentValue - previousValue;
    return {
      key,
      current: currentValue,
      previous: previousValue,
      delta,
      percent: previousValue > 0 ? delta / previousValue * 100 : currentValue > 0 ? null : 0
    };
  });
}

function metric(label, value) {
  return el('div', { class: 'growth-metric' }, el('span', { class: 'k' }, label), el('strong', {}, value));
}

function tripAction(tripId, onOpenTrip) {
  if (tripId == null || !onOpenTrip) return null;
  return el('button', {
    type: 'button', class: 'btn sm', onclick: () => { onOpenTrip(tripId); }
  }, icon('routeFwd', 14), t('growth.openTrip'));
}

function recordDetails(record, units) {
  const distance = fmtDistance(record.source.startDistance, units);
  const endDistance = fmtDistance(record.source.endDistance, units);
  const speed = fmtSpeed(record.avgSpeed, units);
  const pace = fmtPace(record.avgSpeed, units);
  const source = record.source;
  return el('details', { class: 'growth-record-source' },
    el('summary', {}, t('growth.recordSource')),
    el('dl', {},
      el('div', {}, el('dt', {}, t('growth.recordDate')), el('dd', {}, `${record.date} · ${new Date(record.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`)),
      el('div', {}, el('dt', {}, t('growth.recordElapsed')), el('dd', {}, fmtDuration(record.elapsedMs))),
      el('div', {}, el('dt', {}, t('growth.recordMoving')), el('dd', {}, fmtDuration(record.movingMs))),
      el('div', {}, el('dt', {}, t('growth.recordPace')), el('dd', {}, `${pace.v}${pace.u} · ${speed.v} ${speed.u}`)),
      el('div', {}, el('dt', {}, t('growth.recordRange')), el('dd', { class: 'mono' }, `${distance.v}${distance.u} → ${endDistance.v}${endDistance.u}`)),
      el('div', {}, el('dt', {}, t('growth.recordProvenance')), el('dd', {}, t('growth.recordProvenanceValue', { splits: source.splitIndexes.length, parts: source.parts.length }))),
      el('div', {}, el('dt', {}, t('growth.recordInterpolation')), el('dd', {}, `${source.startBoundary.interpolated ? t('common.yes') : t('common.no')} / ${source.endBoundary.interpolated ? t('common.yes') : t('common.no')}`))));
}

function recordCard(record, units, onOpenTrip) {
  const moving = fmtDuration(record.movingMs);
  const distance = fmtDistance(record.distance, units);
  return el('article', { class: 'growth-record' },
    el('div', { class: 'growth-record-head' },
      el('strong', { class: 'mono' }, `${distance.v}${distance.u}`),
      el('span', { class: 'tag' }, t(`record.activities.${record.activity}`)),
      tripAction(record.tripId, onOpenTrip)),
    el('div', { class: 'growth-record-name' }, record.name || t('growth.untitledTrip')),
    el('div', { class: 'growth-record-time' }, t('growth.recordMoving'), el('strong', { class: 'mono' }, moving)),
    el('div', { class: 'small faint' }, `${record.date} · ${t('growth.recordElapsed')} ${fmtDuration(record.elapsedMs)}`),
    recordDetails(record, units));
}

function barHeight(value: number, max: number): string {
  if (!(value > 0) || !Number.isFinite(value)) return '0%';
  return `${Math.max(2, Math.round(value / Math.max(1, max) * 100))}%`;
}

function monthlyCard(report: AnnualReport, units) {
  const maxDistance = Math.max(1, ...report.months.map((month) => month.distance));
  const maxDuration = Math.max(1, ...report.months.map((month) => month.duration));
  return el('section', { class: 'growth-section' },
    el('h3', {}, t('growth.monthlyMetrics')),
    el('div', { class: 'growth-chart-legend' },
      el('span', {}, el('i', { class: 'growth-legend-distance' }), t('analysis.distance')),
      el('span', {}, el('i', { class: 'growth-legend-duration' }), t('analysis.duration'))),
    el('div', { class: 'growth-month-scroll' },
      el('div', { class: 'growth-months', 'aria-label': t('growth.monthlyMetrics') },
        ...report.months.map((month) => {
          const distance = fmtDistance(month.distance, units);
          const duration = fmtDuration(month.duration, { compact: true });
          const label = `${month.month} · ${t('analysis.distance')} ${distance.v}${distance.u} · ${t('analysis.duration')} ${duration} · ${month.tripCount} ${t('growth.tripCount')}`;
          return el('div', {
            class: 'growth-month', title: label, 'aria-label': label,
            'data-month': String(month.month),
            'data-month-distance': String(month.distance),
            'data-month-duration': String(month.duration)
          },
          el('div', { class: 'growth-month-bars' },
            el('div', { class: 'growth-bar-track' }, el('i', { class: 'growth-distance-bar', style: { height: barHeight(month.distance, maxDistance) } })),
            el('div', { class: 'growth-bar-track' }, el('i', { class: 'growth-duration-bar', style: { height: barHeight(month.duration, maxDuration) } }))),
          el('span', { class: 'growth-month-distance' }, `${distance.v}${distance.u}`),
          el('span', { class: 'growth-month-label' }, String(month.month)),
          el('span', { class: 'growth-month-duration' }, duration));
        }))),
    el('p', { class: 'small faint' }, t('growth.monthlyMetricsHint')));
}

function weeklyCard(report: AnnualReport, units) {
  const maxTrips = Math.max(1, ...report.weeks.map((week) => week.tripCount));
  return el('section', { class: 'growth-section' },
    el('h3', {}, t('growth.weekly')),
    el('p', { class: 'small faint' }, t('growth.weeklyHint')),
    el('div', { class: 'growth-week-scroll' },
      el('div', {
        class: 'growth-weeks', 'aria-label': t('growth.weekly'),
        style: { gridTemplateColumns: `repeat(${report.weeks.length}, minmax(12px, 1fr))` }
      },
        ...report.weeks.map((week) => {
          const distance = fmtDistance(week.distance, units);
          const label = `${week.isoYear} ${t('growth.weekShort', { n: week.week })} · ${week.start} – ${week.end} · ${week.tripCount} ${t('growth.tripCount')} · ${distance.v}${distance.u} · ${fmtDuration(week.duration, { compact: true })}`;
          return el('div', {
            class: 'growth-week', title: label, 'aria-label': label,
            'data-week': String(week.week), 'data-week-count': String(week.tripCount)
          },
          el('div', { class: 'growth-week-track' }, el('i', { style: { height: barHeight(week.tripCount, maxTrips) } })),
          el('span', {}, String(week.week)));
        }))));
}

function comparisonValue(key: CompareKey, value: number, units): string {
  if (key === 'distance') {
    const distance = fmtDistance(value, units);
    return `${distance.v}${distance.u}`;
  }
  if (key === 'duration' || key === 'movingMs') return fmtDuration(value, { compact: true });
  return String(value);
}

function comparisonLabel(key: CompareKey): string {
  if (key === 'distance') return t('analysis.distance');
  if (key === 'duration') return t('analysis.duration');
  if (key === 'movingMs') return t('analysis.movingTime');
  if (key === 'tripCount') return t('growth.tripCount');
  return t('growth.activeDays');
}

function comparisonCard(report: AnnualReport, previous: AnnualReport | null, units) {
  if (!previous) return el('section', { class: 'growth-section' },
    el('h3', {}, t('growth.yoyTitle')),
    el('p', { class: 'small faint' }, t('growth.yoyNoPrevious')));
  const comparisons = compareAnnualTotals(report.totals, previous.totals);
  return el('section', { class: 'growth-section' },
    el('h3', {}, t('growth.yoyTitle')),
    el('p', { class: 'small faint' }, t('growth.yoyHint')),
    previous.totals.tripCount === 0 ? el('p', { class: 'small faint' }, t('growth.yoyNoPrevious')) : null,
    el('div', { class: 'growth-compare-scroll' },
      el('table', { class: 'growth-compare-table' },
        el('thead', {}, el('tr', {},
          el('th', {}, t('growth.comparisonMetric')),
          el('th', {}, String(previous.year)),
          el('th', {}, String(report.year)),
          el('th', {}, t('growth.change')))),
        el('tbody', {}, ...comparisons.map((comparison) => {
          const change = comparison.percent == null
            ? t('growth.yoyNew')
            : `${comparison.percent > 0 ? '+' : ''}${Math.round(comparison.percent)}%`;
          const direction = comparison.delta > 0 ? 'up' : comparison.delta < 0 ? 'down' : 'same';
          return el('tr', {
            class: `growth-compare-row ${direction}`,
            'data-growth-compare': comparison.key,
            'data-current': String(comparison.current),
            'data-previous': String(comparison.previous),
            'data-percent': comparison.percent == null ? 'new' : String(comparison.percent)
          },
          el('th', { scope: 'row' }, comparisonLabel(comparison.key)),
          el('td', {}, comparisonValue(comparison.key, comparison.previous, units)),
          el('td', {}, comparisonValue(comparison.key, comparison.current, units)),
          el('td', { class: 'mono' }, change));
        })))));
}

function reportKey(year: number, activity: string): string {
  return JSON.stringify([year, activity]);
}

async function copyShareText(text: string, copiedMessage = t('common.copied')) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(text);
    toast(copiedMessage, 'ok');
    return;
  } catch { /* use the selection fallback below */ }
  try {
    const area = el('textarea', { style: { position: 'fixed', left: '-9999px', top: '0' } });
    area.value = text;
    document.body.append(area);
    area.focus();
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    toast(copied ? copiedMessage : t('toast.copyFail'), copied ? 'ok' : 'warn');
  } catch {
    toast(t('toast.copyFail'), 'warn');
  }
}

export function openGrowthReport(trips, options: { initialYear?: number; initialActivity?: string; onOpenTrip?: (tripId: any) => void } = {}) {
  const completed = completedGrowthTrips(trips);
  const tripYears = [...new Set(completed.map(growthTripYear).filter((year): year is number => year != null))].sort((a, b) => b - a);
  const years = buildGrowthYearOptions(completed, options.initialYear);
  const activities = [...new Set(completed.map((trip) => normalizeGrowthActivity(trip.activity)))].sort((a, b) => a.localeCompare(b));
  const currentYear = new Date().getFullYear();
  const initialActivity = options.initialActivity == null || options.initialActivity === ''
    ? ''
    : normalizeGrowthActivity(options.initialActivity);
  let selectedYear: number = validYear(options.initialYear) ? options.initialYear : tripYears[0] ?? currentYear;
  let selectedActivity: string = initialActivity && activities.includes(initialActivity)
    ? initialActivity
    : GROWTH_ALL_ACTIVITIES;
  let controller: AbortController | null = null;
  let closed = false;
  let version = 0;
  let shareJob = 0;
  let shareBusy = false;
  let sharePreview: any = null;
  let visibleReport: AnnualReport | null = null;
  let visibleReportKey = '';
  const recordCache = new Map<string, PersonalRecord[]>();
  const content = el('div', { class: 'growth-report' });
  const yearSelect = el('select', { class: 'input growth-year', 'aria-label': t('growth.year') },
    ...years.map((year) => el('option', { value: String(year) }, String(year))));
  yearSelect.value = String(selectedYear);
  yearSelect.disabled = years.length === 0;
  yearSelect.onchange = () => {
    const year = Number(yearSelect.value);
    if (!validYear(year)) return;
    selectedYear = year;
    renderReport();
  };
  const activitySelect = el('select', { class: 'input growth-activity', 'aria-label': t('growth.activity') },
    el('option', { value: GROWTH_ALL_ACTIVITIES }, t('growth.allActivities')),
    ...activities.map((activity) => el('option', { value: activity }, t(`record.activities.${activity}`))));
  activitySelect.value = selectedActivity;
  activitySelect.onchange = () => {
    selectedActivity = activitySelect.value;
    renderReport();
  };
  const shareButton = el('button', { type: 'button', class: 'btn sm growth-share-button', disabled: true },
    icon('share', 14), t('growth.shareReport'));
  shareButton.onclick = () => { void shareReport(); };
  const body = el('div', {},
    el('div', { class: 'growth-toolbar' },
      el('p', { class: 'small faint' }, t('growth.localOnly')),
      el('div', { class: 'growth-filters' }, yearSelect, activitySelect, shareButton)),
    content);
  const dialog = modal({ title: t('growth.title'), body, wide: true, onClose: () => {
    closed = true;
    version++;
    shareJob++;
    controller?.abort();
    controller = null;
    sharePreview?.close();
  } });

  function syncShareButton() {
    shareButton.classList.toggle('busy', shareBusy);
    shareButton.disabled = shareBusy || !visibleReport || visibleReport.totals.tripCount === 0;
    if (shareBusy) {
      shareButton.replaceChildren(icon('refresh', 14), t('common.loading'));
    } else {
      shareButton.replaceChildren(icon('share', 14), t('growth.shareReport'));
    }
  }

  function renderRecords(records: PersonalRecord[], key: string) {
    const target = content.querySelector('[data-growth-records]');
    if (!target || key !== visibleReportKey || closed) return;
    target.replaceChildren();
    if (!records.length) {
      target.append(el('div', { class: 'small faint' }, t('growth.recordsEmpty')));
      return;
    }
    const units = get('units');
    const recordActivities = [...new Set(records.map((record) => record.activity))].sort();
    for (const activity of recordActivities) {
      const rows = records.filter((record) => record.activity === activity)
        .sort((a, b) => a.distance - b.distance);
      target.append(el('section', { class: 'growth-record-group' },
        el('h4', {}, t(`record.activities.${activity}`)),
        el('div', { class: 'growth-record-grid' }, ...rows.map((record) => recordCard(record, units, (tripId) => {
          dialog.close();
          options.onOpenTrip?.(tripId);
        })))));
    }
  }

  async function loadRecords(year: number, activity: string, key: string, currentVersion: number) {
    const cached = recordCache.get(key);
    const target = content.querySelector('[data-growth-records]');
    if (cached !== undefined) {
      renderRecords(cached, key);
      return;
    }
    controller?.abort();
    const current = new AbortController();
    controller = current;
    const isCurrent = () => !closed && !current.signal.aborted && currentVersion === version
      && key === visibleReportKey && selectedYear === year && selectedActivity === activity;
    const candidates = completed.filter((trip) => growthTripOverlapsYear(trip, year)
      && (activity === GROWTH_ALL_ACTIVITIES || normalizeGrowthActivity(trip.activity) === activity)
      && Number(trip.statsCache?.distance) >= Math.min(...DEFAULT_RECORD_DISTANCES)
      && trip.statsCache?.hasTime !== false);
    if (!candidates.length) {
      if (isCurrent()) {
        recordCache.set(key, []);
        renderRecords([], key);
      }
      return;
    }
    if (target) target.replaceChildren(el('div', { class: 'growth-loading', role: 'status' }, icon('refresh', 16), t('growth.recordsLoading')));
    const best = new Map<string, PersonalRecord>();
    let failures = 0;
    for (let index = 0; index < candidates.length; index++) {
      if (!isCurrent()) return;
      const trip = candidates[index];
      if (target) target.replaceChildren(el('div', { class: 'growth-loading', role: 'status' },
        icon('refresh', 16), t('growth.recordsProgress', { done: index, total: candidates.length })));
      try {
        const track = await routeRepository.load(trip.id);
        if (!isCurrent()) return;
        // A missing track is local to this trip. Keep analysing the successful
        // subset and leave the whole year/activity key uncached for a later retry.
        if (track == null) {
          failures++;
          continue;
        }
        const splits = await computeDistanceSplitsAsync(
          track.segments.map((segment) => ({ id: segment.id, points: segment.points })),
          1000,
          { activity: trip.activity || 'hike', ascentThreshold: get('ascentThreshold') },
          { signal: current.signal }
        );
        if (!isCurrent()) return;
        for (const record of buildPersonalRecords([{ trip, stats: trip.statsCache, splits }], { year })) {
          const recordKey = `${record.activity}:${record.distance}`;
          const previous = best.get(recordKey);
          if (!previous || record.movingMs < previous.movingMs
            || (record.movingMs === previous.movingMs && record.timestamp < previous.timestamp)) best.set(recordKey, record);
        }
      } catch (error) {
        if (!isCurrent() || current.signal.aborted || error?.name === 'AbortError') return;
        failures++;
      }
    }
    if (!isCurrent()) return;
    const records = [...best.values()];
    if (!failures) recordCache.set(key, records);
    renderRecords(records, key);
    if (failures && target) target.append(el('p', { class: 'small growth-warning' }, t('growth.recordsPartial', { n: failures })));
    if (controller === current) controller = null;
  }

  function openSharePreview(result: { blob: Blob }, text: string, title: string, filename: string) {
    const url = URL.createObjectURL(result.blob);
    const img = el('img', { class: 'growth-share-image', src: url, alt: t('growth.shareTitle') });
    const copyBtn = el('button', { class: 'btn' }, icon('copy', 16), t('trips.footprintCopy'));
    const saveBtn = el('button', { class: 'btn' }, icon('download', 16), t('settings.promoDownload'));
    const shareBtn = el('button', { class: 'btn primary growth-share-native' }, icon('share', 16), t('export.shareImage'));
    let preview: any = null;
    preview = modal({
      title: t('growth.shareTitle'),
      body: el('div', { class: 'growth-share-preview' },
        el('div', { class: 'small muted growth-share-privacy' }, t('growth.sharePrivacy')),
        img),
      footer: [copyBtn, saveBtn, shareBtn],
      onClose: () => {
        URL.revokeObjectURL(url);
        if (sharePreview === preview) sharePreview = null;
      }
    });
    sharePreview = preview;
    copyBtn.onclick = () => { void copyShareText(text); };
    saveBtn.onclick = async () => {
      try {
        const exported = await exportImage(result.blob, filename);
        if (exported.mode === 'longpress') {
          img.src = exported.dataUrl;
          toast(t('export.wechatHint'), 'warn');
        } else {
          toast(t('settings.promoDownloaded'), 'ok');
        }
      } catch (error) {
        console.error(error);
        toast(t('growth.shareFailed'), 'err');
      }
    };
    shareBtn.onclick = async () => {
      const file = new File([result.blob], filename, { type: 'image/png' });
      const shared = await nativeShare({ title, text, files: [file] });
      if (!shared) await copyShareText(text, t('growth.shareTextCopied'));
    };
  }

  async function shareReport() {
    const report = visibleReport;
    const key = visibleReportKey;
    if (closed || shareBusy || !report || report.totals.tripCount === 0) return;
    const activity = selectedActivity;
    const job = ++shareJob;
    shareBusy = true;
    syncShareButton();
    try {
      const footprint = buildAnnualShareFootprint(report);
      const result = await generateFootprintImage(footprint);
      if (!result?.blob) throw new Error('Annual poster was not generated');
      if (closed || job !== shareJob || key !== visibleReportKey) return;
      const filename = `roametch-annual-${report.year}-${Date.now()}.png`;
      const title = `${t('growth.title')} · ${report.year}`;
      const text = buildAnnualShareText(report, activity, get('units'));
      openSharePreview(result, text, title, filename);
    } catch (error) {
      if (!closed && job === shareJob && key === visibleReportKey) {
        console.error(error);
        toast(t('growth.shareFailed'), 'err');
      }
    } finally {
      if (job === shareJob) {
        shareBusy = false;
        syncShareButton();
      }
    }
  }

  async function renderReport() {
    const year = selectedYear;
    const activity = selectedActivity;
    if (closed) return;
    const currentVersion = ++version;
    controller?.abort();
    controller = null;
    shareJob++;
    shareBusy = false;
    visibleReport = null;
    visibleReportKey = '';
    syncShareButton();
    if (!validYear(year)) {
      content.replaceChildren(el('div', { class: 'growth-empty' }, t('growth.emptyReport')));
      return;
    }
    const key = reportKey(year, activity);
    const entries = filterGrowthEntries(completed, year, activity);
    const previousEntries = validYear(year - 1) ? filterGrowthEntries(completed, year - 1, activity) : null;
    let report: AnnualReport;
    let previous: AnnualReport | null;
    if (entries.length > 120 || (previousEntries?.length ?? 0) > 120) {
      try {
        [report, previous] = await Promise.all([
          buildAnnualReportAsync(entries, year),
          previousEntries ? buildAnnualReportAsync(previousEntries, year - 1) : Promise.resolve(null)
        ]);
      } catch {
        if (currentVersion !== version || closed) return;
        report = buildAnnualReport(entries, year);
        previous = previousEntries ? buildAnnualReport(previousEntries, year - 1) : null;
      }
      if (currentVersion !== version || closed || key !== reportKey(selectedYear, selectedActivity)) return;
    } else {
      report = buildAnnualReport(entries, year);
      previous = previousEntries ? buildAnnualReport(previousEntries, year - 1) : null;
    }
    visibleReport = report;
    visibleReportKey = key;
    const units = get('units');
    const distance = fmtDistance(report.totals.distance, units);
    const ascent = fmtAltitude(report.totals.ascent, units);
    const bestWeek = report.weeks.reduce((best, week) => !best || week.distance > best.distance ? week : best, null);
    const open = (tripId) => { dialog.close(); options.onOpenTrip?.(tripId); };
    const empty = report.totals.tripCount === 0;
    content.replaceChildren(
      ...(empty ? [el('div', { class: 'growth-empty' }, t(activity === GROWTH_ALL_ACTIVITIES ? 'growth.empty' : 'growth.emptyFiltered'))] : []),
      el('div', { class: 'growth-kpis' },
        metric(t('analysis.distance'), `${distance.v} ${distance.u}`),
        metric(t('analysis.duration'), fmtDuration(report.totals.duration, { compact: true })),
        metric(t('analysis.ascent'), `${ascent.v} ${ascent.u}`),
        metric(t('growth.activeDays'), String(report.totals.activeDays)),
        metric(t('growth.tripCount'), String(report.totals.tripCount)),
        metric(t('growth.movingTime'), fmtDuration(report.totals.movingMs, { compact: true })),
        metric(t('growth.currentStreak'), t('growth.days', { n: report.streaks.current }))),
      monthlyCard(report, units),
      weeklyCard(report, units),
      comparisonCard(report, previous, units),
      el('div', { class: 'growth-two-col' },
        el('section', { class: 'growth-section' },
          el('h3', {}, t('growth.activities')),
          el('p', { class: 'small faint' }, t('growth.activitiesHint')),
          report.activities.length ? el('div', { class: 'growth-activity-list' },
            ...report.activities.map((item) => el('div', { class: 'growth-activity' },
              el('div', {}, el('span', {}, t(`record.activities.${item.activity}`)), el('span', { class: 'mono' }, `${Math.round(item.ratio * 100)}%`)),
              el('div', { class: 'growth-ratio-track' }, el('i', { style: { width: `${Math.round(item.ratio * 100)}%` } })))))
            : el('p', { class: 'small faint' }, t('growth.empty'))),
        el('section', { class: 'growth-section' },
          el('h3', {}, t('growth.highlights')),
          el('div', { class: 'growth-highlight-list' },
            el('div', {}, el('span', {}, t('growth.longestStreak')), el('strong', {}, t('growth.days', { n: report.streaks.longest }))),
            bestWeek && bestWeek.distance > 0 ? el('div', {}, el('span', {}, t('growth.bestWeek')), el('strong', {}, `${bestWeek.start.slice(5)} – ${bestWeek.end.slice(5)}`)) : null,
            report.longestTrip ? el('div', { class: 'growth-trip-highlight' },
              el('div', {}, el('span', {}, t('growth.longestTrip')), el('strong', {}, report.longestTrip.name || t('growth.untitledTrip'))),
              tripAction(report.longestTrip.tripId, open)) : null,
            report.longestDurationTrip ? el('div', { class: 'growth-trip-highlight' },
              el('div', {}, el('span', {}, t('growth.longestDuration')), el('strong', {}, fmtDuration(report.longestDurationTrip.duration, { compact: true }))),
              tripAction(report.longestDurationTrip.tripId, open)) : null,
            report.mostAscentDay ? el('div', {}, el('span', {}, t('growth.mostAscentDay')), el('strong', {}, `${report.mostAscentDay.date.slice(5)} · ${fmtAltitude(report.mostAscentDay.ascent, units).v}${fmtAltitude(report.mostAscentDay.ascent, units).u}`)) : null))),
      el('section', { class: 'growth-section growth-records-section' },
        el('h3', {}, t('growth.recordsTitle')),
        el('p', { class: 'small faint' }, t('growth.recordsHint')),
        el('div', { 'data-growth-records': '' })),
      el('p', { class: 'small faint growth-note' }, t('growth.note')));
    syncShareButton();
    if (currentVersion !== version || closed) return;
    void loadRecords(year, activity, key, currentVersion);
  }

  void renderReport();
  return dialog;
}
