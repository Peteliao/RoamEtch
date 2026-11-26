import { bearing, haversine, physicsFor, MISSING_KINEMATICS_TOLERANCE, SPEED_TOLERANCE } from './geo';

export { SPEED_TOLERANCE } from './geo';
const HISTORY_MS = 120_000;
const CONFIRM_MS = 60_000;
const REVERSAL_DEG = 150;
const SPEED_NOISE = 1;

function accuracy(fix) {
  const value = Number(fix?.acc);
  return isFinite(value) && value > 0 ? value : null;
}

function reportedSpeed(fix) {
  if (fix?.speed == null) return null;
  const value = Number(fix.speed);
  return isFinite(value) && value >= 0 ? value : null;
}

function missingKinematics(fix) {
  return reportedSpeed(fix) == null && fix?.heading == null;
}

export function speedLimitFor(activity, fix = null) {
  const tolerance = missingKinematics(fix) ? MISSING_KINEMATICS_TOLERANCE : SPEED_TOLERANCE;
  return physicsFor(activity).vmax * tolerance;
}

function motion(from, to) {
  const dist = haversine(from.lat, from.lon, to.lat, to.lon);
  const dt = Number(to.t) - Number(from.t);
  const implied = dt > 0 ? dist / (dt / 1000) : null;
  return { dist, dt, implied };
}

function angleDelta(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function previousSpeed(anchor, history, fallback = null) {
  for (let i = history.length - 1; i >= 0; i--) {
    const p = history[i];
    const dt = Number(anchor.t) - Number(p.t);
    if (dt <= 0 || dt > 60_000 || p === anchor) continue;
    const step = motion(p, anchor);
    if (step.implied != null) return step.implied;
  }
  return fallback ?? reportedSpeed(anchor);
}

function travelDirection(anchor, history, minRevDist) {
  let origin = anchor;
  let travelled = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const p = history[i];
    if (Number(anchor.t) - Number(p.t) > HISTORY_MS) break;
    const step = haversine(p.lat, p.lon, origin.lat, origin.lon);
    if (step < 0.5) continue;
    travelled += step;
    origin = p;
    if (travelled >= minRevDist) break;
  }
  return { origin, travelled, heading: travelled > 0 ? bearing(origin.lat, origin.lon, anchor.lat, anchor.lon) : null };
}

function reversal(anchor, history, fix, minRevDist) {
  const direction = travelDirection(anchor, history, minRevDist);
  const outgoing = motion(anchor, fix);
  if (direction.travelled < minRevDist || outgoing.dist < minRevDist || outgoing.implied == null) return false;
  const turn = angleDelta(direction.heading, bearing(anchor.lat, anchor.lon, fix.lat, fix.lon));
  return turn > REVERSAL_DEG;
}

function continuesOldTrack(anchor, history, fix, activity, reason) {
  if (reason === 'speed' || reason === 'accel') return false;
  const physics = physicsFor(activity);
  if (motion(anchor, fix).dist > physics.minRevDist * 2) return false;
  const direction = travelDirection(anchor, history, physics.minRevDist);
  if (direction.travelled < physics.minRevDist) return false;
  const turn = angleDelta(direction.heading, bearing(anchor.lat, anchor.lon, fix.lat, fix.lon));
  return turn < 45;
}

function corridorWidth(a, b) {
  const avg = ((accuracy(a) ?? 15) + (accuracy(b) ?? 15)) / 2;
  return Math.max(25, Math.min(80, avg * 2));
}

function nearCorridor(anchor, history, fix, minRevDist) {
  if (motion(anchor, fix).dist < minRevDist) return false;
  for (const p of history) {
    if (p === anchor || Number(fix.t) - Number(p.t) > HISTORY_MS) continue;
    if (haversine(p.lat, p.lon, fix.lat, fix.lon) <= corridorWidth(p, fix)) return true;
  }
  return false;
}

function suspectReason(anchor, history, fix, activity) {
  const step = motion(anchor, fix);
  if (step.dt <= 0) return null;
  const physics = physicsFor(activity);
  const avgAcc = ((accuracy(anchor) ?? 15) + (accuracy(fix) ?? 15)) / 2;
  const jumpFloor = Math.max(10, avgAcc * 1.2);
  if (step.implied > speedLimitFor(activity, fix) && step.dist > jumpFloor) return 'speed';
  const prior = previousSpeed(anchor, history, step.implied);
  if (step.dist > jumpFloor && step.dt <= 60_000 && prior != null && Math.abs(step.implied - prior) > physics.maxAccel * (step.dt / 1000) + SPEED_NOISE) return 'accel';
  if (step.implied > physics.cruiseMin && reversal(anchor, history, fix, physics.minRevDist)) return 'reversal';
  if (step.implied > physics.cruiseMin && nearCorridor(anchor, history, fix, physics.minRevDist)) return 'history';
  return null;
}

function makePending(fix, anchor, history, activity, reason) {
  const reported = reportedSpeed(fix);
  const speed = reported != null && reported <= speedLimitFor(activity, fix) ? reported : null;
  return {
    entries: [{ fix, speed }],
    anchor,
    history: history.slice(),
    required: missingKinematics(fix) ? 4 : 3,
    reason
  };
}

function coherent(pending, fix, activity) {
  const first = pending.entries[0].fix;
  if (Number(fix.t) - Number(first.t) > CONFIRM_MS) return false;
  const last = pending.entries[pending.entries.length - 1];
  const step = motion(last.fix, fix);
  if (step.dt <= 0) return false;
  const speed = step.implied ?? reportedSpeed(fix);
  if (speed == null || step.implied > speedLimitFor(activity, fix)) return false;
  const physics = physicsFor(activity);
  if (last.speed != null && Math.abs(speed - last.speed) > physics.maxAccel * (step.dt / 1000) + SPEED_NOISE) return false;
  return !suspectReason(last.fix, pending.entries.map((entry) => entry.fix), fix, activity);
}

export function createJumpGate({ confirmPoints = 3 } = {}) {
  let pending = null;

  function evaluate({ fix, anchor, history = [], activity = 'auto' }) {
    if (!anchor) return { action: 'accept', points: [fix] };
    const physics = physicsFor(activity);
    const step = motion(anchor, fix);
    const reason = suspectReason(anchor, history, fix, activity);

    if (pending) {
      const expired = Number(fix.t) - Number(pending.entries[0].fix.t) > CONFIRM_MS;
      if (!expired) {
        const avgAcc = ((accuracy(anchor) ?? 15) + (accuracy(fix) ?? 15)) / 2;
        const nearOld = step.dist <= Math.max(physics.minRevDist, avgAcc * 2);
        if (nearOld && reason !== 'speed' && reason !== 'accel') {
          const discarded = pending.entries.map((entry) => entry.fix);
          const rejectedReason = pending.reason;
          pending = null;
          return { action: 'accept', points: [fix], discarded, reason: rejectedReason };
        }
        if (continuesOldTrack(anchor, history, fix, activity, reason)) {
          const discarded = pending.entries.map((entry) => entry.fix);
          const rejectedReason = pending.reason;
          pending = null;
          return { action: 'accept', points: [fix], discarded, reason: rejectedReason };
        }
        if (coherent(pending, fix, activity)) {
          const last = pending.entries[pending.entries.length - 1];
          const speed = motion(last.fix, fix).implied ?? reportedSpeed(fix);
          pending.entries.push({ fix, speed });
          const escaped = !nearCorridor(pending.anchor, pending.history, pending.entries[0].fix, physics.minRevDist)
            || !nearCorridor(pending.anchor, pending.history, fix, physics.minRevDist);
          if (pending.entries.length >= Math.max(confirmPoints, pending.required) && escaped) {
            const points = pending.entries.map((entry) => entry.fix);
            pending = null;
            return { action: 'confirm', points };
          }
          return { action: 'pending', points: [fix] };
        }
      }
      const discarded = pending.entries.map((entry) => entry.fix);
      const rejectedReason = pending.reason;
      pending = makePending(fix, anchor, history, activity, reason);
      return { action: 'pending', points: [fix], discarded, reason: rejectedReason };
    }

    if (reason) {
      pending = makePending(fix, anchor, history, activity, reason);
      return { action: 'pending', points: [fix] };
    }
    return { action: 'accept', points: [fix] };
  }

  function pendingPoints() {
    return pending ? pending.entries.map((entry) => entry.fix) : [];
  }

  return { evaluate, reset: () => { pending = null; }, pendingPoints };
}
