/**
 * @fileoverview Issue #320 / #273 Phase 6b-O:
 * 日建連・JSCA 2023 §12-1 の小開口まわり主筋の
 * 1/6以下曲げ / 50mm以下ずらしを、production mutationなしで候補分類する。
 */

const SOURCE = 'NIKKENREN-JSCA-RC-REBAR-STANDARD-2023-SECTION-12-1';
const ONE_SIXTH = 1 / 6;
const MAX_SHIFT_MM = 50;
const EPS = 1e-12;

function finite(value) {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    (typeof value === 'string' && value.trim() === '')
  ) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeSmallOpeningSizeGate(input) {
  if (input.openingWithinBothSpacings === true) return 'PASS';
  if (input.openingWithinBothSpacings === false) return 'FAIL';
  return 'UNRESOLVED';
}

function normalizeCoverStatus(input) {
  if (input.coverStatus) return String(input.coverStatus).trim().toUpperCase();
  if (input.coverSatisfied === true) return 'PASS';
  if (input.coverSatisfied === false) return 'FAIL';
  return 'UNRESOLVED';
}

function candidate(ruleId, disposition, eligible, metrics, reason = null) {
  return Object.freeze({
    ruleId,
    disposition,
    eligible,
    metrics: Object.freeze(metrics),
    reason,
    source: SOURCE,
  });
}

export function classifySmallOpeningRebarDeflectionCandidate(input = {}) {
  const sizeGateStatus = normalizeSmallOpeningSizeGate(input);
  const coverStatus = normalizeCoverStatus(input);
  const bendOffsetMm = finite(input.bendOffsetMm);
  const bendRunMm = finite(input.bendRunMm);
  const shiftMm = finite(input.shiftMm);
  const bendSpecified = bendOffsetMm !== null || bendRunMm !== null;
  const shiftSpecified = shiftMm !== null;
  const candidates = [];

  if (sizeGateStatus !== 'PASS') {
    return Object.freeze({
      status: sizeGateStatus === 'FAIL' ? 'REJECTED' : 'UNRESOLVED',
      resolved: sizeGateStatus === 'FAIL',
      reason:
        sizeGateStatus === 'FAIL'
          ? 'small-opening-size-exceeds-rebar-spacing'
          : 'small-opening-size-gate-unresolved',
      source: SOURCE,
      openingId: input.openingId === undefined ? null : String(input.openingId),
      memberType: input.memberType || null,
      memberId: input.memberId === undefined ? null : String(input.memberId),
      barIdentity: input.barIdentity || null,
      sizeGateStatus,
      coverStatus,
      candidates: Object.freeze(candidates),
      geometryMutation: false,
    });
  }

  if (coverStatus !== 'PASS') {
    return Object.freeze({
      status: coverStatus === 'FAIL' ? 'REJECTED' : 'UNRESOLVED',
      resolved: coverStatus === 'FAIL',
      reason:
        coverStatus === 'FAIL'
          ? 'small-opening-cover-constraint-failed'
          : 'small-opening-cover-constraint-unresolved',
      source: SOURCE,
      openingId: input.openingId === undefined ? null : String(input.openingId),
      memberType: input.memberType || null,
      memberId: input.memberId === undefined ? null : String(input.memberId),
      barIdentity: input.barIdentity || null,
      sizeGateStatus,
      coverStatus,
      candidates: Object.freeze(candidates),
      geometryMutation: false,
    });
  }

  if (bendSpecified) {
    if (bendOffsetMm === null || bendRunMm === null || !(bendRunMm > 0)) {
      candidates.push(
        candidate(
          'SMALL-OPENING-BEND-ONE-SIXTH-CANDIDATE',
          'BEND_CANDIDATE',
          false,
          {},
          'small-opening-bend-geometry-incomplete',
        ),
      );
    } else {
      const ratio = Math.abs(bendOffsetMm) / bendRunMm;
      const eligible = ratio <= ONE_SIXTH + EPS;
      candidates.push(
        candidate(
          'SMALL-OPENING-BEND-ONE-SIXTH-CANDIDATE',
          'BEND_CANDIDATE',
          eligible,
          { bendOffsetMm: Math.abs(bendOffsetMm), bendRunMm, ratio },
          eligible ? null : 'small-opening-bend-ratio-over-one-sixth',
        ),
      );
    }
  }

  if (shiftSpecified) {
    const absoluteShiftMm = Math.abs(shiftMm);
    const eligible = absoluteShiftMm <= MAX_SHIFT_MM + EPS;
    candidates.push(
      candidate(
        'SMALL-OPENING-SHIFT-50MM-CANDIDATE',
        'SHIFT_CANDIDATE',
        eligible,
        { shiftMm: absoluteShiftMm },
        eligible ? null : 'small-opening-shift-over-50mm',
      ),
    );
  }

  const eligible = candidates.filter((item) => item.eligible);
  const incomplete = candidates.find(
    (item) => item.reason === 'small-opening-bend-geometry-incomplete',
  );
  let status = 'SPECIAL_REQUIRED';
  let reason = 'small-opening-standard-deflection-not-satisfied';
  if (eligible.length > 0) {
    status = 'CANDIDATE';
    reason = null;
  } else if (!bendSpecified && !shiftSpecified) {
    status = 'UNRESOLVED';
    reason = 'small-opening-deflection-geometry-missing';
  } else if (incomplete) {
    status = 'UNRESOLVED';
    reason = incomplete.reason;
  }

  return Object.freeze({
    status,
    resolved: status !== 'UNRESOLVED',
    reason,
    source: SOURCE,
    openingId: input.openingId === undefined ? null : String(input.openingId),
    memberType: input.memberType || null,
    memberId: input.memberId === undefined ? null : String(input.memberId),
    barIdentity: input.barIdentity || null,
    sizeGateStatus,
    coverStatus,
    candidates: Object.freeze(candidates),
    eligibleCandidates: Object.freeze(eligible),
    geometryMutation: false,
  });
}

export const SMALL_OPENING_DEFLECTION_LIMITS = Object.freeze({
  bendRatioMax: ONE_SIXTH,
  shiftMmMax: MAX_SHIFT_MM,
});
