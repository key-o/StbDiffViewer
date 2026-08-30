/**
 * @fileoverview 比較キー抽出の共有ヘルパー
 *
 * keyExtractors.js（Mode 1 / V1）と keyExtractorsV2.js（Mode 2・3 / V2）の
 * 双方から使用する内部ユーティリティ。comparator.js から分割。
 *
 * @module common-stb/comparison/keyExtractorUtils
 */

import { COMPARISON_KEY_TYPE } from '../../config/comparisonKeyConfig.js';

// --- 定数 ---
const STB_NAMESPACE = 'https://www.building-smart.or.jp/dl'; // ST-Bridge 名前空間 (stbParserと重複するが、独立性のため保持)

export function isGeometryCenterDirectionKeyType(keyType) {
  return keyType === COMPARISON_KEY_TYPE.GEOMETRY_CENTER_DIRECTION_BASED;
}

export function appendSectionSignature(baseKey, sectionSignature) {
  return baseKey && sectionSignature ? `${baseKey}|sec:${sectionSignature}` : baseKey;
}

/**
 * ポリゴン要素から頂点ノードIDリストを抽出する。
 * ST-Bridge 2.x のテキスト形式（<StbNodeIdOrder>1 2 3 4</StbNodeIdOrder>）と
 * JSオブジェクト形式（element.node_ids 配列）の両方をサポートする。
 * 解決順: ①NS付きDOM検索 → ②非NS DOM検索（ST-Bridge 1.x / モック用）→ ③node_ids 配列。
 * 頂点数の下限（ポリゴンとして>=3）の検証は呼び出し側が行う。
 * @param {Element|Object} element - ポリゴン要素（XML DOMまたはJSオブジェクト）。
 * @param {string} nodeOrderTag - 頂点ノードIDリストが含まれるタグ名。
 * @returns {Array<string>|null} ノードID文字列の配列、取得できない場合はnull。
 */
export function extractPolygonNodeIds(element, nodeOrderTag) {
  if (!element) return null;

  let orderElem = null;
  if (typeof element.getElementsByTagNameNS === 'function') {
    orderElem = element.getElementsByTagNameNS(STB_NAMESPACE, nodeOrderTag)[0] || null;
  }
  if (!orderElem && typeof element.getElementsByTagName === 'function') {
    orderElem = element.getElementsByTagName(nodeOrderTag)[0] || null;
  }
  if (orderElem && typeof orderElem.textContent === 'string') {
    const text = orderElem.textContent.trim();
    if (text) {
      return text.split(/\s+/);
    }
  }

  // JSオブジェクト形式
  if (Array.isArray(element.node_ids) && element.node_ids.length > 0) {
    return element.node_ids.map(String);
  }

  return null;
}
