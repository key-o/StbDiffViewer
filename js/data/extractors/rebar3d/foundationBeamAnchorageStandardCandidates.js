/**
 * @fileoverview 日建連・JSCA 2023標準図 §3-2 から、基礎梁主筋の定着候補値をbar単位で生成する。
 *
 * この層は A1/B1/B2/C1/C2 のどの線形・折曲げ形状を採用するかを決めない。
 * 定着先Fc、普通/軽量区分、鉄筋径・鋼種、基礎柱FDの梁軸方向せいが全て明示された場合だけ、
 * L2 / L2h / La / 90°フック余長8d の候補を返す。
 */

import {
  computeFoundationHookTail90,
  computeFoundationL2,
  computeFoundationL2h,
  computeFoundationLaProjection,
} from './foundationBeamStandardRules2023.js';

function unresolved(reason, extra = {}) {
  return {
    status: 'UNRESOLVED',
    resolved: false,
    blockers: [reason],
    source: 'NIKKENREN-JSCA-RC-REBAR-STANDARD-2023',
    ...extra,
  };
}

function finitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function concreteKindToLightweight(concreteKind) {
  const normalized = typeof concreteKind === 'string' ? concreteKind.trim().toUpperCase() : null;
  if (normalized === 'NORMAL') return { resolved: true, lightweight: false };
  if (normalized === 'LIGHTWEIGHT') return { resolved: true, lightweight: true };
  return { resolved: false, lightweight: null };
}

/**
 * 基礎柱FDへ定着する1本の基礎梁主筋について標準候補値を生成する。
 *
 * @param {Object} bar beamRebarPlacement由来のbar fact
 * @param {Object} context
 * @param {string|number|null} context.supportConcreteStrength 定着先コンクリート強度
 * @param {'NORMAL'|'LIGHTWEIGHT'|null} context.concreteKind
 * @param {number|null} context.columnDepthMm 梁軸方向の基礎柱FDせい
 */
export function resolveFoundationBeamAnchorageStandardCandidates(bar, context = {}) {
  if (!bar) return unresolved('foundation-standard-bar-missing');
  if (bar.diaEstimated === true) {
    return unresolved('foundation-standard-bar-dia-estimated', {
      designation: bar.designation || null,
    });
  }
  if (!finitePositive(bar.diaMm)) {
    return unresolved('foundation-standard-bar-dia-unresolved', {
      designation: bar.designation || null,
    });
  }
  if (typeof bar.grade !== 'string' || !bar.grade.trim()) {
    return unresolved('foundation-standard-bar-grade-unresolved');
  }
  if (
    context.supportConcreteStrength === null ||
    context.supportConcreteStrength === undefined ||
    context.supportConcreteStrength === ''
  ) {
    return unresolved('foundation-standard-support-fc-unresolved');
  }

  const concrete = concreteKindToLightweight(context.concreteKind);
  if (!concrete.resolved) {
    return unresolved('foundation-standard-concrete-kind-unresolved');
  }
  if (!finitePositive(context.columnDepthMm)) {
    return unresolved('foundation-standard-column-depth-unresolved');
  }

  const params = {
    fc: context.supportConcreteStrength,
    grade: bar.grade,
    barDiaMm: bar.diaMm,
    lightweight: concrete.lightweight,
  };
  const l2 = computeFoundationL2(params);
  const l2h = computeFoundationL2h(params);
  const la = computeFoundationLaProjection({ ...params, columnDepthMm: context.columnDepthMm });
  const hookTail90 = computeFoundationHookTail90({ barDiaMm: bar.diaMm });

  const candidates = { l2, l2h, la, hookTail90 };
  for (const [key, result] of Object.entries(candidates)) {
    if (!result?.resolved) {
      return unresolved('foundation-standard-candidate-unresolved', {
        failedCandidate: key,
        candidateBlockers: [...(result?.blockers || [])],
        candidates,
      });
    }
  }

  return {
    status: 'READY',
    resolved: true,
    blockers: [],
    source: 'NIKKENREN-JSCA-RC-REBAR-STANDARD-2023',
    supportConcreteStrength: context.supportConcreteStrength,
    concreteKind: concrete.lightweight ? 'LIGHTWEIGHT' : 'NORMAL',
    barDiaMm: bar.diaMm,
    designation: bar.designation || null,
    grade: bar.grade,
    columnDepthMm: context.columnDepthMm,
    candidates,
  };
}

/**
 * endpoint factの全主筋について標準候補を生成する。
 * 1本でも未解決ならendpoint全体をUNRESOLVEDにするが、各barの結果は保持する。
 */
export function resolveFoundationBeamEndpointAnchorageStandardCandidates(endpoint = {}) {
  const bars = Array.isArray(endpoint.mainBars)
    ? endpoint.mainBars
    : Array.isArray(endpoint.bars)
      ? endpoint.bars
      : [];
  if (!bars.length) return unresolved('foundation-standard-endpoint-bars-missing', { bars: [] });

  const columnDepthMm =
    endpoint.supportGeometry?.projectionMm ??
    endpoint.geometry?.projectionMm ??
    endpoint.availableProjectionMm ??
    null;
  const supportConcreteStrength = endpoint.supportConcreteStrength ?? null;
  const concreteKind = endpoint.concreteKind ?? null;
  const results = bars.map((bar) =>
    resolveFoundationBeamAnchorageStandardCandidates(bar, {
      supportConcreteStrength,
      concreteKind,
      columnDepthMm,
    }),
  );
  const unresolvedResults = results.filter((result) => !result.resolved);
  if (unresolvedResults.length) {
    return unresolved('foundation-standard-endpoint-candidates-unresolved', {
      bars: results,
      unresolvedCount: unresolvedResults.length,
    });
  }
  return {
    status: 'READY',
    resolved: true,
    blockers: [],
    source: 'NIKKENREN-JSCA-RC-REBAR-STANDARD-2023',
    bars: results,
  };
}

export const _foundationBeamAnchorageStandardCandidatesInternals = Object.freeze({
  concreteKindToLightweight,
  finitePositive,
});
