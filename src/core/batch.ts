// Batch trip transfer: ZIP of per-trip GPX/GeoJSON out, multi-file GPX/ZIP in.
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { loadTripFull } from './store';
import { buildGPX, buildGeoJSON, importGPX } from './gpx';

const safeName = (s) => String(s || 'trip').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);

export async function exportTripsZip(ids, format = 'gpx') {
  const files = {};
  for (const id of ids) {
    const full = await loadTripFull(id);
    if (!full) continue;
    const base = `${safeName(full.trip.name)}-${id.slice(0, 8)}`;
    if (format === 'geojson') files[`${base}.geojson`] = strToU8(JSON.stringify(buildGeoJSON(full)));
    else files[`${base}.gpx`] = strToU8(buildGPX(full));
  }
  const count = Object.keys(files).length;
  const zipped = zipSync(files, { level: 6 });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return { blob: new Blob([zipped], { type: 'application/zip' }), filename: `roametch-trips-${stamp}.zip`, count };
}

/** Accepts loose .gpx/.xml files and ZIP archives containing them. */
export async function importTripFiles(files) {
  const texts = [];
  let fail = 0;
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      try {
        const entries = unzipSync(new Uint8Array(await f.arrayBuffer()));
        for (const [name, u8] of Object.entries(entries)) {
          if (/\.(gpx|xml)$/i.test(name)) texts.push({ name: name.replace(/\.(gpx|xml)$/i, ''), text: strFromU8(u8) });
        }
      } catch { fail++; }
    } else {
      texts.push({ name: f.name.replace(/\.(gpx|xml)$/i, ''), text: await f.text() });
    }
  }
  let ok = 0;
  for (const { name, text } of texts) {
    try { await importGPX(text, name); ok++; } catch { fail++; }
  }
  return { ok, fail };
}