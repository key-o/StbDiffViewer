/**
 * @fileoverview RC独立基礎配筋の平面polygon・clip・配筋方向を扱う純粋幾何ヘルパー。
 *
 * Three.jsやST-Bridge DOMへ依存せず、R13の矩形・八角形・直角三角形・正三角形で共通利用する。
 *
 * @module data/extractors/rebar3d/foundationRebarGeometry
 */

const EPS = 1e-7;

export function rotatePoint(local, center, angleRad) {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    x: center.x + local.x * cos - local.y * sin,
    y: center.y + local.x * sin + local.y * cos,
    z: local.z,
  };
}

export function evenlySpaced(count, min, max) {
  if (!(count > 0) || !(max >= min)) return [];
  if (count === 1) return [(min + max) / 2];
  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, index) => min + step * index);
}

function cross2(a, b) {
  return a.x * b.y - a.y * b.x;
}

function subtract2(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

function distance2(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function normalizePolygon(points) {
  let result = [];
  for (const point of points || []) {
    if (!result.length || distance2(result[result.length - 1], point) > EPS) result.push(point);
  }
  if (result.length > 1 && distance2(result[0], result[result.length - 1]) <= EPS) result.pop();

  let changed = true;
  while (changed && result.length >= 3) {
    changed = false;
    const next = [];
    for (let index = 0; index < result.length; index += 1) {
      const previous = result[(index - 1 + result.length) % result.length];
      const current = result[index];
      const following = result[(index + 1) % result.length];
      const a = subtract2(current, previous);
      const b = subtract2(following, current);
      if (Math.abs(cross2(a, b)) <= EPS && a.x * b.x + a.y * b.y >= 0) {
        changed = true;
        continue;
      }
      next.push(current);
    }
    result = next;
  }
  return result;
}

function polygonArea(points) {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    twiceArea += a.x * b.y - b.x * a.y;
  }
  return twiceArea / 2;
}

export function polygonCentroid(points) {
  let twiceArea = 0;
  let cxNumerator = 0;
  let cyNumerator = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross;
    cxNumerator += (a.x + b.x) * cross;
    cyNumerator += (a.y + b.y) * cross;
  }
  if (Math.abs(twiceArea) <= EPS) return null;
  return {
    x: cxNumerator / (3 * twiceArea),
    y: cyNumerator / (3 * twiceArea),
  };
}

function centerAtCentroid(points) {
  const centroid = polygonCentroid(points);
  if (!centroid) return null;
  return points.map((point) => ({ x: point.x - centroid.x, y: point.y - centroid.y }));
}

export function planPolygon(shape) {
  if (shape.type === 'EQUI_TRIANGLE') {
    const base = shape.widthBaseMm;
    const chamfer = shape.widthChamferMm;
    const originalSide = base + 2 * chamfer;
    const height = (Math.sqrt(3) * originalSide) / 2;
    const bottomY = -height / 3;
    const topY = (2 * height) / 3;
    return normalizePolygon([
      { x: -base / 2, y: bottomY },
      { x: base / 2, y: bottomY },
      { x: base / 2 + chamfer / 2, y: bottomY + (Math.sqrt(3) * chamfer) / 2 },
      { x: chamfer / 2, y: topY - (Math.sqrt(3) * chamfer) / 2 },
      { x: -chamfer / 2, y: topY - (Math.sqrt(3) * chamfer) / 2 },
      { x: -base / 2 - chamfer / 2, y: bottomY + (Math.sqrt(3) * chamfer) / 2 },
    ]);
  }

  const halfX = shape.widthXmm / 2;
  const halfY = shape.widthYmm / 2;
  if (shape.type === 'RECT') {
    return [
      { x: -halfX, y: -halfY },
      { x: halfX, y: -halfY },
      { x: halfX, y: halfY },
      { x: -halfX, y: halfY },
    ];
  }
  if (shape.type === 'TRIANGLE') {
    const chamferX = Number(shape.chamferXmm) || 0;
    const chamferY = Number(shape.chamferYmm) || 0;
    const polygon = normalizePolygon([
      { x: -halfX, y: -halfY },
      { x: halfX, y: -halfY },
      { x: halfX, y: -halfY + chamferY },
      { x: -halfX + chamferX, y: halfY },
      { x: -halfX, y: halfY },
    ]);
    return centerAtCentroid(polygon);
  }
  if (shape.type !== 'OCTAGON' || !Array.isArray(shape.chamfers)) return null;
  const [c1, c2, c3, c4] = shape.chamfers;
  return normalizePolygon([
    { x: -halfX + c1.x, y: -halfY },
    { x: halfX - c2.x, y: -halfY },
    { x: halfX, y: -halfY + c2.y },
    { x: halfX, y: halfY - c3.y },
    { x: halfX - c3.x, y: halfY },
    { x: -halfX + c4.x, y: halfY },
    { x: -halfX, y: halfY - c4.y },
    { x: -halfX, y: -halfY + c1.y },
  ]);
}

function lineIntersection(a, directionA, b, directionB) {
  const denominator = cross2(directionA, directionB);
  if (Math.abs(denominator) <= EPS) return null;
  const t = cross2(subtract2(b, a), directionB) / denominator;
  return { x: a.x + directionA.x * t, y: a.y + directionA.y * t };
}

export function insetConvexPolygon(rawPoints, inset) {
  const points = normalizePolygon(rawPoints);
  if (points.length < 3 || !(inset >= 0) || polygonArea(points) <= EPS) return null;
  if (inset <= EPS) return points;

  const offsetEdges = [];
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const direction = subtract2(end, start);
    const size = Math.hypot(direction.x, direction.y);
    if (!(size > EPS)) return null;
    const inward = { x: -direction.y / size, y: direction.x / size };
    offsetEdges.push({
      start: { x: start.x + inward.x * inset, y: start.y + inward.y * inset },
      direction,
    });
  }

  const result = [];
  for (let index = 0; index < offsetEdges.length; index += 1) {
    const previous = offsetEdges[(index - 1 + offsetEdges.length) % offsetEdges.length];
    const current = offsetEdges[index];
    const point = lineIntersection(
      previous.start,
      previous.direction,
      current.start,
      current.direction,
    );
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    result.push(point);
  }
  const normalized = normalizePolygon(result);
  return normalized.length >= 3 && polygonArea(normalized) > EPS ? normalized : null;
}

export function axisBounds(points, axis) {
  const values = points.map((point) => point[axis]);
  return { min: Math.min(...values), max: Math.max(...values) };
}

function dot2(a, b) {
  return a.x * b.x + a.y * b.y;
}

function normalize2(vector) {
  const size = Math.hypot(vector.x, vector.y);
  return size > EPS ? { x: vector.x / size, y: vector.y / size } : null;
}

export function perpendicular2(vector) {
  return { x: -vector.y, y: vector.x };
}

export function projectionBounds(points, axis) {
  const values = points.map((point) => dot2(point, axis));
  return { min: Math.min(...values), max: Math.max(...values) };
}

export function evenlySpacedInterior(count, min, max) {
  if (!(count > 0) || !(max > min)) return [];
  const step = (max - min) / (count + 1);
  return Array.from({ length: count }, (_, index) => min + step * (index + 1));
}

export function clipDirectedLine(points, runDirection, crossCoordinate) {
  const run = normalize2(runDirection);
  if (!run) return null;
  const cross = perpendicular2(run);
  const values = [];
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const aCross = dot2(a, cross);
    const bCross = dot2(b, cross);
    if (Math.abs(aCross - crossCoordinate) <= EPS) values.push(dot2(a, run));
    if (Math.abs(bCross - crossCoordinate) <= EPS) values.push(dot2(b, run));
    const delta = bCross - aCross;
    if (Math.abs(delta) <= EPS) continue;
    const t = (crossCoordinate - aCross) / delta;
    if (t >= -EPS && t <= 1 + EPS) {
      const point = {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
      };
      values.push(dot2(point, run));
    }
  }
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return null;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (!(max - min > EPS)) return null;
  return {
    min,
    max,
    run,
    cross,
    start: {
      x: run.x * min + cross.x * crossCoordinate,
      y: run.y * min + cross.y * crossCoordinate,
    },
    end: {
      x: run.x * max + cross.x * crossCoordinate,
      y: run.y * max + cross.y * crossCoordinate,
    },
  };
}

export function clipAxisLine(points, runAxis, crossCoordinate) {
  const crossAxis = runAxis === 'x' ? 'y' : 'x';
  const values = [];
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const aCross = a[crossAxis];
    const bCross = b[crossAxis];
    if (Math.abs(aCross - crossCoordinate) <= EPS) values.push(a[runAxis]);
    if (Math.abs(bCross - crossCoordinate) <= EPS) values.push(b[runAxis]);
    const delta = bCross - aCross;
    if (Math.abs(delta) <= EPS) continue;
    const t = (crossCoordinate - aCross) / delta;
    if (t >= -EPS && t <= 1 + EPS) {
      values.push(a[runAxis] + (b[runAxis] - a[runAxis]) * t);
    }
  }
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return null;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  return max - min > EPS ? { min, max } : null;
}

export function triangleRunDirections(shape) {
  if (shape?.type !== 'TRIANGLE') return null;
  const main = normalize2({
    x: shape.widthXmm - shape.chamferXmm,
    y: -(shape.widthYmm - shape.chamferYmm),
  });
  if (!main) return null;
  return {
    main,
    transverse: perpendicular2(main),
  };
}

export function threeWayRunDirections(shape) {
  if (shape?.type !== 'EQUI_TRIANGLE') return null;
  const root3Over2 = Math.sqrt(3) / 2;
  return [
    { x: 0, y: 1 },
    { x: root3Over2, y: 0.5 },
    { x: -root3Over2, y: 0.5 },
  ];
}
