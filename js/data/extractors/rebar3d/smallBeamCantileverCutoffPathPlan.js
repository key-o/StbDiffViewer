/**
 * @fileoverview R12-AB 片持ち小梁上端2段筋の 2L/3+15d をR5 identity pathへ割り当てる。
 *
 * R12-AAで確定した実支持面基準の片持ち長さLを、member-local top/layer=2 pathの
 * 自由端側cutoff stationへ投影する。この段階ではpath自体を変更しない。
 */

import { validateRebarPath } from './rebarPath.js';

const SOURCE = 'R12-AB-small-beam-cantilever-cutoff-path-plan';
const TOLERANCE_MM = 1e-6;

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    pathPlanReady: false,
    reason,
    source: SOURCE,
    ...extra,
  };
}

function singleLine(path) {
  return path?.primitives?.length === 1 && path.primitives[0]?.type === 'line'
    ? path.primitives[0]
    : null;
}

function stationFromMemberStart(z, memberLengthMm) {
  return Number(z) + memberLengthMm / 2;
}

function close(left, right) {
  return Math.abs(Number(left) - Number(right)) <= TOLERANCE_MM;
}

function gradeKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function trimAt(path, side) {
  const key = side === 'start' ? 'jointTrimStartMm' : 'jointTrimEndMm';
  const value = Number(path?.metadata?.[key] ?? 0);
  return Number.isFinite(value) && value > TOLERANCE_MM ? value : 0;
}

function supportReach(path, line, supportSide, memberLengthMm) {
  const startMm = stationFromMemberStart(line.start.z, memberLengthMm);
  const endMm = stationFromMemberStart(line.end.z, memberLengthMm);
  const trimMm = trimAt(path, supportSide);
  const expectedMm =
    supportSide === 'start'
      ? trimMm > 0
        ? trimMm
        : 0
      : trimMm > 0
        ? memberLengthMm - trimMm
        : memberLengthMm;
  const actualMm = supportSide === 'start' ? startMm : endMm;
  return {
    resolved: close(actualMm, expectedMm),
    startMm,
    endMm,
    trimMm,
    actualMm,
    expectedMm,
  };
}

function isTopSecondLayer(path) {
  return path?.metadata?.role === 'top' && Number(path?.metadata?.layer) === 2;
}

/**
 * R12-AAのproduction factはbar groupごとにpatternを保持する。
 * direct resolveSmallBeamCantileverSpanFact() の互換形(topSecondLayerCutoff直下)も残しつつ、
 * 実productionではpathのrole/dia/gradeに完全一致するtop groupを一意に選ぶ。
 */
function resolveTopSecondLayerPattern(cantileverFact, path) {
  if (cantileverFact?.topSecondLayerCutoff) {
    return {
      resolved: true,
      pattern: cantileverFact.topSecondLayerCutoff,
      patternSource: 'direct',
      group: null,
    };
  }

  const diaMm = Number(path?.metadata?.dia);
  const pathGrade = gradeKey(path?.metadata?.grade);
  if (!(diaMm > 0)) {
    return { resolved: false, reason: 'small-beam-cantilever-cutoff-bar-diameter-unresolved' };
  }
  if (!pathGrade) {
    return {
      resolved: false,
      reason: 'small-beam-cantilever-cutoff-bar-grade-unresolved',
      diaMm,
      grade: null,
    };
  }

  const candidates = (cantileverFact?.groups || []).filter(
    (group) =>
      group?.role === 'top' &&
      close(Number(group?.diaMm), diaMm) &&
      gradeKey(group?.grade) === pathGrade,
  );

  if (candidates.length !== 1) {
    return {
      resolved: false,
      reason:
        candidates.length === 0
          ? 'small-beam-cantilever-cutoff-pattern-group-missing'
          : 'small-beam-cantilever-cutoff-pattern-group-ambiguous',
      candidateCount: candidates.length,
      diaMm,
      grade: pathGrade,
    };
  }

  const pattern = candidates[0]?.pattern?.topSecondLayerCutoff;
  if (!pattern) {
    return {
      resolved: false,
      reason: 'small-beam-cantilever-cutoff-pattern-unresolved',
      candidateCount: 1,
      diaMm,
      grade: pathGrade,
    };
  }

  return {
    resolved: true,
    pattern,
    patternSource: 'group',
    group: candidates[0],
  };
}

/** 片持ち小梁上端2段筋1本の自由端側cutoff targetを解決する。 */
export function resolveSmallBeamCantileverCutoffIdentityPathPlan({
  cantileverFact,
  path,
  memberLengthMm,
} = {}) {
  if (!cantileverFact?.resolved) {
    return unresolved(cantileverFact?.reason || 'small-beam-cantilever-fact-unresolved');
  }
  const length = Number(memberLengthMm);
  if (!(length > 0)) return unresolved('small-beam-cantilever-member-length-unresolved');
  if (!path || !validateRebarPath(path).ok) {
    return unresolved('small-beam-cantilever-member-path-invalid');
  }
  if (path?.metadata?.coordinateSpace !== 'member-local') {
    return unresolved('small-beam-cantilever-member-path-space-mismatch');
  }
  if (!isTopSecondLayer(path)) {
    return unresolved('small-beam-cantilever-path-not-top-second-layer', {
      role: path?.metadata?.role || null,
      layer: path?.metadata?.layer ?? null,
    });
  }

  const identityKey = String(path?.metadata?.identityKey || '').trim();
  if (!identityKey || path?.metadata?.unresolvedMatch === true) {
    return unresolved('small-beam-cantilever-identity-unresolved', {
      identityKey: identityKey || null,
    });
  }
  const line = singleLine(path);
  if (!line) return unresolved('small-beam-cantilever-path-not-single-line', { identityKey });
  if (!close(line.start.x, line.end.x) || !close(line.start.y, line.end.y)) {
    return unresolved('small-beam-cantilever-path-not-axial', { identityKey });
  }

  const supportSide = cantileverFact.supportSide;
  if (!['start', 'end'].includes(supportSide)) {
    return unresolved('small-beam-cantilever-support-side-unresolved', { identityKey });
  }
  const reach = supportReach(path, line, supportSide, length);
  if (!reach.resolved) {
    return unresolved('small-beam-cantilever-support-endpoint-unresolved', {
      identityKey,
      supportSide,
      actualSupportStationMm: reach.actualMm,
      expectedSupportStationMm: reach.expectedMm,
      supportTrimMm: reach.trimMm,
    });
  }

  const patternResolution = resolveTopSecondLayerPattern(cantileverFact, path);
  if (!patternResolution.resolved) {
    return unresolved(patternResolution.reason, {
      identityKey,
      candidateCount: patternResolution.candidateCount ?? null,
      diaMm: patternResolution.diaMm ?? Number(path?.metadata?.dia) ?? null,
      grade: patternResolution.grade ?? (gradeKey(path?.metadata?.grade) || null),
    });
  }
  const groupPattern = patternResolution.pattern;
  const requiredFromSupportMm = Number(groupPattern?.requiredFromSupportMm);
  if (!(requiredFromSupportMm > 0)) {
    return unresolved('small-beam-cantilever-cutoff-length-unresolved', { identityKey });
  }
  if (groupPattern?.fitsWithinCantilever === false) {
    return unresolved('small-beam-cantilever-cutoff-exceeds-cantilever', {
      identityKey,
      requiredFromSupportMm,
      cantileverLengthMm: cantileverFact.cantileverLengthMm,
    });
  }

  const supportNearFaceT = Number(cantileverFact.supportNearFaceT);
  const freeTipT = Number(cantileverFact.freeTipT);
  if (![supportNearFaceT, freeTipT].every(Number.isFinite)) {
    return unresolved('small-beam-cantilever-cutoff-station-unresolved', { identityKey });
  }

  let targetStartMm = reach.startMm;
  let targetEndMm = reach.endMm;
  if (supportSide === 'start') {
    targetEndMm = supportNearFaceT + requiredFromSupportMm;
    if (targetEndMm > freeTipT + TOLERANCE_MM) {
      return unresolved('small-beam-cantilever-cutoff-target-beyond-free-end', {
        identityKey,
        targetEndMm,
        freeTipT,
      });
    }
  } else {
    targetStartMm = supportNearFaceT - requiredFromSupportMm;
    if (targetStartMm < freeTipT - TOLERANCE_MM) {
      return unresolved('small-beam-cantilever-cutoff-target-beyond-free-end', {
        identityKey,
        targetStartMm,
        freeTipT,
      });
    }
  }

  if (
    targetStartMm < -TOLERANCE_MM ||
    targetEndMm > length + TOLERANCE_MM ||
    !(targetEndMm > targetStartMm + TOLERANCE_MM)
  ) {
    return unresolved('small-beam-cantilever-cutoff-target-invalid', {
      identityKey,
      targetStartMm,
      targetEndMm,
      memberLengthMm: length,
    });
  }

  return {
    resolved: true,
    pathPlanReady: true,
    mutationRequired: !close(targetStartMm, reach.startMm) || !close(targetEndMm, reach.endMm),
    reason: null,
    source: SOURCE,
    identityKey,
    role: 'top',
    layer: 2,
    supportSide,
    supportTrimMm: reach.trimMm,
    baselineStartMm: reach.startMm,
    baselineEndMm: reach.endMm,
    targetStartMm: Math.max(0, targetStartMm),
    targetEndMm: Math.min(length, targetEndMm),
    supportNearFaceT,
    freeTipT,
    requiredFromSupportMm,
    referenceFromSupportMm: Number(groupPattern.referenceFromSupportMm),
    extensionMm: Number(groupPattern.extensionMm),
    extensionDiaFactor: Number(groupPattern.extensionDiaFactor),
    patternSource: patternResolution.patternSource,
  };
}

/** member内のtop/layer=2 identityをまとめてplan化する。 */
export function buildSmallBeamCantileverCutoffMemberPathPlan({
  cantileverFact,
  memberPaths,
  memberLengthMm,
  memberPlanLengthMm = null,
  memberId = null,
} = {}) {
  if (!cantileverFact?.resolved) {
    return unresolved(cantileverFact?.reason || 'small-beam-cantilever-fact-unresolved', {
      memberId: memberId == null ? null : String(memberId),
      entries: [],
      unresolved: [],
    });
  }

  const length = Number(memberLengthMm);
  const planLengthProvided = memberPlanLengthMm !== null && memberPlanLengthMm !== undefined;
  const planLength = Number(memberPlanLengthMm);
  if (!(length > 0)) {
    return unresolved('small-beam-cantilever-member-length-unresolved', {
      entries: [],
      unresolved: [],
    });
  }
  if (planLengthProvided && !(planLength > 0)) {
    return unresolved('small-beam-cantilever-plan-length-unresolved', {
      entries: [],
      unresolved: [],
    });
  }
  if (planLengthProvided && Math.abs(length - planLength) > 1e-5) {
    return unresolved('small-beam-cantilever-sloped-member-unsupported', {
      entries: [],
      unresolved: [],
      memberLengthMm: length,
      memberPlanLengthMm: planLength,
    });
  }

  const candidates = (memberPaths || []).filter(isTopSecondLayer);
  if (candidates.length === 0) {
    return {
      resolved: true,
      pathPlanReady: true,
      reason: null,
      source: SOURCE,
      memberId: memberId == null ? null : String(memberId),
      entries: [],
      unresolved: [],
      noSecondLayer: true,
    };
  }

  const identityCounts = new Map();
  const entries = [];
  const unresolvedFacts = [];
  for (const path of candidates) {
    const identityKey = String(path?.metadata?.identityKey || '').trim();
    if (identityKey) identityCounts.set(identityKey, (identityCounts.get(identityKey) || 0) + 1);
    const entry = resolveSmallBeamCantileverCutoffIdentityPathPlan({
      cantileverFact,
      path,
      memberLengthMm: length,
    });
    if (entry.resolved) entries.push(entry);
    else {
      unresolvedFacts.push({
        identityKey: identityKey || null,
        reason: entry.reason,
      });
    }
  }

  for (const [identityKey, count] of identityCounts) {
    if (count <= 1) continue;
    unresolvedFacts.push({
      identityKey,
      reason: 'small-beam-cantilever-identity-path-duplicate',
      candidateCount: count,
    });
  }

  const resolved = unresolvedFacts.length === 0;
  return {
    resolved,
    pathPlanReady: resolved,
    reason: resolved
      ? null
      : unresolvedFacts[0]?.reason || 'small-beam-cantilever-cutoff-plan-unresolved',
    source: SOURCE,
    memberId: memberId == null ? null : String(memberId),
    supportSide: cantileverFact.supportSide,
    entries: resolved ? entries : [],
    unresolved: unresolvedFacts,
    noSecondLayer: false,
  };
}
