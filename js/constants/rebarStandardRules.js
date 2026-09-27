/**
 * @fileoverview 配筋標準図の既定値とプロジェクト共通設定を解決するルールカーネル。
 */

import { getRebarCommonConfig } from '../config/rebarCommonConfig.js';
import { NIKKENREN_2023_REBAR_STANDARD_DEFAULTS } from './rebarStandardDefaults.js';

const defaults = NIKKENREN_2023_REBAR_STANDARD_DEFAULTS;

function normalizeGrade(grade) {
  if (typeof grade !== 'string') return null;
  const matched = grade.toUpperCase().match(/SD\s*(\d{3})/);
  return matched ? `SD${matched[1]}` : null;
}

function resolveFcBand(fc) {
  if (!Number.isFinite(fc)) return null;
  return defaults.lengths.fcBands.find((band) => fc >= band.min && fc <= band.max) || null;
}

function getLengthTableOverride(table, grade, bandKey) {
  if (!table || typeof table !== 'object' || Array.isArray(table)) return null;
  const row = table[grade]?.[bandKey];
  return row && typeof row === 'object' && !Array.isArray(row) ? row : null;
}

function applyNumericOverrides(values, override, keys) {
  if (!override) return values;
  const next = { ...values };
  for (const key of keys) {
    if (Number.isFinite(override[key])) next[key] = override[key];
  }
  return next;
}

function resolveLengthFactors({ fc, grade }) {
  const normalizedGrade = normalizeGrade(grade);
  const band = resolveFcBand(fc);
  const baseValues =
    normalizedGrade && band ? defaults.lengths.factors[normalizedGrade]?.[band.key] : null;

  if (!normalizedGrade || !band || !baseValues) {
    return {
      ok: false,
      specialRequired: true,
      standardId: defaults.standardId,
      grade: normalizedGrade,
      fcBand: band?.key || null,
      values: null,
    };
  }

  const config = getRebarCommonConfig();
  let values = { ...baseValues };
  values = applyNumericOverrides(
    values,
    getLengthTableOverride(config.splice.lapLengthTable, normalizedGrade, band.key),
    ['l1', 'l1h'],
  );
  values = applyNumericOverrides(
    values,
    getLengthTableOverride(config.anchorage.developmentLengthTable, normalizedGrade, band.key),
    ['l2', 'l2h'],
  );
  values = applyNumericOverrides(
    values,
    getLengthTableOverride(config.anchorage.projectionLengthTable, normalizedGrade, band.key),
    ['la', 'lb'],
  );

  return {
    ok: true,
    specialRequired: false,
    standardId: defaults.standardId,
    grade: normalizedGrade,
    fcBand: band.key,
    values,
  };
}

function resolveLengthFactor({ kind, fc, grade }) {
  const resolved = resolveLengthFactors({ fc, grade });
  if (!resolved.ok) return { ...resolved, kind, factor: null };

  const key = String(kind || '').toLowerCase();
  const factor = Object.prototype.hasOwnProperty.call(resolved.values, key)
    ? resolved.values[key]
    : null;
  if (!Number.isFinite(factor)) {
    return { ...resolved, ok: false, specialRequired: true, kind: key, factor: null };
  }
  return { ...resolved, kind: key, factor };
}

/**
 * 小梁下端筋の定着長さ L3 / L3h を表3-2-2の既定値から解決する。
 *
 * geometryや支持面は扱わず、必要長さだけを返す。片持ち小梁の直線定着は
 * 表中の <25d> を用い、フック付定着は通常小梁と同じ L3h=10d を採用する。
 */
function resolveSmallBeamBottomAnchorage({ barDiaMm, cantilever = false, hooked = false } = {}) {
  const rule = defaults.lengths.smallBeamAndSlabBottom?.smallBeam || null;
  const kind = hooked ? 'L3H' : 'L3';
  const factor = hooked
    ? rule?.l3hDiaFactor
    : cantilever
      ? rule?.cantileverL3DiaFactor
      : rule?.l3DiaFactor;

  if (!(Number.isFinite(barDiaMm) && barDiaMm > 0) || !(Number.isFinite(factor) && factor > 0)) {
    return {
      ok: false,
      specialRequired: true,
      standardId: defaults.standardId,
      kind,
      barDiaMm: Number.isFinite(barDiaMm) ? barDiaMm : null,
      factor: Number.isFinite(factor) ? factor : null,
      requiredMm: null,
      cantilever: cantilever === true,
      hooked: hooked === true,
    };
  }

  return {
    ok: true,
    specialRequired: false,
    standardId: defaults.standardId,
    kind,
    barDiaMm,
    factor,
    requiredMm: factor * barDiaMm,
    cantilever: cantilever === true,
    hooked: hooked === true,
  };
}

/**
 * 小梁上端筋を大梁内へ折曲げ定着する際の L2 / Lb / B/2 要求だけを解決する。
 *
 * 日建連 §9-1 / §3-2 に従い、全長は L2、投影長さは max(Lb, 支持梁幅B/2)、
 * 折曲げ余長は90°フック既定の8dを保持する。実支持面や折曲げ方向はここでは決めない。
 */
function resolveSmallBeamTopAnchorage({ barDiaMm, supportWidthMm, fc, grade } = {}) {
  const l2 = resolveLengthFactor({ kind: 'l2', fc, grade });
  const lb = resolveLengthFactor({ kind: 'lb', fc, grade });
  const tailFactor = resolveHookTailFactor(90);
  const validBar = Number.isFinite(barDiaMm) && barDiaMm > 0;
  const validSupport = Number.isFinite(supportWidthMm) && supportWidthMm > 0;
  const factorsResolved = l2.ok && lb.ok && Number.isFinite(tailFactor) && tailFactor > 0;

  const l2RequiredMm = validBar && l2.ok ? l2.factor * barDiaMm : null;
  const lbByTableMm = validBar && lb.ok ? lb.factor * barDiaMm : null;
  const minBySupportMm = validSupport ? supportWidthMm / 2 : null;
  const projectionRequiredMm =
    Number.isFinite(lbByTableMm) && Number.isFinite(minBySupportMm)
      ? Math.max(lbByTableMm, minBySupportMm)
      : null;
  const tailRequiredMm = validBar && Number.isFinite(tailFactor) ? tailFactor * barDiaMm : null;

  if (!validBar || !validSupport || !factorsResolved) {
    return {
      ok: false,
      specialRequired: true,
      standardId: defaults.standardId,
      barDiaMm: validBar ? barDiaMm : null,
      supportWidthMm: validSupport ? supportWidthMm : null,
      grade: normalizeGrade(grade),
      fc: Number.isFinite(fc) ? fc : null,
      l2Factor: l2.factor,
      l2RequiredMm,
      lbFactor: lb.factor,
      lbByTableMm,
      minBySupportMm,
      projectionRequiredMm,
      tailFactor: Number.isFinite(tailFactor) ? tailFactor : null,
      tailRequiredMm,
    };
  }

  return {
    ok: true,
    specialRequired: false,
    standardId: defaults.standardId,
    barDiaMm,
    supportWidthMm,
    grade: l2.grade,
    fc,
    l2Factor: l2.factor,
    l2RequiredMm,
    lbFactor: lb.factor,
    lbByTableMm,
    minBySupportMm,
    projectionRequiredMm,
    tailFactor,
    tailRequiredMm,
  };
}

function resolveHookTailFactor(bendAngle) {
  const config = getRebarCommonConfig();
  const overrideByAngle = {
    180: config.bend.hookTailFactor180,
    135: config.bend.hookTailFactor135,
    90: config.bend.hookTailFactor90,
  };
  const override = overrideByAngle[bendAngle];
  if (Number.isFinite(override)) return override;
  return defaults.bend.hookTailDiaFactor[bendAngle] ?? null;
}

function resolveBendInsideDiameterFactor({ grade, barDiaMm, bendAngle }) {
  const normalizedGrade = normalizeGrade(grade);
  if (!normalizedGrade || !Number.isFinite(barDiaMm) || !Number.isFinite(bendAngle)) {
    return { ok: false, specialRequired: true, factor: null };
  }

  const config = getRebarCommonConfig();
  const rules = Array.isArray(config.bend.insideDiameterTable)
    ? config.bend.insideDiameterTable
    : defaults.bend.insideDiameterRules;
  const rule = rules.find((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const minOk = candidate.minDiaMm === undefined || barDiaMm >= candidate.minDiaMm;
    const maxOk = candidate.maxDiaMm === undefined || barDiaMm <= candidate.maxDiaMm;
    return (
      Array.isArray(candidate.grades) &&
      candidate.grades.includes(normalizedGrade) &&
      Array.isArray(candidate.bendAngles) &&
      candidate.bendAngles.includes(bendAngle) &&
      minOk &&
      maxOk &&
      Number.isFinite(candidate.factor)
    );
  });

  if (!rule) return { ok: false, specialRequired: true, factor: null };
  return {
    ok: true,
    specialRequired: false,
    factor: rule.factor,
    standardId: defaults.standardId,
  };
}

function resolveMainBarClearSpacingMm({
  firstDiaMm,
  secondDiaMm = firstDiaMm,
  coarseAggregateMaxMm,
}) {
  const config = getRebarCommonConfig();
  const aggregateMax = Number.isFinite(coarseAggregateMaxMm)
    ? coarseAggregateMaxMm
    : Number.isFinite(config.spacing.coarseAggregateMaxMm)
      ? config.spacing.coarseAggregateMaxMm
      : defaults.spacing.assumedCoarseAggregateMaxMm;
  const aggregateFactor = Number.isFinite(config.spacing.aggregateFactor)
    ? config.spacing.aggregateFactor
    : defaults.spacing.coarseAggregateFactor;
  const nominalFactor = Number.isFinite(config.spacing.adjacentNominalDiaFactor)
    ? config.spacing.adjacentNominalDiaFactor
    : defaults.spacing.adjacentNominalAverageFactor;

  if (
    !Number.isFinite(firstDiaMm) ||
    !Number.isFinite(secondDiaMm) ||
    !Number.isFinite(aggregateMax)
  ) {
    return null;
  }

  const averageNominalDia = (firstDiaMm + secondDiaMm) / 2;
  const standardMinimum = Math.max(
    aggregateFactor * aggregateMax,
    nominalFactor * averageNominalDia,
  );
  const configuredMinimum = Number.isFinite(config.spacing.minimumClearSpacingMm)
    ? config.spacing.minimumClearSpacingMm
    : 0;
  return Math.ceil(Math.max(standardMinimum, configuredMinimum));
}

function resolveSpacingByDesignation(designation) {
  if (typeof designation !== 'string') return null;
  const normalized = designation.toUpperCase().replace(/\s+/g, '');
  const row = defaults.spacing.byDesignation[normalized];
  if (!row) return null;

  const config = getRebarCommonConfig();
  return {
    ...row,
    layer2MinMm: Number.isFinite(config.spacing.secondLayerSpacingMm)
      ? config.spacing.secondLayerSpacingMm
      : row.layer2MinMm,
  };
}

function resolveColumnBeamCover({
  soilContact = false,
  outdoor = false,
  durableFinish = false,
} = {}) {
  const source = soilContact
    ? defaults.cover.columnBeam.soilContact
    : outdoor
      ? defaults.cover.columnBeam.noSoilOutdoor
      : defaults.cover.columnBeam.noSoilIndoor;
  // 表4-1の※1は「土に接しない部分」の屋外値にのみ付く。
  // 土に接する柱・梁（分類i）には耐久性上有効な仕上げによる10mm低減を適用しない。
  const reduction =
    !soilContact && outdoor && durableFinish ? defaults.cover.durableFinishReductionMm : 0;
  const config = getRebarCommonConfig();
  return {
    designMm: Number.isFinite(config.cover.designCoverMm)
      ? config.cover.designCoverMm
      : source.designMm - reduction,
    minimumMm: Number.isFinite(config.cover.minimumCoverMm)
      ? config.cover.minimumCoverMm
      : source.minimumMm - reduction,
    constructionAllowanceMm: config.cover.constructionAllowanceMm,
    category: source.category,
    standardId: defaults.standardId,
  };
}

function resolveColumnProjectionDepthRatio() {
  const configured = getRebarCommonConfig().anchorage.columnProjectionDepthRatio;
  return Number.isFinite(configured) ? configured : defaults.lengths.beamColumnProjectionDepthRatio;
}

function resolveFirstStirrupFromFaceMm() {
  const configured = getRebarCommonConfig().girder.firstStirrupFromFaceMm;
  return Number.isFinite(configured) ? configured : defaults.girder.firstStirrupFromFaceMm;
}

/**
 * 柱仕口部帯筋の解決ルール。
 *
 * 日建連 §7-2 は仕口部範囲を「柱に取り付く全ての梁せいが重なる範囲」とする一方、
 * 帯筋の配筋要領・間隔自体は構造図によるとしている。そのため標準既定値だけでは
 * jointPitchMm を補完しない。共通設定で明示された場合、または project fallback として
 * pw=0.2% / 0.3% が選択された場合に限り生成候補を返す。
 * @returns {Object} 解決済みルール
 */
function resolveColumnJointHoopRule() {
  const source = defaults.column.jointHoop;
  const configured = getRebarCommonConfig().column.hoopPlacementRule;
  const override =
    configured && typeof configured === 'object' && !Array.isArray(configured) ? configured : {};
  const jointPitchMm =
    Number.isFinite(override.jointPitchMm) && override.jointPitchMm > 0
      ? override.jointPitchMm
      : null;
  const fallbackPwRatio = [0.002, 0.003].includes(Number(override.fallbackPwRatio))
    ? Number(override.fallbackPwRatio)
    : null;
  const useGeneralLoopGeometry = override.useGeneralLoopGeometry === true;
  const explicitJointRule = jointPitchMm !== null && useGeneralLoopGeometry;

  return {
    ...source,
    jointPitchMm,
    fallbackPwRatio,
    useGeneralLoopGeometry,
    orthogonalDotTolerance: Number.isFinite(override.orthogonalDotTolerance)
      ? Math.max(0, Math.min(1, override.orthogonalDotTolerance))
      : 0.15,
    specialRequired: !explicitJointRule && fallbackPwRatio === null,
    standardId: defaults.standardId,
  };
}

export const REBAR_STANDARD_RULES = Object.freeze({
  standardId: defaults.standardId,
  defaults,
  normalizeGrade,
  resolveFcBand,
  resolveLengthFactors,
  resolveLengthFactor,
  resolveSmallBeamBottomAnchorage,
  resolveSmallBeamTopAnchorage,
  resolveHookTailFactor,
  resolveBendInsideDiameterFactor,
  resolveMainBarClearSpacingMm,
  resolveSpacingByDesignation,
  resolveColumnBeamCover,
  resolveColumnProjectionDepthRatio,
  resolveFirstStirrupFromFaceMm,
  resolveColumnJointHoopRule,
});
