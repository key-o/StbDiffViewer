/**
 * @fileoverview R12-Y 小梁下端L3h actual hookをtrim済みmember主筋へ接続してworld化する。
 */

import { anchorLocalPathToWorldLines } from '../core/RebarPathWorldAdapter.js';
import { buildBeamMemberRebarPaths } from '../../../data/extractors/rebar3d/beamRebarPathBuilder.js';
import {
  createRebarPath,
  getPathEnd,
  getPathStart,
  rebarPathToLineSegments,
  validateRebarPath,
} from '../../../data/extractors/rebar3d/rebarPath.js';

const TOLERANCE_MM = 1e-5;

function closeEnough(left, right, tolerance = TOLERANCE_MM) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

function readyEntry(entry) {
  const path = entry?.productionPath;
  return (
    entry?.role === 'bottom' &&
    entry?.generationStatus === 'CENTERLINE_READY' &&
    entry.productionPathCandidate === true &&
    entry.productionConsumer === 'beam-anchor-local-path-with-main-trim' &&
    path?.metadata?.coordinateSpace === 'anchor-local' &&
    path?.metadata?.role === 'bottom' &&
    path?.metadata?.bendGeometry === 'actual-arc' &&
    path?.metadata?.bendDirection === 'UP' &&
    path?.metadata?.anchorageMode === 'HOOK_L3H_90'
  );
}

function anchorPathHonorsTrim(entry) {
  const path = entry?.productionPath;
  if (!path || !validateRebarPath(path).ok) return false;
  const trim = Number(entry?.trimRequiredMm ?? path.metadata?.mainBarTrimRequiredMm ?? 0);
  if (!(Number.isFinite(trim) && trim >= 0)) return false;
  const metadataTrim = Number(path.metadata?.mainBarTrimRequiredMm ?? 0);
  if (!closeEnough(metadataTrim, trim)) return false;

  const start = getPathStart(path);
  const expectedStartZ = trim > TOLERANCE_MM ? trim : 0;
  if (!start || !closeEnough(start.z, expectedStartZ)) return false;

  // main barを切り戻した位置よりさらに部材内側へhookが侵入しないことを確認する。
  for (const line of rebarPathToLineSegments(path)) {
    for (const point of [line.start, line.end]) {
      if (!Number.isFinite(Number(point?.z)) || Number(point.z) > trim + TOLERANCE_MM) return false;
    }
  }
  return true;
}

function matchingTrimmedMemberPaths(paths, entry, memberLengthMm) {
  const hookStart = getPathStart(entry.productionPath);
  const side = entry.side;
  const trim = Number(entry.trimRequiredMm || 0);
  const expectedZ = side === 'start' ? -memberLengthMm / 2 + trim : memberLengthMm / 2 - trim;

  return (paths || []).filter((path) => {
    if (
      path?.metadata?.coordinateSpace !== 'member-local' ||
      path.metadata?.identityKey !== entry.identityKey ||
      path.metadata?.role !== 'bottom' ||
      !validateRebarPath(path).ok
    ) {
      return false;
    }
    const endpoint = side === 'start' ? getPathStart(path) : getPathEnd(path);
    return (
      closeEnough(endpoint?.x, hookStart?.x) &&
      closeEnough(endpoint?.y, hookStart?.y) &&
      closeEnough(endpoint?.z, expectedZ)
    );
  });
}

/**
 * R12-Y production planをworld pathへ変換する。
 * 同じidentityのmember主筋が要求trim位置に一意に到達している場合だけhookを描画する。
 */
export function resolveSmallBeamBottomL3hWorldPaths({
  memberPlan,
  memberPaths,
  placement,
  memberLengthMm,
  memberId,
  sectionId = null,
} = {}) {
  const paths = [];
  const unresolved = [];
  if (!memberPlan?.entries?.length) return { paths, unresolved };
  if (!(Number(memberLengthMm) > 0) || !placement) {
    return { paths, unresolved: [{ reason: 'small-beam-bottom-L3h-render-placement-unresolved' }] };
  }
  if (
    memberPlan.sectionId !== null &&
    memberPlan.sectionId !== undefined &&
    String(memberPlan.sectionId) !== String(sectionId)
  ) {
    return { paths, unresolved: [{ reason: 'small-beam-bottom-L3h-render-section-mismatch' }] };
  }

  for (const entry of memberPlan.entries) {
    const path = entry?.productionPath;
    if (!readyEntry(entry)) {
      unresolved.push({ reason: 'small-beam-bottom-L3h-render-gate-not-ready', entry });
      continue;
    }
    if (!['start', 'end'].includes(entry.side) || !entry.identityKey) {
      unresolved.push({ reason: 'small-beam-bottom-L3h-render-identity-unresolved', entry });
      continue;
    }
    if (
      path.metadata?.identityKey !== entry.identityKey ||
      String(path.metadata?.memberId || '') !== String(memberId || '')
    ) {
      unresolved.push({ reason: 'small-beam-bottom-L3h-render-path-identity-mismatch', entry });
      continue;
    }
    if (!anchorPathHonorsTrim(entry)) {
      unresolved.push({ reason: 'small-beam-bottom-L3h-render-trim-contract-mismatch', entry });
      continue;
    }

    const candidates = matchingTrimmedMemberPaths(memberPaths, entry, Number(memberLengthMm));
    if (candidates.length !== 1) {
      unresolved.push({
        reason:
          candidates.length === 0
            ? 'small-beam-bottom-L3h-render-main-path-unresolved'
            : 'small-beam-bottom-L3h-render-main-path-ambiguous',
        entry,
        candidateCount: candidates.length,
      });
      continue;
    }

    const world = anchorLocalPathToWorldLines(path, placement, {
      anchor: entry.side,
      memberId,
      memberTag: 'StbBeam',
    });
    if (!world || !validateRebarPath(world).ok) {
      unresolved.push({ reason: 'small-beam-bottom-L3h-render-world-path-invalid', entry });
      continue;
    }

    const worldPath = createRebarPath(world.primitives, {
      ...world.metadata,
      source: 'small-beam-r12-bottom-L3h-world',
      ruleId: 'R12-Y',
      renderReady: true,
      generationStatus: 'CENTERLINE_READY',
      productionPathCandidate: true,
      productionConsumer: 'explicit-world-path',
      memberId: String(memberId),
      memberTag: 'StbBeam',
      endpoint: entry.side,
      identityKey: entry.identityKey,
      mainBarTrimRequiredMm: Number(entry.trimRequiredMm || 0),
    });
    if (!validateRebarPath(worldPath).ok) {
      unresolved.push({ reason: 'small-beam-bottom-L3h-render-world-path-invalid', entry });
      continue;
    }
    paths.push(worldPath);
  }

  return { paths, unresolved };
}

/**
 * R12-Yのmain-bar trimとhook描画をmember単位で原子的に適用する。
 * candidate build / world continuityのどちらかが成立しない場合は、R12-Y trimを含まない
 * baseline buildへ戻し、hook pathも返さない。
 */
export function buildSmallBeamBottomL3hMemberMutation({
  layout,
  memberLengthMm,
  memberId,
  memberPlan,
  placement,
  sectionId = null,
  existingEndpointTrims = [],
  haunchTransitions = [],
  endpointInsets = [],
  positionToleranceMm = undefined,
} = {}) {
  const commonOptions = {
    memberId,
    haunchTransitions,
    endpointInsets,
    ...(Number.isFinite(Number(positionToleranceMm)) ? { positionToleranceMm } : {}),
  };
  const baseline = buildBeamMemberRebarPaths(layout, memberLengthMm, {
    ...commonOptions,
    endpointTrims: existingEndpointTrims,
  });
  if (!memberPlan?.entries?.length) {
    return { built: baseline, paths: [], unresolved: [], applied: false, reason: null };
  }

  const plannedTrims = Array.isArray(memberPlan.endpointTrims) ? memberPlan.endpointTrims : [];
  if (plannedTrims.some((spec) => !spec?.identityKey || !(Number(spec?.trimMm) > 0))) {
    return {
      built: baseline,
      paths: [],
      unresolved: [{ reason: 'small-beam-bottom-L3h-member-trim-plan-invalid' }],
      applied: false,
      reason: 'small-beam-bottom-L3h-member-trim-plan-invalid',
    };
  }

  const candidate = buildBeamMemberRebarPaths(layout, memberLengthMm, {
    ...commonOptions,
    endpointTrims: [...existingEndpointTrims, ...plannedTrims],
  });
  const baselineHaunchUnresolved = baseline.haunchTransitions?.unresolved?.length || 0;
  const candidateHaunchUnresolved = candidate.haunchTransitions?.unresolved?.length || 0;
  if (candidateHaunchUnresolved > baselineHaunchUnresolved) {
    return {
      built: baseline,
      paths: [],
      unresolved: [{ reason: 'small-beam-bottom-L3h-member-trim-haunch-conflict' }],
      applied: false,
      reason: 'small-beam-bottom-L3h-member-trim-haunch-conflict',
    };
  }

  const resolved = resolveSmallBeamBottomL3hWorldPaths({
    memberPlan,
    memberPaths: candidate.paths,
    placement,
    memberLengthMm,
    memberId,
    sectionId,
  });
  if (resolved.unresolved.length > 0 || resolved.paths.length !== memberPlan.entries.length) {
    return {
      built: baseline,
      paths: [],
      unresolved:
        resolved.unresolved.length > 0
          ? resolved.unresolved
          : [{ reason: 'small-beam-bottom-L3h-member-mutation-count-mismatch' }],
      applied: false,
      reason:
        resolved.unresolved[0]?.reason || 'small-beam-bottom-L3h-member-mutation-count-mismatch',
    };
  }

  return {
    built: candidate,
    paths: resolved.paths,
    unresolved: [],
    applied: true,
    reason: null,
  };
}
