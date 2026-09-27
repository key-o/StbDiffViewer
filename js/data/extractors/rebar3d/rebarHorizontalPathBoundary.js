/**
 * @fileoverview Issue #302 Phase 5c-B: horizontal RebarPath の柱plan boundary containment。
 *
 * path centerlineだけでなく鉄筋外径を含むenvelopeが、attached column plan boundaryの
 * 共通部分内に収まることをpure geometryで判定する。
 */

import { getPrimitiveStart } from './rebarPath.js';

const EPS = 1e-9;
const TAU = Math.PI * 2;
const HORIZONTAL_PLANE_TOLERANCE = 1e-7;
const DEFAULT_CONTAINMENT_TOLERANCE_MM = 1e-6;

function finite(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function point2(value) {
  const x = finite(value?.x);
  const y = finite(value?.y);
  return x === null || y === null ? null : { x, y };
}

function subtract(left, right) {
  return { x: left.x - right.x, y: left.y - right.y };
}

function dot(left, right) {
  return left.x * right.x + left.y * right.y;
}

function distance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function normalizeAnglePositive(angle) {
  const value = angle % TAU;
  return value < 0 ? value + TAU : value;
}

function angleOnSweep(angle, sweep) {
  if (Math.abs(sweep) >= TAU - EPS) return true;
  if (sweep >= 0) return normalizeAnglePositive(angle) <= sweep + EPS;
  return normalizeAnglePositive(-angle) <= -sweep + EPS;
}

function horizontalArcBasis(primitive) {
  const center = point2(primitive?.center);
  const start = point2(getPrimitiveStart(primitive));
  const radius = finite(primitive?.radius);
  const sweep = finite(primitive?.sweepAngleRad);
  const nx = finite(primitive?.planeNormal?.x);
  const ny = finite(primitive?.planeNormal?.y);
  const nz = finite(primitive?.planeNormal?.z);
  const normalLength = nx === null || ny === null || nz === null ? null : Math.hypot(nx, ny, nz);
  if (!center || !start || !(radius > 0) || sweep === null || !(normalLength > EPS)) {
    return { resolved: false, reason: 'horizontal-boundary-arc-geometry-unresolved' };
  }
  if (
    Math.abs(nx / normalLength) > HORIZONTAL_PLANE_TOLERANCE ||
    Math.abs(ny / normalLength) > HORIZONTAL_PLANE_TOLERANCE ||
    Math.abs(Math.abs(nz / normalLength) - 1) > HORIZONTAL_PLANE_TOLERANCE
  ) {
    return { resolved: false, reason: 'horizontal-boundary-arc-plane-not-horizontal' };
  }
  const startDirection = {
    x: (start.x - center.x) / radius,
    y: (start.y - center.y) / radius,
  };
  const startLength = Math.hypot(startDirection.x, startDirection.y);
  if (!(startLength > EPS)) {
    return { resolved: false, reason: 'horizontal-boundary-arc-start-unresolved' };
  }
  const s = { x: startDirection.x / startLength, y: startDirection.y / startLength };
  const normalSign = nz >= 0 ? 1 : -1;
  const t = { x: -normalSign * s.y, y: normalSign * s.x };
  return { resolved: true, center, radius, sweep, s, t };
}

function uniqueAngles(values) {
  return [...new Set(values.filter(Number.isFinite).map((value) => value.toFixed(12)))].map(Number);
}

function candidateAngles(sweep, criticalAngles) {
  const values = [0, sweep];
  for (const critical of criticalAngles) {
    for (const turn of [-2, -1, 0, 1, 2]) {
      const candidate = critical + turn * TAU;
      if (angleOnSweep(candidate, sweep)) values.push(candidate);
    }
  }
  return uniqueAngles(values);
}

function arcPoint(basis, angle) {
  return {
    x: basis.center.x + basis.radius * (basis.s.x * Math.cos(angle) + basis.t.x * Math.sin(angle)),
    y: basis.center.y + basis.radius * (basis.s.y * Math.cos(angle) + basis.t.y * Math.sin(angle)),
  };
}

function primitiveProjectionRange(primitive, origin, axis) {
  if (primitive?.type === 'line') {
    const start = point2(primitive.start);
    const end = point2(primitive.end);
    if (!start || !end) return { resolved: false, reason: 'horizontal-boundary-line-unresolved' };
    const values = [dot(subtract(start, origin), axis), dot(subtract(end, origin), axis)];
    return { resolved: true, min: Math.min(...values), max: Math.max(...values) };
  }
  if (primitive?.type !== 'arc') {
    return { resolved: false, reason: 'horizontal-boundary-primitive-unsupported' };
  }
  const basis = horizontalArcBasis(primitive);
  if (!basis.resolved) return basis;
  const a = dot(basis.s, axis);
  const b = dot(basis.t, axis);
  const critical = Math.atan2(b, a);
  const angles = candidateAngles(basis.sweep, [critical, critical + Math.PI]);
  const values = angles.map((angle) => dot(subtract(arcPoint(basis, angle), origin), axis));
  return { resolved: true, min: Math.min(...values), max: Math.max(...values) };
}

function primitiveMaximumRadius(primitive, center) {
  if (primitive?.type === 'line') {
    const start = point2(primitive.start);
    const end = point2(primitive.end);
    if (!start || !end) return { resolved: false, reason: 'horizontal-boundary-line-unresolved' };
    return {
      resolved: true,
      maxRadiusMm: Math.max(distance(start, center), distance(end, center)),
    };
  }
  if (primitive?.type !== 'arc') {
    return { resolved: false, reason: 'horizontal-boundary-primitive-unsupported' };
  }
  const basis = horizontalArcBasis(primitive);
  if (!basis.resolved) return basis;
  const offset = subtract(basis.center, center);
  const a = dot(offset, basis.s);
  const b = dot(offset, basis.t);
  const critical = Math.atan2(b, a);
  const angles = candidateAngles(basis.sweep, [critical]);
  const maxRadiusMm = Math.max(...angles.map((angle) => distance(arcPoint(basis, angle), center)));
  return { resolved: true, maxRadiusMm };
}

function normalizeBoundary(boundary, index) {
  const center = point2(boundary?.center);
  const shape = String(boundary?.shape || '')
    .trim()
    .toUpperCase();
  const id = String(boundary?.id || index);
  if (!center) return { resolved: false, reason: 'column-plan-boundary-center-unresolved', id };

  if (shape === 'RECTANGLE') {
    const widthX = finite(boundary?.widthX);
    const widthY = finite(boundary?.widthY);
    const rotateRad = finite(boundary?.rotateRad) ?? 0;
    if (!(widthX > 0) || !(widthY > 0) || !Number.isFinite(rotateRad)) {
      return { resolved: false, reason: 'column-plan-rectangle-unresolved', id };
    }
    return { resolved: true, id, shape, center, widthX, widthY, rotateRad };
  }

  if (shape === 'CIRCLE') {
    const diameter = finite(boundary?.diameter ?? boundary?.widthX);
    if (!(diameter > 0)) {
      return { resolved: false, reason: 'column-plan-circle-unresolved', id };
    }
    return { resolved: true, id, shape, center, diameter };
  }

  return { resolved: false, reason: 'column-plan-boundary-shape-unsupported', id };
}

function rectangleContainment(path, boundary, pathRadiusMm, toleranceMm) {
  const cos = Math.cos(boundary.rotateRad);
  const sin = Math.sin(boundary.rotateRad);
  const axes = [
    { name: 'X', axis: { x: cos, y: sin }, limit: boundary.widthX / 2 - pathRadiusMm },
    { name: 'Y', axis: { x: -sin, y: cos }, limit: boundary.widthY / 2 - pathRadiusMm },
  ];
  if (axes.some((item) => !(item.limit > 0))) {
    return { resolved: false, ok: false, reason: 'column-plan-boundary-too-small' };
  }

  const ranges = [];
  for (const item of axes) {
    let min = Infinity;
    let max = -Infinity;
    for (const primitive of path.primitives) {
      const range = primitiveProjectionRange(primitive, boundary.center, item.axis);
      if (!range.resolved) return { resolved: false, ok: false, reason: range.reason };
      min = Math.min(min, range.min);
      max = Math.max(max, range.max);
    }
    ranges.push({ axis: item.name, min, max, limit: item.limit });
  }

  const outside = ranges.filter(
    (range) => range.min < -range.limit - toleranceMm || range.max > range.limit + toleranceMm,
  );
  return {
    resolved: true,
    ok: outside.length === 0,
    reason: outside.length ? 'horizontal-path-column-plan-boundary-exceeded' : null,
    ranges,
  };
}

function circleContainment(path, boundary, pathRadiusMm, toleranceMm) {
  const limit = boundary.diameter / 2 - pathRadiusMm;
  if (!(limit > 0)) {
    return { resolved: false, ok: false, reason: 'column-plan-boundary-too-small' };
  }

  let maxRadiusMm = 0;
  for (const primitive of path.primitives) {
    const measured = primitiveMaximumRadius(primitive, boundary.center);
    if (!measured.resolved) return { resolved: false, ok: false, reason: measured.reason };
    maxRadiusMm = Math.max(maxRadiusMm, measured.maxRadiusMm);
  }
  const ok = maxRadiusMm <= limit + toleranceMm;
  return {
    resolved: true,
    ok,
    reason: ok ? null : 'horizontal-path-column-plan-boundary-exceeded',
    maxRadiusMm,
    limit,
  };
}

/**
 * pathの鉄筋外径を含むplan envelopeが、すべてのattached column boundary内に収まるか判定する。
 *
 * @param {object} path world-coordinate RebarPath
 * @param {Array<object>} boundaries column plan boundaries
 * @param {{pathOuterDiameterMm?:number, containmentToleranceMm?:number}} options
 */
export function evaluateHorizontalRebarPathPlanBoundary(path, boundaries, options = {}) {
  if (!Array.isArray(path?.primitives) || path.primitives.length === 0) {
    return { resolved: false, ok: false, reason: 'horizontal-path-required', boundaries: [] };
  }
  const pathOuterDiameterMm = finite(options.pathOuterDiameterMm);
  if (!(pathOuterDiameterMm > 0)) {
    return {
      resolved: false,
      ok: false,
      reason: 'horizontal-path-outer-diameter-required',
      boundaries: [],
    };
  }
  if (!Array.isArray(boundaries) || boundaries.length === 0) {
    return {
      resolved: false,
      ok: false,
      reason: 'column-plan-boundary-required',
      boundaries: [],
    };
  }
  const toleranceMm = finite(options.containmentToleranceMm) ?? DEFAULT_CONTAINMENT_TOLERANCE_MM;
  const pathRadiusMm = pathOuterDiameterMm / 2;
  const results = [];

  for (const [index, rawBoundary] of boundaries.entries()) {
    const boundary = normalizeBoundary(rawBoundary, index);
    if (!boundary.resolved) {
      return {
        resolved: false,
        ok: false,
        reason: boundary.reason,
        boundaryId: boundary.id,
        boundaries: results,
      };
    }
    const measured =
      boundary.shape === 'RECTANGLE'
        ? rectangleContainment(path, boundary, pathRadiusMm, toleranceMm)
        : circleContainment(path, boundary, pathRadiusMm, toleranceMm);
    if (!measured.resolved) {
      return {
        resolved: false,
        ok: false,
        reason: measured.reason,
        boundaryId: boundary.id,
        boundaries: results,
      };
    }
    results.push({ id: boundary.id, shape: boundary.shape, ...measured });
  }

  results.sort((left, right) => left.id.localeCompare(right.id));
  const blockers = results.filter((item) => !item.ok);
  return {
    resolved: true,
    ok: blockers.length === 0,
    reason: blockers.length ? 'horizontal-path-column-plan-boundary-exceeded' : null,
    blockers,
    boundaries: results,
  };
}
