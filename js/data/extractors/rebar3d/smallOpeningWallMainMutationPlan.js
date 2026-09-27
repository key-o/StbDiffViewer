/**
 * @fileoverview Issue #328 / #320 Phase 6b-O3:
 * O-001 small-opening candidateをactual wallMain RebarPathへbar-levelで割り当てる。
 *
 * このmoduleはmutation planだけを生成し、production RebarPath geometryは変更しない。
 * opening / bar / split segmentを一意に証明できない場合はfail-closedでUNRESOLVEDにする。
 */

import { collectWallRebarFacts, getWallRebarCoverOverride } from './wallRebarSectionFacts.js';
import { collectSmallOpeningRebarSourceFacts } from './smallOpeningRebarSourceFacts.js';
import { buildWallFrame } from './wallRebarGeometry.js';
import { getWallRebarSourceFingerprint } from './wallRebarPlacement.js';
import { buildWallRebarTopologySnapshot } from './wallRebarTopology.js';

const SOURCE = 'PHASE-6B-O3-SMALL-OPENING-WALL-MUTATION-PLAN';
const DEFAULT_TOLERANCE_MM = 1e-4;

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

function unresolved(reason, values = {}) {
  return Object.freeze({
    status: 'UNRESOLVED',
    resolved: false,
    pathPlanReady: false,
    productionReady: false,
    reason,
    source: SOURCE,
    entries: Object.freeze([]),
    ...values,
  });
}

function rejected(reason, values = {}) {
  return Object.freeze({
    status: 'REJECTED',
    resolved: true,
    pathPlanReady: false,
    productionReady: false,
    reason,
    source: SOURCE,
    entries: Object.freeze([]),
    ...values,
  });
}

function close(left, right, toleranceMm) {
  const a = finite(left);
  const b = finite(right);
  return a !== null && b !== null && Math.abs(a - b) <= toleranceMm;
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function referencePointsForWall(wall, nodes) {
  const points = [];
  for (const nodeId of wall?.nodeIds || []) {
    const node = nodes?.get?.(String(nodeId));
    if (!node) return null;
    const offset = wall?.offsets?.get?.(String(nodeId)) || { x: 0, y: 0, z: 0 };
    const x = finite(node.x);
    const y = finite(node.y);
    const z = finite(node.z);
    if (x === null || y === null || z === null) return null;
    points.push({
      x: x + (finite(offset.x) ?? 0),
      y: y + (finite(offset.y) ?? 0),
      z: z + (finite(offset.z) ?? 0),
    });
  }
  return points;
}

function worldToLocal(frame, point) {
  const x = finite(point?.x);
  const y = finite(point?.y);
  const z = finite(point?.z);
  if (x === null || y === null || z === null) return null;
  const delta = subtract({ x, y, z }, frame.origin);
  return {
    x: dot(delta, frame.xAxis),
    y: dot(delta, frame.yAxis),
    z: dot(delta, frame.zAxis),
  };
}

function openingProfile(opening) {
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
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    if (pointSegmentDistance(point, start, end) <= toleranceMm) return true;
  }
  return false;
}

function pointInsidePolygonStrict(point, polygon, toleranceMm) {
  if (onPolygonBoundary(point, polygon, toleranceMm)) return false;
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

function singleLine(path) {
  return path?.primitives?.length === 1 && path.primitives[0]?.type === 'line'
    ? path.primitives[0]
    : null;
}

function buildPathIndex(renderPlan) {
  const byIdentity = new Map();
  const duplicate = new Set();
  for (const [index, path] of (renderPlan?.paths || []).entries()) {
    if (path?.metadata?.memberType !== 'wall' || path?.metadata?.role !== 'wallMain') continue;
    const identityKey = text(path.metadata.identityKey);
    if (!identityKey) continue;
    if (byIdentity.has(identityKey)) duplicate.add(identityKey);
    byIdentity.set(identityKey, Object.freeze({ path, pathIndex: index }));
  }
  return { byIdentity, duplicate };
}

function matchingRenderCheck(renderPlan, memberId) {
  const matches = (renderPlan?.checks || []).filter(
    (check) => String(check?.memberId) === String(memberId),
  );
  return matches.length === 1 ? matches[0] : null;
}

function sourceFactMatchesCurrent(sourceFact, currentSourceFact, toleranceMm) {
  if (!sourceFact || !currentSourceFact) return false;
  if (
    text(sourceFact.memberType) !== text(currentSourceFact.memberType) ||
    text(sourceFact.memberId) !== text(currentSourceFact.memberId) ||
    text(sourceFact.memberSectionId) !== text(currentSourceFact.memberSectionId) ||
    text(sourceFact.openingId) !== text(currentSourceFact.openingId) ||
    text(sourceFact.openingSectionId) !== text(currentSourceFact.openingSectionId) ||
    text(sourceFact.openingElementName) !== text(currentSourceFact.openingElementName) ||
    sourceFact.openingWithinBothSpacings !== currentSourceFact.openingWithinBothSpacings ||
    sourceFact.sourceVersion !== currentSourceFact.sourceVersion
  ) {
    return false;
  }

  const numericFields = [
    'openingWidthMm',
    'openingHeightMm',
    'openingMaxMm',
    'positionXMm',
    'positionYMm',
    'rotateDeg',
    'spacingFirstMm',
    'spacingSecondMm',
  ];
  if (
    !numericFields.every((field) => {
      const sourceValue = finite(sourceFact[field]);
      const currentValue = finite(currentSourceFact[field]);
      return (
        sourceValue !== null &&
        currentValue !== null &&
        close(sourceValue, currentValue, toleranceMm)
      );
    })
  ) {
    return false;
  }

  return (
    Array.isArray(sourceFact.spacingDirections) &&
    Array.isArray(currentSourceFact.spacingDirections) &&
    sourceFact.spacingDirections.length === currentSourceFact.spacingDirections.length &&
    sourceFact.spacingDirections.every(
      (direction, index) => direction === currentSourceFact.spacingDirections[index],
    )
  );
}

function eligibleCandidate(evaluation) {
  const values = Array.isArray(evaluation?.eligibleCandidates) ? evaluation.eligibleCandidates : [];
  return values.length === 1 ? values[0] : null;
}

function candidateGeometry(candidate, evaluation, toleranceMm) {
  const signed = evaluation?.deflectionGeometry;
  if (candidate?.disposition === 'SHIFT_CANDIDATE') {
    const candidateShiftMm = finite(candidate?.metrics?.shiftMm);
    const shiftMm = finite(signed?.shiftMm);
    if (
      signed?.method !== 'SHIFT' ||
      candidateShiftMm === null ||
      shiftMm === null ||
      !close(Math.abs(shiftMm), candidateShiftMm, toleranceMm)
    ) {
      return null;
    }
    return Object.freeze({
      method: 'SHIFT',
      bendOffsetMm: null,
      bendRunMm: null,
      shiftMm,
    });
  }
  if (candidate?.disposition === 'BEND_CANDIDATE') {
    const candidateOffsetMm = finite(candidate?.metrics?.bendOffsetMm);
    const candidateRunMm = finite(candidate?.metrics?.bendRunMm);
    const bendOffsetMm = finite(signed?.bendOffsetMm);
    const bendRunMm = finite(signed?.bendRunMm);
    if (
      signed?.method !== 'BEND' ||
      candidateOffsetMm === null ||
      candidateRunMm === null ||
      bendOffsetMm === null ||
      bendRunMm === null ||
      !(bendRunMm > 0) ||
      !close(Math.abs(bendOffsetMm), candidateOffsetMm, toleranceMm) ||
      !close(bendRunMm, candidateRunMm, toleranceMm)
    ) {
      return null;
    }
    return Object.freeze({
      method: 'BEND',
      bendOffsetMm,
      bendRunMm,
      shiftMm: null,
    });
  }
  return null;
}

function topologyModelSourceMatches(topology, memberId, modelSource) {
  const expected = text(modelSource);
  const entries = [...(topology?.facts || []), ...(topology?.unresolved || [])].filter(
    (entry) => String(entry?.memberId) === String(memberId),
  );
  return entries.every((entry) => text(entry?.modelSource) === expected);
}

function localLineForFact(fact, indexedPath, frame, toleranceMm) {
  const path = indexedPath?.path;
  if (
    !path ||
    text(path?.metadata?.identityKey) !== text(fact?.sourceIdentityKey) ||
    String(path?.metadata?.memberId) !== String(fact?.memberId) ||
    path?.metadata?.direction !== fact?.direction ||
    text(path?.metadata?.face) !== text(fact?.face) ||
    !close(path?.metadata?.dia, fact?.dia, toleranceMm)
  ) {
    return null;
  }

  const line = singleLine(path);
  if (!line) return null;
  const start = worldToLocal(frame, line.start);
  const end = worldToLocal(frame, line.end);
  if (!start || !end || !close(start.z, end.z, toleranceMm)) return null;
  if (fact.direction === 'VERTICAL' && !close(start.x, end.x, toleranceMm)) return null;
  if (fact.direction === 'HORIZONTAL' && !close(start.y, end.y, toleranceMm)) return null;

  return Object.freeze({
    fact,
    pathIndex: indexedPath.pathIndex,
    start: Object.freeze(start),
    end: Object.freeze(end),
  });
}

function touchingEndpoint(segment, polygon, toleranceMm) {
  const startTouches = onPolygonBoundary(segment.start, polygon, toleranceMm);
  const endTouches = onPolygonBoundary(segment.end, polygon, toleranceMm);
  if (startTouches === endTouches) return null;
  return Object.freeze({
    point: startTouches ? segment.start : segment.end,
    other: startTouches ? segment.end : segment.start,
  });
}

function axisValue(point, direction) {
  return direction === 'VERTICAL' ? point.y : point.x;
}

function crossAxisValue(point, direction) {
  return direction === 'VERTICAL' ? point.x : point.y;
}

function resolveSplitPair(group, pathIndex, frame, polygon, toleranceMm) {
  const touching = [];
  let invalidBoundaryTouch = false;

  for (const fact of group) {
    const identityKey = text(fact?.sourceIdentityKey);
    if (!identityKey || pathIndex.duplicate.has(identityKey)) {
      return unresolved('small-opening-wall-source-path-identity-unresolved');
    }
    const segment = localLineForFact(
      fact,
      pathIndex.byIdentity.get(identityKey),
      frame,
      toleranceMm,
    );
    if (!segment) return unresolved('small-opening-wall-source-path-mismatch');

    const touch = touchingEndpoint(segment, polygon, toleranceMm);
    if (!touch) {
      if (
        onPolygonBoundary(segment.start, polygon, toleranceMm) ||
        onPolygonBoundary(segment.end, polygon, toleranceMm)
      ) {
        invalidBoundaryTouch = true;
      }
      continue;
    }
    touching.push(Object.freeze({ ...segment, touch }));
  }

  if (touching.length === 0 && !invalidBoundaryTouch) {
    return Object.freeze({ status: 'NOT_CROSSING' });
  }
  if (invalidBoundaryTouch || touching.length !== 2) {
    return unresolved('small-opening-wall-split-segment-pair-unresolved', {
      touchingSegmentCount: touching.length,
    });
  }

  const [first, second] = touching;
  const direction = first.fact.direction;
  if (
    direction !== second.fact.direction ||
    first.fact.face !== second.fact.face ||
    !close(first.fact.dia, second.fact.dia, toleranceMm) ||
    first.fact.semanticIdentity !== second.fact.semanticIdentity
  ) {
    return unresolved('small-opening-wall-split-semantic-mismatch');
  }
  if (
    !close(
      crossAxisValue(first.touch.point, direction),
      crossAxisValue(second.touch.point, direction),
      toleranceMm,
    )
  ) {
    return unresolved('small-opening-wall-split-collinearity-unresolved');
  }

  const ordered = [first, second].sort(
    (left, right) =>
      axisValue(left.touch.point, direction) - axisValue(right.touch.point, direction),
  );
  const before = ordered[0];
  const after = ordered[1];
  const beforeTouch = axisValue(before.touch.point, direction);
  const afterTouch = axisValue(after.touch.point, direction);
  if (
    !(afterTouch > beforeTouch + toleranceMm) ||
    !(axisValue(before.touch.other, direction) < beforeTouch - toleranceMm) ||
    !(axisValue(after.touch.other, direction) > afterTouch + toleranceMm)
  ) {
    return unresolved('small-opening-wall-split-order-unresolved');
  }

  const midpoint = {
    x: (before.touch.point.x + after.touch.point.x) / 2,
    y: (before.touch.point.y + after.touch.point.y) / 2,
  };
  if (!pointInsidePolygonStrict(midpoint, polygon, toleranceMm)) {
    return unresolved('small-opening-wall-gap-does-not-cross-opening');
  }

  const pathRef = (segment) =>
    Object.freeze({
      sourceIdentityKey: segment.fact.sourceIdentityKey,
      segmentIdentity: segment.fact.segmentIdentity,
      pathIndex: segment.pathIndex,
    });

  return Object.freeze({
    status: 'RESOLVED',
    barIdentity: before.fact.semanticIdentity,
    direction,
    face: before.fact.face,
    diaMm: before.fact.dia,
    diaName: before.fact.diaName || null,
    grade: before.fact.grade || null,
    beforePathRef: pathRef(before),
    afterPathRef: pathRef(after),
    gapStartLocal: Object.freeze({ x: before.touch.point.x, y: before.touch.point.y }),
    gapEndLocal: Object.freeze({ x: after.touch.point.x, y: after.touch.point.y }),
  });
}

/**
 * O-001 evaluation 1件を、明示されたwallMain bar identity 1本へ接続する。
 * targetBarIdentityを省略した場合はevaluation.barIdentityだけを使用し、nearest等で推定しない。
 * wallRenderOptionsにはrenderPlan生成時と同じ描画オプションを渡し、provenanceと照合する。
 */
export function buildSmallOpeningWallMainMutationPlan(
  xmlDoc,
  renderPlan,
  evaluation,
  {
    modelSource = null,
    targetBarIdentity = null,
    toleranceMm = DEFAULT_TOLERANCE_MM,
    wallRenderOptions = {},
  } = {},
) {
  const tolerance = finite(toleranceMm);
  if (tolerance === null || tolerance < 0) {
    throw new RangeError('small opening mutation plan toleranceMm must be finite and non-negative');
  }

  const expectedModelSource = text(modelSource);
  const evaluationModelSource = text(evaluation?.modelSource);
  const openingId = text(evaluation?.openingId);
  const memberId = text(evaluation?.memberId);
  const evaluationBarIdentity = text(evaluation?.barIdentity);
  const explicitTargetBarIdentity = text(targetBarIdentity);
  const barIdentity = evaluationBarIdentity || explicitTargetBarIdentity;
  const common = { openingId, memberId, modelSource: expectedModelSource, barIdentity };

  if (
    evaluationBarIdentity &&
    explicitTargetBarIdentity &&
    evaluationBarIdentity !== explicitTargetBarIdentity
  ) {
    return unresolved('small-opening-wall-bar-identity-mismatch', {
      ...common,
      evaluationBarIdentity,
      targetBarIdentity: explicitTargetBarIdentity,
    });
  }

  if (evaluation?.memberType !== 'StbWall') {
    return unresolved('small-opening-wall-member-type-unsupported', common);
  }
  if (evaluationModelSource !== expectedModelSource) {
    return unresolved('small-opening-wall-model-source-mismatch', {
      ...common,
      evaluationModelSource,
    });
  }
  if (!openingId || !memberId) {
    return unresolved('small-opening-wall-source-identity-unresolved', common);
  }
  if (!barIdentity) {
    return unresolved('small-opening-wall-bar-identity-unresolved', common);
  }
  if (evaluation?.status === 'REJECTED') {
    return rejected(evaluation.reason || 'small-opening-wall-candidate-rejected', common);
  }
  if (evaluation?.status !== 'CANDIDATE') {
    return unresolved(evaluation?.reason || 'small-opening-wall-candidate-unresolved', common);
  }
  if (evaluation?.sizeGateStatus !== 'PASS') {
    return unresolved('small-opening-wall-size-gate-unresolved', common);
  }
  if (evaluation?.coverStatus !== 'PASS') {
    return evaluation?.coverStatus === 'FAIL'
      ? rejected('small-opening-cover-constraint-failed', common)
      : unresolved('small-opening-wall-cover-gate-unresolved', common);
  }

  const candidate = eligibleCandidate(evaluation);
  if (!candidate) {
    return unresolved('small-opening-wall-candidate-count-unresolved', {
      ...common,
      candidateCount: evaluation?.eligibleCandidates?.length || 0,
    });
  }
  const geometry = candidateGeometry(candidate, evaluation, tolerance);
  if (!geometry) return unresolved('small-opening-wall-candidate-geometry-unresolved', common);

  const expectedCoverMm = getWallRebarCoverOverride(wallRenderOptions);
  const renderPlanCoverMm = renderPlan?.provenance?.coverMm;
  if (expectedCoverMm !== renderPlanCoverMm) {
    return unresolved('small-opening-wall-render-plan-options-mismatch', common);
  }
  const facts = collectWallRebarFacts(xmlDoc, wallRenderOptions);
  const walls = (facts?.walls || []).filter((wall) => String(wall?.id) === memberId);
  if (walls.length !== 1) return unresolved('small-opening-wall-member-source-unresolved', common);
  const wall = walls[0];

  const openings = (wall?.openings || []).filter((opening) => String(opening?.id) === openingId);
  if (openings.length !== 1) {
    return unresolved('small-opening-wall-opening-source-unresolved', common);
  }
  const opening = openings[0];
  const currentSourceFacts = collectSmallOpeningRebarSourceFacts(xmlDoc).filter(
    (fact) =>
      fact?.memberType === 'WALL' &&
      String(fact.memberId) === memberId &&
      String(fact.openingId) === openingId,
  );
  if (
    currentSourceFacts.length !== 1 ||
    !sourceFactMatchesCurrent(evaluation?.sourceFact, currentSourceFacts[0], tolerance)
  ) {
    return unresolved('small-opening-wall-source-fact-mismatch', common);
  }

  const renderPlanModelSource = text(renderPlan?.provenance?.modelSource);
  if (!expectedModelSource || renderPlanModelSource !== expectedModelSource) {
    return unresolved('small-opening-wall-render-plan-model-source-mismatch', {
      ...common,
      renderPlanModelSource,
    });
  }

  const check = matchingRenderCheck(renderPlan, memberId);
  if (
    !check ||
    check.status !== 'READY' ||
    String(check.sectionId) !== String(wall.sectionId) ||
    Number(check.openingCount) < 1
  ) {
    return unresolved('small-opening-wall-render-plan-unresolved', common);
  }
  const renderPlanSourceFingerprint = text(
    renderPlan?.provenance?.wallSourceFingerprints?.[memberId],
  );
  if (
    !renderPlanSourceFingerprint ||
    renderPlanSourceFingerprint !== getWallRebarSourceFingerprint(facts, memberId)
  ) {
    return unresolved('small-opening-wall-render-plan-source-mismatch', common);
  }

  const points = referencePointsForWall(wall, facts.nodes);
  const frame = points ? buildWallFrame(points) : null;
  const polygon = openingProfile(opening);
  if (!frame || !polygon) {
    return unresolved('small-opening-wall-opening-geometry-unresolved', common);
  }

  const semantic = buildWallRebarTopologySnapshot(renderPlan, { modelSource });
  if (
    !Array.isArray(semantic?.facts) ||
    !Array.isArray(semantic?.unresolved) ||
    !topologyModelSourceMatches(semantic, memberId, modelSource) ||
    semantic.unresolved.some((item) => String(item?.memberId) === memberId)
  ) {
    return unresolved('small-opening-wall-topology-unresolved', common);
  }

  const group = semantic.facts.filter(
    (fact) =>
      String(fact?.memberId) === memberId &&
      fact?.role === 'wallMain' &&
      fact?.semanticIdentity === barIdentity,
  );
  if (group.length < 2) {
    return unresolved('small-opening-wall-bar-identity-not-split', {
      ...common,
      segmentCount: group.length,
    });
  }

  const split = resolveSplitPair(group, buildPathIndex(renderPlan), frame, polygon, tolerance);
  if (split.status === 'NOT_CROSSING') {
    return unresolved('small-opening-wall-bar-not-crossing-opening', common);
  }
  if (split.status !== 'RESOLVED') {
    return unresolved(split.reason || 'small-opening-wall-bar-plan-unresolved', {
      ...common,
      touchingSegmentCount: split.touchingSegmentCount,
    });
  }

  const entry = Object.freeze({
    status: 'READY',
    resolved: true,
    pathPlanReady: true,
    productionReady: false,
    source: SOURCE,
    openingId,
    memberId,
    modelSource: expectedModelSource,
    candidateType: candidate.disposition,
    candidateRuleId: candidate.ruleId,
    detailingSource: text(evaluation?.detailingSource),
    projectSourceRef: text(evaluation?.projectSourceRef),
    evaluationSourceKey: text(evaluation?.sourceKey),
    barIdentity: split.barIdentity,
    direction: split.direction,
    face: split.face,
    diaMm: split.diaMm,
    diaName: split.diaName,
    grade: split.grade,
    beforePathRef: split.beforePathRef,
    afterPathRef: split.afterPathRef,
    geometry,
    gapStartLocal: split.gapStartLocal,
    gapEndLocal: split.gapEndLocal,
    reason: null,
  });

  return Object.freeze({
    status: 'READY',
    resolved: true,
    pathPlanReady: true,
    productionReady: false,
    reason: null,
    source: SOURCE,
    openingId,
    memberId,
    modelSource: expectedModelSource,
    candidateType: candidate.disposition,
    candidateRuleId: candidate.ruleId,
    detailingSource: entry.detailingSource,
    projectSourceRef: entry.projectSourceRef,
    evaluationSourceKey: entry.evaluationSourceKey,
    barIdentity: split.barIdentity,
    entries: Object.freeze([entry]),
    unresolved: Object.freeze([]),
  });
}

export const SMALL_OPENING_WALL_MUTATION_PLAN_SOURCE = SOURCE;
