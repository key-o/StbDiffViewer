/**
 * @fileoverview production-ready RebarPath間の実径ベース衝突判定。
 *
 * Arcは判定境界でのみ十分細かいchordへ分割し、各Line segment間の最短距離を評価する。
 * 描画meshには依存しない。
 */

import { rebarPathToLineSegments, validateRebarPath } from './rebarPath.js';

const EPS = 1e-9;

function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale(v, factor) {
  return { x: v.x * factor, y: v.y * factor, z: v.z * factor };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

/**
 * 3D線分同士の最短距離。
 * Ericson, Real-Time Collision Detectionのclosest pointsを退化線分対応で実装する。
 */
export function segmentSegmentDistance(a0, a1, b0, b1) {
  const u = subtract(a1, a0);
  const v = subtract(b1, b0);
  const w = subtract(a0, b0);
  const a = dot(u, u);
  const b = dot(u, v);
  const c = dot(v, v);
  const d = dot(u, w);
  const e = dot(v, w);

  let s;
  let t;
  if (a <= EPS && c <= EPS) {
    s = 0;
    t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = clamp01(e / c);
  } else if (c <= EPS) {
    t = 0;
    s = clamp01(-d / a);
  } else {
    const denom = a * c - b * b;
    s = denom > EPS ? clamp01((b * e - c * d) / denom) : 0;
    t = (b * s + e) / c;
    if (t < 0) {
      t = 0;
      s = clamp01(-d / a);
    } else if (t > 1) {
      t = 1;
      s = clamp01((b - d) / a);
    }
  }

  const pa = add(a0, scale(u, s));
  const pb = add(b0, scale(v, t));
  const delta = subtract(pa, pb);
  return {
    distanceMm: Math.hypot(delta.x, delta.y, delta.z),
    pointA: pa,
    pointB: pb,
    parameterA: s,
    parameterB: t,
  };
}

function pathDiameter(path) {
  const dia = Number(path?.metadata?.dia);
  return dia > 0 && Number.isFinite(dia) ? dia : null;
}

export function evaluateRebarPathCollision({
  sourcePaths,
  existingPaths,
  clearanceMm = 0,
  maxArcAngleRad = Math.PI / 36,
} = {}) {
  const sources = (sourcePaths || []).filter((path) => validateRebarPath(path).ok);
  const existing = (existingPaths || []).filter((path) => validateRebarPath(path).ok);
  const clearance = Number(clearanceMm);
  if (!Number.isFinite(clearance) || clearance < 0) {
    return { resolved: false, collision: false, reason: 'rebar-collision-clearance-invalid' };
  }

  for (const source of sources) {
    const sourceDia = pathDiameter(source);
    if (!sourceDia) continue;
    const sourceLines = rebarPathToLineSegments(source, { maxArcAngleRad });
    for (const target of existing) {
      const targetDia = pathDiameter(target);
      if (!targetDia) continue;
      const targetLines = rebarPathToLineSegments(target, { maxArcAngleRad });
      const thresholdMm = sourceDia / 2 + targetDia / 2 + clearance;

      for (const sourceLine of sourceLines) {
        for (const targetLine of targetLines) {
          const nearest = segmentSegmentDistance(
            sourceLine.start,
            sourceLine.end,
            targetLine.start,
            targetLine.end,
          );
          if (nearest.distanceMm < thresholdMm - 1e-6) {
            return {
              resolved: true,
              collision: true,
              reason: 'REBAR_COLLISION',
              thresholdMm,
              distanceMm: nearest.distanceMm,
              sourceIdentityKey: source.metadata?.identityKey || null,
              targetIdentityKey: target.metadata?.identityKey || null,
              sourceMemberId: source.metadata?.memberId || null,
              targetMemberId: target.metadata?.memberId || null,
              pointSource: nearest.pointA,
              pointTarget: nearest.pointB,
            };
          }
        }
      }
    }
  }

  return { resolved: true, collision: false, reason: null };
}
