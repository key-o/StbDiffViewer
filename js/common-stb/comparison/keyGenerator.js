/**
 * @fileoverview 比較キー生成モジュール
 *
 * モデル要素の比較用キー文字列を生成するための関数群。
 * 座標ベースとGUIDベースの両方のキー生成をサポートします。
 */

import { COMPARISON_KEY_TYPE } from '../../config/comparisonKeyConfig.js';
import { COORDINATE_PRECISION } from '../../config/geometryConfig.js';
import { createLogger } from '../../utils/logger.js';
import { readElementAttribute } from '../../data/accessors/elementAttributeAccessor.js';

const log = createLogger('common-stb:comparison:keyGenerator');

const PRECISION = COORDINATE_PRECISION;

/**
 * 座標オブジェクトから比較用のキー文字列を生成する。
 * @param {{x: number, y: number, z: number}} coords - 座標オブジェクト。
 * @param {number} [precision=PRECISION] - キー生成に使用する小数点以下の桁数。
 * @returns {string|null} 生成されたキー文字列、または無効な座標の場合はnull。
 */
export function getNodeCoordKey(coords, precision = PRECISION) {
  if (
    !coords ||
    typeof coords.x !== 'number' ||
    typeof coords.y !== 'number' ||
    typeof coords.z !== 'number'
  ) {
    log.warn('[keyGenerator] キー生成: 無効な座標', coords);
    return null;
  }
  return `${coords.x.toFixed(precision)},${coords.y.toFixed(precision)},${coords.z.toFixed(precision)}`;
}

/**
 * 線分要素（始点・終点座標）から比較用のキー文字列を生成する。
 * @param {{x: number, y: number, z: number}} startCoords - 始点座標。
 * @param {{x: number, y: number, z: number}} endCoords - 終点座標。
 * @param {number} [precision=PRECISION] - 座標キー生成に使用する小数点以下の桁数。
 * @returns {string|null} 生成されたキー文字列、または無効な座標の場合はnull。
 */
export function getLineElementKey(startCoords, endCoords, precision = PRECISION) {
  const startKey = getNodeCoordKey(startCoords, precision);
  const endKey = getNodeCoordKey(endCoords, precision);
  if (startKey === null || endKey === null) return null;
  return [startKey, endKey].sort().join('|');
}

function areCoordsEqual(a, b, epsilon = 1e-6) {
  return (
    Math.abs(a.x - b.x) <= epsilon &&
    Math.abs(a.y - b.y) <= epsilon &&
    Math.abs(a.z - b.z) <= epsilon
  );
}

function areCoordsCollinear(a, b, c, epsilon = 1e-6) {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const bc = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
  const cross = {
    x: ab.y * bc.z - ab.z * bc.y,
    y: ab.z * bc.x - ab.x * bc.z,
    z: ab.x * bc.y - ab.y * bc.x,
  };
  return (
    Math.abs(cross.x) <= epsilon && Math.abs(cross.y) <= epsilon && Math.abs(cross.z) <= epsilon
  );
}

function normalizePolygonCoords(vertexCoordsList) {
  const deduped = [];
  for (const coords of vertexCoordsList) {
    if (!deduped.length || !areCoordsEqual(deduped[deduped.length - 1], coords)) {
      deduped.push(coords);
    }
  }

  if (deduped.length > 1 && areCoordsEqual(deduped[0], deduped[deduped.length - 1])) {
    deduped.pop();
  }

  let changed = true;
  while (changed && deduped.length > 2) {
    changed = false;
    for (let i = 0; i < deduped.length; i++) {
      const prev = deduped[(i - 1 + deduped.length) % deduped.length];
      const curr = deduped[i];
      const next = deduped[(i + 1) % deduped.length];
      if (
        areCoordsEqual(prev, curr) ||
        areCoordsEqual(curr, next) ||
        areCoordsCollinear(prev, curr, next)
      ) {
        deduped.splice(i, 1);
        changed = true;
        break;
      }
    }
  }

  return deduped;
}

/**
 * ポリゴン要素（頂点座標リスト）から比較用のキー文字列を生成する。
 * @param {Array<{x: number, y: number, z: number}>} vertexCoordsList - 頂点座標のリスト。
 * @param {number} [precision=PRECISION] - 座標キー生成に使用する小数点以下の桁数。
 * @returns {string|null} 生成されたキー文字列、または無効な頂点が含まれる場合はnull。
 */
export function getPolyElementKey(vertexCoordsList, precision = PRECISION) {
  if (!vertexCoordsList || vertexCoordsList.length === 0) return null;
  const normalizedCoords = normalizePolygonCoords(vertexCoordsList);
  const coordKeys = normalizedCoords.map((coords) => getNodeCoordKey(coords, precision));
  if (coordKeys.some((key) => key === null)) return null;
  return coordKeys.sort().join(',');
}

/**
 * 要素からプロパティ値を取得する（XML DOM/JSオブジェクト両対応）
 * @param {Element|Object} element - 要素
 * @param {string} attrName - 属性名
 * @returns {string|null} 属性値
 */
export function getAttr(element, attrName) {
  return readElementAttribute(element, attrName);
}

/**
 * 要素のGUID属性からキーを生成する（XML DOM/JSオブジェクト両対応）
 * @param {Element|Object} element - XML要素またはJSオブジェクト
 * @returns {string|null} GUID文字列、またはGUID属性が無い場合はnull
 */
function getGuidKey(element) {
  const guid = getAttr(element, 'guid');
  return guid && guid.trim() !== '' ? guid.trim() : null;
}

/**
 * ノードIDから所属階・所属通芯名に基づく比較用キー文字列を生成する。
 * @param {string} nodeId - ノードID。
 * @param {Map<string, {storyName: string|null, axisNames: string[]}>} storyAxisLookup - 所属情報ルックアップ。
 * @returns {string|null} 生成されたキー文字列、または所属情報が無い場合はnull。
 */
export function getNodeStoryAxisKey(nodeId, storyAxisLookup) {
  if (!storyAxisLookup || !nodeId) return null;
  const info = storyAxisLookup.get(String(nodeId));
  if (!info) return null;

  const storyPart = info.storyName || '';
  const axisPart = [...info.axisNames].sort().join(',');

  // 階名も通芯名も無い場合はキー生成不可
  if (!storyPart && !axisPart) return null;

  return `sa:${storyPart}|${axisPart}`;
}

/**
 * 要素から比較キーを生成する（キータイプに応じて位置ベースまたはGUIDベース）
 * @param {Element} element - XML要素
 * @param {string} keyType - 比較キータイプ（COMPARISON_KEY_TYPE.POSITION_NODE_ONLY 等の位置情報系 または GUID_BASED）
 * @param {function} positionKeyGenerator - 位置ベースのキー生成関数
 * @returns {string|null} 生成されたキー文字列、GUIDモードでGUIDが無い場合はnull
 */
export function getElementKey(element, keyType, positionKeyGenerator) {
  if (keyType === COMPARISON_KEY_TYPE.GUID_BASED) {
    const guidKey = getGuidKey(element);
    if (guidKey !== null) {
      return `guid:${guidKey}`;
    }
    // GUIDモードでGUIDが無い要素は比較対象から除外（nullを返す）
    // これにより、GUIDが無い要素は「Aのみ」または「Bのみ」として分類される
    return null;
  }

  // 位置ベースのキー生成（位置情報系キータイプ および STORY_AXIS_BASED のフォールバック）
  return positionKeyGenerator();
}

// ============================================
// 配置要素比較モード: Mode 2 & 3 キー生成
// ============================================

/**
 * 座標にオフセットを加算する（3軸）
 * @param {{x: number, y: number, z: number}} coords - 基準座標
 * @param {{x?: number, y?: number, z?: number}} offset - オフセット値
 * @returns {{x: number, y: number, z: number}} オフセット後の座標
 */
export function addOffsetToCoords(coords, offset = {}) {
  if (!coords) return null;
  return {
    x: coords.x + (offset?.x || 0),
    y: coords.y + (offset?.y || 0),
    z: coords.z + (offset?.z || 0),
  };
}

/**
 * 回転角をキー文字列にフォーマットする
 * @param {number|string} rotate - 回転角（度）
 * @param {number} [precision=PRECISION] - 小数桁数
 * @returns {string} フォーマットされた回転角文字列
 */
export function formatRotateForKey(rotate, precision = PRECISION) {
  const rotVal = parseFloat(rotate) || 0;
  return rotVal.toFixed(precision);
}

/**
 * 線分要素（ノード + オフセット）から比較キーを生成（Mode 2）
 * @param {{x: number, y: number, z: number}} startCoords - 始点座標（ノード座標）
 * @param {{x?: number, y?: number, z?: number}} startOffset - 始点オフセット (offset_start_X/Y/Z)
 * @param {{x: number, y: number, z: number}} endCoords - 終点座標（ノード座標）
 * @param {{x?: number, y?: number, z?: number}} endOffset - 終点オフセット (offset_end_X/Y/Z)
 * @param {number} [precision=PRECISION] - キー生成に使用する小数点以下の桁数
 * @returns {string|null} 生成されたキー文字列、または無効な座標の場合はnull
 */
export function getLineElementKeyMode2(
  startCoords,
  startOffset,
  endCoords,
  endOffset,
  precision = PRECISION,
) {
  // オフセット適用後の絶対座標を計算
  const startAbsCoords = addOffsetToCoords(startCoords, startOffset);
  const endAbsCoords = addOffsetToCoords(endCoords, endOffset);

  if (!startAbsCoords || !endAbsCoords) return null;

  const startKey = getNodeCoordKey(startAbsCoords, precision);
  const endKey = getNodeCoordKey(endAbsCoords, precision);

  if (startKey === null || endKey === null) return null;
  return [startKey, endKey].sort().join('|');
}

/**
 * 線分要素（ノード + オフセット + 回転角）から比較キーを生成（Mode 3）
 * @param {{x: number, y: number, z: number}} startCoords - 始点座標（ノード座標）
 * @param {{x?: number, y?: number, z?: number}} startOffset - 始点オフセット
 * @param {{x: number, y: number, z: number}} endCoords - 終点座標（ノード座標）
 * @param {{x?: number, y?: number, z?: number}} endOffset - 終点オフセット
 * @param {number|string} rotate - 回転角（度）
 * @param {number} [precision=PRECISION] - キー生成に使用する小数点以下の桁数
 * @returns {string|null} 生成されたキー文字列、または無効な座標の場合はnull
 */
export function getLineElementKeyMode3(
  startCoords,
  startOffset,
  endCoords,
  endOffset,
  rotate,
  precision = PRECISION,
) {
  // Mode 2 のキーを取得
  const baseKey = getLineElementKeyMode2(startCoords, startOffset, endCoords, endOffset, precision);
  if (baseKey === null) return null;

  // 回転角を追加
  const rotateKey = formatRotateForKey(rotate, precision);
  return `${baseKey}|rot:${rotateKey}`;
}

/**
 * ポリゴン要素（頂点 + オフセット）から比較キーを生成（Mode 2）
 * @param {Array<{x: number, y: number, z: number}>} vertexCoordsList - 頂点座標リスト
 * @param {{x?: number, y?: number, z?: number}} [levelOffset={}] - 厚さまたはレベルオフセット
 * @param {number} [precision=PRECISION] - キー生成に使用する小数点以下の桁数
 * @returns {string|null} 生成されたキー文字列、または無効な頂点が含まれる場合はnull
 */
export function getPolyElementKeyMode2(vertexCoordsList, levelOffset = {}, precision = PRECISION) {
  if (!vertexCoordsList || vertexCoordsList.length === 0) return null;

  // 各頂点にレベルオフセットを適用
  const offsetCoordsList = vertexCoordsList.map((coords) => addOffsetToCoords(coords, levelOffset));

  const normalizedCoords = normalizePolygonCoords(offsetCoordsList);
  const coordKeys = normalizedCoords.map((coords) => getNodeCoordKey(coords, precision));

  if (coordKeys.some((key) => key === null)) return null;
  return coordKeys.sort().join(',');
}

/**
 * ポリゴン要素（頂点 + オフセット + 厚さ）から比較キーを生成（Mode 3）
 * @param {Array<{x: number, y: number, z: number}>} vertexCoordsList - 頂点座標リスト
 * @param {{x?: number, y?: number, z?: number}} [levelOffset={}] - レベルオフセット
 * @param {number|string} [thickness=''] - 厚さ値
 * @param {number} [precision=PRECISION] - キー生成に使用する小数点以下の桁数
 * @returns {string|null} 生成されたキー文字列、または無効な頂点が含まれる場合はnull
 */
export function getPolyElementKeyMode3(
  vertexCoordsList,
  levelOffset = {},
  thickness = '',
  precision = PRECISION,
) {
  // Mode 2 のキーを取得
  const baseKey = getPolyElementKeyMode2(vertexCoordsList, levelOffset, precision);
  if (baseKey === null) return null;

  // 厚さを追加
  const thicknessVal = parseFloat(thickness) || 0;
  const thicknessKey = thicknessVal.toFixed(precision);
  return `${baseKey}|thick:${thicknessKey}`;
}

/**
 * 頂点ごとのオフセットを各頂点座標に適用した「最終頂点座標リスト」を計算する。
 * 床(StbSlabOffsetList)・壁(StbWallOffsetList)で頂点ごとに offset_X/Y/Z が
 * 定義される場合のための専用ヘルパー。
 *
 * @param {Array<{x: number, y: number, z: number}>} vertexCoordsList - 各節点の基本座標
 * @param {Array<{x?: number, y?: number, z?: number}|null|undefined>} perVertexOffsets
 *        - vertexCoordsList と同じ長さの配列。各要素は対応頂点のオフセット (または null)
 * @returns {Array<{x: number, y: number, z: number}>|null} 最終頂点座標。長さ不一致なら null。
 */
export function applyPerVertexOffsets(vertexCoordsList, perVertexOffsets) {
  if (!Array.isArray(vertexCoordsList) || !Array.isArray(perVertexOffsets)) return null;
  if (vertexCoordsList.length !== perVertexOffsets.length) return null;

  return vertexCoordsList.map((coords, i) => addOffsetToCoords(coords, perVertexOffsets[i]));
}

/**
 * ポリゴン要素（頂点ごとのオフセット適用）から比較キーを生成 (Mode 2)。
 * 床・壁の StbSlabOffsetList / StbWallOffsetList を反映した最終ジオメトリで比較する。
 *
 * @param {Array<{x: number, y: number, z: number}>} vertexCoordsList - 各節点の基本座標
 * @param {Array<{x?: number, y?: number, z?: number}|null>} perVertexOffsets - 頂点ごとのオフセット
 * @param {number} [precision=PRECISION] - キー精度
 * @returns {string|null} 生成されたキー文字列
 */
export function getPolyElementKeyPerVertexMode2(
  vertexCoordsList,
  perVertexOffsets,
  precision = PRECISION,
) {
  const finalCoords = applyPerVertexOffsets(vertexCoordsList, perVertexOffsets);
  if (!finalCoords) return null;
  return getPolyElementKey(finalCoords, precision);
}

/**
 * ポリゴン要素（頂点ごとのオフセット + 厚さ）から比較キーを生成 (Mode 3)。
 *
 * @param {Array<{x: number, y: number, z: number}>} vertexCoordsList
 * @param {Array<{x?: number, y?: number, z?: number}|null>} perVertexOffsets
 * @param {number|string} [thickness='']
 * @param {number} [precision=PRECISION]
 * @returns {string|null}
 */
export function getPolyElementKeyPerVertexMode3(
  vertexCoordsList,
  perVertexOffsets,
  thickness = '',
  precision = PRECISION,
) {
  const baseKey = getPolyElementKeyPerVertexMode2(vertexCoordsList, perVertexOffsets, precision);
  if (baseKey === null) return null;

  const thicknessVal = parseFloat(thickness) || 0;
  const thicknessKey = thicknessVal.toFixed(precision);
  return `${baseKey}|thick:${thicknessKey}`;
}
