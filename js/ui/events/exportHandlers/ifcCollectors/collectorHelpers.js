/**
 * @fileoverview IFC/STBエクスポート データ収集の共通ヘルパー
 *
 * 要素データ収集ファクトリと、各 collector から共有される純粋ヘルパー関数群を提供します。
 *
 * @module ui/events/exportHandlers/ifcCollectors/collectorHelpers
 */

import { getOrParseStructureData, extractProfileFromSection } from '../commonDataCollector.js';
import { createLogger } from '../../../../utils/logger.js';
import { getSectionDataFromMap } from '../../../../data/accessors/sectionMapAccessor.js';

const log = createLogger('ifcDataCollector');

// ================================================================
// 汎用データ収集ファクトリ
// ================================================================

/**
 * 要素データ収集の共通パターンをファクトリ化
 *
 * @param {Array<Object>} sources - 収集ソース定義の配列
 * @param {string} sources[].elementKey - elementData内の要素配列キー
 * @param {string} sources[].sectionKey - sectionMaps内の断面マップキー
 * @param {Function} sources[].converterFn - 変換関数
 * @param {string} [sources[].elementType] - 要素タイプ文字列（converterFnに渡す）
 * @param {Object} [options] - オプション
 * @param {boolean} [options.needsSteelSections=false] - steelSectionsをconverterFnに渡すか
 * @param {Function} [options.extraDataExtractor] - structureDataから追加データを抽出する関数
 * @returns {Promise<Array>} 変換済みデータの配列
 */
export async function collectElementDataForExport(sources, options = {}) {
  const result = [];

  const structureData = await getOrParseStructureData();
  if (!structureData) return result;

  const { nodeMap, steelSections, elementData, sectionMaps } = structureData;
  const extraData = options.extraDataExtractor ? options.extraDataExtractor(structureData) : {};

  for (const source of sources) {
    const elements = elementData[source.elementKey] || [];
    const sections = sectionMaps[source.sectionKey];

    for (const element of elements) {
      // converterFnの引数を構築: (element, nodeMap, sections, [steelSections], [elementType], ...extraData)
      const args = [element, nodeMap, sections];
      if (options.needsSteelSections) args.push(steelSections);
      if (source.elementType) args.push(source.elementType);
      // 追加データを個別引数として渡す
      if (extraData.args) args.push(...extraData.args);

      const entry = source.converterFn(...args);
      if (entry) result.push(entry);
    }
  }

  return result;
}

// ================================================================
// 共通ヘルパー関数
// ================================================================

/**
 * 要素データ変換の共通処理を抽出
 * ノード取得、セクション抽出、プロファイル抽出、回転角度取得などを統一処理
 * @param {Object} element - 要素データ
 * @param {Map} nodeMap - ノードマップ
 * @param {Map} sectionMap - セクションマップ
 * @param {Object} config - 設定オプション
 * @param {string|Array} [config.nodeKeys] - ノード取得設定
 *   単一ノード: 'id_node' → {nodeId, nodeKey: 'id_node'}
 *   複数キー: ['id_node_start', 'id_node_end'] → {nodes, nodeKeys}
 * @param {string} [config.sectionKey='id_section'] - 断面キー
 * @param {Map} [config.steelSections] - 鋼材断面マップ
 * @param {number} [config.minNodeCount] - ノード最小数チェック
 * @returns {Object|null} 共通情報: { nodes, nodeIds, section, profile, rotation, errors: [] }
 */
export function extractCommonElementData(element, nodeMap, sectionMap, config = {}) {
  const result = {
    section: null,
    profile: null,
    rotation: 0,
    errors: [],
    nodes: [],
    nodeIds: [],
  };

  try {
    // (1) ノード取得とバリデーション
    const nodeConfig = config.nodeKeys || 'id_node';
    const minNodeCount = config.minNodeCount || 0;

    if (typeof nodeConfig === 'string') {
      // 単一ノード取得
      const node = nodeMap.get(element[nodeConfig]);
      if (!node) {
        result.errors.push(`ノードが見つかりません: ${element.id} (${nodeConfig})`);
      } else {
        result.nodes.push(node);
        result.nodeIds.push(element[nodeConfig]);
      }
    } else if (Array.isArray(nodeConfig)) {
      // 複数ノード取得
      for (const key of nodeConfig) {
        const node = nodeMap.get(element[key]);
        if (!node) {
          result.errors.push(`ノードが見つかりません: ${element.id} (${key})`);
        } else {
          result.nodes.push(node);
          result.nodeIds.push(element[key]);
        }
      }
    }

    // 最小ノード数チェック
    if (minNodeCount > 0 && result.nodes.length < minNodeCount) {
      result.errors.push(
        `ノード数不足: ${element.id} (期待: ${minNodeCount}, 実際: ${result.nodes.length})`,
      );
      return result;
    }

    // (2) セクション情報抽出
    const sectionKey = config.sectionKey || 'id_section';
    if (sectionKey && element[sectionKey]) {
      result.section = getSectionDataFromMap(sectionMap, element[sectionKey]);
    }

    // (3) プロファイル抽出（steelSectionsがある場合）
    if (result.section && config.steelSections) {
      result.profile = extractProfileFromSection(result.section, config.steelSections);
    }

    // (4) 回転角度取得
    result.rotation = element.rotate || element.angle || 0;

    return result;
  } catch (error) {
    result.errors.push(`データ抽出エラー: ${error.message}`);
    return result;
  }
}

/**
 * ノード座標にオフセットを適用
 * @param {Object} node - ノード座標
 * @param {Object} element - 要素データ
 * @param {string} prefix - オフセットキープレフィックス（例: 'offset_start_', 'offset_bottom_'）
 * @param {string} [zAxis='z'] - Z軸の適用方式: 'apply' = オフセット適用, 'skip' = 適用しない
 * @returns {Object} オフセット適用後の座標 {x, y, z}
 */
export function applyNodeOffset(node, element, prefix, zAxis = 'apply') {
  const offsetX = element[`${prefix}X`] || 0;
  const offsetY = element[`${prefix}Y`] || 0;
  const offsetZ = zAxis === 'apply' ? element[`${prefix}Z`] || 0 : 0;

  return {
    x: node.x + offsetX,
    y: node.y + offsetY,
    z: node.z + offsetZ,
  };
}

/**
 * 複数ノードのオフセット適用（メッシュ頂点など）
 * @param {Array<number>} nodeIds - ノードID配列
 * @param {Map} nodeMap - ノードマップ
 * @param {Object} element - 要素データ
 * @param {Map|Object} [offsetsSource] - オフセット情報の取得元
 * @param {string} [offsetKeyPrefix] - オフセットキープレフィックス
 * @returns {Array<Object>|null} 頂点座標配列、またはエラー時はnull
 */
export function applyOffsetsToVertices(nodeIds, nodeMap, element, offsetsSource, offsetKeyPrefix) {
  const vertices = [];

  for (const nodeId of nodeIds) {
    const node = nodeMap.get(nodeId);
    if (!node) {
      log.warn(`頂点ノード ${nodeId} が見つかりません`);
      return null;
    }

    let offsetX = 0,
      offsetY = 0,
      offsetZ = 0;
    if (offsetsSource) {
      const offset = offsetsSource.get ? offsetsSource.get(nodeId) : offsetsSource[nodeId];
      if (offset) {
        offsetX = offset[`${offsetKeyPrefix || 'offset_'}X`] || 0;
        offsetY = offset[`${offsetKeyPrefix || 'offset_'}Y`] || 0;
        offsetZ = offset[`${offsetKeyPrefix || 'offset_'}Z`] || 0;
      }
    }

    vertices.push({
      x: node.x + offsetX,
      y: node.y + offsetY,
      z: node.z + offsetZ,
    });
  }

  return vertices;
}

/**
 * SRC造の鉄骨プロファイルを抽出（ビューアと同様に複合断面を出力）
 * SRC造でない、または鉄骨プロファイル未定義の場合は null を返す。
 * @param {Object} section - セクションデータ
 * @param {Map} steelSections - 鋼材断面マップ
 * @returns {Object|null} 鉄骨プロファイル、または該当しない場合は null
 */
export function extractSteelProfile(section, steelSections) {
  if (!section?.isSRC || !section.steelProfile) return null;

  const steelSectionData = {
    dimensions: section.steelProfile.dimensions,
    shapeName: section.shapeName,
  };
  return extractProfileFromSection(steelSectionData, steelSections);
}

/**
 * セクションから寸法値を抽出
 * @param {Object} section - セクションデータ
 * @param {Array<string>} keys - 優先順位付き寸法キー（例: ['D', 'diameter']）
 * @param {*} defaultValue - 見つからない場合のデフォルト値
 * @returns {*} 見つかった寸法値またはデフォルト値
 */
export function extractDimensionFromSection(section, keys, defaultValue) {
  if (!section) return defaultValue;

  for (const key of keys) {
    // トップレベル
    if (section[key] !== undefined) return section[key];
    // dimensions オブジェクト内
    if (section.dimensions && section.dimensions[key] !== undefined) {
      return section.dimensions[key];
    }
  }

  return defaultValue;
}
