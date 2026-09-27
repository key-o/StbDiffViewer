/**
 * @fileoverview R12-ZB 小梁カットオフのspan factsをR5 identity pathへ割り当てる。
 *
 * R12-ZAで確定した実支持面Lo・Lo/4・Lo/6・7Lo/12・2Lo/3と15d/20dを、
 * 既存member-local RebarPathの「どちらの材端へ到達しているか」へ投影する。
 * この段階ではpath自体を変更せず、identity単位のtarget stationだけを返す。
 */

import { validateRebarPath } from './rebarPath.js';
import { resolveSmallBeamCutoffBarRequirement } from './smallBeamCutoffFacts.js';

const SOURCE = 'R12-ZB-small-beam-cutoff-path-plan';
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

function nonNegativeMetadataMm(path, key) {
  const value = Number(path?.metadata?.[key] ?? 0);
  return Number.isFinite(value) && value > TOLERANCE_MM ? value : 0;
}

function endpointReach(path, baselineStartMm, baselineEndMm, memberLengthMm) {
  const startTrimMm = nonNegativeMetadataMm(path, 'jointTrimStartMm');
  const endTrimMm = nonNegativeMetadataMm(path, 'jointTrimEndMm');
  const startTrimMatches = startTrimMm <= 0 || close(baselineStartMm, startTrimMm);
  const endTrimMatches = endTrimMm <= 0 || close(baselineEndMm, memberLengthMm - endTrimMm);
  return {
    valid: startTrimMatches && endTrimMatches,
    touchesStart: startTrimMm > 0 ? startTrimMatches : close(baselineStartMm, 0),
    touchesEnd: endTrimMm > 0 ? endTrimMatches : close(baselineEndMm, memberLengthMm),
    startTrimMm,
    endTrimMm,
    expectedStartMm: startTrimMm > 0 ? startTrimMm : 0,
    expectedEndMm: endTrimMm > 0 ? memberLengthMm - endTrimMm : memberLengthMm,
  };
}

function planMode(touchesStart, touchesEnd) {
  if (touchesStart && touchesEnd) return 'THROUGH';
  if (touchesStart) return 'START_ANCHORED';
  if (touchesEnd) return 'END_ANCHORED';
  return 'CENTER';
}

/**
 * 主筋path 1本のcutoff target stationを解決する。
 */
export function resolveSmallBeamCutoffIdentityPathPlan({
  spanFact,
  path,
  memberLengthMm,
  pathIndex = null,
} = {}) {
  if (!spanFact?.resolved) {
    return unresolved(spanFact?.reason || 'small-beam-cutoff-span-unresolved');
  }
  const length = Number(memberLengthMm);
  if (!(length > 0)) return unresolved('small-beam-cutoff-member-length-unresolved');
  if (!path || !validateRebarPath(path).ok) {
    return unresolved('small-beam-cutoff-member-path-invalid');
  }
  if (path?.metadata?.coordinateSpace !== 'member-local') {
    return unresolved('small-beam-cutoff-member-path-space-mismatch');
  }
  const identityKey = String(path?.metadata?.identityKey || '').trim();
  const identityResolved = Boolean(identityKey) && path?.metadata?.unresolvedMatch !== true;
  const line = singleLine(path);
  if (!line) return unresolved('small-beam-cutoff-path-not-single-line', { identityKey });
  if (!close(line.start.x, line.end.x) || !close(line.start.y, line.end.y)) {
    return unresolved('small-beam-cutoff-path-not-axial', { identityKey });
  }

  const baselineStartMm = stationFromMemberStart(line.start.z, length);
  const baselineEndMm = stationFromMemberStart(line.end.z, length);
  if (
    !Number.isFinite(baselineStartMm) ||
    !Number.isFinite(baselineEndMm) ||
    !(baselineEndMm > baselineStartMm + TOLERANCE_MM)
  ) {
    return unresolved('small-beam-cutoff-path-station-invalid', { identityKey });
  }

  const role = path.metadata?.role;
  const barRequirement = resolveSmallBeamCutoffBarRequirement(spanFact, {
    role,
    dia: path.metadata?.dia,
  });
  if (!barRequirement.resolved) return unresolved(barRequirement.reason, { identityKey, role });

  // R7/R12-Yで材端側だけをtrim済みのpathも、別RebarPathで仕口・hookへ継続しているため
  // cutoff上は材端へ到達しているidentityとして扱う。trim metadataと実stationが不一致なら
  // 推定せずmember全体をfail-closedにする。
  const reach = endpointReach(path, baselineStartMm, baselineEndMm, length);
  if (!reach.valid) {
    return unresolved('small-beam-cutoff-endpoint-trim-station-mismatch', {
      identityKey,
      role,
      baselineStartMm,
      baselineEndMm,
      expectedStartMm: reach.expectedStartMm,
      expectedEndMm: reach.expectedEndMm,
      endpointTrimStartMm: reach.startTrimMm,
      endpointTrimEndMm: reach.endTrimMm,
    });
  }
  const mode = planMode(reach.touchesStart, reach.touchesEnd);
  const localPathIndex = Number(pathIndex);
  const pathMatchKind = identityResolved ? 'IDENTITY' : 'PATH_INDEX';
  if (
    !identityResolved &&
    (mode !== 'CENTER' || !Number.isInteger(localPathIndex) || localPathIndex < 0)
  ) {
    return unresolved('small-beam-cutoff-identity-unresolved', {
      identityKey: identityKey || null,
      role,
      mode,
      pathIndex: Number.isInteger(localPathIndex) ? localPathIndex : null,
    });
  }
  const pathLocator = identityResolved
    ? { kind: 'IDENTITY', identityKey }
    : {
        kind: 'PATH_INDEX',
        pathIndex: localPathIndex,
        baselineX: Number(line.start.x),
        baselineY: Number(line.start.y),
        baselineStartMm,
        baselineEndMm,
      };
  if (mode === 'THROUGH') {
    return {
      resolved: true,
      pathPlanReady: true,
      mutationRequired: false,
      reason: null,
      source: SOURCE,
      identityKey: identityKey || null,
      role,
      mode,
      pathMatchKind,
      pathIndex: pathMatchKind === 'PATH_INDEX' ? localPathIndex : null,
      pathLocator,
      baselineStartMm,
      baselineEndMm,
      targetStartMm: baselineStartMm,
      targetEndMm: baselineEndMm,
      endpointTrimStartMm: reach.startTrimMm,
      endpointTrimEndMm: reach.endTrimMm,
      barRequirement,
    };
  }

  const startReferenceMm =
    Number(spanFact.startNearFaceT) + barRequirement.startReferenceFromStartNearFaceMm;
  const endReferenceMm =
    Number(spanFact.startNearFaceT) + barRequirement.endReferenceFromStartNearFaceMm;
  const extensionMm = Number(barRequirement.requiredExtensionMm);
  if (![startReferenceMm, endReferenceMm, extensionMm].every(Number.isFinite)) {
    return unresolved('small-beam-cutoff-target-reference-unresolved', { identityKey, role });
  }

  let targetStartMm = baselineStartMm;
  let targetEndMm = baselineEndMm;
  if (mode === 'START_ANCHORED') {
    targetEndMm = startReferenceMm + extensionMm;
  } else if (mode === 'END_ANCHORED') {
    targetStartMm = endReferenceMm - extensionMm;
  } else {
    targetStartMm = startReferenceMm - extensionMm;
    targetEndMm = endReferenceMm + extensionMm;
  }

  if (
    targetStartMm < -TOLERANCE_MM ||
    targetEndMm > length + TOLERANCE_MM ||
    !(targetEndMm > targetStartMm + TOLERANCE_MM)
  ) {
    return unresolved('small-beam-cutoff-target-outside-member', {
      identityKey,
      role,
      mode,
      targetStartMm,
      targetEndMm,
      memberLengthMm: length,
    });
  }

  return {
    resolved: true,
    pathPlanReady: true,
    mutationRequired: !close(targetStartMm, baselineStartMm) || !close(targetEndMm, baselineEndMm),
    reason: null,
    source: SOURCE,
    identityKey: identityKey || null,
    role,
    mode,
    pathMatchKind,
    pathIndex: pathMatchKind === 'PATH_INDEX' ? localPathIndex : null,
    pathLocator,
    baselineStartMm,
    baselineEndMm,
    targetStartMm: Math.max(0, targetStartMm),
    targetEndMm: Math.min(length, targetEndMm),
    endpointTrimStartMm: reach.startTrimMm,
    endpointTrimEndMm: reach.endTrimMm,
    startReferenceMm,
    endReferenceMm,
    extensionMm,
    barRequirement,
  };
}

/**
 * 同一memberのR5 pathsを一括plan化する。identity重複や1本でもunresolvedがあればmember全体をreadyにしない。
 */
export function buildSmallBeamCutoffMemberPathPlan({
  spanFact,
  memberPaths,
  memberLengthMm,
  memberId = null,
} = {}) {
  const entries = [];
  const unresolvedFacts = [];
  const identityCounts = new Map();

  for (const [pathIndex, path] of (memberPaths || []).entries()) {
    if (path?.metadata?.role !== 'top' && path?.metadata?.role !== 'bottom') continue;
    const identityKey = String(path?.metadata?.identityKey || '').trim();
    if (identityKey) identityCounts.set(identityKey, (identityCounts.get(identityKey) || 0) + 1);
    const fact = resolveSmallBeamCutoffIdentityPathPlan({
      spanFact,
      path,
      memberLengthMm,
      pathIndex,
    });
    if (fact.resolved) entries.push(fact);
    else
      unresolvedFacts.push({
        identityKey: identityKey || null,
        role: path?.metadata?.role || null,
        pathIndex,
        reason: fact.reason,
      });
  }

  for (const [identityKey, count] of identityCounts) {
    if (count <= 1) continue;
    unresolvedFacts.push({
      identityKey,
      role: null,
      reason: 'small-beam-cutoff-identity-path-duplicate',
      candidateCount: count,
    });
  }

  const resolved = Boolean(spanFact?.resolved) && unresolvedFacts.length === 0;
  return {
    resolved,
    pathPlanReady: resolved,
    reason: resolved
      ? null
      : spanFact?.reason || unresolvedFacts[0]?.reason || 'small-beam-cutoff-plan-unresolved',
    source: SOURCE,
    memberId: memberId === null || memberId === undefined ? null : String(memberId),
    spanType: spanFact?.spanType || null,
    entries: resolved ? entries : [],
    unresolved: unresolvedFacts,
  };
}
