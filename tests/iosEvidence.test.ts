import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'vitest';
import {
  canonicalizeIosEvidenceJson,
  computeBuildFingerprint,
  DEFAULT_MAX_AGE_DAYS,
  ENVIRONMENT_PROFILES,
  IOS_SCENARIOS,
  MATRIX_VERSION,
  REQUIRED_CELL_COUNT,
  verifyEvidenceFile,
  verifyIosEvidence
} from '../scripts/verify-ios-evidence.mjs';

const BUILD = { fingerprint: `sha256:${'1'.repeat(64)}`, fileCount: 2, totalBytes: 5 };
const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const collectorKeys = generateKeyPairSync('ed25519');
const TRUSTED_PUBLIC_KEY = collectorKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const temporary: string[] = [];

function tempDir() {
  const directory = mkdtempSync(join(tmpdir(), 'roametch-ios-evidence-'));
  temporary.push(directory);
  return directory;
}

function attest(evidence: any, privateKey = collectorKeys.privateKey) {
  const publicKey = createPublicKey(privateKey);
  const keyId = `sha256:${createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')}`;
  evidence.provenance.attestation = {
    algorithm: 'ed25519',
    keyId,
    signature: sign(null, Buffer.from(canonicalizeIosEvidenceJson(evidence), 'utf8'), privateKey).toString('base64')
  };
  return evidence;
}

function setCapturedAt(evidence: any, capturedAt: string) {
  evidence.capturedAt = capturedAt;
  const captureTime = Date.parse(capturedAt);
  for (const run of evidence.runs) {
    run.startedAt = new Date(captureTime - 2 * 60 * 60 * 1000).toISOString();
    run.completedAt = new Date(captureTime - 60 * 60 * 1000).toISOString();
  }
  return attest(evidence);
}

function fixture(): any {
  const runs: any[] = [];
  for (const profile of ENVIRONMENT_PROFILES) {
    for (const mode of ['safari', 'pwa'] as const) {
      for (const scenario of IOS_SCENARIOS) {
        const osBand = profile.osBand;
        const actual: Record<string, unknown> = { points: 20_000 };
        if (scenario === 'quota') actual.quotaTriggered = true;
        else if (scenario === 'memory-pressure') actual.recovered = true;
        else if (scenario === 'incoming-call') Object.assign(actual, { incomingCalls: 1, recordingResumed: true });
        else if (scenario === 'network-switch') Object.assign(actual, { networkTransitions: 3, locationFreshnessSeparated: true });
        else if (scenario === 'app-update') Object.assign(actual, { updateInstalled: true, spillRecovered: true });
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
            { type: 'screenshot', path: `${profile.tier}/${mode}/${scenario}.png`, sha256: createHash('sha256').update(`fixture:${profile.tier}/${mode}/${scenario}.png`).digest('hex') },
            { type: 'device-log', path: `${profile.tier}/${mode}/${scenario}.log`, sha256: createHash('sha256').update(`fixture:${profile.tier}/${mode}/${scenario}.log`).digest('hex') }
          ]
        });
      }
    }
  }
  const evidence = {
    schemaVersion: 1,
    matrixVersion: MATRIX_VERSION,
    capturedAt: '2026-11-01T11:00:00.000Z',
    buildFingerprint: BUILD.fingerprint,
    artifact: { path: 'dist', fileCount: BUILD.fileCount, totalBytes: BUILD.totalBytes },
    iosPolicy: {
      minimum: { version: '16.7.12', build: '20H364', source: 'https://support.apple.com/', verifiedAt: '2026-11-01T09:00:00.000Z' },
      latest: { version: '26.1', build: 'fixture-latest', source: 'https://support.apple.com/', verifiedAt: '2026-11-01T09:00:00.000Z' }
    },
    provenance: {
      method: 'physical-device',
      collector: 'fixture-only-collector',
      collectorVersion: '1.0.0',
      sources: ['xcode-instruments', 'device-log']
    },
    runs
  };
  return attest(evidence);
}

function materialize(evidence: any) {
  const root = tempDir();
  for (const run of evidence.runs) {
    for (const ref of run.evidence) {
      mkdirSync(join(root, ref.path, '..'), { recursive: true });
      writeFileSync(join(root, ref.path), `fixture:${ref.path}`);
    }
  }
  return root;
}

function verifyFixture(evidence: any, options: Record<string, unknown> = {}) {
  const { build = BUILD, ...verificationOptions } = options;
  return verifyIosEvidence(evidence, build, {
    evidenceRoot: materialize(evidence),
    trustedPublicKey: TRUSTED_PUBLIC_KEY,
    now: NOW,
    ...verificationOptions
  });
}

function assertAccepted(report: ReturnType<typeof verifyIosEvidence>) {
  assert.deepEqual(report, {
    ok: true,
    errors: [],
    summary: { passedRuns: REQUIRED_CELL_COUNT, requiredCells: REQUIRED_CELL_COUNT, uniqueCells: REQUIRED_CELL_COUNT }
  });
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
    assert.equal(schema['x-required-matrix'].version, MATRIX_VERSION);
    assert.deepEqual(schema['x-required-matrix'].scenarios, IOS_SCENARIOS);
    assert.deepEqual(schema['x-required-matrix'].modes, ['safari', 'pwa']);
    assert.equal(schema['x-default-max-age-days'], DEFAULT_MAX_AGE_DAYS);
    assert.ok(schema.required.includes('capturedAt'));
    assert.ok(schema.required.includes('provenance'));
    assert.equal(schema.$defs.provenance.properties.method.const, 'physical-device');
    assert.equal(schema.$defs.provenance.properties.attestation.properties.algorithm.const, 'ed25519');
  });

  it('accepts the complete physical-device matrix fixture', () => {
    const evidence = fixture();
    assert.equal(evidence.runs.length, REQUIRED_CELL_COUNT);
    assertAccepted(verifyFixture(evidence));
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

  it('honors trusted-key and max-age CLI configuration for signed evidence', () => {
    const evidence = fixture();
    setCapturedAt(evidence, new Date(Date.now() - 45 * DAY_MS).toISOString());
    const root = materialize(evidence);
    const path = join(root, 'evidence.json');
    writeFileSync(path, JSON.stringify(evidence));
    const args = [
      'scripts/verify-ios-evidence.mjs', '--evidence', path, '--evidence-root', root,
      '--fingerprint', BUILD.fingerprint
    ];
    const env = { ...process.env, IOS_EVIDENCE_TRUSTED_PUBLIC_KEY: TRUSTED_PUBLIC_KEY };
    const expired = spawnSync(process.execPath, args, { encoding: 'utf8', env });
    assert.equal(expired.status, 1);
    assert.match(expired.stderr, /older than the 30-day TTL/);
    const accepted = spawnSync(process.execPath, [...args, '--max-age-days', '60'], { encoding: 'utf8', env });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, new RegExp(`${REQUIRED_CELL_COUNT}\\/${REQUIRED_CELL_COUNT} cells`));
  });

  it('rejects a missing matrix cell', () => {
    const evidence = fixture();
    evidence.runs.pop();
    issue(verifyFixture(evidence), /Missing required matrix cell/);
  });

  it('rejects a mismatched dist fingerprint', () => {
    issue(verifyFixture(fixture(), { build: { ...BUILD, fingerprint: `sha256:${'2'.repeat(64)}` } }), /fingerprint does not match dist/);
  });

  it('rejects a simulator impersonating a physical iPhone', () => {
    const evidence = fixture();
    Object.assign(evidence.runs[0].device, {
      model: 'iPhone SE (2nd generation) Simulator', physical: true, udid: 'SIMULATOR-UDID'
    });
    const report = verifyFixture(evidence);
    issue(report, /simulator\/emulated browser/);
    issue(report, /hardware UDID/);
  });

  it('rejects unverified policy sources, OS build mismatches, and non-iPhone current devices', () => {
    const unofficial = fixture();
    unofficial.iosPolicy.latest.source = 'https://example.com/ios';
    issue(verifyFixture(unofficial), /Apple source URL/);

    const wrongBuild = fixture();
    wrongBuild.runs.find((run: any) => run.device.tier === 'current').os.build = 'wrong-build';
    issue(verifyFixture(wrongBuild), /os\.build does not match iosPolicy\.latest/);

    const wrongModel = fixture();
    wrongModel.runs.find((run: any) => run.device.tier === 'current').device.model = 'iPad Pro';
    issue(verifyFixture(wrongModel), /current tier requires an iPhone/);
  });

  it('rejects failed and pending runs', () => {
    for (const status of ['failed', 'pending', 'blocked']) {
      const evidence = fixture();
      evidence.runs[0].status = status;
      issue(verifyFixture(evidence), /status must be passed/);
    }
  });

  it('requires independent proof for incoming-call, network-switch, and app-update runs', () => {
    const cases = [
      { scenario: 'incoming-call', field: 'recordingResumed', error: /real incoming call and confirmed recording recovery/ },
      { scenario: 'network-switch', field: 'locationFreshnessSeparated', error: /real network transitions and independent GPS freshness/ },
      { scenario: 'app-update', field: 'spillRecovered', error: /real web-app update and recovered pending points/ }
    ];
    for (const item of cases) {
      const evidence = fixture();
      const run = evidence.runs.find((candidate: any) => candidate.scenario === item.scenario);
      delete run.result.actual[item.field];
      attest(evidence);
      issue(verifyFixture(evidence), item.error);
    }
  });

  it('requires capturedAt and rejects future or expired evidence', () => {
    const missing = fixture();
    delete missing.capturedAt;
    attest(missing);
    issue(verifyFixture(missing), /capturedAt is required/);

    const future = fixture();
    setCapturedAt(future, new Date(NOW + 1).toISOString());
    issue(verifyFixture(future), /capturedAt must not be in the future/);

    const expired = fixture();
    setCapturedAt(expired, new Date(NOW - (DEFAULT_MAX_AGE_DAYS + 1) * DAY_MS).toISOString());
    issue(verifyFixture(expired), /older than the 30-day TTL/);
  });

  it('supports a configurable TTL and accepts the exact age boundary', () => {
    const evidence = fixture();
    setCapturedAt(evidence, new Date(NOW - 45 * DAY_MS).toISOString());
    issue(verifyFixture(evidence), /older than the 30-day TTL/);
    assertAccepted(verifyFixture(evidence, { maxAgeDays: 60 }));

    setCapturedAt(evidence, new Date(NOW - DEFAULT_MAX_AGE_DAYS * DAY_MS).toISOString());
    assertAccepted(verifyFixture(evidence));
    issue(verifyFixture(evidence, { maxAgeDays: 0 }), /maxAgeDays must be a positive number/);
  });

  it('requires trusted physical-device provenance and rejects synthesized or undeclared sources', () => {
    const missing = fixture();
    delete missing.provenance;
    issue(verifyFixture(missing), /provenance is required/);
    issue(verifyFixture(fixture(), { trustedPublicKey: null }), /trusted iOS evidence public key is required/);

    const synthesized = fixture();
    synthesized.provenance.method = 'synthesized';
    attest(synthesized);
    issue(verifyFixture(synthesized), /synthesized evidence is explicitly rejected/);

    const unsupported = fixture();
    unsupported.provenance.sources = ['playwright'];
    attest(unsupported);
    issue(verifyFixture(unsupported), /trusted device collection sources/);

    const undeclared = fixture();
    undeclared.provenance.sources = ['device-log'];
    attest(undeclared);
    issue(verifyFixture(undeclared), /memory\.source is not declared in trusted provenance\.sources/);
  });

  it('rejects forged collection metadata and attestations from an untrusted key', () => {
    const modified = fixture();
    modified.provenance.collector = 'forged-collector';
    issue(verifyFixture(modified), /signature is invalid for the trusted public key/);

    const attackerKeys = generateKeyPairSync('ed25519');
    attest(modified, attackerKeys.privateKey);
    const report = verifyFixture(modified);
    issue(report, /keyId does not match the trusted public key/);
    issue(report, /signature is invalid for the trusted public key/);
  });

  it('requires an evidence root instead of trusting attachment hashes alone', () => {
    const evidence = fixture();
    const report = verifyIosEvidence(evidence, BUILD, { trustedPublicKey: TRUSTED_PUBLIC_KEY, now: NOW });
    issue(report, /--evidence-root is required/);
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
      fingerprint: BUILD.fingerprint,
      evidenceRoot: root,
      trustedPublicKey: TRUSTED_PUBLIC_KEY,
      now: NOW
    });
    assertAccepted(accepted);
    const ref = evidence.runs[0].evidence[0];
    writeFileSync(join(root, ref.path), 'changed');
    const changed = await verifyEvidenceFile(path, {
      fingerprint: BUILD.fingerprint,
      evidenceRoot: root,
      trustedPublicKey: TRUSTED_PUBLIC_KEY,
      now: NOW
    });
    issue(changed, /SHA-256 does not match/);
    rmSync(join(root, ref.path));
    const missing = await verifyEvidenceFile(path, {
      fingerprint: BUILD.fingerprint,
      evidenceRoot: root,
      trustedPublicKey: TRUSTED_PUBLIC_KEY,
      now: NOW
    });
    issue(missing, /attachment is missing/);
  });

  it('gates release after the final build and before publishing without blocking CI or Pages', () => {
    const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
    const verifyJob = release.split('\n  images:')[0];
    const buildIndex = verifyJob.indexOf('- run: npm run build');
    const finalBuildIndex = verifyJob.indexOf('- run: npm run test:memory');
    const gateIndex = verifyJob.indexOf('- name: Verify iOS real-device evidence');
    const packageIndex = verifyJob.indexOf('- name: Package static build');
    const publishIndex = verifyJob.indexOf('- name: Publish GitHub Release');
    assert.ok(buildIndex >= 0 && finalBuildIndex > buildIndex);
    assert.ok(gateIndex > finalBuildIndex && packageIndex > gateIndex && publishIndex > packageIndex);
    const gate = verifyJob.slice(gateIndex, packageIndex);
    assert.match(gate, /npm run verify:ios-evidence -- --evidence docs\/qa\/ios-evidence\.json --evidence-root docs\/qa\/evidence/);
    assert.match(gate, /IOS_EVIDENCE_TRUSTED_PUBLIC_KEY/);
    assert.doesNotMatch(gate, /continue-on-error|^\s+if:/m);
    assert.match(release, /images:\s*\n\s+needs: verify/);

    for (const workflow of ['ci.yml', 'deploy.yml']) {
      const source = readFileSync(new URL(`../.github/workflows/${workflow}`, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /verify:ios-evidence|verify-ios-evidence/);
    }
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
