import { describe, expect, it } from 'vitest';
import { acceptMeetSequence, pruneMeetReplay, type MeetReplayGuard } from '../src/core/meetReplay';

describe('meetup replay guard', () => {
  it('accepts strictly increasing sequences and rejects repeats or stale packets', () => {
    const guard: MeetReplayGuard = new Map();
    expect(acceptMeetSequence(guard, 'alice', 1)).toBe(true);
    expect(acceptMeetSequence(guard, 'alice', 2)).toBe(true);
    expect(acceptMeetSequence(guard, 'alice', 2)).toBe(false);
    expect(acceptMeetSequence(guard, 'alice', 1)).toBe(false);
    expect(acceptMeetSequence(guard, 'alice', 9)).toBe(true);
    expect(acceptMeetSequence(guard, 'alice', 8)).toBe(false);
  });

  it('keeps independent state per sender and rejects invalid sequence values', () => {
    const guard: MeetReplayGuard = new Map();
    expect(acceptMeetSequence(guard, 'alice', 10)).toBe(true);
    expect(acceptMeetSequence(guard, 'bob', 1)).toBe(true);
    expect(acceptMeetSequence(guard, 'bob', 2)).toBe(true);
    expect(acceptMeetSequence(guard, 'alice', 3)).toBe(false);
    expect(acceptMeetSequence(guard, '', 11)).toBe(false);
    expect(acceptMeetSequence(guard, 'alice', 0)).toBe(false);
    expect(acceptMeetSequence(guard, 'alice', Number.NaN)).toBe(false);
    expect(acceptMeetSequence(guard, 'alice', 1.5)).toBe(false);
  });

  it('prunes replay state only after a sender is inactive long enough', () => {
    const guard: MeetReplayGuard = new Map();
    const now = 1_000_000;
    acceptMeetSequence(guard, 'gone', 1, now - 20_000);
    acceptMeetSequence(guard, 'here', 1, now - 20_000);
    pruneMeetReplay(guard, new Set(['here']), now, 10_000);
    expect(guard.has('gone')).toBe(false);
    expect(guard.has('here')).toBe(true);
  });
});
