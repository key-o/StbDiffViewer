/**
 * @fileoverview R12 小梁定着の適用範囲を geometry 非依存で解決する strategy。
 *
 * 標準値の数値解決は REBAR_STANDARD_RULES に委譲し、この層では日建連 §9 の
 * 「小梁を大梁へ定着する」適用範囲だけを判定する。一般小梁上端筋は L2 / Lb / B/2、
 * 片持ち小梁上端筋は §9-3(3) の L2 / La / 3B/4 を別 resolver へ流す。
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
 * 一般小梁は L2 / Lb / B/2、片持ち小梁は L2 / La / 3B/4 を使用する。
 * 柱支持、小梁支持、未解決支持はどちらの標準経路にも流さない。
 */
export function resolveSmallBeamTopAnchorageRequirement({
  cantilever = false,
  supportType,
  barDiaMm,
  supportWidthMm,
  fc,
  grade,
} = {}) {
  if (supportType !== 'GIRDER') {
    const reason =
      cantilever === true && supportType === 'BEAM'
        ? 'cantilever-tip-beam-figure-9-4'
        : `unsupported-top-support:${supportType || 'UNKNOWN'}`;
    return specialRequirement('TOP', reason, {
      cantilever: cantilever === true,
      supportType: supportType || null,
      sourceFigure: reason === 'cantilever-tip-beam-figure-9-4' ? '9-4' : null,
    });
  }

  const resolved =
    cantilever === true
      ? REBAR_STANDARD_RULES.resolveSmallBeamCantileverTopAnchorage({
          barDiaMm,
          supportWidthMm,
          fc,
          grade,
        })
      : REBAR_STANDARD_RULES.resolveSmallBeamTopAnchorage({
          barDiaMm,
          supportWidthMm,
          fc,
          grade,
        });
  return {
    ...resolved,
    kind: 'TOP',
    reason: resolved.ok
      ? null
      : cantilever === true
        ? 'cantilever-top-anchorage-length-unresolved'
        : 'top-anchorage-length-unresolved',
    cantilever: cantilever === true,
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
    const reason =
      cantilever === true && supportType === 'BEAM'
        ? 'cantilever-tip-beam-figure-9-4'
        : `unsupported-bottom-support:${supportType || 'UNKNOWN'}`;
    return specialRequirement('BOTTOM', reason, {
      cantilever: cantilever === true,
      hooked: hooked === true,
      supportType: supportType || null,
      sourceFigure: reason === 'cantilever-tip-beam-figure-9-4' ? '9-4' : null,
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
