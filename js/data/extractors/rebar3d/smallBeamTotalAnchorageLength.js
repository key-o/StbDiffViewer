/**
 * @fileoverview R12-P 一般小梁上端筋のL2全長を実中心線長で評価する。
 *
 * R12-Nの同一bar水平投影factとR12-Oの同一bar鉛直余長factを組み合わせ、
 * 仕口面から90°曲げ始点までのLine + 90°Arc + 利用可能tail直線の中心線長を求める。
 *
 * このresolverはL2全長だけを評価し、Lb/B/2投影・8d余長の独立条件、
 * 折曲げ方向strategy、RebarPath生成、production接続は行わない。
 */

const TOLERANCE_MM = 1e-6;

function unresolved(reason, extra = {}) {
  return {
    ...extra,
    resolved: false,
    reason,
    availableTotalMm: null,
    requiredMm: null,
    ok: null,
    source: 'R12-small-beam-total-anchorage-length',
  };
}

function closeEnough(left, right) {
  return (
    Number.isFinite(Number(left)) &&
    Number.isFinite(Number(right)) &&
    Math.abs(Number(left) - Number(right)) <= TOLERANCE_MM
  );
}

/**
 * 同一小梁上端主筋1本について、仕口面から鉄筋端までの最大中心線長を解く。
 *
 * @param {Object} params
 * @param {Object} params.projectionFact R12-N bar-level projection fact
 * @param {Object} params.tailFact R12-O bar-level tail fact
 * @param {Object} params.requirement 小梁上端筋requirement
 * @returns {Object}
 */
export function resolveSmallBeamTopTotalAnchorageLength({
  projectionFact,
  tailFact,
  requirement,
} = {}) {
  if (!projectionFact?.resolved) {
    return unresolved(projectionFact?.reason || 'small-beam-projection-unresolved');
  }
  if (!tailFact?.resolved) {
    return unresolved(tailFact?.reason || 'small-beam-tail-unresolved');
  }
  if (!requirement?.ok) {
    return unresolved(requirement?.reason || 'small-beam-top-requirement-unresolved');
  }

  const projectionDiaMm = Number(projectionFact.barDiaMm);
  const tailDiaMm = Number(tailFact.barDiaMm);
  if (!(projectionDiaMm > 0) || !(tailDiaMm > 0) || !closeEnough(projectionDiaMm, tailDiaMm)) {
    return unresolved('small-beam-total-length-bar-diameter-mismatch', {
      projectionDiaMm: Number.isFinite(projectionDiaMm) ? projectionDiaMm : null,
      tailDiaMm: Number.isFinite(tailDiaMm) ? tailDiaMm : null,
    });
  }

  const projectionGrade = String(projectionFact.grade || '').toUpperCase();
  const tailGrade = String(tailFact.grade || '').toUpperCase();
  if (!projectionGrade || !tailGrade || projectionGrade !== tailGrade) {
    return unresolved('small-beam-total-length-bar-grade-mismatch', {
      projectionGrade: projectionGrade || null,
      tailGrade: tailGrade || null,
    });
  }

  const projectionRadiusMm = Number(projectionFact.centerlineRadiusMm);
  const tailRadiusMm = Number(tailFact.centerlineRadiusMm);
  if (
    !(projectionRadiusMm > 0) ||
    !(tailRadiusMm > 0) ||
    !closeEnough(projectionRadiusMm, tailRadiusMm)
  ) {
    return unresolved('small-beam-total-length-bend-radius-mismatch', {
      projectionRadiusMm: Number.isFinite(projectionRadiusMm) ? projectionRadiusMm : null,
      tailRadiusMm: Number.isFinite(tailRadiusMm) ? tailRadiusMm : null,
    });
  }

  const horizontalLineMm = Number(projectionFact.bendStartFromNearMm);
  const availableTailMm = Number(tailFact.availableTailMm);
  const requiredMm = Number(requirement.l2RequiredMm);
  const minimumTailMm = Number(requirement.tailRequiredMm);
  if (!(horizontalLineMm >= 0)) {
    return unresolved('small-beam-total-length-horizontal-line-unresolved');
  }
  if (!(availableTailMm >= 0)) {
    return unresolved('small-beam-total-length-tail-unresolved');
  }
  if (!(requiredMm > 0)) {
    return unresolved('small-beam-total-length-l2-required-unresolved');
  }

  const arcLengthMm = (Math.PI * projectionRadiusMm) / 2;
  const availableTotalMm = horizontalLineMm + arcLengthMm + availableTailMm;
  const tailNeededForL2Mm = Math.max(0, requiredMm - horizontalLineMm - arcLengthMm);
  const requiredTailForCombinedMm = Number.isFinite(minimumTailMm)
    ? Math.max(minimumTailMm, tailNeededForL2Mm)
    : tailNeededForL2Mm;
  const ok = availableTotalMm + TOLERANCE_MM >= requiredMm;

  return {
    resolved: true,
    reason: null,
    source: 'R12-small-beam-total-anchorage-length',
    standardId: projectionFact.standardId || tailFact.standardId || null,
    side: projectionFact.side || tailFact.side || null,
    supportId: projectionFact.supportId || tailFact.supportId || null,
    barDiaMm: projectionDiaMm,
    grade: projectionGrade,
    barOffsetMm: Number.isFinite(Number(projectionFact.barOffsetMm))
      ? Number(projectionFact.barOffsetMm)
      : null,
    centerFromTopMm: Number.isFinite(Number(tailFact.centerFromTopMm))
      ? Number(tailFact.centerFromTopMm)
      : null,
    centerlineRadiusMm: projectionRadiusMm,
    horizontalLineMm,
    arcLengthMm,
    availableTailMm,
    availableTotalMm,
    requiredMm,
    minimumTailMm: Number.isFinite(minimumTailMm) ? minimumTailMm : null,
    tailNeededForL2Mm,
    requiredTailForCombinedMm,
    ok,
  };
}
