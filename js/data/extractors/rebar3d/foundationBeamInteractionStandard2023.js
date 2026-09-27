/**
 * @fileoverview 日建連・JSCA 2023標準図 §6-3 / §6-4 の基礎梁取合いrequirement契約。
 *
 * 構造図が正本であり、標準図は構造図に記載がない場合の既定詳細である。
 * このmoduleは標準図を明示採用した場合だけpure requirementを返し、world geometryは生成しない。
 */

const SOURCE = 'NIKKENREN-JSCA-RC-REBAR-STANDARD-2023-SECTION-6-3-6-4';
const WIDTH_TOLERANCE_MM = 1e-6;

function result(status, reason, extra = {}) {
  return {
    status,
    resolved: status === 'READY',
    reason: reason || null,
    blockers: reason ? [reason] : [],
    source: SOURCE,
    geometryResolved: false,
    productionReady: false,
    ...extra,
  };
}

function unresolved(reason, extra = {}) {
  return result('UNRESOLVED', reason, extra);
}
function invalid(reason, extra = {}) {
  return result('INVALID', reason, extra);
}
function special(reason, extra = {}) {
  return result('SPECIAL_REQUIRED', reason, extra);
}
function ready(extra = {}) {
  return result('READY', null, extra);
}
function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
function standardSelected(detailSource) {
  return (
    String(detailSource || '')
      .trim()
      .toUpperCase() === 'STANDARD_2023'
  );
}

export function resolveFoundationBeamFoundationInteractionRequirement2023({
  detailSource,
  stepHeightMm,
  beamWidthMm,
  beamStirrup = null,
} = {}) {
  if (!standardSelected(detailSource)) {
    return unresolved('foundation-interaction-structural-drawing-detail-required');
  }
  const D = finitePositive(stepHeightMm);
  const beamWidth = finitePositive(beamWidthMm);
  if (D === null) return invalid('foundation-interaction-step-height-invalid');
  if (beamWidth === null) return invalid('foundation-interaction-beam-width-invalid');
  if (D > 1000) {
    return special('foundation-interaction-step-height-beyond-figure-6-3', {
      stepHeightMm: D,
      beamWidthMm: beamWidth,
    });
  }
  const common = {
    section: '6-3',
    figure: 'FIG_6_3',
    stepHeightMm: D,
    reinforcementWidthRule: 'MATCH_FOUNDATION_BEAM_WIDTH',
    reinforcementWidthMm: beamWidth,
    additionalTie: { designation: 'D16', pitchMm: 200 },
    geometryTokens: ['L2', 'L2H', '20D'],
    geometryReason: 'foundation-interaction-figure-6-3-path-not-encoded',
  };
  if (D <= 200) {
    return ready({ ...common, figureCase: '0_LT_D_LE_200', companionBeamStirrup: null });
  }
  const stirrupDia = finitePositive(beamStirrup?.diaMm);
  const stirrupPitch = finitePositive(beamStirrup?.pitchMm);
  if (stirrupDia === null || stirrupPitch === null) {
    return unresolved('foundation-interaction-beam-stirrup-schedule-unresolved', {
      ...common,
      figureCase: '200_LT_D_LE_1000',
    });
  }
  return ready({
    ...common,
    figureCase: '200_LT_D_LE_1000',
    companionBeamStirrup: {
      designation: beamStirrup?.designation || null,
      diaMm: stirrupDia,
      pitchMm: stirrupPitch,
      grade: beamStirrup?.grade || null,
      rule: 'SAME_DIAMETER_AND_SPACING_AS_FOUNDATION_BEAM_STIRRUP',
    },
  });
}

export function resolveFoundationBeamLowestColumnInteractionRequirement2023({
  detailSource,
  beamWidthMm,
  columnWidthMm,
} = {}) {
  if (!standardSelected(detailSource)) {
    return unresolved('foundation-lowest-column-structural-drawing-detail-required');
  }
  const beamWidth = finitePositive(beamWidthMm);
  const columnWidth = finitePositive(columnWidthMm);
  if (beamWidth === null) return invalid('foundation-lowest-column-beam-width-invalid');
  if (columnWidth === null) return invalid('foundation-lowest-column-column-width-invalid');
  const differenceMm = beamWidth - columnWidth;
  if (differenceMm > WIDTH_TOLERANCE_MM) {
    return ready({
      section: '6-4',
      figure: 'FIG_6_4',
      figureCase: 'BEAM_WIDER_THAN_COLUMN',
      beamWidthMm: beamWidth,
      columnWidthMm: columnWidth,
      widthDifferenceMm: differenceMm,
      passFoundationBeamStirrupsThroughColumn: true,
      geometryReason: 'foundation-lowest-column-figure-6-4-path-not-encoded',
    });
  }
  if (differenceMm < -WIDTH_TOLERANCE_MM) {
    return ready({
      section: '6-4',
      figure: 'FIG_6_4',
      figureCase: 'BEAM_NARROWER_THAN_COLUMN',
      beamWidthMm: beamWidth,
      columnWidthMm: columnWidth,
      widthDifferenceMm: differenceMm,
      passFoundationBeamStirrupsThroughColumn: null,
      geometryReason: 'foundation-lowest-column-figure-6-4-case-2-path-not-encoded',
    });
  }
  return special('foundation-lowest-column-equal-width-not-depicted-in-figure-6-4', {
    section: '6-4',
    figure: 'FIG_6_4',
    beamWidthMm: beamWidth,
    columnWidthMm: columnWidth,
    widthDifferenceMm: differenceMm,
    widthToleranceMm: WIDTH_TOLERANCE_MM,
  });
}

export const _foundationBeamInteractionStandard2023Internals = Object.freeze({
  WIDTH_TOLERANCE_MM,
  finitePositive,
  standardSelected,
});
