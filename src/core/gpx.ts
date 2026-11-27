// GPX / GeoJSON / KML import-export. Output is always strict WGS-84.
import { createTrip, addSegment, appendPoints, addWaypoint, updateTrip, deleteTrip, deleteSegment, db } from './store';
import { uuid } from './geo';
import { streamGPX, type GPXStreamInput } from './gpxStream';

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
  try {
    const summary = await streamGPX(input, async (event) => {
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
    }, options);
    if (!segments) await addSegment(tripId);
    const trip = await createTrip({
      id: tripId,
      name: summary.name || fallbackName,
      status: 'finished',
      hasTime: summary.hasTime,
      createdAt: summary.startTime ?? Date.now(),
      publish: false
    });
    await db.trips.add(trip);
    return trip;
  } catch (error) {
    try { await deleteTrip(tripId); } catch { /* preserve the original parse failure */ }
    throw error;
  }
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const iso = (t) => (t ? new Date(t).toISOString() : '');

export function buildGPX(full) {
  const { trip, segments, waypoints } = full;
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="RoamEtch" xmlns="http://www.topografix.com/GPX/1/1">\n`;
  out += `  <metadata><name>${esc(trip.name)}</name><time>${iso(trip.createdAt)}</time></metadata>\n`;
  for (const w of waypoints) {
    if (w.hidden) continue;
    out += `  <wpt lat="${w.lat.toFixed(7)}" lon="${w.lon.toFixed(7)}">${w.alt != null ? `<ele>${w.alt.toFixed(1)}</ele>` : ''}<name>${esc(w.name)}</name><desc>${esc(w.desc)}</desc>${w.time ? `<time>${iso(w.time)}</time>` : ''}</wpt>\n`;
  }
  out += `  <trk><name>${esc(trip.name)}</name><trkseg>\n`;
  // segments separated by closing/opening trkseg (standard multi-segment GPX)
  segments.forEach((seg, i) => {
    if (i > 0) out += `  </trkseg>\n  <trkseg>\n`;
    for (const p of seg.points) {
      out += `    <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${p.alt != null ? `<ele>${p.alt.toFixed(1)}</ele>` : ''}${p.t ? `<time>${iso(p.t)}</time>` : ''}</trkpt>\n`;
    }
  });
  out += `  </trkseg></trk>\n</gpx>\n`;
  return out;
}

export function buildGeoJSON(full, { simplified = null } = {}) {
  const { trip, segments, waypoints } = full;
  const features = [];
  segments.forEach((seg, i) => {
    const pts = simplified ? simplified[i] : seg.points;
    if (pts.length < 2) return;
    features.push({
      type: 'Feature',
      properties: { kind: 'segment', index: i, name: trip.name },
      geometry: { type: 'LineString', coordinates: pts.map((p) => (p.alt != null ? [p.lon, p.lat, p.alt] : [p.lon, p.lat])) }
    });
  });
  for (const w of waypoints) {
    if (w.hidden) continue;
    features.push({
      type: 'Feature',
      properties: { kind: 'waypoint', name: w.name, desc: w.desc, wpType: w.type, time: w.time },
      geometry: { type: 'Point', coordinates: [w.lon, w.lat] }
    });
  }
  return { type: 'FeatureCollection', name: trip.name, features };
}

export function buildKML(full) {
  const { trip, segments, waypoints } = full;
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(trip.name)}</name>\n`;
  out += `<Style id="track"><LineStyle><color>ffa7cd2b</color><width>4</width></LineStyle></Style>\n`;
  segments.forEach((seg, i) => {
    if (seg.points.length < 2) return;
    out += `<Placemark><name>${esc(trip.name)} #${i + 1}</name><styleUrl>#track</styleUrl><LineString><tessellate>1</tessellate><coordinates>\n`;
    out += seg.points.map((p) => `${p.lon.toFixed(7)},${p.lat.toFixed(7)}${p.alt != null ? ',' + p.alt.toFixed(1) : ''}`).join(' ');
    out += `\n</coordinates></LineString></Placemark>\n`;
  });
  for (const w of waypoints) {
    if (w.hidden) continue;
    out += `<Placemark><name>${esc(w.name)}</name><description>${esc(w.desc)}</description><Point><coordinates>${w.lon.toFixed(7)},${w.lat.toFixed(7)}${w.alt != null ? ',' + w.alt.toFixed(1) : ''}</coordinates></Point></Placemark>\n`;
  }
  out += `</Document></kml>\n`;
  return out;
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