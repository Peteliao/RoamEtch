// Travel story model: groups one trip into local-day chapters, independent of
// recording segments so a midnight-spanning track still reads as two days.
import { computeStats } from './stats';
import { sunTimes } from './solar';
import { languageTag } from './language';
import type { ManualWeather } from './weather';

export type Story = {
  title: string;
  intro: string;
  dayNotes: Record<string, string>;
  manualWeather: Record<string, ManualWeather>;
  updatedAt?: number;
};

export type StoryPhoto = {
  id: string;
  nodeId: string;
  nodeName: string;
  time: number | null;
  media: any;
};

export type StoryNode = {
  id: string;
  name: string;
  desc: string;
  type: string;
  time: number | null;
  lat: number;
  lon: number;
  photoCount: number;
};

export type StoryDay = {
  day: string;
  label: string;
  start: number | null;
  end: number | null;
  segments: Array<{ id: string; points: any[] }>;
  distance: number;
  duration: number;
  movingMs: number;
  ascent: number;
  descent: number;
  avgSpeed: number;
  nodes: StoryNode[];
  photos: StoryPhoto[];
  center: { lat: number; lon: number } | null;
  firstTime: number | null;
  sun: { sunrise: string | null; sunset: string | null; polar: 'day' | 'night' | null; available: boolean };
  hasTrack: boolean;
};

export function normalizeStory(story: any): Story {
  return {
    title: typeof story?.title === 'string' ? story.title : '',
    intro: typeof story?.intro === 'string' ? story.intro : '',
    dayNotes: story?.dayNotes && typeof story.dayNotes === 'object' ? { ...story.dayNotes } : {},
    manualWeather: story?.manualWeather && typeof story.manualWeather === 'object' ? { ...story.manualWeather } : {},
    updatedAt: Number.isFinite(story?.updatedAt) ? story.updatedAt : undefined
  };
}

export function storyTitle(trip: any, story: Story) {
  return story.title.trim() || trip?.name || '';
}

export function dayKeyOf(time: number | null | undefined, fallback = Date.now()) {
  const date = new Date(Number.isFinite(time) ? Number(time) : fallback);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function storyDayLabel(day: string, lang = 'zh') {
  const date = new Date(`${day}T12:00:00`);
  if (!Number.isFinite(date.getTime())) return day;
  return date.toLocaleDateString(languageTag(lang), { month: 'short', day: 'numeric' });
}

function validPoint(point: any) {
  return point && Number.isFinite(point.lat) && Number.isFinite(point.lon)
    && Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180;
}

function fmtClock(date: Date | undefined, lang: string) {
  if (!date || !Number.isFinite(date.getTime())) return null;
  return date.toLocaleTimeString(languageTag(lang), { hour: '2-digit', minute: '2-digit' });
}

function sunFor(day: string, point: { lat: number; lon: number } | null, lang: string) {
  if (!point) return { sunrise: null, sunset: null, polar: null, available: false };
  const date = new Date(`${day}T12:00:00`);
  const times = sunTimes(date, point.lat, point.lon);
  return {
    sunrise: fmtClock(times.sunrise, lang),
    sunset: fmtClock(times.sunset, lang),
    polar: times.polar,
    available: true
  };
}

export type StoryOptions = {
  ascentThreshold?: number;
  activity?: string;
  weightKg?: number;
  lang?: string;
};

export function buildStoryDays(full: any, opts: StoryOptions = {}): StoryDay[] {
  if (!full) return [];
  const lang = opts.lang || 'zh';
  const fallback = full.trip?.createdAt || Date.now();
  const mediaById = new Map<string, any>((full.media || []).map((m) => [m.id, m]));
  const dayMap = new Map<string, {
    segments: Map<string, any[]>;
    nodes: any[];
  }>();

  function bucket(day: string) {
    if (!dayMap.has(day)) dayMap.set(day, { segments: new Map(), nodes: [] });
    return dayMap.get(day)!;
  }

  for (const segment of full.segments || []) {
    const points = Array.isArray(segment.points) ? segment.points : [];
    for (const point of points) {
      if (!validPoint(point) || !Number.isFinite(point.t)) continue;
      const day = dayKeyOf(point.t, fallback);
      const entry = bucket(day);
      if (!entry.segments.has(segment.id)) entry.segments.set(segment.id, []);
      entry.segments.get(segment.id)!.push(point);
    }
  }

  for (const waypoint of full.waypoints || []) {
    if (!Number.isFinite(waypoint.lat) || !Number.isFinite(waypoint.lon)) continue;
    const time = Number.isFinite(waypoint.time) ? waypoint.time : fallback;
    const day = dayKeyOf(time, fallback);
    bucket(day).nodes.push(waypoint);
  }

  const days: StoryDay[] = [];
  for (const [day, entry] of [...dayMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const segments = [...entry.segments.entries()]
      .map(([id, points]) => ({ id, points }))
      .sort((a, b) => (a.points[0]?.t || 0) - (b.points[0]?.t || 0));
    const stats = computeStats(segments, {
      ascentThreshold: opts.ascentThreshold ?? 4,
      activity: opts.activity || full.trip?.activity || 'hike',
      weightKg: opts.weightKg,
      series: false
    });
    const nodes = entry.nodes.sort((a, b) => (a.time || 0) - (b.time || 0));
    const photos: StoryPhoto[] = [];
    for (const node of nodes) {
      for (const mediaId of node.mediaIds || []) {
        const media = mediaById.get(mediaId);
        if (media) photos.push({
          id: media.id, nodeId: node.id, nodeName: node.name || '',
          time: Number.isFinite(node.time) ? node.time : null, media
        });
      }
    }
    let center: { lat: number; lon: number } | null = null;
    let firstTime: number | null = null;
    for (const segment of segments) {
      for (const point of segment.points) {
        if (!center) center = { lat: point.lat, lon: point.lon };
        if (firstTime == null || point.t < firstTime) firstTime = point.t;
      }
    }
    if (!center && nodes.length) center = { lat: nodes[0].lat, lon: nodes[0].lon };
    if (firstTime == null && nodes.length) firstTime = Number.isFinite(nodes[0].time) ? nodes[0].time : null;
    let lastTime: number | null = firstTime;
    for (const node of nodes) {
      if (Number.isFinite(node.time) && (lastTime == null || node.time > lastTime)) lastTime = node.time;
    }
    days.push({
      day,
      label: storyDayLabel(day, lang),
      start: firstTime,
      end: lastTime,
      segments,
      distance: stats.distance,
      duration: stats.duration,
      movingMs: stats.movingMs,
      ascent: stats.ascent,
      descent: stats.descent,
      avgSpeed: stats.avgSpeed,
      nodes: nodes.map((node) => ({
        id: node.id, name: node.name || '', desc: node.desc || '', type: node.type || 'waypoint',
        time: Number.isFinite(node.time) ? node.time : null, lat: node.lat, lon: node.lon,
        photoCount: (node.mediaIds || []).length
      })),
      photos,
      center,
      firstTime,
      sun: sunFor(day, center, lang),
      hasTrack: segments.length > 0
    });
  }
  return days;
}

export function storyPhotos(full: any) {
  const mediaById = new Map<string, any>((full.media || []).map((m) => [m.id, m]));
  const photos: StoryPhoto[] = [];
  for (const node of full.waypoints || []) {
    for (const mediaId of node.mediaIds || []) {
      const media = mediaById.get(mediaId);
      if (media) photos.push({
        id: media.id, nodeId: node.id, nodeName: node.name || '',
        time: Number.isFinite(node.time) ? node.time : null, media
      });
    }
  }
  return photos.sort((a, b) => (a.time || 0) - (b.time || 0));
}

export function storySummary(days: StoryDay[]) {
  return days.reduce((sum, day) => ({
    days: sum.days + 1,
    distance: sum.distance + day.distance,
    ascent: sum.ascent + day.ascent,
    photos: sum.photos + day.photos.length,
    nodes: sum.nodes + day.nodes.length
  }), { days: 0, distance: 0, ascent: 0, photos: 0, nodes: 0 });
}

export function storyDayForTime(days: StoryDay[], time: number) {
  const key = dayKeyOf(time);
  return days.find((day) => day.day === key) || days.find((day) => day.start != null && day.end != null && time >= day.start && time <= day.end) || null;
}
