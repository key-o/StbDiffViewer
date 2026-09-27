/**
 * @fileoverview Phase 6b-O5 actual-path source RebarPath resolver.
 *
 * O3 mutation-plan referencesをcurrent render plan / wall topologyへ再照合し、
 * stale pathIndex・identity・semantic mismatchをactual geometry生成前にfail-closedにする。
 */

import { buildWallRebarTopologySnapshot } from './wallRebarTopology.js';

function finite(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function close(left, right, toleranceMm) {
  const a = finite(left);
  const b = finite(right);
  return a !== null && b !== null && Math.abs(a - b) <= toleranceMm;
}

function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function worldToLocal(frame, point) {
  const delta = subtract(point, frame.origin);
  return {
    x: dot(delta, frame.xAxis),
    y: dot(delta, frame.yAxis),
    z: dot(delta, frame.zAxis),
  };
}

function singleLine(path) {
  return path?.primitives?.length === 1 && path.primitives[0]?.type === 'line'
    ? path.primitives[0]
    : null;
}

function sourcePathForRef(renderPlan, ref) {
  const index = Number(ref?.pathIndex);
  if (!Number.isInteger(index) || index < 0 || index >= (renderPlan?.paths || []).length) {
    return null;
  }
  const path = renderPlan.paths[index];
  if (text(path?.metadata?.identityKey) !== text(ref?.sourceIdentityKey)) return null;
  if (path?.metadata?.role !== 'wallMain' || path?.metadata?.memberType !== 'wall') return null;
  return { path, pathIndex: index };
}

export function axisValue(point, direction) {
  return direction === 'VERTICAL' ? point.y : point.x;
}

function crossAxisValue(point, direction) {
  return direction === 'VERTICAL' ? point.x : point.y;
}

export function setAxisValue(point, direction, value) {
  return direction === 'VERTICAL' ? { ...point, y: value } : { ...point, x: value };
}

export function setCrossAxisValue(point, direction, value) {
  return direction === 'VERTICAL' ? { ...point, x: value } : { ...point, y: value };
}

export function axisDirection(direction) {
  return direction === 'VERTICAL' ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
}

function localLine(path, frame) {
  const line = singleLine(path);
  if (!line) return null;
  const start = worldToLocal(frame, line.start);
  const end = worldToLocal(frame, line.end);
  if (![start, end].flatMap((point) => Object.values(point)).every(Number.isFinite)) return null;
  return { start, end };
}

function endpointMatchingGap(line, gap, direction, toleranceMm) {
  const candidates = [line.start, line.end].filter(
    (point) =>
      close(point.z, gap.z, toleranceMm) &&
      close(axisValue(point, direction), axisValue(gap, direction), toleranceMm) &&
      close(crossAxisValue(point, direction), crossAxisValue(gap, direction), toleranceMm),
  );
  if (candidates.length !== 1) return null;
  const point = candidates[0];
  const other = point === line.start ? line.end : line.start;
  return { point, other };
}

function sourceTopologyMatches(renderPlan, entry, modelSource, toleranceMm) {
  const memberId = text(entry?.memberId);
  const barIdentity = text(entry?.barIdentity);
  const refs = [entry?.beforePathRef, entry?.afterPathRef];
  if (!memberId || !barIdentity || refs.some((ref) => !ref)) return false;

  const topology = buildWallRebarTopologySnapshot(renderPlan, { modelSource });
  if (
    !Array.isArray(topology?.facts) ||
    !Array.isArray(topology?.unresolved) ||
    topology.unresolved.some((item) => String(item?.memberId) === memberId)
  ) {
    return false;
  }

  const matched = refs.map((ref) =>
    topology.facts.filter(
      (fact) =>
        String(fact?.memberId) === memberId &&
        fact?.role === 'wallMain' &&
        fact?.semanticIdentity === barIdentity &&
        fact?.sourceIdentityKey === ref?.sourceIdentityKey &&
        fact?.segmentIdentity === ref?.segmentIdentity &&
        fact?.direction === entry?.direction &&
        text(fact?.face) === text(entry?.face) &&
        close(fact?.dia, entry?.diaMm, toleranceMm) &&
        text(fact?.diaName) === text(entry?.diaName) &&
        text(fact?.grade) === text(entry?.grade),
    ),
  );
  if (matched.some((values) => values.length !== 1)) return false;
  return matched[0][0].segmentIdentity !== matched[1][0].segmentIdentity;
}

function resolveSourceGeometry(renderPlan, entry, frame, toleranceMm) {
  const beforeIndexed = sourcePathForRef(renderPlan, entry?.beforePathRef);
  const afterIndexed = sourcePathForRef(renderPlan, entry?.afterPathRef);
  if (!beforeIndexed || !afterIndexed || beforeIndexed.pathIndex === afterIndexed.pathIndex) {
    return null;
  }

  const before = localLine(beforeIndexed.path, frame);
  const after = localLine(afterIndexed.path, frame);
  if (!before || !after) return null;

  const direction = entry?.direction;
  if (!['VERTICAL', 'HORIZONTAL'].includes(direction)) return null;
  if (
    beforeIndexed.path.metadata?.direction !== direction ||
    afterIndexed.path.metadata?.direction !== direction ||
    text(beforeIndexed.path.metadata?.face) !== text(entry?.face) ||
    text(afterIndexed.path.metadata?.face) !== text(entry?.face) ||
    !close(beforeIndexed.path.metadata?.dia, entry?.diaMm, toleranceMm) ||
    !close(afterIndexed.path.metadata?.dia, entry?.diaMm, toleranceMm)
  ) {
    return null;
  }

  const beforeGap = {
    x: finite(entry?.gapStartLocal?.x),
    y: finite(entry?.gapStartLocal?.y),
    z: before.start.z,
  };
  const afterGap = {
    x: finite(entry?.gapEndLocal?.x),
    y: finite(entry?.gapEndLocal?.y),
    z: after.start.z,
  };
  if ([beforeGap.x, beforeGap.y, afterGap.x, afterGap.y].some((value) => value === null)) {
    return null;
  }

  const beforeMatch = endpointMatchingGap(before, beforeGap, direction, toleranceMm);
  const afterMatch = endpointMatchingGap(after, afterGap, direction, toleranceMm);
  if (!beforeMatch || !afterMatch) return null;

  const beforeAxis = axisValue(beforeMatch.point, direction);
  const afterAxis = axisValue(afterMatch.point, direction);
  if (!(afterAxis > beforeAxis + toleranceMm)) return null;
  if (!(axisValue(beforeMatch.other, direction) < beforeAxis - toleranceMm)) return null;
  if (!(axisValue(afterMatch.other, direction) > afterAxis + toleranceMm)) return null;
  if (
    !close(
      crossAxisValue(beforeMatch.point, direction),
      crossAxisValue(afterMatch.point, direction),
      toleranceMm,
    ) ||
    !close(beforeMatch.point.z, afterMatch.point.z, toleranceMm)
  ) {
    return null;
  }

  return {
    beforePath: beforeIndexed.path,
    afterPath: afterIndexed.path,
    beforePathIndex: beforeIndexed.pathIndex,
    afterPathIndex: afterIndexed.pathIndex,
    beforeOuter: beforeMatch.other,
    gapStart: beforeMatch.point,
    gapEnd: afterMatch.point,
    afterOuter: afterMatch.other,
    direction,
    baseCross: crossAxisValue(beforeMatch.point, direction),
    z: beforeMatch.point.z,
  };
}

export function resolveSmallOpeningWallActualPathSource(
  renderPlan,
  entry,
  frame,
  modelSource,
  toleranceMm,
) {
  if (!sourceTopologyMatches(renderPlan, entry, modelSource, toleranceMm)) {
    return {
      ok: false,
      reason: 'small-opening-wall-actual-path-source-semantic-mismatch',
      source: null,
    };
  }

  const source = resolveSourceGeometry(renderPlan, entry, frame, toleranceMm);
  if (!source) {
    return {
      ok: false,
      reason: 'small-opening-wall-actual-path-source-stale',
      source: null,
    };
  }
  return { ok: true, reason: null, source };
}
