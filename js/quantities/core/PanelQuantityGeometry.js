/**
 * @fileoverview panel quantity専用の2Dローカル座標・開口幾何ヘルパー。
 * Three.jsには依存しない。
 */

import { measurePlanarPolygon3d } from './PanelMeasure.js';

const EPSILON = 1e-9;

function point3(point) {
  const result = { x: Number(point?.x), y: Number(point?.y), z: Number(point?.z) };
  if (![result.x, result.y, result.z].every(Number.isFinite)) {
    throw new TypeError('point must have finite x/y/z');
  }
  return result;
}

function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalize(vector, label) {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (!Number.isFinite(length) || length <= EPSILON) throw new RangeError(`${label} is degenerate`);
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function newellNormal(points) {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    nx += (current.y - next.y) * (current.z + next.z);
    ny += (current.z - next.z) * (current.x + next.x);
    nz += (current.x - next.x) * (current.y + next.y);
  }
  return normalize({ x: nx, y: ny, z: nz }, 'panel normal');
}

export function createPanelLocalGeometry(points) {
  if (!Array.isArray(points) || points.length < 3) throw new TypeError('panel requires 3+ points');
  const normalized = points.map(point3);
  const measure = measurePlanarPolygon3d(normalized);
  if (!measure.planar) {
    return { measure, frame: null, polygon2d: null };
  }
  const origin = normalized[0];
  const xAxis = normalize(subtract(normalized[1], origin), 'panel local X');
  const normal = newellNormal(normalized);
  const yAxis = normalize(cross(normal, xAxis), 'panel local Y');
  const polygon2d = normalized.map((point) => {
    const delta = subtract(point, origin);
    return { x: dot(delta, xAxis), y: dot(delta, yAxis) };
  });
  return { measure, frame: { origin, xAxis, yAxis, normal }, polygon2d };
}

export function pointInPolygon2d(point, polygon, tolerance = 1e-7) {
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const px = point.x - a.x;
    const py = point.y - a.y;
    const cross2 = dx * py - dy * px;
    const length2 = dx * dx + dy * dy;
    if (Math.abs(cross2) <= tolerance * Math.max(1, Math.sqrt(length2))) {
      const projection = px * dx + py * dy;
      if (projection >= -tolerance && projection <= length2 + tolerance) return true;
    }
  }

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    const intersects =
      pi.y > point.y !== pj.y > point.y &&
      point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function isConvexPolygon2d(polygon, tolerance = 1e-7) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let sign = 0;
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const c = polygon[(index + 2) % polygon.length];
    const cross2 = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross2) <= tolerance) continue;
    const current = Math.sign(cross2);
    if (sign === 0) sign = current;
    else if (current !== sign) return false;
  }
  return sign !== 0;
}

export function openingCorners2d(opening) {
  const x = Number(opening?.position_X);
  const y = Number(opening?.position_Y);
  const width = Number(opening?.length_X);
  const height = Number(opening?.length_Y);
  const rotate = Number(opening?.rotate ?? 0);
  if (![x, y, width, height, rotate].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }
  const radians = (rotate * Math.PI) / 180;
  const ux = { x: Math.cos(radians), y: Math.sin(radians) };
  const uy = { x: -Math.sin(radians), y: Math.cos(radians) };
  return [
    { x, y },
    { x: x + ux.x * width, y: y + ux.y * width },
    { x: x + ux.x * width + uy.x * height, y: y + ux.y * width + uy.y * height },
    { x: x + uy.x * height, y: y + uy.y * height },
  ];
}

function axes(polygon) {
  const result = [];
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length > EPSILON) result.push({ x: -dy / length, y: dx / length });
  }
  return result;
}

function range(polygon, axis) {
  const values = polygon.map((point) => point.x * axis.x + point.y * axis.y);
  return { min: Math.min(...values), max: Math.max(...values) };
}

/** 接触だけなら重複面積0としてfalse。 */
export function convexPolygonsOverlap2d(a, b, tolerance = 1e-7) {
  for (const axis of [...axes(a), ...axes(b)]) {
    const ra = range(a, axis);
    const rb = range(b, axis);
    if (ra.max <= rb.min + tolerance || rb.max <= ra.min + tolerance) return false;
  }
  return true;
}

export function polygonBounds2d(polygon) {
  return {
    minX: Math.min(...polygon.map((point) => point.x)),
    maxX: Math.max(...polygon.map((point) => point.x)),
    minY: Math.min(...polygon.map((point) => point.y)),
    maxY: Math.max(...polygon.map((point) => point.y)),
  };
}
