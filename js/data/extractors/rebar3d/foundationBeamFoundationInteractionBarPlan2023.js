/**
 * @fileoverview 日建連・JSCA 2023標準図 図6-3 の追加D16筋を、
 * world placement前のsymbolic bar planへ束ねる。
 *
 * 図から一意に読める縦断寸法だけをbindingする:
 * - beam側 L2
 * - 取合い部 D
 * - foundation側 L2h
 * - 90° hook tail 20d
 *
 * D16-@200 は補強幅=基礎梁幅の範囲へ梁幅方向に配置するrequirementとして保持するが、
 * 図6-3単独では最初の1本の端部余白/配列originが一意でないためbar count/world位置は決めない。
 * hook tailも梁軸方向であることまでは読めるが、start/endに対する符号はworld geometry側で
 * footing境界と照合するまで決めない。
 */

const SOURCE = 'R13-foundation-beam-foundation-interaction-bar-plan-2023';
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
function invalid(reason, extra = {}) {
  return outcome('INVALID', reason, extra);
}
function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function resolveFoundationBeamFoundationInteractionBarPlan2023({
  stepGeometry,
  planInteraction,
  requirement,
  lengthPlan,
} = {}) {
  if (stepGeometry?.status !== 'READY') {
    return unresolved(stepGeometry?.reason || 'foundation-interaction-bar-plan-step-unresolved');
  }
  if (planInteraction?.status !== 'READY') {
    return unresolved(
      planInteraction?.reason || 'foundation-interaction-bar-plan-plan-interaction-unresolved',
    );
  }
  if (requirement?.status !== 'READY') {
    return unresolved(
      requirement?.reason || 'foundation-interaction-bar-plan-requirement-unresolved',
    );
  }
  if (lengthPlan?.status !== 'READY') {
    return unresolved(
      lengthPlan?.reason || 'foundation-interaction-bar-plan-length-plan-unresolved',
    );
  }

  const D = finitePositive(stepGeometry.stepHeightMm);
  const beamBottomZ = Number(stepGeometry.beamBottomZ);
  const footingTopZ = Number(stepGeometry.footingTopZ);
  const beamWidthMm = finitePositive(requirement.reinforcementWidthMm);
  const l2Mm = finitePositive(lengthPlan.beamLengths?.l2?.requiredMm);
  const l2hMm = finitePositive(lengthPlan.foundationLengths?.l2h?.requiredMm);
  const tail20dMm = finitePositive(lengthPlan.additionalTie?.tail20dMm);
  const pitchMm = finitePositive(lengthPlan.additionalTie?.pitchMm);
  if (
    D === null ||
    !Number.isFinite(beamBottomZ) ||
    !Number.isFinite(footingTopZ) ||
    beamWidthMm === null ||
    l2Mm === null ||
    l2hMm === null ||
    tail20dMm === null ||
    pitchMm === null
  ) {
    return invalid('foundation-interaction-bar-plan-dimension-invalid');
  }
  if (Math.abs(beamBottomZ - footingTopZ - D) > EPS) {
    return invalid('foundation-interaction-bar-plan-D-geometry-mismatch', {
      stepHeightMm: D,
      beamBottomZ,
      footingTopZ,
    });
  }

  const verticalTopZ = beamBottomZ + l2Mm;
  const hookBendZ = footingTopZ - l2hMm;
  const verticalLegMm = verticalTopZ - hookBendZ;
  const expectedVerticalLegMm = l2Mm + D + l2hMm;
  if (!(verticalLegMm > 0) || Math.abs(verticalLegMm - expectedVerticalLegMm) > EPS) {
    return invalid('foundation-interaction-bar-plan-vertical-leg-inconsistent', {
      verticalLegMm,
      expectedVerticalLegMm,
    });
  }

  const additionalTieFamily = {
    family: 'FIG_6_3_ADDITIONAL_D16',
    designation: lengthPlan.additionalTie.designation,
    diaMm: lengthPlan.additionalTie.diaMm,
    grade: lengthPlan.additionalTie.grade,
    nominalPitchMm: pitchMm,
    reinforcementWidthMm: beamWidthMm,
    reinforcementWidthBasis: 'MATCH_FOUNDATION_BEAM_WIDTH',
    longitudinalSectionShape: 'J_BAR_VERTICAL_PLUS_90_DEG_TAIL',
    sectionPlaneBasis: 'PARALLEL_TO_FOUNDATION_BEAM_AXIS',
    vertical: {
      topZ: verticalTopZ,
      beamEmbedMm: l2Mm,
      interactionGapMm: D,
      foundationEmbedToHookMm: l2hMm,
      hookBendZ,
      totalLegMm: verticalLegMm,
      dimensionBinding: ['BEAM_L2', 'D', 'FOUNDATION_L2H'],
    },
    hook: {
      tailMm: tail20dMm,
      factorD: 20,
      axisBasis: 'FOUNDATION_BEAM_AXIS',
      directionSignResolved: false,
    },
    distribution: {
      axisBasis: 'FOUNDATION_BEAM_TRANSVERSE',
      nominalPitchMm: pitchMm,
      widthMm: beamWidthMm,
      originResolved: false,
      barCountResolved: false,
      reason: 'foundation-interaction-D16-transverse-distribution-origin-unresolved',
    },
  };

  const companionFamily = requirement.companionBeamStirrup
    ? {
        family: 'FIG_6_3_COMPANION_BEAM_STIRRUP',
        designation: requirement.companionBeamStirrup.designation,
        diaMm: requirement.companionBeamStirrup.diaMm,
        grade: requirement.companionBeamStirrup.grade,
        pitchMm: requirement.companionBeamStirrup.pitchMm,
        rule: requirement.companionBeamStirrup.rule,
        sectionShapeResolved: false,
        placementResolved: false,
        reason: 'foundation-interaction-companion-stirrup-world-shape-unresolved',
      }
    : null;

  return ready({
    figureCase: requirement.figureCase,
    side: stepGeometry.side || planInteraction.side || null,
    nodeId: stepGeometry.nodeId || planInteraction.nodeId || null,
    additionalTieFamily,
    companionFamily,
    longitudinalSectionBindingResolved: true,
    transverseDistributionResolved: false,
    hookDirectionResolved: false,
    worldPlacementResolved: false,
    productionBlockers: [
      'foundation-interaction-D16-transverse-distribution-origin-unresolved',
      'foundation-interaction-D16-hook-direction-unresolved',
      ...(companionFamily
        ? ['foundation-interaction-companion-stirrup-world-shape-unresolved']
        : []),
    ],
  });
}

export const _foundationBeamFoundationInteractionBarPlan2023Internals = Object.freeze({
  finitePositive,
});
