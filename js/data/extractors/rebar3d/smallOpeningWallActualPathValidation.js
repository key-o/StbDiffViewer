/**
 * @fileoverview Phase 6b-O5 small-opening wall actual-path boundary validation.
 *
 * Wall-local RebarPath candidateがwall profile内に留まり、opening profileへ
 * 接触・侵入しないことをline/arc chord上でfail-closedに確認する。
 */

import { rebarPathToLineSegments } from './rebarPath.js';

const ARC_CHECK_MAX_ANGLE_RAD = Math.PI / 720;
const EPS = 1e-12;

function finite(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pointSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length2 = dx * dx + dy * dy;
  if (!(length2 > 0)) return Math.hypot(point.x - start.x, point.y - start.y);
  const raw = ((point.x - start.x) * dx + (point.y - start.y) * dy) / length2;
  const t = Math.max(0, Math.min(1, raw));
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

function onPolygonBoundary(point, polygon, toleranceMm) {
  return polygon.some(
    (start, index) =>
      pointSegmentDistance(point, start, polygon[(index + 1) % polygon.length]) <= toleranceMm,
  );
}

function pointInPolygon(point, polygon, toleranceMm = 0) {
  if (onPolygonBoundary(point, polygon, toleranceMm)) return true;
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[previous];
    const b = polygon[index];
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function cross2Vector(a, b) {
  return a.x * b.y - a.y * b.x;
}

function cross2(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersectOrTouch(a, b, c, d, toleranceMm) {
  if (
    pointSegmentDistance(a, c, d) <= toleranceMm ||
    pointSegmentDistance(b, c, d) <= toleranceMm ||
    pointSegmentDistance(c, a, b) <= toleranceMm ||
    pointSegmentDistance(d, a, b) <= toleranceMm
  ) {
    return true;
  }
  const abC = cross2(a, b, c);
  const abD = cross2(a, b, d);
  const cdA = cross2(c, d, a);
  const cdB = cross2(c, d, b);
  return abC > 0 !== abD > 0 && cdA > 0 !== cdB > 0;
}

function segmentTouchesPolygon(start, end, polygon, toleranceMm) {
  if (pointInPolygon(start, polygon, toleranceMm) || pointInPolygon(end, polygon, toleranceMm)) {
    return true;
  }
  for (let index = 0; index < polygon.length; index += 1) {
    if (
      segmentsIntersectOrTouch(
        start,
        end,
        polygon[index],
        polygon[(index + 1) % polygon.length],
        toleranceMm,
      )
    ) {
      return true;
    }
  }
  return false;
}

function properIntersectionParameter(a, b, c, d) {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const denominator = cross2Vector(r, s);
  if (Math.abs(denominator) <= EPS) return null;
  const ca = { x: c.x - a.x, y: c.y - a.y };
  const t = cross2Vector(ca, s) / denominator;
  const u = cross2Vector(ca, r) / denominator;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return Math.max(0, Math.min(1, t));
}

function segmentInsidePolygon(start, end, polygon, toleranceMm) {
  if (!pointInPolygon(start, polygon, toleranceMm)) return false;
  if (!pointInPolygon(end, polygon, toleranceMm)) return false;

  const parameters = [0, 1];
  for (let index = 0; index < polygon.length; index += 1) {
    const t = properIntersectionParameter(
      start,
      end,
      polygon[index],
      polygon[(index + 1) % polygon.length],
    );
    if (t !== null) parameters.push(t);
  }
  parameters.sort((a, b) => a - b);

  const unique = parameters.filter(
    (value, index) => index === 0 || Math.abs(value - parameters[index - 1]) > EPS,
  );
  for (let index = 0; index + 1 < unique.length; index += 1) {
    const left = unique[index];
    const right = unique[index + 1];
    if (right - left <= EPS) continue;
    const t = (left + right) / 2;
    const midpoint = {
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
    };
    if (!pointInPolygon(midpoint, polygon, toleranceMm)) return false;
  }
  return true;
}

export function buildSmallOpeningWallOpeningProfile(opening) {
  const width = finite(opening?.widthMm);
  const height = finite(opening?.heightMm);
  const x = finite(opening?.positionXMm);
  const y = finite(opening?.positionYMm);
  const rotateDeg = finite(opening?.rotateDeg);
  if (
    width === null ||
    height === null ||
    x === null ||
    y === null ||
    rotateDeg === null ||
    !(width > 0) ||
    !(height > 0)
  ) {
    return null;
  }

  const angle = (rotateDeg * Math.PI) / 180;
  const ux = { x: Math.cos(angle), y: Math.sin(angle) };
  const uy = { x: -Math.sin(angle), y: Math.cos(angle) };
  const p0 = { x, y };
  const p1 = { x: p0.x + ux.x * width, y: p0.y + ux.y * width };
  const p2 = { x: p1.x + uy.x * height, y: p1.y + uy.y * height };
  const p3 = { x: p0.x + uy.x * height, y: p0.y + uy.y * height };
  return Object.freeze([p0, p1, p2, p3].map((point) => Object.freeze(point)));
}

export function pathInsideWallAndOutsideOpening(path, wallProfile, openingProfile, toleranceMm) {
  if (!Array.isArray(wallProfile) || wallProfile.length < 3) return false;
  if (!Array.isArray(openingProfile) || openingProfile.length < 3) return false;

  const segments = rebarPathToLineSegments(path, {
    maxArcAngleRad: ARC_CHECK_MAX_ANGLE_RAD,
  });
  if (segments.length === 0) return false;

  for (const segment of segments) {
    const start = { x: segment.start.x, y: segment.start.y };
    const end = { x: segment.end.x, y: segment.end.y };
    if (!segmentInsidePolygon(start, end, wallProfile, toleranceMm)) return false;
    if (segmentTouchesPolygon(start, end, openingProfile, toleranceMm)) return false;
  }
  return true;
}
