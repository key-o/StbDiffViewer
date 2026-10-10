/**
 * @fileoverview 面材（床・壁）のIFC/STBエクスポートデータ収集・変換
 *
 * @module ui/events/exportHandlers/ifcCollectors/planarCollectors
 */

import { createLogger } from '../../../../utils/logger.js';
import { getSectionDataFromMap } from '../../../../data/accessors/sectionMapAccessor.js';
import {
  collectElementDataForExport,
  applyOffsetsToVertices,
  extractDimensionFromSection,
} from './collectorHelpers.js';

const log = createLogger('ifcDataCollector');

// ================================================================
// 床データ収集・変換
// ================================================================

/**
 * 現在のモデルから床データを収集
 * @returns {Promise<Array>} IFCSTBExporter用の床データ配列
 */
export function collectSlabDataForExport() {
  return collectElementDataForExport([
    {
      elementKey: 'slabElements',
      sectionKey: 'slabSections',
      converterFn: convertSlabToExportData,
    },
  ]);
}

/**
 * 床要素をエクスポート用データに変換
 * @param {Object} element - 床要素
 * @param {Map} nodeMap - ノードマップ
 * @param {Map} sectionMap - 断面マップ
 * @returns {Object|null} エクスポート用データ
 */
function convertSlabToExportData(element, nodeMap, sectionMap) {
  try {
    const nodeIds = element.node_ids;
    if (!nodeIds || nodeIds.length < 3) {
      log.warn(`床 ${element.id}: ノードが3点未満`);
      return null;
    }

    // 頂点座標を取得（オフセット適用）
    const offsets = element.offsets || new Map();
    const vertices = applyOffsetsToVertices(nodeIds, nodeMap, element, offsets, 'offset_');

    if (!vertices) {
      return null;
    }

    // 断面データから厚さを取得
    const thickness = extractDimensionFromSection(
      getSectionDataFromMap(sectionMap, element.id_section),
      ['depth', 't', 'thickness'],
      150,
    );

    // 床タイプを決定
    let predefinedType = 'FLOOR';
    if (element.isFoundation) {
      predefinedType = 'BASESLAB';
    } else if (element.kind_slab === 'ROOF') {
      predefinedType = 'ROOF';
    }

    return {
      name: element.name || `Slab_${element.id}`,
      vertices,
      thickness,
      predefinedType,
    };
  } catch (error) {
    log.warn(`床変換エラー (${element.id}):`, error);
    return null;
  }
}

// ================================================================
// 壁データ収集・変換
// ================================================================

/**
 * 現在のモデルから壁データを収集
 * @returns {Promise<Array>} IFCSTBExporter用の壁データ配列
 */
export function collectWallDataForExport() {
  return collectElementDataForExport(
    [
      {
        elementKey: 'wallElements',
        sectionKey: 'wallSections',
        converterFn: convertWallToExportData,
      },
    ],
    {
      extraDataExtractor: ({ elementData }) => ({
        args: [elementData.openingElements || new Map()],
      }),
    },
  );
}

/**
 * 壁要素をエクスポート用データに変換
 * @param {Object} element - 壁要素
 * @param {Map} nodeMap - ノードマップ
 * @param {Map} sectionMap - 断面マップ
 * @param {Map} openingElements - 開口情報マップ
 * @returns {Object|null} エクスポート用データ
 */
function convertWallToExportData(element, nodeMap, sectionMap, openingElements = new Map()) {
  try {
    const nodeIds = element.node_ids;
    if (!nodeIds || nodeIds.length < 4) {
      log.warn(`壁 ${element.id}: ノードが4点未満`);
      return null;
    }

    // 頂点座標を取得（オフセット適用）
    const offsets = element.offsets || new Map();
    const vertices = applyOffsetsToVertices(nodeIds, nodeMap, element, offsets, 'offset_');

    if (!vertices) {
      return null;
    }

    // 4点から壁の始点・終点・高さを計算
    const p0 = vertices[0];
    const p1 = vertices[1];
    const p2 = vertices[2];
    const p3 = vertices[3];

    const bottomZ = Math.min(p0.z, p1.z);
    const topZ = Math.max(p2.z, p3.z);
    const height = topZ - bottomZ;

    if (height <= 0) {
      log.warn(`壁 ${element.id}: 高さが0以下`);
      return null;
    }

    const startPoint = { x: p0.x, y: p0.y, z: bottomZ };
    const endPoint = { x: p1.x, y: p1.y, z: bottomZ };

    // 断面データから厚さを取得
    const thickness = extractDimensionFromSection(
      getSectionDataFromMap(sectionMap, element.id_section),
      ['t', 'thickness'],
      200,
    );

    // 壁タイプを決定
    let predefinedType = 'STANDARD';
    if (element.kind_wall === 'WALL_SHEAR') {
      predefinedType = 'SHEAR';
    } else if (element.kind_wall === 'WALL_PARTITION') {
      predefinedType = 'PARTITIONING';
    }

    // 開口情報を収集
    const openings = [];
    if (openingElements && openingElements.size > 0) {
      // STB 2.0.2の場合: 壁のopen_idsを使用
      if (element.open_ids && element.open_ids.length > 0) {
        for (const openId of element.open_ids) {
          const opening = openingElements.get(openId);
          if (opening) {
            openings.push({
              id: opening.id,
              name: opening.name,
              positionX: opening.position_X,
              positionY: opening.position_Y,
              width: opening.length_X,
              height: opening.length_Y,
              rotate: opening.rotate,
            });
          }
        }
      } else {
        // STB 2.1.0の場合: id_memberを使用して壁と開口を関連付け
        for (const opening of openingElements.values()) {
          if (opening.kind_member === 'WALL' && String(opening.id_member) === String(element.id)) {
            openings.push({
              id: opening.id,
              name: opening.name,
              positionX: opening.position_X,
              positionY: opening.position_Y,
              width: opening.length_X,
              height: opening.length_Y,
              rotate: opening.rotate,
            });
          }
        }
      }
    }

    return {
      name: element.name || `Wall_${element.id}`,
      startPoint,
      endPoint,
      height,
      thickness,
      predefinedType,
      kindStructure: element.kind_structure || 'RC',
      openings,
    };
  } catch (error) {
    log.warn(`壁変換エラー (${element.id}):`, error);
    return null;
  }
}
