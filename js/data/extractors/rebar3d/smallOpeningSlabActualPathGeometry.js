/**
 * @fileoverview Phase 6b-O7b slab small-opening actual path geometry helpers.
 * Pure slab-local/world transformation, opening clipping, SHIFT/BEND candidate generation only.
 */

import {
  createLine,
  createRebarPath,
  getPathEnd,
  getPathStart,
  rebarPathToLineSegments,
} from './rebarPath.js';
import { buildDoglegTransitionPath } from './rebarTransitionArcGeometry.js';

export const MAX_GEOMETRY_TOLERANCE_MM = 0.01;

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale(value, factor) {
  return { x: value.x * factor, y: value.y * factor, z: value.z * factor };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function distance(a, b) {
  const delta = subtract(a, b);
  return Math.hypot(delta.x, delta.y, delta.z);
}

function worldPointToLocal(frame, point) {
  const rel = subtract(point, frame.origin);
  return {
    x: dot(rel, frame.xAxis),
    y: dot(rel, frame.yAxis),
    z: dot(rel, frame.normal),
  };
}

function worldVectorToLocal(frame, vector) {
  return {
    x: dot(vector, frame.xAxis),
    y: dot(vector, frame.yAxis),
    z: dot(vector, frame.normal),
  };
}

function localPointToWorld(frame, point) {
  return add(
    add(add(frame.origin, scale(frame.xAxis, point.x)), scale(frame.yAxis, point.y)),
    scale(frame.normal, point.z || 0),
  );
}

function localVectorToWorld(frame, vector) {
  return add(
    add(scale(frame.xAxis, vector.x), scale(frame.yAxis, vector.y)),
    scale(frame.normal, vector.z || 0),
  );
}

function primitiveToLocal(frame, primitive) {
  if (primitive?.type === 'line') {
    return createLine(
      worldPointToLocal(frame, primitive.start),
      worldPointToLocal(frame, primitive.end),
    );
  }
  if (primitive?.type === 'arc') {
    return {
      ...primitive,
      center: worldPointToLocal(frame, primitive.center),
      planeNormal: worldVectorToLocal(frame, primitive.planeNormal),
      startDirection: worldVectorToLocal(frame, primitive.startDirection),
    };
  }
  return null;
}

function primitiveToWorld(frame, primitive) {
  if (primitive?.type === 'line') {
    return createLine(
      localPointToWorld(frame, primitive.start),
      localPointToWorld(frame, primitive.end),
    );
  }
  if (primitive?.type === 'arc') {
    return {
      ...primitive,
      center: localPointToWorld(frame, primitive.center),
      planeNormal: localVectorToWorld(frame, primitive.planeNormal),
      startDirection: localVectorToWorld(frame, primitive.startDirection),
    };
  }
  return null;
}

export function toSlabLocalPath(frame, path, metadata = path?.metadata || {}) {
  const primitives = (path?.primitives || []).map((primitive) =>
    primitiveToLocal(frame, primitive),
  );
  if (primitives.length === 0 || primitives.some((primitive) => !primitive)) return null;
  return createRebarPath(primitives, metadata);
}

export function toSlabWorldPath(frame, path, metadata = path?.metadata || {}) {
  const primitives = (path?.primitives || []).map((primitive) =>
    primitiveToWorld(frame, primitive),
  );
  if (primitives.length === 0 || primitives.some((primitive) => !primitive)) return null;
  return createRebarPath(primitives, metadata);
}

function translatePrimitive(primitive, delta) {
  if (primitive?.type === 'line') {
    return createLine(add(primitive.start, delta), add(primitive.end, delta));
  }
  if (primitive?.type === 'arc') {
    return { ...primitive, center: add(primitive.center, delta) };
  }
  return null;
}

function translatePath(path, delta, metadata) {
  const primitives = (path?.primitives || []).map((primitive) =>
    translatePrimitive(primitive, delta),
  );
  if (primitives.length === 0 || primitives.some((primitive) => !primitive)) return null;
  return createRebarPath(primitives, metadata);
}

function axisDirection(runAxis) {
  return runAxis === 'x' ? { x: 1, y: 0, z: 0 } : runAxis === 'y' ? { x: 0, y: 1, z: 0 } : null;
}

function runValue(point, runAxis) {
  return runAxis === 'x' ? point.x : runAxis === 'y' ? point.y : NaN;
}

function crossValue(point, runAxis) {
  return runAxis === 'x' ? point.y : runAxis === 'y' ? point.x : NaN;
}

function pointAt(runAxis, run, cross, z) {
  return runAxis === 'x' ? { x: run, y: cross, z } : { x: cross, y: run, z };
}

function crossDelta(runAxis, amount) {
  return runAxis === 'x' ? { x: 0, y: amount, z: 0 } : { x: amount, y: 0, z: 0 };
}

function toOpeningCoordinates(opening, point) {
  const dx = point.x - opening.positionX;
  const dy = point.y - opening.positionY;
  const cos = Math.cos(opening.rotationRad);
  const sin = Math.sin(opening.rotationRad);
  return {
    u: dx * cos + dy * sin,
    v: -dx * sin + dy * cos,
  };
}

function clipAxis(start, delta, min, max, interval) {
  if (Math.abs(delta) <= 1e-12) {
    return start >= min && start <= max ? interval : null;
  }
  const first = (min - start) / delta;
  const second = (max - start) / delta;
  const low = Math.min(first, second);
  const high = Math.max(first, second);
  const t0 = Math.max(interval[0], low);
  const t1 = Math.min(interval[1], high);
  return t0 <= t1 ? [t0, t1] : null;
}

export function clipSegmentToOpening(start, end, opening, insetMm = 0) {
  const a = toOpeningCoordinates(opening, start);
  const b = toOpeningCoordinates(opening, end);
  const minU = insetMm;
  const maxU = opening.width - insetMm;
  const minV = insetMm;
  const maxV = opening.height - insetMm;
  if (!(maxU > minU && maxV > minV)) return null;

  let interval = [0, 1];
  interval = clipAxis(a.u, b.u - a.u, minU, maxU, interval);
  if (!interval) return null;
  interval = clipAxis(a.v, b.v - a.v, minV, maxV, interval);
  if (!interval || interval[1] - interval[0] <= 1e-12) return null;
  return interval;
}

export function segmentCrossesOpeningInterior(start, end, opening, toleranceMm) {
  return Boolean(clipSegmentToOpening(start, end, opening, toleranceMm));
}

export function pathOutsideOpening(path, opening, toleranceMm) {
  if (!Number.isFinite(toleranceMm) || toleranceMm < 0 || toleranceMm > MAX_GEOMETRY_TOLERANCE_MM) {
    return false;
  }
  const segments = rebarPathToLineSegments(path, { maxArcAngleRad: Math.PI / 180 });
  if (segments.length === 0) return false;
  return segments.every(
    (segment) => !segmentCrossesOpeningInterior(segment.start, segment.end, opening, toleranceMm),
  );
}

export function pathInsideSlabAndOutsideOpening(path, frame, opening, toleranceMm) {
  if (!Number.isFinite(toleranceMm) || toleranceMm < 0 || toleranceMm > MAX_GEOMETRY_TOLERANCE_MM) {
    return false;
  }
  const segments = rebarPathToLineSegments(path, { maxArcAngleRad: Math.PI / 180 });
  if (segments.length === 0 || !pathOutsideOpening(path, opening, toleranceMm)) return false;
  for (const segment of segments) {
    for (const point of [segment.start, segment.end]) {
      if (
        point.x < -toleranceMm ||
        point.x > frame.width + toleranceMm ||
        point.y < -toleranceMm ||
        point.y > frame.height + toleranceMm
      ) {
        return false;
      }
    }
  }
  return true;
}

function optionalLine(start, end, dia, grade, toleranceMm) {
  if (distance(start, end) <= toleranceMm) return null;
  return createRebarPath([createLine(start, end)], { dia, grade });
}

function concatPaths(parts, metadata, toleranceMm) {
  const primitives = [];
  for (const part of parts) {
    if (!part) continue;
    for (const primitive of part.primitives || []) {
      const previous = primitives[primitives.length - 1];
      if (previous) {
        const previousEnd = getPathEnd(createRebarPath([previous]));
        const currentStart = getPathStart(createRebarPath([primitive]));
        if (!previousEnd || !currentStart || distance(previousEnd, currentStart) > toleranceMm) {
          return null;
        }
      }
      primitives.push(primitive);
    }
  }
  return primitives.length > 0 ? createRebarPath(primitives, metadata) : null;
}

export function sourceHasBoundaryDetailing(path) {
  const metadata = path?.metadata || {};
  return Boolean(
    metadata.boundaryStartMode ||
    metadata.boundaryEndMode ||
    (path?.primitives || []).some((primitive) => primitive?.type !== 'line') ||
    (path?.primitives || []).length !== 1,
  );
}

export function buildSlabShiftLocalPath({ sourcePath, runAxis, shiftMm, metadata }) {
  return translatePath(sourcePath, crossDelta(runAxis, shiftMm), metadata);
}

export function buildSlabBendLocalPath({
  sourcePath,
  runAxis,
  crossCoordMm,
  openingGeometry,
  offsetMm,
  runMm,
  diaMm,
  grade,
  metadata,
  toleranceMm,
}) {
  const crossingLines = [];
  for (let index = 0; index < (sourcePath?.primitives || []).length; index += 1) {
    const primitive = sourcePath.primitives[index];
    if (primitive?.type !== 'line') continue;
    const crossing = clipSegmentToOpening(primitive.start, primitive.end, openingGeometry, 0);
    if (crossing) crossingLines.push({ primitiveIndex: index, line: primitive, crossing });
  }
  if (crossingLines.length !== 1) {
    return {
      ok: false,
      reason:
        crossingLines.length === 0
          ? 'small-opening-slab-bend-opening-intersection-unresolved'
          : 'small-opening-slab-bend-opening-intersection-ambiguous',
    };
  }

  const { primitiveIndex, line, crossing } = crossingLines[0];
  const startRun = runValue(line.start, runAxis);
  const endRun = runValue(line.end, runAxis);
  const startCross = crossValue(line.start, runAxis);
  const endCross = crossValue(line.end, runAxis);
  if (
    !Number.isFinite(startRun) ||
    !Number.isFinite(endRun) ||
    !(endRun > startRun + toleranceMm) ||
    Math.abs(startCross - crossCoordMm) > toleranceMm ||
    Math.abs(endCross - crossCoordMm) > toleranceMm ||
    Math.abs(line.start.z - line.end.z) > toleranceMm
  ) {
    return { ok: false, reason: 'small-opening-slab-bend-source-line-unresolved' };
  }

  const deltaRun = endRun - startRun;
  const entryRun = startRun + deltaRun * crossing[0];
  const exitRun = startRun + deltaRun * crossing[1];
  const z = line.start.z;
  const shiftedCross = crossCoordMm + offsetMm;
  const axis = axisDirection(runAxis);
  if (!axis) return { ok: false, reason: 'small-opening-slab-bend-axis-unresolved' };

  const firstBuilt = buildDoglegTransitionPath({
    sharpStart: pointAt(runAxis, entryRun - runMm, crossCoordMm, z),
    sharpEnd: pointAt(runAxis, entryRun, shiftedCross, z),
    incomingDirection: axis,
    outgoingDirection: axis,
    grade,
    barDiaMm: diaMm,
    metadata: { dia: diaMm, grade },
  });
  if (!firstBuilt.ok || !firstBuilt.path) {
    return {
      ok: false,
      reason: 'small-opening-slab-bend-entry-dogleg-unresolved',
      doglegReason: firstBuilt.reason || null,
    };
  }

  const secondBuilt = buildDoglegTransitionPath({
    sharpStart: pointAt(runAxis, exitRun, shiftedCross, z),
    sharpEnd: pointAt(runAxis, exitRun + runMm, crossCoordMm, z),
    incomingDirection: axis,
    outgoingDirection: axis,
    grade,
    barDiaMm: diaMm,
    metadata: { dia: diaMm, grade },
  });
  if (!secondBuilt.ok || !secondBuilt.path) {
    return {
      ok: false,
      reason: 'small-opening-slab-bend-exit-dogleg-unresolved',
      doglegReason: secondBuilt.reason || null,
    };
  }

  const firstStart = getPathStart(firstBuilt.path);
  const firstEnd = getPathEnd(firstBuilt.path);
  const secondStart = getPathStart(secondBuilt.path);
  const secondEnd = getPathEnd(secondBuilt.path);
  if (!firstStart || !firstEnd || !secondStart || !secondEnd) {
    return { ok: false, reason: 'small-opening-slab-bend-dogleg-endpoint-unresolved' };
  }
  if (
    runValue(firstStart, runAxis) < startRun - toleranceMm ||
    runValue(secondEnd, runAxis) > endRun + toleranceMm ||
    runValue(firstEnd, runAxis) >= runValue(secondStart, runAxis) - toleranceMm
  ) {
    return { ok: false, reason: 'small-opening-slab-bend-run-does-not-fit-source-span' };
  }

  const prefixPath = optionalLine(line.start, firstStart, diaMm, grade, toleranceMm);
  const central = optionalLine(firstEnd, secondStart, diaMm, grade, toleranceMm);
  const suffix = optionalLine(secondEnd, line.end, diaMm, grade, toleranceMm);
  if (!central) return { ok: false, reason: 'small-opening-slab-bend-central-run-unresolved' };

  const replacement = concatPaths(
    [prefixPath, firstBuilt.path, central, secondBuilt.path, suffix],
    metadata,
    toleranceMm,
  );
  if (!replacement) {
    return { ok: false, reason: 'small-opening-slab-bend-path-discontinuous' };
  }

  const primitives = [...(sourcePath?.primitives || [])];
  primitives.splice(primitiveIndex, 1, ...replacement.primitives);
  const path = createRebarPath(primitives, metadata);
  return {
    ok: true,
    path,
    firstBuilt,
    secondBuilt,
    sourcePrimitiveIndex: primitiveIndex,
  };
}
