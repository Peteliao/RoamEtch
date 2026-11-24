import { describe, expect, it } from 'vitest';
import { ACTIVITY_PHYSICS } from '../src/core/geo';
import { createJumpGate } from '../src/core/trackFilter';

const M_PER_LON = 95_600;

function fix(t, lon, speed = 20, heading = 90, acc = 5) {
  return { lat: 30, lon: 120 + lon / M_PER_LON, t, speed, heading, acc };
}

function runGate(activity, fixes) {
  const gate = createJumpGate();
  const actions = [];
  const accepted = [];
  let anchor = null;
  let history = [];
  for (const point of fixes) {
    const decision = gate.evaluate({ fix: point, anchor, history, activity });
    actions.push(decision.action);
    if (decision.action === 'accept' || decision.action === 'confirm') {
      accepted.push(...decision.points);
      anchor = decision.points[decision.points.length - 1];
      history = [...history, ...decision.points].slice(-400);
    }
  }
  return { actions, accepted };
}

describe('activity physics jump gate', () => {
  it.each(Object.keys(ACTIVITY_PHYSICS))('uses the %s speed envelope', (activity) => {
    const vmax = ACTIVITY_PHYSICS[activity].vmax;
    const within = runGate(activity, [fix(0, 0), fix(10_000, vmax * 12)]);
    const beyond = runGate(activity, [fix(0, 0), fix(10_000, vmax * 14)]);
    expect(within.actions).toEqual(['accept', 'accept']);
    expect(beyond.actions).toEqual(['accept', 'pending']);
  });

  it('holds an abrupt reversal instead of accepting a ping-pong edge', () => {
    const result = runGate('drive', [
      fix(0, 0), fix(10_000, -100), fix(20_000, -200), fix(30_000, -120)
    ]);
    expect(result.actions).toEqual(['accept', 'accept', 'accept', 'pending']);
    expect(result.accepted).toHaveLength(3);
  });

  it('does not confirm a relocation after only two mutually consistent fixes', () => {
    const result = runGate('drive', [
      fix(0, 0), fix(10_000, 1_000), fix(20_000, 1_100), fix(30_000, 1_200)
    ]);
    expect(result.actions).toEqual(['accept', 'pending', 'pending', 'confirm']);
    expect(result.accepted).toHaveLength(4);
  });

  it('confirms a relocation using candidate-to-candidate speed after a large jump', () => {
    const result = runGate('drive', [
      fix(0, 0), fix(5_000, 2_000), fix(15_000, 2_100), fix(25_000, 2_200)
    ]);
    expect(result.actions).toEqual(['accept', 'pending', 'pending', 'confirm']);
    expect(result.accepted).toHaveLength(4);
  });

  it('requires a fourth point when speed and heading are both missing', () => {
    const degraded = (t, lon) => ({ ...fix(t, lon, null, null), speed: null, heading: null });
    const result = runGate('drive', [
      fix(0, 0), degraded(10_000, 1_000), degraded(20_000, 1_100),
      degraded(30_000, 1_200), degraded(40_000, 1_300)
    ]);
    expect(result.actions).toEqual(['accept', 'pending', 'pending', 'pending', 'confirm']);
  });

  it('drops a false cluster when the real fix returns to the old anchor', () => {
    const result = runGate('drive', [
      fix(0, 0), fix(10_000, 1_000), fix(20_000, 1_100), fix(30_000, 0)
    ]);
    expect(result.actions).toEqual(['accept', 'pending', 'pending', 'accept']);
    expect(result.accepted.at(-1).lon).toBeCloseTo(120, 8);
  });

  it('still confirms a distant relocation that continues the old heading', () => {
    const result = runGate('drive', [
      fix(0, 0), fix(5_000, 100), fix(10_000, 200), fix(15_000, 300),
      fix(25_000, 1_300), fix(35_000, 1_400), fix(45_000, 1_500)
    ]);
    expect(result.actions.slice(-3)).toEqual(['pending', 'pending', 'confirm']);
    expect(result.accepted).toHaveLength(7);
  });

  it('keeps a coherent false cluster on the recent corridor unconfirmed', () => {
    const history = Array.from({ length: 8 }, (_, i) => fix(i * 5_000, -i * 100, 10, 270));
    const result = runGate('drive', [
      ...history,
      fix(40_000, -100, 10, 90),
      fix(45_000, -200, 10, 270),
      fix(50_000, -300, 10, 270)
    ]);
    expect(result.actions.slice(-3)).toEqual(['pending', 'pending', 'pending']);
  });

  it('uses the conservative auto envelope until activity converges', () => {
    const result = runGate('auto', [fix(0, 0), fix(10_000, 400)]);
    expect(result.actions).toEqual(['accept', 'pending']);
  });
});
