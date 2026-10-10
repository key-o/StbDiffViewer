/** @fileoverview R12-AF 片持ち小梁自由端hookをtrim済みtop主筋へ接続してworld化する。 */
import { anchorLocalPathToWorldLines } from '../core/RebarPathWorldAdapter.js';
import {
  createLine,
  createRebarPath,
  getPathEnd,
  getPathStart,
  rebarPathToLineSegments,
  validateRebarPath,
} from '../../../data/extractors/rebar3d/rebarPath.js';

const TOLERANCE_MM = 1e-5;

function closeEnough(left, right, tolerance = TOLERANCE_MM) {
  const a = Number(left),
    b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}
function singleLine(path) {
  return path?.primitives?.length === 1 && path.primitives[0]?.type === 'line'
    ? path.primitives[0]
    : null;
}
function readyEntry(entry) {
  const path = entry?.productionPath;
  return (
    entry?.role === 'top' &&
    entry?.generationStatus === 'CENTERLINE_READY' &&
    entry.productionPathCandidate === true &&
    entry.productionConsumer === 'beam-anchor-local-path-with-main-trim' &&
    path?.metadata?.coordinateSpace === 'anchor-local' &&
    path?.metadata?.role === 'top' &&
    path?.metadata?.bendGeometry === 'actual-arc' &&
    path?.metadata?.bendDirection === 'DOWN' &&
    path?.metadata?.anchorageMode === 'CANTILEVER_FREE_TIP_90'
  );
}
function anchorPathHonorsTrim(entry) {
  const path = entry?.productionPath;
  if (!path || !validateRebarPath(path).ok) return false;
  const trim = Number(entry?.trimRequiredMm ?? path.metadata?.mainBarTrimRequiredMm),
    metadataTrim = Number(path.metadata?.mainBarTrimRequiredMm);
  if (!(trim > 0) || !closeEnough(metadataTrim, trim)) return false;
  const start = getPathStart(path);
  if (!start || !closeEnough(start.z, trim)) return false;
  for (const line of rebarPathToLineSegments(path))
    for (const point of [line.start, line.end]) {
      const z = Number(point?.z);
      if (!Number.isFinite(z) || z > trim + TOLERANCE_MM) return false;
    }
  return true;
}
function endpointPoint(path, side) {
  return side === 'start' ? getPathStart(path) : getPathEnd(path);
}
function targetCandidates(paths, entry, memberLengthMm) {
  const side = entry.side,
    endpointZ = side === 'start' ? -memberLengthMm / 2 : memberLengthMm / 2,
    hookStart = getPathStart(entry.productionPath);
  return (paths || []).filter((path) => {
    const line = singleLine(path);
    if (
      !line ||
      path?.metadata?.coordinateSpace !== 'member-local' ||
      path.metadata?.identityKey !== entry.identityKey ||
      path.metadata?.role !== 'top' ||
      !validateRebarPath(path).ok
    )
      return false;
    const endpoint = endpointPoint(path, side);
    return (
      closeEnough(endpoint?.x, hookStart?.x) &&
      closeEnough(endpoint?.y, hookStart?.y) &&
      closeEnough(endpoint?.z, endpointZ)
    );
  });
}
function trimPath(path, side, trimMm, memberLengthMm) {
  const line = singleLine(path);
  if (!line || !(trimMm > 0) || !(memberLengthMm > 0)) return null;
  const start = { ...line.start },
    end = { ...line.end };
  if (side === 'start') start.z = Number(start.z) + trimMm;
  else if (side === 'end') end.z = Number(end.z) - trimMm;
  else return null;
  if (!(Number(end.z) > Number(start.z) + TOLERANCE_MM)) return null;
  const trimmed = createRebarPath([createLine(start, end)], {
    ...path.metadata,
    cantileverFreeTipTrimmed: true,
    cantileverFreeTipTrimMm: trimMm,
    cantileverFreeTipEndpoint: side,
  });
  return validateRebarPath(trimmed).ok ? trimmed : null;
}
function applyMemberTrims(memberPlan, memberPaths, memberLengthMm) {
  const baseline = Array.isArray(memberPaths) ? memberPaths : [];
  let working = baseline.slice();
  const unresolved = [];
  for (const entry of memberPlan?.entries || []) {
    if (!readyEntry(entry) || !['start', 'end'].includes(entry.side) || !entry.identityKey) {
      unresolved.push({ reason: 'small-beam-cantilever-free-tip-mutation-entry-invalid', entry });
      break;
    }
    if (!anchorPathHonorsTrim(entry)) {
      unresolved.push({
        reason: 'small-beam-cantilever-free-tip-mutation-trim-contract-mismatch',
        entry,
      });
      break;
    }
    const candidates = targetCandidates(working, entry, Number(memberLengthMm));
    if (candidates.length !== 1) {
      unresolved.push({
        reason:
          candidates.length === 0
            ? 'small-beam-cantilever-free-tip-main-path-unresolved'
            : 'small-beam-cantilever-free-tip-main-path-ambiguous',
        entry,
        candidateCount: candidates.length,
      });
      break;
    }
    const target = candidates[0],
      trimmed = trimPath(target, entry.side, Number(entry.trimRequiredMm), Number(memberLengthMm));
    if (!trimmed) {
      unresolved.push({ reason: 'small-beam-cantilever-free-tip-main-path-trim-invalid', entry });
      break;
    }
    working = working.map((path) => (path === target ? trimmed : path));
  }
  return unresolved.length > 0
    ? { paths: baseline, unresolved, applied: false }
    : { paths: working, unresolved: [], applied: (memberPlan?.entries || []).length > 0 };
}
function matchingTrimmedMemberPaths(paths, entry, memberLengthMm) {
  const hookStart = getPathStart(entry.productionPath),
    side = entry.side,
    trim = Number(entry.trimRequiredMm),
    expectedZ = side === 'start' ? -memberLengthMm / 2 + trim : memberLengthMm / 2 - trim;
  return (paths || []).filter((path) => {
    if (
      path?.metadata?.coordinateSpace !== 'member-local' ||
      path.metadata?.identityKey !== entry.identityKey ||
      path.metadata?.role !== 'top' ||
      !validateRebarPath(path).ok
    )
      return false;
    const endpoint = endpointPoint(path, side);
    return (
      closeEnough(endpoint?.x, hookStart?.x) &&
      closeEnough(endpoint?.y, hookStart?.y) &&
      closeEnough(endpoint?.z, expectedZ)
    );
  });
}

function resolveSmallBeamCantileverFreeTipWorldPaths({
  memberPlan,
  memberPaths,
  placement,
  memberLengthMm,
  memberId,
  sectionId = null,
} = {}) {
  const paths = [],
    unresolved = [];
  if (!memberPlan?.entries?.length) return { paths, unresolved };
  if (!(Number(memberLengthMm) > 0) || !placement)
    return {
      paths,
      unresolved: [{ reason: 'small-beam-cantilever-free-tip-render-placement-unresolved' }],
    };
  if (
    memberPlan.sectionId !== null &&
    memberPlan.sectionId !== undefined &&
    String(memberPlan.sectionId) !== String(sectionId)
  )
    return {
      paths,
      unresolved: [{ reason: 'small-beam-cantilever-free-tip-render-section-mismatch' }],
    };
  for (const entry of memberPlan.entries) {
    const path = entry.productionPath;
    if (!readyEntry(entry)) {
      unresolved.push({ reason: 'small-beam-cantilever-free-tip-render-gate-not-ready', entry });
      continue;
    }
    if (!anchorPathHonorsTrim(entry)) {
      unresolved.push({
        reason: 'small-beam-cantilever-free-tip-render-trim-contract-mismatch',
        entry,
      });
      continue;
    }
    if (
      path.metadata?.identityKey !== entry.identityKey ||
      String(path.metadata?.memberId || '') !== String(memberId || '')
    ) {
      unresolved.push({
        reason: 'small-beam-cantilever-free-tip-render-path-identity-mismatch',
        entry,
      });
      continue;
    }
    const candidates = matchingTrimmedMemberPaths(memberPaths, entry, Number(memberLengthMm));
    if (candidates.length !== 1) {
      unresolved.push({
        reason:
          candidates.length === 0
            ? 'small-beam-cantilever-free-tip-render-main-path-unresolved'
            : 'small-beam-cantilever-free-tip-render-main-path-ambiguous',
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
      unresolved.push({
        reason: 'small-beam-cantilever-free-tip-render-world-path-invalid',
        entry,
      });
      continue;
    }
    const worldPath = createRebarPath(world.primitives, {
      ...world.metadata,
      source: 'small-beam-r12-cantilever-free-tip-world',
      ruleId: 'R12-AF',
      renderReady: true,
      generationStatus: 'CENTERLINE_READY',
      productionPathCandidate: true,
      productionConsumer: 'explicit-world-path',
      memberId: String(memberId),
      memberTag: 'StbBeam',
      endpoint: entry.side,
      identityKey: entry.identityKey,
      mainBarTrimRequiredMm: Number(entry.trimRequiredMm),
      bendInsetFromTipMm: Number(entry.bendInsetMm),
    });
    if (!validateRebarPath(worldPath).ok) {
      unresolved.push({
        reason: 'small-beam-cantilever-free-tip-render-world-path-invalid',
        entry,
      });
      continue;
    }
    paths.push(worldPath);
  }
  return { paths, unresolved };
}

export function buildSmallBeamCantileverFreeTipMemberMutation({
  memberPlan,
  memberPaths,
  placement,
  memberLengthMm,
  memberId,
  sectionId = null,
} = {}) {
  const baseline = Array.isArray(memberPaths) ? memberPaths : [];
  if (!memberPlan?.entries?.length)
    return { memberPaths: baseline, paths: [], unresolved: [], applied: false, reason: null };
  const trimmed = applyMemberTrims(memberPlan, baseline, Number(memberLengthMm));
  if (!trimmed.applied)
    return {
      memberPaths: baseline,
      paths: [],
      unresolved: trimmed.unresolved,
      applied: false,
      reason:
        trimmed.unresolved[0]?.reason || 'small-beam-cantilever-free-tip-member-trim-unresolved',
    };
  const resolved = resolveSmallBeamCantileverFreeTipWorldPaths({
    memberPlan,
    memberPaths: trimmed.paths,
    placement,
    memberLengthMm,
    memberId,
    sectionId,
  });
  if (resolved.unresolved.length > 0 || resolved.paths.length !== memberPlan.entries.length)
    return {
      memberPaths: baseline,
      paths: [],
      unresolved:
        resolved.unresolved.length > 0
          ? resolved.unresolved
          : [{ reason: 'small-beam-cantilever-free-tip-member-mutation-count-mismatch' }],
      applied: false,
      reason:
        resolved.unresolved[0]?.reason ||
        'small-beam-cantilever-free-tip-member-mutation-count-mismatch',
    };
  return {
    memberPaths: trimmed.paths,
    paths: resolved.paths,
    unresolved: [],
    applied: true,
    reason: null,
  };
}
