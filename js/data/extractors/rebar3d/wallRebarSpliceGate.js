/**
 * @fileoverview Issue #310 Phase 6a-C: RC壁筋 splice region のpure hard gate。
 *
 * 壁筋の継手位置自体は生成しない。上流が wall bar 軸上へ射影した splice interval と
 * 柱・梁領域 interval を受け取り、W-001「壁筋の継手を柱・梁内に設けない」を判定する。
 */

const DEFAULT_TOLERANCE_MM = 1e-6;
const FORBIDDEN_MEMBER_TYPES = new Set(['COLUMN', 'GIRDER', 'BEAM']);

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

function intervalFrom(value, { allowPoint = false } = {}) {
  const stationMm = finite(value?.stationMm);
  if (allowPoint && stationMm !== null) {
    return Object.freeze({ startMm: stationMm, endMm: stationMm, isPoint: true });
  }
  const rawStart = finite(value?.startStationMm);
  const rawEnd = finite(value?.endStationMm);
  if (rawStart === null || rawEnd === null) return null;
  return Object.freeze({
    startMm: Math.min(rawStart, rawEnd),
    endMm: Math.max(rawStart, rawEnd),
    isPoint: Math.abs(rawStart - rawEnd) <= Number.EPSILON,
  });
}

function intervalRelation(candidate, forbidden, toleranceMm) {
  if (candidate.isPoint) {
    const station = candidate.startMm;
    if (station > forbidden.startMm + toleranceMm && station < forbidden.endMm - toleranceMm) {
      return 'INTERIOR_OVERLAP';
    }
    if (
      Math.abs(station - forbidden.startMm) <= toleranceMm ||
      Math.abs(station - forbidden.endMm) <= toleranceMm
    ) {
      return 'BOUNDARY_TOUCH';
    }
    return 'DISJOINT';
  }

  const overlapStart = Math.max(candidate.startMm, forbidden.startMm);
  const overlapEnd = Math.min(candidate.endMm, forbidden.endMm);
  if (overlapEnd - overlapStart > toleranceMm) return 'INTERIOR_OVERLAP';
  if (overlapEnd >= overlapStart - toleranceMm) return 'BOUNDARY_TOUCH';
  return 'DISJOINT';
}

function normalizeForbiddenRegion(region, index) {
  const memberType = text(region?.memberType)?.toUpperCase() || null;
  const interval = intervalFrom(region, { allowPoint: false });
  if (!FORBIDDEN_MEMBER_TYPES.has(memberType) || !interval) return null;
  return Object.freeze({
    regionKey: text(region?.regionKey) || `${memberType}:${text(region?.memberId) || '-'}:${index}`,
    memberType,
    memberId: text(region?.memberId),
    barIdentity: text(region?.barIdentity),
    startStationMm: interval.startMm,
    endStationMm: interval.endMm,
  });
}

function appliesToCandidate(region, candidate) {
  if (!region.barIdentity) return true;
  const barIdentity = text(candidate?.barIdentity) || text(candidate?.semanticIdentity);
  return Boolean(barIdentity) && region.barIdentity === barIdentity;
}

function freezeResult(values) {
  return Object.freeze({
    ruleId: 'WALL-SPLICE-IN-WALL',
    ...values,
    blockingRegions: Object.freeze((values.blockingRegions || []).slice()),
  });
}

/**
 * 1つの wall splice candidate を評価するpure gate。
 *
 * candidate:
 *   candidateKey, wallMemberId, barIdentity/semanticIdentity,
 *   stationMm または startStationMm/endStationMm
 *
 * forbiddenRegions:
 *   memberType=COLUMN|GIRDER|BEAM, memberId,
 *   startStationMm/endStationMm, optional barIdentity
 */
export function evaluateWallSpliceRegionGate(
  candidate,
  forbiddenRegions,
  { toleranceMm = DEFAULT_TOLERANCE_MM } = {},
) {
  const tolerance = finite(toleranceMm);
  if (tolerance === null || tolerance < 0) {
    throw new RangeError('wall splice toleranceMm must be a finite non-negative number');
  }

  const candidateInterval = intervalFrom(candidate, { allowPoint: true });
  const candidateKey = text(candidate?.candidateKey) || null;
  const wallMemberId = text(candidate?.wallMemberId) || text(candidate?.memberId);
  const barIdentity = text(candidate?.barIdentity) || text(candidate?.semanticIdentity);
  if (!candidateInterval) {
    return freezeResult({
      status: 'UNRESOLVED',
      allowed: null,
      reason: 'wall-splice-candidate-interval-unresolved',
      candidateKey,
      wallMemberId,
      barIdentity,
      candidateInterval: null,
      blockingRegions: [],
    });
  }

  const rawRegions = Array.isArray(forbiddenRegions) ? forbiddenRegions : [];
  const normalized = [];
  for (const [index, region] of rawRegions.entries()) {
    const normalizedRegion = normalizeForbiddenRegion(region, index);
    if (!normalizedRegion) {
      return freezeResult({
        status: 'UNRESOLVED',
        allowed: null,
        reason: 'wall-splice-forbidden-region-unresolved',
        candidateKey,
        wallMemberId,
        barIdentity,
        candidateInterval,
        invalidRegionIndex: index,
        blockingRegions: [],
      });
    }
    if (appliesToCandidate(normalizedRegion, candidate)) normalized.push(normalizedRegion);
  }
  normalized.sort((a, b) => a.regionKey.localeCompare(b.regionKey));

  const interior = [];
  const boundary = [];
  for (const region of normalized) {
    const relation = intervalRelation(
      candidateInterval,
      {
        startMm: region.startStationMm,
        endMm: region.endStationMm,
        isPoint: false,
      },
      tolerance,
    );
    if (relation === 'INTERIOR_OVERLAP') interior.push(region);
    else if (relation === 'BOUNDARY_TOUCH') boundary.push(region);
  }

  const publicInterval = Object.freeze({
    startStationMm: candidateInterval.startMm,
    endStationMm: candidateInterval.endMm,
  });
  if (interior.length) {
    return freezeResult({
      status: 'REJECTED',
      allowed: false,
      reason: 'wall-splice-overlaps-column-or-beam-region',
      candidateKey,
      wallMemberId,
      barIdentity,
      candidateInterval: publicInterval,
      blockingRegions: interior,
    });
  }
  if (boundary.length) {
    return freezeResult({
      status: 'UNRESOLVED',
      allowed: null,
      reason: 'wall-splice-region-boundary-ambiguous',
      candidateKey,
      wallMemberId,
      barIdentity,
      candidateInterval: publicInterval,
      blockingRegions: boundary,
    });
  }
  return freezeResult({
    status: 'PASS',
    allowed: true,
    reason: null,
    candidateKey,
    wallMemberId,
    barIdentity,
    candidateInterval: publicInterval,
    blockingRegions: [],
  });
}

/** 同一region contractで複数candidateをdeterministicに評価する。 */
export function evaluateWallSpliceRegionCandidates(candidates, forbiddenRegions, options = {}) {
  const results = (Array.isArray(candidates) ? candidates : []).map((candidate) =>
    evaluateWallSpliceRegionGate(candidate, forbiddenRegions, options),
  );
  results.sort((a, b) =>
    `${a.candidateKey || ''}:${a.barIdentity || ''}:${a.candidateInterval?.startStationMm ?? ''}`.localeCompare(
      `${b.candidateKey || ''}:${b.barIdentity || ''}:${b.candidateInterval?.startStationMm ?? ''}`,
    ),
  );
  return Object.freeze(results);
}

export const __testOnly = Object.freeze({ intervalFrom, intervalRelation });
