const LARGE_TRACK_POINTS = 100_000;
const CODEC = 'columns-v1';
const NUMERIC_KEYS = ['lat', 'lon', 'alt', 't', 'acc', 'speed', 'heading', 'altAcc', 'distance', 'dt', 'slope'] as const;
const NUMERIC_COLUMNS = new Map<string, number>(NUMERIC_KEYS.map((key, index) => [key, index]));

function payloadPointCount(payload) {
  if (Array.isArray(payload?.segments)) {
    return payload.segments.reduce((sum, segment) => sum + (segment.points?.length || 0), 0);
  }
  if (Array.isArray(payload?.full?.segments)) {
    return payload.full.segments.reduce((sum, segment) => sum + (segment.points?.length || 0), 0);
  }
  if (Array.isArray(payload?.trips)) {
    return payload.trips.reduce((sum, trip) => sum + (trip.segments || []).reduce((count, segment) => count + (segment.points?.length || 0), 0), 0);
  }
  if (Array.isArray(payload?.points)) return payload.points.length;
  if (Array.isArray(payload?.a?.segments) && Array.isArray(payload?.b?.segments)) {
    return payload.a.segments.reduce((sum, segment) => sum + (segment.points?.length || 0), 0)
      + payload.b.segments.reduce((sum, segment) => sum + (segment.points?.length || 0), 0);
  }
  return 0;
}

function encodePoints(points: any[], transferList: Transferable[]) {
  const count = points.length;
  const maskWords = Math.ceil(count / 32);
  const columns = NUMERIC_KEYS.map(() => new Float64Array(count));
  const present = NUMERIC_KEYS.map(() => new Uint32Array(maskWords));
  const altSrc = new Int32Array(count).fill(-1);
  const altSrcPresent = new Uint32Array(maskWords);
  const synth = new Uint8Array(count);
  const synthPresent = new Uint32Array(maskWords);
  const altSrcValues: string[] = [];
  const altSrcIndexes = new Map<string, number>();
  const extras: Array<{ index: number; values: Record<string, any> }> = [];

  for (let index = 0; index < count; index++) {
    const point = points[index];
    const word = index >>> 5;
    const bit = 1 << (index & 31);
    let extra: Record<string, any> | null = null;
    for (const key of Object.keys(point)) {
      const column = NUMERIC_COLUMNS.get(key);
      if (column != null) {
        present[column][word] |= bit;
        const value = point[key];
        if (value === null) columns[column][index] = NaN;
        else if (typeof value === 'number') {
          columns[column][index] = value;
          if (Number.isNaN(value)) (extra ||= {})[key] = value;
        } else (extra ||= {})[key] = value;
      } else if (key === 'altSrc') {
        altSrcPresent[word] |= bit;
        const value = point.altSrc;
        if (typeof value === 'string') {
          let encoded = altSrcIndexes.get(value);
          if (encoded == null) {
            encoded = altSrcValues.length;
            altSrcIndexes.set(value, encoded);
            altSrcValues.push(value);
          }
          altSrc[index] = encoded;
        } else if (value !== null) (extra ||= {})[key] = value;
      } else if (key === 'synth') {
        synthPresent[word] |= bit;
        synth[index] = point.synth ? 1 : 0;
        if (typeof point.synth !== 'boolean') (extra ||= {})[key] = point.synth;
      } else (extra ||= {})[key] = point[key];
    }
    if (extra) extras.push({ index, values: extra });
  }

  for (const column of columns) transferList.push(column.buffer);
  for (const mask of present) transferList.push(mask.buffer);
  transferList.push(altSrc.buffer, altSrcPresent.buffer, synth.buffer, synthPresent.buffer);
  return { count, columns, present, altSrc, altSrcPresent, altSrcValues, synth, synthPresent, extras };
}

function decodePoints(encoded) {
  const points = new Array(encoded.count);
  const extras = new Map<number, Record<string, any>>(encoded.extras.map((entry) => [entry.index, entry.values]));
  for (let index = 0; index < encoded.count; index++) {
    const point: Record<string, any> = {};
    const word = index >>> 5;
    const bit = 1 << (index & 31);
    for (let column = 0; column < NUMERIC_KEYS.length; column++) {
      if (encoded.present[column][word] & bit) {
        const value = encoded.columns[column][index];
        point[NUMERIC_KEYS[column]] = Number.isNaN(value) ? null : value;
      }
    }
    if (encoded.altSrcPresent[word] & bit) {
      const valueIndex = encoded.altSrc[index];
      point.altSrc = valueIndex >= 0 ? encoded.altSrcValues[valueIndex] : null;
    }
    if (encoded.synthPresent[word] & bit) point.synth = encoded.synth[index] === 1;
    const extra = extras.get(index);
    if (extra) Object.assign(point, extra);
    points[index] = point;
  }
  return points;
}

function encodeSegments(segments = [], transferList: Transferable[]) {
  return segments.map((segment) => {
    const { points, ...metadata } = segment;
    return { ...metadata, points: Array.isArray(points) ? encodePoints(points, transferList) : points };
  });
}

function decodeSegments(segments = []) {
  return segments.map((segment) => ({ ...segment, points: decodePoints(segment.points) }));
}

function encodeTrack(track, transferList: Transferable[]) {
  return { ...track, segments: encodeSegments(track?.segments, transferList) };
}

export function prepareWorkerPayload(_type, payload) {
  const pointCount = payloadPointCount(payload);
  if (pointCount <= LARGE_TRACK_POINTS) return { payload, transferList: [] as Transferable[] };
  const transferList: Transferable[] = [];
  const encoded: Record<string, any> = { codec: CODEC };
  if (Array.isArray(payload.segments)) encoded.segments = encodeSegments(payload.segments, transferList);
  else if (payload.full) encoded.full = { trip: payload.full.trip, waypoints: payload.full.waypoints, segments: encodeSegments(payload.full.segments, transferList) };
  else if (Array.isArray(payload.trips)) encoded.trips = payload.trips.map((trip) => ({ trip: trip.trip, ...encodeTrack(trip, transferList) }));
  else if (Array.isArray(payload.points)) encoded.points = encodePoints(payload.points, transferList);
  else if (payload.a && payload.b) {
    encoded.a = encodeTrack(payload.a, transferList);
    encoded.b = encodeTrack(payload.b, transferList);
  }
  for (const key of Object.keys(payload)) {
    if (!['segments', 'full', 'trips', 'points', 'a', 'b'].includes(key)) encoded[key] = payload[key];
  }
  return { payload: encoded, pointCount, transferList };
}

export function decodeWorkerPayload(payload) {
  if (payload?.codec !== CODEC) return payload;
  const decoded: Record<string, any> = { ...payload };
  delete decoded.codec;
  if (Array.isArray(payload.segments)) decoded.segments = decodeSegments(payload.segments);
  if (payload.full) decoded.full = { ...payload.full, segments: decodeSegments(payload.full.segments) };
  if (Array.isArray(payload.trips)) decoded.trips = payload.trips.map((trip) => ({ ...trip, segments: decodeSegments(trip.segments) }));
  if (payload.points) decoded.points = decodePoints(payload.points);
  if (payload.a) decoded.a = { ...payload.a, segments: decodeSegments(payload.a.segments) };
  if (payload.b) decoded.b = { ...payload.b, segments: decodeSegments(payload.b.segments) };
  return decoded;
}
