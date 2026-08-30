/**
 * @fileoverview 構造要素の断面解決
 *
 * STB/JSONの断面参照、断面タイプ推定、表示配置に必要な断面高さの取得を担当する。
 */

import { resolveGeometryProfileTypeInPlace } from '../../../common-stb/import/section/sectionTypeUtil.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('viewer:geometry:section-resolver');

/**
 * 要素の断面データを統一形式で取得する。
 * @param {Object} element
 * @param {Map} sections
 * @param {boolean} isJsonInput
 * @returns {Object|null}
 */
export function getSectionData(element, sections, isJsonInput) {
  let sectionData;

  if (isJsonInput) {
    sectionData = element.section;
    if (!sectionData) {
      log.warn(`JSON element ${element.id}: no section data`);
    }
  } else {
    const rawSectionId = element.id_section;
    if (!rawSectionId) {
      log.warn(`STB element ${element.id}: no id_section`);
      return null;
    }
    if (!sections) {
      log.warn(`STB element ${element.id}: sections map is null`);
      return null;
    }

    const parsedId = parseInt(rawSectionId, 10);
    const sectionId = Number.isNaN(parsedId) ? rawSectionId : parsedId;
    sectionData = sections.get(sectionId);
    if (!sectionData) {
      log.warn(`STB element ${element.id}: section not found (id_section=${sectionId})`);
    }
  }

  if (!sectionData) return null;
  return resolveGeometryProfileTypeInPlace(sectionData);
}

/**
 * 天端基準配置に使用する断面高さを取得する。
 * @param {Object} sectionData
 * @param {string} sectionType
 * @returns {number}
 */
export function getSectionHeight(sectionData, sectionType) {
  if (!sectionData) return 0;

  const dims = sectionData.dimensions || sectionData;
  const upperType = (sectionType || '').toUpperCase();

  if (upperType === 'CIRCLE' || upperType === 'PIPE') {
    return 0;
  }

  const heightCandidates = [dims.overall_depth, dims.height, dims.outer_height, dims.A, dims.depth];

  for (const candidate of heightCandidates) {
    if (candidate !== undefined && candidate !== null) {
      const height = Number(candidate);
      if (Number.isFinite(height) && height > 0) {
        return height;
      }
    }
  }

  if (dims.diameter || dims.outer_diameter) {
    return Number(dims.diameter || dims.outer_diameter) || 0;
  }

  return 0;
}
