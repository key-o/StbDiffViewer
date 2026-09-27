/**
 * @fileoverview 配筋指針2010 付録A A3の柱・梁最小幅 validator。
 *
 * Choice schema から付表A3-2の table class を解決し、主筋径・本数・帯筋/あばら筋径
 * に対する必要幅を source-literal lookup する。表外値は補間・外挿しない。
 */

import {
  OrthogonalBeamAssemblyOrder,
  ShearClosureFamily,
  ShearFabricationSequence,
  ShearHookPattern,
  normalizeRebarDetailingChoice,
} from '../../../config/rebarDetailingChoice.js';
import { barOuterDiameterMm } from '../../../constants/beamOpeningRules.js';
import {
  APPENDIX_A3_MAIN_BAR_COUNTS,
  APPENDIX_A3_SOURCE,
  getAppendixA3RawRow,
  getAppendixA3SourceAnomaly,
  getAppendixA3TableMetadata,
} from '../../../constants/rebarAppendixA3MinimumWidthTables.js';
import { rebarRuleTraceMetadata } from './rebarDetailingRuleRegistry.js';
import { calculateAppendixA3MinimumWidthByFormula } from './rebarAppendixA3MinimumWidthFormula.js';

export const AppendixA3Exposure = Object.freeze({
  STANDARD: 'STANDARD',
  OUTDOOR_NO_DURABLE_FINISH: 'OUTDOOR_NO_DURABLE_FINISH',
  SOIL_CONTACT: 'SOIL_CONTACT',
});

const NO_HOOK_CLOSURES = new Set([
  ShearClosureFamily.WELDED_CLOSED,
  ShearClosureFamily.SPIRAL,
  ShearClosureFamily.MECHANICAL_CLOSED,
]);
const A3_WIDTH_RULE = rebarRuleTraceMetadata('APPENDIX-A3-MINIMUM-SECTION-WIDTH-GUIDE');
const A3_CONDITION_RULE = rebarRuleTraceMetadata('APPENDIX-A3-CALCULATION-CONDITIONS');
const A3_NO_INTERPOLATION_RULE = rebarRuleTraceMetadata('APPENDIX-A3-NO-INTERPOLATION');
const A3_COVER_RULE = rebarRuleTraceMetadata('APPENDIX-A3-COVER-ADJUSTMENT');
const A3_FORMULA_RULE = rebarRuleTraceMetadata('APPENDIX-A3-COMMENTARY-FORMULA-FALLBACK');

function resolveCalculationConditions({
  coarseAggregateMaxMm,
  transverseBendInsideDiameterFactor,
  lapSpliceConcentratedCount,
} = {}) {
  const aggregate = Number(coarseAggregateMaxMm);
  const aggregateResolved =
    Number.isFinite(aggregate) && aggregate > 0
      ? { value: aggregate, assumed: false }
      : { value: APPENDIX_A3_SOURCE.calculationConditions.maxCoarseAggregateMm, assumed: true };
  const useCommentaryFormula =
    aggregateResolved.value > APPENDIX_A3_SOURCE.calculationConditions.maxCoarseAggregateMm;

  const bendFactor = Number(transverseBendInsideDiameterFactor);
  const bendResolved =
    Number.isFinite(bendFactor) && bendFactor > 0
      ? { value: bendFactor, assumed: false }
      : {
          value: APPENDIX_A3_SOURCE.calculationConditions.transverseBendInsideDiameterFactor,
          assumed: true,
        };
  if (
    Math.abs(
      bendResolved.value -
        APPENDIX_A3_SOURCE.calculationConditions.transverseBendInsideDiameterFactor,
    ) > 1e-9
  ) {
    return {
      ok: false,
      reason: `appendix-a3-transverse-bend-factor-outside-commentary-formula:bend-factor-not-3d:${bendResolved.value}`,
      coarseAggregateMaxMm: aggregateResolved,
      transverseBendInsideDiameterFactor: bendResolved,
    };
  }

  const spliceCountRaw =
    lapSpliceConcentratedCount === null || lapSpliceConcentratedCount === undefined
      ? 0
      : Number(lapSpliceConcentratedCount);
  if (!Number.isInteger(spliceCountRaw) || spliceCountRaw < 0) {
    return {
      ok: false,
      reason: `appendix-a3-lap-splice-count-invalid:${lapSpliceConcentratedCount}`,
      coarseAggregateMaxMm: aggregateResolved,
      transverseBendInsideDiameterFactor: bendResolved,
    };
  }

  return {
    ok: true,
    reason: null,
    useCommentaryFormula,
    coarseAggregateMaxMm: aggregateResolved,
    transverseBendInsideDiameterFactor: bendResolved,
    lapSpliceConcentratedCount: {
      value: spliceCountRaw,
      assumed: lapSpliceConcentratedCount === null || lapSpliceConcentratedCount === undefined,
    },
  };
}

function normalizedMemberType(memberType) {
  const normalized = String(memberType || '')
    .trim()
    .toUpperCase();
  return ['COLUMN', 'BEAM'].includes(normalized) ? normalized : null;
}

function normalizeMainBarDia(value) {
  const normalized = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  return /^D(?:16|19|22|25|29|32|35|38|41)$/.test(normalized) ? normalized : null;
}

function normalizeTransverseBar(value) {
  const normalized = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/Φ/g, 'φ');

  if (normalized === 'D10') {
    return { barType: 'DEFORMED', deformedTableDia: 'D10', roundTableDia: null };
  }
  if (normalized === 'D13') {
    return { barType: 'DEFORMED', deformedTableDia: 'D13', roundTableDia: null };
  }
  if (normalized === 'D16') {
    return { barType: 'DEFORMED', deformedTableDia: 'D16', roundTableDia: null };
  }

  if (['9φ', 'φ9', '9', 'P9', 'R9'].includes(normalized)) {
    return { barType: 'ROUND', deformedTableDia: 'D10', roundTableDia: 'R9' };
  }
  if (['13φ', 'φ13', '13', 'P13', 'R13'].includes(normalized)) {
    return { barType: 'ROUND', deformedTableDia: 'D13', roundTableDia: 'R13' };
  }
  if (['16φ', 'φ16', '16', 'P16', 'R16'].includes(normalized)) {
    return { barType: 'ROUND', deformedTableDia: 'D16', roundTableDia: 'R16' };
  }
  return null;
}

function memberChoice(choice, memberType) {
  const normalized = normalizeRebarDetailingChoice(choice);
  return memberType === 'COLUMN' ? normalized.columnHoop : normalized.girderStirrup;
}

function tableSuffix(memberType) {
  return memberType === 'COLUMN' ? '1' : '2';
}

function tableIdForSequence(choice, memberType, sequence) {
  const item = memberChoice(choice, memberType);
  const suffix = tableSuffix(memberType);

  if (NO_HOOK_CLOSURES.has(item.closureFamily)) return `e${suffix}`;

  if (item.closureFamily === ShearClosureFamily.U_WITH_CAP) {
    if (memberType !== 'BEAM') return null;
    return sequence === ShearFabricationSequence.PRE_BENT ? 'd2' : null;
  }

  if (item.closureFamily !== ShearClosureFamily.HOOKED) return null;

  if (item.hookPattern === ShearHookPattern.SINGLE_CORNER) {
    if (sequence === ShearFabricationSequence.POST_BENT) return `a${suffix}`;
    if (sequence === ShearFabricationSequence.PRE_BENT) return `b${suffix}`;
    return null;
  }

  if (item.hookPattern === ShearHookPattern.ALTERNATING) {
    if (sequence === ShearFabricationSequence.POST_BENT) return `c${suffix}`;
    if (sequence === ShearFabricationSequence.PRE_BENT) return `d${suffix}`;
  }

  return null;
}

export function resolveAppendixA3TableCandidates(choice, memberType = 'BEAM') {
  const type = normalizedMemberType(memberType);
  if (!type) {
    return {
      ok: false,
      memberType: null,
      reason: `appendix-a3-member-type-unsupported:${memberType}`,
      candidates: [],
    };
  }
  const item = memberChoice(choice, type);

  if (NO_HOOK_CLOSURES.has(item.closureFamily)) {
    return {
      ok: true,
      memberType: type,
      candidates: [
        Object.freeze({
          tableId: `e${tableSuffix(type)}`,
          fabricationSequence: null,
        }),
      ],
    };
  }

  if (item.closureFamily === ShearClosureFamily.U_WITH_CAP) {
    if (type !== 'BEAM') {
      return {
        ok: false,
        memberType: type,
        reason: 'appendix-a3-u-with-cap-beam-only',
        candidates: [],
      };
    }
    if (
      ![ShearFabricationSequence.UNSPECIFIED, ShearFabricationSequence.PRE_BENT].includes(
        item.fabricationSequence,
      )
    ) {
      return {
        ok: false,
        memberType: type,
        reason: 'appendix-a3-u-with-cap-requires-pre-bent',
        candidates: [],
      };
    }
    return {
      ok: true,
      memberType: type,
      candidates: [
        Object.freeze({
          tableId: 'd2',
          fabricationSequence: ShearFabricationSequence.PRE_BENT,
        }),
      ],
    };
  }

  if (item.closureFamily !== ShearClosureFamily.HOOKED) {
    return {
      ok: false,
      memberType: type,
      reason: `appendix-a3-closure-not-supported:${item.closureFamily}`,
      candidates: [],
    };
  }

  const sequences =
    item.fabricationSequence === ShearFabricationSequence.UNSPECIFIED
      ? [ShearFabricationSequence.PRE_BENT, ShearFabricationSequence.POST_BENT]
      : [item.fabricationSequence];

  const candidates = sequences
    .map((sequence) => ({
      tableId: tableIdForSequence(choice, type, sequence),
      fabricationSequence: sequence,
    }))
    .filter((candidate) => candidate.tableId);

  if (candidates.length !== sequences.length) {
    return {
      ok: false,
      memberType: type,
      reason: 'appendix-a3-table-class-unresolved',
      candidates: [],
    };
  }

  return { ok: true, memberType: type, candidates: candidates.map(Object.freeze) };
}

function exposureAdjustmentForSide(memberType, exposure, side) {
  const normalized = String(exposure || AppendixA3Exposure.STANDARD).toUpperCase();
  if (!Object.values(AppendixA3Exposure).includes(normalized)) {
    return {
      ok: false,
      reason: `appendix-a3-exposure-unsupported:${side}:${normalized}`,
      adjustmentMm: 0,
    };
  }

  if (normalized === AppendixA3Exposure.STANDARD) {
    return { ok: true, adjustmentMm: 0, reason: null };
  }

  if (normalized === AppendixA3Exposure.OUTDOOR_NO_DURABLE_FINISH) {
    return { ok: true, adjustmentMm: 10, reason: null };
  }

  if (normalized === AppendixA3Exposure.SOIL_CONTACT) {
    return { ok: true, adjustmentMm: 10, reason: null };
  }

  return {
    ok: false,
    reason: `appendix-a3-exposure-unsupported:${side}:${normalized}`,
    adjustmentMm: 0,
  };
}

export function resolveAppendixA3ExposureAdjustment(
  memberType,
  { left = AppendixA3Exposure.STANDARD, right = AppendixA3Exposure.STANDARD } = {},
) {
  const type = normalizedMemberType(memberType);
  if (!type) {
    return {
      ok: false,
      memberType: null,
      reason: `appendix-a3-member-type-unsupported:${memberType}`,
      adjustmentMm: null,
    };
  }
  const leftResult = exposureAdjustmentForSide(type, left, 'left');
  const rightResult = exposureAdjustmentForSide(type, right, 'right');
  if (!leftResult.ok || !rightResult.ok) {
    return {
      ok: false,
      memberType: type,
      reason: leftResult.reason || rightResult.reason,
      adjustmentMm: null,
      left: leftResult,
      right: rightResult,
    };
  }
  return {
    ok: true,
    memberType: type,
    reason: null,
    adjustmentMm: leftResult.adjustmentMm + rightResult.adjustmentMm,
    left: leftResult,
    right: rightResult,
  };
}

function isAppendixA3ColumnCornerFloatCombination(mainBarDia, normalizedTransverse) {
  const mainDiaMm = nominalDiameterMm(mainBarDia);
  const equivalent = normalizedTransverse?.deformedTableDia;
  if (!Number.isFinite(mainDiaMm)) return false;
  if (equivalent === 'D10' && mainDiaMm >= 29) return true;
  if (equivalent === 'D13' && mainDiaMm >= 38) return true;
  return false;
}

export function lookupAppendixA3MinimumWidth({
  tableId,
  mainBarDia,
  transverseBarDia,
  mainBarCount,
} = {}) {
  const normalizedMain = normalizeMainBarDia(mainBarDia);
  const normalizedTransverse = normalizeTransverseBar(transverseBarDia);
  const count = Number(mainBarCount);

  if (!getAppendixA3TableMetadata(tableId)) {
    return { ok: false, reason: `appendix-a3-table-unknown:${tableId}` };
  }
  if (!normalizedMain) {
    return { ok: false, reason: `appendix-a3-main-bar-dia-unsupported:${mainBarDia}` };
  }
  if (!normalizedTransverse) {
    return {
      ok: false,
      reason: `appendix-a3-transverse-bar-dia-unsupported:${transverseBarDia}`,
    };
  }

  const isRoundTable = String(tableId).startsWith('f');
  const isNoHookDeformedTable = String(tableId).startsWith('e');
  if (isRoundTable && normalizedTransverse.barType !== 'ROUND') {
    return {
      ok: false,
      reason: `appendix-a3-f-table-requires-round-bar:${transverseBarDia}`,
    };
  }
  if (isNoHookDeformedTable && normalizedTransverse.barType === 'ROUND') {
    return {
      ok: false,
      reason: `appendix-a3-round-bar-requires-f-table:${transverseBarDia}`,
    };
  }

  const transverseTableDia = isRoundTable
    ? normalizedTransverse.roundTableDia
    : normalizedTransverse.deformedTableDia;
  if (!Number.isInteger(count) || !APPENDIX_A3_MAIN_BAR_COUNTS.includes(count)) {
    return { ok: false, reason: `appendix-a3-main-bar-count-out-of-range:${mainBarCount}` };
  }

  const row = getAppendixA3RawRow(tableId, normalizedMain, transverseTableDia);
  if (!row) {
    const metadata = getAppendixA3TableMetadata(tableId);
    if (
      metadata?.memberType === 'COLUMN' &&
      isAppendixA3ColumnCornerFloatCombination(normalizedMain, normalizedTransverse)
    ) {
      return {
        ok: false,
        reason: 'appendix-a3-column-corner-bar-float-requires-transverse-bend-inside-dia-4d',
      };
    }
    return {
      ok: false,
      reason: `appendix-a3-combination-not-tabulated:${tableId}:${normalizedMain}:${transverseTableDia}`,
    };
  }

  const widthMm = row.valuesMm[count - 2];
  if (!Number.isFinite(widthMm)) {
    return {
      ok: false,
      reason: `appendix-a3-source-cell-missing:${tableId}:${normalizedMain}:${transverseTableDia}:${count}`,
    };
  }

  const metadata = getAppendixA3TableMetadata(tableId);
  const sourceAnomaly = getAppendixA3SourceAnomaly(
    tableId,
    normalizedMain,
    transverseTableDia,
    count,
  );

  return {
    ok: true,
    reason: null,
    tableId,
    source: APPENDIX_A3_SOURCE,
    sourcePage: metadata.sourcePage,
    memberType: metadata.memberType,
    mainBarDia: normalizedMain,
    transverseBarDia: transverseTableDia,
    transverseBarType: normalizedTransverse.barType,
    transverseBarEquivalentDeformedDia: normalizedTransverse.deformedTableDia,
    mainBarCount: count,
    baseRequiredWidthMm: widthMm,
    starredCoverRule: row.starredCoverRule,
    coverBasis: row.starredCoverRule ? 'MAIN_BAR_NOMINAL_DIA_X1_5' : 'TABLE_BASE_40MM',
    sourceAnomaly,
  };
}

function adaptCandidateForTransverseBar(choice, memberType, candidate, transverseBarDia) {
  const normalized = normalizeTransverseBar(transverseBarDia);
  if (!normalized || normalized.barType !== 'ROUND' || !candidate.tableId.startsWith('e')) {
    return { ok: true, candidate };
  }

  const item = memberChoice(choice, memberType);
  if (![ShearClosureFamily.WELDED_CLOSED, ShearClosureFamily.SPIRAL].includes(item.closureFamily)) {
    return {
      ok: false,
      reason: `appendix-a3-round-bar-no-table-for-closure:${item.closureFamily}`,
      candidate,
    };
  }

  return {
    ok: true,
    candidate: {
      ...candidate,
      tableId: candidate.tableId === 'e1' ? 'f1' : 'f2',
    },
  };
}

function nominalDiameterMm(dia) {
  const match = /^D(\d+)$/.exec(String(dia || '').toUpperCase());
  return match ? Number(match[1]) : null;
}

function finitePositiveOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function resolveCandidateCoverAdjustment(lookup, exposureResult, cover = {}) {
  const mainDiaMm = nominalDiameterMm(lookup.mainBarDia);
  const baseCoverPerSideMm = lookup.starredCoverRule ? mainDiaMm * 1.5 : 40;

  if (!Number.isFinite(baseCoverPerSideMm)) {
    return {
      ok: false,
      reason: 'appendix-a3-cover-basis-unresolved',
    };
  }

  const requiredLeftMm = baseCoverPerSideMm + Number(exposureResult.left?.adjustmentMm || 0);
  const requiredRightMm = baseCoverPerSideMm + Number(exposureResult.right?.adjustmentMm || 0);
  const actualLeftMm = finitePositiveOrNull(cover.leftMm);
  const actualRightMm = finitePositiveOrNull(cover.rightMm);
  const effectiveLeftMm = Math.max(requiredLeftMm, actualLeftMm ?? requiredLeftMm);
  const effectiveRightMm = Math.max(requiredRightMm, actualRightMm ?? requiredRightMm);

  const warnings = [];
  if (actualLeftMm !== null && actualLeftMm < requiredLeftMm) {
    warnings.push({
      code: 'APPENDIX_A3_COVER_BELOW_REQUIRED',
      side: 'LEFT',
      actualCoverMm: actualLeftMm,
      requiredCoverMm: requiredLeftMm,
    });
  }
  if (actualRightMm !== null && actualRightMm < requiredRightMm) {
    warnings.push({
      code: 'APPENDIX_A3_COVER_BELOW_REQUIRED',
      side: 'RIGHT',
      actualCoverMm: actualRightMm,
      requiredCoverMm: requiredRightMm,
    });
  }

  return {
    ok: true,
    reason: null,
    baseCoverPerSideMm,
    requiredCoverMm: { left: requiredLeftMm, right: requiredRightMm },
    actualCoverMm: { left: actualLeftMm, right: actualRightMm },
    effectiveCoverMm: { left: effectiveLeftMm, right: effectiveRightMm },
    widthAdjustmentMm:
      effectiveLeftMm - baseCoverPerSideMm + (effectiveRightMm - baseCoverPerSideMm),
    warnings,
  };
}

function evaluateCandidate(candidate, inputs, exposureResult, cover, calculationConditions) {
  const directLookup = calculationConditions.useCommentaryFormula
    ? null
    : lookupAppendixA3MinimumWidth({
        tableId: candidate.tableId,
        mainBarDia: inputs.mainBarDia,
        transverseBarDia: inputs.transverseBarDia,
        mainBarCount: inputs.mainBarCount,
      });

  let lookup =
    directLookup?.ok === true ? { ...directLookup, calculationMethod: 'SOURCE_TABLE' } : null;
  const formulaFallbackReason = calculationConditions.useCommentaryFormula
    ? `aggregate-over-${APPENDIX_A3_SOURCE.calculationConditions.maxCoarseAggregateMm}`
    : directLookup?.reason || 'source-table-unavailable';

  if (!lookup) {
    const formula = calculateAppendixA3MinimumWidthByFormula({
      tableId: candidate.tableId,
      mainBarDia: inputs.mainBarDia,
      transverseBarDia: inputs.transverseBarDia,
      mainBarCount: inputs.mainBarCount,
      coarseAggregateMaxMm: calculationConditions.coarseAggregateMaxMm.value,
      transverseBendInsideDiameterFactor:
        calculationConditions.transverseBendInsideDiameterFactor.value,
    });
    if (!formula.ok) {
      return {
        ok: false,
        tableId: candidate.tableId,
        fabricationSequence: candidate.fabricationSequence,
        reason: formula.reason,
        formulaAttempted: true,
        formulaFallbackReason,
      };
    }
    lookup = formula;
  }

  const coverAdjustment = resolveCandidateCoverAdjustment(lookup, exposureResult, cover);
  if (!coverAdjustment.ok) {
    return {
      ok: false,
      tableId: candidate.tableId,
      fabricationSequence: candidate.fabricationSequence,
      reason: coverAdjustment.reason,
      formulaAttempted: lookup.calculationMethod === 'COMMENTARY_FORMULA',
    };
  }

  const mainBarOuterDiameterMm = barOuterDiameterMm(lookup.mainBarDia, NaN);
  if (!(Number.isFinite(mainBarOuterDiameterMm) && mainBarOuterDiameterMm > 0)) {
    return {
      ok: false,
      tableId: candidate.tableId,
      fabricationSequence: candidate.fabricationSequence,
      reason: 'appendix-a3-main-bar-outer-diameter-unresolved',
      formulaAttempted: lookup.calculationMethod === 'COMMENTARY_FORMULA',
    };
  }
  const spliceExtraWidthMm =
    mainBarOuterDiameterMm * calculationConditions.lapSpliceConcentratedCount.value;
  const requiredWidthMm =
    lookup.baseRequiredWidthMm + coverAdjustment.widthAdjustmentMm + spliceExtraWidthMm;
  const providedWidthMm = Number(inputs.providedWidthMm);
  const hasProvided = Number.isFinite(providedWidthMm) && providedWidthMm > 0;

  return {
    ok: true,
    tableId: candidate.tableId,
    fabricationSequence: candidate.fabricationSequence,
    sourcePage: lookup.sourcePage,
    sourcePages: lookup.sourcePages || null,
    mainBarDia: lookup.mainBarDia,
    transverseBarDia: lookup.transverseBarDia,
    mainBarCount: lookup.mainBarCount,
    baseRequiredWidthMm: lookup.baseRequiredWidthMm,
    exposureAdjustmentMm: exposureResult.adjustmentMm,
    coverAdjustment,
    spliceExtraWidthMm,
    requiredWidthMm,
    providedWidthMm: hasProvided ? providedWidthMm : null,
    marginMm: hasProvided ? providedWidthMm - requiredWidthMm : null,
    pass: hasProvided ? providedWidthMm >= requiredWidthMm : null,
    starredCoverRule: lookup.starredCoverRule,
    coverBasis: lookup.coverBasis,
    sourceAnomaly: lookup.sourceAnomaly,
    calculationMethod: lookup.calculationMethod || 'SOURCE_TABLE',
    formulaFallbackReason:
      lookup.calculationMethod === 'COMMENTARY_FORMULA' ? formulaFallbackReason : null,
    formulaTrace:
      lookup.calculationMethod === 'COMMENTARY_FORMULA'
        ? {
            pValues: lookup.pValues,
            rawWidthMm: lookup.rawWidthMm,
            widthBeforeRoundingMm: lookup.widthBeforeRoundingMm,
            sourceCoverAdjustmentMm: lookup.sourceCoverAdjustmentMm,
            calculationConditions: lookup.calculationConditions,
          }
        : null,
  };
}
function summarizeCandidates(candidates, hasProvided) {
  if (!hasProvided) {
    return candidates.length > 1 ? 'MULTIPLE_CANDIDATES' : 'RESOLVED_REQUIREMENT';
  }
  const passCount = candidates.filter((candidate) => candidate.pass === true).length;
  if (candidates.length === 1) return passCount === 1 ? 'PASS' : 'FAIL';
  if (passCount === candidates.length) return 'PASS_ALL';
  if (passCount === 0) return 'FAIL_ALL';
  return 'CONDITIONAL';
}

export function validateAppendixA3MinimumWidth({
  choice,
  memberType = 'BEAM',
  mainBarDia,
  transverseBarDia,
  mainBarCount,
  providedWidthMm = null,
  exposure = {},
  cover = {},
  coarseAggregateMaxMm = null,
  transverseBendInsideDiameterFactor = null,
  lapSpliceConcentratedCount = null,
} = {}) {
  const type = normalizedMemberType(memberType);
  if (!type) {
    return {
      ok: false,
      status: 'UNRESOLVED',
      memberType: null,
      reason: `appendix-a3-member-type-unsupported:${memberType}`,
      candidates: [],
    };
  }
  const calculationConditions = resolveCalculationConditions({
    coarseAggregateMaxMm,
    transverseBendInsideDiameterFactor,
    lapSpliceConcentratedCount,
  });
  if (!calculationConditions.ok) {
    return {
      ok: false,
      status: 'UNRESOLVED',
      memberType: type,
      reason: calculationConditions.reason,
      candidates: [],
      calculationConditions,
      appliedRules: [A3_WIDTH_RULE, A3_CONDITION_RULE],
    };
  }

  const tableCandidates = resolveAppendixA3TableCandidates(choice, type);
  if (!tableCandidates.ok) {
    return {
      ok: false,
      status: 'UNRESOLVED',
      memberType: type,
      reason: tableCandidates.reason,
      candidates: [],
      calculationConditions,
      appliedRules: [A3_WIDTH_RULE, A3_CONDITION_RULE, A3_NO_INTERPOLATION_RULE],
    };
  }

  const exposureResult = resolveAppendixA3ExposureAdjustment(type, exposure);
  if (!exposureResult.ok) {
    return {
      ok: false,
      status: 'UNRESOLVED',
      memberType: type,
      reason: exposureResult.reason,
      candidates: [],
      exposure: exposureResult,
      calculationConditions,
      appliedRules: [A3_WIDTH_RULE, A3_CONDITION_RULE, A3_COVER_RULE],
    };
  }

  const inputs = { mainBarDia, transverseBarDia, mainBarCount, providedWidthMm };
  const adaptedCandidates = tableCandidates.candidates.map((candidate) =>
    adaptCandidateForTransverseBar(choice, type, candidate, transverseBarDia),
  );
  const adaptationFailure = adaptedCandidates.find((item) => !item.ok);
  if (adaptationFailure) {
    return {
      ok: false,
      status: 'UNRESOLVED',
      memberType: type,
      reason: adaptationFailure.reason,
      candidates: [],
      exposure: exposureResult,
      calculationConditions,
      appliedRules: [A3_WIDTH_RULE, A3_CONDITION_RULE, A3_NO_INTERPOLATION_RULE],
    };
  }
  const candidates = adaptedCandidates.map((item) =>
    evaluateCandidate(item.candidate, inputs, exposureResult, cover, calculationConditions),
  );
  const failed = candidates.find((candidate) => !candidate.ok);
  if (failed) {
    return {
      ok: false,
      status: 'UNRESOLVED',
      memberType: type,
      reason: failed.reason,
      candidates,
      exposure: exposureResult,
      calculationConditions,
      appliedRules: [
        A3_WIDTH_RULE,
        A3_CONDITION_RULE,
        A3_NO_INTERPOLATION_RULE,
        ...(failed.formulaAttempted ? [A3_FORMULA_RULE] : []),
      ],
    };
  }

  const provided = Number(providedWidthMm);
  const hasProvided = Number.isFinite(provided) && provided > 0;
  const requiredWidths = candidates.map((candidate) => candidate.requiredWidthMm);
  const warnings = [
    ...candidates
      .filter((candidate) => candidate.sourceAnomaly)
      .map((candidate) => ({
        code: 'APPENDIX_A3_SOURCE_LITERAL_ANOMALY',
        ...candidate.sourceAnomaly,
      })),
    ...candidates.flatMap((candidate) => candidate.coverAdjustment?.warnings || []),
    ...candidates
      .filter((candidate) => candidate.calculationMethod === 'COMMENTARY_FORMULA')
      .map((candidate) => ({
        code: 'APPENDIX_A3_COMMENTARY_FORMULA_FALLBACK',
        tableId: candidate.tableId,
        reason: candidate.formulaFallbackReason,
        sourcePages: candidate.sourcePages,
      })),
  ];
  if (calculationConditions.transverseBendInsideDiameterFactor.assumed) {
    warnings.push({
      code: 'APPENDIX_A3_BEND_FACTOR_ASSUMED_3D',
      assumedFactor: calculationConditions.transverseBendInsideDiameterFactor.value,
    });
  }
  if (calculationConditions.lapSpliceConcentratedCount.assumed) {
    warnings.push({
      code: 'APPENDIX_A3_LAP_SPLICE_COUNT_ASSUMED_ZERO',
      assumedCount: calculationConditions.lapSpliceConcentratedCount.value,
    });
  }

  return {
    ok: true,
    status: summarizeCandidates(candidates, hasProvided),
    memberType: type,
    source: APPENDIX_A3_SOURCE,
    providedWidthMm: hasProvided ? provided : null,
    requiredWidthRangeMm: {
      min: Math.min(...requiredWidths),
      max: Math.max(...requiredWidths),
    },
    candidates,
    exposure: exposureResult,
    calculationConditions,
    warnings,
    appliedRules: [
      A3_WIDTH_RULE,
      A3_CONDITION_RULE,
      A3_COVER_RULE,
      ...(candidates.some((candidate) => candidate.calculationMethod === 'COMMENTARY_FORMULA')
        ? [A3_FORMULA_RULE]
        : []),
    ],
    decisionContext: {
      orthogonalBeamAssemblyOrder:
        normalizeRebarDetailingChoice(choice).joint?.orthogonalBeamAssemblyOrder ||
        OrthogonalBeamAssemblyOrder.EXPLICIT_REQUIRED,
    },
  };
}
