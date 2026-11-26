export const SIMULATION_SCENARIOS = [
  'hike', 'cycle', 'drive', 'drift', 'location-loss', 'altitude-spike',
  'stationary', 'sudden-stop', 'background-suspend', 'network-switch', 'mixed'
] as const;

export type SimulationScenario = typeof SIMULATION_SCENARIOS[number];
export type SimulationEventType =
  | 'gps-drift' | 'location-loss' | 'location-restored'
  | 'altitude-spike' | 'stationary' | 'resume-motion' | 'sudden-stop'
  | 'background-suspend' | 'background-resume' | 'network-offline' | 'network-online';

export interface SimulatedFix {
  lat: number;
  lon: number;
  acc: number;
  alt: number;
  altAcc: number;
  speed: number;
  heading: number;
  t: number;
}

export interface SimulationEvent {
  type: SimulationEventType;
  t: number;
  index: number;
  durationMs?: number;
}

export type SimulationItem =
  | { kind: 'fix'; fix: SimulatedFix }
  | { kind: 'event'; event: SimulationEvent };

export interface SimulationOptions {
  scenario?: SimulationScenario;
  durationMs?: number;
  sampleMs?: number;
  startTime?: number;
  seed?: number;
  maxPoints?: number;
  start?: { lat: number; lon: number; alt: number };
}

export interface NormalizedSimulationOptions {
  scenario: SimulationScenario;
  durationMs: number;
  sampleMs: number;
  startTime: number;
  seed: number;
  maxPoints: number;
  start: { lat: number; lon: number; alt: number };
}

export interface SimulationHooks {
  onFix?: (fix: SimulatedFix) => void | Promise<void>;
  onEvent?: (event: SimulationEvent) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface SimulationRunResult {
  fixes: number;
  events: number;
  aborted: boolean;
  firstFixT: number | null;
  lastFixT: number | null;
}

const BASE_SPEED: Record<SimulationScenario, number> = {
  hike: 1.3,
  cycle: 6.5,
  drive: 22,
  drift: 1.3,
  'location-loss': 1.3,
  'altitude-spike': 1.3,
  stationary: 0,
  'sudden-stop': 1.3,
  'background-suspend': 1.3,
  'network-switch': 1.3,
  mixed: 1.3
};

function randomGenerator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function normalizeSimulationOptions(options: SimulationOptions = {}): NormalizedSimulationOptions {
  const scenario = options.scenario ?? 'mixed';
  if (!SIMULATION_SCENARIOS.includes(scenario)) throw new Error(`unknown simulation scenario: ${scenario}`);
  const durationMs = options.durationMs ?? 20 * 60_000;
  const sampleMs = options.sampleMs ?? 1000;
  const startTime = options.startTime ?? Date.now();
  const seed = options.seed ?? 1;
  const maxPoints = options.maxPoints ?? Number.POSITIVE_INFINITY;
  const start = options.start ?? { lat: 30, lon: 120, alt: 100 };
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('durationMs must be positive');
  if (!Number.isFinite(sampleMs) || sampleMs <= 0) throw new Error('sampleMs must be positive');
  if (!Number.isFinite(startTime) || startTime <= 0) throw new Error('startTime must be positive');
  if (!Number.isFinite(seed)) throw new Error('seed must be finite');
  if (maxPoints !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxPoints) || maxPoints <= 0)) {
    throw new Error('maxPoints must be a positive integer');
  }
  if (!Number.isFinite(start.lat) || Math.abs(start.lat) > 90) throw new Error('invalid start latitude');
  if (!Number.isFinite(start.lon) || Math.abs(start.lon) > 180) throw new Error('invalid start longitude');
  if (!Number.isFinite(start.alt)) throw new Error('invalid start altitude');
  return { scenario, durationMs, sampleMs, startTime, seed, maxPoints, start: { ...start } };
}

function hasScenario(scenario: SimulationScenario, selected: SimulationScenario) {
  return scenario === selected || scenario === 'mixed';
}

export function* simulateTrack(options: SimulationOptions = {}): Generator<SimulationItem, void, unknown> {
  const config = normalizeSimulationOptions(options);
  const { scenario, durationMs, sampleMs, startTime, seed, maxPoints, start } = config;
  const totalSteps = Math.max(1, Math.floor(durationMs / sampleMs));
  const at = (ratio: number) => Math.min(totalSteps, Math.floor(totalSteps * ratio));
  const mixed = scenario === 'mixed';
  const locationRange = mixed ? [at(0.05), at(0.15)] : [at(0.1), at(0.5)];
  const backgroundRange = mixed ? [at(0.55), at(0.65)] : [at(0.1), at(0.6)];
  const stationaryRange = mixed ? [at(0.7), at(0.8)] : [0, totalSteps];
  const suddenStopIndex = at(mixed ? 0.85 : 0.4);
  const altitudeSpikeIndex = at(mixed ? 0.52 : 0.5);
  const networkOfflineIndex = at(0.2);
  const networkOnlineIndex = at(0.35);
  const random = randomGenerator(seed);
  const baseSpeed = BASE_SPEED[scenario];
  let lat = start.lat;
  let lon = start.lon;
  let emitted = 0;

  const event = (type: SimulationEventType, index: number, durationMs?: number): SimulationItem => ({
    kind: 'event',
    event: { type, t: startTime + index * sampleMs, index, ...(durationMs == null ? {} : { durationMs }) }
  });

  for (let index = 0; index <= totalSteps; index++) {
    const t = startTime + index * sampleMs;
    if (hasScenario(scenario, 'network-switch')) {
      if (index === networkOfflineIndex) yield event('network-offline', index);
      if (index === networkOnlineIndex) yield event('network-online', index, (networkOnlineIndex - networkOfflineIndex) * sampleMs);
    }
    if (hasScenario(scenario, 'location-loss')) {
      if (index === locationRange[0]) {
        yield event('location-loss', index, (locationRange[1] - locationRange[0]) * sampleMs);
      }
      if (index === locationRange[1]) yield event('location-restored', index);
    }
    if (hasScenario(scenario, 'background-suspend')) {
      if (index === backgroundRange[0]) {
        yield event('background-suspend', index, (backgroundRange[1] - backgroundRange[0]) * sampleMs);
      }
      if (index === backgroundRange[1]) yield event('background-resume', index);
    }
    if (hasScenario(scenario, 'stationary') && index === stationaryRange[0]) yield event('stationary', index);
    if (hasScenario(scenario, 'stationary') && mixed && index === stationaryRange[1]) yield event('resume-motion', index);
    if (hasScenario(scenario, 'sudden-stop') && index === suddenStopIndex) yield event('sudden-stop', index);
    if (hasScenario(scenario, 'altitude-spike') && index === altitudeSpikeIndex) yield event('altitude-spike', index);

    const inLocationGap = hasScenario(scenario, 'location-loss')
      && index >= locationRange[0] && index < locationRange[1];
    const inBackgroundGap = hasScenario(scenario, 'background-suspend')
      && index >= backgroundRange[0] && index < backgroundRange[1];
    if (inLocationGap || inBackgroundGap) continue;
    if (emitted >= maxPoints) return;

    const stationary = hasScenario(scenario, 'stationary')
      && (scenario === 'stationary' || (index >= stationaryRange[0] && index < stationaryRange[1]));
    const stopped = hasScenario(scenario, 'sudden-stop') && index >= suddenStopIndex;
    const speed = stationary || stopped ? 0 : baseSpeed * (0.94 + random() * 0.12);
    const heading = 78 + Math.sin(index / 90) * 18 + (random() - 0.5) * 2;
    const metresPerDegree = 111_320;
    const lonScale = metresPerDegree * Math.max(0.1, Math.cos(lat * Math.PI / 180));
    const distance = speed * sampleMs / 1000;
    lat += Math.cos(heading * Math.PI / 180) * distance / metresPerDegree;
    lon += Math.sin(heading * Math.PI / 180) * distance / lonScale;

    const driftPhase = index % 41;
    const drifting = hasScenario(scenario, 'drift') && !stationary && !stopped && driftPhase >= 12 && driftPhase <= 14;
    if (drifting && driftPhase === 12) yield event('gps-drift', index);
    if (drifting) lon += Math.max(35, baseSpeed * sampleMs / 1000 * 5) / lonScale;
    if (stationary) {
      lat += (random() - 0.5) * 0.6 / metresPerDegree;
      lon += (random() - 0.5) * 0.6 / lonScale;
    }

    const alt = start.alt + Math.sin(index / 180) * 12 + Math.cos(index / 47) * 2
      + (hasScenario(scenario, 'altitude-spike') && index === altitudeSpikeIndex ? 150 : 0);
    const acc = drifting && driftPhase === 12 ? 65 : 5 + random() * 3;
    yield {
      kind: 'fix',
      fix: { lat, lon, acc, alt, altAcc: 8, speed, heading, t }
    };
    emitted++;
  }
}

export async function runSimulation(options: SimulationOptions, hooks: SimulationHooks = {}): Promise<SimulationRunResult> {
  let fixes = 0;
  let events = 0;
  let firstFixT: number | null = null;
  let lastFixT: number | null = null;
  for (const item of simulateTrack(options)) {
    if (hooks.signal?.aborted) return { fixes, events, aborted: true, firstFixT, lastFixT };
    if (item.kind === 'event') {
      await hooks.onEvent?.(item.event);
      events++;
    } else {
      await hooks.onFix?.(item.fix);
      firstFixT ??= item.fix.t;
      lastFixT = item.fix.t;
      fixes++;
    }
  }
  return { fixes, events, aborted: false, firstFixT, lastFixT };
}
