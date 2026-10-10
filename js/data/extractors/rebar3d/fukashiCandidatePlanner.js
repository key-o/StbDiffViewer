/**
 * @fileoverview ConcreteDeficiencyをFACE_OFFSET/LOCAL_PRISM候補へdeterministicに変換する。
 */

import { evaluateConcreteDeficiency } from './concreteDeficiency.js';

const AUTO_FACES = new Set(['LEFT', 'RIGHT', 'BOTTOM', 'TOP']);

function cloneBounds(bounds) {
  return {
    min: { x: Number(bounds.min.x), y: Number(bounds.min.y), z: Number(bounds.min.z) },
    max: { x: Number(bounds.max.x), y: Number(bounds.max.y), z: Number(bounds.max.z) },
  };
}

function ceilTo(value, unit) {
  return Math.ceil((value - 1e-9) / unit) * unit;
}

function noCandidate(reason, extra = {}) {
  return {
    resolved: true,
    automaticCandidate: false,
    reason,
    candidate: null,
    ...extra,
  };
}

function deterministicId({
  hostMemberTag,
  hostMemberId,
  sourceRuleId,
  face,
  stationStartMm,
  stationEndMm,
}) {
  return [
    'FUKASHI',
    hostMemberTag || 'UNKNOWN',
    hostMemberId || 'UNKNOWN',
    sourceRuleId || 'UNKNOWN',
    face || 'SPECIAL',
    Number.isFinite(stationStartMm) ? stationStartMm : 'NA',
    Number.isFinite(stationEndMm) ? stationEndMm : 'NA',
  ].join(':');
}

export function planFukashiCandidate({
  deficiency,
  rule,
  hostMemberTag,
  hostMemberId,
  sourceType = 'REBAR_ENVELOPE',
  sourceRuleId = null,
  sourceIdentityKeys = [],
  fullLength = false,
  stationStartMm = null,
  stationEndMm = null,
} = {}) {
  if (!rule?.enabled) return noCandidate('CONCRETE_ACCOMMODATION_DISABLED');
  if (!deficiency?.resolved) return noCandidate('SPECIAL_DETAIL_REQUIRED');
  if (deficiency.satisfied) return noCandidate(null, { satisfied: true });
  if (
    !['CONCRETE_ENVELOPE_MISSING', 'ANCHORAGE_CONCRETE_MISSING', 'BEND_CONCRETE_MISSING'].includes(
      deficiency.reason,
    )
  ) {
    return noCandidate(deficiency.reason || 'SPECIAL_DETAIL_REQUIRED');
  }
  if (deficiency.missingFaces?.length !== 1) {
    return noCandidate('SPECIAL_DETAIL_REQUIRED', {
      missingFaces: deficiency.missingFaces || [],
    });
  }

  const face = deficiency.missingFaces[0];
  if (!AUTO_FACES.has(face)) {
    return noCandidate('SPECIAL_DETAIL_REQUIRED', { face });
  }
  const mode = fullLength ? 'FACE_OFFSET' : 'LOCAL_PRISM';
  if (mode === 'FACE_OFFSET' && !rule.allowFaceOffset) {
    return noCandidate('SPECIAL_DETAIL_REQUIRED');
  }
  if (mode === 'LOCAL_PRISM' && !rule.allowLocalPrism) {
    return noCandidate('SPECIAL_DETAIL_REQUIRED');
  }

  const rawRequiredMm = Number(deficiency.missingByFace?.[face]);
  const constructionMarginMm = Number(rule.constructionMarginMm);
  const roundingMm = Number(rule.roundingMm);
  const proposedThicknessMm = ceilTo(rawRequiredMm + constructionMarginMm, roundingMm);
  if (proposedThicknessMm > Number(rule.maxAutomaticFukashiMm)) {
    return noCandidate('EXCESSIVE_FUKASHI_REQUIRED', {
      face,
      rawRequiredMm,
      proposedThicknessMm,
    });
  }

  const normalizedStart = Number.isFinite(Number(stationStartMm)) ? Number(stationStartMm) : null;
  const normalizedEnd = Number.isFinite(Number(stationEndMm)) ? Number(stationEndMm) : null;
  const candidate = {
    id: deterministicId({
      hostMemberTag,
      hostMemberId,
      sourceRuleId,
      face,
      stationStartMm: normalizedStart,
      stationEndMm: normalizedEnd,
    }),
    hostMemberTag: hostMemberTag == null ? null : String(hostMemberTag),
    hostMemberId: hostMemberId == null ? null : String(hostMemberId),
    sourceType,
    sourceRuleId,
    sourceIdentityKeys: [...new Set((sourceIdentityKeys || []).map(String))],
    reason: deficiency.reason,
    mode,
    face,
    rawRequiredMm,
    constructionMarginMm,
    proposedThicknessMm,
    stationStartMm: normalizedStart,
    stationEndMm: normalizedEnd,
    status: 'CANDIDATE',
    automatic: true,
    requireApproval: rule.requireApproval !== false,
  };
  return {
    resolved: true,
    automaticCandidate: true,
    reason: deficiency.reason,
    candidate,
  };
}

export function applyFukashiCandidateToBounds(existingBounds, candidate) {
  const next = cloneBounds(existingBounds);
  const amount = Number(candidate?.proposedThicknessMm);
  if (!(amount > 0)) return null;
  if (candidate.face === 'LEFT') next.min.x -= amount;
  else if (candidate.face === 'RIGHT') next.max.x += amount;
  else if (candidate.face === 'BOTTOM') next.min.y -= amount;
  else if (candidate.face === 'TOP') next.max.y += amount;
  else return null;
  return next;
}

export function recheckFukashiCandidate({
  candidate,
  requiredBounds,
  existingBounds,
  openingConflict = false,
  rebarCollision = false,
  supportTopologyResolved = true,
} = {}) {
  const temporaryBounds = applyFukashiCandidateToBounds(existingBounds, candidate);
  if (!temporaryBounds) {
    return { status: 'ROLLBACK', acceptable: false, reason: 'SPECIAL_DETAIL_REQUIRED' };
  }
  const deficiency = evaluateConcreteDeficiency({
    requiredBounds,
    existingBounds: temporaryBounds,
    sourceType: candidate?.sourceType,
    openingConflict,
    rebarCollision,
    supportTopologyResolved,
  });
  if (!deficiency.resolved || !deficiency.satisfied) {
    return {
      status: 'ROLLBACK',
      acceptable: false,
      reason: deficiency.reason || 'SPECIAL_DETAIL_REQUIRED',
      temporaryBounds,
      deficiency,
    };
  }
  return {
    status: 'PASS',
    acceptable: true,
    reason: null,
    temporaryBounds,
    deficiency,
  };
}
