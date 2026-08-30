/**
 * @fileoverview 差分サマリー要素タイプ別テーブルの共有セル・骨格生成ユーティリティ
 *
 * 配置要素テーブルの colgroup・列幅スタイルや、数値セル（本体行・合計行）の
 * HTML断片を生成する共有関数を提供します。
 */

import { filterClickAttrs } from './filterAttrs.js';
import { TYPE_TABLE_WIDTH_TERMS } from './tableColumns.js';

/**
 * 実列（名前列を除く）ぶんの colgroup を生成する。全実列を均一の metric 幅にする。
 * @param {Array<Object>} columns - 実列の配列
 * @returns {string} colgroup HTML文字列
 */
function generateMetricColgroup(columns) {
  let html = '<colgroup><col class="diff-type-name-col">';
  for (let i = 0; i < columns.length; i++) {
    html += '<col class="diff-type-metric-col">';
  }
  html += '</colgroup>';
  return html;
}

/**
 * テーブルの実列幅合計と、ヘッダグリッド用の列幅リストをCSS変数として返す。
 * table-layout: fixed で上段ヘッダ（CSS Grid）を下段の実列に正確に揃えるため、
 * 表示中の列を足し合わせた幅をテーブル自体に明示する。
 * @param {Array<Object>} columns - 実列の配列
 * @returns {string} style属性文字列
 */
function generatePlacementWidthStyle(columns) {
  const terms = [TYPE_TABLE_WIDTH_TERMS.name, ...columns.map(() => TYPE_TABLE_WIDTH_TERMS.metric)];
  return `--diff-type-table-width: calc(${terms.join(' + ')}); --diff-type-grid-columns: ${terms.join(
    ' ',
  )};`;
}

/**
 * 要素タイプ別テーブルの数値セルを生成する（0件は淡色表示・クリック不可）
 * @param {number} value - 件数
 * @param {string} valueClass - 値に付与する色クラス
 * @param {Array<string>} [statuses] - クリック時に適用する差分ステータス群
 * @param {string|null} [elementType] - クリック時の要素タイプ絞り込み（nullでクリック不可）
 * @returns {string} HTML文字列
 */
function renderTypeCell(value, valueClass, statuses, elementType, criteria = null) {
  if (value <= 0) {
    return '<td class="diff-cell-zero">0</td>';
  }
  if (statuses && elementType) {
    return `<td class="${valueClass} diff-clickable" title="クリックで3D表示を絞り込み"${filterClickAttrs(statuses, elementType, criteria)}>${value}</td>`;
  }
  return `<td class="${valueClass}">${value}</td>`;
}

/**
 * 要素タイプ別テーブルの合計行セルを生成する。
 * @param {number} value - 件数
 * @param {string} valueClass - 値に付与する色クラス
 * @returns {string} HTML文字列
 */
function renderTypeTotalCell(value, valueClass, statuses = null, criteria = null) {
  if (value <= 0) {
    return '<td class="diff-cell-zero">0</td>';
  }
  if (statuses) {
    return `<td class="${valueClass} diff-clickable" title="クリックで3D表示を絞り込み"${filterClickAttrs(statuses, null, criteria)}>${value}</td>`;
  }
  return `<td class="${valueClass}">${value}</td>`;
}

export { generateMetricColgroup, generatePlacementWidthStyle, renderTypeCell, renderTypeTotalCell };
