/**
 * @fileoverview 比較結果の集計・境界計算
 *
 * カメラフィッティング用の境界ボックス算出と、
 * 差分カテゴリ別の統計サマリー生成を提供する。
 *
 * @module modelLoader/comparison/comparisonStatistics
 */

import * as THREE from 'three';
import { createLogger } from '../../utils/logger.js';
import { getCategoryCounts } from '../../data/normalizeComparisonResult.js';

const logger = createLogger('modelLoader:comparison');

/**
 * Calculate element bounds for camera fitting
 * @param {Map} comparisonResults - Results from element comparison
 * @param {Map} nodeMapA - Node map for model A
 * @param {Map} nodeMapB - Node map for model B
 * @returns {THREE.Box3} Combined bounding box
 */
export function calculateElementBounds(comparisonResults, nodeMapA, nodeMapB) {
  const bounds = new THREE.Box3();

  // Add all node positions to bounds
  for (const node of nodeMapA.values()) {
    bounds.expandByPoint(new THREE.Vector3(node.x, node.y, node.z));
  }

  for (const node of nodeMapB.values()) {
    bounds.expandByPoint(new THREE.Vector3(node.x, node.y, node.z));
  }

  // If bounds are empty, create a default bounds
  if (bounds.isEmpty()) {
    bounds.expandByPoint(new THREE.Vector3(-1000, -1000, -1000));
    bounds.expandByPoint(new THREE.Vector3(1000, 1000, 1000));
    logger.warn('No valid geometry found, using default bounds');
  }

  return bounds;
}

/**
 * Get element comparison statistics
 * @param {Map} comparisonResults - Results from element comparison
 * @returns {Object} Statistics summary
 */
export function getComparisonStatistics(comparisonResults) {
  const stats = {
    totalElements: 0,
    matchedElements: 0,
    onlyAElements: 0,
    onlyBElements: 0,
    // 5カテゴリ詳細
    exactElements: 0,
    withinToleranceElements: 0,
    attributeMismatchElements: 0,
    elementTypes: {},
    selectedTypes: [],
    errors: [],
  };

  for (const [elementType, result] of comparisonResults.entries()) {
    const counts = getCategoryCounts(result);
    const typeStats = {
      matched: counts.matched,
      exact: counts.exact,
      withinTolerance: counts.withinTolerance,
      attributeMismatch: counts.attributeMismatch,
      onlyA: counts.onlyA,
      onlyB: counts.onlyB,
      total: counts.total,
      isSelected: result.isSelected,
    };

    stats.elementTypes[elementType] = typeStats;
    stats.totalElements += typeStats.total;
    stats.matchedElements += typeStats.matched;
    stats.exactElements += typeStats.exact;
    stats.withinToleranceElements += typeStats.withinTolerance;
    stats.attributeMismatchElements += typeStats.attributeMismatch;
    stats.onlyAElements += typeStats.onlyA;
    stats.onlyBElements += typeStats.onlyB;

    if (result.isSelected) {
      stats.selectedTypes.push(elementType);
    }

    if (result.error) {
      stats.errors.push({
        elementType,
        error: result.error,
      });
    }
  }

  return stats;
}
