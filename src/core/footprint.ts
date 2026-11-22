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
    const d = startDate(trip);
    if (!d) continue;
    const year = d.getFullYear();
    let entry = years.get(year);
    if (!entry) {
      entry = {
        year, trips: 0, distance: 0, ascent: 0, duration: 0, days: new Set(),
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
    year: currentYear, trips: 0, distance: 0, ascent: 0, duration: 0, days: 0,
    months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, trips: 0, distance: 0, ascent: 0, days: 0 }))
  };
  return { years: list, current };
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
    topMonth: top,
    maxMonthDistance: Math.max(1, ...fp.months.map((m) => m.distance))
  };
}
