/**
 * @fileoverview 配筋指針2010 付録A A3 備考表1/2の最小幅算定式。
 *
 * 付表A3-2のsource-literalセルが直接使えない場合だけ利用する。
 * 表内セルの印字値はこの式で置換しない。
 */

import { barOuterDiameterMm } from '../../../constants/beamOpeningRules.js';
import { getAppendixA3TableMetadata } from '../../../constants/rebarAppendixA3MinimumWidthTables.js';

const SOURCE_BASE_COVER_MM = 40;
const SOURCE_MAX_AGGREGATE_MM = 25;
const SOURCE_BEND_FACTOR = 3;
const MAIN_DIA_PATTERN = /^D(16|19|22|25|29|32|35|38|41)$/;
const TRANSVERSE_DIA_PATTERN = /^D(10|13|16)$/;

const COMMENTARY_P_REFERENCE_FIELDS = Object.freeze([
  'P1',
  'P2',
  'P2A',
  'P3',
  'P4',
  'P4A',
  'P5',
  'P5A',
]);

const COMMENTARY_P_REFERENCE_ROWS = Object.freeze({
  DEFORMED: Object.freeze([
    'D16/D10/50,22,26,126,72,76,101,101',
    'D16/D13/50,26,34,157,83,84,127,127',
    'D19/D10/53,23,26,127,76,79,102,102',
    'D19/D13/53,27,34,159,87,87,128,128',
    'D22/D10/58,24,26,129,82,84,104,104',
    'D22/D13/58,29,34,161,92,92,130,130',
    'D25/D10/66,25,26,131,91,92,106,106',
    'D25/D13/66,30,34,162,96,100,132,132',
    'D25/D16/66,35,42,195,111,111,159,159',
    'D29/D10/77,-,26,133,104,103,108,108',
    'D29/D13/77,31,34,165,108,111,134,134',
    'D29/D16/77,37,42,198,117,119,161,161',
    'D32/D13/84,32,34,166,116,118,136,136',
    'D32/D16/84,38,42,199,122,126,163,163',
    'D35/D13/93,34,34,168,127,127,138,138',
    'D35/D16/93,39,42,201,132,135,165,165',
    'D38/D13/100,-,34,170,135,134,139,139',
    'D38/D16/100,40,42,203,140,142,166,166',
    'D41/D16/108,41,42,204,149,150,168,168',
  ]),
  ROUND: Object.freeze([
    'D16/R9/50,19,23,113,69,73,91,91',
    'D16/R13/50,25,33,155,81,83,125,125',
    'D19/R9/53,20,23,115,73,76,92,92',
    'D19/R13/53,26,33,157,84,86,126,126',
    'D22/R9/58,22,23,117,80,81,94,94',
    'D22/R13/58,28,33,159,89,91,128,128',
    'D25/R9/66,23,23,118,89,89,96,96',
    'D25/R13/66,29,33,160,95,99,130,130',
    'D25/R16/66,33,40,192,106,106,155,155',
    'D29/R9/77,-,23,121,102,100,98,98',
    'D29/R13/77,30,33,163,107,110,132,132',
    'D29/R16/77,35,40,194,112,117,158,158',
    'D32/R13/84,31,33,164,115,117,134,134',
    'D32/R16/84,36,40,196,120,124,159,159',
    'D35/R13/93,33,33,166,126,126,136,136',
    'D35/R16/93,37,40,198,130,133,161,161',
    'D38/R13/100,-,33,168,134,133,137,137',
    'D38/R16/100,38,40,199,138,140,163,163',
    'D41/R16/108,39,40,200,147,148,164,164',
  ]),
});

function buildPReference(rows) {
  const result = {};
  for (const raw of rows) {
    const [mainBarDia, transverseBarDia, encoded] = raw.split('/');
    const values = encoded.split(',').map((value) => (value === '-' ? null : Number(value)));
    if (values.length !== COMMENTARY_P_REFERENCE_FIELDS.length) {
      throw new TypeError(`Invalid Appendix A3 commentary P row: ${raw}`);
    }
    result[mainBarDia] ||= {};
    result[mainBarDia][transverseBarDia] = Object.freeze(
      Object.fromEntries(
        COMMENTARY_P_REFERENCE_FIELDS.map((field, index) => [field, values[index]]),
      ),
    );
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(result).map(([mainBarDia, entries]) => [mainBarDia, Object.freeze(entries)]),
    ),
  );
}

const COMMENTARY_P_REFERENCE = Object.freeze({
  DEFORMED: buildPReference(COMMENTARY_P_REFERENCE_ROWS.DEFORMED),
  ROUND: buildPReference(COMMENTARY_P_REFERENCE_ROWS.ROUND),
});

function ceilMm(value) {
  return Math.ceil(Number(value) - 1e-9);
}

function ceil5Mm(value) {
  return Math.ceil((Number(value) - 1e-9) / 5) * 5;
}

function parseMainBar(value) {
  const normalized = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  const match = MAIN_DIA_PATTERN.exec(normalized);
  if (!match) return null;
  const nominalMm = Number(match[1]);
  return {
    name: normalized,
    nominalMm,
    outerMm: barOuterDiameterMm(normalized, NaN),
  };
}

function parseTransverseBar(value, tableId) {
  const normalized = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/Φ/g, 'φ');
  const family = String(tableId || '')[0];

  const deformed = TRANSVERSE_DIA_PATTERN.exec(normalized);
  if (deformed) {
    if (family === 'f') return null;
    const nominalMm = Number(deformed[1]);
    return {
      name: normalized,
      nominalMm,
      outerMm: barOuterDiameterMm(normalized, NaN),
      barType: 'DEFORMED',
      equivalentDeformedDia: normalized,
    };
  }

  const roundMatch = /^(?:R|P)?(9|13|16)φ?$/.exec(normalized) || /^φ(9|13|16)$/.exec(normalized);
  if (!roundMatch) return null;
  const nominalMm = Number(roundMatch[1]);
  if (family === 'f') {
    return {
      name: `R${nominalMm}`,
      nominalMm,
      outerMm: nominalMm,
      barType: 'ROUND',
      equivalentDeformedDia: `D${nominalMm === 9 ? 10 : nominalMm}`,
    };
  }

  const equivalent = `D${nominalMm === 9 ? 10 : nominalMm}`;
  return {
    name: equivalent,
    nominalMm: Number(equivalent.slice(1)),
    outerMm: barOuterDiameterMm(equivalent, NaN),
    barType: 'ROUND_EQUIVALENT',
    equivalentDeformedDia: equivalent,
  };
}

function isColumnCornerFloat(tableId, mainBar, transverseBar) {
  if (!String(tableId || '').endsWith('1')) return false;
  const equivalent = transverseBar?.equivalentDeformedDia;
  if (equivalent === 'D10' && mainBar.nominalMm >= 29) return true;
  if (equivalent === 'D13' && mainBar.nominalMm >= 38) return true;
  return false;
}

export function calculateAppendixA3PValues({
  mainBarDia,
  transverseBarDia,
  tableId,
  coarseAggregateMaxMm = SOURCE_MAX_AGGREGATE_MM,
} = {}) {
  const mainBar = parseMainBar(mainBarDia);
  const transverseBar = parseTransverseBar(transverseBarDia, tableId);
  if (!mainBar) {
    return { ok: false, reason: `appendix-a3-formula-main-bar-dia-unsupported:${mainBarDia}` };
  }
  if (!transverseBar) {
    return {
      ok: false,
      reason: `appendix-a3-formula-transverse-bar-dia-unsupported:${transverseBarDia}`,
    };
  }
  if (
    !(Number.isFinite(mainBar.outerMm) && mainBar.outerMm > 0) ||
    !(Number.isFinite(transverseBar.outerMm) && transverseBar.outerMm > 0)
  ) {
    return { ok: false, reason: 'appendix-a3-formula-bar-outer-diameter-unresolved' };
  }

  const aggregate = Number(coarseAggregateMaxMm);
  if (!(Number.isFinite(aggregate) && aggregate > 0)) {
    return {
      ok: false,
      reason: `appendix-a3-formula-aggregate-invalid:${coarseAggregateMaxMm}`,
    };
  }

  const family = String(tableId || '')[0];
  const referenceType = family === 'f' ? 'ROUND' : 'DEFORMED';
  const reference =
    COMMENTARY_P_REFERENCE[referenceType]?.[mainBar.name]?.[transverseBar.name] || null;
  if (!reference) {
    return {
      ok: false,
      reason: `appendix-a3-formula-p-reference-unavailable:${tableId}:${mainBar.name}:${transverseBar.name}`,
    };
  }

  const aggregateBasisMm = Math.max(SOURCE_MAX_AGGREGATE_MM, aggregate);
  const P1 =
    aggregateBasisMm <= SOURCE_MAX_AGGREGATE_MM
      ? reference.P1
      : ceilMm(mainBar.outerMm + Math.max(1.5 * mainBar.nominalMm, 1.25 * aggregateBasisMm, 25));
  const P2 = reference.P2;
  const P2A = reference.P2A;
  const P3 = reference.P3;
  const P4 =
    Number.isFinite(P2) && Number.isFinite(reference.P4)
      ? Math.max(reference.P4, P1 + P2)
      : reference.P4;
  const P4A =
    Number.isFinite(P2A) && Number.isFinite(reference.P4A)
      ? Math.max(reference.P4A, P1 + P2A)
      : reference.P4A;

  return {
    ok: true,
    reason: null,
    mainBar,
    transverseBar,
    aggregateBasisMm,
    P1,
    P2,
    P2A,
    P3,
    P4,
    P4A,
    P5: reference.P5,
    P5A: reference.P5A,
    pReferenceType: referenceType,
  };
}
function rawWidthByFamily(tableId, count, p) {
  const family = String(tableId || '')[0];
  const beam = String(tableId || '').endsWith('2');
  const P2 = beam ? p.P2A : p.P2;
  const P4 = beam ? p.P4A : p.P4;
  const P5 = beam ? p.P5A : p.P5;

  if (family === 'a') return P2 + p.P3 + 80 + (count - 2) * p.P1;
  if (family === 'b') {
    return count === 2 ? P2 + P4 + 10 + 80 : P2 + (count - 2) * p.P1 + P4 + 80;
  }
  if (family === 'c') {
    return count === 2 ? P2 + p.P3 + 80 : 2 * p.P3 + 80 + (count - 3) * p.P1;
  }
  if (family === 'd') {
    if (count === 2) return P2 + P5 + 80;
    if (count === 3) return 2 * P4 + 10 + 80;
    return 2 * P4 + (count - 3) * p.P1 + 80;
  }
  if (family === 'e' || family === 'f') {
    return 2 * P2 + (count - 1) * p.P1 + 80;
  }
  return null;
}

export function calculateAppendixA3MinimumWidthByFormula({
  tableId,
  mainBarDia,
  transverseBarDia,
  mainBarCount,
  coarseAggregateMaxMm = SOURCE_MAX_AGGREGATE_MM,
  transverseBendInsideDiameterFactor = SOURCE_BEND_FACTOR,
} = {}) {
  const metadata = getAppendixA3TableMetadata(tableId);
  if (!metadata) {
    return { ok: false, reason: `appendix-a3-formula-table-unknown:${tableId}` };
  }

  const count = Number(mainBarCount);
  if (!Number.isInteger(count) || count < 2) {
    return {
      ok: false,
      reason: `appendix-a3-formula-main-bar-count-invalid:${mainBarCount}`,
    };
  }

  const bendFactor = Number(transverseBendInsideDiameterFactor);
  if (!Number.isFinite(bendFactor) || Math.abs(bendFactor - SOURCE_BEND_FACTOR) > 1e-9) {
    return {
      ok: false,
      reason: `appendix-a3-formula-transverse-bend-factor-out-of-scope:${transverseBendInsideDiameterFactor}`,
    };
  }

  const p = calculateAppendixA3PValues({
    mainBarDia,
    transverseBarDia,
    tableId,
    coarseAggregateMaxMm,
  });
  if (!p.ok) return p;
  if (isColumnCornerFloat(tableId, p.mainBar, p.transverseBar)) {
    return {
      ok: false,
      reason: 'appendix-a3-column-corner-bar-float-requires-transverse-bend-inside-dia-4d',
    };
  }

  const rawWidthMm = rawWidthByFamily(tableId, count, p);
  if (!Number.isFinite(rawWidthMm)) {
    return { ok: false, reason: `appendix-a3-formula-family-unsupported:${tableId}` };
  }

  const sourceCoverAdjustmentMm =
    2 * Math.max(0, 1.5 * p.mainBar.nominalMm - (SOURCE_BASE_COVER_MM + p.transverseBar.outerMm));
  const widthBeforeRoundingMm = rawWidthMm + sourceCoverAdjustmentMm;
  const widthMm = ceil5Mm(widthBeforeRoundingMm);

  return {
    ok: true,
    reason: null,
    tableId,
    sourcePage: 293,
    sourcePages: [293, 294, 295, 296, 297],
    memberType: metadata.memberType,
    mainBarDia: p.mainBar.name,
    transverseBarDia: p.transverseBar.name,
    transverseBarType: p.transverseBar.barType,
    transverseBarEquivalentDeformedDia: p.transverseBar.equivalentDeformedDia,
    mainBarCount: count,
    baseRequiredWidthMm: widthMm,
    rawWidthMm,
    widthBeforeRoundingMm,
    sourceCoverAdjustmentMm,
    starredCoverRule: sourceCoverAdjustmentMm > 0,
    coverBasis: sourceCoverAdjustmentMm > 0 ? 'MAIN_BAR_NOMINAL_DIA_X1_5' : 'TABLE_BASE_40MM',
    sourceAnomaly: null,
    calculationMethod: 'COMMENTARY_FORMULA',
    pValues: {
      P1: p.P1,
      P2: p.P2,
      P2A: p.P2A,
      P3: p.P3,
      P4: p.P4,
      P4A: p.P4A,
      P5: p.P5,
      P5A: p.P5A,
    },
    calculationConditions: {
      coarseAggregateMaxMm: Number(coarseAggregateMaxMm),
      aggregateBasisMm: p.aggregateBasisMm,
      transverseBendInsideDiameterFactor: SOURCE_BEND_FACTOR,
    },
  };
}
