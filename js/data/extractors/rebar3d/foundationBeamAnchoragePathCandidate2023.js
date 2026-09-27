/**
 * @fileoverview R13 基礎大梁端部の2023標準図定着requirementを、
 * anchor-local RebarPath候補へ変換する。
 *
 * この層は中心線geometryだけを解決する。FoundationColumn鉛直範囲・かぶりとの
 * containmentは後段で確認するため、path生成に成功してもproductionReady=falseを維持する。
 *
 * 日建連・JSCA 2023 §3-2 / §6-1:
 * - STRAIGHT_L2: 直線定着 L2
 * - BENT_L2_LA_TAIL8D: 全長L2、投影長Laかつ3D/4、90°余長8d以上
 *
 * Laは仕口面から鉄筋外面までの投影要求として扱い、centerlineの鉛直脚位置は
 * `La - d/2` とする。総中心線長がL2に不足する場合は、8dを下限として余長を延長する。
 */

import { buildAnchoredHookPath } from './rebarHookGeometry.js';
import {
  createLine,
  createRebarPath,
  getCenterlineLength,
  getProjectedExtent,
  validateRebarPath,
} from './rebarPath.js';

const EPS_MM = 1e-6;
const SOURCE = 'NIKKENREN-JSCA-RC-REBAR-STANDARD-2023-FOUNDATION-BEAM-ANCHORAGE';

function result(status, reason, extra = {}) {
  return {
    status,
    resolved: status === 'READY',
    geometryReady: status === 'READY',
    productionReady: false,
    reason: reason || null,
    blockers: reason ? [reason] : [],
    productionBlockers:
      status === 'READY' ? ['foundation-anchorage-support-vertical-containment-unresolved'] : [],
    source: SOURCE,
    path: null,
    ...extra,
  };
}

function unresolved(reason, extra = {}) {
  return result('UNRESOLVED', reason, extra);
}

function blocked(reason, extra = {}) {
  return result('BLOCKED', reason, extra);
}

function invalid(reason, extra = {}) {
  return result('INVALID', reason, extra);
}

function ready(path, extra = {}) {
  return result('READY', null, { path, ...extra });
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function normalizeRole(value) {
  const role = String(value || '')
    .trim()
    .toLowerCase();
  return role === 'top' || role === 'bottom' ? role : null;
}

function requirementFromBar(bar) {
  const resolution = bar?.anchorageRequirementResolution || null;
  if (bar?.anchorageRequirementResolved !== true || resolution?.resolved !== true) return null;
  return resolution;
}

function metadata({ side, bar, requirement, extra = {} }) {
  return {
    memberId: null,
    memberTag: 'StbGirder',
    role: bar.role,
    layer: bar.layer ?? null,
    dia: Number(bar.diaMm),
    diaName: bar.designation || null,
    grade: bar.grade || null,
    endpoint: side,
    coordinateSpace: 'anchor-local',
    source: 'foundation-beam-r13-anchorage-candidate',
    ruleId: 'R13',
    anchorageMode: requirement.mode,
    projectionRequirementMm: Number(requirement.requiredAnchorageMm),
    totalLengthRequirementMm: Number(requirement.totalLengthRequirementMm),
    minimumTailRequirementMm: Number(requirement.tailRequirementMm || 0),
    ...extra,
  };
}

function resolveInputs(side, bar) {
  if (!['start', 'end'].includes(side)) return invalid('foundation-anchorage-path-side-invalid');
  const requirement = requirementFromBar(bar);
  if (!requirement) {
    return unresolved(
      bar?.anchorageRequirementReason || 'foundation-anchorage-path-requirement-unresolved',
    );
  }

  const role = normalizeRole(bar?.role);
  const u = finiteNumber(bar?.u);
  const v = finiteNumber(bar?.v);
  const diaMm = positiveNumber(bar?.diaMm);
  const availableProjectionMm = finiteNumber(bar?.availableProjectionMm);
  if (!role || u === null || v === null || diaMm === null || !bar?.grade) {
    return unresolved('foundation-anchorage-path-bar-facts-unresolved', {
      requirement,
      role,
      u,
      v,
      diaMm,
    });
  }
  if (availableProjectionMm === null || availableProjectionMm < 0) {
    return unresolved('foundation-anchorage-path-available-projection-unresolved', {
      requirement,
      role,
      u,
      v,
      diaMm,
    });
  }
  return {
    status: 'READY',
    resolved: true,
    requirement,
    role,
    u,
    v,
    diaMm,
    grade: String(bar.grade).trim().toUpperCase(),
    availableProjectionMm,
  };
}

function resolveStraightCandidate(side, bar, facts) {
  const requiredMm = positiveNumber(facts.requirement.requiredAnchorageMm);
  if (!requiredMm) return unresolved('foundation-anchorage-path-straight-length-unresolved');
  if (facts.availableProjectionMm + EPS_MM < requiredMm) {
    return blocked('foundation-anchorage-path-projection-insufficient', {
      requiredProjectionMm: requiredMm,
      availableProjectionMm: facts.availableProjectionMm,
      marginMm: facts.availableProjectionMm - requiredMm,
    });
  }

  const path = createRebarPath(
    [createLine({ x: facts.u, y: facts.v, z: 0 }, { x: facts.u, y: facts.v, z: -requiredMm })],
    metadata({
      side,
      bar,
      requirement: facts.requirement,
      extra: {
        bendGeometry: 'straight',
        projectedOuterSurfaceMm: requiredMm,
      },
    }),
  );
  if (!validateRebarPath(path).ok) {
    return invalid('foundation-anchorage-path-straight-invalid');
  }
  return ready(path, {
    mode: 'STRAIGHT_L2',
    role: facts.role,
    bendDirection: null,
    requiredProjectionMm: requiredMm,
    availableProjectionMm: facts.availableProjectionMm,
    marginMm: facts.availableProjectionMm - requiredMm,
    generatedCenterlineLengthMm: getCenterlineLength(path),
    projectedCenterlineExtentMm: getProjectedExtent(path, { x: 0, y: 0, z: 1 }),
    projectedOuterSurfaceMm: requiredMm,
  });
}

function resolveBentCandidate(side, bar, facts) {
  const requiredProjectionMm = positiveNumber(facts.requirement.requiredAnchorageMm);
  const totalLengthRequirementMm = positiveNumber(facts.requirement.totalLengthRequirementMm);
  const minimumTailRequirementMm = positiveNumber(facts.requirement.tailRequirementMm);
  if (!requiredProjectionMm || !totalLengthRequirementMm || !minimumTailRequirementMm) {
    return unresolved('foundation-anchorage-path-bent-requirement-unresolved');
  }
  if (facts.availableProjectionMm + EPS_MM < requiredProjectionMm) {
    return blocked('foundation-anchorage-path-projection-insufficient', {
      requiredProjectionMm,
      availableProjectionMm: facts.availableProjectionMm,
      marginMm: facts.availableProjectionMm - requiredProjectionMm,
    });
  }

  // 標準図の投影長は仕口面から鉄筋外面まで。RebarPathは中心線なのでd/2を控除する。
  const verticalLegCenterProjectionMm = requiredProjectionMm - facts.diaMm / 2;
  if (!(verticalLegCenterProjectionMm > 0)) {
    return invalid('foundation-anchorage-path-centerline-projection-invalid', {
      requiredProjectionMm,
      diaMm: facts.diaMm,
    });
  }

  // 8dを初期余長として一度解き、実曲げ半径からL2を満たすために必要な余長を再計算する。
  const provisional = buildAnchoredHookPath({
    anchor: side,
    at: -verticalLegCenterProjectionMm,
    u: facts.u,
    v: facts.v,
    barDiaMm: facts.diaMm,
    grade: facts.grade,
    bendAngleDeg: 90,
    outgoingDirection: { x: 0, y: facts.role === 'top' ? -1 : 1, z: 0 },
    tailLengthMm: minimumTailRequirementMm,
    metadata: metadata({
      side,
      bar,
      requirement: facts.requirement,
      extra: { bendGeometry: 'actual-arc' },
    }),
  });
  if (!provisional.ok || !provisional.path || !validateRebarPath(provisional.path).ok) {
    return unresolved(provisional.reason || 'foundation-anchorage-path-bend-geometry-unresolved');
  }

  const provisionalLengthMm = getCenterlineLength(provisional.path);
  const provisionalTailMm = positiveNumber(provisional.tailLengthMm);
  if (!provisionalTailMm) {
    return invalid('foundation-anchorage-path-tail-unresolved');
  }
  const fixedGeometryLengthMm = provisionalLengthMm - provisionalTailMm;
  const effectiveTailLengthMm = Math.max(
    minimumTailRequirementMm,
    totalLengthRequirementMm - fixedGeometryLengthMm,
  );

  const hook = buildAnchoredHookPath({
    anchor: side,
    at: -verticalLegCenterProjectionMm,
    u: facts.u,
    v: facts.v,
    barDiaMm: facts.diaMm,
    grade: facts.grade,
    bendAngleDeg: 90,
    outgoingDirection: { x: 0, y: facts.role === 'top' ? -1 : 1, z: 0 },
    tailLengthMm: effectiveTailLengthMm,
    metadata: metadata({
      side,
      bar,
      requirement: facts.requirement,
      extra: {
        bendGeometry: 'actual-arc',
        bendDirection: facts.role === 'top' ? 'DOWN' : 'UP',
        projectionMeasure: 'JOINT_FACE_TO_REBAR_OUTER_SURFACE',
        verticalLegCenterProjectionMm,
      },
    }),
  });
  if (!hook.ok || !hook.path || !validateRebarPath(hook.path).ok) {
    return unresolved(hook.reason || 'foundation-anchorage-path-generated-hook-invalid');
  }

  const generatedCenterlineLengthMm = getCenterlineLength(hook.path);
  const projectedCenterlineExtentMm = getProjectedExtent(hook.path, { x: 0, y: 0, z: 1 });
  const projectedOuterSurfaceMm = projectedCenterlineExtentMm + facts.diaMm / 2;
  if (generatedCenterlineLengthMm + EPS_MM < totalLengthRequirementMm) {
    return blocked('foundation-anchorage-path-total-length-insufficient', {
      generatedCenterlineLengthMm,
      totalLengthRequirementMm,
    });
  }
  if (projectedOuterSurfaceMm + EPS_MM < requiredProjectionMm) {
    return blocked('foundation-anchorage-path-projection-contract-mismatch', {
      projectedOuterSurfaceMm,
      requiredProjectionMm,
    });
  }

  return ready(hook.path, {
    mode: 'BENT_L2_LA_TAIL8D',
    role: facts.role,
    bendDirection: facts.role === 'top' ? 'DOWN' : 'UP',
    requiredProjectionMm,
    availableProjectionMm: facts.availableProjectionMm,
    marginMm: facts.availableProjectionMm - requiredProjectionMm,
    totalLengthRequirementMm,
    minimumTailRequirementMm,
    effectiveTailLengthMm: hook.tailLengthMm,
    verticalLegCenterProjectionMm,
    centerlineRadiusMm: hook.centerlineRadiusMm,
    insideDiameterMm: hook.insideDiameterMm,
    generatedCenterlineLengthMm,
    projectedCenterlineExtentMm,
    projectedOuterSurfaceMm,
  });
}

/**
 * 1本の基礎大梁端部主筋についてanchor-local定着path候補を作る。
 * production描画への接続はFoundationColumn鉛直containment解決後に行う。
 */
export function resolveFoundationBeamAnchoragePathCandidate2023({ side, bar } = {}) {
  const facts = resolveInputs(side, bar);
  if (!facts.resolved) return facts;

  if (facts.requirement.mode === 'STRAIGHT_L2') {
    return resolveStraightCandidate(side, bar, facts);
  }
  if (facts.requirement.mode === 'BENT_L2_LA_TAIL8D') {
    return resolveBentCandidate(side, bar, facts);
  }
  return invalid('foundation-anchorage-path-mode-unsupported', {
    mode: facts.requirement.mode || null,
  });
}

export const _foundationBeamAnchoragePathCandidate2023Internals = Object.freeze({
  resolveInputs,
  resolveStraightCandidate,
  resolveBentCandidate,
  normalizeRole,
});
