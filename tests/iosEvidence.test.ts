import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'vitest';
import {
  computeBuildFingerprint,
  ENVIRONMENT_PROFILES,
  IOS_SCENARIOS,
  REQUIRED_CELL_COUNT,
  verifyEvidenceFile,
  verifyIosEvidence
} from '../scripts/verify-ios-evidence.mjs';

const BUILD = { fingerprint: `sha256:${'1'.repeat(64)}`, fileCount: 2, totalBytes: 5 };
const temporary: string[] = [];

function tempDir() {
  const directory = mkdtempSync(join(tmpdir(), 'roametch-ios-evidence-'));
  temporary.push(directory);
  return directory;
}

function fixture(): any {
  const runs: any[] = [];
  for (const profile of ENVIRONMENT_PROFILES) {
    for (const mode of ['safari', 'pwa'] as const) {
      for (const scenario of IOS_SCENARIOS) {
        const osBand = profile.osBand;
        const actual = scenario === 'quota'
          ? { points: 20_000, quotaTriggered: true }
          : scenario === 'memory-pressure'
            ? { points: 20_000, recovered: true }
            : { points: 20_000 };
        runs.push({
          id: `${profile.tier}-${mode}-${scenario}`,
          tester: 'fixture-only',
          device: {
            tier: profile.tier,
            model: profile.model ?? 'iPhone 16 Pro',
            udid: 'a'.repeat(40),
            ramGb: profile.ramGb,
            physical: true
          },
          os: {
            band: osBand,
            version: osBand === 'minimum' ? '16.7.12' : '26.1',
            build: osBand === 'minimum' ? '20H364' : 'fixture-latest'
          },
          mode,
          displayMode: mode === 'safari' ? 'browser' : 'standalone',
          scenario,
          status: 'passed',
          startedAt: '2026-11-01T10:00:00.000Z',
          completedAt: '2026-11-01T10:01:00.000Z',
          dataset: { trackPoints: 20_000, mediaCount: 20, mediaBytes: 40 * 1024 * 1024, backupBytes: 50 * 1024 * 1024 },
          result: {
            expected: structuredClone(actual),
            actual,
            countsCorrect: true,
            pageErrors: 0,
            crashes: 0,
            dataLoss: false,
            systemTerminations: scenario === 'system-termination' ? 1 : 0
          },
          memory: {
            source: 'xcode-instruments',
            peakBytes: 180 * 1024 * 1024,
            pressureEvents: scenario === 'memory-pressure' ? 1 : 0,
            jetsamEvents: scenario === 'system-termination' ? 1 : 0
          },
          evidence: [
            { type: 'screenshot', path: `${profile.tier}/${mode}/${scenario}.png`, sha256: 'b'.repeat(64) },
            { type: 'device-log', path: `${profile.tier}/${mode}/${scenario}.log`, sha256: 'c'.repeat(64) }
          ]
        });
      }
    }
  }
  return {
    schemaVersion: 1,
    matrixVersion: 'p0-4-v1',
    capturedAt: '2026-11-01T11:00:00.000Z',
    buildFingerprint: BUILD.fingerprint,
    artifact: { path: 'dist', fileCount: BUILD.fileCount, totalBytes: BUILD.totalBytes },
    iosPolicy: {
      minimum: { version: '16.7.12', build: '20H364', source: 'https://support.apple.com/', verifiedAt: '2026-11-01T09:00:00.000Z' },
      latest: { version: '26.1', build: 'fixture-latest', source: 'https://support.apple.com/', verifiedAt: '2026-11-01T09:00:00.000Z' }
    },
    runs
  };
}

function issue(report: ReturnType<typeof verifyIosEvidence>, text: RegExp) {
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => text.test(error)), report.errors.join('\n'));
}

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('P0-4 iOS evidence release gate', () => {
  it('keeps the JSON Schema matrix aligned with the verifier', () => {
    const schema = JSON.parse(readFileSync(new URL('../docs/qa/ios-evidence.schema.json', import.meta.url), 'utf8'));
    assert.equal(schema.properties.runs.minItems, REQUIRED_CELL_COUNT);
    assert.equal(schema.properties.runs.maxItems, REQUIRED_CELL_COUNT);
    assert.equal(schema['x-required-matrix'].version, 'p0-4-v1');
    assert.deepEqual(schema['x-required-matrix'].scenarios, IOS_SCENARIOS);
    assert.deepEqual(schema['x-required-matrix'].modes, ['safari', 'pwa']);
  });

  it('accepts the complete physical-device matrix fixture', () => {
    const evidence = fixture();
    assert.equal(evidence.runs.length, REQUIRED_CELL_COUNT);
    const report = verifyIosEvidence(evidence, BUILD);
    assert.deepEqual(report, {
      ok: true,
      errors: [],
      summary: { passedRuns: 52, requiredCells: 52, uniqueCells: 52 }
    });
  });

  it('rejects a missing evidence file and the CLI exits non-zero', async () => {
    const directory = tempDir();
    const path = join(directory, 'missing.json');
    const report = await verifyEvidenceFile(path, { fingerprint: BUILD.fingerprint });
    issue(report, /missing or invalid JSON/);
    const cli = spawnSync(process.execPath, [
      'scripts/verify-ios-evidence.mjs', '--evidence', path, '--fingerprint', BUILD.fingerprint
    ], { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /missing or invalid JSON/);
  });

  it('rejects a missing matrix cell', () => {
    const evidence = fixture();
    evidence.runs.pop();
    issue(verifyIosEvidence(evidence, BUILD), /Missing required matrix cell/);
  });

  it('rejects a mismatched dist fingerprint', () => {
    issue(verifyIosEvidence(fixture(), { ...BUILD, fingerprint: `sha256:${'2'.repeat(64)}` }), /fingerprint does not match dist/);
  });

  it('rejects a simulator impersonating a physical iPhone', () => {
    const evidence = fixture();
    Object.assign(evidence.runs[0].device, {
      model: 'iPhone SE (2nd generation) Simulator', physical: true, udid: 'SIMULATOR-UDID'
    });
    const report = verifyIosEvidence(evidence, BUILD);
    issue(report, /simulator\/emulated browser/);
    issue(report, /hardware UDID/);
  });

  it('rejects unverified policy sources, OS build mismatches, and non-iPhone current devices', () => {
    const unofficial = fixture();
    unofficial.iosPolicy.latest.source = 'https://example.com/ios';
    issue(verifyIosEvidence(unofficial, BUILD), /Apple source URL/);

    const wrongBuild = fixture();
    wrongBuild.runs.find((run: any) => run.device.tier === 'current').os.build = 'wrong-build';
    issue(verifyIosEvidence(wrongBuild, BUILD), /os\.build does not match iosPolicy\.latest/);

    const wrongModel = fixture();
    wrongModel.runs.find((run: any) => run.device.tier === 'current').device.model = 'iPad Pro';
    issue(verifyIosEvidence(wrongModel, BUILD), /current tier requires an iPhone/);
  });

  it('rejects failed and pending runs', () => {
    for (const status of ['failed', 'pending', 'blocked']) {
      const evidence = fixture();
      evidence.runs[0].status = status;
      issue(verifyIosEvidence(evidence, BUILD), /status must be passed/);
    }
  });

  it('verifies attachment existence and content hash', async () => {
    const evidence = fixture();
    const root = tempDir();
    for (const run of evidence.runs) {
      for (const ref of run.evidence) {
        mkdirSync(join(root, ref.path, '..'), { recursive: true });
        const bytes = Buffer.from(`fixture:${ref.path}`);
        writeFileSync(join(root, ref.path), bytes);
        ref.sha256 = createHash('sha256').update(bytes).digest('hex');
      }
    }
    const path = join(root, 'evidence.json');
    writeFileSync(path, JSON.stringify(evidence));
    const accepted = await verifyEvidenceFile(path, {
      fingerprint: BUILD.fingerprint, evidenceRoot: root
    });
    assert.deepEqual(accepted, {
      ok: true,
      errors: [],
      summary: { passedRuns: 52, requiredCells: 52, uniqueCells: 52 }
    });
    const ref = evidence.runs[0].evidence[0];
    writeFileSync(join(root, ref.path), 'changed');
    const changed = await verifyEvidenceFile(path, {
      fingerprint: BUILD.fingerprint, evidenceRoot: root
    });
    issue(changed, /SHA-256 does not match/);
    rmSync(join(root, ref.path));
    const missing = await verifyEvidenceFile(path, {
      fingerprint: BUILD.fingerprint, evidenceRoot: root
    });
    issue(missing, /attachment is missing/);
  });

  it('fingerprints dist deterministically without mtime or commit dependence', () => {
    const directory = tempDir();
    mkdirSync(join(directory, 'assets'));
    writeFileSync(join(directory, 'index.html'), 'app');
    writeFileSync(join(directory, 'assets', 'app.js'), 'js');
    const before = computeBuildFingerprint(directory);
    utimesSync(join(directory, 'index.html'), new Date(0), new Date(0));
    assert.deepEqual(computeBuildFingerprint(directory), before);
    writeFileSync(join(directory, 'assets', 'app.js'), 'changed');
    assert.notEqual(computeBuildFingerprint(directory).fingerprint, before.fingerprint);
  });
});
