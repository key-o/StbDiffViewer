/**
 * @fileoverview 基礎系（杭・基礎・基礎柱）のIFC/STBエクスポートデータ収集・変換
 *
 * @module ui/events/exportHandlers/ifcCollectors/foundationCollectors
 */

import { extractProfileFromSection } from '../commonDataCollector.js';
import { createLogger } from '../../../../utils/logger.js';
import { getSectionDataFromMap } from '../../../../data/accessors/sectionMapAccessor.js';
import {
  collectElementDataForExport,
  extractCommonElementData,
  extractDimensionFromSection,
} from './collectorHelpers.js';

const log = createLogger('ifcDataCollector');

// ================================================================
// 杭データ収集・変換
// ================================================================

/**
 * 現在のモデルから杭データを収集
 * @returns {Promise<Array>} IFCSTBExporter用の杭データ配列
 */
export function collectPileDataForExport() {
  return collectElementDataForExport([
    {
      elementKey: 'pileElements',
      sectionKey: 'pileSections',
      converterFn: convertPileToExportData,
    },
  ]);
}

/**
 * 杭要素をエクスポート用データに変換
 * @param {Object} element - 杭要素
 * @param {Map} nodeMap - ノードマップ
 * @param {Map} sectionMap - 断面マップ
 * @returns {Object|null} エクスポート用データ
 */
function convertPileToExportData(element, nodeMap, sectionMap) {
  try {
    let topPoint, bottomPoint;

    if (element.pileFormat === '2node') {
      // 2ノード形式
      const commonData = extractCommonElementData(element, nodeMap, sectionMap, {
        nodeKeys: ['id_node_bottom', 'id_node_top'],
        sectionKey: 'id_section',
        minNodeCount: 2,
      });

      if (commonData.errors.length > 0) {
        log.warn(`杭 ${element.id}:`, commonData.errors.join(', '));
        return null;
      }

      const [bottomNode, topNode] = commonData.nodes;
      topPoint = {
        x: topNode.x + (element.offset_top_X || 0),
        y: topNode.y + (element.offset_top_Y || 0),
        z: topNode.z,
      };
      bottomPoint = {
        x: bottomNode.x + (element.offset_bottom_X || 0),
        y: bottomNode.y + (element.offset_bottom_Y || 0),
        z: bottomNode.z,
      };
    } else if (element.pileFormat === '1node') {
      // 1ノード形式
      const commonData = extractCommonElementData(element, nodeMap, sectionMap, {
        nodeKeys: 'id_node',
        sectionKey: 'id_section',
        minNodeCount: 1,
      });

      if (commonData.errors.length > 0) {
        log.warn(`杭 ${element.id}:`, commonData.errors.join(', '));
        return null;
      }

      const [node] = commonData.nodes;
      const offsetX = element.offset_X || 0;
      const offsetY = element.offset_Y || 0;
      const lengthAll = element.length_all || 10000; // デフォルト10m
      const levelTop = element.level_top !== undefined ? element.level_top : node.z;

      // 杭頭位置（level_topが杭頭のレベル）
      topPoint = {
        x: node.x + offsetX,
        y: node.y + offsetY,
        z: levelTop,
      };
      // 杭底位置（杭頭から杭長さ分下）
      bottomPoint = {
        x: node.x + offsetX,
        y: node.y + offsetY,
        z: levelTop - lengthAll,
      };
    } else {
      log.warn(`杭 ${element.id}: 不明な形式`);
      return null;
    }

    // 断面データから直径と肉厚を取得
    let diameter = 600; // デフォルト600mm
    let wallThickness = null;
    let predefinedType = 'DRIVEN';
    let constructionType = 'PREFAB_STEEL';

    if (sectionMap) {
      const sectionData = getSectionDataFromMap(sectionMap, element.id_section);
      if (sectionData) {
        diameter = extractDimensionFromSection(sectionData, ['D', 'diameter'], 600);
        wallThickness = extractDimensionFromSection(sectionData, ['t', 'wallThickness'], null);
      }
    }

    // 杭種別からIFCタイプを決定
    if (element.kind_structure === 'CAST' || element.kind === 'KIND_CAST') {
      predefinedType = 'BORED';
      constructionType = 'CAST_IN_PLACE';
      wallThickness = null; // 場所打ち杭は中実
    } else if (element.kind_structure === 'ST' || element.kind === 'KIND_ST') {
      predefinedType = 'DRIVEN';
      constructionType = 'PREFAB_STEEL';
    } else if (element.kind_structure === 'PC' || element.kind === 'KIND_PHC') {
      predefinedType = 'DRIVEN';
      constructionType = 'PRECAST_CONCRETE';
    }

    return {
      name: element.name || `Pile_${element.id}`,
      topPoint,
      bottomPoint,
      diameter,
      wallThickness,
      predefinedType,
      constructionType,
    };
  } catch (error) {
    log.warn(`杭変換エラー (${element.id}):`, error);
    return null;
  }
}

// ================================================================
// 基礎データ収集・変換
// ================================================================

/**
 * 現在のモデルから基礎データを収集
 * @returns {Promise<Array>} IFCSTBExporter用の基礎データ配列
 */
export function collectFootingDataForExport() {
  return collectElementDataForExport([
    {
      elementKey: 'footingElements',
      sectionKey: 'footingSections',
      converterFn: convertFootingToExportData,
    },
  ]);
}

/**
 * 基礎要素をエクスポート用データに変換
 * @param {Object} element - 基礎要素
 * @param {Map} nodeMap - ノードマップ
 * @param {Map} sectionMap - 断面マップ
 * @returns {Object|null} エクスポート用データ
 */
function convertFootingToExportData(element, nodeMap, sectionMap) {
  try {
    // 共通データ抽出
    const commonData = extractCommonElementData(element, nodeMap, sectionMap, {
      nodeKeys: 'id_node',
      sectionKey: 'id_section',
      minNodeCount: 1,
    });

    if (commonData.errors.length > 0) {
      log.warn(`基礎 ${element.id}:`, commonData.errors.join(', '));
      return null;
    }

    const [node] = commonData.nodes;
    const { section } = commonData;

    const offsetX = element.offset_X || 0;
    const offsetY = element.offset_Y || 0;
    const levelBottom = element.level_bottom || 0;
    const rotation = element.rotate || 0;

    // 断面データから寸法を取得
    const width_X = extractDimensionFromSection(
      section,
      ['width_X', 'width', 'overall_width'],
      1500,
    );
    const width_Y = extractDimensionFromSection(
      section,
      ['width_Y', 'height', 'overall_depth'],
      1500,
    );
    const depth = extractDimensionFromSection(section, ['depth', 'thickness', 't'], 500);

    // 基礎タイプを決定（長方形基礎はPAD_FOOTING、細長い場合はSTRIP_FOOTING）
    const predefinedType =
      width_X / width_Y > 3 || width_Y / width_X > 3 ? 'STRIP_FOOTING' : 'PAD_FOOTING';

    // IFCでは基礎上端を原点として下方向に押し出すため、
    // position.z は基礎上端のレベル（= 底面レベル + 深さ）
    return {
      name: element.name || `Footing_${element.id}`,
      position: {
        x: node.x + offsetX,
        y: node.y + offsetY,
        z: levelBottom + depth, // 基礎上端のレベル
      },
      width_X,
      width_Y,
      depth,
      rotation,
      predefinedType,
    };
  } catch (error) {
    log.warn(`基礎変換エラー (${element.id}):`, error);
    return null;
  }
}

// ================================================================
// 基礎柱データ収集・変換
// ================================================================

/**
 * 現在のモデルから基礎柱データを収集
 * @returns {Promise<Array>} IFCSTBExporter用の基礎柱データ配列
 */
export function collectFoundationColumnDataForExport() {
  return collectElementDataForExport(
    [
      {
        elementKey: 'foundationColumnElements',
        sectionKey: 'foundationcolumnSections',
        converterFn: convertFoundationColumnToExportData,
      },
    ],
    { needsSteelSections: true },
  );
}

/**
 * 基礎柱要素をエクスポート用データに変換
 * StbFoundationColumn は1節点（id_node）+ FD/WR二重断面構造
 * @param {Object} element - 基礎柱要素
 * @param {Map} nodeMap - ノードマップ
 * @param {Map} sectionMap - 断面マップ
 * @param {Map} steelSections - 鋼材断面マップ
 * @returns {Object|null} エクスポート用データ
 */
function convertFoundationColumnToExportData(element, nodeMap, sectionMap, steelSections) {
  try {
    // 共通データ抽出
    const commonData = extractCommonElementData(element, nodeMap, sectionMap, {
      nodeKeys: 'id_node',
      steelSections,
      minNodeCount: 1,
    });

    if (commonData.errors.length > 0) {
      log.warn(`基礎柱 ${element.id}:`, commonData.errors.join(', '));
      return null;
    }

    const [baseNode] = commonData.nodes;
    const lengthFD = element.length_FD || 0;
    const lengthWR = element.length_WR || 0;
    const totalLength = lengthFD + lengthWR;

    if (totalLength <= 0) {
      log.warn(`基礎柱 ${element.id}: 長さが0です`);
      return null;
    }

    // FD断面の取得
    let profileFD = null;
    if (element.id_section_FD && lengthFD > 0) {
      const sectionFD = getSectionDataFromMap(sectionMap, element.id_section_FD);
      profileFD = sectionFD ? extractProfileFromSection(sectionFD, steelSections) : null;
    }

    // WR断面の取得
    let profileWR = null;
    if (element.id_section_WR && lengthWR > 0) {
      const sectionWR = getSectionDataFromMap(sectionMap, element.id_section_WR);
      profileWR = sectionWR ? extractProfileFromSection(sectionWR, steelSections) : null;
    }

    if (!profileFD && !profileWR) {
      log.warn(`基礎柱 ${element.id}: FD/WR断面が両方見つかりません`);
      return null;
    }

    const baseX = baseNode.x + (element.offset_FD_X || 0);
    const baseY = baseNode.y + (element.offset_FD_Y || 0);
    const baseZ = baseNode.z + (element.offset_Z || 0);

    return {
      name: element.name || `FoundationColumn_${element.id}`,
      topPoint: { x: baseX, y: baseY, z: baseZ },
      bottomPoint: { x: baseX, y: baseY, z: baseZ - totalLength },
      lengthFD,
      lengthWR,
      profileFD,
      profileWR,
      rotation: element.rotate || 0,
    };
  } catch (error) {
    log.warn(`基礎柱変換エラー (${element.id}):`, error);
    return null;
  }
}
