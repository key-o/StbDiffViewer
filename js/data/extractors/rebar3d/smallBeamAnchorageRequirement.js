/**
 * @fileoverview R12 小梁定着の適用範囲を geometry 非依存で解決する strategy。
 *
 * 標準値の数値解決は REBAR_STANDARD_RULES に委譲し、この層では日建連 §9 の
 * 「小梁を大梁へ定着する」適用範囲だけを判定する。片持ち小梁上端筋は §3-2 の
 * Lb 対象外なので、一般小梁用 resolver へ流さず fail-closed にする。
 */

import { REBAR_STANDARD_RULES } from '../../../constants/rebarStandardRules.js';

const STANDARD_SOURCE = 'NIKKENREN-JSCA-2023-9';

function specialRequirement(kind, reason, input = {}) {
  return {
    ok: false,
    specialRequired: true,
    kind,
    reason,
    standardId: REBAR_STANDARD_RULES.standardId,
    source: STANDARD_SOURCE,
    ...input,
  };
}

/**
 * 小梁上端筋の大梁内折曲げ定着 requirement を解決する。
 *
 * 一般小梁かつ大梁支持の場合だけ L2 / Lb / B/2 resolver を適用する。
 * 片持ち小梁上端筋、柱支持、小梁支持、未解決支持はこの標準経路へ流さない。
 */
export function resolveSmallBeamTopAnchorageRequirement({
  cantilever = false,
  supportType,
  barDiaMm,
  supportWidthMm,
  fc,
  grade,
} = {}) {
  if (cantilever === true) {
    return specialRequirement('TOP', 'cantilever-top-lb-not-applicable', {
      cantilever: true,
      supportType: supportType || null,
    });
  }

  if (supportType !== 'GIRDER') {
    return specialRequirement('TOP', `unsupported-top-support:${supportType || 'UNKNOWN'}`, {
      cantilever: false,
      supportType: supportType || null,
    });
  }

  const resolved = REBAR_STANDARD_RULES.resolveSmallBeamTopAnchorage({
    barDiaMm,
    supportWidthMm,
    fc,
    grade,
  });
  return {
    ...resolved,
    kind: 'TOP',
    reason: resolved.ok ? null : 'top-anchorage-length-unresolved',
    cantilever: false,
    supportType,
    source: STANDARD_SOURCE,
  };
}

/**
 * 小梁下端筋の L3 / L3h requirement を解決する。
 *
 * §9の通常経路として大梁支持だけを自動適用し、その他の支持関係は fail-closed とする。
 */
export function resolveSmallBeamBottomAnchorageRequirement({
  cantilever = false,
  supportType,
  hooked = false,
  barDiaMm,
} = {}) {
  if (supportType !== 'GIRDER') {
    return specialRequirement('BOTTOM', `unsupported-bottom-support:${supportType || 'UNKNOWN'}`, {
      cantilever: cantilever === true,
      hooked: hooked === true,
      supportType: supportType || null,
    });
  }

  const resolved = REBAR_STANDARD_RULES.resolveSmallBeamBottomAnchorage({
    barDiaMm,
    cantilever,
    hooked,
  });
  return {
    ...resolved,
    kind: 'BOTTOM',
    lengthKind: resolved.kind,
    reason: resolved.ok ? null : 'bottom-anchorage-length-unresolved',
    supportType,
    source: STANDARD_SOURCE,
  };
}
