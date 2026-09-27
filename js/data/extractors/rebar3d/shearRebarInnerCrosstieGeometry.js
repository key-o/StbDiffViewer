/**
 * @fileoverview R11 中子筋専用の135°両端フック形状契約。
 *
 * 中子筋は外周HOOP/STPとは別shapeとして扱う。1本の直筋に両端135°フックを設け、
 * 2つのフックは同じ拘束対象主筋側へ向ける。generic open-tie builderが返す左右variant
 * のうち指定sideだけを採用し、材軸方向のalternateを禁止する。
 *
 * 端部Arcはcover envelopeではなく、placementで解決済みの拘束対象主筋中心・径を正本とする。
 * 中子筋直線部を主筋外周へ接する位置に保ち、135°Arcの主脚側接点を主筋中心と同じ軸位置へ
 * 固定する。拘束対象主筋factが無い、または径・離隔が矛盾する場合は推定せずfail-closedとする。
 */

import { resolveHookBendGeometry } from './rebarHookGeometry.js';
import { buildHookedOpenTiePath } from './shearRebarPathGeometry.js';

const INNER_CROSSTIE_HOOK_ANGLE_DEG = 135;
const POSITION_TOLERANCE_MM = 1e-5;
const EPS = 1e-7;

function failure(reason, extra = {}) {
  return {
    ok: false,
    specialRequired: true,
    reason,
    ...extra,
    path: null,
    paths: [],
  };
}

function normalizeRestrainedBar(bar) {
  const u = Number(bar?.u);
  const v = Number(bar?.v);
  const dia = Number(bar?.dia);
  if (![u, v, dia].every(Number.isFinite) || !(dia > 0)) return null;
  return { u, v, dia };
}

function signWithTolerance(value) {
  if (!Number.isFinite(value) || Math.abs(value) <= POSITION_TOLERANCE_MM) return 0;
  return value > 0 ? 1 : -1;
}

function validateClearance(actualMm, requiredMm) {
  return Math.abs(Number(actualMm) - Number(requiredMm)) <= POSITION_TOLERANCE_MM;
}

/**
 * 両端の拘束対象主筋から、generic open-tie builderへ渡すsharp cornerを解く。
 * generic builderの135°filletでは主脚側接点がcornerからtangentDistanceだけ内側に来るため、
 * cornerを主筋中心軸位置から外側へ戻しておく。
 */
function alignTieTerminalCornersToRestrainedBars(tie, rule, hookSideSign) {
  if (tie?.type !== 'LINE') return failure('inner-crosstie-restrained-main-bar-unresolved');
  const startBar = normalizeRestrainedBar(tie.restrainedStartBar);
  const endBar = normalizeRestrainedBar(tie.restrainedEndBar);
  if (!startBar || !endBar) {
    return failure('inner-crosstie-restrained-main-bar-unresolved', {
      restrainedStartBar: tie?.restrainedStartBar || null,
      restrainedEndBar: tie?.restrainedEndBar || null,
    });
  }

  const tieDiaMm = Number(rule?.barDiaMm);
  const radiusMm = Number(rule?.centerlineRadiusMm);
  if (!(tieDiaMm > 0) || !(radiusMm > 0)) {
    return failure('inner-crosstie-restrained-main-bar-invalid-rule');
  }

  const requiredStartClearanceMm = (startBar.dia + tieDiaMm) / 2;
  const requiredEndClearanceMm = (endBar.dia + tieDiaMm) / 2;
  const requiredMaxClearanceMm = Math.max(requiredStartClearanceMm, requiredEndClearanceMm);
  if (radiusMm + POSITION_TOLERANCE_MM < requiredMaxClearanceMm) {
    return failure('inner-crosstie-bend-radius-insufficient-for-main-bar-clearance', {
      centerlineRadiusMm: radiusMm,
      requiredStartClearanceMm,
      requiredEndClearanceMm,
    });
  }

  const angleRad = (INNER_CROSSTIE_HOOK_ANGLE_DEG * Math.PI) / 180;
  const tangentDistanceMm = radiusMm * Math.tan(angleRad / 2);
  if (!(tangentDistanceMm > EPS) || !Number.isFinite(tangentDistanceMm)) {
    return failure('inner-crosstie-restrained-main-bar-invalid-tangent-distance');
  }

  if (tie.axis === 'v') {
    const tieU = Number(tie.u);
    const tieStart = Number(tie.vMin);
    const tieEnd = Number(tie.vMax);
    if (![tieU, tieStart, tieEnd].every(Number.isFinite) || !(tieEnd > tieStart)) {
      return failure('inner-crosstie-restrained-main-bar-invalid-tie');
    }
    const startDelta = startBar.u - tieU;
    const endDelta = endBar.u - tieU;
    const startSide = signWithTolerance(startDelta);
    const endSide = signWithTolerance(endDelta);
    if (startSide !== hookSideSign || endSide !== hookSideSign) {
      return failure('inner-crosstie-restrained-main-bar-side-mismatch', {
        hookSideSign,
        startSide,
        endSide,
      });
    }
    if (
      !validateClearance(Math.abs(startDelta), requiredStartClearanceMm) ||
      !validateClearance(Math.abs(endDelta), requiredEndClearanceMm)
    ) {
      return failure('inner-crosstie-restrained-main-bar-clearance-mismatch', {
        startClearanceMm: Math.abs(startDelta),
        endClearanceMm: Math.abs(endDelta),
        requiredStartClearanceMm,
        requiredEndClearanceMm,
      });
    }
    if (
      Math.abs(tieStart - startBar.v) > POSITION_TOLERANCE_MM ||
      Math.abs(tieEnd - endBar.v) > POSITION_TOLERANCE_MM ||
      !(endBar.v > startBar.v)
    ) {
      return failure('inner-crosstie-restrained-main-bar-span-mismatch');
    }
    return {
      ok: true,
      tie: {
        ...tie,
        vMin: startBar.v - tangentDistanceMm,
        vMax: endBar.v + tangentDistanceMm,
      },
      startBar,
      endBar,
      startAxisMm: startBar.v,
      endAxisMm: endBar.v,
      tangentDistanceMm,
      startClearanceMm: Math.abs(startDelta),
      endClearanceMm: Math.abs(endDelta),
      requiredStartClearanceMm,
      requiredEndClearanceMm,
    };
  }

  if (tie.axis === 'u') {
    const tieV = Number(tie.v);
    const tieStart = Number(tie.uMin);
    const tieEnd = Number(tie.uMax);
    if (![tieV, tieStart, tieEnd].every(Number.isFinite) || !(tieEnd > tieStart)) {
      return failure('inner-crosstie-restrained-main-bar-invalid-tie');
    }
    const startDelta = startBar.v - tieV;
    const endDelta = endBar.v - tieV;
    const startSide = signWithTolerance(startDelta);
    const endSide = signWithTolerance(endDelta);
    if (startSide !== hookSideSign || endSide !== hookSideSign) {
      return failure('inner-crosstie-restrained-main-bar-side-mismatch', {
        hookSideSign,
        startSide,
        endSide,
      });
    }
    if (
      !validateClearance(Math.abs(startDelta), requiredStartClearanceMm) ||
      !validateClearance(Math.abs(endDelta), requiredEndClearanceMm)
    ) {
      return failure('inner-crosstie-restrained-main-bar-clearance-mismatch', {
        startClearanceMm: Math.abs(startDelta),
        endClearanceMm: Math.abs(endDelta),
        requiredStartClearanceMm,
        requiredEndClearanceMm,
      });
    }
    if (
      Math.abs(tieStart - startBar.u) > POSITION_TOLERANCE_MM ||
      Math.abs(tieEnd - endBar.u) > POSITION_TOLERANCE_MM ||
      !(endBar.u > startBar.u)
    ) {
      return failure('inner-crosstie-restrained-main-bar-span-mismatch');
    }
    return {
      ok: true,
      tie: {
        ...tie,
        uMin: startBar.u - tangentDistanceMm,
        uMax: endBar.u + tangentDistanceMm,
      },
      startBar,
      endBar,
      startAxisMm: startBar.u,
      endAxisMm: endBar.u,
      tangentDistanceMm,
      startClearanceMm: Math.abs(startDelta),
      endClearanceMm: Math.abs(endDelta),
      requiredStartClearanceMm,
      requiredEndClearanceMm,
    };
  }

  return failure('inner-crosstie-restrained-main-bar-axis-unresolved');
}

/**
 * 中子筋: 直筋 + 両端135°フック、両フックは同一の拘束対象主筋側。
 * Arcの主脚側接点は restrainedStartBar / restrainedEndBar の中心軸位置へ固定する。
 */
export function buildInnerCrosstie135Path({
  tie,
  grade,
  barDiaMm = tie?.dia,
  hookSideSign,
  tailLengthMm = null,
  metadata = {},
} = {}) {
  const sideSign = Number(hookSideSign);
  if (![1, -1].includes(sideSign)) {
    return failure('inner-crosstie-hook-side-unresolved', { hookSideSign });
  }

  const hookRule = resolveHookBendGeometry({
    grade,
    barDiaMm,
    bendAngleDeg: INNER_CROSSTIE_HOOK_ANGLE_DEG,
    tailLengthMm,
  });
  if (!hookRule.ok) return { ...hookRule, path: null, paths: [] };

  const aligned = alignTieTerminalCornersToRestrainedBars(tie, hookRule, sideSign);
  if (!aligned.ok) return aligned;

  const result = buildHookedOpenTiePath({
    tie: aligned.tie,
    grade,
    barDiaMm,
    hookAngleDeg: INNER_CROSSTIE_HOOK_ANGLE_DEG,
    tailLengthMm,
    allowConditional90: false,
    metadata: {
      ...metadata,
      shapeContract: 'INNER_CROSSTIE_135',
      hookEndsSameSide: true,
      terminalMainBarAligned: true,
      restrainedStartBar: aligned.startBar,
      restrainedEndBar: aligned.endBar,
      terminalMainBarStartAxisMm: aligned.startAxisMm,
      terminalMainBarEndAxisMm: aligned.endAxisMm,
      terminalMainBarClearanceStartMm: aligned.startClearanceMm,
      terminalMainBarClearanceEndMm: aligned.endClearanceMm,
      terminalMainBarRequiredClearanceStartMm: aligned.requiredStartClearanceMm,
      terminalMainBarRequiredClearanceEndMm: aligned.requiredEndClearanceMm,
      terminalTangentDistanceMm: aligned.tangentDistanceMm,
    },
  });
  if (!result.ok) return result;

  const selected = (result.paths || []).find(
    (path) => Number(path?.metadata?.hookSideSign) === sideSign,
  );
  if (!selected) {
    return failure('inner-crosstie-hook-side-variant-unresolved', { hookSideSign: sideSign });
  }

  if (
    selected?.metadata?.hookAngleDeg !== INNER_CROSSTIE_HOOK_ANGLE_DEG ||
    selected?.metadata?.hookEndsSameSide !== true ||
    selected?.metadata?.shapeContract !== 'INNER_CROSSTIE_135' ||
    selected?.metadata?.terminalMainBarAligned !== true
  ) {
    return failure('inner-crosstie-shape-contract-mismatch');
  }

  return {
    ok: true,
    specialRequired: false,
    reason: null,
    path: selected,
    paths: [selected],
    hookRule: result.hookRule,
    hookSideSign: sideSign,
    hookAngleDeg: INNER_CROSSTIE_HOOK_ANGLE_DEG,
    hookEndsSameSide: true,
    shapeContract: 'INNER_CROSSTIE_135',
    alternateHookSide: false,
    terminalMainBarAligned: true,
    restrainedStartBar: aligned.startBar,
    restrainedEndBar: aligned.endBar,
    terminalMainBarStartAxisMm: aligned.startAxisMm,
    terminalMainBarEndAxisMm: aligned.endAxisMm,
    terminalMainBarClearanceStartMm: aligned.startClearanceMm,
    terminalMainBarClearanceEndMm: aligned.endClearanceMm,
    terminalMainBarRequiredClearanceStartMm: aligned.requiredStartClearanceMm,
    terminalMainBarRequiredClearanceEndMm: aligned.requiredEndClearanceMm,
    terminalTangentDistanceMm: aligned.tangentDistanceMm,
    alignedTie: aligned.tie,
  };
}
