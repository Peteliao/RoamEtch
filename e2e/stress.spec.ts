import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gotoTab } from './utils';
import {
  EVIDENCE_LIMITS,
  STRESS_BASE_TIME,
  STRESS_CHUNK_SIZE,
  STRESS_TRACK_NAME,
  assertFullWorkerStats,
  attachStressReport,
  blockNextChunkWriteAndSpill,
  blockStressRemote,
  deterministicPointAt,
  emitSyntheticFix,
  expectedTrackDistance,
  findCompletedWorkerTask,
  fingerprintFixtureTrips,
  installSyntheticGeolocation,
  installStressProbes,
  openStressCdp,
  readBoundedPreview,
  readPerfProbe,
  readRawChunkFingerprint,
  readRecordMapSummary,
  readStressMetrics,
  readTripStorageSummary,
  readWorkerProbe,
  ready,
  resetPerfProbe,
  sampleStressMetrics,
  seedThreeFixtureTrips,
  setSyntheticVisibility,
  summarizeExportedGpx,
  waitForFullWorkerStats,
  writeDeterministicGpx
} from './stressUtils';

const configuredPoints = Number(process.env.LT_STRESS_POINTS || 1_000_000);
if (!Number.isSafeInteger(configuredPoints) || configuredPoints < 1_000 || configuredPoints > 1_000_000) {
  throw new Error('LT_STRESS_POINTS must be an integer from 1000 through 1000000');
}
const POINTS = configuredPoints;
const IMPORT_BUDGET_MS = 180_000;
const MAP_BUDGET_MS = 120_000;
const EDIT_BUDGET_MS = 60_000;
const EXPORT_BUDGET_MS = 120_000;
const COLD_START_BUDGET_MS = 45_000;
const HEAP_BUDGET_BYTES = 3_500 * 1024 * 1024;
const TASK_BUDGET_SECONDS = 180;
const SCRIPT_BUDGET_SECONDS = 120;
const NODE_GROWTH_BUDGET = 100_000;
const LONG_TASK_BUDGET_MS = 10_000;
const FRAME_GAP_BUDGET_MS = 12_000;

const failureState = new WeakMap<Page, { pageErrors: string[]; crashes: number }>();

function watchFailures(page: Page) {
  const state = { pageErrors: [] as string[], crashes: 0 };
  failureState.set(page, state);
  page.on('pageerror', (error) => state.pageErrors.push(error.message));
  page.on('crash', () => { state.crashes++; });
  return state;
}

function errorText(error: unknown) {
  return error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ''}` : String(error);
}

test(`browser full chain imports ${POINTS.toLocaleString('en-US')} deterministic points, computes in a Worker, maps, safely edits, exports, and cold-starts`, async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const failures = watchFailures(page);
  const inputPath = testInfo.outputPath('deterministic-stress.gpx');
  const input = writeDeterministicGpx(inputPath, POINTS);
  const report: any = {
    scenario: 'million-point-browser-full-chain',
    syntheticPoints: POINTS,
    input,
    budgets: {
      importMs: IMPORT_BUDGET_MS, mapMs: MAP_BUDGET_MS, editMs: EDIT_BUDGET_MS,
      exportMs: EXPORT_BUDGET_MS, coldStartMs: COLD_START_BUDGET_MS,
      heapBytes: HEAP_BUDGET_BYTES, taskSeconds: TASK_BUDGET_SECONDS,
      scriptSeconds: SCRIPT_BUDGET_SECONDS, nodeGrowth: NODE_GROWTH_BUDGET,
      longestLongTaskMs: LONG_TASK_BUDGET_MS, maxFrameGapMs: FRAME_GAP_BUDGET_MS
    },
    isolation: { persistentProfile: false, disposableContext: true, eraseAllCalls: 0, fixtureTrips: 3 },
    evidenceLimits: EVIDENCE_LIMITS,
    phases: [] as any[],
    checks: {} as Record<string, boolean>,
    pageErrors: failures.pageErrors,
    crashes: failures.crashes,
    passed: false
  };
  let tripId = '';
  let fixtureBaseline: any = null;
  let session: Awaited<ReturnType<typeof openStressCdp>> | null = null;
  let sampler: Awaited<ReturnType<typeof sampleStressMetrics>> | null = null;
  let baseline: Awaited<ReturnType<typeof readStressMetrics>> | null = null;

  const phase = async <T>(name: string, budgetMs: number, action: () => Promise<T>): Promise<T> => {
    const before = session ? await readStressMetrics(session) : null;
    const started = performance.now();
    let result: T;
    let failure: unknown = null;
    try {
      result = await action();
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const after = session ? await readStressMetrics(session) : null;
      const elapsedMs = performance.now() - started;
      report.phases.push({
        name, budgetMs, elapsedMs,
        taskSeconds: before && after ? after.TaskDuration - before.TaskDuration : null,
        scriptSeconds: before && after ? after.ScriptDuration - before.ScriptDuration : null,
        heapBeforeBytes: before?.JSHeapUsedSize ?? null,
        heapAfterBytes: after?.JSHeapUsedSize ?? null,
        failure: failure == null ? null : errorText(failure)
      });
      expect(elapsedMs, `${name} exceeded its bounded runtime`).toBeLessThanOrEqual(budgetMs);
    }
    return result!;
  };

  try {
    await installStressProbes(page);
    await blockStressRemote(page);
    await page.goto('/');
    await ready(page);
    const fixtures = await seedThreeFixtureTrips(page);
    fixtureBaseline = fixtures.fingerprint;
    report.fixtureIds = fixtures.ids;
    await gotoTab(page, 'trips');

    session = await openStressCdp(page);
    await session.send('HeapProfiler.collectGarbage');
    baseline = await readStressMetrics(session);
    report.baselineMetrics = baseline;
    sampler = await sampleStressMetrics(session, baseline);
    await resetPerfProbe(page);

    const imported = await phase('import-indexeddb-worker-analysis', IMPORT_BUDGET_MS, async () => {
      const chooserPromise = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: '导入', exact: true }).click();
      const chooser = await chooserPromise;
      await chooser.setFiles(inputPath);
      await expect(page.locator('#trip-detail')).toHaveClass(/active/, { timeout: IMPORT_BUDGET_MS });
      await expect(page.locator('.trip-detail-title')).toHaveText(STRESS_TRACK_NAME, { timeout: IMPORT_BUDGET_MS });
      await waitForFullWorkerStats(page, POINTS);
      await expect(page.locator('#view-analysis .analysis-map canvas').first()).toBeVisible({ timeout: IMPORT_BUDGET_MS });
      await expect(page.locator('#view-analysis .stat-more-row').last()).toContainText(String(POINTS), { timeout: IMPORT_BUDGET_MS });
      tripId = await page.evaluate((name) => (window as any).__lt.store.listTrips().then((trips: any[]) => trips.find((trip) => trip.name === name)?.id || ''), STRESS_TRACK_NAME);
      expect(tripId).toBeTruthy();
      return readTripStorageSummary(page, tripId);
    });

    expect(imported.segmentCount).toBe(1);
    expect(imported.chunkCount).toBe(Math.ceil(POINTS / STRESS_CHUNK_SIZE));
    expect(imported.pointCount).toBe(POINTS);
    expect(imported.segments[0].contiguousSequence).toBe(true);
    expect(imported.segments[0].firstPoint).toEqual(deterministicPointAt(0));
    expect(imported.segments[0].lastPoint).toEqual(deterministicPointAt(POINTS - 1));
    expect(imported.trip.statsCache).toMatchObject({ pointCount: POINTS, segCount: 1, duration: (POINTS - 1) * 1_000 });
    expect(imported.trip.statsCache.distance).toBeCloseTo(expectedTrackDistance(POINTS), 1);
    report.importedStorage = imported;
    report.expectedDistance = expectedTrackDistance(POINTS);
    report.checks.importExact = true;

    const mapSummary = await phase('full-record-map', MAP_BUDGET_MS, async () => {
      await page.locator('#trip-detail .trip-detail-actions').getByRole('button', { name: '在地图查看', exact: true }).click();
      await expect(page.locator('#view-record.active')).toBeVisible({ timeout: MAP_BUDGET_MS });
      await expect(page.locator('#view-record canvas').first()).toBeVisible({ timeout: MAP_BUDGET_MS });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await waitForFullWorkerStats(page, POINTS);
      await expect.poll(async () => {
        try {
          const summary = await readRecordMapSummary(page);
          return summary.rawPointCount === POINTS && summary.renderedFeatureCount === 1 && summary.renderedCoordinateCount > 1
            ? summary : null;
        } catch {
          return null;
        }
      }, { timeout: MAP_BUDGET_MS, message: 'record map must retain every source point and publish a simplified line' }).not.toBeNull();
      return readRecordMapSummary(page);
    });
    expect(mapSummary).toMatchObject({ rawPointCount: POINTS, rawSegmentCount: 1, indexEntries: 0, renderedFeatureCount: 1 });
    expect(mapSummary.renderedCoordinateCount).toBeGreaterThan(1);
    expect(mapSummary.renderedCoordinateCount).toBeLessThanOrEqual(POINTS);
    report.map = mapSummary;
    const mapProbe = await readWorkerProbe(page);
    report.computeWorkerTimeline = mapProbe.workers
      .filter((worker: any) => worker.url.includes('compute.worker'))
      .map((worker: any) => ({
        index: worker.index, sent: worker.sent, responses: worker.responses,
        terminated: worker.terminated, terminatedAt: worker.terminatedAt
      }));
    report.workerTasks = assertFullWorkerStats(mapProbe, POINTS);
    report.mapSimplificationWorker = findCompletedWorkerTask(mapProbe, 'simplify', POINTS);
    expect(report.mapSimplificationWorker, 'full-track simplification must complete in compute.worker').not.toBeNull();
    report.checks.workerVerified = true;
    report.checks.mapExact = true;
    report.checks.mapSimplificationWorker = true;

    const editedName = `${STRESS_TRACK_NAME}-安全编辑`;
    const editResult = await phase('name-tag-only-safe-edit', EDIT_BUDGET_MS, async () => {
      await gotoTab(page, 'trips');
      const beforeRaw = await readRawChunkFingerprint(page, tripId);
      const before = await readTripStorageSummary(page, tripId);
      await page.locator('#trip-detail .trip-detail-actions').getByRole('button', { name: '编辑', exact: true }).click();
      const editor = page.getByRole('dialog', { name: '编辑行程' });
      await expect(editor).toBeVisible();
      await editor.locator('.m-body input[type="text"]').nth(0).fill(editedName);
      await editor.locator('.m-body input[type="text"]').nth(1).fill(`stress，large-${POINTS};stress`);
      await editor.locator('.m-foot').getByRole('button', { name: '保存', exact: true }).click();
      await expect(editor).toBeHidden({ timeout: EDIT_BUDGET_MS });
      const after = await readTripStorageSummary(page, tripId);
      const afterRaw = await readRawChunkFingerprint(page, tripId);
      return { before, after, beforeRaw, afterRaw };
    });
    expect(editResult.after.trip).toMatchObject({ name: editedName, activity: 'hike', tags: ['stress', `large-${POINTS}`] });
    expect(editResult.after.trip.statsCache).toEqual(editResult.before.trip.statsCache);
    expect(editResult.afterRaw).toEqual(editResult.beforeRaw);
    expect(editResult.after.pointCount).toBe(POINTS);
    expect(editResult.after.chunkCount).toBe(Math.ceil(POINTS / STRESS_CHUNK_SIZE));
    report.safeEdit = {
      name: editResult.after.trip.name,
      tags: editResult.after.trip.tags,
      rawChunksUnchanged: true,
      statsCacheUnchanged: true,
      chunkCount: editResult.after.chunkCount
    };
    report.checks.safeEditPreserved = true;

    const exported = await phase('gpx-export-and-consistency', EXPORT_BUDGET_MS, async () => {
      await page.locator('#trip-detail button[data-section="share"]').click();
      await expect(page.locator('#view-export')).toHaveClass(/active/);
      await page.locator('#view-export .privacy-adjust').click();
      const privacyRadius = page.locator('#export-privacy-controls input[type="number"]');
      await privacyRadius.fill('0');
      await privacyRadius.press('Tab');
      const downloadPromise = page.waitForEvent('download', { timeout: EXPORT_BUDGET_MS });
      await page.locator('#view-export button').filter({ hasText: 'GPX' }).first().click();
      const download = await downloadPromise;
      const path = await download.path();
      expect(path).toBeTruthy();
      expect(download.suggestedFilename()).toBe(`${editedName}.gpx`);
      return summarizeExportedGpx(path!, POINTS, editedName);
    });
    expect(exported.pointCount).toBe(POINTS);
    expect(exported.segments).toBe(1);
    expect(exported.containsTrackName).toBe(true);
    for (const sample of exported.samples) {
      expect(sample.point, `exported checkpoint ${sample.index}`).toEqual(sample.expected);
    }
    report.export = exported;
    report.checks.exportConsistent = true;
    if (POINTS > 100_000) {
      report.gpxSerializationWorker = findCompletedWorkerTask(await readWorkerProbe(page), 'gpx', POINTS);
      expect(report.gpxSerializationWorker, 'large GPX serialization must complete in compute.worker').not.toBeNull();
      report.checks.gpxSerializationWorker = true;
    }

    report.perfBeforeReload = await readPerfProbe(page);
    const coldStart = await phase('cold-document-preview', COLD_START_BUDGET_MS, async () => {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: COLD_START_BUDGET_MS });
      await ready(page);
      await expect(page.locator('#view-record canvas').first()).toBeVisible({ timeout: COLD_START_BUDGET_MS });
      const preview = await readBoundedPreview(page, tripId);
      const storage = await readTripStorageSummary(page, tripId);
      return { preview, storage };
    });
    expect(coldStart.preview).toEqual({ points: 500, readOnly: true, segments: 1 });
    expect(coldStart.storage.pointCount).toBe(POINTS);
    expect(coldStart.storage.chunkCount).toBe(Math.ceil(POINTS / STRESS_CHUNK_SIZE));
    expect(coldStart.storage.trip.name).toBe(editedName);
    report.coldStart = coldStart;
    report.checks.coldPreviewBounded = true;

    const fixtureAfter = await fingerprintFixtureTrips(page, fixtures.ids);
    expect(fixtureAfter).toEqual(fixtureBaseline);
    report.fixtureFingerprintUnchanged = true;
    report.checks.fixturesPreserved = true;
  } catch (error) {
    report.failure = errorText(error);
    throw error;
  } finally {
    if (session && baseline) {
      try {
        if (sampler) report.sampledMetrics = await sampler.stop();
        await session.send('HeapProfiler.collectGarbage');
        report.finalMetrics = await readStressMetrics(session);
        report.memoryDelta = {
          heapBytes: report.finalMetrics.JSHeapUsedSize - baseline.JSHeapUsedSize,
          taskSeconds: report.finalMetrics.TaskDuration - baseline.TaskDuration,
          scriptSeconds: report.finalMetrics.ScriptDuration - baseline.ScriptDuration,
          nodes: report.finalMetrics.Nodes - baseline.Nodes
        };
        report.checks.heapBudget = report.sampledMetrics.peak.JSHeapUsedSize <= HEAP_BUDGET_BYTES;
        report.checks.taskBudget = report.memoryDelta.taskSeconds <= TASK_BUDGET_SECONDS;
        report.checks.scriptBudget = report.memoryDelta.scriptSeconds <= SCRIPT_BUDGET_SECONDS;
        report.checks.nodeBudget = report.sampledMetrics.peak.Nodes - baseline.Nodes <= NODE_GROWTH_BUDGET;
      } catch (error) {
        report.metricsFailure = errorText(error);
      }
      await session.detach().catch(() => {});
    }
    try {
      const currentPerf = await readPerfProbe(page);
      report.perf = report.perfBeforeReload || currentPerf;
      if (report.perfBeforeReload) report.coldStartPerf = currentPerf;
      report.checks.longTaskBudget = report.perf.longestLongTaskMs <= LONG_TASK_BUDGET_MS;
      report.checks.frameGapBudget = report.perf.maxFrameGapMs <= FRAME_GAP_BUDGET_MS;
    } catch (error) {
      report.perfFailure = errorText(error);
    }
    report.pageErrors = failures.pageErrors;
    report.crashes = failures.crashes;
    report.checks.noBrowserFailures = failures.pageErrors.length === 0 && failures.crashes === 0;
    report.passed = !report.failure && !report.metricsFailure && !report.perfFailure && Object.values(report.checks).every(Boolean);
    report.browserVersion = page.context().browser()?.version() || null;
    report.viewport = page.viewportSize();
    await attachStressReport(testInfo, 'stress-full-chain', report);
  }

  expect(failures.pageErrors).toEqual([]);
  expect(failures.crashes).toBe(0);
  expect(report.checks).toEqual(Object.fromEntries(Object.keys(report.checks).map((key) => [key, true])));
  expect(report.passed).toBe(true);
});

test('simulated eight-hour recording covers silence retry, pause/resume, background segmentation, pagehide spill recovery, continuation, and diagnostic export', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const failures = watchFailures(page);
  const report: any = {
    scenario: 'simulated-eight-hour-recording-lifecycle',
    simulated: true,
    realSoak: false,
    fakeClock: true,
    mockedGeolocation: true,
    isolation: { persistentProfile: false, disposableContext: true, eraseAllCalls: 0, fixtureTrips: 3 },
    evidenceLimits: EVIDENCE_LIMITS,
    expectedSegmentPoints: [481, 1, 5, 1],
    expectedTotalPoints: 488,
    checks: {} as Record<string, boolean>,
    pageErrors: failures.pageErrors,
    crashes: failures.crashes,
    passed: false
  };
  let fixtureIds: string[] = [];
  let fixtureBaseline: any = null;
  let tripId = '';
  const wallStarted = Date.now();

  try {
    await installSyntheticGeolocation(page);
    await blockStressRemote(page);
    await page.clock.install({ time: new Date(STRESS_BASE_TIME) });
    // Freeze before navigation so application startup cannot consume the pause target.
    await page.clock.pauseAt(new Date(STRESS_BASE_TIME + 60_000));
    await page.goto('/');
    await ready(page);
    const fixtures = await seedThreeFixtureTrips(page);
    fixtureIds = fixtures.ids;
    fixtureBaseline = fixtures.fingerprint;
    report.fixtureIds = fixtureIds;

    const started = await page.evaluate(async () => {
      const recorder = (window as any).__lt.recorder;
      const ok = await recorder.startRecording({ name: '虚拟八小时生命周期', activity: 'hike', simulated: false });
      return { ok, tripId: recorder.rec.tripId, startedAt: recorder.rec.startedAt, status: recorder.rec.status };
    });
    expect(started.ok).toBe(true);
    expect(started.status).toBe('recording');
    tripId = started.tripId;
    report.recordingStarted = started;

    await emitSyntheticFix(page, 0);
    for (let index = 1; index < 480; index++) {
      // Advance synthetic fix time without running every intermediate renderer
      // frame. Timer-driven silence/visibility behavior is exercised below with runFor.
      await page.clock.setSystemTime(STRESS_BASE_TIME + 60_000 + index * 60_000);
      await emitSyntheticFix(page, index);
    }
    const beforeSilence = await page.evaluate(() => ({
      pointCount: (window as any).__lt.recorder.rec.live.pointCount,
      watchCalls: (window as any).__stressGeo.watchCalls,
      currentCalls: (window as any).__stressGeo.currentCalls
    }));
    expect(beforeSilence.pointCount).toBe(480);
    await page.clock.runFor(21_000);
    const silent = await page.evaluate(() => ({
      geoError: (window as any).__lt.recorder.rec.geoError,
      watchCalls: (window as any).__stressGeo.watchCalls,
      currentCalls: (window as any).__stressGeo.currentCalls,
      status: (window as any).__lt.recorder.rec.status
    }));
    expect(silent).toMatchObject({ geoError: 'silent', status: 'recording' });
    expect(silent.watchCalls).toBeGreaterThan(beforeSilence.watchCalls);
    expect(silent.currentCalls).toBeGreaterThan(beforeSilence.currentCalls);
    await emitSyntheticFix(page, 480);
    expect(await page.evaluate(() => (window as any).__lt.recorder.rec.geoError)).toBeNull();
    report.silenceRetry = { beforeSilence, silent, recovered: true };
    report.checks.silenceRetry = true;

    expect(await page.evaluate(() => (window as any).__lt.recorder.pauseRecording())).toBe(true);
    expect(await page.evaluate(() => (window as any).__lt.recorder.rec.status)).toBe('paused');
    const pausedAt = await page.evaluate(() => Date.now());
    await page.clock.setSystemTime(pausedAt + 10 * 60_000);
    expect(await page.evaluate(() => (window as any).__lt.recorder.resumeRecording())).toBe(true);
    await emitSyntheticFix(page, 481);
    const afterResume = await page.evaluate(() => ({
      segmentCount: (window as any).__lt.recorder.rec.live.segCount,
      segmentId: (window as any).__lt.recorder.rec.segmentId
    }));
    expect(afterResume.segmentCount).toBe(2);
    report.pauseResume = { pausedVirtualMs: 10 * 60_000, afterResume };
    report.checks.pauseResumeSegmentation = true;

    await setSyntheticVisibility(page, 'hidden');
    await page.clock.runFor(50_000);
    await setSyntheticVisibility(page, 'visible');
    await emitSyntheticFix(page, 482);
    const afterBackground = await page.evaluate(() => ({
      segmentCount: (window as any).__lt.recorder.rec.live.segCount,
      watchCalls: (window as any).__stressGeo.watchCalls,
      currentCalls: (window as any).__stressGeo.currentCalls
    }));
    expect(afterBackground.segmentCount).toBe(3);
    expect(afterBackground.watchCalls).toBeGreaterThan(silent.watchCalls);
    const beforeNextFix = await page.evaluate(() => Date.now());
    await page.clock.setSystemTime(beforeNextFix + 60_000);
    await emitSyntheticFix(page, 483);
    report.background = { hiddenVirtualMs: 50_000, autoBreakVerifiedBySegment: true, afterBackground };
    report.checks.backgroundSegmentation = true;

    // Isolate the fault-injected spill to exactly three new fixes; earlier fixes
    // in this segment must already be durable before the next chunk write is gated.
    expect(await page.evaluate(() => (window as any).__lt.recorder.flushBuffer())).toBe(true);
    expect(await page.evaluate(() => (window as any).__lt.recorder.rec.saveState.pending)).toBe(0);
    const spill = await blockNextChunkWriteAndSpill(page, 484);
    expect(spill.pending).toBe(3);
    expect(spill.blockedWrites).toBe(1);
    expect(spill.persistedPoints).toBe(484);
    expect(spill.persistedSegments).toBe(3);
    expect(spill.livePointCount).toBe(487);
    report.pagehideSpill = spill;
    await page.clock.runFor(20_000);
    // The three injected fixes carry one-minute synthetic timestamps; move the
    // document clock past them before continuation after reload.
    await page.clock.setSystemTime(spill.spillTimestamps[spill.spillTimestamps.length - 1] + 1_000);
    report.geolocationBeforeReload = await page.evaluate(() => ({
      watchCalls: (window as any).__stressGeo.watchCalls,
      currentCalls: (window as any).__stressGeo.currentCalls,
      clearCalls: (window as any).__stressGeo.clearCalls,
      emits: (window as any).__stressGeo.emits
    }));
    expect(report.geolocationBeforeReload.watchCalls).toBeGreaterThanOrEqual(3);
    expect(report.geolocationBeforeReload.currentCalls).toBeGreaterThanOrEqual(2);
    expect(report.geolocationBeforeReload.emits).toBe(487);

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
    await ready(page);
    const recovered = await page.evaluate(async (id) => {
      const store = (window as any).__lt.store;
      const trip = await store.getTrip(id);
      const segments = await store.db.segments.where('tripId').equals(id).sortBy('index');
      const counts = [];
      for (const segment of segments) {
        let count = 0;
        await store.db.trackChunks.where('segmentId').equals(segment.id).each((chunk: any) => { count += chunk.points.length; });
        counts.push(count);
      }
      return {
        status: trip.status,
        segmentCounts: counts,
        totalPoints: counts.reduce((sum: number, count: number) => sum + count, 0),
        spill: localStorage.getItem('roametch.pendingPoints.v1')
      };
    }, tripId);
    expect(recovered).toEqual({ status: 'recording', segmentCounts: [481, 1, 5], totalPoints: 487, spill: null });
    expect(recovered.totalPoints - spill.persistedPoints).toBe(spill.pending);
    report.recoveryEvidence = {
      blockedWrites: spill.blockedWrites,
      persistedBeforePagehide: spill.persistedPoints,
      persistedAfterReload: recovered.totalPoints,
      recoveredFromSpill: recovered.totalPoints - spill.persistedPoints
    };
    report.recovered = recovered;
    report.checks.pagehideSpillRecovery = true;

    expect(await page.evaluate((id) => (window as any).__lt.recorder.continueTrip(id), tripId)).toBe(true);
    await page.clock.runFor(1_000);
    await emitSyntheticFix(page, 487);
    expect(await page.evaluate(() => (window as any).__lt.recorder.stopRecording())).toBe(tripId);
    const finished = await page.evaluate(async (id) => {
      const store = (window as any).__lt.store;
      const trip = await store.getTrip(id);
      const segments = await store.db.segments.where('tripId').equals(id).sortBy('index');
      const counts = [];
      for (const segment of segments) {
        let count = 0;
        await store.db.trackChunks.where('segmentId').equals(segment.id).each((chunk: any) => { count += chunk.points.length; });
        counts.push(count);
      }
      return {
        status: trip.status,
        segmentCounts: counts,
        totalPoints: counts.reduce((sum: number, count: number) => sum + count, 0),
        saveState: (window as any).__lt.recorder.rec.saveState,
        spill: localStorage.getItem('roametch.pendingPoints.v1')
      };
    }, tripId);
    expect(finished.status).toBe('finished');
    expect(finished.segmentCounts).toEqual(report.expectedSegmentPoints);
    expect(finished.totalPoints).toBe(report.expectedTotalPoints);
    expect(finished.saveState).toMatchObject({ pending: 0, error: null, degraded: false });
    expect(finished.spill).toBeNull();
    report.finished = finished;
    report.checks.continuationAndFinalization = true;

    const fixtureAfter = await fingerprintFixtureTrips(page, fixtureIds);
    expect(fixtureAfter).toEqual(fixtureBaseline);
    report.checks.fixturesPreserved = true;

    await gotoTab(page, 'settings');
    for (let tap = 0; tap < 7; tap++) await page.locator('.about-version').click();
    const diagButton = page.getByRole('button', { name: '导出诊断日志', exact: true });
    await expect(diagButton).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      diagButton.click()
    ]);
    const diagPath = await download.path();
    expect(diagPath).toBeTruthy();
    const diagnostic = JSON.parse(readFileSync(diagPath!, 'utf8'));
    await attachStressReport(testInfo, 'roametch-diagnostic', diagnostic);
    expect(diagnostic.app).toBe('RoamEtch');
    expect(diagnostic.entries.length).toBeLessThanOrEqual(500);
    expect(diagnostic.entries.filter((entry: any) => entry.category === 'error')).toEqual([]);
    report.diagnostic = {
      app: diagnostic.app,
      version: diagnostic.version,
      exportedAt: diagnostic.exportedAt,
      entryCount: diagnostic.entries.length,
      categories: [...new Set(diagnostic.entries.map((entry: any) => entry.category))]
    };
    report.checks.diagnosticExport = true;

    report.virtualDurationMs = await page.evaluate(() => Date.now()) - started.startedAt;
    report.wallDurationMs = Date.now() - wallStarted;
    expect(report.virtualDurationMs).toBeGreaterThanOrEqual(8 * 60 * 60_000);
    expect(report.wallDurationMs).toBeLessThan(180_000);
    report.checks.acceleratedClockBounded = true;
  } catch (error) {
    report.failure = errorText(error);
    throw error;
  } finally {
    report.pageErrors = failures.pageErrors;
    report.crashes = failures.crashes;
    report.checks.noBrowserFailures = failures.pageErrors.length === 0 && failures.crashes === 0;
    report.passed = !report.failure && Object.values(report.checks).every(Boolean);
    report.browserVersion = page.context().browser()?.version() || null;
    report.viewport = page.viewportSize();
    await attachStressReport(testInfo, 'stress-recording-lifecycle', report);
  }

  expect(failures.pageErrors).toEqual([]);
  expect(failures.crashes).toBe(0);
  expect(report.checks).toEqual(Object.fromEntries(Object.keys(report.checks).map((key) => [key, true])));
  expect(report.passed).toBe(true);
});

test('browser cold-starts under CDP weak-network shaping and keeps IndexedDB fixtures usable across offline/online switching', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const failures = watchFailures(page);
  const weakNetwork = {
    offline: false,
    latency: 180,
    downloadThroughput: 400 * 1024,
    uploadThroughput: 200 * 1024,
    packetLoss: 0.01
  };
  const report: any = {
    scenario: 'cdp-weak-network-cold-start-and-switching',
    synthetic: true,
    realCarrier: false,
    budgets: { coldStartMs: COLD_START_BUDGET_MS },
    isolation: { persistentProfile: false, disposableContext: true, eraseAllCalls: 0, fixtureTrips: 3 },
    evidenceLimits: EVIDENCE_LIMITS,
    checks: {} as Record<string, boolean>,
    pageErrors: failures.pageErrors,
    crashes: failures.crashes,
    passed: false
  };
  let session: Awaited<ReturnType<typeof openStressCdp>> | null = null;
  let fixtureIds: string[] = [];

  try {
    await blockStressRemote(page);
    await page.goto('/');
    await ready(page);
    const fixtures = await seedThreeFixtureTrips(page);
    fixtureIds = fixtures.ids;
    report.fixtureIds = fixtureIds;
    report.fixtureBaseline = fixtures.fingerprint;

    session = await openStressCdp(page);
    await session.send('Network.enable');
    await session.send('Network.setCacheDisabled', { cacheDisabled: true });
    await session.send('Network.emulateNetworkConditions', weakNetwork);
    report.network = { weak: weakNetwork, cacheDisabled: true };

    const coldStartedAt = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
    await ready(page, 90_000);
    const coldStartMs = Date.now() - coldStartedAt;
    expect(coldStartMs).toBeLessThanOrEqual(COLD_START_BUDGET_MS);
    report.coldStartMs = coldStartMs;
    report.navigation = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0] as any;
      return {
        domContentLoadedMs: navigation?.domContentLoadedEventEnd || null,
        loadMs: navigation?.loadEventEnd || null,
        resources: performance.getEntriesByType('resource').map((entry: any) => ({
          name: entry.name, initiatorType: entry.initiatorType, durationMs: entry.duration, transferSize: entry.transferSize
        }))
      };
    });
    report.checks.weakColdStartBounded = true;

    const fixtureAfter = await fingerprintFixtureTrips(page, fixtureIds);
    expect(fixtureAfter).toEqual(report.fixtureBaseline);
    report.checks.fixturesPreservedAfterWeakReload = true;

    await session.send('Network.emulateNetworkConditions', {
      offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1, packetLoss: 0
    });
    await expect.poll(() => page.evaluate(() => navigator.onLine), { timeout: 5_000 }).toBe(false);
    const offlineData = await page.evaluate(async (ids) => {
      const trips = await (window as any).__lt.store.listTrips();
      return {
        online: navigator.onLine,
        fixtureNames: ids.map((id) => trips.find((trip: any) => trip.id === id)?.name).sort()
      };
    }, fixtureIds);
    expect(offlineData.online).toBe(false);
    expect(offlineData.fixtureNames).toEqual(['压力固定行程丙', '压力固定行程乙', '压力固定行程甲']);
    report.offline = offlineData;
    report.checks.offlineLocalDataUsable = true;

    await session.send('Network.emulateNetworkConditions', weakNetwork);
    await expect.poll(() => page.evaluate(() => navigator.onLine), { timeout: 5_000 }).toBe(true);
    const onlineFixtureNames = await page.evaluate(async (ids) => {
      const trips = await (window as any).__lt.store.listTrips();
      return ids.map((id) => trips.find((trip: any) => trip.id === id)?.name).sort();
    }, fixtureIds);
    expect(onlineFixtureNames).toEqual(offlineData.fixtureNames);
    report.online = { online: true, fixtureNames: onlineFixtureNames };
    report.checks.onlineSwitchPreservedData = true;
  } catch (error) {
    report.failure = errorText(error);
    throw error;
  } finally {
    if (session) {
      await session.send('Network.emulateNetworkConditions', {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, packetLoss: 0
      }).catch(() => {});
      await session.send('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {});
      await session.detach().catch(() => {});
    }
    report.pageErrors = failures.pageErrors;
    report.crashes = failures.crashes;
    report.checks.noBrowserFailures = failures.pageErrors.length === 0 && failures.crashes === 0;
    report.passed = !report.failure && Object.values(report.checks).every(Boolean);
    report.browserVersion = page.context().browser()?.version() || null;
    report.viewport = page.viewportSize();
    await attachStressReport(testInfo, 'stress-weak-network', report);
  }

  expect(failures.pageErrors).toEqual([]);
  expect(failures.crashes).toBe(0);
  expect(report.checks).toEqual(Object.fromEntries(Object.keys(report.checks).map((key) => [key, true])));
  expect(report.passed).toBe(true);
});
