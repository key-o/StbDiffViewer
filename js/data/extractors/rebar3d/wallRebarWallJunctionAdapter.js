/**
 * @fileoverview Issue #310 Phase 6a-D2b:
 * RC壁 L/T junction のactual wall factsをD1a/D1bへ接続し、bar-levelの
 * continuity / lap / anchorage assignmentをtrace-onlyで確定する。
 *
 * このmoduleはproduction RebarPathを変更しない。L1/L2値、補強筋径、W-001 splice gateは
 * 上流から明示入力されたfactsだけを使用し、欠落値を径・Fc・nearest geometryから推定しない。
 */

import { collectWallRebarFacts } from './wallRebarSectionFacts.js';
import { getCommonReinforcementStrengthMap } from '../reinforcementStrengthResolver.js';
import { buildWallRebarTopologySnapshot } from './wallRebarTopology.js';
import {
  buildWallWallJunctionTopologyFact,
  deriveWallWallJunctionTopology,
} from './wallRebarWallJunctionTopology.js';

const DEFAULT_TOLERANCE_MM = 1e-4;
const SUPPORTED_PATTERNS = new Set(['SINGLE', 'DOUBLE_NET']);

function finite(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positive(value) {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
}

function text(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function unresolved(reason, values = {}) {
  return Object.freeze({
    status: 'UNRESOLVED',
    reason,
    productionReady: false,
    ...values,
  });
}

function pointFromNode(node, offset) {
  const x = finite(node?.x);
  const y = finite(node?.y);
  const z = finite(node?.z);
  if (x === null || y === null || z === null) return null;
  return Object.freeze({
    x: x + (finite(offset?.x) ?? 0),
    y: y + (finite(offset?.y) ?? 0),
    z: z + (finite(offset?.z) ?? 0),
  });
}

function wallReferencePoints(wall, facts) {
  const result = [];
  for (const nodeId of wall?.nodeIds || []) {
    const node = facts?.nodes?.get?.(String(nodeId));
    if (!node) return null;
    const point = pointFromNode(node, wall?.offsets?.get?.(String(nodeId)));
    if (!point) return null;
    result.push(point);
  }
  return result;
}

function collapseCollinearPlanPoints(points, toleranceMm) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const anchor = points[0];
  const directionPoint = points.find(
    (point) => Math.hypot(point.x - anchor.x, point.y - anchor.y) > toleranceMm,
  );
  if (!directionPoint) return null;

  const directionX = directionPoint.x - anchor.x;
  const directionY = directionPoint.y - anchor.y;
  const directionLength = Math.hypot(directionX, directionY);
  if (!(directionLength > toleranceMm)) return null;

  let minProjection = Infinity;
  let maxProjection = -Infinity;
  let minPoint = null;
  let maxPoint = null;
  for (const point of points) {
    const crossDistance =
      Math.abs((point.x - anchor.x) * directionY - (point.y - anchor.y) * directionX) /
      directionLength;
    if (crossDistance > toleranceMm) return null;
    const projection =
      ((point.x - anchor.x) * directionX + (point.y - anchor.y) * directionY) / directionLength;
    if (projection < minProjection) {
      minProjection = projection;
      minPoint = point;
    }
    if (projection > maxProjection) {
      maxProjection = projection;
      maxPoint = point;
    }
  }
  if (!minPoint || !maxPoint || maxProjection - minProjection <= toleranceMm) return null;
  return Object.freeze([
    Object.freeze({ x: minPoint.x, y: minPoint.y }),
    Object.freeze({ x: maxPoint.x, y: maxPoint.y }),
  ]);
}

function wallPlanRun(wall, facts, toleranceMm) {
  const points = wallReferencePoints(wall, facts);
  if (!points || points.length < 2) return null;
  const unique = [];
  for (const point of points) {
    if (unique.some((value) => Math.hypot(value.x - point.x, value.y - point.y) <= toleranceMm)) {
      continue;
    }
    unique.push(Object.freeze({ x: point.x, y: point.y }));
  }
  const run = collapseCollinearPlanPoints(unique, toleranceMm);
  if (!run) return null;
  const zValues = points.map((point) => point.z).filter(Number.isFinite);
  if (zValues.length !== points.length) return null;
  return Object.freeze({
    start: run[0],
    end: run[1],
    verticalRange: Object.freeze({
      min: Math.min(...zValues),
      max: Math.max(...zValues),
    }),
  });
}

function verticalRangesOverlap(sourceRun, targetRun, toleranceMm) {
  const sourceMin = finite(sourceRun?.verticalRange?.min);
  const sourceMax = finite(sourceRun?.verticalRange?.max);
  const targetMin = finite(targetRun?.verticalRange?.min);
  const targetMax = finite(targetRun?.verticalRange?.max);
  if (
    sourceMin === null ||
    sourceMax === null ||
    targetMin === null ||
    targetMax === null ||
    sourceMax < sourceMin ||
    targetMax < targetMin
  ) {
    return false;
  }
  return Math.min(sourceMax, targetMax) + toleranceMm >= Math.max(sourceMin, targetMin);
}

function barForDirection(section, direction) {
  if (!section || !SUPPORTED_PATTERNS.has(section.pattern)) return null;
  const matches = (section.bars || []).filter((bar) => String(bar?.pos || '') === direction);
  return matches.length === 1 ? matches[0] : null;
}

function maxDiameter(bar) {
  const values = (bar?.diametersMm || []).map(positive).filter((value) => value !== null);
  return values.length ? Math.max(...values) : null;
}

function effectiveGrade(fact, strengths) {
  const explicit = text(fact?.grade);
  if (explicit) return Object.freeze({ grade: explicit, source: 'EXPLICIT' });
  const diaName = text(fact?.diaName)?.toUpperCase();
  const common = diaName ? strengths.get(diaName) || null : null;
  return Object.freeze({ grade: common, source: common ? 'COMMON' : 'UNRESOLVED' });
}

function linePrimitive(path) {
  const primitives = Array.isArray(path?.primitives) ? path.primitives : [];
  const lines = primitives.filter((primitive) => primitive?.type === 'line');
  return lines.length === 1 ? lines[0] : null;
}

function pointAtPlanStation(line, junctionPoint, toleranceMm) {
  const sx = finite(line?.start?.x);
  const sy = finite(line?.start?.y);
  const sz = finite(line?.start?.z);
  const ex = finite(line?.end?.x);
  const ey = finite(line?.end?.y);
  const ez = finite(line?.end?.z);
  const jx = finite(junctionPoint?.x);
  const jy = finite(junctionPoint?.y);
  if ([sx, sy, sz, ex, ey, ez, jx, jy].some((value) => value === null)) return null;

  const dx = ex - sx;
  const dy = ey - sy;
  const length2 = dx * dx + dy * dy;
  if (!(length2 > 0)) return null;
  const rawT = ((jx - sx) * dx + (jy - sy) * dy) / length2;
  const length = Math.sqrt(length2);
  const parameterTolerance = toleranceMm / Math.max(length, toleranceMm || 1);
  if (rawT < -parameterTolerance || rawT > 1 + parameterTolerance) return null;
  const t = Math.max(0, Math.min(1, rawT));
  return Object.freeze({
    x: sx + (ex - sx) * t,
    y: sy + (ey - sy) * t,
    z: sz + (ez - sz) * t,
    parameter: t,
    stationRole:
      rawT > parameterTolerance && rawT < 1 - parameterTolerance ? 'INTERIOR' : 'ENDPOINT',
  });
}

function lineVerticalPosition(line, toleranceMm) {
  const startZ = finite(line?.start?.z);
  const endZ = finite(line?.end?.z);
  if (startZ === null || endZ === null || Math.abs(startZ - endZ) > toleranceMm) return null;
  return (startZ + endZ) / 2;
}

function isWithinVerticalRange(z, verticalRange, toleranceMm) {
  const value = finite(z);
  const min = finite(verticalRange?.min);
  const max = finite(verticalRange?.max);
  return (
    value !== null &&
    min !== null &&
    max !== null &&
    min <= max &&
    value + toleranceMm >= min &&
    value - toleranceMm <= max
  );
}

function pathMap(renderPlan, memberId) {
  const map = new Map();
  const duplicate = new Set();
  const paths = Array.isArray(renderPlan?.paths) ? renderPlan.paths : [];
  for (const path of paths) {
    if (
      path?.metadata?.memberType !== 'wall' ||
      path?.metadata?.role !== 'wallMain' ||
      String(path?.metadata?.memberId) !== String(memberId)
    ) {
      continue;
    }
    const key = text(path.metadata.identityKey);
    if (!key) continue;
    if (map.has(key)) duplicate.add(key);
    map.set(key, path);
  }
  return { map, duplicate };
}

function semanticBarsAtJunction(
  memberId,
  topology,
  renderPlan,
  junctionPoint,
  strengths,
  toleranceMm,
  expectedHorizontalBarSlots,
  verticalRange,
  requireInteriorStation = false,
) {
  const index = pathMap(renderPlan, memberId);
  const grouped = new Map();
  const semanticSegments = new Map();
  const observedHorizontalBarSlots = new Set();
  for (const fact of topology?.facts || []) {
    if (String(fact?.memberId) !== String(memberId) || fact?.direction !== 'HORIZONTAL') continue;
    const semanticIdentity = text(fact.semanticIdentity);
    if (!semanticIdentity) {
      return unresolved('wall-wall-junction-bar-semantic-unresolved', {
        memberId: String(memberId),
      });
    }
    const barIndex = Number(fact.barIndex);
    const face = text(fact.face);
    if (!Number.isInteger(barIndex) || barIndex < 0 || !face) {
      return unresolved('wall-wall-junction-horizontal-bar-slot-unresolved', {
        memberId: String(memberId),
        semanticIdentity,
      });
    }
    const segmentIdentity = text(fact.segmentIdentity);
    if (!segmentIdentity) {
      return unresolved('wall-wall-junction-segment-identity-unresolved', {
        memberId: String(memberId),
        semanticIdentity,
      });
    }
    const sourceIdentityKey = text(fact.sourceIdentityKey);
    if (!sourceIdentityKey) {
      return unresolved('wall-wall-junction-source-path-missing', {
        memberId: String(memberId),
        segmentIdentity,
      });
    }
    if (index.duplicate.has(sourceIdentityKey)) {
      return unresolved('wall-wall-junction-duplicate-path-identity', {
        memberId: String(memberId),
      });
    }
    const path = index.map.get(sourceIdentityKey);
    if (!path) {
      return unresolved('wall-wall-junction-source-path-missing', {
        memberId: String(memberId),
        segmentIdentity,
      });
    }
    if (
      String(path.metadata.memberId) !== String(memberId) ||
      path.metadata.direction !== fact.direction ||
      text(path.metadata.face) !== face ||
      text(path.metadata.identityKey) !== sourceIdentityKey
    ) {
      return unresolved('wall-wall-junction-source-path-mismatch', {
        memberId: String(memberId),
        segmentIdentity,
      });
    }
    const line = linePrimitive(path);
    if (!line) {
      return unresolved('wall-wall-junction-path-geometry-unresolved', {
        memberId: String(memberId),
        segmentIdentity,
      });
    }
    const lineZ = lineVerticalPosition(line, toleranceMm);
    if (lineZ === null) {
      return unresolved('wall-wall-junction-bar-z-unresolved', {
        memberId: String(memberId),
        segmentIdentity,
      });
    }
    if (!isWithinVerticalRange(lineZ, verticalRange, toleranceMm)) continue;
    const point = pointAtPlanStation(line, junctionPoint, toleranceMm);
    observedHorizontalBarSlots.add(`${face}:B${barIndex}`);
    if (requireInteriorStation && point && point.stationRole !== 'INTERIOR') {
      return unresolved('wall-wall-junction-main-bar-crossing-unresolved', {
        memberId: String(memberId),
        semanticIdentity,
        segmentIdentity,
      });
    }
    if (!semanticSegments.has(semanticIdentity)) {
      semanticSegments.set(semanticIdentity, {
        segmentIdentities: [],
        stationSegments: [],
      });
    }
    semanticSegments.get(semanticIdentity).segmentIdentities.push(segmentIdentity);
    if (!point) continue;
    semanticSegments.get(semanticIdentity).stationSegments.push(segmentIdentity);
    const grade = effectiveGrade(fact, strengths);
    const value = Object.freeze({
      semanticIdentity,
      segmentIdentity,
      direction: fact.direction,
      face: fact.face,
      dia: fact.dia,
      diaName: fact.diaName,
      grade: grade.grade,
      gradeSource: grade.source,
      junctionPoint: Object.freeze({ x: point.x, y: point.y, z: point.z }),
    });
    if (!grouped.has(semanticIdentity)) grouped.set(semanticIdentity, []);
    grouped.get(semanticIdentity).push(value);
  }

  const expectedSlots = Array.isArray(expectedHorizontalBarSlots) ? expectedHorizontalBarSlots : [];
  const expectedSlotKeys = new Set(expectedSlots.map((slot) => slot.key));
  const missingExpectedSlots = expectedSlots.filter(
    (slot) => !observedHorizontalBarSlots.has(slot.key),
  );
  const unexpectedObservedSlots = [...observedHorizontalBarSlots].filter(
    (key) => !expectedSlotKeys.has(key),
  );
  if (missingExpectedSlots.length > 0 || unexpectedObservedSlots.length > 0) {
    return unresolved('wall-wall-junction-horizontal-bar-completeness-unresolved', {
      memberId: String(memberId),
      missingBarSlots: Object.freeze(missingExpectedSlots.map((slot) => slot.key)),
      unexpectedBarSlots: Object.freeze(unexpectedObservedSlots),
    });
  }

  const missingStation = [...semanticSegments.entries()].filter(
    ([, value]) => value.stationSegments.length === 0,
  );
  if (missingStation.length > 0) {
    return unresolved('wall-wall-junction-station-bar-segment-unresolved', {
      memberId: String(memberId),
      semanticIdentities: Object.freeze(missingStation.map(([identity]) => identity)),
      segmentIdentities: Object.freeze(
        missingStation.flatMap(([, value]) => value.segmentIdentities),
      ),
    });
  }

  const bars = [];
  for (const [semanticIdentity, segments] of grouped.entries()) {
    if (segments.length !== 1) {
      return unresolved('wall-wall-junction-semantic-segment-tie', {
        memberId: String(memberId),
        semanticIdentity,
        segmentCount: segments.length,
      });
    }
    bars.push(segments[0]);
  }
  bars.sort((a, b) => a.segmentIdentity.localeCompare(b.segmentIdentity));
  if (bars.length === 0) {
    return unresolved('wall-wall-junction-horizontal-bars-unresolved', {
      memberId: String(memberId),
    });
  }
  return Object.freeze({ status: 'RESOLVED', bars: Object.freeze(bars) });
}

function expectedHorizontalBarSlots(section, run, verticalRange, toleranceMm) {
  const horizontal = barForDirection(section, 'HORIZONTAL');
  const minZ = finite(run?.verticalRange?.min);
  const maxZ = finite(run?.verticalRange?.max);
  const pitchMm = positive(horizontal?.pitchMm);
  const diameters = Array.isArray(horizontal?.diametersMm) ? horizontal.diametersMm : [];
  if (
    !horizontal ||
    minZ === null ||
    maxZ === null ||
    !(maxZ > minZ) ||
    pitchMm === null ||
    diameters.length === 0
  ) {
    return null;
  }
  const barCount = Math.max(1, Math.floor((maxZ - minZ) / pitchMm));
  const usedSpan = (barCount - 1) * pitchMm;
  const firstZ = minZ + (maxZ - minZ - usedSpan) / 2;
  const faces = section.pattern === 'DOUBLE_NET' ? ['PLUS', 'MINUS'] : ['CENTER'];
  const slots = [];
  for (let barIndex = 0; barIndex < barCount; barIndex += 1) {
    const z = firstZ + barIndex * pitchMm;
    if (!isWithinVerticalRange(z, verticalRange, toleranceMm)) continue;
    if (positive(diameters[barIndex % diameters.length]) === null) return null;
    for (const face of faces) {
      slots.push(Object.freeze({ face, barIndex, z, key: `${face}:B${barIndex}` }));
    }
  }
  return Object.freeze(slots);
}

function memberAdapter(
  wall,
  section,
  facts,
  topology,
  renderPlan,
  junctionPoint,
  strengths,
  toleranceMm,
  verticalRange,
  requireInteriorStation = false,
) {
  const run = wallPlanRun(wall, facts, toleranceMm);
  const horizontal = barForDirection(section, 'HORIZONTAL');
  const vertical = barForDirection(section, 'VERTICAL');
  if (!run || !horizontal || !vertical || !SUPPORTED_PATTERNS.has(section?.pattern)) {
    return unresolved('wall-wall-junction-member-adapter-unresolved', {
      memberId: String(wall?.id || ''),
    });
  }
  const expectedSlots = expectedHorizontalBarSlots(section, run, verticalRange, toleranceMm);
  if (!expectedSlots) {
    return unresolved('wall-wall-junction-horizontal-bar-completeness-unresolved', {
      memberId: String(wall?.id || ''),
    });
  }
  const bars = semanticBarsAtJunction(
    wall.id,
    topology,
    renderPlan,
    junctionPoint,
    strengths,
    toleranceMm,
    expectedSlots,
    verticalRange,
    requireInteriorStation,
  );
  if (bars.status !== 'RESOLVED') return bars;
  return Object.freeze({
    status: 'RESOLVED',
    member: Object.freeze({
      memberId: String(wall.id),
      pattern: section.pattern,
      run,
      horizontalPitchMm: positive(horizontal.pitchMm),
    }),
    bars: bars.bars,
    maxVerticalDiaMm: maxDiameter(vertical),
    maxHorizontalDiaMm: maxDiameter(horizontal),
  });
}

function topologyModelSourceMatches(topology, modelSource, memberIds) {
  const expected = text(modelSource);
  if (!Array.isArray(topology?.facts) || !Array.isArray(topology?.unresolved)) return false;
  const entries = [...topology.facts, ...topology.unresolved].filter((entry) =>
    memberIds.includes(String(entry?.memberId)),
  );
  if (entries.length === 0) return true;
  return entries.every((entry) => text(entry?.modelSource) === expected);
}

/**
 * current production wall render-plan + normalized STB facts を D2a topology factへ接続する。
 * source/target wall pairは明示入力とし、nearest wall探索は行わない。
 */
export function buildWallWallJunctionResolverInput(
  xmlDoc,
  renderPlan,
  {
    modelSource = null,
    sourceMemberId,
    targetMemberId,
    topology = null,
    toleranceMm = DEFAULT_TOLERANCE_MM,
  } = {},
) {
  const tolerance = finite(toleranceMm);
  if (tolerance === null || tolerance < 0) {
    throw new RangeError('wall junction resolver toleranceMm must be finite and non-negative');
  }
  const sourceId = text(sourceMemberId);
  const targetId = text(targetMemberId);
  if (!sourceId || !targetId || sourceId === targetId) {
    return unresolved('wall-wall-junction-member-pair-unresolved', {
      modelSource: text(modelSource),
      sourceMemberId: sourceId,
      targetMemberId: targetId,
    });
  }

  const facts = collectWallRebarFacts(xmlDoc);
  const semantic = topology || buildWallRebarTopologySnapshot(renderPlan, { modelSource });
  if (topology && (!Array.isArray(semantic?.facts) || !Array.isArray(semantic?.unresolved))) {
    return unresolved('wall-wall-junction-semantic-facts-unresolved', {
      modelSource: text(modelSource),
      sourceMemberId: sourceId,
      targetMemberId: targetId,
    });
  }
  if (topology && !topologyModelSourceMatches(semantic, modelSource, [sourceId, targetId])) {
    return unresolved('wall-wall-junction-semantic-model-source-mismatch', {
      modelSource: text(modelSource),
      sourceMemberId: sourceId,
      targetMemberId: targetId,
    });
  }
  if (
    (semantic?.unresolved || []).some((item) =>
      [sourceId, targetId].includes(String(item.memberId)),
    )
  ) {
    return unresolved('wall-wall-junction-semantic-facts-unresolved', {
      modelSource: text(modelSource),
      sourceMemberId: sourceId,
      targetMemberId: targetId,
    });
  }

  const sourceWall = facts.walls.find((wall) => String(wall.id) === sourceId);
  const targetWall = facts.walls.find((wall) => String(wall.id) === targetId);
  const sourceSection = sourceWall ? facts.sections.get(String(sourceWall.sectionId)) : null;
  const targetSection = targetWall ? facts.sections.get(String(targetWall.sectionId)) : null;
  if (!sourceWall || !targetWall || !sourceSection || !targetSection) {
    return unresolved('wall-wall-junction-source-facts-unresolved', {
      modelSource: text(modelSource),
      sourceMemberId: sourceId,
      targetMemberId: targetId,
    });
  }

  const sourceRun = wallPlanRun(sourceWall, facts, tolerance);
  const targetRun = wallPlanRun(targetWall, facts, tolerance);
  if (!sourceRun || !targetRun) {
    return unresolved('wall-wall-junction-plan-run-unresolved', {
      modelSource: text(modelSource),
      sourceMemberId: sourceId,
      targetMemberId: targetId,
    });
  }
  if (!verticalRangesOverlap(sourceRun, targetRun, tolerance)) {
    return unresolved('wall-wall-junction-vertical-range-disjoint', {
      modelSource: text(modelSource),
      sourceMemberId: sourceId,
      targetMemberId: targetId,
      sourceVerticalRange: sourceRun.verticalRange,
      targetVerticalRange: targetRun.verticalRange,
    });
  }
  const sharedVerticalRange = Object.freeze({
    min: Math.max(sourceRun.verticalRange.min, targetRun.verticalRange.min),
    max: Math.min(sourceRun.verticalRange.max, targetRun.verticalRange.max),
  });
  const preliminary = deriveWallWallJunctionTopology(sourceRun, targetRun, {
    toleranceMm: tolerance,
  });
  if (preliminary.status !== 'RESOLVED') {
    return unresolved(preliminary.reason, {
      modelSource: text(modelSource),
      sourceMemberId: sourceId,
      targetMemberId: targetId,
      topologyFact: preliminary,
    });
  }

  const strengths = getCommonReinforcementStrengthMap(xmlDoc);
  const source = memberAdapter(
    sourceWall,
    sourceSection,
    facts,
    semantic,
    renderPlan,
    preliminary.junctionPoint,
    strengths,
    tolerance,
    sharedVerticalRange,
    preliminary.topology === 'T' && preliminary.mainSide === 'SOURCE',
  );
  const target = memberAdapter(
    targetWall,
    targetSection,
    facts,
    semantic,
    renderPlan,
    preliminary.junctionPoint,
    strengths,
    tolerance,
    sharedVerticalRange,
    preliminary.topology === 'T' && preliminary.mainSide === 'TARGET',
  );
  if (source.status !== 'RESOLVED' || target.status !== 'RESOLVED') {
    return unresolved(source.status !== 'RESOLVED' ? source.reason : target.reason, {
      modelSource: text(modelSource),
      sourceMemberId: sourceId,
      targetMemberId: targetId,
      sourceAdapter: source,
      targetAdapter: target,
    });
  }

  const topologyFact = buildWallWallJunctionTopologyFact(
    {
      modelSource,
      sourceMember: source.member,
      targetMember: target.member,
      sourceBars: source.bars,
      targetBars: target.bars,
    },
    { toleranceMm: tolerance },
  );
  if (topologyFact.status !== 'RESOLVED') {
    return unresolved(topologyFact.reason, {
      modelSource: text(modelSource),
      sourceMemberId: sourceId,
      targetMemberId: targetId,
      topologyFact,
    });
  }

  const maxWallVerticalDiaMm = Math.max(source.maxVerticalDiaMm || 0, target.maxVerticalDiaMm || 0);
  const maxWallHorizontalDiaMm = Math.max(
    source.maxHorizontalDiaMm || 0,
    target.maxHorizontalDiaMm || 0,
  );
  const wallMaximums = Object.freeze({
    verticalDiaMm: maxWallVerticalDiaMm > 0 ? maxWallVerticalDiaMm : null,
    horizontalDiaMm: maxWallHorizontalDiaMm > 0 ? maxWallHorizontalDiaMm : null,
  });
  return Object.freeze({
    status: 'RESOLVED',
    phase: 'PHASE_6A_D2B_INPUT',
    modelSource: text(modelSource),
    sourceMemberId: sourceId,
    targetMemberId: targetId,
    sharedVerticalRange,
    topologyFact,
    wallMaximums,
    // compatibility aliases for the first D2b resolver draft
    maxWallVerticalDiaMm: wallMaximums.verticalDiaMm,
    maxWallHorizontalDiaMm: wallMaximums.horizontalDiaMm,
    productionReady: false,
  });
}
