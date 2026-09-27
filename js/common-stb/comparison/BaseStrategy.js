/**
 * @fileoverview 比較戦略の基底クラス
 *
 * モデル要素比較のための戦略パターン実装。
 * 異なる比較ロジック（厳密、許容差、バージョン対応）を統一インターフェースで提供します。
 */

/**
 * 比較結果の型定義
 * @typedef {Object} ComparisonResult
 * @property {Array<{dataA: any, dataB: any}>} matched - 一致した要素ペア
 * @property {Array<{dataA: any, dataB: any}>} [mismatch] - キー一致だが属性不一致の要素ペア
 * @property {Array<any>} onlyA - モデルAのみに存在する要素
 * @property {Array<any>} onlyB - モデルBのみに存在する要素
 */

/**
 * 比較オプションの型定義
 * @typedef {Object} ComparisonOptions
 * @property {string} [keyType] - 比較キータイプ
 * @property {Object} [toleranceConfig] - 許容差設定
 * @property {Object} [versionInfo] - バージョン情報
 * @property {function(any, any): boolean} [attributeComparator] - 属性比較関数（trueで一致）
 * @property {boolean} [classifyNullKeysAsOnly=false] - key=null要素をonlyA/onlyBに分類するか
 */

/**
 * 比較戦略の基底クラス
 * @abstract
 */

import { createLogger } from '../../utils/logger.js';

const log = createLogger('common-stb:comparison:BaseStrategy');

export function evaluateAttributeComparator(attributeComparator, dataA, dataB) {
  if (!attributeComparator) {
    return { matches: true };
  }

  const result = attributeComparator(dataA, dataB);
  if (typeof result === 'boolean') {
    return { matches: result };
  }
  if (result && typeof result === 'object') {
    const matches = result.matches ?? result.isEqual ?? result.match ?? false;
    return { ...result, matches };
  }
  return { matches: Boolean(result) };
}

function createAttributeMismatchPair(dataA, dataB, attributeComparison = {}) {
  return {
    dataA,
    dataB,
    matchType: 'attributeMismatch',
    attributeState: 'mismatch',
    attributeMismatchKind: attributeComparison.attributeMismatchKind || attributeComparison.kind,
    attributeDiffScope: attributeComparison.attributeDiffScope || attributeComparison.scope,
    attributeDiffDetails:
      attributeComparison.attributeDiffDetails || attributeComparison.differences,
  };
}

function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? '';
  } catch (error) {
    return '';
  }
}

function compareByDeterministicSignature(itemA, itemB) {
  const compareResult = String(itemA).localeCompare(String(itemB));
  if (compareResult !== 0) {
    return compareResult;
  }
  return 0;
}

export class BaseStrategy {
  /**
   * 戦略名を取得
   * @returns {string} 戦略名
   */
  get name() {
    return 'base';
  }

  /**
   * 2つの要素リストを比較する
   * @abstract
   * @param {Array<Element>} elementsA - モデルAの要素リスト
   * @param {Array<Element>} elementsB - モデルBの要素リスト
   * @param {Map} nodeMapA - モデルAのノードマップ
   * @param {Map} nodeMapB - モデルBのノードマップ
   * @param {function} keyExtractor - キー抽出関数
   * @param {ComparisonOptions} [options={}] - 比較オプション
   * @returns {ComparisonResult} 比較結果
   */
  compare(elementsA, elementsB, nodeMapA, nodeMapB, keyExtractor, _options = {}) {
    throw new Error('compare() must be implemented by subclass');
  }

  /**
   * 2つの要素データを比較する
   * @abstract
   * @param {Object} dataA - 要素Aのデータ
   * @param {Object} dataB - 要素Bのデータ
   * @param {ComparisonOptions} [options={}] - 比較オプション
   * @returns {Object} 詳細な比較結果
   */
  compareElementData(dataA, dataB, _options = {}) {
    throw new Error('compareElementData() must be implemented by subclass');
  }

  /**
   * この戦略が指定されたオプションに適用可能かどうかを判定
   * @param {ComparisonOptions} options - 比較オプション
   * @returns {boolean} 適用可能な場合true
   */
  isApplicable(_options = {}) {
    return true;
  }
}

/**
 * 基本比較戦略（厳密一致）
 */
export class BasicStrategy extends BaseStrategy {
  get name() {
    return 'basic';
  }

  /**
   * @override
   */
  compare(elementsA, elementsB, nodeMapA, nodeMapB, keyExtractor, options = {}) {
    const { attributeComparator, classifyNullKeysAsOnly = false } = options;
    const keysA = new Map();
    const keysB = new Map();
    const onlyA = [];
    const onlyB = [];
    const matched = [];
    const mismatch = [];
    let nullKeyCountA = 0;
    let nullKeyCountB = 0;

    for (const elementA of elementsA) {
      const { key, data } = keyExtractor(elementA, nodeMapA);
      if (key !== null) {
        if (!keysA.has(key)) {
          keysA.set(key, []);
        }
        keysA.get(key).push(data);
      } else {
        nullKeyCountA++;
        if (classifyNullKeysAsOnly && data !== null) {
          onlyA.push(data);
        }
      }
    }

    for (const elementB of elementsB) {
      const { key, data } = keyExtractor(elementB, nodeMapB);
      if (key !== null) {
        if (!keysB.has(key)) {
          keysB.set(key, []);
        }
        keysB.get(key).push(data);
      } else {
        nullKeyCountB++;
        if (classifyNullKeysAsOnly && data !== null) {
          onlyB.push(data);
        }
      }
    }

    if (nullKeyCountA > 0 || nullKeyCountB > 0) {
      log.warn(
        `[Data] 比較キー未生成の要素: A=${nullKeyCountA}件, B=${nullKeyCountB}件` +
          (classifyNullKeysAsOnly ? ' (onlyA/onlyBに分類)' : ' (除外)'),
      );
    }

    for (const [key, dataAList] of keysA.entries()) {
      const dataBList = keysB.get(key) || [];

      if (attributeComparator && dataAList.length > 0 && dataBList.length > 0) {
        const candidateMatches = [];

        if (dataAList.length === 1 && dataBList.length === 1) {
          const attributeComparison = evaluateAttributeComparator(
            attributeComparator,
            dataAList[0],
            dataBList[0],
          );
          if (!attributeComparison.matches) {
            mismatch.push(
              createAttributeMismatchPair(dataAList[0], dataBList[0], attributeComparison),
            );
          } else {
            matched.push({ dataA: dataAList[0], dataB: dataBList[0] });
          }

          keysB.delete(key);
          continue;
        }

        for (let aIndex = 0; aIndex < dataAList.length; aIndex += 1) {
          for (let bIndex = 0; bIndex < dataBList.length; bIndex += 1) {
            const attributeComparison = evaluateAttributeComparator(
              attributeComparator,
              dataAList[aIndex],
              dataBList[bIndex],
            );
            if (attributeComparison.matches) {
              candidateMatches.push({
                aIndex,
                bIndex,
                aLabel: safeStringify(dataAList[aIndex]),
                bLabel: safeStringify(dataBList[bIndex]),
              });
            }
          }
        }

        const matchedA = new Array(dataAList.length).fill(false);
        const matchedB = new Array(dataBList.length).fill(false);

        candidateMatches.sort((left, right) => {
          const leftA = left.aLabel;
          const rightA = right.aLabel;
          const aCompare = compareByDeterministicSignature(leftA, rightA);
          if (aCompare !== 0) {
            return aCompare;
          }

          const leftB = left.bLabel;
          const rightB = right.bLabel;
          const bCompare = compareByDeterministicSignature(leftB, rightB);
          if (bCompare !== 0) {
            return bCompare;
          }

          return left.aIndex - right.aIndex || left.bIndex - right.bIndex;
        });

        for (const candidate of candidateMatches) {
          if (matchedA[candidate.aIndex] || matchedB[candidate.bIndex]) {
            continue;
          }

          matchedA[candidate.aIndex] = true;
          matchedB[candidate.bIndex] = true;
          matched.push({
            dataA: dataAList[candidate.aIndex],
            dataB: dataBList[candidate.bIndex],
          });
        }

        dataAList.forEach((dataAItem, index) => {
          if (!matchedA[index]) {
            onlyA.push(dataAItem);
          }
        });
        dataBList.forEach((dataBItem, index) => {
          if (!matchedB[index]) {
            onlyB.push(dataBItem);
          }
        });
        keysB.delete(key);
        continue;
      }

      const remainingDataA = [...dataAList];
      const remainingDataB = [...(dataBList || [])];

      while (remainingDataA.length > 0 && remainingDataB.length > 0) {
        const dataBItem = remainingDataB.shift();
        const dataAItem = remainingDataA.shift();

        const attributeComparison = evaluateAttributeComparator(
          attributeComparator,
          dataAItem,
          dataBItem,
        );
        if (!attributeComparison.matches) {
          mismatch.push(createAttributeMismatchPair(dataAItem, dataBItem, attributeComparison));
        } else {
          matched.push({ dataA: dataAItem, dataB: dataBItem });
        }
      }

      onlyA.push(...remainingDataA);
      onlyB.push(...remainingDataB);
      keysB.delete(key);
    }

    for (const remainingDataB of keysB.values()) {
      onlyB.push(...remainingDataB);
    }

    return { matched, mismatch, onlyA, onlyB };
  }

  /**
   * @override
   */
  compareElementData(_dataA, _dataB, _options = {}) {
    // 基本的には同じキーであれば一致とみなす
    return {
      isEqual: true,
      differences: [],
      matchType: 'exact',
    };
  }
}

// 互換性のためのエイリアス
export { BasicStrategy as BasicComparisonStrategy };
