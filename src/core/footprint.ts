// Year / month footprint aggregation for the local trip library.
import { fmtAltitude, fmtDistance } from './geo';

function startDate(trip) {
  const d = new Date(trip?.createdAt);
  return isNaN(d.getTime()) ? null : d;
}

function dayKey(d) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function buildFootprints(trips, now = new Date()) {
  const years = new Map();
  for (const trip of trips || []) {
    if (trip?.status === 'recording' || trip?.status === 'paused') continue;
    const d = startDate(trip);
    if (!d) continue;
    const year = d.getFullYear();
    let entry = years.get(year);
    if (!entry) {
      entry = {
        year, trips: 0, distance: 0, ascent: 0, duration: 0, days: new Set(), cities: [],
        months: Array.from({ length: 12 }, (_, i) => ({
          month: i + 1, trips: 0, distance: 0, ascent: 0, days: new Set()
        }))
      };
      years.set(year, entry);
    }
    const month = entry.months[d.getMonth()];
    const distance = Number(trip.statsCache?.distance) || 0;
    const ascent = Number(trip.statsCache?.ascent) || 0;
    const duration = Number(trip.statsCache?.duration) || 0;
    entry.trips++;
    entry.distance += distance;
    entry.ascent += ascent;
    entry.duration += duration;
    entry.days.add(dayKey(d));
    month.trips++;
    month.distance += distance;
    month.ascent += ascent;
    month.days.add(dayKey(d));
  }
  const currentYear = now.getFullYear();
  const list = [...years.values()].map((entry) => ({
    ...entry,
    days: entry.days.size,
    months: entry.months.map((m) => ({ ...m, days: m.days.size }))
  }));
  list.sort((a, b) => b.year - a.year);
  const current = list.find((f) => f.year === currentYear) || {
    year: currentYear, trips: 0, distance: 0, ascent: 0, duration: 0, days: 0, cities: [],
    months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, trips: 0, distance: 0, ascent: 0, days: 0 }))
  };
  return { years: list, current };
}

export function aggregateCityFootprints(entries: any[]) {
  const cities = new Map<string, any>();
  const centres = new Map<string, { lat: number; lon: number; samples: number }>();
  for (const entry of entries || []) {
    const at = Number(entry.trip?.createdAt) || 0;
    for (const city of entry.cities || []) {
      const name = String(city.name || '').trim().replace(/\s+/g, ' ');
      if (!name) continue;
      const key = name.toLocaleLowerCase();
      let item = cities.get(key);
      if (!item) {
        item = { name, trips: 0, visits: 0, tripIds: new Set(), firstAt: at, lastAt: at };
        cities.set(key, item);
      }
      if (!item.tripIds.has(entry.trip?.id)) {
        item.tripIds.add(entry.trip?.id);
        item.trips++;
      }
      item.visits++;
      if (at && (!item.firstAt || at < item.firstAt)) item.firstAt = at;
      if (at > item.lastAt) item.lastAt = at;
      const centre = centres.get(key) || { lat: 0, lon: 0, samples: 0 };
      centre.lat = (centre.lat * centre.samples + Number(city.lat)) / (centre.samples + 1);
      centre.lon = (centre.lon * centre.samples + Number(city.lon)) / (centre.samples + 1);
      centre.samples++;
      centres.set(key, centre);
    }
  }
  return [...cities.values()]
    .map((city) => {
      const centre = centres.get(city.name.toLocaleLowerCase());
      return { ...city, lat: centre.lat, lon: centre.lon, tripIds: [...city.tripIds] };
    })
    .sort((a, b) => b.trips - a.trips || b.visits - a.visits || a.name.localeCompare(b.name));
}

export function withFootprintCities(fp, cities) {
  return { ...fp, cities: cities || [] };
}

export function recapFootprint(fp, units = 'metric') {
  const activeMonths = fp.months.filter((m) => m.trips > 0).length;
  let top = null;
  for (const m of fp.months) {
    if (m.trips > 0 && (!top || m.distance > top.distance)) top = m;
  }
  return {
    year: fp.year,
    trips: fp.trips,
    days: fp.days,
    distance: fmtDistance(fp.distance, units),
    ascent: fmtAltitude(fp.ascent, units),
    activeMonths,
    cityCount: fp.cities?.length || 0,
    topMonth: top,
    maxMonthDistance: Math.max(1, ...fp.months.map((m) => m.distance))
  };
}
