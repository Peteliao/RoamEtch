export type VideoPoint = [number, number];
export type VideoRect = { x: number; y: number; w: number; h: number };

function inside(point: VideoPoint, rect: VideoRect, pad = 0) {
  return point[0] >= rect.x - pad && point[0] <= rect.x + rect.w + pad
    && point[1] >= rect.y - pad && point[1] <= rect.y + rect.h + pad;
}

function cross(a: VideoPoint, b: VideoPoint, c: VideoPoint) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsIntersect(a: VideoPoint, b: VideoPoint, c: VideoPoint, d: VideoPoint) {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  return ((abC > 0 && abD < 0) || (abC < 0 && abD > 0))
    && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0));
}

function intersectsRect(a: VideoPoint, b: VideoPoint, rect: VideoRect) {
  const x0 = rect.x, y0 = rect.y, x1 = rect.x + rect.w, y1 = rect.y + rect.h;
  const corners: VideoPoint[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  for (let i = 0; i < 4; i++) if (segmentsIntersect(a, b, corners[i], corners[(i + 1) % 4])) return true;
  return false;
}

export function routeRectScore(points: VideoPoint[], rect: VideoRect, pad = 0) {
  let score = 0;
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (inside(point, rect, pad)) score++;
    if (i > 0 && intersectsRect(points[i - 1], point, { x: rect.x - pad, y: rect.y - pad, w: rect.w + pad * 2, h: rect.h + pad * 2 })) score += 4;
  }
  return score;
}

export function placeVideoOverlay(
  points: VideoPoint[],
  sizes: Array<{ w: number; h: number }>,
  viewport: { w: number; h: number },
  margin = 28
): VideoRect & { score: number } {
  const valid = points.filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
  let best: (VideoRect & { score: number; rank: number }) | null = null;
  for (const size of sizes) {
    const w = Math.min(size.w, viewport.w - margin * 2);
    const h = Math.min(size.h, viewport.h - margin * 2);
    const maxX = Math.max(margin, viewport.w - w - margin);
    const maxY = Math.max(margin, viewport.h - h - margin);
    const spots = [
      [margin, margin], [maxX, margin],
      [margin, maxY], [maxX, maxY],
      [(viewport.w - w) / 2, margin], [(viewport.w - w) / 2, maxY]
    ];
    for (const [x, y] of spots) {
      const rect = { x, y, w, h };
      let score = routeRectScore(valid, rect, 8);
      const active = valid.at(-1);
      if (active && inside(active, rect, 18)) score += 1000;
      const distance = Math.hypot(x + w / 2 - viewport.w / 2, y + h / 2 - viewport.h / 2);
      const rank = score * 1e6 + distance;
      if (!best || rank < best.rank) best = { ...rect, score, rank };
    }
    if (best?.score === 0) break;
  }
  const { rank, ...rect } = best || { x: margin, y: margin, w: sizes[0].w, h: sizes[0].h, score: 0, rank: 0 };
  void rank;
  return rect;
}
