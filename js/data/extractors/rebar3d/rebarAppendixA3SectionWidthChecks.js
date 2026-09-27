/**
 * @fileoverview 配筋指針2010 付録A A3の section-level 幅チェック収集。
 *
 * STB断面抽出結果から、付表A3-2で直接評価できる単一径・単一段の主筋列を取り出し、
 * rebarAppendixA3WidthValidatorへ渡す。混在径・表外本数・環境条件未解決は推定しない。
 */

import { getRebarCommonConfig } from '../../../config/rebarCommonConfig.js';
import { barDiameterMm } from '../../../constants/beamOpeningRules.js';
import { APPENDIX_A3_SOURCE } from '../../../constants/rebarAppendixA3MinimumWidthTables.js';
import { REBAR_STANDARD_RULES } from '../../../constants/rebarStandardRules.js';
import { extractRcColumnSections } from '../columnSectionListExtractor.js';
import { extractRcBeamSectionDetail } from '../beamSectionList/sectionDetail.js';
import { querySelectorAll } from '../sectionListUtils.js';
import { rebarRuleTraceMetadata } from './rebarDetailingRuleRegistry.js';
import { isGirderSection } from './rebarSectionUtils.js';
import {
  AppendixA3Exposure,
  validateAppendixA3MinimumWidth,
} from './rebarAppendixA3WidthValidator.js';

const A3_WIDTH_RULE = rebarRuleTraceMetadata('APPENDIX-A3-MINIMUM-SECTION-WIDTH-GUIDE');
const A3_NO_INTERPOLATION_RULE = rebarRuleTraceMetadata('APPENDIX-A3-NO-INTERPOLATION');

function positiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeDia(value) {
  const normalized = String(value || '')
    .trim()
    .toUpperCase();
  return normalized || null;
}

function resolveCalculationInputs(options, context, transverseBarDia, transverseBarGrade) {
  const config = options?.commonConfig || getRebarCommonConfig();
  const coarseAggregateMaxMm = Number.isFinite(options?.coarseAggregateMaxMm)
    ? options.coarseAggregateMaxMm
    : config.spacing?.coarseAggregateMaxMm;

  let transverseBendInsideDiameterFactor = null;
  if (typeof options?.transverseBendInsideDiameterFactorResolver === 'function') {
    const resolved = options.transverseBendInsideDiameterFactorResolver({
      ...context,
      transverseBarDia,
      transverseBarGrade,
    });
    if (Number.isFinite(resolved)) transverseBendInsideDiameterFactor = resolved;
  } else if (transverseBarDia && transverseBarGrade) {
    const barDiaMm = barDiameterMm(transverseBarDia, NaN);
    const resolved = REBAR_STANDARD_RULES.resolveBendInsideDiameterFactor({
      grade: transverseBarGrade,
      barDiaMm,
      bendAngle: 135,
    });
    if (resolved.ok && Number.isFinite(resolved.factor)) {
      transverseBendInsideDiameterFactor = resolved.factor;
    }
  }

  let lapSpliceConcentratedCount = null;
  if (typeof options?.lapSpliceConcentratedCountResolver === 'function') {
    const resolved = options.lapSpliceConcentratedCountResolver(context);
    if (Number.isInteger(resolved) && resolved >= 0) {
      lapSpliceConcentratedCount = resolved;
    }
  }

  return {
    coarseAggregateMaxMm,
    transverseBendInsideDiameterFactor,
    lapSpliceConcentratedCount,
  };
}

function defaultExposure() {
  return {
    left: AppendixA3Exposure.STANDARD,
    right: AppendixA3Exposure.STANDARD,
  };
}

function resolveExposure(options, context) {
  const resolver = options?.exposureResolver;
  if (typeof resolver !== 'function') {
    return { value: defaultExposure(), assumed: true, source: 'standard-non-soil-base' };
  }
  const value = resolver(context);
  if (!value) {
    return { value: defaultExposure(), assumed: true, source: 'standard-non-soil-base' };
  }
  return { value, assumed: false, source: 'project-resolver' };
}

function resolveCover(options, context, fallback = null) {
  const resolver = options?.coverResolver;
  if (typeof resolver === 'function') {
    const value = resolver(context);
    if (value) return { value, assumed: false, source: 'project-resolver' };
  }
  if (fallback?.leftMm || fallback?.rightMm) {
    return { value: fallback, assumed: false, source: 'stb-source-cover' };
  }
  return { value: {}, assumed: true, source: 'appendix-a3-table-basis' };
}

function resultCheckBase(kind, context, validation, exposure, cover) {
  return {
    kind: 'APPENDIX_A3_MINIMUM_WIDTH',
    targetKind: kind,
    source: validation.source || null,
    sectionId: context.sectionId || null,
    sectionName: context.sectionName || null,
    position: context.position || null,
    axis: context.axis || null,
    side: context.side || null,
    layer: context.layer ?? null,
    memberCategory: context.memberCategory || kind,
    providedWidthMm: context.providedWidthMm ?? null,
    mainBarDia: context.mainBarDia || null,
    mainBarCount: context.mainBarCount ?? null,
    transverseBarDia: context.transverseBarDia || null,
    transverseBarGrade: context.transverseBarGrade || null,
    exposure: exposure.value,
    exposureAssumed: exposure.assumed,
    exposureSource: exposure.source,
    cover: cover.value,
    coverAssumed: cover.assumed,
    coverSource: cover.source,
    status: validation.status,
    ok: validation.ok,
    reason: validation.reason || null,
    requiredWidthRangeMm: validation.requiredWidthRangeMm || null,
    candidates: validation.candidates || [],
    warnings: validation.warnings || [],
    calculationConditions: validation.calculationConditions || null,
    appliedRules: validation.appliedRules || [A3_WIDTH_RULE],
  };
}

function applySectionCalculationGates(validation, calculationInputs) {
  const aggregate = Number(calculationInputs?.coarseAggregateMaxMm);
  const limit = APPENDIX_A3_SOURCE.calculationConditions.maxCoarseAggregateMm;
  if (!(aggregate > limit)) return validation;

  return {
    ...validation,
    ok: false,
    status: 'UNRESOLVED',
    reason: `appendix-a3-aggregate-over-${limit}-section-collector-gate:${aggregate}`,
    requiredWidthRangeMm: null,
    candidates: [],
    warnings: [],
  };
}

function unresolvedCheck(kind, context, reason, exposure = null, cover = null) {
  return {
    kind: 'APPENDIX_A3_MINIMUM_WIDTH',
    targetKind: kind,
    sectionId: context.sectionId || null,
    sectionName: context.sectionName || null,
    position: context.position || null,
    axis: context.axis || null,
    side: context.side || null,
    layer: context.layer ?? null,
    memberCategory: context.memberCategory || kind,
    providedWidthMm: context.providedWidthMm ?? null,
    mainBarDia: context.mainBarDia || null,
    mainBarCount: context.mainBarCount ?? null,
    transverseBarDia: context.transverseBarDia || null,
    transverseBarGrade: context.transverseBarGrade || null,
    exposure: exposure?.value || null,
    exposureAssumed: exposure?.assumed ?? true,
    exposureSource: exposure?.source || null,
    cover: cover?.value || null,
    coverAssumed: cover?.assumed ?? true,
    coverSource: cover?.source || null,
    status: 'UNRESOLVED',
    ok: false,
    reason,
    requiredWidthRangeMm: null,
    candidates: [],
    warnings: [],
    appliedRules: [A3_WIDTH_RULE, A3_NO_INTERPOLATION_RULE],
  };
}

function groupBeamLayers(bar) {
  if (!bar) return [];
  const grouped = new Map();
  const layers = Array.isArray(bar.layers) ? bar.layers : [];

  for (const layer of layers) {
    const step = positiveInteger(layer?.step) || 1;
    const entry = grouped.get(step) || { step, groups: [] };
    const sourceGroups =
      Array.isArray(layer?.barGroups) && layer.barGroups.length > 0 ? layer.barGroups : [layer];
    for (const group of sourceGroups) {
      const count = positiveInteger(group?.count);
      if (count <= 0) continue;
      entry.groups.push({
        count,
        dia: normalizeDia(group?.dia || layer?.dia || bar?.dia),
      });
    }
    grouped.set(step, entry);
  }

  if (grouped.size === 0) {
    const count1st = positiveInteger(bar.count1st) || positiveInteger(bar.count);
    if (count1st > 0) {
      grouped.set(1, {
        step: 1,
        groups: [{ count: count1st, dia: normalizeDia(bar.dia) }],
      });
    }
  }

  return [...grouped.values()].sort((a, b) => a.step - b.step);
}

function summarizeUniformGroups(groups, countKey = 'count') {
  const active = (groups || []).filter((group) => positiveInteger(group?.[countKey]) > 0);
  const count = active.reduce((sum, group) => sum + positiveInteger(group[countKey]), 0);
  const dias = [...new Set(active.map((group) => normalizeDia(group.dia)).filter(Boolean))];
  return {
    count,
    dia: dias.length === 1 ? dias[0] : null,
    mixedDiameter: dias.length > 1,
    missingDiameter: count > 0 && dias.length === 0,
  };
}

function collectBeamSideChecks(sectionDetail, positionKey, position, side, options, choice) {
  const bar = side === 'TOP' ? position?.topBar : position?.bottomBar;
  if (!bar) return [];
  const layers = groupBeamLayers(bar);
  const checks = [];

  for (const layer of layers) {
    const summary = summarizeUniformGroups(layer.groups);
    const context = {
      sectionId: sectionDetail.id,
      sectionName: sectionDetail.name,
      memberCategory: options.memberCategory || 'BEAM',
      position: positionKey,
      side,
      layer: layer.step,
      providedWidthMm: Number(position?.width) || null,
      mainBarDia: summary.dia,
      mainBarCount: summary.count,
      transverseBarDia: normalizeDia(position?.stirrup?.dia),
      transverseBarGrade: position?.stirrup?.grade || null,
    };
    const exposure = resolveExposure(options, { ...context, memberType: 'BEAM' });
    const calculationInputs = resolveCalculationInputs(
      options,
      { ...context, memberType: 'BEAM' },
      context.transverseBarDia,
      context.transverseBarGrade,
    );
    const sourceCover = position?.cover?.sourceCover || sectionDetail?.cover?.sourceCover;
    const cover = resolveCover(
      options,
      { ...context, memberType: 'BEAM' },
      {
        leftMm: sourceCover?.left ?? null,
        rightMm: sourceCover?.right ?? null,
      },
    );

    if (!(context.providedWidthMm > 0)) {
      checks.push(
        unresolvedCheck('BEAM', context, 'appendix-a3-beam-width-missing', exposure, cover),
      );
      continue;
    }
    if (!context.transverseBarDia) {
      checks.push(
        unresolvedCheck('BEAM', context, 'appendix-a3-stirrup-dia-missing', exposure, cover),
      );
      continue;
    }
    if (summary.mixedDiameter) {
      checks.push(
        unresolvedCheck(
          'BEAM',
          context,
          'appendix-a3-mixed-main-diameter-not-tabulated',
          exposure,
          cover,
        ),
      );
      continue;
    }
    if (summary.missingDiameter || !summary.dia) {
      checks.push(
        unresolvedCheck('BEAM', context, 'appendix-a3-main-dia-missing', exposure, cover),
      );
      continue;
    }

    const validation = applySectionCalculationGates(
      validateAppendixA3MinimumWidth({
        choice,
        memberType: 'BEAM',
        mainBarDia: summary.dia,
        transverseBarDia: context.transverseBarDia,
        mainBarCount: summary.count,
        providedWidthMm: context.providedWidthMm,
        exposure: exposure.value,
        cover: cover.value,
        ...calculationInputs,
      }),
      calculationInputs,
    );
    checks.push(resultCheckBase('BEAM', context, validation, exposure, cover));
  }

  return checks;
}

export function collectAppendixA3BeamDetailChecks(sectionDetail, options = {}) {
  const commonConfig = options.commonConfig || getRebarCommonConfig();
  const choice = options.choice ?? commonConfig.detailing?.choice;
  const resolvedOptions = { ...options, commonConfig };
  const checks = [];
  for (const [positionKey, position] of Object.entries(sectionDetail?.positions || {})) {
    checks.push(
      ...collectBeamSideChecks(
        sectionDetail,
        positionKey,
        position,
        'TOP',
        resolvedOptions,
        choice,
      ),
      ...collectBeamSideChecks(
        sectionDetail,
        positionKey,
        position,
        'BOTTOM',
        resolvedOptions,
        choice,
      ),
    );
  }
  return checks;
}

function columnArrangements(sectionDetail) {
  if (Array.isArray(sectionDetail?.arrangements) && sectionDetail.arrangements.length > 0) {
    return sectionDetail.arrangements;
  }
  if (!sectionDetail?.mainBar) return [];
  return [
    {
      position: 'SAME',
      mainBar: sectionDetail.mainBar,
      hoop: sectionDetail.hoop,
    },
  ];
}

function columnLayerGroups(mainBar) {
  const layers = Array.isArray(mainBar?.layers) ? mainBar.layers : [];
  if (layers.length > 0) return layers;

  if (positiveInteger(mainBar?.countX) > 0 || positiveInteger(mainBar?.countY) > 0) {
    return [
      {
        step: 1,
        groups: [
          {
            countX: positiveInteger(mainBar.countX),
            countY: positiveInteger(mainBar.countY),
            dia: normalizeDia(mainBar.dia),
          },
        ],
      },
    ];
  }
  return [];
}

function resolveColumnAxisLayer(mainBar, layer, axis) {
  const countKey = axis === 'X' ? 'countY' : 'countX';
  const groups = Array.isArray(layer?.groups) ? layer.groups : [];
  const summary = summarizeUniformGroups(groups, countKey);
  if (summary.count <= 0) return { ...summary, skip: true };
  if (summary.mixedDiameter) return summary;

  if (
    Number(layer?.step || 1) === 1 &&
    normalizeDia(mainBar?.diaSub) &&
    normalizeDia(mainBar.diaSub) !== normalizeDia(mainBar.dia)
  ) {
    const primaryAxis = String(mainBar?.mainDirection || 'X').toUpperCase() === 'Y' ? 'Y' : 'X';
    if (axis !== primaryAxis && summary.count > 2) {
      return {
        ...summary,
        dia: null,
        mixedDiameter: true,
        reason: 'appendix-a3-column-primary-sub-diameter-mixed-on-face',
      };
    }
    return {
      ...summary,
      dia: normalizeDia(mainBar.dia),
      mixedDiameter: false,
      missingDiameter: false,
    };
  }

  return summary;
}

function collectColumnArrangementChecks(sectionDetail, arrangement, options, choice) {
  const dimensions = sectionDetail?.dimensions;
  if (dimensions?.type !== 'RECTANGLE') return [];
  const mainBar = arrangement?.mainBar;
  const hoopDia = normalizeDia(arrangement?.hoop?.dia);
  const layers = columnLayerGroups(mainBar);
  const checks = [];

  for (const layer of layers) {
    for (const axis of ['X', 'Y']) {
      const summary = resolveColumnAxisLayer(mainBar, layer, axis);
      if (summary.skip) continue;
      const providedWidthMm =
        axis === 'X' ? Number(dimensions.width) || null : Number(dimensions.height) || null;
      const context = {
        sectionId: sectionDetail.id,
        sectionName: sectionDetail.name,
        memberCategory: 'COLUMN',
        position: arrangement?.position || 'SAME',
        axis,
        layer: Number(layer?.step) || 1,
        providedWidthMm,
        mainBarDia: summary.dia,
        mainBarCount: summary.count,
        transverseBarDia: hoopDia,
        transverseBarGrade: arrangement?.hoop?.grade || null,
      };
      const exposure = resolveExposure(options, { ...context, memberType: 'COLUMN' });
      const calculationInputs = resolveCalculationInputs(
        options,
        { ...context, memberType: 'COLUMN' },
        hoopDia,
        context.transverseBarGrade,
      );
      const faceCover =
        axis === 'X'
          ? {
              leftMm: arrangement?.coverFaces?.startX ?? null,
              rightMm: arrangement?.coverFaces?.endX ?? null,
            }
          : {
              leftMm: arrangement?.coverFaces?.startY ?? null,
              rightMm: arrangement?.coverFaces?.endY ?? null,
            };
      const cover = resolveCover(options, { ...context, memberType: 'COLUMN' }, faceCover);

      if (!(providedWidthMm > 0)) {
        checks.push(
          unresolvedCheck('COLUMN', context, 'appendix-a3-column-width-missing', exposure, cover),
        );
        continue;
      }
      if (!hoopDia) {
        checks.push(
          unresolvedCheck('COLUMN', context, 'appendix-a3-hoop-dia-missing', exposure, cover),
        );
        continue;
      }
      if (summary.mixedDiameter) {
        checks.push(
          unresolvedCheck(
            'COLUMN',
            context,
            summary.reason || 'appendix-a3-mixed-main-diameter-not-tabulated',
            exposure,
            cover,
          ),
        );
        continue;
      }
      if (summary.missingDiameter || !summary.dia) {
        checks.push(
          unresolvedCheck('COLUMN', context, 'appendix-a3-main-dia-missing', exposure, cover),
        );
        continue;
      }

      const validation = applySectionCalculationGates(
        validateAppendixA3MinimumWidth({
          choice,
          memberType: 'COLUMN',
          mainBarDia: summary.dia,
          transverseBarDia: hoopDia,
          mainBarCount: summary.count,
          providedWidthMm,
          exposure: exposure.value,
          cover: cover.value,
          ...calculationInputs,
        }),
        calculationInputs,
      );
      checks.push(resultCheckBase('COLUMN', context, validation, exposure, cover));
    }
  }

  return checks;
}

export function collectAppendixA3ColumnDetailChecks(sectionDetail, options = {}) {
  const commonConfig = options.commonConfig || getRebarCommonConfig();
  const choice = options.choice ?? commonConfig.detailing?.choice;
  const resolvedOptions = { ...options, commonConfig };
  return columnArrangements(sectionDetail).flatMap((arrangement) =>
    collectColumnArrangementChecks(sectionDetail, arrangement, resolvedOptions, choice),
  );
}

export function collectRebarAppendixA3WidthChecks(xmlDoc, options = {}) {
  if (!xmlDoc) return [];
  const checks = [];

  for (const [, sectionDetail] of extractRcColumnSections(xmlDoc)) {
    checks.push(...collectAppendixA3ColumnDetailChecks(sectionDetail, options));
  }

  for (const tagName of ['StbSecGirder_RC', 'StbSecBeam_RC']) {
    for (const element of querySelectorAll(xmlDoc, tagName)) {
      const sectionDetail = extractRcBeamSectionDetail(element);
      if (!sectionDetail?.id) continue;
      checks.push(
        ...collectAppendixA3BeamDetailChecks(sectionDetail, {
          ...options,
          memberCategory: isGirderSection(element) ? 'GIRDER' : 'BEAM',
        }),
      );
    }
  }

  return checks;
}
