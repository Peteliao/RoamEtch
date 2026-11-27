import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  lstatSync, readFileSync, readdirSync, realpathSync, statSync
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const MATRIX_VERSION = 'p0-4-v2';
export const REQUIRED_CELL_COUNT = 64;
export const DEFAULT_MAX_AGE_DAYS = 30;
export const LARGE_TRACK_POINTS = 20_000;
export const LARGE_BACKUP_BYTES = 50 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export const IOS_SCENARIOS = [
  'cold-start',
  'large-track',
  'health-check',
  'gps-cleaning',
  'gps-restore',
  'recording-recovery',
  'large-backup',
  'offline',
  'lock-screen',
  'background',
  'incoming-call',
  'network-switch',
  'app-update',
  'quota',
  'memory-pressure',
  'system-termination'
];

/** Only compatible floor/current pairings are release-gating cells. */
export const ENVIRONMENT_PROFILES = [
  { tier: 'legacy-low-memory', osBand: 'minimum', model: 'iPhone SE (2nd generation)', ramGb: 3 },
  { tier: 'current', osBand: 'latest', model: null, ramGb: 8 }
];

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_DIST = join(ROOT, 'dist');
const DEFAULT_EVIDENCE = join(ROOT, 'docs', 'qa', 'ios-evidence.json');
const SHA256 = /^[a-f0-9]{64}$/;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const IOS_VERSION = /^\d+\.\d+(?:\.\d+)?$/;
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const PHYSICAL_UDID = /^(?:[a-f0-9]{40}|[a-f0-9]{8}-[a-f0-9]{16})$/i;
const SCENARIO_SET = new Set(IOS_SCENARIOS);
const MEMORY_SOURCES = new Set(['xcode-instruments', 'metric-kit', 'device-log']);
const EVIDENCE_TYPES = new Set(['screenshot', 'video', 'log', 'trace', 'xcode-instruments', 'device-log']);
const VISUAL_TYPES = new Set(['screenshot', 'video']);
const DIAGNOSTIC_TYPES = new Set(['log', 'trace', 'xcode-instruments', 'device-log']);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Build artifacts must not contain symlinks: ${path}`);
    if (stat.isDirectory()) files.push(...listFiles(path));
    else if (stat.isFile()) files.push(path);
    else throw new Error(`Unsupported build artifact: ${path}`);
  }
  return files;
}

/**
 * Content-only fingerprint of the deployable dist tree. File mtimes and commit SHAs
 * are deliberately excluded, so evidence can be verified before/after committing.
 */
export function computeBuildFingerprint(distDir = DEFAULT_DIST) {
  const root = resolve(distDir);
  if (!statSync(root).isDirectory()) throw new Error(`dist is not a directory: ${root}`);
  const entries = listFiles(root)
    .map((path) => ({ path: relative(root, path).split(sep).join('/'), bytes: readFileSync(path) }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!entries.length) throw new Error(`dist is empty: ${root}`);
  const digest = createHash('sha256');
  let totalBytes = 0;
  for (const entry of entries) {
    const fileHash = sha256(entry.bytes);
    digest.update(`${entry.path}\0${entry.bytes.length}\0${fileHash}\n`);
    totalBytes += entry.bytes.length;
  }
  return { fingerprint: `sha256:${digest.digest('hex')}`, fileCount: entries.length, totalBytes };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isDateTime(value) {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE_TIME.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1];
}

function isHttpUrl(value) {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch { return false; }
}

function isAppleUrl(value) {
  if (!isHttpUrl(value)) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'support.apple.com' || host.endsWith('.support.apple.com')
      || host === 'developer.apple.com' || host.endsWith('.developer.apple.com');
  } catch { return false; }
}

function safeEvidencePath(value) {
  return isNonEmptyString(value)
    && !isAbsolute(value)
    && !/^[a-z]:/i.test(value)
    && !value.includes('\\')
    && !value.startsWith('/')
    && !/[\u0000-\u001f\u007f]/.test(value)
    && value.split('/').every((part) => part && part !== '.' && part !== '..');
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('Evidence contains a value that cannot be canonically serialized');
}

/**
 * Deterministic signed payload: recursively sorted object keys, no whitespace,
 * JSON string/number encoding, and the attestation object itself excluded.
 */
export function canonicalizeIosEvidenceJson(evidence) {
  if (!isRecord(evidence)) return canonicalJson(evidence);
  if (!isRecord(evidence.provenance)) return canonicalJson(evidence);
  const unsigned = { ...evidence, provenance: { ...evidence.provenance } };
  delete unsigned.provenance.attestation;
  return canonicalJson(unsigned);
}

function loadTrustedPublicKey(value) {
  if (!isNonEmptyString(value)) throw new Error('a base64 SPKI Ed25519 public key is required');
  const bytes = Buffer.from(value.trim(), 'base64');
  if (!bytes.length) throw new Error('the trusted public key is empty');
  const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the trusted public key must be Ed25519');
  return key;
}

function publicKeyId(key) {
  return `sha256:${sha256(key.export({ type: 'spki', format: 'der' }))}`;
}

function isEd25519Signature(value) {
  if (!isNonEmptyString(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === 64 && bytes.toString('base64') === value;
}

function validateProvenance(evidence, trustedPublicKey, errors) {
  const provenance = evidence.provenance;
  if (!isRecord(provenance)) {
    errors.push('provenance is required and must describe trusted physical-device collection');
    return null;
  }
  if (provenance.method !== 'physical-device') {
    errors.push('provenance.method must be physical-device; synthesized evidence is explicitly rejected');
  }
  if (!isNonEmptyString(provenance.collector) || !isNonEmptyString(provenance.collectorVersion)) {
    errors.push('provenance must identify the collector and collectorVersion');
  }
  let sources = null;
  if (!Array.isArray(provenance.sources) || !provenance.sources.length
    || provenance.sources.some((source) => !MEMORY_SOURCES.has(source))
    || new Set(provenance.sources).size !== provenance.sources.length) {
    errors.push('provenance.sources must be a non-empty unique list of trusted device collection sources');
  } else {
    sources = new Set(provenance.sources);
  }

  const attestation = provenance.attestation;
  if (!isRecord(attestation) || attestation.algorithm !== 'ed25519'
    || !FINGERPRINT.test(attestation.keyId || '') || !isEd25519Signature(attestation.signature)) {
    errors.push('provenance.attestation requires an Ed25519 keyId and signature');
    return sources;
  }
  let key;
  try {
    key = loadTrustedPublicKey(trustedPublicKey);
  } catch (error) {
    errors.push(`A trusted iOS evidence public key is required via --trusted-public-key or IOS_EVIDENCE_TRUSTED_PUBLIC_KEY: ${error.message}`);
    return sources;
  }
  if (attestation.keyId !== publicKeyId(key)) {
    errors.push('provenance.attestation.keyId does not match the trusted public key');
  }
  let validSignature = false;
  try {
    validSignature = verify(null, Buffer.from(canonicalizeIosEvidenceJson(evidence), 'utf8'), key, Buffer.from(attestation.signature, 'base64'));
  } catch { validSignature = false; }
  if (!validSignature) errors.push('provenance.attestation signature is invalid for the trusted public key (forged or modified evidence)');
  return sources;
}

function requiredKey(tier, osBand, mode, scenario) {
  return `${tier}|${osBand}|${mode}|${scenario}`;
}

function requiredKeys() {
  const keys = [];
  for (const profile of ENVIRONMENT_PROFILES) {
    for (const mode of ['safari', 'pwa']) {
      for (const scenario of IOS_SCENARIOS) {
        keys.push(requiredKey(profile.tier, profile.osBand, mode, scenario));
      }
    }
  }
  return keys;
}

function validatePolicyVersion(value, label, errors) {
  if (!isRecord(value) || !IOS_VERSION.test(value.version || '')
    || !isNonEmptyString(value.build) || !isAppleUrl(value.source) || !isDateTime(value.verifiedAt)) {
    errors.push(`${label} must include version, build, an Apple source URL, and verifiedAt`);
  }
}

function validateEvidenceReference(ref, label, evidenceRoot, errors) {
  if (!isRecord(ref) || !EVIDENCE_TYPES.has(ref.type)
    || !safeEvidencePath(ref.path) || !SHA256.test(ref.sha256 || '')) {
    errors.push(`${label} must have a supported type, safe relative path, and SHA-256`);
    return;
  }
  if (!evidenceRoot) return;
  try {
    const path = realpathSync(resolve(evidenceRoot, ref.path));
    const fromRoot = relative(evidenceRoot, path);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      errors.push(`${label} attachment escapes --evidence-root through a symlink: ${ref.path}`);
      return;
    }
    if (!lstatSync(path).isFile()) {
      errors.push(`${label} attachment is not a regular file: ${ref.path}`);
      return;
    }
    if (sha256(readFileSync(path)) !== ref.sha256) errors.push(`${label} SHA-256 does not match ${ref.path}`);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') errors.push(`${label} attachment is missing: ${ref.path}`);
    else errors.push(`${label} attachment cannot be verified: ${ref.path} (${error.message})`);
  }
}

/** Semantic release gate; the JSON Schema documents the same wire contract. */
export function verifyIosEvidence(evidence, build, {
  evidenceRoot = null,
  trustedPublicKey = null,
  now = Date.now(),
  maxAgeDays = DEFAULT_MAX_AGE_DAYS
} = {}) {
  const errors = [];
  if (!isRecord(evidence)) return { ok: false, errors: ['Evidence must be a JSON object'], summary: { passedRuns: 0, requiredCells: REQUIRED_CELL_COUNT } };
  if (evidence.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (evidence.matrixVersion !== MATRIX_VERSION) errors.push(`matrixVersion must be ${MATRIX_VERSION}`);

  let attachmentRoot = null;
  if (!isNonEmptyString(evidenceRoot)) errors.push('--evidence-root is required to verify every attachment');
  else {
    try {
      attachmentRoot = realpathSync(resolve(evidenceRoot));
      if (!statSync(attachmentRoot).isDirectory()) throw new Error('not a directory');
    } catch {
      errors.push(`--evidence-root is not an accessible directory: ${evidenceRoot}`);
    }
  }

  const nowMs = now instanceof Date ? now.getTime() : now;
  const validNow = typeof nowMs === 'number' && Number.isFinite(nowMs);
  if (!validNow) errors.push('Verification time must be a valid Date or millisecond timestamp');
  const maxAge = Number(maxAgeDays);
  const validMaxAge = Number.isFinite(maxAge) && maxAge > 0;
  if (!validMaxAge) errors.push('maxAgeDays must be a positive number of days');

  if (!isNonEmptyString(evidence.capturedAt)) errors.push('capturedAt is required and must be an ISO date-time with timezone');
  else if (!isDateTime(evidence.capturedAt)) errors.push('capturedAt must be an ISO date-time with timezone');
  else if (validNow) {
    const ageMs = nowMs - Date.parse(evidence.capturedAt);
    if (ageMs < 0) errors.push('capturedAt must not be in the future');
    else if (validMaxAge && ageMs > maxAge * DAY_MS) errors.push(`capturedAt is older than the ${maxAgeDays}-day TTL; recapture the real-device matrix`);
  }

  const provenanceSources = validateProvenance(evidence, trustedPublicKey, errors);

  if (!isRecord(build) || !FINGERPRINT.test(build.fingerprint || '')) errors.push('A computed sha256:<hex> build fingerprint is required');
  if (evidence.buildFingerprint !== build?.fingerprint) errors.push('Build fingerprint does not match dist (rebuild and rerun the real-device matrix)');
  if (!isRecord(evidence.artifact) || evidence.artifact.path !== 'dist'
    || !isCount(evidence.artifact.fileCount) || !isCount(evidence.artifact.totalBytes)) {
    errors.push('artifact must identify dist with fileCount and totalBytes');
  } else {
    if (Number.isSafeInteger(build?.fileCount) && evidence.artifact.fileCount !== build.fileCount) errors.push('Artifact fileCount does not match dist');
    if (Number.isSafeInteger(build?.totalBytes) && evidence.artifact.totalBytes !== build.totalBytes) errors.push('Artifact totalBytes does not match dist');
  }
  if (!isRecord(evidence.iosPolicy)) errors.push('iosPolicy is required');
  else {
    validatePolicyVersion(evidence.iosPolicy.minimum, 'iosPolicy.minimum', errors);
    validatePolicyVersion(evidence.iosPolicy.latest, 'iosPolicy.latest', errors);
    if (evidence.iosPolicy.minimum?.version === evidence.iosPolicy.latest?.version) errors.push('Minimum and latest iOS versions must be distinct');
  }

  const runs = Array.isArray(evidence.runs) ? evidence.runs : [];
  if (!Array.isArray(evidence.runs)) errors.push('runs must be an array');
  if (runs.length !== REQUIRED_CELL_COUNT) errors.push(`Exactly ${REQUIRED_CELL_COUNT} matrix runs are required; found ${runs.length}`);
  const ids = new Set();
  const cells = new Map();
  let passedRuns = 0;

  runs.forEach((run, index) => {
    const label = `runs[${index}]`;
    if (!isRecord(run)) { errors.push(`${label} must be an object`); return; }
    if (!isNonEmptyString(run.id) || ids.has(run.id)) errors.push(`${label}.id must be non-empty and unique`);
    else ids.add(run.id);
    if (!isNonEmptyString(run.tester)) errors.push(`${label}.tester is required`);
    if (!isDateTime(run.startedAt) || !isDateTime(run.completedAt) || Date.parse(run.completedAt) < Date.parse(run.startedAt)) {
      errors.push(`${label} must have valid startedAt/completedAt timestamps`);
    } else {
      if (isDateTime(evidence.capturedAt) && Date.parse(run.completedAt) > Date.parse(evidence.capturedAt)) {
        errors.push(`${label}.completedAt must not be after capturedAt`);
      }
      if (validNow && Date.parse(run.completedAt) > nowMs) errors.push(`${label}.completedAt must not be in the future`);
    }

    const device = run.device;
    if (!isRecord(device)) {
      errors.push(`${label}.device must identify a physical iPhone with model, hardware UDID, RAM, and physical=true`);
    } else {
      if (/simulator|emulator|playwright|webkit-iphone/i.test(device.model || '')) errors.push(`${label}.device is a simulator/emulated browser, not real-device evidence`);
      if (!['legacy-low-memory', 'current'].includes(device.tier)
        || !isNonEmptyString(device.model) || device.physical !== true
        || !PHYSICAL_UDID.test(device.udid || '') || !Number.isFinite(device.ramGb)) {
        errors.push(`${label}.device must identify a physical iPhone with model, hardware UDID, RAM, and physical=true`);
      } else if (device.tier === 'legacy-low-memory') {
        if (device.model !== 'iPhone SE (2nd generation)' || device.ramGb !== 3) errors.push(`${label}.device must be the 3 GB iPhone SE (2nd generation) floor device`);
      } else if (!device.model.startsWith('iPhone ') || device.ramGb < 8) {
        errors.push(`${label}.device current tier requires an iPhone with at least 8 GB RAM`);
      }
    }

    const os = run.os;
    if (!isRecord(os) || !['minimum', 'latest'].includes(os.band)
      || !IOS_VERSION.test(os.version || '') || !isNonEmptyString(os.build)) {
      errors.push(`${label}.os must include band, version, and build`);
    } else {
      const expectedVersion = os.band === 'minimum' ? evidence.iosPolicy?.minimum?.version : evidence.iosPolicy?.latest?.version;
      const expectedBuild = os.band === 'minimum' ? evidence.iosPolicy?.minimum?.build : evidence.iosPolicy?.latest?.build;
      if (expectedVersion && os.version !== expectedVersion) errors.push(`${label}.os.version does not match iosPolicy.${os.band}`);
      if (expectedBuild && os.build !== expectedBuild) errors.push(`${label}.os.build does not match iosPolicy.${os.band}`);
    }

    const mode = run.mode;
    if (!['safari', 'pwa'].includes(mode)) errors.push(`${label}.mode must be safari or pwa`);
    if ((mode === 'safari' && run.displayMode !== 'browser') || (mode === 'pwa' && run.displayMode !== 'standalone')) {
      errors.push(`${label}.displayMode must match ${mode}`);
    }
    if (!SCENARIO_SET.has(run.scenario)) errors.push(`${label}.scenario is not in the P0-4 matrix`);
    if (run.status !== 'passed') errors.push(`${label}.status must be passed (failed, pending, and blocked runs fail the gate)`);

    const dataset = run.dataset;
    if (!isRecord(dataset) || !['trackPoints', 'mediaCount', 'mediaBytes', 'backupBytes'].every((key) => isCount(dataset[key]))) {
      errors.push(`${label}.dataset must contain non-negative integer track/media/backup counts`);
    } else if (['large-track', 'health-check', 'gps-cleaning', 'gps-restore', 'recording-recovery', 'large-backup'].includes(run.scenario)
      && dataset.trackPoints < LARGE_TRACK_POINTS) {
      errors.push(`${label}.dataset requires at least ${LARGE_TRACK_POINTS} track points`);
    }
    if (run.scenario === 'large-backup' && isRecord(dataset)
      && (dataset.backupBytes < LARGE_BACKUP_BYTES || dataset.mediaCount < 20 || dataset.mediaBytes < 40 * 1024 * 1024)) {
      errors.push(`${label}.dataset large-backup requires >=50 MiB archive, >=20 media, and >=40 MiB media payload`);
    }

    const result = run.result;
    if (!isRecord(result) || !isDeepStrictEqual(result.expected, result.actual)) errors.push(`${label}.result expected and actual values must match`);
    if (!isRecord(result) || result.countsCorrect !== true || result.pageErrors !== 0 || result.crashes !== 0
      || result.dataLoss !== false || !isCount(result.systemTerminations)) {
      errors.push(`${label}.result requires countsCorrect=true, zero page errors/crashes, no data loss, and termination count`);
    }
    if (isRecord(result)) {
      if (run.scenario === 'system-termination' && result.systemTerminations < 1) errors.push(`${label} must record an actual OS termination and recovery`);
      else if (run.scenario !== 'system-termination' && result.systemTerminations !== 0) errors.push(`${label} must not record a system termination`);
      if (run.scenario === 'quota' && result.actual?.quotaTriggered !== true) errors.push(`${label} must demonstrate a real QuotaExceededError`);
      if (run.scenario === 'memory-pressure' && result.actual?.recovered !== true) errors.push(`${label} must confirm recovery after memory pressure`);
      if (run.scenario === 'incoming-call'
        && (!isCount(result.actual?.incomingCalls) || result.actual.incomingCalls < 1 || result.actual.recordingResumed !== true)) {
        errors.push(`${label} must record a real incoming call and confirmed recording recovery`);
      }
      if (run.scenario === 'network-switch'
        && (!isCount(result.actual?.networkTransitions) || result.actual.networkTransitions < 2 || result.actual.locationFreshnessSeparated !== true)) {
        errors.push(`${label} must record real network transitions and independent GPS freshness reporting`);
      }
      if (run.scenario === 'app-update'
        && (result.actual?.updateInstalled !== true || result.actual.spillRecovered !== true)) {
        errors.push(`${label} must record a real web-app update and recovered pending points`);
      }
    }

    const memory = run.memory;
    if (!isRecord(memory) || !MEMORY_SOURCES.has(memory.source)
      || !isCount(memory.peakBytes) || memory.peakBytes <= 0
      || !isCount(memory.pressureEvents) || !isCount(memory.jetsamEvents)) {
      errors.push(`${label}.memory requires measured peak bytes, pressure/jetsam counts, and an Apple/device evidence source`);
    } else {
      if (run.scenario === 'memory-pressure' && memory.pressureEvents < 1) errors.push(`${label} must record at least one real memory-pressure event`);
      if (run.scenario !== 'system-termination' && memory.jetsamEvents !== 0) errors.push(`${label} must not record jetsam`);
    }

    if (provenanceSources && MEMORY_SOURCES.has(memory?.source) && !provenanceSources.has(memory.source)) {
      errors.push(`${label}.memory.source is not declared in trusted provenance.sources`);
    }

    const refs = run.evidence;
    if (!Array.isArray(refs) || refs.length < 2) errors.push(`${label}.evidence requires at least one visual and one diagnostic artifact`);
    else {
      refs.forEach((ref, refIndex) => validateEvidenceReference(ref, `${label}.evidence[${refIndex}]`, attachmentRoot, errors));
      if (!refs.some((ref) => VISUAL_TYPES.has(ref?.type))) errors.push(`${label}.evidence requires a screenshot or video`);
      if (!refs.some((ref) => DIAGNOSTIC_TYPES.has(ref?.type))) errors.push(`${label}.evidence requires a log, trace, Instruments, or device-log artifact`);
    }

    const osBand = device?.tier === 'legacy-low-memory' ? 'minimum' : device?.tier === 'current' ? 'latest' : null;
    if (osBand && os?.band !== osBand) errors.push(`${label} uses an incompatible device/OS pairing`);
    if (osBand && ['safari', 'pwa'].includes(mode) && SCENARIO_SET.has(run.scenario)) {
      const key = requiredKey(device.tier, osBand, mode, run.scenario);
      if (cells.has(key)) errors.push(`${label} duplicates matrix cell ${key}`);
      else cells.set(key, run);
      if (run.status === 'passed') passedRuns++;
    }
  });

  for (const key of requiredKeys()) {
    if (!cells.has(key)) errors.push(`Missing required matrix cell: ${key}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    summary: { passedRuns, requiredCells: REQUIRED_CELL_COUNT, uniqueCells: cells.size }
  };
}

export async function verifyEvidenceFile(filePath, {
  distDir = DEFAULT_DIST,
  fingerprint = null,
  evidenceRoot = null,
  trustedPublicKey = null,
  now = Date.now(),
  maxAgeDays = DEFAULT_MAX_AGE_DAYS
} = {}) {
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(resolve(filePath), 'utf8'));
  } catch (error) {
    return { ok: false, errors: [`Evidence file is missing or invalid JSON: ${filePath} (${error.message})`], summary: { passedRuns: 0, requiredCells: REQUIRED_CELL_COUNT } };
  }
  let build;
  try {
    build = fingerprint ? { fingerprint } : computeBuildFingerprint(distDir);
  } catch (error) {
    return { ok: false, errors: [`Cannot fingerprint dist: ${error.message}`], summary: { passedRuns: 0, requiredCells: REQUIRED_CELL_COUNT } };
  }
  return verifyIosEvidence(evidence, build, { evidenceRoot, trustedPublicKey, now, maxAgeDays });
}

function usage() {
  return [
    'Usage: node scripts/verify-ios-evidence.mjs [options]',
    '',
    '  --evidence <path>       Evidence JSON (default: docs/qa/ios-evidence.json)',
    '  --dist <path>           Build tree to fingerprint (default: dist)',
    '  --fingerprint <sha256>  Verify an archived build when dist is unavailable',
    '  --evidence-root <path>  Required directory used to verify every attachment',
    '  --trusted-public-key <b64>  Trusted Ed25519 SPKI key (or IOS_EVIDENCE_TRUSTED_PUBLIC_KEY)',
    '  --max-age-days <days>   Maximum evidence age (default: 30; or IOS_EVIDENCE_MAX_AGE_DAYS)',
    '  --print-fingerprint     Print the current dist fingerprint and exit',
    '  --help                  Show this help'
  ].join('\n');
}

async function main() {
  const options = {
    evidence: DEFAULT_EVIDENCE,
    distDir: DEFAULT_DIST,
    fingerprint: null,
    evidenceRoot: null,
    trustedPublicKey: process.env.IOS_EVIDENCE_TRUSTED_PUBLIC_KEY || null,
    maxAgeDays: process.env.IOS_EVIDENCE_MAX_AGE_DAYS || DEFAULT_MAX_AGE_DAYS,
    printFingerprint: false
  };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') { console.log(usage()); return; }
    if (arg === '--print-fingerprint') { options.printFingerprint = true; continue; }
    const names = {
      '--evidence': 'evidence',
      '--dist': 'distDir',
      '--fingerprint': 'fingerprint',
      '--evidence-root': 'evidenceRoot',
      '--trusted-public-key': 'trustedPublicKey',
      '--max-age-days': 'maxAgeDays'
    };
    if (!names[arg] || !args[index + 1]) throw new Error(`Unknown or incomplete option: ${arg}\n${usage()}`);
    options[names[arg]] = args[++index];
  }
  if (options.printFingerprint) {
    console.log(computeBuildFingerprint(options.distDir).fingerprint);
    return;
  }
  if (options.fingerprint && !FINGERPRINT.test(options.fingerprint)) throw new Error('--fingerprint must be sha256:<64 lowercase hex>');
  const report = await verifyEvidenceFile(options.evidence, options);
  if (!report.ok) {
    console.error('iOS real-device evidence verification failed:');
    report.errors.forEach((error) => console.error(`- ${error}`));
    process.exitCode = 1;
    return;
  }
  console.log(`iOS real-device evidence verified: ${report.summary.passedRuns}/${report.summary.requiredCells} cells; build ${options.fingerprint || computeBuildFingerprint(options.distDir).fingerprint}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
