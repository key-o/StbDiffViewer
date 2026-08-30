/**
 * @fileoverview 重要度を考慮した要素比較・集計
 *
 * comparator.js から分割（ロジックは無変更）。
 *
 * @module common-stb/comparison/importanceComparison
 */

import { IMPORTANCE_LEVELS, IMPORTANCE_LEVEL_NAMES } from '../../constants/importanceLevels.js';
import { compareElements } from './comparisonCore.js';

// --- 重要度を考慮した比較機能 ---

/**
 * 要素リストを重要度でフィルタリングする
 * @param {Array<Element>} elements - 要素リスト
 * @param {string} elementType - 要素タイプ
 * @param {string[]} targetLevels - 対象とする重要度レベルの配列
 * @param {Function} lookupFn - 重要度判定関数 (element, elementType) => level
 * @returns {Array<Element>} フィルタリングされた要素リスト
 */
function filterElementsByImportance(elements, elementType, targetLevels, lookupFn) {
  if (!lookupFn || !targetLevels || targetLevels.length === 0) {
    return elements;
  }

  return elements.filter((element) => {
    const importance = lookupFn(element, elementType);
    return targetLevels.includes(importance);
  });
}

/*
 * 重要度を考慮した要素比較（compareElementsの拡張版）
 * @param {Array<Element>} elementsA - モデルAの要素リスト
 * @param {Array<Element>} elementsB - モデルBの要素リスト
 * @param {Map<string, {x: number, y: number, z: number}>} nodeMapA - モデルAのノードマップ
 * @param {Map<string, {x: number, y: number, z: number}>} nodeMapB - モデルBのノードマップ
 * @param {function(Element, Map): {key: string|null, data: any}} keyExtractor - キー抽出関数
 * @param {string} elementType - 要素タイプ
 * @param {Object} options - オプション設定
 * @param {string[]} [options.targetImportanceLevels] - 対象重要度レベル
 * @param {boolean} [options.includeImportanceInfo=true] - 重要度情報を結果に含めるか
 * @param {Function} [options.importanceLookup] - 重要度判定関数 (element, elementType) => level
 * @returns {{matched: Array, onlyA: Array, onlyB: Array, importanceStats: Object}} 重要度を考慮した比較結果
 */
export function compareElementsWithImportance(
  elementsA,
  elementsB,
  nodeMapA,
  nodeMapB,
  keyExtractor,
  elementType,
  options = {},
) {
  const {
    targetImportanceLevels = null,
    includeImportanceInfo = true,
    importanceLookup = null,
    compareOptions = {},
  } = options;

  // 重要度フィルタリング
  let filteredElementsA = elementsA;
  let filteredElementsB = elementsB;

  if (targetImportanceLevels) {
    filteredElementsA = filterElementsByImportance(
      elementsA,
      elementType,
      targetImportanceLevels,
      importanceLookup,
    );
    filteredElementsB = filterElementsByImportance(
      elementsB,
      elementType,
      targetImportanceLevels,
      importanceLookup,
    );
  }

  // 基本的な比較を実行
  const basicResult = compareElements(
    filteredElementsA,
    filteredElementsB,
    nodeMapA,
    nodeMapB,
    keyExtractor,
    compareOptions,
  );

  // 重要度情報を付加
  if (includeImportanceInfo) {
    const addImportanceInfo = (items, modelType) => {
      return items.map((item) => {
        let element;
        if (modelType === 'matched') {
          // matchedの場合、dataAから要素を取得
          element = item.dataA.element || null;
        } else {
          // onlyA, onlyBの場合
          element = item.element || null;
        }

        const importance =
          element && typeof importanceLookup === 'function'
            ? importanceLookup(element, elementType)
            : IMPORTANCE_LEVELS.OPTIONAL;

        return {
          ...item,
          importance,
          importanceName: IMPORTANCE_LEVEL_NAMES[importance],
        };
      });
    };

    basicResult.matched = addImportanceInfo(basicResult.matched, 'matched');
    basicResult.onlyA = addImportanceInfo(basicResult.onlyA, 'onlyA');
    basicResult.onlyB = addImportanceInfo(basicResult.onlyB, 'onlyB');
  }

  // 重要度別統計情報を生成
  const importanceStats = generateImportanceStatistics(basicResult, elementType);

  return {
    ...basicResult,
    importanceStats,
    elementType,
    filterSettings: {
      targetImportanceLevels,
      totalElementsA: elementsA.length,
      totalElementsB: elementsB.length,
      filteredElementsA: filteredElementsA.length,
      filteredElementsB: filteredElementsB.length,
    },
  };
}

/**
 * 比較結果から重要度別統計情報を生成する
 * @param {Object} comparisonResult - 比較結果
 * @param {string} elementType - 要素タイプ
 * @returns {Object} 重要度別統計情報
 */
function generateImportanceStatistics(comparisonResult, elementType) {
  const stats = {
    elementType,
    byImportance: {},
    summary: {
      totalMatched: comparisonResult.matched.length,
      totalOnlyA: comparisonResult.onlyA.length,
      totalOnlyB: comparisonResult.onlyB.length,
      totalDifferences: comparisonResult.onlyA.length + comparisonResult.onlyB.length,
    },
  };

  // 重要度レベル別の初期化
  for (const level of Object.values(IMPORTANCE_LEVELS)) {
    stats.byImportance[level] = {
      matched: 0,
      onlyA: 0,
      onlyB: 0,
      differences: 0,
    };
  }

  // 統計を集計
  const countByImportance = (items, category) => {
    items.forEach((item) => {
      const importance = item.importance || IMPORTANCE_LEVELS.OPTIONAL;
      stats.byImportance[importance][category]++;
      if (category !== 'matched') {
        stats.byImportance[importance].differences++;
      }
    });
  };

  countByImportance(comparisonResult.matched, 'matched');
  countByImportance(comparisonResult.onlyA, 'onlyA');
  countByImportance(comparisonResult.onlyB, 'onlyB');

  return stats;
}

/**
 * 重要度別比較サマリーを生成する
 * @param {Array<Object>} comparisonResults - 複数の要素タイプの比較結果
 * @returns {Object} 全体的な重要度サマリー
 */
export function generateImportanceSummary(comparisonResults) {
  const summary = {
    totalElements: 0,
    totalDifferences: 0,
    byImportance: {},
    byElementType: {},
    criticalDifferences: 0, // 高重要度の差分
    timestamp: new Date().toISOString(),
  };

  // 重要度レベル別の初期化
  for (const level of Object.values(IMPORTANCE_LEVELS)) {
    summary.byImportance[level] = {
      matched: 0,
      differences: 0,
      onlyA: 0,
      onlyB: 0,
    };
  }

  // 各比較結果を集計
  comparisonResults.forEach((result) => {
    if (!result.importanceStats) {
      return;
    }

    const elementType = result.elementType;
    summary.byElementType[elementType] = result.importanceStats.summary;

    summary.totalElements +=
      result.importanceStats.summary.totalMatched + result.importanceStats.summary.totalDifferences;
    summary.totalDifferences += result.importanceStats.summary.totalDifferences;

    // 重要度別の集計
    for (const [importance, stats] of Object.entries(result.importanceStats.byImportance)) {
      summary.byImportance[importance].matched += stats.matched;
      summary.byImportance[importance].differences += stats.differences;
      summary.byImportance[importance].onlyA += stats.onlyA;
      summary.byImportance[importance].onlyB += stats.onlyB;

      // 高重要度の差分をカウント
      if (importance === IMPORTANCE_LEVELS.REQUIRED) {
        summary.criticalDifferences += stats.differences;
      }
    }
  });

  return summary;
}

/*
 * 要素の重要度を取得するヘルパー
 * @param {Element} element - 要素
 * @param {string} elementType - 要素タイプ
 * @param {Function} importanceLookup - 重要度判定関数
 * @returns {number} 重要度レベル
 */
function getElementImportance(element, elementType, importanceLookup) {
  if (!element || typeof importanceLookup !== 'function') {
    return IMPORTANCE_LEVELS.OPTIONAL;
  }
  try {
    return importanceLookup(element, elementType) ?? IMPORTANCE_LEVELS.OPTIONAL;
  } catch {
    return IMPORTANCE_LEVELS.OPTIONAL;
  }
}

/**
 * 重要度設定の変更を比較結果に反映する
 * @param {Object} comparisonResult - 既存の比較結果
 * @param {string} elementType - 要素タイプ
 * @param {Function} importanceLookup - 重要度判定関数
 * @returns {Object} 更新された比較結果
 */
export function updateComparisonResultImportance(comparisonResult, elementType, importanceLookup) {
  // 重要度情報を再計算
  const addImportanceInfo = (items, modelType) => {
    return items.map((item) => {
      let element;
      if (modelType === 'matched') {
        element = item.dataA.element || null;
      } else {
        element = item.element || null;
      }

      const importance = element
        ? getElementImportance(element, elementType, importanceLookup)
        : IMPORTANCE_LEVELS.OPTIONAL;

      return {
        ...item,
        importance,
        importanceName: IMPORTANCE_LEVEL_NAMES[importance],
      };
    });
  };

  const updatedResult = {
    ...comparisonResult,
    matched: addImportanceInfo(comparisonResult.matched, 'matched'),
    onlyA: addImportanceInfo(comparisonResult.onlyA, 'onlyA'),
    onlyB: addImportanceInfo(comparisonResult.onlyB, 'onlyB'),
  };

  // 統計情報を再生成
  updatedResult.importanceStats = generateImportanceStatistics(updatedResult, elementType);

  return updatedResult;
}
