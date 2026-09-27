/**
 * @fileoverview R12-S 一般小梁 VERTICAL_90 path planをR10 actual-arc RebarPathへ接続する。
 *
 * R12-Rのr10InputだけをR10 buildAnchoredHookPath()へ渡し、生成された中心線の
 * validation・実曲げArc・中心線長をpath planと独立照合する。
 * member-local主筋との連続性・identity・production gateは後段で扱う。
 */

import { buildAnchoredHookPath } from './rebarHookGeometry.js';
import { getCenterlineLength, getPathStart, validateRebarPath } from './rebarPath.js';

const TOLERANCE_MM = 1e-6;
const ANGLE_TOLERANCE_RAD = 1e-9;
const SOURCE = 'R12-small-beam-vertical-90-actual-path';

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    actualPathReady: false,
    productionReady: false,
    reason,
    source: SOURCE,
    path: null,
    ...extra,
  };
}

function closeEnough(left, right, tolerance = TOLERANCE_MM) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

function samePoint(point, target) {
  return (
    closeEnough(point?.x, target?.x) &&
    closeEnough(point?.y, target?.y) &&
    closeEnough(point?.z, target?.z)
  );
}

/**
 * VERTICAL_90 path plan 1本をR10 actual-arc RebarPathへ変換する。
 *
 * R10 pathはmember端(z=0)から開始するため、R12-Pのnear face起点全長との照合では
 * `nearFaceFromMemberEndMm + pathCenterlineFromMemberEndMm` を用いる。
 */
export function resolveSmallBeamVertical90ActualPath({
  pathPlan,
  memberId = null,
  elementName = null,
} = {}) {
  if (!pathPlan?.resolved || pathPlan.pathPlanReady !== true || !pathPlan.r10Input) {
    return unresolved(pathPlan?.reason || 'small-beam-vertical-90-path-plan-not-ready');
  }
  if (pathPlan.mode !== 'VERTICAL_90') {
    return unresolved('small-beam-vertical-90-actual-path-mode-mismatch', {
      selectedMode: pathPlan.mode || null,
    });
  }

  const nearFaceFromMemberEndMm = Number(pathPlan.nearFaceFromMemberEndMm);
  const selectedTotalFromNearMm = Number(pathPlan.selectedTotalFromNearMm);
  if (!(nearFaceFromMemberEndMm >= 0) || !(selectedTotalFromNearMm > 0)) {
    return unresolved('small-beam-vertical-90-actual-path-length-source-unresolved');
  }

  const built = buildAnchoredHookPath({
    ...pathPlan.r10Input,
    metadata: {
      source: 'small-beam-r12-vertical-90',
      ruleId: 'R12-S',
      memberId: memberId === null || memberId === undefined ? null : String(memberId),
      memberTag: 'StbBeam',
      elementName: elementName || null,
      role: 'top',
      layer: pathPlan.layer ?? null,
      identityKey: pathPlan.identityKey || null,
      bendGeometry: 'actual-arc',
      anchorageMode: 'VERTICAL_90',
      supportId: pathPlan.supportId || null,
      barIndex: Number.isInteger(pathPlan.barIndex) ? pathPlan.barIndex : null,
    },
  });
  if (!built?.ok || !built.path) {
    return unresolved('small-beam-vertical-90-r10-path-unresolved', {
      r10Reason: built?.reason || null,
      r10Result: built || null,
    });
  }

  const validation = validateRebarPath(built.path);
  if (!validation.ok || built.validation?.ok !== true) {
    return unresolved('small-beam-vertical-90-r10-path-invalid', {
      validation,
      r10Validation: built.validation || null,
    });
  }

  const pathStart = getPathStart(built.path);
  const expectedStart = {
    x: Number(pathPlan.u),
    y: Number(pathPlan.v),
    z: 0,
  };
  if (!samePoint(pathStart, expectedStart)) {
    return unresolved('small-beam-vertical-90-r10-member-end-start-mismatch', {
      pathStart,
      expectedStart,
    });
  }

  if (
    built.path.metadata?.coordinateSpace !== 'anchor-local' ||
    built.path.metadata?.anchor !== pathPlan.anchor ||
    built.path.metadata?.bendGeometry !== 'actual-arc'
  ) {
    return unresolved('small-beam-vertical-90-r10-metadata-mismatch', {
      pathMetadata: built.path.metadata || null,
    });
  }

  const arcs = built.path.primitives.filter((primitive) => primitive?.type === 'arc');
  if (arcs.length !== 1) {
    return unresolved('small-beam-vertical-90-r10-arc-count-mismatch', {
      arcCount: arcs.length,
    });
  }
  const arc = arcs[0];
  if (
    !closeEnough(arc.radius, pathPlan.centerlineRadiusMm) ||
    Math.abs(Number(arc.sweepAngleRad) - Math.PI / 2) > ANGLE_TOLERANCE_RAD
  ) {
    return unresolved('small-beam-vertical-90-r10-arc-geometry-mismatch', {
      arcRadiusMm: Number(arc.radius),
      expectedRadiusMm: Number(pathPlan.centerlineRadiusMm),
      sweepAngleRad: Number(arc.sweepAngleRad),
    });
  }

  if (
    !closeEnough(built.sharpCorner?.z, pathPlan.sharpCornerAtMm) ||
    !closeEnough(built.incomingTangent?.z, pathPlan.incomingTangentAtMm) ||
    !closeEnough(built.tailLengthMm, pathPlan.tailLengthMm)
  ) {
    return unresolved('small-beam-vertical-90-r10-plan-geometry-mismatch', {
      r10SharpCornerAtMm: built.sharpCorner?.z ?? null,
      plannedSharpCornerAtMm: pathPlan.sharpCornerAtMm ?? null,
      r10IncomingTangentAtMm: built.incomingTangent?.z ?? null,
      plannedIncomingTangentAtMm: pathPlan.incomingTangentAtMm ?? null,
      r10TailLengthMm: built.tailLengthMm ?? null,
      plannedTailLengthMm: pathPlan.tailLengthMm ?? null,
    });
  }

  const pathCenterlineFromMemberEndMm = getCenterlineLength(built.path);
  const actualTotalFromNearMm = nearFaceFromMemberEndMm + pathCenterlineFromMemberEndMm;
  if (
    !Number.isFinite(pathCenterlineFromMemberEndMm) ||
    !closeEnough(actualTotalFromNearMm, selectedTotalFromNearMm)
  ) {
    return unresolved('small-beam-vertical-90-r10-centerline-length-mismatch', {
      pathCenterlineFromMemberEndMm,
      nearFaceFromMemberEndMm,
      actualTotalFromNearMm,
      selectedTotalFromNearMm,
    });
  }

  return {
    resolved: true,
    actualPathReady: true,
    productionReady: false,
    reason: null,
    source: SOURCE,
    mode: 'VERTICAL_90',
    anchor: pathPlan.anchor,
    supportId: pathPlan.supportId || null,
    barIndex: Number.isInteger(pathPlan.barIndex) ? pathPlan.barIndex : null,
    layer: pathPlan.layer ?? null,
    identityKey: pathPlan.identityKey || null,
    u: Number(pathPlan.u),
    v: Number(pathPlan.v),
    barDiaMm: Number(pathPlan.barDiaMm),
    grade: pathPlan.grade || null,
    coordinateSpace: 'anchor-local',
    bendGeometry: 'actual-arc',
    path: built.path,
    validation,
    pathStart,
    sharpCornerAtMm: Number(built.sharpCorner.z),
    incomingTangentAtMm: Number(built.incomingTangent.z),
    outgoingTangent: built.outgoingTangent,
    centerlineRadiusMm: Number(built.centerlineRadiusMm),
    insideDiameterMm: Number(built.insideDiameterMm),
    tailLengthMm: Number(built.tailLengthMm),
    pathCenterlineFromMemberEndMm,
    nearFaceFromMemberEndMm,
    actualTotalFromNearMm,
    selectedTotalFromNearMm,
  };
}
