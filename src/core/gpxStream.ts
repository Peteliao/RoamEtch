export interface GPXStreamPoint {
  lat: number;
  lon: number;
  alt: number | null;
  altSrc: string | null;
  t: number | null;
  acc: null;
  speed: null;
}

export interface GPXStreamWaypoint {
  lat: number;
  lon: number;
  name: string;
  desc: string;
  type: 'custom';
  alt: number | null;
  time: number | null;
}

export type GPXSegmentSource = 'track' | 'route';

export type GPXStreamEvent =
  | { type: 'segment-start'; index: number; source: GPXSegmentSource }
  | { type: 'points'; index: number; points: GPXStreamPoint[]; source: GPXSegmentSource }
  | { type: 'segment-end'; index: number; source: GPXSegmentSource }
  | { type: 'waypoints'; waypoints: GPXStreamWaypoint[] }
  | { type: 'done'; name: string; hasTime: boolean; segments: number; waypoints: number };

export type GPXStreamInput = Blob | AsyncIterable<Uint8Array>;

export interface GPXStreamOptions {
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
  singlePass?: boolean;
}

type XmlToken =
  | { type: 'text'; value: string; raw: boolean }
  | { type: 'tag'; value: string };

const BATCH_SIZE = 400;
const WAYPOINT_BATCH_SIZE = 100;
const MAX_CAPTURE_CHARS = 64 * 1024;
const MAX_XML_TOKEN_CHARS = 1024 * 1024;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function abortError() {
  return new DOMException('The operation was aborted.', 'AbortError');
}

export const MAX_GPX_STREAM_BYTES = 1024 * 1024 * 1024;

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function decodeEntities(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return whole; }
      }
      return whole;
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

function localName(value: string) {
  return value.split(':').pop()!.toLowerCase();
}

function findTagEnd(value: string) {
  let quote = '';
  let brackets = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '[') brackets++;
    else if (char === ']') brackets = Math.max(0, brackets - 1);
    else if (char === '>' && brackets === 0) return index;
  }
  return -1;
}

function isAsyncIterable(value: GPXStreamInput): value is AsyncIterable<Uint8Array> {
  return typeof (value as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function';
}

async function* byteChunks(input: GPXStreamInput, onRead?: (loaded: number) => void, signal?: AbortSignal, maxBytes = MAX_GPX_STREAM_BYTES): AsyncGenerator<Uint8Array> {
  let loaded = 0;
  if (isAsyncIterable(input)) {
    for await (const value of input) {
      checkAbort(signal);
      loaded += value.byteLength;
      if (loaded > maxBytes) throw new Error('GPX input too large');
      onRead?.(loaded);
      yield value;
    }
    return;
  }
  const reader = input.stream().getReader();
  let done = false;
  try {
    while (true) {
      checkAbort(signal);
      const next = await reader.read();
      if (next.done) {
        done = true;
        return;
      }
      loaded += next.value.byteLength;
      if (loaded > maxBytes) throw new Error('GPX input too large');
      onRead?.(loaded);
      yield next.value;
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function* xmlTokens(input: GPXStreamInput, onRead?: (loaded: number) => void, signal?: AbortSignal, maxBytes = MAX_GPX_STREAM_BYTES): AsyncGenerator<XmlToken> {
  const chunks = byteChunks(input, onRead, signal, maxBytes)[Symbol.asyncIterator]();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let final = false;
  const readMore = async () => {
    const next = await chunks.next();
    if (next.done) {
      final = true;
      buffer += decoder.decode();
    } else {
      buffer += decoder.decode(next.value, { stream: true });
    }
  };
  try {
    while (true) {
      if (!buffer) {
        if (final) break;
        await readMore();
        continue;
      }
      const start = buffer.indexOf('<');
      if (start < 0) {
        yield { type: 'text', value: buffer, raw: false };
        buffer = '';
        continue;
      }
      if (start > 0) {
        yield { type: 'text', value: buffer.slice(0, start), raw: false };
        buffer = buffer.slice(start);
        continue;
      }
      if (buffer.startsWith('<!--')) {
        const end = buffer.indexOf('-->');
        if (end < 0) {
          if (buffer.length > MAX_XML_TOKEN_CHARS) throw new Error('XML token too large');
          if (final) throw new Error('XML parse error');
          await readMore();
          continue;
        }
        buffer = buffer.slice(end + 3);
        continue;
      }
      if (buffer.startsWith('<![CDATA[')) {
        const end = buffer.indexOf(']]>');
        if (end < 0) {
          if (buffer.length > MAX_XML_TOKEN_CHARS) throw new Error('XML token too large');
          if (final) throw new Error('XML parse error');
          await readMore();
          continue;
        }
        yield { type: 'text', value: buffer.slice(9, end), raw: true };
        buffer = buffer.slice(end + 3);
        continue;
      }
      if (buffer.startsWith('<?')) {
        const end = buffer.indexOf('?>');
        if (end < 0) {
          if (buffer.length > MAX_XML_TOKEN_CHARS) throw new Error('XML token too large');
          if (final) throw new Error('XML parse error');
          await readMore();
          continue;
        }
        buffer = buffer.slice(end + 2);
        continue;
      }
      const end = findTagEnd(buffer);
      if (end < 0) {
        if (buffer.length > MAX_XML_TOKEN_CHARS) throw new Error('XML token too large');
        if (final) throw new Error('XML parse error');
        await readMore();
        continue;
      }
      yield { type: 'tag', value: buffer.slice(0, end + 1) };
      buffer = buffer.slice(end + 1);
    }
  } finally {
    await chunks.return(new Uint8Array());
  }
}

interface StartTag {
  name: string;
  closing: false;
  selfClosing: boolean;
  attrs: Record<string, string>;
}

interface EndTag {
  name: string;
  closing: true;
  selfClosing: false;
  attrs: Record<string, never>;
}

function parseTag(value: string): StartTag | EndTag | null {
  if (/^<!/.test(value)) return null;
  if (/^<\//.test(value)) {
    const name = localName(value.slice(2, -1).trim());
    return name ? { name, closing: true, selfClosing: false, attrs: {} } : null;
  }
  const selfClosing = /\/\s*>$/.test(value);
  const inner = value.slice(1, selfClosing ? -2 : -1).trim();
  const match = inner.match(/^([^\s/>]+)/);
  if (!match) return null;
  const attrs: Record<string, string> = {};
  const attrPattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const attr of inner.matchAll(attrPattern)) {
    attrs[localName(attr[1])] = decodeEntities(attr[2] ?? attr[3] ?? '');
  }
  return { name: localName(match[1]), closing: false, selfClosing, attrs };
}

async function hasTracks(file: Blob, signal?: AbortSignal) {
  for await (const token of xmlTokens(file, undefined, signal)) {
    checkAbort(signal);
    if (token.type !== 'tag') continue;
    const tag = parseTag(token.value);
    if (tag && !tag.closing && tag.name === 'trk') return true;
  }
  return false;
}

function validCoords(lat: number, lon: number) {
  return Number.isFinite(lat) && Number.isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function parsedTime(value: string | null) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function parsedAltitude(value: string | null) {
  if (value == null) return null;
  const altitude = Number.parseFloat(value);
  return Number.isFinite(altitude) ? altitude : null;
}

interface PointDraft {
  lat: number;
  lon: number;
  ele: string | null;
  time: string | null;
}

interface WaypointDraft extends PointDraft {
  name: string;
  desc: string;
}

type CaptureKind =
  | 'point-ele' | 'point-time' | 'waypoint-ele' | 'waypoint-time'
  | 'waypoint-name' | 'waypoint-desc' | 'metadata-name' | 'trk-name' | 'rte-name';

interface TextCapture {
  kind: CaptureKind;
  depth: number;
  parts: { value: string; raw: boolean }[];
  chars: number;
}

function makePoint(draft: PointDraft): GPXStreamPoint | null {
  if (!validCoords(draft.lat, draft.lon)) return null;
  return {
    lat: draft.lat,
    lon: draft.lon,
    alt: parsedAltitude(draft.ele),
    altSrc: draft.ele != null ? 'svc' : null,
    t: parsedTime(draft.time),
    acc: null,
    speed: null
  };
}

function makeWaypoint(draft: WaypointDraft): GPXStreamWaypoint | null {
  if (!validCoords(draft.lat, draft.lon)) return null;
  return {
    lat: draft.lat,
    lon: draft.lon,
    name: draft.name,
    desc: draft.desc,
    type: 'custom',
    alt: parsedAltitude(draft.ele),
    time: parsedTime(draft.time)
  };
}

export async function streamGPX(
  input: GPXStreamInput,
  onEvent: (event: GPXStreamEvent) => void | Promise<void>,
  options: GPXStreamOptions = {}
) {
  const { signal, onProgress, singlePass = false } = options;
  checkAbort(signal);
  const rewindable = !isAsyncIterable(input);
  if (!rewindable && !singlePass) throw new Error('single-pass input requires singlePass mode');
  const total = rewindable ? (input as Blob).size : 0;
  if (total > MAX_GPX_STREAM_BYTES) throw new Error('GPX input too large');
  let trackMode = rewindable ? await hasTracks(input as Blob, signal) : false;
  const stack: string[] = [];
  let rootSeen = false;
  let rootClosed = false;
  let capture: TextCapture | null = null;
  let point: PointDraft | null = null;
  let waypoint: WaypointDraft | null = null;
  let metadataName = '';
  let trackName = '';
  let routeName = '';
  let hasTime = false;
  let segmentCount = 0;
  let waypointCount = 0;
  let activeSegment: { index: number; batch: GPXStreamPoint[]; source: GPXSegmentSource } | null = null;
  let waypointBatch: GPXStreamWaypoint[] = [];
  let track: { hasSegments: boolean } | null = null;
  let loaded = 0;

  const emit = async (event: GPXStreamEvent) => {
    checkAbort(signal);
    await onEvent(event);
  };
  const beginSegment = async (source: GPXSegmentSource) => {
    activeSegment = { index: segmentCount++, batch: [], source };
    await emit({ type: 'segment-start', index: activeSegment.index, source });
  };
  const queuePoint = async (value: GPXStreamPoint | null) => {
    if (!value || !activeSegment) return;
    if (value.t != null) hasTime = true;
    activeSegment.batch.push(value);
    if (activeSegment.batch.length >= BATCH_SIZE) {
      await emit({ type: 'points', index: activeSegment.index, points: activeSegment.batch, source: activeSegment.source });
      activeSegment.batch = [];
    }
  };
  const endSegment = async () => {
    if (!activeSegment) return;
    if (activeSegment.batch.length) {
      await emit({ type: 'points', index: activeSegment.index, points: activeSegment.batch, source: activeSegment.source });
    }
    await emit({ type: 'segment-end', index: activeSegment.index, source: activeSegment.source });
    activeSegment = null;
  };
  const queueWaypoint = async (value: GPXStreamWaypoint | null) => {
    if (!value) return;
    waypointCount++;
    waypointBatch.push(value);
    if (waypointBatch.length >= WAYPOINT_BATCH_SIZE) {
      await emit({ type: 'waypoints', waypoints: waypointBatch });
      waypointBatch = [];
    }
  };
  const startCapture = (kind: CaptureKind, depth: number) => {
    capture = { kind, depth, parts: [], chars: 0 };
  };
  const appendCapture = (value: string, raw: boolean) => {
    if (!capture) return;
    const remaining = MAX_CAPTURE_CHARS - capture.chars;
    if (remaining <= 0) return;
    const text = value.slice(0, remaining);
    const previous = capture.parts[capture.parts.length - 1];
    if (previous?.raw === raw) previous.value += text;
    else capture.parts.push({ value: text, raw });
    capture.chars += text.length;
  };
  const finishCapture = async () => {
    if (!capture) return;
    let value = '';
    let encoded = '';
    const flushEncoded = () => {
      if (!encoded) return;
      value += decodeEntities(encoded);
      encoded = '';
    };
    for (const part of capture.parts) {
      if (part.raw) {
        flushEncoded();
        value += part.value;
      } else {
        encoded += part.value;
      }
    }
    flushEncoded();
    value = value.trim();
    const kind = capture.kind;
    capture = null;
    if (kind === 'point-ele' && point) point.ele = value;
    else if (kind === 'point-time' && point) point.time = value;
    else if (kind === 'waypoint-ele' && waypoint) waypoint.ele = value;
    else if (kind === 'waypoint-time' && waypoint) waypoint.time = value;
    else if (kind === 'waypoint-name' && waypoint) waypoint.name = value;
    else if (kind === 'waypoint-desc' && waypoint) waypoint.desc = value;
    else if (kind === 'metadata-name') metadataName ||= value;
    else if (kind === 'trk-name') trackName ||= value;
    else if (kind === 'rte-name') routeName ||= value;
  };
  const completePoint = async () => {
    const value = makePoint(point!);
    point = null;
    if (!value) return;
    if (track) {
      await queuePoint(value);
    } else if (!trackMode && activeSegment) {
      await queuePoint(value);
    }
  };
  const completeWaypoint = async () => {
    const value = makeWaypoint(waypoint!);
    waypoint = null;
    await queueWaypoint(value);
  };

  for await (const token of xmlTokens(input, (loaded) => onProgress?.(loaded, total), signal)) {
    checkAbort(signal);
    if (token.type === 'text') {
      if (capture) appendCapture(token.value, token.raw);
      continue;
    }
    const tag = parseTag(token.value);
    if (!tag) continue;
    if (tag.closing) {
      if (!stack.length || stack[stack.length - 1] !== tag.name) throw new Error('XML parse error');
      if (capture && capture.depth === stack.length) await finishCapture();
      if (tag.name === 'trkpt' || tag.name === 'rtept') await completePoint();
      else if (tag.name === 'wpt') await completeWaypoint();
      else if (tag.name === 'trkseg') await endSegment();
      else if (tag.name === 'rte' && !trackMode) await endSegment();
      else if (tag.name === 'trk') {
        await endSegment();
        track = null;
      }
      stack.pop();
      if (!stack.length) rootClosed = true;
      continue;
    }

    const parent = stack[stack.length - 1] || '';
    if (!stack.length) {
      if (rootSeen || rootClosed) throw new Error('XML parse error');
      rootSeen = true;
    }
    if (tag.name === 'trk') {
      trackMode = true;
      track = { hasSegments: false };
      await beginSegment('track');
    } else if (tag.name === 'trkseg' && track) {
      if (track.hasSegments) await beginSegment('track');
      track.hasSegments = true;
    } else if (tag.name === 'rte' && !trackMode) await beginSegment('route');
    else if (tag.name === 'trkpt' || tag.name === 'rtept') {
      point = { lat: Number.parseFloat(tag.attrs.lat || ''), lon: Number.parseFloat(tag.attrs.lon || ''), ele: null, time: null };
    } else if (tag.name === 'wpt') {
      waypoint = { lat: Number.parseFloat(tag.attrs.lat || ''), lon: Number.parseFloat(tag.attrs.lon || ''), ele: null, time: null, name: '', desc: '' };
    }

    if (!capture) {
      if ((tag.name === 'ele' || tag.name === 'time') && waypoint && parent === 'wpt') {
        startCapture(tag.name === 'ele' ? 'waypoint-ele' : 'waypoint-time', stack.length + 1);
      } else if ((tag.name === 'ele' || tag.name === 'time') && point && (parent === 'trkpt' || parent === 'rtept')) {
        startCapture(tag.name === 'ele' ? 'point-ele' : 'point-time', stack.length + 1);
      } else if ((tag.name === 'name' || tag.name === 'desc') && waypoint && parent === 'wpt') {
        startCapture(tag.name === 'name' ? 'waypoint-name' : 'waypoint-desc', stack.length + 1);
      } else if (tag.name === 'name' && parent === 'metadata') {
        startCapture('metadata-name', stack.length + 1);
      } else if (tag.name === 'name' && parent === 'trk') {
        startCapture('trk-name', stack.length + 1);
      } else if (tag.name === 'name' && parent === 'rte') {
        startCapture('rte-name', stack.length + 1);
      }
    }

    if (tag.selfClosing) {
      if (capture && capture.depth === stack.length + 1) await finishCapture();
      if (tag.name === 'trkpt' || tag.name === 'rtept') await completePoint();
      else if (tag.name === 'wpt') await completeWaypoint();
    } else {
      stack.push(tag.name);
    }
  }

  if (stack.length || !rootSeen) throw new Error('XML parse error');
  if (activeSegment) await endSegment();
  if (waypointBatch.length) await emit({ type: 'waypoints', waypoints: waypointBatch });
  if (!segmentCount && !waypointCount) throw new Error('no track data');
  const name = metadataName || trackName || routeName;
  await emit({ type: 'done', name, hasTime, segments: segmentCount, waypoints: waypointCount });
  onProgress?.(total, total);
  return { name, hasTime, segments: segmentCount, waypoints: waypointCount, loaded: total };
}
