// Pure GPX / GeoJSON / KML serialization. Safe to import from a Worker.

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
