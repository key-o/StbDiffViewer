/**
 * @fileoverview Issue #302 Phase 5c-B1: horizontal dogleg geometry-readiness proposal。
 *
 * Phase 5c-Aのnormative candidateをactual RebarPath候補へ変換し、
 * continuous column-main-bar clearance / column plan boundaryまで全て成立した場合だけ
 * READYを返す。member trim / anchorage suppression / render plan mutationは行わない。
 */

import { barOuterDiameterMm } from '../../../constants/beamOpeningRules.js';
import { buildDoglegTransitionPath } from './rebarTransitionArcGeometry.js';
import { createLine, createRebarPath, validateRebarPath } from './rebarPath.js';
import { evaluateHorizontalRebarPathPlanClearance } from './rebarHorizontalPathClearance.js';
import { evaluateHorizontalRebarPathPlanBoundary } from './rebarHorizontalPathBoundary.js';

const EPS = 1e-6;
const SLOPE_LIMIT = 1 / 6;

function finite(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finitePoint(point) {
  return (
    point &&
    Number.isFinite(Number(point.x)) &&
    Number.isFinite(Number(point.y)) &&
    Number.isFinite(Number(point.z))
  );
}

function finitePlanDirection(direction) {
  const x = finite(direction?.x);
  const y = finite(direction?.y);
  const length = x === null || y === null ? null : Math.hypot(x, y);
  if (!(length > EPS)) return null;
  return { x: x / length, y: y / length };
}

function planDot(left, right) {
  return left.x * right.x + left.y * right.y;
}

function moveAlongPlan(point, direction, distanceMm) {
  return {
    x: Number(point.x) + Number(direction.x) * distanceMm,
    y: Number(point.y) + Number(direction.y) * distanceMm,
    z: Number(point.z),
  };
}

function subtract(left, right) {
  return {
    x: Number(left.x) - Number(right.x),
    y: Number(left.y) - Number(right.y),
    z: Number(left.z) - Number(right.z),
  };
}

function dotPlan(vector, direction) {
  return vector.x * Number(direction.x) + vector.y * Number(direction.y);
}

function pointDistance(left, right) {
  return Math.hypot(
    Number(right.x) - Number(left.x),
    Number(right.y) - Number(left.y),
    Number(right.z) - Number(left.z),
  );
}

function pushLine(primitives, start, end) {
  if (pointDistance(start, end) > EPS) primitives.push(createLine(start, end));
}

function text(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase();
}

function fail(reason, extra = {}) {
  return {
    ...extra,
    status: 'UNRESOLVED',
    ready: false,
    reason,
    path: null,
  };
}

function sameBarIdentity(leftBar, rightBar) {
  return (
    Number(leftBar?.dia) === Number(rightBar?.dia) &&
    text(leftBar?.diaName || leftBar?.dia) === text(rightBar?.diaName || rightBar?.dia) &&
    text(leftBar?.grade) === text(rightBar?.grade) &&
    text(leftBar?.role) === text(rightBar?.role) &&
    Number(leftBar?.layer) === Number(rightBar?.layer)
  );
}

function pathMetadata(transition, window) {
  return {
    memberId: null,
    memberIds: [
      transition?.leftBar?.memberId || transition?.leftBar?.sourceMemberId || null,
      transition?.rightBar?.memberId || transition?.rightBar?.sourceMemberId || null,
    ].filter(Boolean),
    memberTag: 'StbGirder',
    role: transition?.leftBar?.role || null,
    layer: transition?.leftBar?.layer ?? null,
    dia: Number(transition?.leftBar?.dia),
    diaName: transition?.leftBar?.diaName || null,
    grade: transition?.leftBar?.grade || null,
    positionZone: 'JOINT',
    source: 'girder-r7-horizontal-through-candidate',
    ruleId: '8-3',
    endpoint: null,
    coordinateSpace: 'world',
    disposition: 'BENT_HORIZONTAL_THROUGH',
    candidateRuleId: 'GIRDER-BENT-HORIZONTAL-ONE-SIXTH-CANDIDATE',
    jtMm: window?.jtMm ?? null,
    eMm: transition?.horizontalOffsetMm ?? null,
  };
}

export function buildHorizontalDoglegCandidate({ transition, window } = {}) {
  if (
    transition?.candidateDisposition !== 'BENT_HORIZONTAL_THROUGH' ||
    transition?.candidateRuleId !== 'GIRDER-BENT-HORIZONTAL-ONE-SIXTH-CANDIDATE'
  ) {
    return fail('horizontal-dogleg-candidate-required');
  }
  if (!sameBarIdentity(transition.leftBar, transition.rightBar)) {
    return fail('horizontal-dogleg-bar-identity-mismatch');
  }

  const verticalOffsetMm = finite(transition.verticalOffsetMm);
  const horizontalOffsetMm = finite(transition.horizontalOffsetMm);
  if (!(horizontalOffsetMm > EPS) || verticalOffsetMm === null) {
    return fail('horizontal-dogleg-offset-unresolved');
  }
  if (Math.abs(verticalOffsetMm) > EPS) {
    return fail('combined-horizontal-vertical-offset-not-supported');
  }

  if (window?.source !== 'actual-column-rebar-common-overlap') {
    return fail('horizontal-dogleg-actual-column-window-required');
  }
  const jtMm = finite(window?.jtMm);
  const leftBoundaryOffsetMm = finite(window?.leftBoundaryOffsetMm);
  const rightBoundaryOffsetMm = finite(window?.rightBoundaryOffsetMm);
  const frameAxis = finitePlanDirection(window?.geometry?.frame?.axis);
  const frameTransverse = finitePlanDirection(window?.geometry?.frame?.transverse);
  const leftOutward = finitePlanDirection(window?.geometry?.left?.outwardPlanDirection);
  const rightOutward = finitePlanDirection(window?.geometry?.right?.outwardPlanDirection);
  if (
    !(jtMm > EPS) ||
    leftBoundaryOffsetMm === null ||
    rightBoundaryOffsetMm === null ||
    !frameAxis ||
    !frameTransverse ||
    !leftOutward ||
    !rightOutward ||
    Math.abs(planDot(frameAxis, frameTransverse)) > 1e-5 ||
    Math.abs(planDot(leftOutward, rightOutward) + 1) > 1e-5 ||
    Math.abs(Math.abs(planDot(leftOutward, frameAxis)) - 1) > 1e-5
  ) {
    return fail('horizontal-dogleg-window-geometry-unresolved');
  }

  const leftEndpoint = transition?.leftBar?.worldPosition;
  const rightEndpoint = transition?.rightBar?.worldPosition;
  if (!finitePoint(leftEndpoint) || !finitePoint(rightEndpoint)) {
    return fail('horizontal-dogleg-endpoint-unresolved');
  }

  const leftBend = moveAlongPlan(leftEndpoint, leftOutward, leftBoundaryOffsetMm);
  const rightBend = moveAlongPlan(rightEndpoint, rightOutward, rightBoundaryOffsetMm);
  const delta = subtract(rightBend, leftBend);
  if (Math.abs(delta.z) > EPS) {
    return fail('horizontal-dogleg-bend-plane-not-horizontal');
  }

  const axialRunMm = Math.abs(dotPlan(delta, frameAxis));
  const transverseOffsetMm = Math.abs(dotPlan(delta, frameTransverse));
  if (Math.abs(axialRunMm - jtMm) > 1e-3) {
    return fail('horizontal-dogleg-axial-run-inconsistent', {
      axialRunMm,
      transverseOffsetMm,
      jtMm,
    });
  }
  if (Math.abs(transverseOffsetMm - horizontalOffsetMm) > 1e-3) {
    return fail('horizontal-dogleg-transverse-offset-inconsistent', {
      axialRunMm,
      transverseOffsetMm,
      horizontalOffsetMm,
      jtMm,
    });
  }

  const ratio = transverseOffsetMm / axialRunMm;
  if (ratio > SLOPE_LIMIT + 1e-9) {
    return fail('horizontal-bend-slope-exceeds-1-over-6', {
      axialRunMm,
      transverseOffsetMm,
      ratio,
      jtMm,
    });
  }

  const rounded = buildDoglegTransitionPath({
    sharpStart: leftBend,
    sharpEnd: rightBend,
    incomingDirection: { x: -leftOutward.x, y: -leftOutward.y, z: 0 },
    outgoingDirection: { x: rightOutward.x, y: rightOutward.y, z: 0 },
    grade: transition.leftBar.grade,
    barDiaMm: Number(transition.leftBar.dia),
    metadata: pathMetadata(transition, window),
  });
  if (!rounded.path) {
    return fail(rounded.reason || 'horizontal-dogleg-arc-unresolved', {
      axialRunMm,
      transverseOffsetMm,
      ratio,
      jtMm,
      rounded,
    });
  }

  const leftTrimMm = Math.max(0, leftBoundaryOffsetMm + rounded.startCorner.tangentDistanceMm);
  const rightTrimMm = Math.max(0, rightBoundaryOffsetMm + rounded.endCorner.tangentDistanceMm);
  const leftExtensionMm = Math.max(
    0,
    -(leftBoundaryOffsetMm + rounded.startCorner.tangentDistanceMm),
  );
  const rightExtensionMm = Math.max(
    0,
    -(rightBoundaryOffsetMm + rounded.endCorner.tangentDistanceMm),
  );

  const primitives = [];
  if (!(leftTrimMm > EPS)) {
    pushLine(primitives, leftEndpoint, rounded.startCorner.incomingTangent);
  }
  primitives.push(...rounded.path.primitives);
  if (!(rightTrimMm > EPS)) {
    pushLine(primitives, rounded.endCorner.outgoingTangent, rightEndpoint);
  }
  if (!primitives.length) {
    return fail('horizontal-dogleg-path-empty', {
      axialRunMm,
      transverseOffsetMm,
      ratio,
      jtMm,
      rounded,
    });
  }

  const candidatePath = createRebarPath(primitives, {
    ...rounded.path.metadata,
    bendGeometry: 'actual-arc',
    axialRunMm,
    transverseOffsetMm,
    ratio,
    leftTrimMm,
    rightTrimMm,
    leftExtensionMm,
    rightExtensionMm,
  });
  const validation = validateRebarPath(candidatePath);
  if (!validation.ok) {
    return fail('horizontal-dogleg-path-invalid', {
      axialRunMm,
      transverseOffsetMm,
      ratio,
      jtMm,
      rounded,
      candidatePath,
      validation,
    });
  }

  return {
    status: 'CANDIDATE_READY',
    ready: false,
    reason: null,
    path: null,
    candidatePath,
    validation,
    rounded,
    leftBend,
    rightBend,
    axialRunMm,
    transverseOffsetMm,
    ratio,
    jtMm,
    leftTrimMm,
    rightTrimMm,
    leftExtensionMm,
    rightExtensionMm,
  };
}

/**
 * horizontal dogleg candidateをproduction mutation前の全geometry gateへ通す。
 *
 * READY時のみpathを返す。UNRESOLVED時はcandidatePathを診断用に保持してもpathはnull。
 */
export function evaluateHorizontalDoglegReadiness({
  transition,
  window,
  columnBars,
  columnBoundaries,
  collisionToleranceMm,
  containmentToleranceMm,
} = {}) {
  const built = buildHorizontalDoglegCandidate({ transition, window });
  if (built.status !== 'CANDIDATE_READY' || !built.candidatePath) return built;

  const pathOuterDiameterMm = barOuterDiameterMm(
    transition?.leftBar?.diaName || transition?.leftBar?.dia,
    Number(transition?.leftBar?.dia) || 25,
  );
  const clearance = evaluateHorizontalRebarPathPlanClearance(built.candidatePath, columnBars, {
    pathOuterDiameterMm,
    collisionToleranceMm,
  });
  if (!clearance.resolved || !clearance.ok) {
    return fail(clearance.reason || 'horizontal-dogleg-clearance-unresolved', {
      ...built,
      candidatePath: built.candidatePath,
      clearance,
      boundary: null,
    });
  }

  const boundary = evaluateHorizontalRebarPathPlanBoundary(built.rounded.path, columnBoundaries, {
    pathOuterDiameterMm,
    containmentToleranceMm,
  });
  if (!boundary.resolved || !boundary.ok) {
    return fail(boundary.reason || 'horizontal-dogleg-boundary-unresolved', {
      ...built,
      candidatePath: built.candidatePath,
      clearance,
      boundary,
    });
  }

  return {
    ...built,
    status: 'READY',
    ready: true,
    reason: null,
    path: built.candidatePath,
    pathOuterDiameterMm,
    clearance,
    boundary,
  };
}
