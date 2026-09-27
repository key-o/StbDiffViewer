/**
 * @fileoverview R12-N 小梁主筋ごとの大梁内「確保可能投影長さ」を解決する。
 *
 * R12-Mの実支持矩形を、部材中心軸ではなく各主筋軸(u)で再交差させる。
 * 支持大梁の反対側コンクリート面から設計かぶりと対象鉄筋半径を控除し、
 * 90°折曲げの中心線半径まで考慮して折曲げ開始点が支持大梁内に収まる場合だけ
 * availableProjectionMm を生成する。
 *
 * このresolverは必要長さとの比較、定着mode選択、折曲げ方向、RebarPath生成を行わない。
 */

import { REBAR_STANDARD_RULES } from '../../../constants/rebarStandardRules.js';
import { resolveSmallBeamSupportFaceGeometry } from './smallBeamSupportFaceGeometry.js';
import {
  hasUnsupportedSmallBeamSectionRotation,
  resolveSmallBeamSectionRollDegrees,
  SMALL_BEAM_ROTATED_SECTION_UNSUPPORTED_REASON,
} from './smallBeamSectionOrientation.js';

const TOLERANCE_MM = 1e-6;

function unresolved(reason, extra = {}) {
  return {
    ...extra,
    resolved: false,
    reason,
    availableProjectionMm: null,
    source: 'R12-small-beam-available-projection',
  };
}

function resolveBendRule(barDiaMm, grade) {
  const normalizedGrade = REBAR_STANDARD_RULES.normalizeGrade(grade);
  if (!normalizedGrade) {
    return { resolved: false, reason: 'small-beam-bar-grade-unresolved' };
  }

  const inside = REBAR_STANDARD_RULES.resolveBendInsideDiameterFactor({
    grade: normalizedGrade,
    barDiaMm,
    bendAngle: 90,
  });
  if (!inside.ok || !Number.isFinite(inside.factor)) {
    return {
      resolved: false,
      reason: 'small-beam-90deg-bend-rule-unresolved',
      grade: normalizedGrade,
      insideDiameterFactor: inside.factor ?? null,
    };
  }

  const insideDiameterMm = inside.factor * barDiaMm;
  return {
    resolved: true,
    reason: null,
    grade: normalizedGrade,
    insideDiameterFactor: inside.factor,
    insideDiameterMm,
    centerlineRadiusMm: (insideDiameterMm + barDiaMm) / 2,
  };
}

/**
 * 小梁主筋1本の、仕口面から鉄筋外面までの確保可能投影長さを解決する。
 *
 * @param {Object} params
 * @param {function(string): Element[]} params.scanTag
 * @param {Element} params.beamEl 対象StbBeam
 * @param {Object} params.supportEnd smallBeamSupportFactsの端部fact
 * @param {Object} params.supportContext smallBeamSupportGirderContext
 * @param {Object} params.bar beamRebarPlacementのbar fact（u,dia,grade）
 * @param {Object|null} [params.index] 共有RebarModelIndex
 * @returns {Object} bar-level available projection fact
 */
export function resolveSmallBeamBarAvailableProjection({
  scanTag,
  beamEl,
  supportEnd,
  supportContext,
  bar,
  index = null,
} = {}) {
  const barOffsetMm = Number(bar?.u);
  const barDiaMm = Number(bar?.dia);
  if (!Number.isFinite(barOffsetMm)) {
    return unresolved('small-beam-bar-lateral-position-unresolved');
  }
  if (!(Number.isFinite(barDiaMm) && barDiaMm > 0)) {
    return unresolved('small-beam-bar-diameter-unresolved', { barOffsetMm });
  }
  if (hasUnsupportedSmallBeamSectionRotation(beamEl)) {
    return unresolved(SMALL_BEAM_ROTATED_SECTION_UNSUPPORTED_REASON, {
      barOffsetMm,
      barDiaMm,
      sectionRollDegrees: resolveSmallBeamSectionRollDegrees(beamEl),
    });
  }

  const geometry = resolveSmallBeamSupportFaceGeometry(
    scanTag,
    beamEl,
    supportEnd,
    supportContext,
    { beamLateralOffsetMm: barOffsetMm, index },
  );
  if (!geometry.resolved) {
    return unresolved(geometry.reason || 'small-beam-bar-support-geometry-unresolved', {
      barOffsetMm,
      barDiaMm,
      supportGeometry: geometry,
    });
  }

  const farFaceSide = geometry.farFaceSide;
  if (!farFaceSide) {
    return unresolved('support-far-face-side-unresolved', {
      barOffsetMm,
      barDiaMm,
      supportGeometry: geometry,
    });
  }

  const coverFact = supportContext?.supportCoverBySide?.[farFaceSide];
  const supportCoverMm = Number(coverFact?.coverMm);
  if (!coverFact?.resolved || !(Number.isFinite(supportCoverMm) && supportCoverMm >= 0)) {
    return unresolved(coverFact?.reason || 'support-far-face-cover-unresolved', {
      barOffsetMm,
      barDiaMm,
      farFaceSide,
      supportGeometry: geometry,
      supportCover: coverFact || null,
    });
  }

  const bendRule = resolveBendRule(barDiaMm, bar?.grade);
  if (!bendRule.resolved) {
    return unresolved(bendRule.reason, {
      barOffsetMm,
      barDiaMm,
      farFaceSide,
      supportGeometry: geometry,
      supportCover: coverFact,
      ...bendRule,
    });
  }

  const sinSkew = Number(geometry.sinSkew);
  if (!(Number.isFinite(sinSkew) && sinSkew > 0)) {
    return unresolved('small-beam-skew-projection-unresolved', {
      barOffsetMm,
      barDiaMm,
      farFaceSide,
      supportGeometry: geometry,
      supportCover: coverFact,
    });
  }

  const barRadiusMm = barDiaMm / 2;
  // 支持大梁の側面法線方向に、かぶり + 対象鉄筋半径を確保する。
  const centerInsetFromFarFaceNormalMm = supportCoverMm + barRadiusMm;
  const centerInsetFromFarFaceAlongBarMm = centerInsetFromFarFaceNormalMm / sinSkew;
  const verticalLegCenterFromNearMm =
    geometry.effectiveEmbedmentMm - centerInsetFromFarFaceAlongBarMm;

  if (!(verticalLegCenterFromNearMm > TOLERANCE_MM)) {
    return unresolved('nonpositive-small-beam-bar-center-projection', {
      barOffsetMm,
      barDiaMm,
      farFaceSide,
      supportGeometry: geometry,
      supportCover: coverFact,
      barRadiusMm,
      centerInsetFromFarFaceNormalMm,
      centerInsetFromFarFaceAlongBarMm,
      verticalLegCenterFromNearMm,
      ...bendRule,
    });
  }

  // 90°曲げでは、水平直線部の接線位置は縦脚中心（sharp corner）からRだけ手前。
  const bendStartFromNearMm = verticalLegCenterFromNearMm - bendRule.centerlineRadiusMm;
  if (bendStartFromNearMm < -TOLERANCE_MM) {
    return unresolved('small-beam-90deg-bend-start-outside-support', {
      barOffsetMm,
      barDiaMm,
      farFaceSide,
      supportGeometry: geometry,
      supportCover: coverFact,
      barRadiusMm,
      centerInsetFromFarFaceNormalMm,
      centerInsetFromFarFaceAlongBarMm,
      verticalLegCenterFromNearMm,
      bendStartFromNearMm,
      ...bendRule,
    });
  }

  // 標準図の投影長さは仕口面から鉄筋外面までなので、縦脚中心へ対象筋半径を加える。
  const availableProjectionMm = verticalLegCenterFromNearMm + barRadiusMm;
  if (!(availableProjectionMm > 0)) {
    return unresolved('nonpositive-small-beam-available-projection', {
      barOffsetMm,
      barDiaMm,
      farFaceSide,
      supportGeometry: geometry,
      supportCover: coverFact,
    });
  }

  return {
    resolved: true,
    reason: null,
    source: 'R12-small-beam-available-projection',
    standardId: REBAR_STANDARD_RULES.standardId,
    side: supportEnd?.side || null,
    supportId: supportEnd?.supportId ? String(supportEnd.supportId) : null,
    barOffsetMm,
    barDiaMm,
    grade: bendRule.grade,
    barRadiusMm,
    farFaceSide,
    supportCoverMm,
    supportCoverSource: coverFact.source || null,
    supportGeometry: geometry,
    sinSkew,
    skewAngleDeg: geometry.skewAngleDeg,
    effectiveEmbedmentMm: geometry.effectiveEmbedmentMm,
    centerInsetFromFarFaceNormalMm,
    centerInsetFromFarFaceAlongBarMm,
    verticalLegCenterFromNearMm,
    bendStartFromNearMm: Math.max(0, bendStartFromNearMm),
    insideDiameterFactor: bendRule.insideDiameterFactor,
    insideDiameterMm: bendRule.insideDiameterMm,
    centerlineRadiusMm: bendRule.centerlineRadiusMm,
    availableProjectionMm,
  };
}
