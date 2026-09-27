/**
 * @fileoverview Issue #302 Phase 5c-B: horizontal dogleg RebarPath と柱主筋のplan clearance。
 *
 * horizontal bendをproductionへ接続する前に、endpointだけでなくLine / Arcを含む
 * centerline全体と垂直な柱主筋のplan上最小距離を評価する。
 *
 * このkernelはhorizontal-plane Arcだけを対象とする。Arc面が水平でない場合は
 * 推定投影せずfail-closedとする。
 */

import { getPrimitiveEnd, getPrimitiveStart } from './rebarPath.js';

const EPS = 1e-9;
const TAU = Math.PI * 2;
const DEFAULT_COLLISION_TOLERANCE_MM = 0.5;
const HORIZONTAL_PLANE_TOLERANCE = 1e-7;

function finite(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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

function point2(value) {
  const x = finite(value?.x);
  const y = finite(value?.y);
  return x === null || y === null ? null : { x, y };
}

function distance2(left, right) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function pointToSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length2 = dx * dx + dy * dy;
  if (!(length2 > EPS)) return distance2(point, start);
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / length2),
  );
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

function horizontalArcDistance(point, primitive) {
  const center = point2(primitive?.center);
  const start = point2(getPrimitiveStart(primitive));
  const end = point2(getPrimitiveEnd(primitive));
  const radius = finite(primitive?.radius);
  const sweep = finite(primitive?.sweepAngleRad);
  const normalX = finite(primitive?.planeNormal?.x);
  const normalY = finite(primitive?.planeNormal?.y);
  const normalZ = finite(primitive?.planeNormal?.z);
  const normalLength =
    normalX === null || normalY === null || normalZ === null
      ? null
      : Math.hypot(normalX, normalY, normalZ);
  if (!center || !start || !end || !(radius > 0) || sweep === null) {
    return { resolved: false, reason: 'horizontal-path-arc-geometry-unresolved' };
  }
  if (
    !(normalLength > EPS) ||
    Math.abs(normalX / normalLength) > HORIZONTAL_PLANE_TOLERANCE ||
    Math.abs(normalY / normalLength) > HORIZONTAL_PLANE_TOLERANCE ||
    Math.abs(Math.abs(normalZ / normalLength) - 1) > HORIZONTAL_PLANE_TOLERANCE
  ) {
    return { resolved: false, reason: 'horizontal-path-arc-plane-not-horizontal' };
  }

  const sx = (start.x - center.x) / radius;
  const sy = (start.y - center.y) / radius;
  const radial = Math.hypot(point.x - center.x, point.y - center.y);
  if (!(Math.hypot(sx, sy) > EPS)) {
    return { resolved: false, reason: 'horizontal-path-arc-start-unresolved' };
  }
  if (!(radial > EPS)) {
    return { resolved: true, distanceMm: radius };
  }

  const px = (point.x - center.x) / radial;
  const py = (point.y - center.y) / radial;
  const signedAngle = Math.atan2(sx * py - sy * px, sx * px + sy * py);
  const orientedAngle = normalZ >= 0 ? signedAngle : -signedAngle;
  if (angleOnSweep(orientedAngle, sweep)) {
    return { resolved: true, distanceMm: Math.abs(radial - radius) };
  }
  return {
    resolved: true,
    distanceMm: Math.min(distance2(point, start), distance2(point, end)),
  };
}

function primitivePlanDistance(point, primitive) {
  if (primitive?.type === 'line') {
    const start = point2(primitive.start);
    const end = point2(primitive.end);
    if (!start || !end) return { resolved: false, reason: 'horizontal-path-line-unresolved' };
    return { resolved: true, distanceMm: pointToSegmentDistance(point, start, end) };
  }
  if (primitive?.type === 'arc') return horizontalArcDistance(point, primitive);
  return { resolved: false, reason: 'horizontal-path-primitive-unsupported' };
}

function obstacleIdentity(obstacle, index) {
  return String(obstacle?.semanticIdentity || obstacle?.id || index);
}

/**
 * @param {object} path world-coordinate RebarPath
 * @param {Array<object>} obstacles vertical column-main-bar facts
 * @param {{pathOuterDiameterMm?:number, collisionToleranceMm?:number}} options
 */
export function evaluateHorizontalRebarPathPlanClearance(path, obstacles, options = {}) {
  const primitives = path?.primitives;
  if (!Array.isArray(primitives) || primitives.length === 0) {
    return { resolved: false, ok: false, reason: 'horizontal-path-required', blockers: [] };
  }
  const pathOuterDiameterMm = finite(options.pathOuterDiameterMm);
  if (!(pathOuterDiameterMm > 0)) {
    return {
      resolved: false,
      ok: false,
      reason: 'horizontal-path-outer-diameter-required',
      blockers: [],
    };
  }
  if (!Array.isArray(obstacles) || obstacles.length === 0) {
    return {
      resolved: false,
      ok: false,
      reason: 'column-main-bar-obstacles-required',
      blockers: [],
    };
  }
  const collisionToleranceMm =
    finite(options.collisionToleranceMm) ?? DEFAULT_COLLISION_TOLERANCE_MM;
  if (!(collisionToleranceMm >= 0)) {
    return {
      resolved: false,
      ok: false,
      reason: 'horizontal-path-collision-tolerance-invalid',
      blockers: [],
    };
  }

  const rows = [];
  for (const [index, obstacle] of obstacles.entries()) {
    const point = point2(obstacle?.worldPosition);
    const obstacleOuterDiameterMm = finite(obstacle?.outerDiameterMm);
    if (!point || !(obstacleOuterDiameterMm > 0)) {
      return {
        resolved: false,
        ok: false,
        reason: 'column-main-bar-geometry-unresolved',
        blocker: obstacleIdentity(obstacle, index),
        blockers: [],
      };
    }

    let minimumCenterDistanceMm = Infinity;
    for (const primitive of primitives) {
      const measured = primitivePlanDistance(point, primitive);
      if (!measured.resolved) {
        return {
          resolved: false,
          ok: false,
          reason: measured.reason,
          blocker: obstacleIdentity(obstacle, index),
          blockers: [],
        };
      }
      minimumCenterDistanceMm = Math.min(minimumCenterDistanceMm, measured.distanceMm);
    }

    const requiredCenterDistanceMm =
      (pathOuterDiameterMm + obstacleOuterDiameterMm) / 2 + collisionToleranceMm;
    const clearMm = minimumCenterDistanceMm - (pathOuterDiameterMm + obstacleOuterDiameterMm) / 2;
    rows.push({
      semanticIdentity: obstacleIdentity(obstacle, index),
      minimumCenterDistanceMm,
      requiredCenterDistanceMm,
      clearMm,
      collisionToleranceMm,
      collision: minimumCenterDistanceMm < requiredCenterDistanceMm - EPS,
    });
  }

  rows.sort((left, right) => left.semanticIdentity.localeCompare(right.semanticIdentity));
  const blockers = rows.filter((row) => row.collision);
  const minimumClearMm = Math.min(...rows.map((row) => row.clearMm));
  return {
    resolved: true,
    ok: blockers.length === 0,
    reason: blockers.length ? 'horizontal-path-column-main-bar-clearance-conflict' : null,
    minimumClearMm,
    collisionToleranceMm,
    blockers,
    rows,
  };
}
