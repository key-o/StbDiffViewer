/**
 * @fileoverview 要素タイプごとの比較キー抽出関数（Mode 1 / V1）
 *
 * 線分要素・ポリゴン要素・節点要素から比較キーと関連データを抽出する。
 * 配置比較モード Mode 2・3（オフセット / 回転を考慮）に対応した派生版は
 * keyExtractorsV2.js に分離されている（統合していない理由は同ファイル冒頭を参照）。
 *
 * comparator.js から分割（ロジックは無変更）。
 *
 * @module common-stb/comparison/keyExtractors
 */

import { COMPARISON_KEY_TYPE } from '../../config/comparisonKeyConfig.js';
import { DEFAULT_PILE_LENGTH } from '../../config/geometryConfig.js';

// キー生成関数をインポート
import {
  getNodeCoordKey,
  getLineElementKey,
  getPolyElementKey,
  getElementKey,
  getAttr,
  getNodeStoryAxisKey,
} from './keyGenerator.js';

import {
  isGeometryCenterDirectionKeyType,
  appendSectionSignature,
  extractPolygonNodeIds,
} from './keyExtractorUtils.js';
import { createLogger } from '../../utils/logger.js';

// ログ名前空間は分割前（comparator.js）のまま維持する（ns フィルタ互換のため）
const log = createLogger('common-stb:comparison:comparator');

// --- 要素タイプごとのキー抽出関数 ---

/*
 * 線分要素（柱、梁など）から比較キーと関連データ（始点・終点座標、要素ID）を抽出する。
 * @param {Element} element - 線分要素のXML要素。
 * @param {Map<string, {x: number, y: number, z: number}>} nodeMap - 対応するノードマップ。
 * @param {string} idStartAttr - 始点ノードIDの属性名。
 * @param {string} idEndAttr - 終点ノードIDの属性名。
 * @param {string} [keyType] - 比較キータイプ（省略時はPOSITION_NODE_ONLY）
 * @param {Object} [options={}] - オプション
 * @param {function} [options.sectionSignatureResolver] - 断面シグネチャ解決関数
 * @param {Map} [options.storyAxisLookup] - 所属階・通芯ルックアップ（STORY_AXIS_BASEDモード用）
 * @returns {{key: string|null, data: {startCoords: object, endCoords: object, id: string}|null}} キーとデータのオブジェクト。
 */
export function lineElementKeyExtractor(
  element,
  nodeMap,
  idStartAttr,
  idEndAttr,
  keyType = COMPARISON_KEY_TYPE.POSITION_NODE_ONLY,
  options = {},
) {
  let startId = getAttr(element, idStartAttr);
  let endId = getAttr(element, idEndAttr);
  const elementId = getAttr(element, 'id');
  let startCoords = nodeMap.get(startId);
  let endCoords = nodeMap.get(endId);

  // 1-node format fallback (Pile: id_node + level_top / Footing: id_node + level_bottom)
  // 2ノード座標が揃わず、かつ単一ノード属性 id_node を持つ要素で発動する。
  // startAttr に 'id_node' を渡す呼び出し（基礎の描画設定）でも startId が truthy に
  // ならないよう、!startId && !endId ではなく id_node の有無で判定する。
  const idNode = getAttr(element, 'id_node');
  if ((!startCoords || !endCoords) && idNode) {
    const levelTop = getAttr(element, 'level_top');
    const levelBottom = getAttr(element, 'level_bottom');

    // Pile: id_node + level_top 形式
    if (idNode && levelTop && nodeMap.has(idNode)) {
      const topNode = nodeMap.get(idNode);
      const offsetX = parseFloat(getAttr(element, 'offset_X')) || 0;
      const offsetY = parseFloat(getAttr(element, 'offset_Y')) || 0;
      const levelTopValue = parseFloat(levelTop);

      // Default pile length for line display (actual length from section data used in 3D)
      const defaultPileLength = DEFAULT_PILE_LENGTH;

      // Calculate top node position (level_top はノードZからの相対オフセット)
      const topZ = topNode.z + levelTopValue;
      endCoords = {
        x: topNode.x + offsetX,
        y: topNode.y + offsetY,
        z: topZ, // ノードZ + level_top が杭天端Z座標
      };

      // Calculate bottom node (top - default pile length)
      startCoords = {
        x: endCoords.x,
        y: endCoords.y,
        z: topZ - defaultPileLength,
      };

      // Use synthetic IDs for 1-node format
      startId = `${idNode}_bottom`;
      endId = idNode;
    }
    // Footing: id_node + level_bottom 形式
    else if (idNode && levelBottom !== null && nodeMap.has(idNode)) {
      const refNode = nodeMap.get(idNode);
      const offsetX = parseFloat(getAttr(element, 'offset_X')) || 0;
      const offsetY = parseFloat(getAttr(element, 'offset_Y')) || 0;
      const levelBottomValue = parseFloat(levelBottom) || 0;

      // Calculate bottom position (level_bottom はノードZからの相対オフセット)
      startCoords = {
        x: refNode.x + offsetX,
        y: refNode.y + offsetY,
        z: refNode.z + levelBottomValue, // ノードZ + level_bottom が下端Z座標
      };

      // Calculate top position (reference node Z)
      endCoords = {
        x: refNode.x + offsetX,
        y: refNode.y + offsetY,
        z: refNode.z, // ノードZが上端Z座標
      };

      // Use synthetic IDs for 1-node format
      startId = `${idNode}_bottom`;
      endId = idNode;
    }
  }

  if (startCoords && endCoords) {
    // 要素の全属性を取得してelement objectを作成
    const elementData = {
      id: elementId,
      [idStartAttr]: startId,
      [idEndAttr]: endId,
    };

    // name属性やその他の属性も取得
    const name = getAttr(element, 'name');
    if (name) elementData.name = name;

    const idSection = getAttr(element, 'id_section');
    if (idSection) elementData.id_section = idSection;

    const kindStructure = getAttr(element, 'kind_structure');
    if (kindStructure) elementData.kind_structure = kindStructure;

    // GUID属性も取得
    const guid = getAttr(element, 'guid');
    if (guid) elementData.guid = guid;

    // キータイプに応じたキー生成
    let baseKey;
    if (keyType === COMPARISON_KEY_TYPE.STORY_AXIS_BASED && options.storyAxisLookup) {
      const startSaKey = getNodeStoryAxisKey(startId, options.storyAxisLookup);
      const endSaKey = getNodeStoryAxisKey(endId, options.storyAxisLookup);
      baseKey = startSaKey && endSaKey ? [startSaKey, endSaKey].sort().join('|') : null;
    } else if (isGeometryCenterDirectionKeyType(keyType)) {
      baseKey = 'geometry:line';
    } else {
      baseKey = getElementKey(element, keyType, () => getLineElementKey(startCoords, endCoords));
    }
    const sectionSignature =
      typeof options.sectionSignatureResolver === 'function'
        ? options.sectionSignatureResolver(element)
        : null;
    const key = appendSectionSignature(baseKey, sectionSignature);

    return {
      key,
      data: {
        startCoords,
        endCoords,
        id: elementId,
        name: name || undefined,
        guid: guid || undefined,
        // 許容差フォールバックで断面キー部の一致を検証するために保持
        sectionSignature: sectionSignature ?? undefined,
        element: elementData,
        rawElement: element,
      },
    };
  }
  log.warn(`[Data] 線分要素: ノード座標が不足 (Start=${startId}, End=${endId}, id=${elementId})`);
  return { key: null, data: null };
}

/*
 * ポリゴン要素（スラブ、壁など）から比較キーと関連データ（頂点座標リスト、要素ID）を抽出する。
 * @param {Element} element - ポリゴン要素のXML要素。
 * @param {Map<string, {x: number, y: number, z: number}>} nodeMap - 対応するノードマップ。
 * @param {string} [nodeOrderTag="StbNodeIdOrder"] - 頂点ノードIDリストが含まれるタグ名。
 * @param {string} [keyType] - 比較キータイプ（省略時はPOSITION_NODE_ONLY）
 * @param {Object} [options={}] - オプション
 * @param {function} [options.sectionSignatureResolver] - 断面シグネチャ解決関数
 * @param {Map} [options.storyAxisLookup] - 所属階・通芯ルックアップ（STORY_AXIS_BASEDモード用）
 * @returns {{key: string|null, data: {vertexCoordsList: Array<object>, id: string}|null}} キーとデータのオブジェクト。
 */
export function polyElementKeyExtractor(
  element,
  nodeMap,
  nodeOrderTag = 'StbNodeIdOrder',
  keyType = COMPARISON_KEY_TYPE.POSITION_NODE_ONLY,
  options = {},
) {
  const elementId = getAttr(element, 'id');

  const nodeIds = extractPolygonNodeIds(element, nodeOrderTag);

  if (nodeIds) {
    const vertexCoordsList = nodeIds
      .map((id) => nodeMap.get(String(id)))
      .filter((coords) => coords);

    if (vertexCoordsList.length === nodeIds.length && vertexCoordsList.length >= 3) {
      const name = getAttr(element, 'name');
      const guid = getAttr(element, 'guid');

      // キータイプに応じたキー生成
      let baseKey;
      if (keyType === COMPARISON_KEY_TYPE.STORY_AXIS_BASED && options.storyAxisLookup) {
        const vertexSaKeys = nodeIds.map((id) =>
          getNodeStoryAxisKey(String(id), options.storyAxisLookup),
        );
        baseKey = vertexSaKeys.every((k) => k !== null) ? vertexSaKeys.sort().join(',') : null;
      } else if (isGeometryCenterDirectionKeyType(keyType)) {
        baseKey = 'geometry:polygon';
      } else {
        baseKey = getElementKey(element, keyType, () => getPolyElementKey(vertexCoordsList));
      }
      const sectionSignature =
        typeof options.sectionSignatureResolver === 'function'
          ? options.sectionSignatureResolver(element)
          : null;
      const key = appendSectionSignature(baseKey, sectionSignature);

      return {
        key,
        data: {
          vertexCoordsList,
          id: elementId,
          name: name || undefined,
          guid: guid || undefined,
          // 許容差フォールバックで断面キー部の一致を検証するために保持
          sectionSignature: sectionSignature ?? undefined,
          element,
          rawElement: element,
        },
      };
    } else {
      log.warn(
        `[Data] 面要素: ノード座標または頂点が不足 (id=${elementId}, nodes=${nodeIds.length}, found=${vertexCoordsList.length})`,
      );
    }
  } else {
    log.warn(`[Data] 面要素: ノード順序タグが不足 (id=${elementId}, tag=${nodeOrderTag})`);
  }
  return { key: null, data: null };
}

/*
 * 節点要素から比較キーと関連データ（座標、ノードID）を抽出する。
 * @param {Element} element - 節点要素のXML要素 (StbNode)。
 * @param {Map<string, {x: number, y: number, z: number}>} nodeMap - 対応するノードマップ。
 * @param {string} [keyType] - 比較キータイプ（省略時はPOSITION_NODE_ONLY）
 * @param {Object} [options={}] - オプション
 * @param {Map} [options.storyAxisLookup] - 所属階・通芯ルックアップ（STORY_AXIS_BASEDモード用）
 * @returns {{key: string|null, data: {coords: object, id: string}|null}} キーとデータのオブジェクト。
 */
export function nodeElementKeyExtractor(
  element,
  nodeMap,
  keyType = COMPARISON_KEY_TYPE.POSITION_NODE_ONLY,
  options = {},
) {
  const nodeId = getAttr(element, 'id');
  const coords = nodeMap.get(nodeId);
  if (coords) {
    const name = getAttr(element, 'name');
    const guid = getAttr(element, 'guid');

    let key;
    if (keyType === COMPARISON_KEY_TYPE.STORY_AXIS_BASED && options.storyAxisLookup) {
      key = getNodeStoryAxisKey(nodeId, options.storyAxisLookup);
    } else {
      key = getElementKey(element, keyType, () => getNodeCoordKey(coords));
    }

    return {
      key,
      data: {
        coords,
        id: nodeId,
        name: name || undefined,
        guid: guid || undefined,
        element: {
          id: nodeId,
          ...(name ? { name } : {}),
          ...(guid ? { guid } : {}),
        },
        rawElement: element,
      },
    };
  }
  return { key: null, data: null };
}
