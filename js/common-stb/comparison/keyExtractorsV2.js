/**
 * @fileoverview 配置要素比較 V2（Mode 2 & 3）のキー抽出関数
 *
 * keyExtractors.js の V1 版とは**意図的に別物**であり、統合していない:
 * - V1 は「節点位置のみ（Mode 1）」を前提としたキーを生成し、
 *   `COMPARISON_KEY_TYPE.STORY_AXIS_BASED`（所属階・通芯ベース）にも対応する。
 * - V2 は追加引数 `placementMode` を取り、Mode 2（節点位置+オフセット）/
 *   Mode 3（配置位置完全一致: オフセット+回転/厚さ）専用のキーを生成する。
 *   V2 は STORY_AXIS_BASED を扱わない。
 * - V2 は placementMode が未設定 / NODE_POSITION_ONLY / 未知の値のとき
 *   V1 の関数へ委譲する（後方互換）。よって V2 は V1 の上位ラッパであり、
 *   両者を1本化すると Mode 1 の比較キー・返却データ形状が変わって回帰する。
 * - 返却 data の形状も異なる: V1 は name/guid と合成済み `element` オブジェクトを返し、
 *   V2 は startOffset/endOffset/rotate（線分）や perVertexOffsets/thickness（面）と
 *   生の element を返す。
 *
 * comparator.js から分割（ロジックは無変更）。
 *
 * @module common-stb/comparison/keyExtractorsV2
 */

import {
  COMPARISON_KEY_TYPE,
  PLACEMENT_COMPARISON_MODE,
} from '../../config/comparisonKeyConfig.js';
import { DEFAULT_PILE_LENGTH } from '../../config/geometryConfig.js';

// キー生成関数をインポート
import {
  getAttr,
  getLineElementKeyMode2,
  getLineElementKeyMode3,
  getPolyElementKeyPerVertexMode2,
  getPolyElementKeyPerVertexMode3,
} from './keyGenerator.js';

import {
  isGeometryCenterDirectionKeyType,
  appendSectionSignature,
  extractPolygonNodeIds,
} from './keyExtractorUtils.js';
import { lineElementKeyExtractor, polyElementKeyExtractor } from './keyExtractors.js';
import { createLogger } from '../../utils/logger.js';

// ログ名前空間は分割前（comparator.js）のまま維持する（ns フィルタ互換のため）
const log = createLogger('common-stb:comparison:comparator');

// --- バージョン対応比較関数 ---
// ============================================
// 配置要素比較 V2（Mode 2 & 3）キー抽出
// ============================================

/**
 * 線分要素（Mode 2/3対応）からキーと関連データを抽出
 *
 * V1 の `lineElementKeyExtractor` との違い（統合してはいけない理由）:
 * - 引数に `placementMode` が入るためシグネチャが異なる。
 * - Mode 2 は始終点オフセットを、Mode 3 はさらに `rotate` を含めたキーを生成する。
 * - V1 が対応する `COMPARISON_KEY_TYPE.STORY_AXIS_BASED`（`options.storyAxisLookup`）は扱わない。
 * - 返却 data に startOffset / endOffset / rotate を含み、`element` は生の要素
 *   （V1 は name/guid と合成済みの element オブジェクトを返す）。
 * - Mode 1・未設定・未知モードでは V1 にそのまま委譲する。
 *
 * @param {Element} element - 線分要素
 * @param {Map} nodeMap - ノードマップ
 * @param {string} idStartAttr - 始点属性名
 * @param {string} idEndAttr - 終点属性名
 * @param {string} placementMode - 配置比較モード (NODE_POSITION_ONLY | NODE_POSITION_WITH_OFFSET | PLACEMENT_POSITION_COMPLETE)
 * @param {string} [keyType] - 比較キータイプ
 * @param {Object} [options={}] - オプション
 * @returns {{key: string|null, data: object|null}}
 */
export function lineElementKeyExtractorV2(
  element,
  nodeMap,
  idStartAttr,
  idEndAttr,
  placementMode,
  keyType = COMPARISON_KEY_TYPE.POSITION_NODE_ONLY,
  options = {},
) {
  // Mode 1（NODE_POSITION_ONLY）またはモード未設定はMode 1の関数に委譲（後方互換）
  if (
    !placementMode ||
    placementMode === PLACEMENT_COMPARISON_MODE.NODE_POSITION_ONLY ||
    !Object.values(PLACEMENT_COMPARISON_MODE).includes(placementMode)
  ) {
    return lineElementKeyExtractor(element, nodeMap, idStartAttr, idEndAttr, keyType, options);
  }

  let startId = getAttr(element, idStartAttr);
  let endId = getAttr(element, idEndAttr);
  const elementId = getAttr(element, 'id');
  let startCoords = nodeMap.get(startId);
  let endCoords = nodeMap.get(endId);

  // オフセット値を抽出
  const startOffsetX = parseFloat(getAttr(element, 'offset_start_X')) || 0;
  const startOffsetY = parseFloat(getAttr(element, 'offset_start_Y')) || 0;
  const startOffsetZ = parseFloat(getAttr(element, 'offset_start_Z')) || 0;
  const endOffsetX = parseFloat(getAttr(element, 'offset_end_X')) || 0;
  const endOffsetY = parseFloat(getAttr(element, 'offset_end_Y')) || 0;
  const endOffsetZ = parseFloat(getAttr(element, 'offset_end_Z')) || 0;
  const rotate = getAttr(element, 'rotate') || 0;

  const startOffset = { x: startOffsetX, y: startOffsetY, z: startOffsetZ };
  const endOffset = { x: endOffsetX, y: endOffsetY, z: endOffsetZ };

  // 座標取得失敗時の処理（1-node format等）
  // startAttr に 'id_node' を渡す呼び出し（基礎の描画設定）でも発動するよう、
  // !startId && !endId ではなく単一ノード属性 id_node の有無で判定する。
  const idNode = getAttr(element, 'id_node');
  if ((!startCoords || !endCoords) && idNode) {
    const levelTop = getAttr(element, 'level_top');
    const levelBottom = getAttr(element, 'level_bottom');

    if (idNode && levelTop && nodeMap.has(idNode)) {
      const topNode = nodeMap.get(idNode);
      const offsetX = parseFloat(getAttr(element, 'offset_X')) || 0;
      const offsetY = parseFloat(getAttr(element, 'offset_Y')) || 0;
      const levelTopValue = parseFloat(levelTop);
      const defaultPileLength = DEFAULT_PILE_LENGTH;

      const topZ = topNode.z + levelTopValue;
      endCoords = {
        x: topNode.x + offsetX,
        y: topNode.y + offsetY,
        z: topZ,
      };

      startCoords = {
        x: endCoords.x,
        y: endCoords.y,
        z: topZ - defaultPileLength,
      };

      startId = `${idNode}_bottom`;
      endId = idNode;
    } else if (idNode && levelBottom !== null && nodeMap.has(idNode)) {
      const refNode = nodeMap.get(idNode);
      const offsetX = parseFloat(getAttr(element, 'offset_X')) || 0;
      const offsetY = parseFloat(getAttr(element, 'offset_Y')) || 0;
      const levelBottomValue = parseFloat(levelBottom) || 0;

      // level_bottom はノードZからの相対オフセット（V1 lineElementKeyExtractor と統一）
      startCoords = {
        x: refNode.x + offsetX,
        y: refNode.y + offsetY,
        z: refNode.z + levelBottomValue,
      };

      endCoords = {
        x: refNode.x + offsetX,
        y: refNode.y + offsetY,
        z: refNode.z,
      };

      startId = `${idNode}_bottom`;
      endId = idNode;
    }
  }

  if (startCoords && endCoords) {
    let baseKey = null;

    if (isGeometryCenterDirectionKeyType(keyType)) {
      baseKey = 'geometry:line';
    } else if (placementMode === PLACEMENT_COMPARISON_MODE.NODE_POSITION_WITH_OFFSET) {
      baseKey = getLineElementKeyMode2(startCoords, startOffset, endCoords, endOffset);
    } else if (placementMode === PLACEMENT_COMPARISON_MODE.PLACEMENT_POSITION_COMPLETE) {
      baseKey = getLineElementKeyMode3(startCoords, startOffset, endCoords, endOffset, rotate);
    }

    if (baseKey !== null) {
      // Mode 1 と同様に断面シグネチャをキーへ付加する（断面一致基準をオフセット/回転モードでも尊重）
      const sectionSignature =
        typeof options.sectionSignatureResolver === 'function'
          ? options.sectionSignatureResolver(element)
          : null;

      return {
        key: appendSectionSignature(baseKey, sectionSignature),
        data: {
          startCoords,
          endCoords,
          startOffset,
          endOffset,
          rotate,
          id: elementId,
          // 許容差フォールバックで断面キー部の一致を検証するために保持
          sectionSignature: sectionSignature ?? undefined,
          element,
          rawElement: element,
        },
      };
    }
  }

  return { key: null, data: null };
}

/**
 * ポリゴン要素から StbSlabOffsetList / StbWallOffsetList を解析し、
 * 「ノードID → {x,y,z} オフセット」のMapを返す。
 *
 * @param {Element} element - 床または壁のXML要素
 * @returns {Map<string, {x: number, y: number, z: number}>}
 */
function extractPerVertexOffsetMap(element) {
  const map = new Map();
  if (!element || typeof element.getElementsByTagName !== 'function') return map;

  // 床(StbSlabOffsetList) と 壁(StbWallOffsetList) の両方をサポート
  for (const listTag of ['StbSlabOffsetList', 'StbWallOffsetList']) {
    const lists = element.getElementsByTagName(listTag);
    if (!lists || lists.length === 0) continue;

    const itemTag = listTag.replace('List', ''); // StbSlabOffset / StbWallOffset
    for (const list of Array.from(lists)) {
      const items =
        typeof list.getElementsByTagName === 'function' ? list.getElementsByTagName(itemTag) : [];
      for (const item of Array.from(items)) {
        const nodeId = getAttr(item, 'id_node');
        if (!nodeId) continue;
        map.set(String(nodeId), {
          x: parseFloat(getAttr(item, 'offset_X')) || 0,
          y: parseFloat(getAttr(item, 'offset_Y')) || 0,
          z: parseFloat(getAttr(item, 'offset_Z')) || 0,
        });
      }
    }
  }
  return map;
}

/**
 * ポリゴン要素（Mode 2/3対応）からキーと関連データを抽出
 *
 * 床(StbSlab)・壁(StbWall) の StbSlabOffsetList / StbWallOffsetList を解析し、
 * 「節点ごとのオフセット」を加算した最終頂点座標で比較キーを生成する。
 * これにより、節点を移動した表現と、節点+オフセットで表現したものが
 * 最終ジオメトリ的に等価であれば同一判定される。
 *
 * V1 の `polyElementKeyExtractor` との違い（統合してはいけない理由）:
 * - 引数に `placementMode` が入るためシグネチャが異なる。
 * - 節点ごとのオフセットリストを解析し、Mode 2 はオフセット込み、
 *   Mode 3 はさらに thickness を含めたキーを生成する。
 * - V1 が対応する `COMPARISON_KEY_TYPE.STORY_AXIS_BASED`（`options.storyAxisLookup`）は扱わない。
 * - 返却 data に perVertexOffsets / thickness を含む。
 * - Mode 1・未設定・未知モードでは V1 にそのまま委譲する。
 *
 * @param {Element} element - ポリゴン要素
 * @param {Map} nodeMap - ノードマップ
 * @param {string} nodeOrderTag - ノード順序タグ名
 * @param {string} placementMode - 配置比較モード
 * @param {string} [keyType] - 比較キータイプ
 * @param {Object} [options={}] - オプション
 * @returns {{key: string|null, data: object|null}}
 */
export function polyElementKeyExtractorV2(
  element,
  nodeMap,
  nodeOrderTag,
  placementMode,
  keyType = COMPARISON_KEY_TYPE.POSITION_NODE_ONLY,
  options = {},
) {
  // Mode 1（NODE_POSITION_ONLY）またはモード未設定はMode 1の関数に委譲（後方互換）
  if (
    !placementMode ||
    placementMode === PLACEMENT_COMPARISON_MODE.NODE_POSITION_ONLY ||
    !Object.values(PLACEMENT_COMPARISON_MODE).includes(placementMode)
  ) {
    return polyElementKeyExtractor(element, nodeMap, nodeOrderTag, keyType, options);
  }

  const elementId = getAttr(element, 'id');
  const name = getAttr(element, 'name');
  const guid = getAttr(element, 'guid');

  // ノード順序タグからノードIDリストを取得（Mode 1と同一の抽出ロジック）
  const nodeIds = extractPolygonNodeIds(element, nodeOrderTag);
  if (nodeIds) {
    // 節点ごとオフセット (StbSlabOffsetList / StbWallOffsetList)
    const offsetByNode = extractPerVertexOffsetMap(element);

    // 厚さ（Mode 3で使用）
    const thickness = getAttr(element, 'thickness') || 0;

    // 各頂点座標を取得
    const vertexCoordsList = nodeIds.map((nodeId) => nodeMap.get(String(nodeId))).filter((c) => c);

    if (vertexCoordsList.length === nodeIds.length && vertexCoordsList.length >= 3) {
      const perVertexOffsets = nodeIds.map((nodeId) => offsetByNode.get(String(nodeId)) || null);
      let baseKey = null;
      if (isGeometryCenterDirectionKeyType(keyType)) {
        baseKey = 'geometry:polygon';
      } else if (placementMode === PLACEMENT_COMPARISON_MODE.NODE_POSITION_WITH_OFFSET) {
        baseKey = getPolyElementKeyPerVertexMode2(vertexCoordsList, perVertexOffsets);
      } else if (placementMode === PLACEMENT_COMPARISON_MODE.PLACEMENT_POSITION_COMPLETE) {
        baseKey = getPolyElementKeyPerVertexMode3(vertexCoordsList, perVertexOffsets, thickness);
      }

      if (baseKey !== null) {
        // Mode 1 と同様に断面シグネチャをキーへ付加する（断面一致基準をオフセット/回転モードでも尊重）
        const sectionSignature =
          typeof options.sectionSignatureResolver === 'function'
            ? options.sectionSignatureResolver(element)
            : null;

        return {
          key: appendSectionSignature(baseKey, sectionSignature),
          data: {
            vertexCoordsList,
            perVertexOffsets,
            thickness,
            id: elementId,
            name: name || undefined,
            guid: guid || undefined,
            // 許容差フォールバックで断面キー部の一致を検証するために保持
            sectionSignature: sectionSignature ?? undefined,
            element,
            rawElement: element,
          },
        };
      }
    } else {
      log.warn(
        `[Data] 面要素(V2): ノード座標不足 (id=${elementId}, nodes=${nodeIds.length}, found=${vertexCoordsList.length})`,
      );
    }
  } else {
    log.warn(`[Data] 面要素(V2): ノード順序タグが不足 (id=${elementId}, tag=${nodeOrderTag})`);
  }

  return { key: null, data: null };
}
