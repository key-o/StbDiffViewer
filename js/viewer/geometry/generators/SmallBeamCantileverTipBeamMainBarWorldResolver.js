/**
 * @fileoverview R12-AO 図9-4-2 先端小梁top/bottom主筋を片持ち梁内へ90°折曲げするworld resolver。
 *
 * 先端小梁member-local identity pathを折曲げ接線位置までtrimし、同じidentityのactual-arc +
 * 片持ち梁内直線定着をworld RebarPathとして生成する。member内trimとworld path生成は
 * tip-beam member単位でatomicに適用し、1本でも不成立なら全てbaselineへrollbackする。
 */

import * as THREE from 'three';
import {
  createLine,
  createRebarPath,
  getCenterlineLength,
  getPathEnd,
  getPathStart,
  validateRebarPath,
} from '../../../data/extractors/rebar3d/rebarPath.js';
import { resolveRoundedTransitionCorner } from '../../../data/extractors/rebar3d/rebarTransitionArcGeometry.js';
import { validateTangentContinuousRebarPath } from '../../../data/extractors/rebar3d/shearRebarPathGeometry.js';

const SOURCE = 'R12-AO-small-beam-cantilever-tip-beam-main-bar-world';
const EPS = 1e-6;
const CONTINUITY_TOLERANCE_MM = 1e-5;

function closeEnough(left, right, tolerance = CONTINUITY_TOLERANCE_MM) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

function samePoint(left, right, tolerance = CONTINUITY_TOLERANCE_MM) {
  return (
    closeEnough(left?.x, right?.x, tolerance) &&
    closeEnough(left?.y, right?.y, tolerance) &&
    closeEnough(left?.z, right?.z, tolerance)
  );
}

function singleLine(path) {
  return path?.primitives?.length === 1 && path.primitives[0]?.type === 'line'
    ? path.primitives[0]
    : null;
}

function quaternion(placement) {
  const finite = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  };
  return new THREE.Quaternion(
    finite(placement?.rotation?.x, 0),
    finite(placement?.rotation?.y, 0),
    finite(placement?.rotation?.z, 0),
    finite(placement?.rotation?.w, 1),
  );
}

function memberLocalPointToWorld(point, placement) {
  const roll = Number(placement?.localRollRad) || 0;
  const cos = Math.cos(roll);
  const sin = Math.sin(roll);
  const u = roll === 0 ? Number(point.x) : Number(point.x) * cos - Number(point.y) * sin;
  const v = roll === 0 ? Number(point.y) : Number(point.x) * sin + Number(point.y) * cos;
  const vector = new THREE.Vector3(u, v, Number(point.z));
  vector.applyQuaternion(quaternion(placement));
  vector.add(
    new THREE.Vector3(
      Number(placement?.center?.x),
      Number(placement?.center?.y),
      Number(placement?.center?.z),
    ),
  );
  return { x: vector.x, y: vector.y, z: vector.z };
}

function worldPointToMemberLocal(point, placement) {
  const vector = new THREE.Vector3(
    Number(point?.x) - Number(placement?.center?.x),
    Number(point?.y) - Number(placement?.center?.y),
    Number(point?.z) - Number(placement?.center?.z),
  );
  vector.applyQuaternion(quaternion(placement).invert());
  const roll = Number(placement?.localRollRad) || 0;
  if (roll !== 0) {
    const cos = Math.cos(-roll);
    const sin = Math.sin(-roll);
    const x = vector.x * cos - vector.y * sin;
    const y = vector.x * sin + vector.y * cos;
    vector.x = x;
    vector.y = y;
  }
  return { x: vector.x, y: vector.y, z: vector.z };
}

function axialWorldDirection(placement, sign) {
  const vector = new THREE.Vector3(0, 0, Number(sign));
  vector.applyQuaternion(quaternion(placement));
  if (!(vector.length() > EPS)) return null;
  vector.normalize();
  return { x: vector.x, y: vector.y, z: vector.z };
}

function addScaled(point, direction, length) {
  return {
    x: Number(point.x) + Number(direction.x) * Number(length),
    y: Number(point.y) + Number(direction.y) * Number(length),
    z: Number(point.z) + Number(direction.z) * Number(length),
  };
}

function subtract(left, right) {
  return {
    x: Number(left.x) - Number(right.x),
    y: Number(left.y) - Number(right.y),
    z: Number(left.z) - Number(right.z),
  };
}

function dot(left, right) {
  return (
    Number(left.x) * Number(right.x) +
    Number(left.y) * Number(right.y) +
    Number(left.z) * Number(right.z)
  );
}

function endpointLocalZ(side, memberLengthMm) {
  return side === 'start' ? -Number(memberLengthMm) / 2 : Number(memberLengthMm) / 2;
}

function memberCandidate(paths, entry, side, memberLengthMm) {
  const expectedZ = endpointLocalZ(side, memberLengthMm);
  return (paths || []).filter((path) => {
    const line = singleLine(path);
    if (
      !line ||
      path?.metadata?.coordinateSpace !== 'member-local' ||
      path.metadata?.identityKey !== entry.identityKey ||
      path.metadata?.role !== entry.role ||
      !validateRebarPath(path).ok
    ) {
      return false;
    }
    const endpoint = side === 'start' ? getPathStart(path) : getPathEnd(path);
    return (
      closeEnough(endpoint?.x, entry.u) &&
      closeEnough(endpoint?.y, entry.v) &&
      closeEnough(endpoint?.z, expectedZ)
    );
  });
}

function trimMemberPath(path, side, trimMm) {
  const line = singleLine(path);
  if (!line || !(Number(trimMm) > 0)) return null;
  const start = { ...line.start };
  const end = { ...line.end };
  if (side === 'start') start.z = Number(start.z) + Number(trimMm);
  else if (side === 'end') end.z = Number(end.z) - Number(trimMm);
  else return null;
  if (!(Number(end.z) > Number(start.z) + EPS)) return null;

  const result = createRebarPath([createLine(start, end)], {
    ...path.metadata,
    cantileverTipBeamMainTrimmed: true,
    cantileverTipBeamMainTrimMm: Number(trimMm),
    cantileverTipBeamEndpoint: side,
    cantileverTipBeamRuleId: 'R12-AO',
  });
  return validateRebarPath(result).ok ? result : null;
}

function supportEndpoint(placement, side) {
  if (side === 'start') return placement?.adjustedStart || null;
  if (side === 'end') return placement?.adjustedEnd || null;
  return null;
}

function supportOppositeEndpoint(placement, side) {
  if (side === 'start') return placement?.adjustedEnd || null;
  if (side === 'end') return placement?.adjustedStart || null;
  return null;
}

function insideSupportSection(point, placement, widthMm, depthMm, diaMm) {
  const local = worldPointToMemberLocal(point, placement);
  const radius = Number(diaMm) / 2;
  return (
    Number.isFinite(local.x) &&
    Number.isFinite(local.y) &&
    Math.abs(local.x) + radius <= Number(widthMm) / 2 + EPS &&
    Math.abs(local.y) + radius <= Number(depthMm) / 2 + EPS
  );
}

function entryLengthPlan(entry, bend) {
  const arcLengthMm = Number(bend.sweepAngleRad) * Number(bend.centerlineRadiusMm);
  const tangentDistanceMm = Number(bend.tangentDistanceMm);
  if (!(arcLengthMm > 0) || !(tangentDistanceMm > 0)) {
    return { ok: false, reason: 'cantilever-tip-beam-main-bend-length-unresolved' };
  }

  if (entry.role === 'top') {
    const l2RequiredMm = Number(entry.l2RequiredMm);
    const additionalStraightRequiredMm = Number(entry.additionalStraightRequiredMm);
    if (!(l2RequiredMm > 0) || !(additionalStraightRequiredMm > 0)) {
      return { ok: false, reason: 'cantilever-tip-beam-top-length-unresolved' };
    }
    const endDistanceFromCornerMm = Math.max(
      l2RequiredMm - arcLengthMm + tangentDistanceMm,
      additionalStraightRequiredMm + tangentDistanceMm,
    );
    return {
      ok: endDistanceFromCornerMm > tangentDistanceMm + EPS,
      reason:
        endDistanceFromCornerMm > tangentDistanceMm + EPS
          ? null
          : 'cantilever-tip-beam-top-straight-after-bend-nonpositive',
      requiredCenterlineMm: l2RequiredMm,
      minimumStraightAfterBendMm: additionalStraightRequiredMm,
      endDistanceFromCornerMm,
      outgoingStraightMm: endDistanceFromCornerMm - tangentDistanceMm,
      arcLengthMm,
    };
  }

  if (entry.role === 'bottom') {
    const l3RequiredMm = Number(entry.l3RequiredMm);
    if (!(l3RequiredMm > 0)) {
      return { ok: false, reason: 'cantilever-tip-beam-bottom-length-unresolved' };
    }
    const endDistanceFromCornerMm = l3RequiredMm - arcLengthMm + tangentDistanceMm;
    return {
      ok: endDistanceFromCornerMm > tangentDistanceMm + EPS,
      reason:
        endDistanceFromCornerMm > tangentDistanceMm + EPS
          ? null
          : 'cantilever-tip-beam-bottom-straight-after-bend-nonpositive',
      requiredCenterlineMm: l3RequiredMm,
      minimumStraightAfterBendMm: 0,
      endDistanceFromCornerMm,
      outgoingStraightMm: endDistanceFromCornerMm - tangentDistanceMm,
      arcLengthMm,
    };
  }

  return { ok: false, reason: 'cantilever-tip-beam-main-role-unresolved' };
}

function buildEntryGeometry({
  entry,
  memberPath,
  memberPlan,
  tipBeamPlacement,
  cantileverPlacement,
} = {}) {
  const tipSide = memberPlan.tipBeamEndpoint;
  const cantileverSide = memberPlan.cantileverEndpoint;
  const endpointLocal = tipSide === 'start' ? getPathStart(memberPath) : getPathEnd(memberPath);
  const corner = memberLocalPointToWorld(endpointLocal, tipBeamPlacement);
  const incomingDirection = axialWorldDirection(tipBeamPlacement, tipSide === 'start' ? -1 : 1);
  const outgoingDirection = axialWorldDirection(
    cantileverPlacement,
    cantileverSide === 'start' ? 1 : -1,
  );
  if (!incomingDirection || !outgoingDirection) {
    return { ok: false, reason: 'cantilever-tip-beam-main-world-axis-unresolved' };
  }
  if (
    Math.abs(incomingDirection.z) > EPS ||
    Math.abs(outgoingDirection.z) > EPS ||
    Math.abs(dot(incomingDirection, outgoingDirection)) > 1e-5
  ) {
    return {
      ok: false,
      reason: 'cantilever-tip-beam-main-world-axis-not-horizontal-orthogonal',
      incomingDirection,
      outgoingDirection,
    };
  }

  const bend = resolveRoundedTransitionCorner({
    corner,
    incomingDirection,
    outgoingDirection,
    grade: entry.grade,
    barDiaMm: entry.diaMm,
  });
  if (!bend.ok) {
    return {
      ok: false,
      reason: bend.reason || 'cantilever-tip-beam-main-bend-unresolved',
      bend,
    };
  }

  const jointEnvelopeMm = Number(bend.tangentDistanceMm) + Number(entry.diaMm) / 2;
  if (
    jointEnvelopeMm > Number(memberPlan.tipBeamWidthMm) / 2 + EPS ||
    jointEnvelopeMm > Number(memberPlan.cantileverBeamWidthMm) / 2 + EPS
  ) {
    return {
      ok: false,
      reason: 'cantilever-tip-beam-main-bend-radius-exceeds-joint-overlap',
      jointEnvelopeMm,
      tipBeamHalfWidthMm: Number(memberPlan.tipBeamWidthMm) / 2,
      cantileverBeamHalfWidthMm: Number(memberPlan.cantileverBeamWidthMm) / 2,
    };
  }

  const trimmed = trimMemberPath(memberPath, tipSide, bend.tangentDistanceMm);
  if (!trimmed) {
    return { ok: false, reason: 'cantilever-tip-beam-main-path-trim-invalid' };
  }
  const trimmedEndpoint = tipSide === 'start' ? getPathStart(trimmed) : getPathEnd(trimmed);
  const trimmedEndpointWorld = memberLocalPointToWorld(trimmedEndpoint, tipBeamPlacement);
  if (!samePoint(trimmedEndpointWorld, bend.incomingTangent)) {
    return {
      ok: false,
      reason: 'cantilever-tip-beam-main-trim-tangent-mismatch',
      trimmedEndpointWorld,
      incomingTangent: bend.incomingTangent,
    };
  }

  const lengthPlan = entryLengthPlan(entry, bend);
  if (!lengthPlan.ok) return lengthPlan;

  const supportAtConnection = supportEndpoint(cantileverPlacement, cantileverSide);
  const supportInteriorEnd = supportOppositeEndpoint(cantileverPlacement, cantileverSide);
  if (!supportAtConnection || !supportInteriorEnd) {
    return { ok: false, reason: 'cantilever-tip-beam-main-support-placement-unresolved' };
  }
  const availableIntoCantileverMm = dot(subtract(supportInteriorEnd, corner), outgoingDirection);
  if (
    !(availableIntoCantileverMm > 0) ||
    lengthPlan.endDistanceFromCornerMm > availableIntoCantileverMm + EPS
  ) {
    return {
      ok: false,
      reason: 'cantilever-tip-beam-main-anchorage-exceeds-cantilever',
      availableIntoCantileverMm,
      requiredIntoCantileverMm: lengthPlan.endDistanceFromCornerMm,
    };
  }

  const end = addScaled(corner, outgoingDirection, lengthPlan.endDistanceFromCornerMm);
  if (
    !insideSupportSection(
      bend.outgoingTangent,
      cantileverPlacement,
      memberPlan.cantileverBeamWidthMm,
      memberPlan.cantileverBeamDepthMm,
      entry.diaMm,
    ) ||
    !insideSupportSection(
      end,
      cantileverPlacement,
      memberPlan.cantileverBeamWidthMm,
      memberPlan.cantileverBeamDepthMm,
      entry.diaMm,
    )
  ) {
    return {
      ok: false,
      reason: 'cantilever-tip-beam-main-anchorage-outside-cantilever-section',
    };
  }

  const worldPath = createRebarPath([bend.arc, createLine(bend.outgoingTangent, end)], {
    memberId: String(memberPlan.elementId),
    memberTag: 'StbBeam',
    supportMemberId: String(memberPlan.sourceCantileverId),
    supportMemberTag: 'StbBeam',
    coordinateSpace: 'world',
    source: SOURCE,
    ruleId: 'R12-AO',
    sourceFigure: '9-4-2',
    role: entry.role,
    layer: entry.layer ?? null,
    identityKey: entry.identityKey,
    dia: Number(entry.diaMm),
    grade: entry.grade,
    bendGeometry: 'actual-arc',
    bendAngleDeg: 90,
    insideDiameterMm: Number(bend.insideDiameterMm),
    centerlineRadiusMm: Number(bend.centerlineRadiusMm),
    anchorageMode: 'CANTILEVER_TIP_BEAM_90',
    requirementKind: entry.role === 'top' ? 'L2' : 'L3',
    requiredCenterlineMm: lengthPlan.requiredCenterlineMm,
    minimumStraightAfterBendMm: lengthPlan.minimumStraightAfterBendMm,
    actualStraightAfterBendMm: lengthPlan.outgoingStraightMm,
    endpoint: tipSide,
    supportEndpoint: cantileverSide,
    renderReady: true,
    generationStatus: 'CENTERLINE_READY',
    productionPathCandidate: true,
    productionConsumer: 'explicit-world-path',
  });
  const validation = validateTangentContinuousRebarPath(worldPath);
  const centerlineLengthMm = getCenterlineLength(worldPath);
  if (
    !validateRebarPath(worldPath).ok ||
    !validation.ok ||
    !(centerlineLengthMm + EPS >= lengthPlan.requiredCenterlineMm) ||
    !(lengthPlan.outgoingStraightMm + EPS >= lengthPlan.minimumStraightAfterBendMm)
  ) {
    return {
      ok: false,
      reason: 'cantilever-tip-beam-main-world-path-contract-invalid',
      validation,
      centerlineLengthMm,
      lengthPlan,
    };
  }

  return {
    ok: true,
    trimmed,
    worldPath,
    bend,
    lengthPlan,
    availableIntoCantileverMm,
    centerlineLengthMm,
  };
}

export function buildSmallBeamCantileverTipBeamMainBarMemberMutation({
  memberPlan,
  memberPaths,
  tipBeamPlacement,
  cantileverPlacement,
  memberLengthMm,
  memberId,
  sectionId = null,
  cantileverSectionId = null,
} = {}) {
  const baseline = Array.isArray(memberPaths) ? memberPaths : [];
  const fail = (reason, extra = {}) => ({
    memberPaths: baseline,
    paths: [],
    unresolved: [{ reason, ...extra }],
    applied: false,
    reason,
  });

  if (!memberPlan?.entries?.length) {
    return {
      memberPaths: baseline,
      paths: [],
      unresolved: [],
      applied: false,
      reason: null,
    };
  }
  if (
    memberPlan.figureCase !== 'FIGURE_9_4_2' ||
    memberPlan.generationStatus !== 'WORLD_PATH_PLAN_READY' ||
    memberPlan.productionPathCandidate !== true ||
    memberPlan.productionConsumer !== 'tip-beam-cross-member-world-bend'
  ) {
    return fail('cantilever-tip-beam-main-render-gate-not-ready');
  }
  if (
    String(memberPlan.elementId) !== String(memberId) ||
    !['start', 'end'].includes(memberPlan.tipBeamEndpoint) ||
    !['start', 'end'].includes(memberPlan.cantileverEndpoint)
  ) {
    return fail('cantilever-tip-beam-main-render-member-contract-mismatch');
  }
  if (
    memberPlan.sectionId !== null &&
    memberPlan.sectionId !== undefined &&
    String(memberPlan.sectionId) !== String(sectionId)
  ) {
    return fail('cantilever-tip-beam-main-render-section-mismatch');
  }
  if (
    memberPlan.sourceCantileverSectionId !== null &&
    memberPlan.sourceCantileverSectionId !== undefined &&
    String(memberPlan.sourceCantileverSectionId) !== String(cantileverSectionId)
  ) {
    return fail('cantilever-tip-beam-main-render-support-section-mismatch');
  }
  if (!(Number(memberLengthMm) > 0) || !tipBeamPlacement || !cantileverPlacement) {
    return fail('cantilever-tip-beam-main-render-placement-unresolved');
  }

  const replacements = new Map();
  const worldPaths = [];
  const targetedPaths = new Set();
  for (const entry of memberPlan.entries) {
    if (
      !['top', 'bottom'].includes(entry?.role) ||
      !entry?.identityKey ||
      !(Number(entry?.diaMm) > 0) ||
      !entry?.grade ||
      !Number.isFinite(Number(entry?.u)) ||
      !Number.isFinite(Number(entry?.v))
    ) {
      return fail('cantilever-tip-beam-main-render-entry-invalid', { entry });
    }

    const candidates = memberCandidate(
      baseline,
      entry,
      memberPlan.tipBeamEndpoint,
      Number(memberLengthMm),
    );
    if (candidates.length !== 1) {
      return fail(
        candidates.length === 0
          ? 'cantilever-tip-beam-main-render-main-path-unresolved'
          : 'cantilever-tip-beam-main-render-main-path-ambiguous',
        { entry, candidateCount: candidates.length },
      );
    }
    const target = candidates[0];
    if (targetedPaths.has(target)) {
      return fail('cantilever-tip-beam-main-render-main-path-reused', { entry });
    }

    const built = buildEntryGeometry({
      entry,
      memberPath: target,
      memberPlan,
      tipBeamPlacement,
      cantileverPlacement,
    });
    if (!built.ok) return fail(built.reason, { entry, detail: built });

    targetedPaths.add(target);
    replacements.set(target, built.trimmed);
    worldPaths.push(built.worldPath);
  }

  if (worldPaths.length !== memberPlan.entries.length) {
    return fail('cantilever-tip-beam-main-render-path-count-mismatch');
  }

  const mutated = baseline.map((path) => replacements.get(path) || path);
  return {
    memberPaths: mutated,
    paths: worldPaths,
    unresolved: [],
    applied: true,
    reason: null,
  };
}
