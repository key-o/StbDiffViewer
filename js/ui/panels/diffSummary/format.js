/**
 * @fileoverview 差分サマリーの表示用フォーマットユーティリティ
 *
 * 件数の百分率文字列への変換や、要素タイプの表示名解決など、
 * サマリー表示で用いるフォーマット関数を提供します。
 */

import { ELEMENT_LABELS } from '../../../config/elementLabels.js';

/**
 * 件数を全体に対する百分率の文字列に変換する
 * @param {number} value - 件数
 * @param {number} total - 全体件数
 * @returns {string} 例: "15.0%"
 */
function formatPct(value, total) {
  if (!total) return '0.0%';
  return `${((value / total) * 100).toFixed(1)}%`;
}

/**
 * 要素タイプの表示名を取得する
 * ELEMENT_LABELS（SSOT）を使用
 * @param {string} elementType - 要素タイプ
 * @returns {string} 表示名
 */
function getElementTypeDisplayName(elementType) {
  return ELEMENT_LABELS[elementType] || elementType;
}

export { formatPct, getElementTypeDisplayName };
