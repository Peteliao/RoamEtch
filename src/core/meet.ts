// Live meetup session: ephemeral room, encrypted presence/location exchange,
// peer staleness, host handover hints, meetup routing and 2-hour self-destruct.
import { get, set } from './settings';
import { emit } from './events';
import { t } from './i18n';
import { haversine, bearing } from './geo';
import { meetRoleColor } from './meetVisuals';
import {
  deriveMeetRoom,
  encryptMeetPacket,
  decryptMeetPacket,
  generateMeetInvite,
  meetLinkFor,
  randomMeetId,
  roomLabelFor,
  signMeetInviteExpiry,
  verifyMeetInviteExpiry,
  MEET_PROTOCOL_VERSION,
  MEET_MAX_PACKET_CHARS
} from './meetLink';
import {
  MEET_FEATURE_VERSION,
  MEET_MARKER_MAX_PER_PEER,
  MEET_MARKER_SESSION_MAX,
  MeetSendLimiter,
  SEND_LIMITS,
  alertCooldownElapsed,
  cleanMarkerLabel,
  clampAlertCooldown,
  clampAlertDistance,
  clampMarkerTtl,
  computeMeetSpread,
  goalZoneAfter,
  isMeetMarkerType,
  markerExpired,
  sanitizeMeetGoal,
  sanitizeMeetMarker,
  type MeetGoal,
  type MeetMarker
} from './meetCollab';
import { acceptMeetSequence, pruneMeetReplay } from './meetReplay';
import {
  MEET_PROTOCOL_MIN,
  MEET_PROTOCOL_MAX,
  MEET_VERSION_MIN_FEATURE,
  decodeEpochSecret,
  deriveMeetEpochKey,
  deriveMeetPairwiseKey,
  epochSecretB64,
  generateEpochSecret,
  generateMeetKeyPair,
  importMeetPublicKey,
  meetLocationPlan,
  meetRoomWithKey,
  negotiateMeetProtocol,
  openMeetDirect,
  sealMeetDirect,
  type MeetKeyPair,
  type MeetVisibility
} from './meetKeys';
import { createMeetRelay } from './meetRelay';
import { shouldPublishFix } from './meetCadence';
import { routeOverRoads } from './gapRepair';
import {
  CHAT_IMAGE_COOLDOWN_MS,
  CHAT_IMAGE_KEEP,
  CHAT_IMAGE_MAX_BASE64,
  ORIGINAL_IMAGE_MIMES,
  readLocalImageHeader,
  sanitizeChatImagePacket,
  sha256Hex
} from './chatImage';
import { OriginalImageCache, type CachedOriginalImage } from './originalImageCache';
import { CHAT_VOICE_KEEP, sanitizeChatVoicePacket } from './chatVoice';
import { sanitizeRtcSignal, SignalDeduplicator, RtcSignalRateLimiter } from './rtcSignal';
import { buildIceServers } from './webrtcConfig';
import { P2PTransferError, P2PTransferManager, webrtcAvailable } from './webrtcTransfer';

const STALE_MS = 45_000;
export const MEET_POSITION_TTL_MS = 60_000;
export const MEET_WEAK_GPS_ACCURACY_M = 50;
const WEAK_GPS_TREND_ACCURACY_M = 30;
const WEAK_GPS_TREND_RATIO = 1.5;
const ACCURACY_HISTORY_KEEP = 6;
const REMOVE_MS = 10 * 60_000;
const HEARTBEAT_MS = 20_000;
const PACKET_CLOCK_TOLERANCE_MS = 5 * 60_000;
const MAX_EXPIRY_MIN = 480;
const MAX_INVITE_EXPIRY_MIN = 30 * 24 * 60;
export const MEET_CHAT_MAX_LEN = 500;
const MAX_CHAT_MESSAGES = 120;
const CHAT_SEEN_LIMIT = 240;
const CHAT_RATE_WINDOW_MS = 3_000;
const CHAT_RATE_LIMIT = 6;
const IMAGE_RECEIVE_GAP_MS = CHAT_IMAGE_COOLDOWN_MS - 750;
const RTC_SIGNAL_QUEUE_LIMIT = 64;
const EPOCH_KEY_GRACE_MS = 20_000;
const HELLO_RETRY_MS = 12_000;
const PEER_COLORS = ['#5aa7f0', '#f5b942', '#f26d6d', '#b07cf7', '#f28ac6', '#7ed957', '#ff9e5e', '#45d1c8'];

type MeetSession = any;
type RtcLane = { promise: Promise<boolean>; queued: number; active: boolean };
let session: MeetSession = null;

function createRtcLane(): RtcLane {
  return { promise: Promise.resolve(true), queued: 0, active: true };
}

function invalidateRtcLane(s: MeetSession) {
  const lane = s.rtcLane as RtcLane;
  lane.active = false;
  s.rtcLane = { promise: Promise.resolve(true), queued: 0, active: false };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanName(value: any) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20);
}

function fallbackName() {
  return t('meet.guestName', { n: Math.floor(10 + Math.random() * 90) });
}

function cleanChatText(value: any) {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return Array.from(text).slice(0, MEET_CHAT_MAX_LEN).join('').trim();
}

function rememberChatId(s: MeetSession, id: string) {
  s.chatSeen.add(id);
  while (s.chatSeen.size > CHAT_SEEN_LIMIT) {
    const oldest = s.chatSeen.values().next().value;
    if (!oldest) break;
    s.chatSeen.delete(oldest);
  }
}

function pushChatMessage(s: MeetSession, message: any) {
  s.messages.push(message);
  if (s.messages.length > MAX_CHAT_MESSAGES) s.messages.splice(0, s.messages.length - MAX_CHAT_MESSAGES);
  const images = s.messages.filter((m: any) => m.img);
  for (let i = 0; i < images.length - CHAT_IMAGE_KEEP; i++) {
    const old = images[i];
    if (old.img?.data) old.img = { ...old.img, data: null };
    old.imgExpired = true;
  }
  const voices = s.messages.filter((m: any) => m.voice);
  for (let i = 0; i < voices.length - CHAT_VOICE_KEEP; i++) {
    const old = voices[i];
    if (old.voice?.data) old.voice = { ...old.voice, data: null };
    old.voiceExpired = true;
  }
}

function pushSystemChat(s: MeetSession, code: string, params: any = {}) {
  pushChatMessage(s, {
    id: randomMeetId(),
    sys: code,
    sysParams: params,
    text: '',
    ts: Date.now(),
    self: false
  });
  emit('meet:chat', { unread: s.chatUnread });
}

function announceNewPeer(s: MeetSession, peer: any) {
  publishOwnMarkers();
  if (s.hostId === s.self.id) {
    peer.hostId = s.self.id;
    publishHi();
    publishGoal();
  }
  pushSystemChat(s, 'join', { name: peer.name });
  emit('meet:peerjoined', {
    name: peer.name, id: peer.id,
    legacy: peer.pv < MEET_FEATURE_VERSION
  });
}

function markerKey(by: string, id: string) {
  return `${by}:${id}`;
}

function removePeerMarkers(s: MeetSession, peerId: string) {
  let changed = false;
  for (const [key, marker] of s.markers) {
    if (marker.by === peerId) {
      s.markers.delete(key);
      changed = true;
    }
  }
  if (changed) emitState();
}

function activeMarkers(s: MeetSession, now: number) {
  for (const [key, marker] of s.markers) {
    if (markerExpired(marker, now)) s.markers.delete(key);
  }
  return [...s.markers.values()];
}

function markerRemainingTtl(marker: MeetMarker, now: number) {
  return Math.max(1, Math.ceil((marker.expiresAt - now) / 60_000));
}

function trimPeerMarkers(s: MeetSession, peerId: string) {
  const owned = [...s.markers.entries()]
    .filter(([, marker]) => marker.by === peerId)
    .sort((a, b) => a[1].createdAt - b[1].createdAt);
  for (let i = 0; i < owned.length - MEET_MARKER_MAX_PER_PEER; i++) s.markers.delete(owned[i][0]);
  const all = [...s.markers.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  for (let i = 0; i < all.length - MEET_MARKER_SESSION_MAX; i++) s.markers.delete(all[i][0]);
}

function sendLimitDenied(s: MeetSession, kind: keyof typeof SEND_LIMITS, now: number) {
  const budget = SEND_LIMITS[kind];
  if (s.sendLimiter.allow(kind, now, budget.limit, budget.windowMs)) return false;
  emit('meet:ratelimited', {
    kind,
    retryAfterMs: s.sendLimiter.retryAfter(kind, now, budget.limit, budget.windowMs)
  });
  return true;
}

function chatRateOk(s: MeetSession, peerId: string, now: number) {
  const recent = (s.chatRate.get(peerId) || []).filter((at: number) => now - at < CHAT_RATE_WINDOW_MS);
  if (recent.length >= CHAT_RATE_LIMIT) {
    s.chatRate.set(peerId, recent);
    return false;
  }
  recent.push(now);
  s.chatRate.set(peerId, recent);
  return true;
}

function imageRateOk(s: MeetSession, peerId: string, now: number) {
  const last = s.chatImageRate.get(peerId) || 0;
  if (last && now - last < IMAGE_RECEIVE_GAP_MS) return false;
  s.chatImageRate.set(peerId, now);
  return true;
}

function resolveName(value: any) {
  return cleanName(value) || cleanName(get('meetName')) || fallbackName();
}

function colorFor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PEER_COLORS[h % PEER_COLORS.length];
}

function clampExpiry(min: any) {
  const n = Number(min);
  return Math.min(MAX_EXPIRY_MIN, Math.max(15, isFinite(n) ? n : 120));
}

function expiryMinutes() {
  return clampExpiry(get('meetExpiryMin'));
}

function inviteExpiryMinutes() {
  const n = Number(get('meetInviteExpiryMin'));
  return Math.min(MAX_INVITE_EXPIRY_MIN, Math.max(15, Number.isFinite(n) ? n : 1440));
}

function setMeetFragment(code: string, exp = 0, sig = '') {
  if (typeof location === 'undefined') return;
  const suffix = exp && sig ? `&iexp=${exp}&isig=${sig}` : '';
  const hash = `#meet=${code}${suffix}`;
  if (location.hash !== hash) history.replaceState(history.state || {}, '', location.pathname + location.search + hash);
}

function clearMeetFragment() {
  if (typeof location !== 'undefined' && /[#&]meet=/.test(location.hash)) {
    history.replaceState(history.state || {}, '', location.pathname + location.search);
  }
}

function relayStatus(s: MeetSession) {
  if (s.relayState === 'connected') return 'live';
  if (s.relayState === 'error') return 'error';
  if (s.relayState === 'reconnecting') return 'reconnecting';
  return 'connecting';
}

function validAccuracy(value: any) {
  const n = Number(value);
  return value != null && Number.isFinite(n) && n > 0 ? n : null;
}

function accuracyTrend(history: any[]) {
  if (!Array.isArray(history) || history.length < 3) return false;
  const [first, second, latest] = history.slice(-3);
  return latest.acc >= WEAK_GPS_TREND_ACCURACY_M
    && latest.acc >= first.acc * WEAK_GPS_TREND_RATIO
    && latest.acc > second.acc
    && second.acc > first.acc;
}

function weakGpsReason(acc: number | null, history: any[]) {
  if (acc != null && acc > MEET_WEAK_GPS_ACCURACY_M) return 'accuracy';
  if (accuracyTrend(history)) return 'deteriorating';
  return null;
}

function rememberAccuracy(target: any, acc: number | null, at: number) {
  if (acc == null) return;
  if (!Array.isArray(target.accuracyHistory)) target.accuracyHistory = [];
  target.accuracyHistory.push({ at, acc });
  while (target.accuracyHistory.length > ACCURACY_HISTORY_KEEP) target.accuracyHistory.shift();
}

function observePeerClock(peer: any, ts: number, now: number) {
  const observed = Math.max(-PACKET_CLOCK_TOLERANCE_MS, Math.min(PACKET_CLOCK_TOLERANCE_MS, ts - now));
  if (!Number.isFinite(peer.clockOffsetMs) || observed > peer.clockOffsetMs) peer.clockOffsetMs = observed;
}

function networkStatus(peer: any, now: number) {
  if (peer.left) return 'left';
  return now - peer.lastContactAt > STALE_MS ? 'offline' : 'online';
}

function normalizedFixAt(position: any, now: number) {
  const sampledAt = Number(position.lastFixAt || position.fixAt || 0);
  if (!sampledAt) return 0;
  const corrected = position.fixApprox ? sampledAt : sampledAt - (Number(position.clockOffsetMs) || 0);
  return Math.min(now, Math.max(0, corrected));
}

function fixAge(position: any, now: number) {
  if (!Number(position.lastFixAt || position.fixAt || 0)) return null;
  return Math.max(0, now - normalizedFixAt(position, now));
}

function positionStatus(position: any, now: number, sharing = position.sharing) {
  if (sharing === false) return 'paused';
  if (!position.hasFix && !Number(position.lastFixAt || position.fixAt || 0)) return 'locating';
  if (position.lat == null || position.lon == null) return 'locating';
  if ((fixAge(position, now) ?? Infinity) >= MEET_POSITION_TTL_MS) return 'stale';
  return weakGpsReason(position.acc ?? null, position.accuracyHistory) ? 'weak' : 'fresh';
}

function peerView(p: any, self: any, hostId: string | null, now: number, goal: MeetGoal | null = null, shareTo = true) {
  const distance = self.hasFix && p.lat != null && p.lon != null
    ? haversine(self.lat, self.lon, p.lat, p.lon)
    : null;
  const goalDistance = goal && p.lat != null && p.lon != null
    ? haversine(goal.lat, goal.lon, p.lat, p.lon)
    : null;
  let bearingDeg: number | null = null;
  let clock: number | null = null;
  if (self.hasFix && p.lat != null && p.lon != null) {
    bearingDeg = bearing(self.lat, self.lon, p.lat, p.lon);
    if (self.heading != null && isFinite(self.heading)) {
      const rel = ((bearingDeg - self.heading) % 360 + 360) % 360;
      clock = Math.round(rel / 30) % 12 || 12;
    }
  }
  const contactAge = Math.max(0, now - p.lastContactAt);
  const network = networkStatus(p, now);
  const location = positionStatus(p, now);
  const sampledAge = fixAge(p, now);
  return {
    id: p.id,
    name: p.name,
    color: meetRoleColor(p.id === hostId),
    lat: p.lat,
    lon: p.lon,
    acc: p.acc,
    heading: p.heading,
    speed: p.speed,
    distance,
    goalDistance,
    bearing: bearingDeg,
    clock,
    protocolVersion: Number(p.pv) || 0,
    legacy: false,
    compatible: p.compatible !== false,
    shareTo,
    sharing: p.sharing !== false,
    isHost: p.id === hostId,
    lastContactAt: p.lastContactAt,
    lastLocAt: p.lastLocAt,
    lastFixAt: p.lastFixAt,
    contactAge,
    locAge: p.lastLocAt ? Math.max(0, now - p.lastLocAt) : null,
    fixAge: sampledAge,
    positionUpdatedAt: sampledAge == null ? 0 : normalizedFixAt(p, now),
    fixApprox: !!p.fixApprox,
    networkStatus: network,
    positionStatus: location,
    weakGpsReason: location === 'weak' ? weakGpsReason(p.acc ?? null, p.accuracyHistory) : null,
    left: !!p.left,
    lastSeen: p.lastSeen,
    age: contactAge,
    // Compatibility alias: stale keeps its original network-contact meaning.
    stale: network === 'offline'
  };
}

function selfView(s: MeetSession, now: number, goal: MeetGoal | null = null) {
  const location = positionStatus(s.self, now, s.sharing);
  const sampledAge = fixAge(s.self, now);
  return {
    id: s.self.id,
    name: s.self.name,
    color: meetRoleColor(s.hostId === s.self.id),
    isHost: s.hostId === s.self.id,
    lat: s.self.lat,
    lon: s.self.lon,
    acc: s.self.acc,
    heading: s.self.heading,
    speed: s.self.speed,
    goalDistance: goal && s.self.lat != null && s.self.lon != null
      ? haversine(goal.lat, goal.lon, s.self.lat, s.self.lon)
      : null,
    hasFix: s.self.hasFix,
    fixAt: s.self.fixAt,
    lastFixAt: s.self.fixAt,
    ts: s.self.ts,
    fixAge: sampledAge,
    positionUpdatedAt: sampledAge == null ? 0 : normalizedFixAt(s.self, now),
    positionStatus: location,
    weakGpsReason: location === 'weak' ? weakGpsReason(s.self.acc ?? null, s.self.accuracyHistory) : null,
    networkStatus: s.relayState === 'connected' ? 'online' : 'offline'
  };
}

export function getMeetSnapshot() {
  const s = session;
  if (!s) {
    return {
      active: false,
      status: 'idle',
      protocol: MEET_PROTOCOL_VERSION,
      code: '',
      invite: '',
      codeDisplay: '',
      roomLabel: '',
      link: '',
      peers: [],
      self: null,
      route: null,
      messages: [],
      markers: [],
      goal: null,
      spread: null,
      lastAlert: null,
      inviteExpiresAt: 0,
      inviteExpired: false,
      chatUnread: 0,
      expiresAt: 0,
      keyEpoch: 0,
      protocolMin: MEET_PROTOCOL_MIN,
      protocolMax: MEET_PROTOCOL_MAX,
      updateRequired: false,
      incompatiblePeers: [],
      peerVisibility: {},
      sharing: false,
      now: Date.now()
    };
  }
  const now = Date.now();
  const goal: MeetGoal | null = s.goal ? { ...s.goal } : null;
  const self = selfView(s, now, goal);
  const peers = [...s.peers.values()].map((p) => peerView(
    p, self, s.hostId, now, goal, s.peerVisibility.get(p.id) !== 'hidden'
  ));
  const peerRank = (p: any) => p.networkStatus === 'left' ? 3 : p.stale ? 2 : p.positionStatus === 'fresh' ? 0 : 1;
  peers.sort((a, b) => peerRank(a) - peerRank(b) || (a.distance ?? Infinity) - (b.distance ?? Infinity));
  const markers = activeMarkers(s, now)
    .map((m) => ({
      ...m,
      byName: m.by === s.self.id ? s.self.name : (s.peers.get(m.by)?.name || t('meet.unnamedPeer')),
      mine: m.by === s.self.id,
      remainingMs: Math.max(0, m.expiresAt - now),
      distance: s.self.hasFix ? haversine(s.self.lat, s.self.lon, m.lat, m.lon) : null
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const goalView = goal ? {
    ...goal,
    mine: goal.by === s.self.id,
    byName: goal.by === s.self.id ? s.self.name : (s.peers.get(goal.by)?.name || t('meet.unnamedPeer')),
    distance: self.goalDistance
  } : null;
  const spread = computeMeetSpread([
    ...(self.hasFix && self.positionStatus === 'fresh' ? [self] : []),
    ...peers.filter((p) => p.networkStatus !== 'left' && p.positionStatus === 'fresh')
  ]);
  const incompatiblePeers = [...s.incompatiblePeers.values()].map((entry: any) => ({ ...entry }));
  const updateRequired = incompatiblePeers.some((entry: any) => entry.updateRequired);
  return {
    active: true,
    status: relayStatus(s),
    protocol: MEET_PROTOCOL_VERSION,
    relayState: s.relayState,
    relayError: s.relayError,
    code: s.invite,
    invite: s.invite,
    codeDisplay: s.roomLabel,
    roomLabel: s.roomLabel,
    link: s.link,
    roomId: s.roomId,
    self,
    peers,
    messages: s.messages.map((m: any) => ({ ...m })),
    markers,
    goal: goalView,
    spread,
    legacyPeers: peers.filter((p) => p.legacy && p.networkStatus !== 'left').length,
    lastAlert: s.lastAlert,
    inviteExpiresAt: s.inviteExpiresAt || 0,
    inviteExpired: !!s.inviteExpiresAt && now >= s.inviteExpiresAt,
    chatUnread: s.chatUnread,
    hostId: s.hostId,
    isHost: s.hostId === s.self.id,
    keyEpoch: s.keyEpoch,
    protocolMin: MEET_PROTOCOL_MIN,
    protocolMax: MEET_PROTOCOL_MAX,
    updateRequired,
    security: {
      epoch: s.keyEpoch,
      rotated: s.keyEpoch > 0,
      hiddenPeers: [...s.peerVisibility.values()].filter((v) => v === 'hidden').length,
      incompatiblePeers: s.incompatiblePeers.size,
      updateRequired
    },
    incompatiblePeers,
    peerVisibility: Object.fromEntries(s.peerVisibility),
    sharing: s.sharing,
    geoError: s.geoError,
    alerts: {
      enabled: get('meetAlertEnabled') !== false,
      distance: clampAlertDistance(get('meetAlertDistance')),
      cooldownMin: clampAlertCooldown(get('meetAlertCooldownMin')),
      goal: get('meetAlertGoal') !== false
    },
    startedAt: s.startedAt,
    expiresAt: s.expiresAt,
    now,
    route: s.route ? {
      peerId: s.route.peerId,
      coords: s.route.coords,
      distance: s.route.distance,
      provider: s.route.provider,
      loading: false
    } : s.routeLoading ? { loading: true, peerId: s.routeLoading } : null
  };
}

function emitState() {
  emit('meet:state', getMeetSnapshot());
}

function emitSelf() {
  emit('meet:self', getMeetSnapshot());
}

function currentSession() {
  return session;
}

function startWatch() {
  const s = session;
  if (!s) return;
  stopWatch();
  if (!navigator.geolocation) {
    s.geoError = 'unavailable';
    emitState();
    return;
  }
  try {
    s.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (session !== s) return;
        applyFix(pos.coords, pos.timestamp);
      },
      (err) => {
        if (session !== s) return;
        s.geoError = err?.code === 1 ? 'denied' : err?.code === 2 ? 'unavailable' : 'timeout';
        emitState();
      },
      { enableHighAccuracy: true, maximumAge: 2500, timeout: 20000 }
    );
  } catch {
    s.geoError = 'unavailable';
    emitState();
  }
}

function stopWatch() {
  if (session?.watchId != null) {
    try { navigator.geolocation?.clearWatch(session.watchId); } catch { /* ignore */ }
    session.watchId = null;
  }
}

function applyFix(coords: any, timestamp?: number) {
  const s = session;
  if (!s || !coords) return;
  const hadFix = s.self.hasFix;
  const hadGeoError = !!s.geoError;
  const previousStatus = positionStatus(s.self, Date.now(), s.sharing);
  const lat = Number(coords.latitude);
  const lon = Number(coords.longitude);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
  const heading = coords.heading != null && isFinite(coords.heading) ? Number(coords.heading) : null;
  const speed = coords.speed != null && isFinite(coords.speed) ? Number(coords.speed) : null;
  const acc = validAccuracy(coords.accuracy);
  const now = Date.now();
  const suppliedAt = Number(timestamp);
  const sampleAt = Number.isFinite(suppliedAt) && suppliedAt > 0 ? suppliedAt : now;
  if (s.self.hasFix && sampleAt <= s.self.fixAt) return;
  s.self = {
    ...s.self,
    lat, lon, acc, heading, speed,
    hasFix: true,
    fixAt: sampleAt,
    lastFixAt: sampleAt,
    ts: sampleAt,
    fixApprox: false
  };
  rememberAccuracy(s.self, acc, sampleAt);
  s.geoError = null;
  s.lastFix = { lat, lon, at: sampleAt };
  emitSelf();
  if (!hadFix || hadGeoError || previousStatus !== positionStatus(s.self, now, s.sharing)) emitState();
  maybePublishFix(lat, lon, now);
}

export function injectMeetFix(fix: any) {
  if (!session) return false;
  applyFix({
    latitude: fix.lat,
    longitude: fix.lon,
    accuracy: fix.acc ?? 8,
    heading: fix.heading ?? null,
    speed: fix.speed ?? null
  }, fix.ts);
  return true;
}

function maybePublishFix(lat: number, lon: number, now: number) {
  const s = session;
  if (!s || !s.sharing) return;
  if (!shouldPublishFix(s.lastPublish, lat, lon, now, s.self.speed)) return;
  s.lastPublish = { lat, lon, at: now };
  publishLoc();
}

function startRelay() {
  const s = session;
  if (!s) return;
  const relayGen = ++s.relayGen;
  s.relayState = 'connecting';
  s.relayError = null;
  const relay = createMeetRelay(s.roomId, {
    onMessage: (text) => {
      if (session !== s || s.relayGen !== relayGen) return;
      handleIncoming(text);
    },
    onState: (state, detail) => {
      if (session !== s || s.relayGen !== relayGen) return;
      s.relayState = state;
      if (state === 'error') {
        s.relayError = detail?.reason || 'relay';
      } else if (state === 'connected') {
        s.relayError = null;
        if (s.hostId === s.self.id) publishHi();
        else if (s.keyEpoch > 0) sendPresence();
        else publishHello();
      }
      emitState();
    }
  });
  s.relay = relay;
}

function publishPacket(body: any, lane: 'critical' | 'rtc' = 'critical', options: { room?: any } = {}) {
  const s = session;
  if (!s) return Promise.resolve(false);
  const rtcLane = s.rtcLane as RtcLane;
  const privacyReject = body.typ === 'pull-reject' && body.p?.reason === 'privacy-disabled';
  if (lane === 'rtc' && (s.leaving || (!privacyReject && (s.p2pStopped || get('meetP2PEnabled') !== true))
    || !rtcLane.active || rtcLane.queued >= RTC_SIGNAL_QUEUE_LIMIT)) return Promise.resolve(false);
  if (lane === 'rtc') rtcLane.queued++;
  const epoch = s.epoch;
  const room = options.room || s.room;
  const previous = lane === 'rtc' ? rtcLane.promise : s.sendChain;
  const rtcCurrent = () => rtcLane.active && s.rtcLane === rtcLane;
  const job = previous.then(async () => {
    if (session !== s || s.epoch !== epoch || !s.relay || (lane === 'rtc' && !rtcCurrent())) return false;
    const relay = s.relay;
    try {
      const seq = ++s.sendSeq;
      if (!Number.isSafeInteger(seq)) return false;
      const packet = { ...body, v: MEET_PROTOCOL_VERSION, sq: seq, ts: Date.now() };
      const text = await encryptMeetPacket(packet, room);
      if (text.length > MEET_MAX_PACKET_CHARS) return false;
      if (session !== s || s.epoch !== epoch || s.relay !== relay || (lane === 'rtc' && !rtcCurrent())) return false;
      return relay.send(text);
    } catch {
      return false;
    }
  }).catch(() => false).finally(() => {
    if (lane === 'rtc') rtcLane.queued--;
  });
  if (lane === 'rtc') rtcLane.promise = job;
  else s.sendChain = job;
  return job;
}

function startP2P(s: MeetSession) {
  s.p2p = new P2PTransferManager({
    selfId: s.self.id,
    enabled: () => session === s && get('meetP2PEnabled') === true,
    iceServers: () => buildIceServers({
      stun: get('meetStun'),
      turnUrl: get('meetTurnUrl'),
      turnUser: get('meetTurnUser'),
      turnPass: get('meetTurnPass')
    }),
    publish: (signal) => session === s ? publishPacket({
      k: 'rtc', id: s.self.id, to: signal.toPeerId, mid: signal.msgId,
      sid: signal.sessionId, typ: signal.type, p: signal.payload
    }, 'rtc') : Promise.resolve(false),
    getOriginal: (fileId) => s.imageCache.get(fileId),
    onProgress: ({ peerId, fileId, sha256, progress }) => {
      if (session === s) emit('meet:p2p', { type: 'progress', peerId, fileId, sha256, progress });
    },
    onError: ({ peerId, fileId, sha256, code }) => {
      if (session === s) emit('meet:p2p', { type: 'error', peerId, fileId, sha256, code });
    }
  });
}

async function prepareOriginalImage(input: any): Promise<CachedOriginalImage | null> {
  const blob = input?.original;
  if (!(blob instanceof Blob)) return null;
  const header = await readLocalImageHeader(blob);
  if (!header || !ORIGINAL_IMAGE_MIMES.includes(header.mime)) return null;
  const mime = String(input?.originalMime || blob.type || header.mime);
  if (mime !== header.mime) return null;
  if (input?.originalWidth != null && Number(input.originalWidth) !== header.width) return null;
  if (input?.originalHeight != null && Number(input.originalHeight) !== header.height) return null;
  const sha256 = await sha256Hex(await blob.arrayBuffer());
  return {
    fileId: randomMeetId(),
    sha256,
    size: blob.size,
    mime,
    width: header.width,
    height: header.height,
    blob,
    createdAt: Date.now(),
    lastUsed: Date.now()
  };
}

function hiPacket() {
  const s = session;
  const body: any = {
    k: 'hi', id: s.self.id, name: s.self.name,
    c: s.self.color, hostId: s.hostId || undefined,
    ep: s.keyEpoch,
    ...protocolFields(s)
  };
  if (s.hostId === s.self.id) {
    body.exp = s.expiresAt;
    if (s.inviteExpiresAt && s.inviteSig) {
      body.iexp = s.inviteExpiresAt;
      body.isig = s.inviteSig;
    }
  }
  return body;
}

function publishHi() {
  const s = session;
  if (!s) return Promise.resolve(false);
  if (s.hostId !== s.self.id && s.keyEpoch === 0) return Promise.resolve(false);
  return publishPacket(hiPacket());
}

function helloPacket() {
  const s = session;
  return {
    k: 'hello', id: s.self.id, name: s.self.name,
    c: s.self.color, hostId: s.hostId || undefined,
    ep: s.keyEpoch,
    ...protocolFields(s)
  };
}

function publishHello() {
  const s = session;
  if (!s || s.hostId === s.self.id) return Promise.resolve(false);
  s.lastHelloAt = Date.now();
  return publishPacket(helloPacket(), 'critical', { room: s.baseRoom });
}

function publishLoc() {
  const s = session;
  if (!s || !s.self.hasFix) return Promise.resolve(false);
  return publishPositional({
    k: 'loc', id: s.self.id, name: s.self.name, c: s.self.color,
    la: s.self.lat, lo: s.self.lon, ac: s.self.acc,
    hd: s.self.heading, sp: s.self.speed, sh: s.sharing,
    ft: s.self.fixAt
  });
}

function publishState() {
  const s = session;
  if (!s) return Promise.resolve(false);
  return publishPacket({
    k: 'st', id: s.self.id, name: s.self.name,
    c: s.self.color, sh: s.sharing
  });
}

function publishGoal() {
  const s = session;
  if (!s || s.hostId !== s.self.id) return Promise.resolve(false);
  if (!s.goal) return publishPositional({ k: 'goal', id: s.self.id, del: true });
  return publishPositional({
    k: 'goal', id: s.self.id,
    la: s.goal.lat, lo: s.goal.lon, tx: s.goal.label
  });
}

function publishOwnMarkers() {
  const s = session;
  if (!s) return;
  const now = Date.now();
  for (const marker of activeMarkers(s, now)) {
    if (marker.by !== s.self.id) continue;
    void publishPositional({
      k: 'mk', id: s.self.id,
      mkid: marker.id, mtyp: marker.type,
      la: marker.lat, lo: marker.lon, tx: marker.label,
      ttl: markerRemainingTtl(marker, now)
    });
  }
}

function sendPresence() {
  const s = session;
  if (!s) return;
  if (s.hostId !== s.self.id && s.keyEpoch === 0) {
    publishHello();
    return;
  }
  publishHi();
  if (s.hostId === s.self.id) publishGoal();
  publishOwnMarkers();
  if (s.sharing && s.self.hasFix) {
    s.lastPublish = { lat: s.self.lat, lon: s.self.lon, at: Date.now() };
    publishLoc();
  } else {
    publishState();
  }
}

function touchPeer(msg: any, now: number, ts: number) {
  const s = session;
  if (!s) return null;
  const id = String(msg.id || '').slice(0, 40);
  if (!id || id === s.self.id) return null;
  let p = s.peers.get(id);
  const isNew = !p;
  if (!p) {
    p = {
      id,
      name: cleanName(msg.name) || t('meet.unnamedPeer'),
      color: /^#[0-9a-f]{6}$/i.test(String(msg.c)) ? msg.c : colorFor(id),
      lat: null, lon: null, acc: null, heading: null, speed: null,
      sharing: true, ts: 0, lastSeen: 0, lastContactAt: 0, lastLocAt: 0,
      lastFixAt: 0, fixApprox: false, clockOffsetMs: null,
      left: false, leftAt: 0, accuracyHistory: [], viewState: '',
      hostId: null, locSeq: 0, hiSeq: 0, stateSeq: 0, pv: 0,
      pk: '', pairwise: null, compatible: false, joined: false, invitedEpoch: 0
    };
    s.peers.set(id, p);
  }
  if (msg.name) p.name = cleanName(msg.name) || p.name;
  if (/^#[0-9a-f]{6}$/i.test(String(msg.c))) p.color = msg.c;
  if (msg.pv != null) p.pv = Math.max(0, Math.min(99, Math.round(Number(msg.pv)) || 0));
  const pk = typeof msg.pk === 'string' ? msg.pk : '';
  if (pk && /^[A-Za-z0-9_-]{87}$/.test(pk)) {
    if (p.pk !== pk) p.pairwise = null;
    p.pk = pk;
  }
  observePeerClock(p, ts, now);
  p.lastContactAt = now;
  p.lastSeen = now;
  return { peer: p, isNew };
}

function noteReplayContact(msg: any, now: number) {
  if (!['hi', 'loc', 'st', 'msg'].includes(msg.k)) return;
  const s = session;
  const peer = s?.peers.get(String(msg.id || '').slice(0, 40));
  if (!s || !peer || peer.left) return;
  const wasOffline = networkStatus(peer, now) === 'offline';
  peer.lastContactAt = now;
  peer.lastSeen = now;
  if (msg.k === 'loc') peer.lastLocAt = now;
  if (wasOffline) emitState();
}

function markPeerLeft(s: MeetSession, id: string, now: number) {
  const peer = s.peers.get(id);
  if (!peer) return false;
  peer.left = true;
  peer.leftAt = now;
  peer.joined = false;
  s.p2p?.closePeer(id);
  s.peerVisibility.delete(id);
  if (s.hostId === id) s.hostId = null;
  if (s.route?.peerId === id) s.route = null;
  s.alertNear.delete(id);
  for (const [key, marker] of s.markers) {
    if (marker.by === id) s.markers.delete(key);
  }
  return true;
}

function protocolFields(s: MeetSession) {
  return {
    pv: MEET_FEATURE_VERSION,
    pmin: MEET_PROTOCOL_MIN,
    pmax: MEET_PROTOCOL_MAX,
    pk: s.keyPair.publicB64
  };
}

function securityVerdict(msg: any) {
  const proto = negotiateMeetProtocol(msg?.pmin, msg?.pmax, msg?.pv);
  if (proto.ok === false) return proto;
  const feature = Math.round(Number(msg?.pv));
  if (!Number.isFinite(feature) || feature < MEET_VERSION_MIN_FEATURE) {
    return { ok: false as const, reason: 'old' as const, peerMin: proto.version, peerMax: proto.version };
  }
  if (!msg?.pk || typeof msg.pk !== 'string') {
    return { ok: false as const, reason: 'missing' as const, peerMin: proto.version, peerMax: proto.version };
  }
  return proto;
}

function rejectIncomingPeer(s: MeetSession, msg: any, verdict: any) {
  const id = String(msg.id || '').slice(0, 40);
  if (!id || id === s.self.id || s.revoked.has(id)) return;
  const existing = s.incompatiblePeers.get(id);
  if (!existing) {
    const name = cleanName(msg.name) || t('meet.unnamedPeer');
    s.incompatiblePeers.set(id, {
      id, name, reason: verdict.reason,
      peerVersion: Number.isFinite(Number(verdict.peerMin)) ? Number(verdict.peerMin) : null,
      updateRequired: verdict.reason === 'protocol' || verdict.reason === 'old' || verdict.reason === 'new'
    });
    pushSystemChat(s, 'incompatible', { name });
    emit('meet:incompatible', { id, name, reason: verdict.reason });
    emitState();
  }
  void publishPacket({
    k: 'reject', id: s.self.id, to: id, reason: 'protocol',
    need: [MEET_PROTOCOL_MIN, MEET_PROTOCOL_MAX, MEET_VERSION_MIN_FEATURE]
  }, 'critical', { room: s.baseRoom });
}

async function ensurePairwise(s: MeetSession, peer: any) {
  if (!peer) return null;
  if (peer.pairwise) return peer.pairwise;
  if (!peer.pk) return null;
  try {
    const publicKey = await importMeetPublicKey(peer.pk);
    if (!publicKey) return null;
    const key = await deriveMeetPairwiseKey(
      s.keyPair.privateKey, publicKey, s.roomId, s.self.id, peer.id
    );
    if (session !== s) return null;
    peer.pairwise = key;
    return key;
  } catch {
    return null;
  }
}

async function installEpoch(s: MeetSession, epoch: number, secretText: any, reason: string) {
  if (!s || !Number.isSafeInteger(epoch) || epoch <= s.keyEpoch) return false;
  const secret = decodeEpochSecret(secretText);
  if (!secret) return false;
  let key: CryptoKey;
  try {
    key = await deriveMeetEpochKey(s.roomId, epoch, secret);
  } catch {
    return false;
  }
  if (session !== s) return false;
  s.previousKeys.push({ epoch: s.keyEpoch, key: s.room.key, until: Date.now() + EPOCH_KEY_GRACE_MS });
  s.previousKeys = s.previousKeys.slice(-3);
  s.keyEpoch = epoch;
  s.epochSecret = secretText;
  s.room = meetRoomWithKey(s.room, key);
  s.secretEpoch = Math.max(s.secretEpoch || 0, epoch);
  emit('meet:security', { type: 'rotated', epoch, reason });
  emitState();
  await publishHi();
  return true;
}

async function rotateEpoch(s: MeetSession, reason: string) {
  if (!s || s.hostId !== s.self.id || s.leaving) return false;
  if (s.rotating) {
    s.rotateQueued = true;
    return false;
  }
  s.rotating = true;
  const gen = s.epoch;
  try {
    do {
      s.rotateQueued = false;
      if (session !== s || s.epoch !== gen || s.hostId !== s.self.id || s.leaving) break;
      const active = [...s.peers.values()].filter((p) => !p.left && !s.revoked.has(p.id)
        && p.compatible && p.pk);
      const epoch = s.keyEpoch + 1;
      if (!active.length) {
        await installEpoch(s, epoch, epochSecretB64(generateEpochSecret()), reason);
        break;
      }
      const secret = generateEpochSecret();
      const secretText = epochSecretB64(secret);
      const roster = [s.self.id, ...active.map((p) => p.id)];
      for (const peer of active) {
        const pairwise = await ensurePairwise(s, peer);
        if (!pairwise || session !== s) continue;
        let box: string;
        try {
          box = await sealMeetDirect(pairwise, {
            k: 'rekey', ep: epoch, sec: secretText, ids: roster, hostId: s.self.id
          });
        } catch {
          continue;
        }
        const sent = await publishPacket({
          k: 'dm', id: s.self.id, to: peer.id, box,
          name: s.self.name, c: s.self.color, hostId: s.self.id,
          ...protocolFields(s)
        }, 'critical', { room: peer.joined ? s.room : s.baseRoom });
        if (sent) {
          peer.joined = true;
          peer.invitedEpoch = epoch;
        }
      }
      if (session !== s || s.epoch !== gen) break;
      const ok = await installEpoch(s, epoch, secretText, reason);
      if (ok) {
        for (const [id] of s.peers) if (s.revoked.has(id)) s.peers.delete(id);
        sendPresence();
        emitState();
      }
    } while (s.rotateQueued && session === s);
    return true;
  } finally {
    s.rotating = false;
  }
}

async function sendWelcome(s: MeetSession, peer: any) {
  if (!s.epochSecret || s.keyEpoch <= 0) return false;
  const pairwise = await ensurePairwise(s, peer);
  if (!pairwise || session !== s) return false;
  const roster = [s.self.id, ...activeSharingPeers(s).map((p) => p.id)];
  let box: string;
  try {
    box = await sealMeetDirect(pairwise, {
      k: 'rekey', ep: s.keyEpoch, sec: s.epochSecret, ids: roster, hostId: s.self.id
    });
  } catch {
    return false;
  }
  const sent = await publishPacket({
    k: 'dm', id: s.self.id, to: peer.id, box,
    name: s.self.name, c: s.self.color, hostId: s.self.id,
    ...protocolFields(s)
  }, 'critical', { room: peer.joined ? s.room : s.baseRoom });
  if (sent) {
    peer.joined = true;
    peer.invitedEpoch = s.keyEpoch;
  }
  return sent;
}

function electHost(s: MeetSession, now: number) {
  if (s.hostId) return;
  const candidates = [
    { id: s.self.id, name: s.self.name },
    ...activeSharingPeers(s).map((p) => ({ id: p.id, name: p.name }))
  ].sort((a, b) => a.id.localeCompare(b.id));
  const winner = candidates[0];
  if (!winner) return;
  s.hostId = winner.id;
  for (const p of s.peers.values()) p.hostId = winner.id;
  if (winner.id === s.self.id) {
    pushSystemChat(s, 'hostChanged', { name: s.self.name });
    void rotateEpoch(s, 'host-elected');
  } else {
    pushSystemChat(s, 'hostChanged', { name: winner.name });
    emit('meet:security', { type: 'host', hostId: winner.id, at: now });
  }
  emitState();
}

function activeSharingPeers(s: MeetSession) {
  return [...s.peers.values()].filter((p) => !p.left && !s.revoked.has(p.id)
    && p.compatible && p.joined);
}

async function publishDirect(s: MeetSession, peer: any, body: any) {
  if (!peer || peer.left || s.revoked.has(peer.id)) return false;
  const pairwise = await ensurePairwise(s, peer);
  if (!pairwise || session !== s) return false;
  let box: string;
  try {
    box = await sealMeetDirect(pairwise, body);
  } catch {
    return false;
  }
  return publishPacket({
    k: 'dm', id: s.self.id, to: peer.id, box,
    name: s.self.name, c: s.self.color, hostId: s.hostId || undefined,
    ...protocolFields(s)
  });
}

/** Broadcast while every peer is visible; otherwise send pairwise to visible peers only. */
async function publishPositional(body: any) {
  const s = session;
  if (!s) return false;
  const active = activeSharingPeers(s);
  if (!active.length) return publishPacket(body);
  const visibility = new Map<string, MeetVisibility>(active.map((p) => [
    p.id, s.peerVisibility.get(p.id) === 'hidden' ? 'hidden' : 'full'
  ]));
  const ready = new Set(active.filter((p) => p.pairwise).map((p) => p.id));
  const plan = meetLocationPlan(active.map((p) => p.id), visibility, ready);
  if (plan.mode === 'broadcast') return publishPacket(body);
  if (plan.mode === 'none') return false;
  let sent = false;
  for (const id of plan.targets) {
    const peer = s.peers.get(id);
    if (peer && await publishDirect(s, peer, body)) sent = true;
  }
  return sent;
}

async function processPeerLocation(s: MeetSession, msg: any, now: number, ts: number, senderId: string) {
  const lat = Number(msg.la);
  const lon = Number(msg.lo);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
  let sampleAt = ts;
  let fixApprox = true;
  if (msg.ft != null) {
    const ft = Number(msg.ft);
    if (!Number.isSafeInteger(ft) || ft <= 0 || ft > ts + 1000) return;
    sampleAt = ft;
    fixApprox = false;
  }
  const touched = touchPeer(msg, now, ts);
  if (!touched) return;
  const p = touched.peer;
  if (p.left) return;
  const seq = Number(msg.sq);
  if (!Number.isSafeInteger(seq)) return;
  if (p.locSeq && seq <= p.locSeq) return;
  p.locSeq = seq;
  p.lastLocAt = now;
  p.ts = ts;
  p.joined = true;
  if (s.hostId === s.self.id) p.hostId = s.self.id;
  if (p.lastFixAt && sampleAt <= p.lastFixAt) {
    if (touched.isNew) announceNewPeer(s, p);
    emitState();
    return;
  }
  p.lat = lat;
  p.lon = lon;
  p.acc = validAccuracy(msg.ac);
  p.heading = msg.hd != null && isFinite(Number(msg.hd)) ? Number(msg.hd) : null;
  p.speed = msg.sp != null && isFinite(Number(msg.sp)) ? Number(msg.sp) : null;
  p.sharing = msg.sh !== false;
  p.lastFixAt = sampleAt;
  p.fixApprox = fixApprox;
  rememberAccuracy(p, p.acc, sampleAt);
  if (touched.isNew) announceNewPeer(s, p);
  emitState();
}

function processPeerMarker(s: MeetSession, msg: any, now: number, senderId: string) {
  const peer = s.peers.get(senderId);
  if (!peer || peer.left) return;
  const mkid = String(msg.mkid || '');
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(mkid)) return;
  const key = markerKey(senderId, mkid);
  if (msg.del) {
    if (s.markers.delete(key)) {
      emit('meet:marker', { action: 'delete', id: mkid, by: senderId });
      emitState();
    }
    return;
  }
  const candidate = sanitizeMeetMarker(msg, now);
  if (!candidate) return;
  const existing = s.markers.get(key);
  if (existing) {
    existing.label = candidate.label;
    existing.expiresAt = Math.min(existing.expiresAt, candidate.expiresAt);
    existing.updatedAt = now;
  } else {
    s.markers.set(key, {
      ...candidate,
      by: senderId,
      byName: peer.name
    } as any);
    trimPeerMarkers(s, senderId);
    emit('meet:marker', { action: 'add', marker: { ...s.markers.get(key) } });
  }
  emitState();
}

function processPeerGoal(s: MeetSession, msg: any, now: number, senderId: string) {
  if (senderId !== s.hostId) return;
  if (msg.del) {
    if (!s.goal) return;
    s.goal = null;
    s.alertNear.clear();
    pushSystemChat(s, 'goalCleared', { name: s.peers.get(senderId)?.name || t('meet.hostBadge') });
    emit('meet:goal', { action: 'clear', by: senderId });
    emitState();
    return;
  }
  const goal = sanitizeMeetGoal(msg, now);
  if (!goal) return;
  s.goal = { ...goal, by: senderId };
  s.alertNear.clear();
  pushSystemChat(s, 'goalSet', {
    name: s.peers.get(senderId)?.name || t('meet.hostBadge'),
    label: goal.label || t('meet.goalDefault')
  });
  emit('meet:goal', { action: 'set', goal: { ...s.goal }, by: s.goal.by });
  emitState();
}

async function handleDirectPacket(s: MeetSession, msg: any, now: number, ts: number, senderId: string) {
  if (String(msg.to || '') !== s.self.id || s.leaving) return;
  const verdict = securityVerdict(msg);
  if (verdict.ok === false) {
    rejectIncomingPeer(s, msg, verdict);
    return;
  }
  const touched = touchPeer(msg, now, ts);
  if (!touched) return;
  const peer = touched.peer;
  const pairwise = await ensurePairwise(s, peer);
  if (!pairwise || session !== s) return;
  const inner = await openMeetDirect(pairwise, msg.box);
  if (!inner || typeof inner.k !== 'string' || session !== s) return;
  if (inner.k === 'rekey') {
    const ep = Number(inner.ep);
    const hostOk = senderId === s.hostId
      || (!s.hostId && (String(msg.hostId || '') === senderId || String(inner.hostId || '') === senderId));
    if (!hostOk || !Number.isSafeInteger(ep) || ep <= s.keyEpoch) return;
    if (!s.hostId) s.hostId = senderId;
    peer.joined = true;
    peer.hostId = senderId;
    const installed = await installEpoch(s, ep, inner.sec, senderId === s.self.id ? 'host' : 'welcome');
    if (installed) {
      for (const p of s.peers.values()) if (p.hostId !== senderId) p.hostId = senderId;
      if (touched.isNew) announceNewPeer(s, peer);
      sendPresence();
      emitState();
    }
    return;
  }
  if (!peer.joined && s.keyEpoch > 0) return;
  if (inner.k === 'loc') {
    processPeerLocation(s, {
      ...inner, id: senderId, name: peer.name, c: peer.color, sq: msg.sq, ts: msg.ts
    }, now, ts, senderId);
    return;
  }
  if (inner.k === 'mk') {
    processPeerMarker(s, { ...inner, id: senderId }, now, senderId);
    return;
  }
  if (inner.k === 'goal') {
    processPeerGoal(s, { ...inner, id: senderId }, now, senderId);
  }
}

async function handleIncoming(text: string) {
  const s = session;
  if (!s) return;
  const epoch = s.epoch;
  const room = s.room;
  const altKeys = [
    s.baseRoom.key,
    ...s.previousKeys.filter((entry: any) => Date.now() < entry.until).map((entry: any) => entry.key)
  ];
  const msg = await decryptMeetPacket(text, room, altKeys);
  if (session !== s || s.epoch !== epoch || !msg || typeof msg.k !== 'string') return;
  const now = Date.now();
  const ts = Number(msg.ts);
  if (!isFinite(ts) || Math.abs(now - ts) > PACKET_CLOCK_TOLERANCE_MS) return;
  const senderId = String(msg.id || '').slice(0, 40);
  if (!senderId || senderId === s.self.id || s.revoked.has(senderId)) return;
  if (msg.v !== MEET_PROTOCOL_VERSION) {
    if (!s.legacyNotices.has(senderId)) {
      s.legacyNotices.add(senderId);
      const name = cleanName(msg.name) || t('meet.unnamedPeer');
      s.incompatiblePeers.set(senderId, {
        id: senderId, name, reason: 'protocol',
        peerVersion: Number.isFinite(Number(msg.v)) ? Number(msg.v) : null,
        updateRequired: true
      });
      pushSystemChat(s, 'incompatible', { name });
      emit('meet:incompatible', { id: senderId, name, reason: 'protocol' });
      emitState();
    }
    return;
  }
  if (msg.k === 'hi' || msg.k === 'hello') {
    const verdict = securityVerdict(msg);
    if (verdict.ok === false) {
      rejectIncomingPeer(s, msg, verdict);
      return;
    }
  }
  if (msg.k === 'rtc') {
    if (s.leaving) return;
    const signal = sanitizeRtcSignal(msg, s.self.id, now);
    if (!signal || !s.rtcSeen.accept(signal.fromPeerId, signal.msgId, now)) return;
    if (!s.rtcRate.accept(signal.fromPeerId, now)) return;
    void s.p2p.handleSignal(signal).catch(() => undefined);
    return;
  }
  // Presence carries its own hiSeq ordering; skipping the session guard lets a
  // freshly admitted peer start its location stream at 1 after hello.
  if (msg.k !== 'hi' && !acceptMeetSequence(s.replay, senderId, Number(msg.sq), now)) {
    noteReplayContact(msg, now);
    return;
  }

  if (msg.k === 'dm') {
    await handleDirectPacket(s, msg, now, ts, senderId);
    return;
  }

  if (msg.k === 'reject') {
    if (String(msg.to || '') !== s.self.id) return;
    const byHost = senderId === s.hostId;
    emit('meet:incompatible', {
      id: senderId, name: cleanName(msg.name) || t('meet.unnamedPeer'),
      reason: String(msg.reason || 'protocol'), byHost
    });
    if (byHost) await leaveMeet('incompatible');
    return;
  }

  if (msg.k === 'closed') {
    if (senderId !== s.hostId) return;
    await leaveMeet('room-closed');
    return;
  }

  if (msg.k === 'hello') {
    if (s.leaving) return;
    const touched = touchPeer(msg, now, ts);
    if (!touched) return;
    s.incompatiblePeers.delete(senderId);
    const peer = touched.peer;
    const wasLeft = peer.left;
    peer.left = false;
    peer.leftAt = 0;
    peer.compatible = true;
    peer.joined = false;
    if (s.hostId === s.self.id) {
      if (touched.isNew || wasLeft) announceNewPeer(s, peer);
      if (s.rotating) return;
      if (peer.invitedEpoch === s.keyEpoch && s.keyEpoch > 0) await sendWelcome(s, peer);
      else await rotateEpoch(s, 'join');
    } else if (touched.isNew || wasLeft) {
      announceNewPeer(s, peer);
    }
    emitState();
    return;
  }

  if (msg.k === 'hi') {
    const existing = s.peers.get(senderId);
    if (existing?.hiSeq && Number(msg.sq) <= existing.hiSeq) return;
    const touched = touchPeer(msg, now, ts);
    if (!touched) return;
    s.incompatiblePeers.delete(senderId);
    const wasLeft = touched.peer.left;
    touched.peer.left = false;
    touched.peer.leftAt = 0;
    touched.peer.hiSeq = Number(msg.sq);
    touched.peer.compatible = true;
    touched.peer.joined = true;
    const advertisedEpoch = Number(msg.ep);
    if (Number.isSafeInteger(advertisedEpoch) && advertisedEpoch > 0) {
      touched.peer.invitedEpoch = Math.max(touched.peer.invitedEpoch || 0, advertisedEpoch);
    }
    if (msg.id === msg.hostId && (!s.hostId || s.hostId === msg.id || s.hostId === s.self.id)) {
      if (!s.hostId) s.hostId = msg.id;
      if (s.hostId === msg.id && isFinite(Number(msg.exp))) {
        const exp = Number(msg.exp);
        if (exp > now && exp <= now + MAX_EXPIRY_MIN * 60_000) s.expiresAt = exp;
      }
    }
    if (s.hostId === s.self.id) touched.peer.hostId = s.self.id;
    if (s.hostId === msg.id) {
      const iexp = Number(msg.iexp);
      const isig = String(msg.isig || '');
      if (Number.isSafeInteger(iexp) && iexp > now && /^[A-Za-z0-9_-]{43}$/.test(isig)) {
        s.inviteExpiresAt = iexp;
        s.inviteSig = isig;
        try {
          s.link = meetLinkFor(s.invite, { exp: iexp, sig: isig });
          setMeetFragment(s.invite, iexp, isig);
        } catch { /* keep the previous share link */ }
      }
    }
    if (touched.isNew) {
      announceNewPeer(s, touched.peer);
    } else if (wasLeft) {
      publishOwnMarkers();
      pushSystemChat(s, 'join', { name: touched.peer.name });
      emit('meet:peerjoined', {
        name: touched.peer.name, id: touched.peer.id,
        legacy: touched.peer.pv < MEET_FEATURE_VERSION
      });
    }
    emitState();
    return;
  }

  if (msg.k === 'msg') {
    const peer = s.peers.get(senderId);
    if (!peer || peer.left || !peer.joined) return;
    const mid = String(msg.mid || '');
    if (!/^[A-Za-z0-9_-]{8,32}$/.test(mid) || s.chatSeen.has(mid)) return;
    const image = msg.im != null ? sanitizeChatImagePacket(msg) : null;
    if (msg.im != null && !image) return;
    const voice = msg.au != null ? sanitizeChatVoicePacket(msg) : null;
    if (msg.au != null && !voice) return;
    if (image && voice) return;
    const text = cleanChatText(msg.tx);
    if (!image && !voice && !text) return;
    if (!chatRateOk(s, senderId, now)) return;
    if (image && !imageRateOk(s, senderId, now)) return;
    const touched = touchPeer(msg, now, ts);
    if (!touched) return;
    if (touched.peer.left) return;
    if (touched.isNew) {
      announceNewPeer(s, touched.peer);
      emitState();
    }
    rememberChatId(s, mid);
    pushChatMessage(s, {
      id: mid,
      fromId: senderId,
      name: touched.peer.name,
      color: touched.peer.color,
      text,
      ts,
      self: false,
      img: image ? {
        data: image.base64,
        mime: image.mime,
        width: image.width,
        height: image.height,
        ...(image.fileId ? {
          fileId: image.fileId,
          hdSize: image.hdSize,
          hdMime: image.hdMime,
          hdWidth: image.hdWidth,
          hdHeight: image.hdHeight,
          hdSha256: image.hdSha256
        } : {})
      } : null,
      voice: voice ? {
        data: voice.base64,
        mime: voice.mime,
        duration: voice.duration,
        waveform: voice.waveform
      } : null,
      lat: image?.lat ?? null,
      lon: image?.lon ?? null,
      acc: image?.acc ?? null
    });
    s.chatUnread = Math.min(999, s.chatUnread + 1);
    emit('meet:chat', { unread: s.chatUnread });
    emit('meet:chat:received', { unread: s.chatUnread, fromId: senderId });
    return;
  }

  if (msg.k === 'loc') {
    const peer = s.peers.get(senderId);
    if (!peer || peer.left || !peer.joined) return;
    processPeerLocation(s, msg, now, ts, senderId);
    return;
  }

  if (msg.k === 'st') {
    const touched = touchPeer(msg, now, ts);
    if (!touched) return;
    if (touched.peer.left || !touched.peer.joined) return;
    const seq = Number(msg.sq);
    if (touched.peer.stateSeq && seq <= touched.peer.stateSeq) return;
    touched.peer.stateSeq = seq;
    touched.peer.sharing = msg.sh !== false;
    if (s.hostId === s.self.id) touched.peer.hostId = s.self.id;
    emitState();
    return;
  }

  if (msg.k === 'meta') {
    if (msg.id !== msg.hostId) return;
    if (s.hostId && s.hostId !== s.self.id && s.hostId !== msg.id) return;
    s.hostId = msg.id;
    const exp = Number(msg.exp);
    if (isFinite(exp) && exp > now && exp <= now + MAX_EXPIRY_MIN * 60_000) s.expiresAt = exp;
    for (const p of s.peers.values()) p.hostId = s.hostId;
    emitState();
    return;
  }

  if (msg.k === 'goal') {
    const peer = s.peers.get(senderId);
    if (!peer || peer.left || !peer.joined) return;
    processPeerGoal(s, msg, now, senderId);
    return;
  }

  if (msg.k === 'mk') {
    const peer = s.peers.get(senderId);
    if (!peer || peer.left || !peer.joined) return;
    processPeerMarker(s, msg, now, senderId);
    return;
  }

  if (msg.k === 'bye') {
    const peer = s.peers.get(senderId);
    if (!peer) return;
    const wasHost = s.hostId === senderId;
    observePeerClock(peer, ts, now);
    peer.lastContactAt = now;
    peer.lastSeen = now;
    markPeerLeft(s, senderId, now);
    pushSystemChat(s, 'leave', { name: peer.name });
    emit('meet:peerleft', { id: senderId, name: peer.name });
    if (wasHost) electHost(s, now);
    else if (s.hostId === s.self.id) void rotateEpoch(s, 'leave');
    emitState();
    return;
  }

  if (msg.k === 'kick') {
    const target = String(msg.target || '');
    const by = String(msg.by || '');
    if (!target || msg.id !== by) return;
    if (s.hostId === s.self.id) return;
    if (!s.hostId || by !== s.hostId) return;
    if (target === s.self.id) {
      await leaveMeet('kicked');
      return;
    }
    const targetName = s.peers.get(target)?.name;
    s.revoked.add(target);
    markPeerLeft(s, target, now);
    if (targetName) {
      pushSystemChat(s, 'kick', { name: targetName });
      emit('meet:peerleft', { id: target, name: targetName, kicked: true });
    }
    if (s.hostId === s.self.id) void rotateEpoch(s, 'kick');
    emitState();
  }
}

function evaluateMeetAlerts(s: MeetSession, now: number) {
  if (get('meetAlertEnabled') === false) return;
  if (positionStatus(s.self, now, s.sharing) !== 'fresh' || s.self.lat == null || s.self.lon == null) return;
  const threshold = clampAlertDistance(get('meetAlertDistance'));
  const cooldown = clampAlertCooldown(get('meetAlertCooldownMin')) * 60_000;
  const fire = (key: string, alert: any) => {
    if (!alertCooldownElapsed(s.alertCooldown.get(key), now, cooldown)) return;
    s.alertCooldown.set(key, now);
    s.lastAlert = alert;
    emit('meet:alert', alert);
  };
  for (const [id, p] of s.peers) {
    if (p.left || p.lat == null || p.lon == null) continue;
    if (networkStatus(p, now) !== 'online' || positionStatus(p, now) !== 'fresh') continue;
    const distance = haversine(s.self.lat, s.self.lon, p.lat, p.lon);
    if (distance >= threshold) {
      fire(`distance:${id}`, {
        kind: 'distance', peerId: id, name: p.name, distance, at: now
      });
    }
  }
  if (!s.goal || get('meetAlertGoal') === false) return;
  const selfGoalDistance = haversine(s.goal.lat, s.goal.lon, s.self.lat, s.self.lon);
  const selfZone = goalZoneAfter(s.alertNear.get('self'), selfGoalDistance, threshold);
  s.alertNear.set('self', selfZone.near);
  if (selfZone.deviated) {
    fire('goal:self', {
      kind: 'goal-self', name: s.self.name, distance: selfGoalDistance, at: now
    });
  }
  for (const [id, p] of s.peers) {
    if (p.left || p.lat == null || p.lon == null) continue;
    if (networkStatus(p, now) !== 'online' || positionStatus(p, now) !== 'fresh') continue;
    const zone = goalZoneAfter(
      s.alertNear.get(id),
      haversine(s.goal.lat, s.goal.lon, p.lat, p.lon),
      threshold
    );
    s.alertNear.set(id, zone.near);
    if (zone.deviated) {
      fire(`goal:${id}`, {
        kind: 'goal-peer', peerId: id, name: p.name, distance: haversine(s.goal.lat, s.goal.lon, p.lat, p.lon), at: now
      });
    }
  }
}

function tick() {
  const s = session;
  if (!s) return;
  const now = Date.now();
  s.rtcRate.prune(now);
  s.previousKeys = s.previousKeys.filter((entry: any) => now < entry.until);
  if (s.hostId !== s.self.id && s.keyEpoch === 0
    && s.relayState === 'connected' && now - (s.lastHelloAt || 0) >= HELLO_RETRY_MS) {
    publishHello();
  }
  const remaining = Math.max(0, s.expiresAt - now);
  emit('meet:tick', { remaining, now });
  if (remaining <= 0) {
    leaveMeet('expired');
    return;
  }
  s.tickCount++;
  let changed = false;
  const markersBefore = s.markers.size;
  activeMarkers(s, now);
  if (s.markers.size !== markersBefore) changed = true;
  const selfState = `${positionStatus(s.self, now, s.sharing)}:${weakGpsReason(s.self.acc ?? null, s.self.accuracyHistory) || ''}`;
  if (s.self.viewState !== selfState) {
    s.self.viewState = selfState;
    changed = true;
  }
  for (const [id, p] of s.peers) {
    const age = now - p.lastContactAt;
    if ((p.left ? now - p.leftAt : age) > REMOVE_MS) {
      const wasHost = s.hostId === id;
      s.peers.delete(id);
      s.p2p?.closePeer(id);
      s.peerVisibility.delete(id);
      if (wasHost) s.hostId = null;
      if (s.route?.peerId === id) s.route = null;
      s.alertNear.delete(id);
      for (const [key, marker] of s.markers) {
        if (marker.by === id) s.markers.delete(key);
      }
      if (wasHost) electHost(s, now);
      changed = true;
      continue;
    }
    const network = networkStatus(p, now);
    const location = positionStatus(p, now);
    const viewState = `${network}:${location}:${weakGpsReason(p.acc ?? null, p.accuracyHistory) || ''}`;
    p.stale = network === 'offline';
    if (p.viewState !== viewState) {
      p.viewState = viewState;
      changed = true;
    }
  }
  if (changed) emitState();
  if (s.tickCount % 5 === 0) {
    evaluateMeetAlerts(s, now);
    pruneMeetReplay(s.replay, new Set(s.peers.keys()), now, REMOVE_MS);
  }
  if (s.tickCount % Math.round(HEARTBEAT_MS / 1000) === 0) {
    publishState();
    if (s.hostId === s.self.id && s.tickCount % 36 === 0) publishHi();
  }
}

async function beginSession({
  invite, name, host, expiryMin, inviteExpiresAt = 0, inviteSig = ''
}: {
  invite: string; name?: string; host: boolean; expiryMin?: number;
  inviteExpiresAt?: number; inviteSig?: string;
}) {
  if (session) await leaveMeet('switch');
  const room = await deriveMeetRoom(invite);
  const keyPair = await generateMeetKeyPair();
  const selfName = resolveName(name);
  if (cleanName(name) && cleanName(name) !== get('meetName')) set('meetName', cleanName(name));
  const selfId = randomMeetId();
  const now = Date.now();
  const mins = clampExpiry(host ? (expiryMin ?? expiryMinutes()) : (expiryMin ?? 120));
  let signedExpiry = 0;
  let signedSig = '';
  if (host) {
    signedExpiry = now + inviteExpiryMinutes() * 60_000;
    signedSig = await signMeetInviteExpiry(room.invite, signedExpiry);
  } else if (inviteExpiresAt || inviteSig) {
    const verdict = await verifyMeetInviteExpiry(room.invite, inviteExpiresAt, inviteSig, now);
    if (verdict.ok === false) throw new Error(`meet-invite-${verdict.reason}`);
    signedExpiry = verdict.legacy ? 0 : verdict.expiresAt;
    signedSig = signedExpiry ? inviteSig : '';
  }
  const link = signedExpiry && signedSig
    ? meetLinkFor(room.invite, { exp: signedExpiry, sig: signedSig })
    : meetLinkFor(room.invite);
  session = {
    invite: room.invite,
    room,
    baseRoom: room,
    keyPair,
    keyEpoch: 0,
    epochSecret: null,
    previousKeys: [],
    peerVisibility: new Map(),
    revoked: new Set(),
    incompatiblePeers: new Map(),
    legacyNotices: new Set(),
    rotating: false,
    rotateQueued: false,
    lastHelloAt: 0,
    secretEpoch: 0,
    roomId: room.roomId,
    roomLabel: roomLabelFor(room.roomId),
    link,
    inviteExpiresAt: signedExpiry,
    inviteSig: signedSig,
    self: {
      id: selfId,
      name: selfName,
      color: '#2bcda7',
      lat: null, lon: null, acc: null, heading: null, speed: null,
      hasFix: false, fixAt: 0, lastFixAt: 0, ts: 0, fixApprox: false,
      accuracyHistory: [], viewState: ''
    },
    hostId: host ? selfId : null,
    peers: new Map(),
    messages: [],
    markers: new Map(),
    goal: null,
    alertNear: new Map(),
    alertCooldown: new Map(),
    lastAlert: null,
    sendLimiter: new MeetSendLimiter(),
    chatUnread: 0,
    chatSeen: new Set(),
    chatRate: new Map(),
    chatImageRate: new Map(),
    lastImageAt: 0,
    imageCache: new OriginalImageCache(),
    rtcSeen: new SignalDeduplicator(),
    rtcRate: new RtcSignalRateLimiter(),
    rtcLane: createRtcLane(),
    p2pStopped: false,
    p2p: null,
    replay: new Map(),
    relay: null,
    relayState: 'connecting',
    relayError: null,
    relayGen: 0,
    epoch: 0,
    sendChain: Promise.resolve(),
    sendSeq: 0,
    watchId: null,
    tickTimer: null,
    tickCount: 0,
    startedAt: now,
    expiresAt: now + mins * 60_000,
    sharing: true,
    geoError: null,
    lastPublish: null,
    lastFix: null,
    route: null,
    routeLoading: '',
    routeAbort: null,
    onVisible: null,
    onOnline: null
  };
  const s = session;
  setMeetFragment(s.invite, s.inviteExpiresAt, s.inviteSig);
  s.onVisible = () => {
    if (document.visibilityState !== 'visible' || session !== s) return;
    startWatch();
    s.p2p?.recover();
    if (s.relayState === 'connected') sendPresence();
  };
  s.onOnline = () => {
    if (session === s) s.p2p?.recover();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', s.onVisible);
  if (typeof window !== 'undefined') window.addEventListener('online', s.onOnline);
  startP2P(s);
  startWatch();
  startRelay();
  s.tickTimer = setInterval(tick, 1000);
  emitState();
  return getMeetSnapshot();
}

export async function createMeetSession({ name, expiryMin }: { name?: string; expiryMin?: number } = {}) {
  return beginSession({ invite: generateMeetInvite(), name, host: true, expiryMin });
}

export async function joinMeetSession(
  invite: string,
  { name, inviteExpiresAt = 0, inviteSig = '' }: { name?: string; inviteExpiresAt?: number; inviteSig?: string } = {}
) {
  return beginSession({ invite, name, host: false, expiryMin: 120, inviteExpiresAt, inviteSig });
}

export async function leaveMeet(reason = 'manual') {
  const s = session;
  if (!s || s.leaving) return;
  s.leaving = true;
  invalidateRtcLane(s);
  if (reason !== 'switch' && reason !== 'room-closed' && reason !== 'incompatible') {
    await Promise.race([publishPacket({ k: 'bye', id: s.self.id }), sleep(250)]);
  }
  cleanupSession(s);
  session = null;
  clearMeetFragment();
  emit('meet:state', getMeetSnapshot());
  emit('meet:ended', { reason });
}

function cleanupSession(s: MeetSession) {
  invalidateRtcLane(s);
  clearInterval(s.tickTimer);
  s.routeAbort?.abort();
  s.routeAbort = null;
  if (s.onVisible && typeof document !== 'undefined') document.removeEventListener('visibilitychange', s.onVisible);
  if (s.onOnline && typeof window !== 'undefined') window.removeEventListener('online', s.onOnline);
  try { if (s.watchId != null) navigator.geolocation?.clearWatch(s.watchId); } catch { /* ignore */ }
  s.watchId = null;
  s.relayGen++;
  try { s.relay?.close(); } catch { /* ignore */ }
  s.relay = null;
  s.peers.clear();
  s.messages.length = 0;
  s.markers.clear();
  s.goal = null;
  s.alertNear.clear();
  s.alertCooldown.clear();
  s.lastAlert = null;
  s.sendLimiter.clear();
  s.chatUnread = 0;
  s.chatSeen.clear();
  s.chatRate.clear();
  s.chatImageRate.clear();
  s.lastImageAt = 0;
  s.p2p?.close();
  s.p2p = null;
  s.imageCache.clear();
  s.rtcSeen.clear();
  s.rtcRate.clear();
  s.replay.clear();
  s.previousKeys = [];
  s.peerVisibility.clear();
  s.revoked.clear();
  s.incompatiblePeers.clear();
  s.legacyNotices.clear();
  s.epochSecret = null;
}

export async function resetMeetCode() {
  const s = session;
  if (!s || s.hostId !== s.self.id) return null;
  await Promise.race([publishPacket({ k: 'closed', id: s.self.id }), sleep(200)]);
  if (session !== s) return null;
  invalidateRtcLane(s);
  s.epoch++;
  s.relayGen++;
  try { s.relay?.close(); } catch { /* ignore */ }
  s.relay = null;
  s.peers.clear();
  s.messages.length = 0;
  s.markers.clear();
  s.goal = null;
  s.alertNear.clear();
  s.alertCooldown.clear();
  s.lastAlert = null;
  s.sendLimiter.clear();
  s.chatUnread = 0;
  s.chatSeen.clear();
  s.chatRate.clear();
  s.chatImageRate.clear();
  s.lastImageAt = 0;
  s.p2p?.close();
  s.p2p = null;
  s.imageCache.clear();
  s.rtcSeen.clear();
  s.rtcRate.clear();
  s.replay.clear();
  s.routeAbort?.abort();
  s.route = null;
  s.routeLoading = '';
  const invite = generateMeetInvite();
  const room = await deriveMeetRoom(invite);
  const keyPair = await generateMeetKeyPair();
  if (session !== s) return null;
  const inviteExpiresAt = Date.now() + inviteExpiryMinutes() * 60_000;
  const inviteSig = await signMeetInviteExpiry(room.invite, inviteExpiresAt);
  s.invite = room.invite;
  s.room = room;
  s.baseRoom = room;
  s.keyPair = keyPair;
  s.keyEpoch = 0;
  s.epochSecret = null;
  s.previousKeys = [];
  s.peerVisibility.clear();
  s.revoked.clear();
  s.incompatiblePeers.clear();
  s.legacyNotices.clear();
  s.rotating = false;
  s.rotateQueued = false;
  s.lastHelloAt = 0;
  s.roomId = room.roomId;
  s.roomLabel = roomLabelFor(room.roomId);
  s.inviteExpiresAt = inviteExpiresAt;
  s.inviteSig = inviteSig;
  s.link = meetLinkFor(room.invite, { exp: inviteExpiresAt, sig: inviteSig });
  setMeetFragment(s.invite, inviteExpiresAt, inviteSig);
  s.hostId = s.self.id;
  s.startedAt = Date.now();
  s.expiresAt = Date.now() + expiryMinutes() * 60_000;
  s.sendChain = Promise.resolve();
  s.sendSeq = 0;
  s.relayState = 'connecting';
  s.relayError = null;
  s.p2pStopped = false;
  s.rtcLane = createRtcLane();
  startP2P(s);
  startRelay();
  publishHi();
  if (s.self.hasFix) publishLoc();
  emitState();
  emit('meet:codeReset', { invite: s.invite });
  return getMeetSnapshot();
}

export function setMeetSharing(on: boolean) {
  const s = session;
  if (!s) return;
  s.sharing = !!on;
  if (s.sharing) sendPresence();
  else publishState();
  emitState();
}

async function sendOwnMarkersTo(s: MeetSession, peer: any, remove = false) {
  const now = Date.now();
  for (const marker of activeMarkers(s, now)) {
    if (marker.by !== s.self.id) continue;
    await publishDirect(s, peer, remove ? {
      k: 'mk', id: s.self.id, del: true, mkid: marker.id
    } : {
      k: 'mk', id: s.self.id,
      mkid: marker.id, mtyp: marker.type,
      la: marker.lat, lo: marker.lon, tx: marker.label,
      ttl: markerRemainingTtl(marker, now)
    });
  }
}

export function setMeetPeerVisibility(peerId: string, visible: boolean) {
  const s = session;
  if (!s) return false;
  const peer = s.peers.get(peerId);
  if (!peer || peer.left || peerId === s.self.id) return false;
  const next = visible ? 'full' : 'hidden';
  if ((s.peerVisibility.get(peerId) || 'full') === next) return true;
  if (next === 'hidden') s.peerVisibility.set(peerId, 'hidden');
  else s.peerVisibility.delete(peerId);
  if (!visible) {
    void sendOwnMarkersTo(s, peer, true);
    emit('meet:security', { type: 'visibility', peerId, visible: false });
  } else {
    if (s.sharing && s.self.hasFix) void publishDirect(s, peer, {
      k: 'loc', id: s.self.id, name: s.self.name, c: s.self.color,
      la: s.self.lat, lo: s.self.lon, ac: s.self.acc,
      hd: s.self.heading, sp: s.self.speed, sh: s.sharing,
      ft: s.self.fixAt
    });
    void sendOwnMarkersTo(s, peer);
    if (s.hostId === s.self.id && s.goal) {
      void publishDirect(s, peer, {
        k: 'goal', id: s.self.id,
        la: s.goal.lat, lo: s.goal.lon, tx: s.goal.label
      });
    }
    emit('meet:security', { type: 'visibility', peerId, visible: true });
  }
  emitState();
  return true;
}

export async function sendMeetMessage(raw: string) {
  const s = session;
  if (!s) return false;
  const text = cleanChatText(raw);
  if (!text) return false;
  const now = Date.now();
  if (sendLimitDenied(s, 'text', now)) return false;
  const mid = randomMeetId();
  const ok = await publishPacket({
    k: 'msg', id: s.self.id, name: s.self.name, c: s.self.color,
    mid, tx: text
  });
  if (session !== s || !ok) return false;
  rememberChatId(s, mid);
  pushChatMessage(s, {
    id: mid,
    fromId: s.self.id,
    name: s.self.name,
    color: s.self.color,
    text,
    ts: now,
    self: true
  });
  emit('meet:chat', { unread: s.chatUnread });
  return true;
}

export async function sendMeetVoice(raw: any) {
  const s = session;
  if (!s) return false;
  const voice = sanitizeChatVoicePacket(raw);
  if (!voice) return false;
  const epoch = s.epoch;
  const now = Date.now();
  if (sendLimitDenied(s, 'voice', now)) return false;
  const mid = randomMeetId();
  const ok = await publishPacket({
    k: 'msg', id: s.self.id, name: s.self.name, c: s.self.color,
    mid, au: voice.base64, aut: voice.mime, aud: voice.duration, auw: voice.waveform
  });
  if (session !== s || s.epoch !== epoch || !ok) return false;
  rememberChatId(s, mid);
  pushChatMessage(s, {
    id: mid,
    fromId: s.self.id,
    name: s.self.name,
    color: s.self.color,
    text: '',
    ts: now,
    self: true,
    voice: {
      data: voice.base64,
      mime: voice.mime,
      duration: voice.duration,
      waveform: voice.waveform
    }
  });
  emit('meet:chat', { unread: s.chatUnread });
  return true;
}

export function markMeetChatRead() {
  const s = session;
  if (!s || !s.chatUnread) return;
  s.chatUnread = 0;
  emit('meet:chat', { unread: 0 });
}

export function meetImageCooldownLeft(now = Date.now()) {
  const s = session;
  if (!s?.lastImageAt) return 0;
  return Math.max(0, CHAT_IMAGE_COOLDOWN_MS - (now - s.lastImageAt));
}

export async function sendMeetImage({ base64, mime, width, height, caption = '', lat = null, lon = null, acc = null, original = null, originalMime = '', originalWidth = null, originalHeight = null }: any) {
  const s = session;
  if (!s) return false;
  const epoch = s.epoch;
  const image = sanitizeChatImagePacket({
    im: base64,
    imt: mime,
    imw: width,
    imh: height,
    la: lat,
    lo: lon,
    ac: acc
  });
  if (!image) return false;
  const now = Date.now();
  if (meetImageCooldownLeft(now) > 0) return false;
  s.lastImageAt = now;
  let cached: CachedOriginalImage | null = null;
  if (original && get('meetP2PEnabled')) {
    try {
      cached = await prepareOriginalImage({ original, originalMime, originalWidth, originalHeight });
    } catch {
      cached = null;
    }
  }
  if (session !== s || s.epoch !== epoch) return false;
  const text = cleanChatText(caption);
  const mid = randomMeetId();
  const body: any = {
    k: 'msg', id: s.self.id, name: s.self.name, c: s.self.color,
    mid, im: image.base64, imt: image.mime, imw: image.width, imh: image.height
  };
  if (cached) {
    body.fid = cached.fileId;
    body.hs = cached.size;
    body.hm = cached.mime;
    body.hw = cached.width;
    body.hh = cached.height;
    body.hsh = cached.sha256;
  }
  if (text) body.tx = text;
  if (image.lat != null && image.lon != null) {
    body.la = image.lat;
    body.lo = image.lon;
    if (image.acc != null) body.ac = image.acc;
  }
  const ok = await publishPacket(body);
  if (session !== s || s.epoch !== epoch) return false;
  if (!ok) {
    if (s.lastImageAt === now) s.lastImageAt = 0;
    return false;
  }
  if (cached) s.imageCache.put(cached);
  rememberChatId(s, mid);
  pushChatMessage(s, {
    id: mid,
    fromId: s.self.id,
    name: s.self.name,
    color: s.self.color,
    text,
    ts: now,
    self: true,
    img: {
      data: image.base64,
      mime: image.mime,
      width: image.width,
      height: image.height,
      ...(cached ? {
        fileId: cached.fileId,
        hdSize: cached.size,
        hdMime: cached.mime,
        hdWidth: cached.width,
        hdHeight: cached.height,
        hdSha256: cached.sha256
      } : {})
    },
    lat: image.lat,
    lon: image.lon,
    acc: image.acc
  });
  emit('meet:chat', { unread: s.chatUnread });
  return true;
}

export async function sendMeetMarker(input: { type?: string; label?: string; ttlMin?: number } = {}) {
  const s = session;
  if (!s) return false;
  const now = Date.now();
  if (positionStatus(s.self, now, s.sharing) !== 'fresh' || s.self.lat == null || s.self.lon == null) return false;
  if (!isMeetMarkerType(input.type)) return false;
  if (sendLimitDenied(s, 'marker', now)) return false;
  const ttlMin = clampMarkerTtl(input.ttlMin ?? get('meetMarkerTtlMin'));
  const marker = sanitizeMeetMarker({
    mkid: randomMeetId(),
    mtyp: input.type,
    la: s.self.lat,
    lo: s.self.lon,
    tx: cleanMarkerLabel(input.label),
    ttl: ttlMin
  }, now);
  if (!marker) return false;
  const ok = await publishPositional({
    k: 'mk', id: s.self.id,
    mkid: marker.id, mtyp: marker.type,
    la: marker.lat, lo: marker.lon, tx: marker.label, ttl: ttlMin
  });
  if (session !== s || !ok) return false;
  const stored = { ...marker, by: s.self.id, byName: s.self.name };
  s.markers.set(markerKey(s.self.id, marker.id), stored);
  trimPeerMarkers(s, s.self.id);
  set('meetMarkerTtlMin', ttlMin);
  emit('meet:marker', { action: 'add', marker: stored });
  emitState();
  return true;
}

export async function deleteMeetMarker(id: string) {
  const s = session;
  if (!s) return false;
  const key = markerKey(s.self.id, String(id || ''));
  if (!s.markers.has(key)) return false;
  const ok = await publishPositional({ k: 'mk', id: s.self.id, del: true, mkid: id });
  if (session !== s || !ok) return false;
  s.markers.delete(key);
  emit('meet:marker', { action: 'delete', id, by: s.self.id });
  emitState();
  return true;
}

export async function sendMeetGoal(options: { label?: string; lat?: number; lon?: number } = {}) {
  const { label = '', lat, lon } = options;
  const s = session;
  if (!s || s.hostId !== s.self.id) return false;
  const now = Date.now();
  const explicitLocation = 'lat' in options || 'lon' in options;
  let goalLat = s.self.lat;
  let goalLon = s.self.lon;
  if (explicitLocation) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)
      || Math.abs(lat as number) > 90 || Math.abs(lon as number) > 180) return false;
    goalLat = lat as number;
    goalLon = lon as number;
  } else if (positionStatus(s.self, now, s.sharing) !== 'fresh' || goalLat == null || goalLon == null) {
    return false;
  }
  if (sendLimitDenied(s, 'goal', now)) return false;
  const goal = sanitizeMeetGoal({ la: goalLat, lo: goalLon, tx: label }, now);
  if (!goal) return false;
  const ok = await publishPositional({ k: 'goal', id: s.self.id, la: goal.lat, lo: goal.lon, tx: goal.label });
  if (session !== s || !ok) return false;
  s.goal = { ...goal, by: s.self.id };
  s.alertNear.clear();
  pushSystemChat(s, 'goalSet', { name: s.self.name, label: goal.label || t('meet.goalDefault') });
  emit('meet:goal', { action: 'set', goal: { ...s.goal }, by: s.goal.by });
  emitState();
  return true;
}

export async function clearMeetGoal() {
  const s = session;
  if (!s || s.hostId !== s.self.id || !s.goal) return false;
  if (sendLimitDenied(s, 'goal', Date.now())) return false;
  const ok = await publishPositional({ k: 'goal', id: s.self.id, del: true });
  if (session !== s || !ok) return false;
  s.goal = null;
  s.alertNear.clear();
  pushSystemChat(s, 'goalCleared', { name: s.self.name });
  emit('meet:goal', { action: 'clear', by: s.self.id });
  emitState();
  return true;
}

export async function sendMeetNow() {
  if (!session) return false;
  await Promise.race([sendPresence(), sleep(500)]);
  return true;
}

export function retryMeetGeolocation() {
  const s = session;
  if (!s) return;
  s.geoError = null;
  startWatch();
  if (s.relayState === 'connected') sendPresence();
  emitState();
}

export async function kickMeetPeer(peerId: string) {
  const s = session;
  if (!s || s.hostId !== s.self.id || !peerId || peerId === s.self.id) return false;
  const target = s.peers.get(peerId);
  if (!target || target.left) return false;
  const sent = await publishPacket({ k: 'kick', id: s.self.id, target: peerId, by: s.self.id });
  if (session !== s) return false;
  if (!sent) return false;
  s.revoked.add(peerId);
  markPeerLeft(s, peerId, Date.now());
  pushSystemChat(s, 'kick', { name: target.name });
  emit('meet:peerleft', { id: peerId, name: target.name, kicked: true });
  await rotateEpoch(s, 'kick');
  emitState();
  return true;
}

export async function planMeetRoute(peerId: string) {
  const s = session;
  if (!s) return null;
  const now = Date.now();
  if (positionStatus(s.self, now, s.sharing) !== 'fresh') return null;
  const peer = s.peers.get(peerId);
  if (!peer || peer.left || positionStatus(peer, now) !== 'fresh' || peer.lat == null || peer.lon == null) return null;
  s.routeAbort?.abort();
  const ctrl = new AbortController();
  s.routeAbort = ctrl;
  s.routeLoading = peerId;
  s.route = null;
  emitState();
  const activity = get('activity') === 'auto' ? 'hike' : (get('activity') || 'hike');
  const route = await routeOverRoads(
    { lat: s.self.lat, lon: s.self.lon },
    { lat: peer.lat, lon: peer.lon },
    activity,
    ctrl.signal
  ).catch(() => null);
  if (session !== s || s.routeLoading !== peerId) return null;
  s.routeLoading = '';
  s.routeAbort = null;
  if (!route) {
    s.route = null;
    emitState();
    emit('meet:routefail', { peerId });
    return null;
  }
  let distance = 0;
  for (let i = 1; i < route.coords.length; i++) {
    distance += haversine(route.coords[i - 1][1], route.coords[i - 1][0], route.coords[i][1], route.coords[i][0]);
  }
  s.route = {
    peerId,
    coords: route.coords,
    distance,
    provider: route.provider,
    at: Date.now()
  };
  emitState();
  emit('meet:route', { peerId, distance, provider: route.provider });
  return s.route;
}

export function clearMeetRoute() {
  const s = session;
  if (!s) return;
  s.routeAbort?.abort();
  s.routeAbort = null;
  s.routeLoading = '';
  s.route = null;
  emitState();
}

export function getMeetOriginalBlob(fileId: string) {
  return session?.imageCache.get(fileId)?.blob || null;
}

export function requestMeetOriginal({ peerId, fileId, sha256, onProgress }: { peerId: string; fileId: string; sha256: string; onProgress?: (progress: number) => void }) {
  const s = session;
  if (!s) return Promise.reject(new P2PTransferError('closed'));
  const image = s.messages.find((message) => message.fromId === peerId
    && message.img?.fileId === fileId && message.img.hdSha256 === sha256)?.img;
  if (!image?.hdSha256 || !image.hdSize || !image.hdMime || !image.hdWidth || !image.hdHeight) return Promise.reject(new P2PTransferError('expired'));
  if (!webrtcAvailable()) return Promise.reject(new P2PTransferError('unsupported'));
  return s.p2p.requestFile({
    peerId,
    fileId,
    sha256: image.hdSha256,
    size: image.hdSize,
    mime: image.hdMime,
    width: image.hdWidth,
    height: image.hdHeight,
    onProgress
  });
}

export function cancelMeetOriginal(peerId: string, fileId: string, sha256?: string) {
  session?.p2p.cancelFile(peerId, fileId, sha256);
}

export function stopMeetP2P() {
  const s = session;
  if (!s) return;
  invalidateRtcLane(s);
  s.p2pStopped = true;
  s.rtcLane = createRtcLane();
  s.p2p?.close();
}

export function resumeMeetP2P() {
  const s = session;
  if (!s || s.leaving || get('meetP2PEnabled') !== true) return;
  s.p2pStopped = false;
  s.rtcLane = createRtcLane();
}

export const meet = {
  snapshot: getMeetSnapshot,
  create: createMeetSession,
  join: joinMeetSession,
  leave: leaveMeet,
  reset: resetMeetCode,
  setSharing: setMeetSharing,
  sendMessage: sendMeetMessage,
  sendVoice: sendMeetVoice,
  sendImage: sendMeetImage,
  sendMarker: sendMeetMarker,
  deleteMarker: deleteMeetMarker,
  setGoal: sendMeetGoal,
  clearGoal: clearMeetGoal,
  originalBlob: getMeetOriginalBlob,
  requestOriginal: requestMeetOriginal,
  cancelOriginal: cancelMeetOriginal,
  stopP2P: stopMeetP2P,
  resumeP2P: resumeMeetP2P,
  imageCooldownLeft: meetImageCooldownLeft,
  markChatRead: markMeetChatRead,
  sendNow: sendMeetNow,
  retryGeo: retryMeetGeolocation,
  setPeerVisibility: setMeetPeerVisibility,
  kick: kickMeetPeer,
  route: planMeetRoute,
  clearRoute: clearMeetRoute,
  injectFix: injectMeetFix,
  active: () => !!session
};
