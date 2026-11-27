// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeDistanceSplits } from '../src/core/distanceSplits';
import { buildAnnualReport } from '../src/core/annualReport';

const mocks = vi.hoisted(() => ({
  loadTripTrack: vi.fn(),
  computeDistanceSplitsAsync: vi.fn(),
  generateFootprintImage: vi.fn(),
  exportImage: vi.fn(),
  nativeShare: vi.fn(),
  toast: vi.fn()
}));

vi.mock('../src/core/store', () => ({ loadTripTrack: mocks.loadTripTrack }));
vi.mock('../src/core/workerBridge', () => ({ computeDistanceSplitsAsync: mocks.computeDistanceSplitsAsync }));
vi.mock('../src/core/footprintShare', () => ({ generateFootprintImage: mocks.generateFootprintImage }));
vi.mock('../src/core/shareEnv', () => ({ exportImage: mocks.exportImage, nativeShare: mocks.nativeShare }));
vi.mock('../src/core/settings', () => ({
  get: (key: string) => key === 'units' ? 'metric' : key === 'ascentThreshold' ? 4 : undefined
}));
vi.mock('../src/core/i18n', () => ({
  t: (key: string, params: Record<string, any> = {}) => key === 'growth.shareText'
    ? `${params.year}|${params.activity}|${params.trips}|${params.distance}|${params.ascent}|${params.duration}|${params.moving}|${params.days}|${params.months}`
    : key
}));
vi.mock('../src/ui/helpers', () => {
  const el = (tag: string, attrs: Record<string, any> = {}, ...children: any[]) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (value != null && value !== false) node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  };
  return {
    el,
    icon: () => document.createElement('span'),
    toast: mocks.toast,
    modal: ({ body, footer, onClose }: any) => {
      const root = document.createElement('div');
      root.append(body);
      if (footer) {
        const actions = document.createElement('div');
        actions.append(...footer.flat().filter(Boolean));
        root.append(actions);
      }
      document.body.append(root);
      return {
        close: () => { root.remove(); onClose?.(); },
        box: root,
        backdrop: root
      };
    }
  };
});

import {
  openGrowthReport,
  buildAnnualShareFootprint,
  buildAnnualShareText,
  buildGrowthYearOptions,
  compareAnnualTotals,
  completedGrowthTrips,
  filterGrowthEntries,
  growthTripOverlapsYear,
  normalizeGrowthActivity
} from '../src/ui/growth';

function trip(id: string, name: string, year: number, overrides: Record<string, any> = {}) {
  const { statsCache, ...rest } = overrides;
  const createdAt = rest.createdAt ?? new Date(year, 0, 15, 8).getTime();
  return {
    id, name, activity: 'hike', status: 'finished', createdAt,
    statsCache: {
      distance: 6000, duration: 3_600_000, activeMs: 3_600_000, movingMs: 3_500_000, ascent: 120, hasTime: true,
      ...statsCache
    },
    ...rest
  };
}

function track(id: string, item: ReturnType<typeof trip>) {
  const points = Array.from({ length: 61 }, (_, index) => ({
    lat: 30, lon: 120 + index * 100 / (111_320 * Math.cos(30 * Math.PI / 180)),
    t: item.createdAt + index * 60_000, alt: 100 + index, acc: 5
  }));
  return { trip: item, segments: [{ id: `seg-${id}`, points }] };
}

function metricValue(label: string): string | null {
  const metric = [...document.querySelectorAll('.growth-metric')]
    .find((node) => node.querySelector('.k')?.textContent === label);
  return metric?.querySelector('strong')?.textContent ?? null;
}

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  vi.resetAllMocks();
  document.body.innerHTML = '';
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: vi.fn(() => 'blob:growth-report') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() });
  mocks.computeDistanceSplitsAsync.mockImplementation(async (segments, interval, options) => computeDistanceSplits(segments, interval, options));
  mocks.generateFootprintImage.mockResolvedValue({
    blob: new Blob(['png'], { type: 'image/png' }),
    filename: 'roametch-footprint-safe.png'
  });
  mocks.exportImage.mockResolvedValue({ mode: 'download' });
  mocks.nativeShare.mockResolvedValue(true);
});

afterEach(() => {
  if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: originalCreateObjectURL });
  else delete (URL as any).createObjectURL;
  if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: originalRevokeObjectURL });
  else delete (URL as any).revokeObjectURL;
  vi.restoreAllMocks();
});

describe('annual report pure logic', () => {
  it('normalizes activities, excludes active recordings and filters by local year plus activity', () => {
    const hike = trip('hike', 'Hike', 2026);
    const run = trip('run', 'Run', 2026, { activity: ' run ' });
    const recording = trip('recording', 'Recording', 2026, { status: 'recording' });
    const previous = trip('previous', 'Previous', 2025);
    expect(normalizeGrowthActivity(null)).toBe('unknown');
    expect(normalizeGrowthActivity(' run ')).toBe('run');
    expect(completedGrowthTrips([hike, run, recording, previous]).map((item) => item.id)).toEqual(['hike', 'run', 'previous']);
    expect(filterGrowthEntries([hike, run, recording, previous], 2026, 'run')).toEqual([{ trip: run, stats: run.statsCache }]);
    expect(filterGrowthEntries([hike, run, recording, previous], 2026, 'all')).toHaveLength(2);
  });

  it('offers the current and explicitly requested empty years without disabling the selector', () => {
    const now = new Date(2026, 5, 1);
    expect(buildGrowthYearOptions([], 2024, now)).toEqual([2026, 2025, 2024]);
    expect(buildGrowthYearOptions([trip('old', 'Old', 2023)], undefined, now)).toEqual([2026, 2025, 2024, 2023]);
    const dialog = openGrowthReport([], { initialYear: 2024 });
    const yearSelect = document.querySelector<HTMLSelectElement>('.growth-year')!;
    expect(yearSelect.disabled).toBe(false);
    expect(yearSelect.value).toBe('2024');
    expect([...yearSelect.options].map((option) => option.value)).toContain(String(now.getFullYear()));
    expect(document.querySelector('.growth-empty')?.textContent).toBe('growth.empty');
    expect(document.querySelector<HTMLButtonElement>('.growth-share-button')?.disabled).toBe(true);
    expect(mocks.loadTripTrack).not.toHaveBeenCalled();
    dialog.close();
  });

  it('shows the activity-filtered empty state without loading unrelated tracks', () => {
    const hike = trip('hike', 'Hike', 2026, { statsCache: { distance: 0, hasTime: false } });
    const run = trip('run', 'Run', 2025, { activity: 'run', statsCache: { distance: 0, hasTime: false } });
    const dialog = openGrowthReport([hike, run], { initialYear: 2026 });
    const activitySelect = document.querySelector<HTMLSelectElement>('.growth-activity')!;
    activitySelect.value = 'run';
    activitySelect.dispatchEvent(new Event('change'));
    expect(document.querySelector('.growth-empty')?.textContent).toBe('growth.emptyFiltered');
    expect(document.querySelector<HTMLButtonElement>('.growth-share-button')?.disabled).toBe(true);
    expect(mocks.loadTripTrack).not.toHaveBeenCalled();
    dialog.close();
  });

  it('compares real annual totals and leaves a zero-baseline percentage undefined', () => {
    const previous = buildAnnualReport([], 2025).totals;
    const current = buildAnnualReport([{ trip: trip('current', 'Current', 2026), stats: trip('current', 'Current', 2026).statsCache }], 2026).totals;
    const distance = compareAnnualTotals(current, previous).find((item) => item.key === 'distance')!;
    expect(distance.current).toBe(6000);
    expect(distance.previous).toBe(0);
    expect(distance.delta).toBe(6000);
    expect(distance.percent).toBeNull();
    const doubled = compareAnnualTotals({ ...current, distance: 12000 }, current).find((item) => item.key === 'distance')!;
    expect(doubled.percent).toBe(100);
  });

  it('whitelists aggregate share data and never copies trip names, tracks, cities or coordinates', () => {
    const item = trip('private-id', 'Sensitive City Trip', 2026);
    const report = buildAnnualReport([{ trip: item, stats: item.statsCache }], 2026);
    report.longestTrip!.name = 'Sensitive City Trip';
    const footprint = buildAnnualShareFootprint(report);
    expect(Object.keys(footprint).sort()).toEqual(['ascent', 'cities', 'days', 'distance', 'duration', 'months', 'trips', 'year']);
    expect(footprint.cities).toEqual([]);
    expect(Object.keys(footprint.months[0]).sort()).toEqual(['ascent', 'distance', 'month', 'trips']);
    const serialized = JSON.stringify(footprint);
    expect(serialized).not.toContain('Sensitive City Trip');
    expect(serialized).not.toContain('private-id');
    expect(serialized).not.toContain('lat');
    expect(serialized).not.toContain('lon');
    const text = buildAnnualShareText(report, 'hike', 'metric');
    expect(text).toContain('2026');
    expect(text).toContain('record.activities.hike');
    expect(text).not.toContain('Sensitive City Trip');
    expect(text).not.toContain('private-id');
  });
});

describe('annual personal records', () => {
  it('attributes a cross-year effort to the year in which the effort starts', async () => {
    const boundary = trip('trip-2025-boundary', '跨年行程', 2025, {
      createdAt: new Date(2025, 11, 31, 23, 50).getTime()
    });
    expect(growthTripOverlapsYear(boundary, 2025)).toBe(true);
    expect(growthTripOverlapsYear(boundary, 2026)).toBe(true);
    expect(growthTripOverlapsYear(boundary, 2027)).toBe(false);
    // Slow first kilometre before midnight, then a fast 5 km effort that starts in 2026.
    const points = Array.from({ length: 61 }, (_, index) => ({
      lat: 30,
      lon: 120 + index * 100 / (111_320 * Math.cos(30 * Math.PI / 180)),
      t: boundary.createdAt + (index <= 10 ? index * 90_000 : 900_000 + (index - 10) * 24_000),
      alt: 100 + index,
      acc: 5
    }));
    mocks.loadTripTrack.mockImplementation(async () => ({
      trip: boundary,
      segments: [{ id: `seg-${boundary.id}`, points }]
    }));

    const dialog = openGrowthReport([boundary], { initialYear: 2026 });
    await vi.waitFor(() => expect(document.querySelectorAll('.growth-record')).toHaveLength(1));
    expect(document.querySelector('.growth-record-name')?.textContent).toContain('跨年行程');
    expect(document.querySelector('.growth-record')?.textContent).toContain('2026');
    expect(mocks.loadTripTrack).toHaveBeenCalledWith(boundary.id);
    dialog.close();
  });

  it('shows successful records after a partial failure and retries that year later', async () => {
    const failed = trip('trip-2026-a', '失败行程', 2026);
    const passed = trip('trip-2026-b', '成功行程', 2026);
    const previous = trip('trip-2025-a', '上一年行程', 2025);
    const tracks = new Map([
      [failed.id, track(failed.id, failed)],
      [passed.id, track(passed.id, passed)],
      [previous.id, track(previous.id, previous)]
    ]);
    let failedOnce = false;
    mocks.loadTripTrack.mockImplementation(async (id: string) => tracks.get(id));
    mocks.computeDistanceSplitsAsync.mockImplementation(async (segments, interval, options) => {
      if (segments[0]?.id === `seg-${failed.id}` && !failedOnce) {
        failedOnce = true;
        throw new Error('temporary compute failure');
      }
      return computeDistanceSplits(segments, interval, options);
    });

    const dialog = openGrowthReport([failed, passed, previous], { initialYear: 2026 });
    await vi.waitFor(() => expect(document.querySelectorAll('.growth-record')).toHaveLength(1));
    expect(document.querySelector('.growth-record-name')?.textContent).toContain('成功行程');
    expect(document.querySelector('.growth-warning')?.textContent).toContain('growth.recordsPartial');

    const yearSelect = document.querySelector<HTMLSelectElement>('.growth-year')!;
    yearSelect.value = '2025';
    yearSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(mocks.loadTripTrack).toHaveBeenCalledWith(previous.id));
    await vi.waitFor(() => expect(document.querySelector('.growth-record-name')?.textContent).toContain('上一年行程'));

    yearSelect.value = '2026';
    yearSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(mocks.loadTripTrack.mock.calls.filter(([id]) => id === failed.id)).toHaveLength(2);
      expect(document.querySelectorAll('.growth-record')).toHaveLength(1);
    });
    expect(document.querySelector('.growth-warning')).toBeNull();
    dialog.close();
  });

  it('treats a null track as a local failure, keeps the successful subset and retries on revisit', async () => {
    const missing = trip('trip-2026-a', '缺失轨迹', 2026);
    const passed = trip('trip-2026-b', '成功行程', 2026);
    const previous = trip('trip-2025-a', '上一年行程', 2025);
    let missingLoads = 0;
    mocks.loadTripTrack.mockImplementation(async (id: string) => {
      if (id === missing.id) {
        missingLoads++;
        return missingLoads === 1 ? null : track(id, missing);
      }
      return track(id, id === previous.id ? previous : passed);
    });

    const dialog = openGrowthReport([missing, passed, previous], { initialYear: 2026 });
    await vi.waitFor(() => expect(document.querySelectorAll('.growth-record')).toHaveLength(1));
    expect(document.querySelector('.growth-record-name')?.textContent).toContain('成功行程');
    expect(document.querySelector('.growth-warning')?.textContent).toContain('growth.recordsPartial');
    expect(mocks.computeDistanceSplitsAsync).toHaveBeenCalledTimes(1);

    const yearSelect = document.querySelector<HTMLSelectElement>('.growth-year')!;
    yearSelect.value = '2025';
    yearSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('.growth-record-name')?.textContent).toContain('上一年行程'));
    yearSelect.value = '2026';
    yearSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(mocks.loadTripTrack.mock.calls.filter(([id]) => id === missing.id)).toHaveLength(2);
      expect(document.querySelectorAll('.growth-record')).toHaveLength(1);
    });
    expect(document.querySelector('.growth-warning')).toBeNull();
    dialog.close();
  });

  it('drops an expired load immediately when the year changes', async () => {
    const current = trip('trip-2026-a', '当前行程', 2026);
    const previous = trip('trip-2025-a', '上一年行程', 2025);
    let resolveCurrent: (value: any) => void = () => {};
    mocks.loadTripTrack.mockImplementation((id: string) => id === current.id
      ? new Promise((resolve) => { resolveCurrent = resolve; })
      : Promise.resolve(track(id, previous)));

    const dialog = openGrowthReport([current, previous], { initialYear: 2026 });
    await vi.waitFor(() => expect(mocks.loadTripTrack).toHaveBeenCalledWith(current.id));
    const yearSelect = document.querySelector<HTMLSelectElement>('.growth-year')!;
    yearSelect.value = '2025';
    yearSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('.growth-record-name')?.textContent).toContain('上一年行程'));
    resolveCurrent(track(current.id, current));
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.computeDistanceSplitsAsync.mock.calls.some(([segments]) => segments[0]?.id === `seg-${current.id}`)).toBe(false);
    expect(document.querySelector('.growth-warning')).toBeNull();
    expect(document.querySelector('.growth-record-name')?.textContent).toContain('上一年行程');
    dialog.close();
  });
});

describe('annual activity report rendering and sharing', () => {
  it('renders every week, monthly distance and duration, annual time totals and year-over-year comparisons', async () => {
    const current = trip('current', 'Current', 2026);
    const previous = trip('previous', 'Previous', 2025, {
      statsCache: { distance: 3000, duration: 1_800_000, activeMs: 1_800_000, movingMs: 1_700_000, ascent: 60, hasTime: true }
    });
    mocks.loadTripTrack.mockImplementation(async (id: string) => track(id, id === current.id ? current : previous));
    const dialog = openGrowthReport([current, previous], { initialYear: 2026 });
    await vi.waitFor(() => expect(document.querySelectorAll('.growth-record')).toHaveLength(1));
    expect(document.querySelector('.growth-report')?.textContent).not.toContain('null');

    expect(document.querySelectorAll('.growth-month')).toHaveLength(12);
    expect(document.querySelector('.growth-month')?.getAttribute('title')).toContain('analysis.duration');
    expect(document.querySelectorAll('.growth-week')).toHaveLength(buildAnnualReport([], 2026).weeks.length);
    expect(metricValue('analysis.duration')).toBe('1h00m');
    expect(metricValue('growth.movingTime')).toBe('58m20s');
    const distanceRow = document.querySelector('[data-growth-compare="distance"]')!;
    expect(distanceRow.getAttribute('data-current')).toBe('6000');
    expect(distanceRow.getAttribute('data-previous')).toBe('3000');
    expect(distanceRow.getAttribute('data-percent')).toBe('100');
    expect(document.querySelectorAll('[data-growth-compare]')).toHaveLength(5);
    dialog.close();
  });

  it('isolates report and record jobs by both year and activity', async () => {
    const hike = trip('hike', 'Hike Trip', 2026);
    const run = trip('run', 'Run Trip', 2026, { activity: 'run' });
    const previous = trip('previous', 'Previous Hike', 2025);
    mocks.loadTripTrack.mockImplementation(async (id: string) => track(id, id === hike.id ? hike : id === run.id ? run : previous));
    const dialog = openGrowthReport([hike, run, previous], { initialYear: 2026 });
    await vi.waitFor(() => expect(document.querySelectorAll('.growth-record')).toHaveLength(2));
    expect(metricValue('growth.tripCount')).toBe('2');

    const activitySelect = document.querySelector<HTMLSelectElement>('.growth-activity')!;
    activitySelect.value = 'run';
    activitySelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('.growth-record-name')?.textContent).toContain('Run Trip'));
    expect(metricValue('growth.tripCount')).toBe('1');
    expect(document.querySelector('.growth-activity-list')?.textContent).toContain('record.activities.run');
    expect(document.querySelector('.growth-activity-list')?.textContent).not.toContain('record.activities.hike');
    expect(mocks.loadTripTrack.mock.calls.filter(([id]) => id === run.id)).toHaveLength(2);

    activitySelect.value = 'hike';
    activitySelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('.growth-record-name')?.textContent).toContain('Hike Trip'));
    expect(mocks.loadTripTrack.mock.calls.filter(([id]) => id === hike.id)).toHaveLength(2);
    activitySelect.value = 'run';
    activitySelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('.growth-record-name')?.textContent).toContain('Run Trip'));
    expect(mocks.loadTripTrack.mock.calls.filter(([id]) => id === run.id)).toHaveLength(2);
    expect(mocks.loadTripTrack.mock.calls.filter(([id]) => id === hike.id)).toHaveLength(2);
    dialog.close();
  });

  it('generates and shares only the aggregate poster payload', async () => {
    const item = trip('private-id', 'Sensitive City Trip', 2026);
    mocks.loadTripTrack.mockResolvedValue(track(item.id, item));
    const dialog = openGrowthReport([item], { initialYear: 2026 });
    const shareButton = document.querySelector<HTMLButtonElement>('.growth-share-button')!;
    expect(shareButton.disabled).toBe(false);
    shareButton.click();
    await vi.waitFor(() => expect(mocks.generateFootprintImage).toHaveBeenCalledTimes(1));
    const payload = mocks.generateFootprintImage.mock.calls[0][0];
    expect(payload.cities).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain('Sensitive City Trip');
    expect(JSON.stringify(payload)).not.toContain('private-id');
    expect(document.querySelector('.growth-share-preview')).not.toBeNull();

    const nativeButton = document.querySelector<HTMLButtonElement>('.growth-share-native')!;
    nativeButton.click();
    await vi.waitFor(() => expect(mocks.nativeShare).toHaveBeenCalledTimes(1));
    const shared = mocks.nativeShare.mock.calls[0][0];
    expect(shared.text).toContain('2026');
    expect(shared.text).not.toContain('Sensitive City Trip');
    expect(shared.text).not.toContain('private-id');
    expect(shared.files).toHaveLength(1);
    expect(shared.files[0].name).toMatch(/^roametch-annual-2026-\d+\.png$/);
    dialog.close();
  });
});
