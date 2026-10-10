/**
 * @fileoverview RebarPathから必要コンクリート包絡のpure geometry factsを生成する。
 *
 * 描画classには依存せず、line/arc中心線の厳密axis boundsへ
 * bar radius + required coverを加えたswept-envelope boundsを返す。
 */

import { validateRebarPath } from './rebarPath.js';

const EPS = 1e-9;
const TAU = Math.PI * 2;

function vec(value) {
  return { x: Number(value?.x), y: Number(value?.y), z: Number(value?.z) };
}

function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale(v, factor) {
  return { x: v.x * factor, y: v.y * factor, z: v.z * factor };
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

function magnitude(v) {
  return Math.hypot(v.x, v.y, v.z);
}

function normalize(v) {
  const length = magnitude(v);
  return length > EPS ? scale(v, 1 / length) : null;
}

function arcBasis(arc) {
  const normal = normalize(vec(arc?.planeNormal));
  const rawStart = normalize(vec(arc?.startDirection));
  if (!normal || !rawStart) return null;
  const start = normalize(subtract(rawStart, scale(normal, dot(rawStart, normal))));
  if (!start) return null;
  const tangent = normalize(cross(normal, start));
  return tangent ? { normal, start, tangent } : null;
}

function normalizePositive(angle) {
  const value = angle % TAU;
  return value < 0 ? value + TAU : value;
}

function angleOnSweep(angle, sweep) {
  if (Math.abs(sweep) >= TAU - EPS) return true;
  if (sweep >= 0) return normalizePositive(angle) <= sweep + EPS;
  return normalizePositive(-angle) <= -sweep + EPS;
}

function lineRange(line, axis) {
  const values = [Number(line?.start?.[axis]), Number(line?.end?.[axis])];
  return values.every(Number.isFinite)
    ? { min: Math.min(...values), max: Math.max(...values) }
    : null;
}

function arcRange(arc, axis) {
  const basis = arcBasis(arc);
  const center = vec(arc?.center);
  const radius = Number(arc?.radius);
  const sweep = Number(arc?.sweepAngleRad);
  if (!basis || !(radius > 0) || !Number.isFinite(sweep) || !Number.isFinite(center[axis])) {
    return null;
  }

  const a = basis.start[axis];
  const b = basis.tangent[axis];
  const evaluate = (angle) => center[axis] + radius * (a * Math.cos(angle) + b * Math.sin(angle));
  const angles = [0, sweep];
  const critical = Math.atan2(b, a);
  for (const candidate of [
    critical,
    critical + Math.PI,
    critical - Math.PI,
    critical + TAU,
    critical - TAU,
  ]) {
    if (angleOnSweep(candidate, sweep)) angles.push(candidate);
  }
  const values = angles.map(evaluate);
  return values.every(Number.isFinite)
    ? { min: Math.min(...values), max: Math.max(...values) }
    : null;
}

function mergeRange(current, next) {
  if (!next) return current;
  if (!current) return { ...next };
  return { min: Math.min(current.min, next.min), max: Math.max(current.max, next.max) };
}

function centerlineBounds(path) {
  const ranges = { x: null, y: null, z: null };
  for (const primitive of path?.primitives || []) {
    for (const axis of ['x', 'y', 'z']) {
      const range =
        primitive?.type === 'line'
          ? lineRange(primitive, axis)
          : primitive?.type === 'arc'
            ? arcRange(primitive, axis)
            : null;
      ranges[axis] = mergeRange(ranges[axis], range);
    }
  }
  if (Object.values(ranges).some((range) => !range)) return null;
  return {
    min: { x: ranges.x.min, y: ranges.y.min, z: ranges.z.min },
    max: { x: ranges.x.max, y: ranges.y.max, z: ranges.z.max },
  };
}

function expand(bounds, amount) {
  return {
    min: {
      x: bounds.min.x - amount,
      y: bounds.min.y - amount,
      z: bounds.min.z - amount,
    },
    max: {
      x: bounds.max.x + amount,
      y: bounds.max.y + amount,
      z: bounds.max.z + amount,
    },
  };
}

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    status: 'UNRESOLVED',
    reason,
    centerlineBounds: null,
    barBounds: null,
    requiredBounds: null,
    clearanceMm: null,
    ...extra,
  };
}

export function buildRequiredConcreteEnvelope({
  rebarPath,
  barDiameterMm = rebarPath?.metadata?.dia,
  requiredCoverMm,
  requireProductionReady = true,
} = {}) {
  const validation = validateRebarPath(rebarPath);
  if (!validation.ok) {
    return unresolved('required-concrete-envelope-invalid-rebar-path', { validation });
  }

  if (
    requireProductionReady &&
    (rebarPath?.metadata?.generationStatus !== 'CENTERLINE_READY' ||
      rebarPath?.metadata?.coordinateSpace !== 'world' ||
      !rebarPath?.metadata?.identityKey ||
      !rebarPath?.metadata?.grade)
  ) {
    return unresolved('required-concrete-envelope-production-path-required');
  }

  const dia = Number(barDiameterMm);
  const cover = Number(requiredCoverMm);
  if (!(dia > 0)) return unresolved('required-concrete-envelope-bar-diameter-unresolved');
  if (!(Number.isFinite(cover) && cover >= 0)) {
    return unresolved('required-concrete-envelope-cover-unresolved');
  }

  const bounds = centerlineBounds(rebarPath);
  if (!bounds) return unresolved('required-concrete-envelope-bounds-unresolved');
  const clearanceMm = dia / 2 + cover;
  return {
    resolved: true,
    status: 'READY',
    reason: null,
    barDiameterMm: dia,
    requiredCoverMm: cover,
    clearanceMm,
    centerlineBounds: bounds,
    barBounds: expand(bounds, dia / 2),
    requiredBounds: expand(bounds, clearanceMm),
    sourceIdentityKeys: [String(rebarPath.metadata.identityKey)],
  };
}

export const _requiredConcreteEnvelopeInternals = Object.freeze({
  centerlineBounds,
  arcRange,
});
