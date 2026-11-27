export type UnitSystem = 'metric' | 'imperial';

export interface TripPlace {
  name?: string;
  countryCode?: string;
  admin?: string;
  lat?: number;
  lon?: number;
}

export interface TripFilterIndex {
  trip: any;
  distanceM: number | null;
  ascentM: number | null;
  hasPhotos: boolean | null;
  waypointCount: number;
  completeness: number | null;
  places: TripPlace[];
  routeId: string;
  routeName: string;
}

/** Distance and ascent thresholds are always stored in canonical metres. */
export interface TripFilters {
  query: string;
  activity: string;
  favoriteOnly: boolean;
  fromDate: string;
  toDate: string;
  minDistance: number | null;
  maxDistance: number | null;
  minAscent: number | null;
  maxAscent: number | null;
  hasPhotos: 'any' | 'yes' | 'no';
  minWaypoints: number | null;
  minCompleteness: number | null;
  place: string;
  routeId: string;
}

export function emptyTripFilters(): TripFilters {
  return {
    query: '', activity: 'all', favoriteOnly: false,
    fromDate: '', toDate: '',
    minDistance: null, maxDistance: null,
    minAscent: null, maxAscent: null,
    hasPhotos: 'any', minWaypoints: null, minCompleteness: null,
    place: '', routeId: ''
  };
}

export function activeTripFilterCount(filters: TripFilters) {
  const toggles = [
    filters.query, filters.activity !== 'all' && filters.activity, filters.favoriteOnly,
    filters.fromDate, filters.toDate, filters.hasPhotos !== 'any' && filters.hasPhotos,
    filters.place, filters.routeId
  ].filter(Boolean).length;
  const thresholds = [
    filters.minDistance, filters.maxDistance, filters.minAscent, filters.maxAscent,
    filters.minWaypoints, filters.minCompleteness
  ].filter((value) => value != null).length;
  return toggles + thresholds;
}

export function hasActiveTripFilters(filters: TripFilters) {
  return activeTripFilterCount(filters) > 0;
}

export type TripFilterMeasurement = 'distance' | 'ascent';

/** Convert a canonical metre threshold to the unit shown in the filter form. */
export function tripFilterDisplayValue(value: number | null, measurement: TripFilterMeasurement, units: UnitSystem = 'metric') {
  if (value == null || !Number.isFinite(value)) return '';
  const scale = measurement === 'distance'
    ? (units === 'imperial' ? 1 / 1609.344 : 1 / 1000)
    : (units === 'imperial' ? 1 / 0.3048 : 1);
  return String(value * scale);
}

/** Convert a value entered in the current display unit back to canonical metres. */
export function canonicalTripFilterValue(value: number | null, measurement: TripFilterMeasurement, units: UnitSystem = 'metric') {
  if (value == null) return null;
  const scale = measurement === 'distance'
    ? (units === 'imperial' ? 1609.344 : 1000)
    : (units === 'imperial' ? 0.3048 : 1);
  return value * scale;
}

export function tripFilterRouteOptions(entries: TripFilterIndex[]) {
  const routes = new Map<string, string>();
  for (const entry of entries) {
    const routeId = String(entry.routeId || '').trim();
    if (!routeId) continue;
    const routeName = String(entry.routeName || '').trim();
    if (!routes.has(routeId) || (routes.get(routeId) === routeId && routeName)) routes.set(routeId, routeName || routeId);
  }
  return [...routes.entries()];
}

export function localDayKey(value: number | string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function createdAtDay(value: unknown) {
  if (value == null || value === '' || (typeof value === 'string' && !value.trim())) return '';
  if (typeof value !== 'number' && typeof value !== 'string' && !(value instanceof Date)) return '';
  const numeric = Number(value);
  return localDayKey(Number.isFinite(numeric) ? numeric : value);
}

export function placeKey(place: TripPlace) {
  const name = String(place?.name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  if (!name) return '';
  return `${String(place?.countryCode || '').trim().toUpperCase()}:${name}`;
}

function completenessValue(value: any) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const percent = numeric <= 1 ? numeric * 100 : numeric;
  return Math.max(0, Math.min(100, percent));
}

export function indexTripForFilters(trip: any, counts: { hasPhotos?: boolean; waypointCount?: number } = {}): TripFilterIndex {
  const stats = trip?.statsCache || {};
  const rawPlaces = trip?.places || trip?.customMetadata?.places || trip?.location?.places || [];
  const places: TripPlace[] = (Array.isArray(rawPlaces) ? rawPlaces : [rawPlaces])
    .filter((place: any) => place && typeof place === 'object')
    .map((place: any) => ({
      name: String(place.name || place.city || '').trim(),
      countryCode: String(place.countryCode || place.country_code || place.cc || '').trim().toUpperCase(),
      admin: String(place.admin || place.state || '').trim(),
      lat: Number.isFinite(Number(place.lat)) ? Number(place.lat) : undefined,
      lon: Number.isFinite(Number(place.lon)) ? Number(place.lon) : undefined
    }))
    .filter((place: TripPlace) => place.name || place.countryCode);
  const singleLocation = trip?.location;
  if (!places.length && singleLocation && typeof singleLocation === 'object' && (singleLocation.name || singleLocation.city || singleLocation.countryCode)) {
    places.push({
      name: String(singleLocation.name || singleLocation.city || '').trim(),
      countryCode: String(singleLocation.countryCode || '').trim().toUpperCase(),
      admin: String(singleLocation.admin || '').trim()
    });
  }
  const distance = trip?.reportedDistance ?? stats.distance;
  const ascent = stats.ascent;
  const derivedCompleteness = Number(stats.duration) > 0 && Number.isFinite(Number(stats.activeMs))
    ? Math.max(0, Math.min(1, Number(stats.activeMs) / Number(stats.duration)))
    : null;
  return {
    trip,
    distanceM: Number.isFinite(Number(distance)) && Number(distance) >= 0 ? Number(distance) : null,
    ascentM: Number.isFinite(Number(ascent)) && Number(ascent) >= 0 ? Number(ascent) : null,
    hasPhotos: counts.hasPhotos ?? (trip?.hasPhotos == null ? null : Boolean(trip.hasPhotos)),
    waypointCount: Math.max(0, Number(counts.waypointCount ?? trip?.waypointCount) || 0),
    completeness: completenessValue(trip?.completeness ?? stats.completeness ?? stats.quality?.completeness ?? stats.gpsQuality?.completeness ?? derivedCompleteness),
    places,
    routeId: String(trip?.routeId || trip?.customMetadata?.routeId || '').trim(),
    routeName: String(trip?.routeName || trip?.customMetadata?.routeName || '').trim()
  };
}

function nonNegative(value: number | null) {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null;
}

function inRange(value: number | null, min: number | null, max: number | null) {
  if (min == null && max == null) return true;
  if (value == null) return false;
  return (min == null || value >= min) && (max == null || value <= max);
}

function matchesPlace(entry: TripFilterIndex, query: string) {
  const needle = query.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  if (!needle) return true;
  return entry.places.some((place) => [place.name, place.admin, place.countryCode, placeKey(place)]
    .some((value) => String(value || '').toLocaleLowerCase().includes(needle)));
}

export function filterTripIndexes(entries: TripFilterIndex[], filters: TripFilters) {
  const minDistance = nonNegative(filters.minDistance);
  const maxDistance = nonNegative(filters.maxDistance);
  const minAscent = nonNegative(filters.minAscent);
  const maxAscent = nonNegative(filters.maxAscent);
  const minWaypoints = nonNegative(filters.minWaypoints);
  const minCompleteness = nonNegative(filters.minCompleteness);
  const query = filters.query.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    const trip = entry.trip;
    if (filters.activity !== 'all' && trip.activity !== filters.activity) return false;
    if (filters.favoriteOnly && !trip.favorite) return false;
    if (query) {
      const haystack = [trip.name, ...(trip.tags || []), ...entry.places.map((place) => `${place.name || ''} ${place.countryCode || ''}`)]
        .join(' ').toLocaleLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (filters.fromDate || filters.toDate) {
      const day = createdAtDay(trip.createdAt);
      if (!day) return false;
      if (filters.fromDate && day < filters.fromDate) return false;
      if (filters.toDate && day > filters.toDate) return false;
    }
    if (!inRange(entry.distanceM, minDistance, maxDistance)) return false;
    if (!inRange(entry.ascentM, minAscent, maxAscent)) return false;
    if (filters.hasPhotos === 'yes' && entry.hasPhotos !== true) return false;
    if (filters.hasPhotos === 'no' && entry.hasPhotos !== false) return false;
    if (minWaypoints != null && entry.waypointCount < minWaypoints) return false;
    if (minCompleteness != null && (entry.completeness == null || entry.completeness < Math.min(100, minCompleteness))) return false;
    if (!matchesPlace(entry, filters.place)) return false;
    if (filters.routeId && entry.routeId !== filters.routeId) return false;
    return true;
  });
}
