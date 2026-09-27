/**
 * @fileoverview 要素比較のコア関数（戦略への委譲）
 *
 * comparator.js から分割（ロジックは無変更）。
 *
 * @module common-stb/comparison/comparisonCore
 */

import { COMPARISON_KEY_TYPE } from '../../config/comparisonKeyConfig.js';
import { getToleranceConfig } from '../../config/toleranceConfig.js';

// 比較戦略をインポート
import { BasicStrategy } from './BaseStrategy.js';
import { SpatialIndexedToleranceStrategy } from './SpatialIndexedToleranceStrategy.js';

// 戦略インスタンス
const basicStrategy = new BasicStrategy();
const toleranceStrategy = new SpatialIndexedToleranceStrategy();

// --- 要素比較ロジック ---
/**
 * 2つの要素リスト（モデルAとB）を比較し、一致、Aのみ、Bのみの要素を分類する。
 * @param {Array<Element>} elementsA - モデルAの要素リスト。
 * @param {Array<Element>} elementsB - モデルBの要素リスト。
 * @param {Map<string, {x: number, y: number, z: number}>} nodeMapA - モデルAのノードマップ。
 * @param {Map<string, {x: number, y: number, z: number}>} nodeMapB - モデルBのノードマップ。
 * @param {function(Element, Map): {key: string|null, data: any}} keyExtractor - 要素から比較キーと関連データを抽出する関数。
 * @param {Object} [options={}] - 比較オプション（attributeComparator等）
 * @returns {{matched: Array<{dataA: any, dataB: any}>, mismatch: Array<{dataA: any, dataB: any}>, onlyA: Array<any>, onlyB: Array<any>}} 比較結果オブジェクト。
 */
export function compareElements(
  elementsA,
  elementsB,
  nodeMapA,
  nodeMapB,
  keyExtractor,
  options = {},
) {
  // BasicStrategyに委譲
  return basicStrategy.compare(elementsA, elementsB, nodeMapA, nodeMapB, keyExtractor, options);
}

/**
 * 許容差を考慮した要素比較
 * @param {Array<Element>} elementsA - モデルAの要素リスト
 * @param {Array<Element>} elementsB - モデルBの要素リスト
 * @param {Map} nodeMapA - モデルAのノードマップ
 * @param {Map} nodeMapB - モデルBのノードマップ
 * @param {function} keyExtractor - キー抽出関数
 * @param {Object} [toleranceConfig] - 許容差設定（省略時は現在の設定を使用）
 * @returns {Object} 拡張された比較結果
 */
export function compareElementsWithTolerance(
  elementsA,
  elementsB,
  nodeMapA,
  nodeMapB,
  keyExtractor,
  toleranceConfig = null,
  keyType = COMPARISON_KEY_TYPE.POSITION_NODE_ONLY,
  strategyOptions = {},
) {
  // ToleranceStrategyに委譲
  return toleranceStrategy.compare(elementsA, elementsB, nodeMapA, nodeMapB, keyExtractor, {
    toleranceConfig: toleranceConfig || getToleranceConfig(),
    keyType,
    ...strategyOptions,
  });
}
