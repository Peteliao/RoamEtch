// GPX / GeoJSON / KML import-export. Output is always strict WGS-84.
import { createTrip, addSegment, appendPoints, addWaypoint, updateTrip, deleteTrip, deleteSegment, publishTrip } from './store';
import { uuid } from './geo';
import { streamGPX, type GPXStreamInput } from './gpxStream';
import { buildGPX, buildGeoJSON, buildKML } from './gpxFormat';

export { buildGPX, buildGeoJSON, buildKML };

function validTimestamp(value: number | null | undefined) {
  return Number.isFinite(value) && !Number.isNaN(new Date(value).getTime()) ? value : null;
}

function earliestTrackTime(segments) {
  let earliest: number | null = null;
  for (const points of segments) {
    for (const point of points) {
      const time = validTimestamp(point.t);
      if (time != null && (earliest == null || time < earliest)) earliest = time;
    }
  }
  return earliest;
}

export function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('XML parse error');
  const name = doc.querySelector('metadata > name')?.textContent
    || doc.querySelector('trk > name')?.textContent
    || doc.querySelector('rte > name')?.textContent || '';
  const segments = [];
  const pushPoint = (el, seg) => {
    const lat = parseFloat(el.getAttribute('lat'));
    const lon = parseFloat(el.getAttribute('lon'));
    if (!isFinite(lat) || !isFinite(lon)) return;
    const ele = el.querySelector('ele')?.textContent;
    const time = el.querySelector('time')?.textContent;
    seg.push({
      lat, lon,
      alt: ele != null && isFinite(parseFloat(ele)) ? parseFloat(ele) : null,
      altSrc: ele != null ? 'svc' : null,
      t: time ? validTimestamp(Date.parse(time)) : null,
      acc: null, speed: null
    });
  };
  const trks = doc.querySelectorAll('trk');
  if (trks.length) {
    trks.forEach((trk) => {
      const segs = trk.querySelectorAll('trkseg');
      if (segs.length) segs.forEach((s) => { const pts = []; s.querySelectorAll('trkpt').forEach((p) => pushPoint(p, pts)); if (pts.length) segments.push(pts); });
      else { const pts = []; trk.querySelectorAll('trkpt').forEach((p) => pushPoint(p, pts)); if (pts.length) segments.push(pts); }
    });
  } else {
    doc.querySelectorAll('rte').forEach((rte) => {
      const pts = [];
      rte.querySelectorAll('rtept').forEach((p) => pushPoint(p, pts));
      if (pts.length) segments.push(pts);
    });
  }
  const waypoints = [];
  doc.querySelectorAll('wpt').forEach((w) => {
    const lat = parseFloat(w.getAttribute('lat')), lon = parseFloat(w.getAttribute('lon'));
    if (!isFinite(lat) || !isFinite(lon)) return;
    waypoints.push({
      lat, lon,
      name: w.querySelector('name')?.textContent || '',
      desc: w.querySelector('desc')?.textContent || '',
      type: 'custom',
      alt: parseFloat(w.querySelector('ele')?.textContent) || null,
      time: Date.parse(w.querySelector('time')?.textContent) || null
    });
  });
  if (!segments.length && !waypoints.length) throw new Error('no track data');
  const hasTime = segments.some((s) => s.some((p) => p.t != null));
  const startTime = earliestTrackTime(segments);
  return { name, segments, waypoints, hasTime, startTime };
}

export async function importGPX(text, fallbackName = 'GPX import') {
  const parsed = parseGPX(text);
  const trip = await createTrip({
    name: parsed.name || fallbackName,
    status: 'finished',
    createdAt: parsed.startTime ?? Date.now()
  });
  for (const pts of parsed.segments) {
    const seg = await addSegment(trip.id, earliestTrackTime([pts]) ?? Date.now());
    await appendPoints(seg.id, trip.id, pts);
  }
  if (!parsed.segments.length) await addSegment(trip.id);
  for (const w of parsed.waypoints) await addWaypoint({ ...w, tripId: trip.id });
  await updateTrip(trip.id, { hasTime: parsed.hasTime });
  return trip;
}

export async function importGPXFile(
  input: GPXStreamInput,
  fallbackName = 'GPX import',
  options: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void; singlePass?: boolean } = {}
) {
  const tripId = uuid();
  let segmentId: string | null = null;
  let segments = 0;
  let sawTrack = false;
  const routeSegmentIds: string[] = [];
  const emit = async (event) => {
      if (event.type === 'segment-start') {
        if (event.source === 'track' && !sawTrack) {
          sawTrack = true;
          for (const id of routeSegmentIds) await deleteSegment(id);
          routeSegmentIds.length = 0;
          segments = 0;
        }
        segmentId = null;
      } else if (event.type === 'points') {
        if (!segmentId) {
          const segment = await addSegment(tripId, event.points[0]?.t || Date.now());
          segmentId = segment.id;
          segments++;
          if (event.source === 'route') routeSegmentIds.push(segment.id);
        }
        await appendPoints(segmentId, tripId, event.points, { allowUnpublished: true });
      } else if (event.type === 'waypoints') {
        for (const waypoint of event.waypoints) await addWaypoint({ ...waypoint, tripId });
      }
  };
  try {
    const largeBlob = input instanceof Blob && input.size >= 256 * 1024;
    const summary = largeBlob && typeof Worker !== 'undefined'
      ? await (await import('./workerBridge')).streamGPXInWorker(input, emit, { ...options, singlePass: true })
      : await streamGPX(input, emit, options);
    if (!segments) await addSegment(tripId);
    const trip = await createTrip({
      id: tripId,
      name: summary.name || fallbackName,
      status: 'finished',
      hasTime: summary.hasTime,
      createdAt: summary.startTime ?? Date.now(),
      publish: false
    });
    await publishTrip(trip);
    return trip;
  } catch (error) {
    try { await deleteTrip(tripId); } catch { /* preserve the original parse failure */ }
    throw error;
  }
}

export function downloadText(text, filename, mime = 'application/octet-stream') {
  const blob = new Blob([text], { type: mime });
  triggerDownload(blob, filename);
}

export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export { uuid };