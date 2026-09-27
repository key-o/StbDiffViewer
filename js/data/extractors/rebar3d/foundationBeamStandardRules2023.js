/**
 * @fileoverview 日建連・JSCA「鉄筋コンクリート造配筋標準図」2023年版 §3-2 の
 * 基礎梁定着で使用する L2/L2h/La/Lb を fail-closed で解決する。
 *
 * 表3-2-1: L2 / L2h
 * 表3-2-3: La / Lb
 *
 * このresolverは表の適用範囲外を近似・丸めしない。未知のFc/鉄筋種別、表中「適用範囲外」
 * は unresolved とする。軽量コンクリートは各表の注記に従い +5d とする。
 * ST-Bridgeの strength_concrete だけでは普通/軽量を判別できないため、lightweight は明示必須とする。
 */

const FC_BANDS = Object.freeze([
  { min: 18, max: 20, key: '18' },
  { min: 21, max: 23, key: '21' },
  { min: 24, max: 29, key: '24_27' },
  { min: 30, max: 38, key: '30_36' },
  { min: 39, max: 47, key: '39_45' },
  { min: 48, max: 60, key: '48_60' },
]);

const TABLE = Object.freeze({
  SD295: Object.freeze({
    18: { l2: 40, l2h: 30, la: 20, lb: 15 },
    21: { l2: 35, l2h: 25, la: 15, lb: 15 },
    '24_27': { l2: 30, l2h: 20, la: 15, lb: 15 },
    '30_36': { l2: 30, l2h: 20, la: 15, lb: 15 },
    '39_45': { l2: 25, l2h: 15, la: 15, lb: 15 },
    '48_60': { l2: 25, l2h: 15, la: 15, lb: 15 },
  }),
  SD345: Object.freeze({
    18: { l2: 40, l2h: 30, la: 20, lb: 20 },
    21: { l2: 35, l2h: 25, la: 20, lb: 20 },
    '24_27': { l2: 35, l2h: 25, la: 20, lb: 15 },
    '30_36': { l2: 30, l2h: 20, la: 15, lb: 15 },
    '39_45': { l2: 30, l2h: 20, la: 15, lb: 15 },
    '48_60': { l2: 25, l2h: 15, la: 15, lb: 15 },
  }),
  SD390: Object.freeze({
    18: null,
    21: { l2: 40, l2h: 30, la: 20, lb: 20 },
    '24_27': { l2: 40, l2h: 30, la: 20, lb: 20 },
    '30_36': { l2: 35, l2h: 25, la: 20, lb: 15 },
    '39_45': { l2: 35, l2h: 25, la: 15, lb: 15 },
    '48_60': { l2: 30, l2h: 20, la: 15, lb: 15 },
  }),
  SD490: Object.freeze({
    18: null,
    21: null,
    '24_27': { l2: 45, l2h: 35, la: 25, lb: null },
    '30_36': { l2: 40, l2h: 30, la: 25, lb: null },
    '39_45': { l2: 40, l2h: 30, la: 20, lb: null },
    '48_60': { l2: 35, l2h: 25, la: 20, lb: null },
  }),
});

function normalizeGrade(value) {
  if (typeof value !== 'string') return null;
  const matched = value.toUpperCase().match(/SD\s*(295|345|390|490)/);
  return matched ? `SD${matched[1]}` : null;
}

function normalizeFc(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const matched = value.match(/\d+(?:\.\d+)?/);
  if (!matched) return null;
  const fc = Number(matched[0]);
  return Number.isFinite(fc) && fc > 0 ? fc : null;
}

function fcBand(fc) {
  return FC_BANDS.find((band) => fc >= band.min && fc <= band.max) || null;
}

function unresolved(reason, extra = {}) {
  return { status: 'UNRESOLVED', resolved: false, blockers: [reason], ...extra };
}

function resolved(value) {
  return { status: 'READY', resolved: true, blockers: [], ...value };
}

/**
 * 2023年版表3-2-1/3-2-3の倍率を解決する。
 */
export function resolveFoundationBeamStandardFactors({ fc, grade, lightweight } = {}) {
  if (typeof lightweight !== 'boolean') {
    return unresolved('foundation-standard-concrete-kind-unresolved');
  }

  const normalizedFc = normalizeFc(fc);
  if (normalizedFc === null) return unresolved('foundation-standard-fc-unresolved');

  const band = fcBand(normalizedFc);
  if (!band) {
    return unresolved('foundation-standard-fc-out-of-range', { fc: normalizedFc });
  }

  const normalizedGrade = normalizeGrade(grade);
  if (!normalizedGrade || !TABLE[normalizedGrade]) {
    return unresolved('foundation-standard-grade-unresolved', {
      fc: normalizedFc,
      grade: grade ?? null,
    });
  }

  const raw = TABLE[normalizedGrade][band.key];
  if (!raw) {
    return unresolved('foundation-standard-combination-out-of-scope', {
      fc: normalizedFc,
      grade: normalizedGrade,
      fcBand: band.key,
    });
  }

  const add = lightweight ? 5 : 0;
  return resolved({
    fc: normalizedFc,
    fcBand: band.key,
    grade: normalizedGrade,
    lightweight,
    concreteKind: lightweight ? 'LIGHTWEIGHT' : 'NORMAL',
    factors: {
      l2: raw.l2 === null ? null : raw.l2 + add,
      l2h: raw.l2h === null ? null : raw.l2h + add,
      la: raw.la === null ? null : raw.la + add,
      lb: raw.lb === null ? null : raw.lb + add,
    },
    source: 'NIKKENREN-JSCA-RC-REBAR-STANDARD-2023-TABLE-3-2-1-3-2-3',
  });
}

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function factorRequirement(factorsResult, factorKey, barDiaMm) {
  if (!factorsResult?.resolved) return factorsResult;
  if (!positive(barDiaMm)) return unresolved('foundation-standard-bar-dia-invalid');
  const factor = factorsResult.factors?.[factorKey];
  if (!positive(factor)) {
    return unresolved(`foundation-standard-${factorKey}-out-of-scope`, {
      fc: factorsResult.fc,
      grade: factorsResult.grade,
    });
  }
  return resolved({
    kind: factorKey.toUpperCase(),
    factor,
    barDiaMm,
    requiredMm: factor * barDiaMm,
    fc: factorsResult.fc,
    grade: factorsResult.grade,
    lightweight: factorsResult.lightweight,
    concreteKind: factorsResult.concreteKind,
    source: factorsResult.source,
  });
}

export function computeFoundationL2(params = {}) {
  return factorRequirement(resolveFoundationBeamStandardFactors(params), 'l2', params.barDiaMm);
}

export function computeFoundationL2h(params = {}) {
  return factorRequirement(resolveFoundationBeamStandardFactors(params), 'l2h', params.barDiaMm);
}

export function computeFoundationLaProjection(params = {}) {
  const base = factorRequirement(
    resolveFoundationBeamStandardFactors(params),
    'la',
    params.barDiaMm,
  );
  if (!base.resolved) return base;
  if (!positive(params.columnDepthMm)) {
    return unresolved('foundation-standard-column-depth-invalid');
  }
  const minByColumnMm = 0.75 * params.columnDepthMm;
  return resolved({
    ...base,
    kind: 'LA',
    tableRequiredMm: base.requiredMm,
    minByColumnMm,
    requiredMm: Math.max(base.requiredMm, minByColumnMm),
    projectionBasis: 'MAX_TABLE_LA_AND_COLUMN_DEPTH_3_4',
  });
}

export function computeFoundationLbProjection(params = {}) {
  const base = factorRequirement(
    resolveFoundationBeamStandardFactors(params),
    'lb',
    params.barDiaMm,
  );
  if (!base.resolved) return base;
  if (!positive(params.supportBeamWidthMm)) {
    return unresolved('foundation-standard-support-beam-width-invalid');
  }
  const minByBeamWidthMm = 0.5 * params.supportBeamWidthMm;
  return resolved({
    ...base,
    kind: 'LB',
    tableRequiredMm: base.requiredMm,
    minByBeamWidthMm,
    requiredMm: Math.max(base.requiredMm, minByBeamWidthMm),
    projectionBasis: 'MAX_TABLE_LB_AND_SUPPORT_BEAM_WIDTH_1_2',
  });
}

export function computeFoundationHookTail90({ barDiaMm } = {}) {
  if (!positive(barDiaMm)) return unresolved('foundation-standard-bar-dia-invalid');
  return resolved({
    kind: 'HOOK_TAIL_90',
    factor: 8,
    barDiaMm,
    requiredMm: 8 * barDiaMm,
    source: 'NIKKENREN-JSCA-RC-REBAR-STANDARD-2023-SECTION-3-2',
  });
}

export const _foundationBeamStandardRules2023Internals = Object.freeze({
  FC_BANDS,
  TABLE,
  normalizeFc,
  normalizeGrade,
  fcBand,
});
