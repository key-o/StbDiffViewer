/**
 * @fileoverview R12-Q 一般小梁上端筋の90°鉛直定着candidateをbar-levelで判定する。
 *
 * R12-N/P/Oで独立に解いた Lb/B/2投影・L2全長・90°余長について、
 * 同一barが3条件をすべて満たす場合だけ vertical-90 candidate-ready とする。
 *
 * candidate-readyは定着modeの採用決定やproduction OKを意味しない。
 * 90°鉛直candidateが成立しない場合も、日建連§9-2の斜め定着等があり得るため、
 * 一般的な「定着NG」には昇格させない。
 */

const TOLERANCE_MM = 1e-6;

function unresolved(reason, extra = {}) {
  return {
    ...extra,
    resolved: false,
    reason,
    candidateReady: null,
    checks: null,
    source: 'R12-small-beam-vertical-90-candidate',
  };
}

function check(availableMm, requiredMm) {
  const available = Number(availableMm);
  const required = Number(requiredMm);
  if (!(available >= 0) || !(required > 0)) return null;
  return {
    availableMm: available,
    requiredMm: required,
    ok: available + TOLERANCE_MM >= required,
  };
}

/**
 * 同一barの90°鉛直定着candidateを解く。
 *
 * @param {Object} params
 * @param {Object} params.projectionFact R12-N bar-level fact
 * @param {Object} params.tailFact R12-O bar-level fact
 * @param {Object} params.totalLengthFact R12-P bar-level fact
 * @param {Object} params.requirement 上端筋requirement
 * @returns {Object}
 */
export function resolveSmallBeamTopVertical90Candidate({
  projectionFact,
  tailFact,
  totalLengthFact,
  requirement,
} = {}) {
  if (!requirement?.ok) {
    return unresolved(requirement?.reason || 'small-beam-top-requirement-unresolved');
  }
  if (!projectionFact?.resolved) {
    return unresolved(projectionFact?.reason || 'small-beam-projection-unresolved');
  }
  if (!tailFact?.resolved) {
    return unresolved(tailFact?.reason || 'small-beam-tail-unresolved');
  }
  if (!totalLengthFact?.resolved) {
    return unresolved(totalLengthFact?.reason || 'small-beam-total-length-unresolved');
  }

  const projection = check(projectionFact.availableProjectionMm, requirement.projectionRequiredMm);
  const tail = check(tailFact.availableTailMm, requirement.tailRequiredMm);
  const l2 = check(totalLengthFact.availableTotalMm, requirement.l2RequiredMm);
  if (!projection || !tail || !l2) {
    return unresolved('small-beam-vertical-90-check-value-unresolved', {
      projection,
      tail,
      l2,
    });
  }

  const failedConditions = [];
  if (!projection.ok) failedConditions.push('LB_PROJECTION');
  if (!tail.ok) failedConditions.push('HOOK_TAIL_90');
  if (!l2.ok) failedConditions.push('L2');

  return {
    resolved: true,
    reason: null,
    source: 'R12-small-beam-vertical-90-candidate',
    candidateKind: 'TOP_VERTICAL_90',
    candidateReady: failedConditions.length === 0,
    failedConditions,
    checks: { l2, projection, tail },
    side: projectionFact.side || tailFact.side || totalLengthFact.side || null,
    supportId: projectionFact.supportId || tailFact.supportId || totalLengthFact.supportId || null,
    barDiaMm: Number(projectionFact.barDiaMm) || null,
    grade: projectionFact.grade || tailFact.grade || totalLengthFact.grade || null,
    barOffsetMm: Number.isFinite(Number(projectionFact.barOffsetMm))
      ? Number(projectionFact.barOffsetMm)
      : null,
    centerFromTopMm: Number.isFinite(Number(tailFact.centerFromTopMm))
      ? Number(tailFact.centerFromTopMm)
      : null,
  };
}
