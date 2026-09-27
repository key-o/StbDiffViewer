/**
 * @fileoverview 図6-4 case1「あばら筋を通す」の軸方向phaseを、
 * 既存の大梁あばら筋member-specific配置から連続させるpure resolver。
 *
 * 新しい配筋originを標準図から推定せず、既にproductionで確定している柱面外側の
 * 最寄りあばら筋位置をanchorとして、同じ端部pitchで最下階柱外周区間へ連続配置する。
 * cross-section loopのworld geometryはこのmoduleでは生成しない。
 */

const SOURCE = 'R13-foundation-beam-lowest-column-pass-through-placement-2023';
const EPS = 1e-6;

function outcome(status, reason, extra = {}) {
  return {
    status,
    resolved: status === 'READY',
    reason: reason || null,
    blockers: reason ? [reason] : [],
    source: SOURCE,
    productionReady: false,
    ...extra,
  };
}
function ready(extra = {}) {
  return outcome('READY', null, extra);
}
function unresolved(reason, extra = {}) {
  return outcome('UNRESOLVED', reason, extra);
}
function notRequired(reason, extra = {}) {
  return outcome('NOT_REQUIRED', reason, extra);
}
function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
function uniqueSorted(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const result = [];
  for (const value of sorted) {
    if (!result.length || Math.abs(value - result[result.length - 1]) > EPS) result.push(value);
  }
  return result;
}
function explicitMemberPositions(layout, memberLengthMm) {
  return uniqueSorted(
    (layout?.segments || [])
      .filter(
        (segment) =>
          segment?.exactAxialPosition === true && Number.isFinite(Number(segment.positionRatio)),
      )
      .map((segment) => Number(segment.positionRatio) * memberLengthMm),
  );
}
function continuationPositions({ side, anchorMm, pitchMm, entryT, exitT }) {
  const values = [];
  if (side === 'start') {
    for (let value = anchorMm - pitchMm; value >= entryT - EPS; value -= pitchMm) {
      if (value <= exitT + EPS) values.push(value);
    }
  } else {
    for (let value = anchorMm + pitchMm; value <= exitT + EPS; value += pitchMm) {
      if (value >= entryT - EPS) values.push(value);
    }
  }
  return uniqueSorted(values);
}

export function resolveFoundationBeamLowestColumnPassThroughPlacement2023({
  interactionFact,
  memberStirrupLayout,
} = {}) {
  if (interactionFact?.status !== 'READY' || interactionFact?.resolved !== true) {
    return unresolved(
      interactionFact?.reason || 'foundation-lowest-column-pass-through-interaction-unresolved',
    );
  }
  if (interactionFact.passThroughRequired !== true) {
    return notRequired('foundation-lowest-column-pass-through-not-required-for-case', {
      figureCase: interactionFact.figureCase || null,
    });
  }
  const side = interactionFact.side;
  if (!['start', 'end'].includes(side)) {
    return unresolved('foundation-lowest-column-pass-through-side-unresolved');
  }
  const pitchMm = finitePositive(interactionFact.beamStirrup?.pitchMm);
  if (pitchMm === null || interactionFact.stirrupScheduleResolved !== true) {
    return unresolved('foundation-lowest-column-pass-through-stirrup-schedule-unresolved');
  }

  const interval = interactionFact.passThroughAxisInterval;
  const memberLengthMm = finitePositive(interval?.memberLengthMm);
  const entryT = Number(interval?.entryT);
  const exitT = Number(interval?.exitT);
  const faceT = Number(interactionFact.geometry?.faceT);
  if (
    memberLengthMm === null ||
    !Number.isFinite(entryT) ||
    !Number.isFinite(exitT) ||
    !(exitT > entryT) ||
    !Number.isFinite(faceT)
  ) {
    return unresolved('foundation-lowest-column-pass-through-axis-interval-unresolved');
  }
  const layoutLengthMm = finitePositive(memberStirrupLayout?.memberPlanLengthMm);
  if (
    memberStirrupLayout?.memberSpecific !== true ||
    layoutLengthMm === null ||
    Math.abs(layoutLengthMm - memberLengthMm) > EPS
  ) {
    return unresolved('foundation-lowest-column-pass-through-member-layout-inconsistent');
  }

  const existingPositionsMm = explicitMemberPositions(memberStirrupLayout, memberLengthMm);
  const spanSidePositions =
    side === 'start'
      ? existingPositionsMm.filter((value) => value > faceT + EPS)
      : existingPositionsMm.filter((value) => value < faceT - EPS);
  if (!spanSidePositions.length) {
    return unresolved('foundation-lowest-column-pass-through-adjacent-stirrup-unresolved');
  }
  const anchorMm = side === 'start' ? spanSidePositions[0] : spanSidePositions.at(-1);
  const positionsMm = continuationPositions({ side, anchorMm, pitchMm, entryT, exitT });
  if (!positionsMm.length) {
    return unresolved('foundation-lowest-column-pass-through-no-position-in-column');
  }

  return ready({
    side,
    nodeId: interactionFact.nodeId || null,
    figureCase: interactionFact.figureCase,
    pitchMm,
    phaseBasis: 'CONTINUATION_OF_EXISTING_MEMBER_STIRRUP_SEQUENCE',
    adjacentAnchorMm: anchorMm,
    lowestColumnFaceT: faceT,
    intervalEntryT: entryT,
    intervalExitT: exitT,
    memberLengthMm,
    positionsMm,
    positionRatios: positionsMm.map((value) => value / memberLengthMm),
    requiresMemberExtension: positionsMm.some(
      (value) => value < -EPS || value > memberLengthMm + EPS,
    ),
    passThroughPhaseResolved: true,
    worldLoopResolved: false,
    productionBlockers: ['foundation-lowest-column-pass-through-world-loop-unresolved'],
  });
}

export const _foundationBeamLowestColumnPassThroughPlacement2023Internals = Object.freeze({
  uniqueSorted,
  explicitMemberPositions,
  continuationPositions,
});
