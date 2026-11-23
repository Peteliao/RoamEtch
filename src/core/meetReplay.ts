// Per-sender replay guard for encrypted meetup packets. Sequence numbers are
// strictly monotonic within one session and one device; MQTT and WebSocket both
// preserve publish order on a connection, so a lower or repeated sequence is a
// replay or stale packet and is dropped.
type SequenceState = { max: number; at: number };
export type MeetReplayGuard = Map<string, SequenceState>;

export function acceptMeetSequence(
  guard: MeetReplayGuard,
  senderId: string,
  seq: number,
  now = Date.now()
) {
  if (!senderId || !Number.isSafeInteger(seq) || seq <= 0) return false;
  const state = guard.get(senderId);
  if (!state) {
    guard.set(senderId, { max: seq, at: now });
    return true;
  }
  if (seq <= state.max) return false;
  state.max = seq;
  state.at = now;
  return true;
}

export function pruneMeetReplay(
  guard: MeetReplayGuard,
  activeIds: Set<string>,
  now: number,
  idleMs: number
) {
  for (const [id, state] of guard) {
    if (!activeIds.has(id) && now - state.at > idleMs) guard.delete(id);
  }
}
