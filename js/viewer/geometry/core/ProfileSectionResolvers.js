/**
 * @fileoverview 断面形状の判定・寸法解決ユーティリティ
 *
 * CROSS_H / SHAPE_T などの複合断面判定と、鋼材形状名から寸法を解決する
 * ロジックを集約します（ProfileCreationUtils から分割）。
 *
 * @module viewer/geometry/core/ProfileSectionResolvers
 */

// E4: 全レイヤー → common-stb/import/ は許可（STB読み込み共通カーネル）
import { parseDimensionsFromShapeName } from '../../../common-stb/import/extractor/dimensionExtractors.js';

/**
 * 有限数値への変換ヘルパー
 * @param {*} value - 値
 * @param {number} defaultValue - 既定値
 * @returns {number} 数値
 */
export function toFiniteNumber(value, defaultValue) {
  const num = Number(value);
  return Number.isFinite(num) ? num : defaultValue;
}

/**
 * CROSS_H断面かどうかを判定
 * @param {Object} sectionData - 断面データ
 * @returns {boolean}
 */
export function isCrossHSection(sectionData) {
  if (!sectionData || typeof sectionData !== 'object') {
    return false;
  }

  const dimensions = sectionData.dimensions || {};
  if (dimensions.crossH_shapeX || dimensions.crossH_shapeY) {
    return true;
  }

  const candidates = [
    sectionData.section_type,
    sectionData.profile_type,
    sectionData.sectionType,
    dimensions.profile_hint,
    sectionData.steelShape?.type,
    sectionData.steelProfile?.section_type,
  ];

  for (const candidate of candidates) {
    const up = String(candidate || '')
      .trim()
      .toUpperCase();
    if (
      up === 'CROSS_H' ||
      up === 'CROSS-H' ||
      up === 'CROSS' ||
      up === 'CRUCIFORM' ||
      up === '+'
    ) {
      return true;
    }
  }

  return false;
}

/**
 * T形複合断面（shape_H + shape_T）かどうかを判定
 * @param {Object} sectionData - 断面データ
 * @returns {boolean}
 */
export function isShapeTSection(sectionData) {
  if (!sectionData || typeof sectionData !== 'object') {
    return false;
  }
  if (sectionData.isShapeT) return true;

  const dimensions = sectionData.dimensions || {};
  if (dimensions.shapeT_shapeH || dimensions.profile_hint === 'SHAPE_T') {
    return true;
  }

  const candidates = [
    sectionData.section_type,
    sectionData.profile_type,
    sectionData.sectionType,
    dimensions.profile_hint,
    sectionData.steelProfile?.section_type,
    sectionData.steelProfile?.dimensions?.profile_hint,
  ];
  return candidates.some((c) => String(c || '').toUpperCase() === 'SHAPE_T');
}

/**
 * CROSS_H断面の形状名から実際のH鋼寸法を解決
 * @param {Object} dimensions - crossH_shapeX/crossH_shapeY を含む寸法データ
 * @param {Map} steelSections - 鋼材形状マップ
 * @returns {Object|null} 解決された寸法データ、または null
 */
export function resolveCrossHDimensions(dimensions, steelSections) {
  if (!dimensions) return null;

  const shapeX = dimensions.crossH_shapeX;
  const shapeY = dimensions.crossH_shapeY;

  if (!shapeX) return null;

  const dataX = steelSections?.get(shapeX);
  const dataY = steelSections?.get(shapeY || shapeX);

  const getDim = (data, key) => {
    if (!data) return null;
    const d = data.dimensions || data;
    return d[key] || null;
  };

  const hX = getDim(dataX, 'H') || getDim(dataX, 'A') || 400.0;
  const bX = getDim(dataX, 'B') || 200.0;
  const hY = getDim(dataY, 'H') || getDim(dataY, 'A') || hX;
  const bY = getDim(dataY, 'B') || bX;

  return {
    profile_hint: 'CROSS_H',
    crossH_shapeX: shapeX,
    crossH_shapeY: shapeY || shapeX,
    overallDepthX: hX,
    overallWidthX: bX,
    overallDepthY: hY,
    overallWidthY: bY,
  };
}

/**
 * H断面寸法を鋼材定義から解決（不足時はフォールバック）
 * @param {string} shapeName - 鋼材形状名
 * @param {Map} steelSections - 鋼材形状マップ
 * @param {Object} [fallback={}] - フォールバック寸法
 * @returns {Object} H断面寸法
 */
export function resolveHDimensions(shapeName, steelSections, fallback = {}) {
  const source = steelSections?.get(shapeName);
  const dims = source?.dimensions || source || {};

  const H = toFiniteNumber(
    dims.H ?? dims.A ?? dims.height ?? dims.overall_depth,
    fallback.H ?? 400,
  );
  const B = toFiniteNumber(dims.B ?? dims.width ?? dims.overall_width, fallback.B ?? 200);
  const t1 = toFiniteNumber(
    dims.t1 ?? dims.tw ?? dims.web_thickness ?? dims.webThickness,
    fallback.t1 ?? 9,
  );
  const t2 = toFiniteNumber(
    dims.t2 ?? dims.tf ?? dims.flange_thickness ?? dims.flangeThickness,
    fallback.t2 ?? 14,
  );
  const r = toFiniteNumber(dims.r ?? dims.fillet_radius ?? dims.filletRadius, fallback.r ?? 0);

  return {
    profile_hint: 'H',
    H,
    B,
    t1,
    t2,
    r,
    height: H,
    width: B,
    overall_depth: H,
    overall_width: B,
    web_thickness: t1,
    flange_thickness: t2,
  };
}

/**
 * 鋼材形状名から断面寸法を解決（steelSections優先、形状名解析でフォールバック）
 * @param {string} shapeName - 鋼材形状名
 * @param {Map} steelSections - 鋼材形状マップ
 * @returns {Object} 寸法オブジェクト
 */
export function resolveSteelDimsByName(shapeName, steelSections) {
  const source = steelSections?.get(shapeName);
  const dims = source?.dimensions || source;
  if (dims && typeof dims === 'object' && Object.keys(dims).length > 0) {
    return dims;
  }
  return parseDimensionsFromShapeName(shapeName) || {};
}
