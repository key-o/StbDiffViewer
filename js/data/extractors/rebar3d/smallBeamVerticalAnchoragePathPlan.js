/**
 * @fileoverview R12-R 一般小梁上端 VERTICAL_90 のRebarPath生成前bar-level planを解決する。
 *
 * R12-N/O/P/Qで同一barに固定した支持面・鉛直余長・L2・candidate factsを、
 * R10 buildAnchoredHookPath() が受け取れる anchor-local inputへ正規化する。
 * この段階ではRebarPathそのもの、production gate、3D geometryは生成しない。
 */

const TOLERANCE_MM = 1e-6;
const SOURCE = 'R12-small-beam-vertical-90-path-plan';

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    pathPlanReady: false,
    reason,
    source: SOURCE,
    r10Input: null,
    ...extra,
  };
}

function closeEnough(left, right) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= TOLERANCE_MM;
}

function gradeKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function sameOptionalString(left, right) {
  const a = left === null || left === undefined || left === '' ? null : String(left);
  const b = right === null || right === undefined || right === '' ? null : String(right);
  return a === b;
}

function validateSourceIdentity({ bar, projectionFact, tailFact, totalLengthFact, candidateFact }) {
  const barDiaMm = Number(bar?.dia);
  const projectionDiaMm = Number(projectionFact?.barDiaMm);
  const tailDiaMm = Number(tailFact?.barDiaMm);
  const totalDiaMm = Number(totalLengthFact?.barDiaMm);
  const candidateDiaMm = Number(candidateFact?.barDiaMm);
  if (
    !(barDiaMm > 0) ||
    ![projectionDiaMm, tailDiaMm, totalDiaMm, candidateDiaMm].every((value) =>
      closeEnough(value, barDiaMm),
    )
  ) {
    return { ok: false, reason: 'small-beam-vertical-90-path-bar-diameter-mismatch' };
  }

  const grade = gradeKey(bar?.grade);
  if (!grade) return { ok: false, reason: 'small-beam-vertical-90-path-bar-grade-unresolved' };
  const grades = [
    projectionFact?.grade,
    tailFact?.grade,
    totalLengthFact?.grade,
    candidateFact?.grade,
  ]
    .map(gradeKey)
    .filter(Boolean);
  if (grades.length !== 4 || grades.some((value) => value !== grade)) {
    return { ok: false, reason: 'small-beam-vertical-90-path-bar-grade-mismatch' };
  }

  const side =
    projectionFact?.side || tailFact?.side || totalLengthFact?.side || candidateFact?.side;
  if (!['start', 'end'].includes(side)) {
    return { ok: false, reason: 'small-beam-vertical-90-path-anchor-unresolved' };
  }
  if (
    [tailFact?.side, totalLengthFact?.side, candidateFact?.side]
      .filter(Boolean)
      .some((value) => value !== side)
  ) {
    return { ok: false, reason: 'small-beam-vertical-90-path-anchor-mismatch' };
  }

  const supportId = projectionFact?.supportId || tailFact?.supportId || totalLengthFact?.supportId;
  if (!supportId) return { ok: false, reason: 'small-beam-vertical-90-path-support-unresolved' };
  if (
    [tailFact?.supportId, totalLengthFact?.supportId, candidateFact?.supportId]
      .filter(Boolean)
      .some((value) => !sameOptionalString(value, supportId))
  ) {
    return { ok: false, reason: 'small-beam-vertical-90-path-support-mismatch' };
  }

  const radius = Number(projectionFact?.centerlineRadiusMm);
  if (!(radius > 0)) {
    return { ok: false, reason: 'small-beam-vertical-90-path-radius-unresolved' };
  }
  if (
    !closeEnough(tailFact?.centerlineRadiusMm, radius) ||
    !closeEnough(totalLengthFact?.centerlineRadiusMm, radius)
  ) {
    return { ok: false, reason: 'small-beam-vertical-90-path-radius-mismatch' };
  }

  return { ok: true, barDiaMm, grade, side, supportId: String(supportId), radius };
}

/**
 * VERTICAL_90を採用済みの上端主筋1本について、R10 hook inputまでを正規化する。
 */
export function resolveSmallBeamVertical90BarPathPlan({
  bar,
  projectionFact,
  tailFact,
  totalLengthFact,
  candidateFact,
  requirement,
  anchorageMode,
  barIndex = null,
} = {}) {
  if (!anchorageMode?.resolved) {
    return unresolved(anchorageMode?.reason || 'small-beam-vertical-90-mode-unresolved');
  }
  if (anchorageMode.mode !== 'VERTICAL_90') {
    return unresolved('small-beam-vertical-90-mode-not-selected', {
      selectedMode: anchorageMode.mode || null,
      alternativeRequired: anchorageMode.alternativeRequired === true,
    });
  }
  if (!candidateFact?.resolved || candidateFact.candidateReady !== true) {
    return unresolved(candidateFact?.reason || 'small-beam-vertical-90-candidate-not-ready');
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
  if (!requirement?.ok) {
    return unresolved(requirement?.reason || 'small-beam-top-requirement-unresolved');
  }

  const identity = validateSourceIdentity({
    bar,
    projectionFact,
    tailFact,
    totalLengthFact,
    candidateFact,
  });
  if (!identity.ok) return unresolved(identity.reason);

  const u = Number(bar?.u);
  const v = Number(bar?.v);
  if (!Number.isFinite(u) || !Number.isFinite(v)) {
    return unresolved('small-beam-vertical-90-path-local-position-unresolved', {
      u: Number.isFinite(u) ? u : null,
      v: Number.isFinite(v) ? v : null,
    });
  }
  if (!closeEnough(projectionFact.barOffsetMm, u)) {
    return unresolved('small-beam-vertical-90-path-lateral-position-mismatch', {
      barU: u,
      projectionBarOffsetMm: projectionFact.barOffsetMm,
    });
  }

  const supportGeometry = projectionFact.supportGeometry;
  const nearFaceT = Number(supportGeometry?.nearFaceT);
  const beamEndT = Number(supportGeometry?.beamEndT);
  if (!supportGeometry?.resolved || !Number.isFinite(nearFaceT) || !Number.isFinite(beamEndT)) {
    return unresolved('small-beam-vertical-90-path-support-face-unresolved');
  }

  const nearFaceFromMemberEndMm =
    identity.side === 'start' ? nearFaceT - beamEndT : beamEndT - nearFaceT;
  if (nearFaceFromMemberEndMm < -TOLERANCE_MM) {
    return unresolved('small-beam-vertical-90-near-face-outside-member-side', {
      nearFaceFromMemberEndMm,
      nearFaceT,
      beamEndT,
    });
  }

  const verticalLegCenterFromNearMm = Number(projectionFact.verticalLegCenterFromNearMm);
  const bendStartFromNearMm = Number(projectionFact.bendStartFromNearMm);
  if (!(verticalLegCenterFromNearMm > 0) || !(bendStartFromNearMm >= 0)) {
    return unresolved('small-beam-vertical-90-path-bend-position-unresolved');
  }

  const radius = identity.radius;
  const sharpCornerAtMm = Math.max(0, nearFaceFromMemberEndMm) - verticalLegCenterFromNearMm;
  const incomingTangentAtMm = sharpCornerAtMm + radius;
  const incomingFromProjectionMm = Math.max(0, nearFaceFromMemberEndMm) - bendStartFromNearMm;
  if (!closeEnough(incomingTangentAtMm, incomingFromProjectionMm)) {
    return unresolved('small-beam-vertical-90-path-tangent-position-mismatch', {
      incomingTangentAtMm,
      incomingFromProjectionMm,
      sharpCornerAtMm,
      radius,
    });
  }

  // 現R10 buildAnchoredHookPathはmember端より内側に接点が入る場合、main bar trimを要求してfail-closed。
  if (incomingTangentAtMm > TOLERANCE_MM) {
    return unresolved('small-beam-vertical-90-member-trim-required', {
      trimRequiredMm: incomingTangentAtMm,
      sharpCornerAtMm,
      incomingTangentAtMm,
      nearFaceFromMemberEndMm: Math.max(0, nearFaceFromMemberEndMm),
    });
  }

  const availableTailMm = Number(tailFact.availableTailMm);
  const requiredTailForCombinedMm = Number(totalLengthFact.requiredTailForCombinedMm);
  const minimumTailMm = Number(requirement.tailRequiredMm);
  if (!(availableTailMm >= 0) || !(requiredTailForCombinedMm > 0) || !(minimumTailMm > 0)) {
    return unresolved('small-beam-vertical-90-path-tail-length-unresolved');
  }
  const tailLengthMm = Math.max(requiredTailForCombinedMm, minimumTailMm);
  if (tailLengthMm > availableTailMm + TOLERANCE_MM) {
    return unresolved('small-beam-vertical-90-path-tail-exceeds-available', {
      tailLengthMm,
      availableTailMm,
    });
  }

  const arcLengthMm = (Math.PI * radius) / 2;
  const horizontalLineFromNearMm = bendStartFromNearMm;
  const selectedTotalFromNearMm = horizontalLineFromNearMm + arcLengthMm + tailLengthMm;
  const l2RequiredMm = Number(requirement.l2RequiredMm);
  if (!(l2RequiredMm > 0) || selectedTotalFromNearMm + TOLERANCE_MM < l2RequiredMm) {
    return unresolved('small-beam-vertical-90-path-selected-length-insufficient', {
      selectedTotalFromNearMm,
      l2RequiredMm: Number.isFinite(l2RequiredMm) ? l2RequiredMm : null,
    });
  }

  const outgoingDirection = { x: 0, y: -1, z: 0 };
  const r10Input = {
    anchor: identity.side,
    at: sharpCornerAtMm,
    u,
    v,
    barDiaMm: identity.barDiaMm,
    grade: identity.grade,
    bendAngleDeg: 90,
    outgoingDirection,
    tailLengthMm,
  };

  return {
    resolved: true,
    pathPlanReady: true,
    reason: null,
    source: SOURCE,
    mode: 'VERTICAL_90',
    productionReady: false,
    anchor: identity.side,
    supportId: identity.supportId,
    barIndex: Number.isInteger(barIndex) ? barIndex : null,
    layer: bar?.layer ?? null,
    identityKey: bar?.identityKey || null,
    u,
    v,
    barDiaMm: identity.barDiaMm,
    grade: identity.grade,
    coordinateSpace: 'anchor-local',
    bendDirection: 'DOWN',
    nearFaceFromMemberEndMm: Math.max(0, nearFaceFromMemberEndMm),
    verticalLegCenterFromNearMm,
    bendStartFromNearMm,
    sharpCornerAtMm,
    incomingTangentAtMm: Math.min(0, incomingTangentAtMm),
    centerlineRadiusMm: radius,
    insideDiameterMm: projectionFact.insideDiameterMm ?? tailFact.insideDiameterMm ?? null,
    availableTailMm,
    minimumTailMm,
    requiredTailForCombinedMm,
    tailLengthMm,
    arcLengthMm,
    selectedTotalFromNearMm,
    l2RequiredMm,
    outgoingDirection,
    r10Input,
  };
}
