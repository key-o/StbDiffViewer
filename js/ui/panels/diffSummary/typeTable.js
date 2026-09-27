/**
 * @fileoverview 差分サマリーの要素タイプ別テーブル生成
 *
 * 配置要素（3D描画対象）を「対応要素数」を親に、3D色と同じ排他的な状態
 * （完全一致 / 位置許容差 / インスタンス属性差 / 断面・タイプ差 / 複合差）へ
 * 分解するテーブルと、その下部に表示する断面・接合・開口・STB定義タブを統合する。
 * あわせて、3D表示フィルタのツールバー・フッターも提供する。
 */

import {
  getPlacementMetricColumns,
  CORRESPONDING_STATUS_COLUMNS,
  FLAT_LEADING_COLUMNS,
  AB_ONLY_COLUMNS,
} from './tableColumns.js';
import {
  generateMetricColgroup,
  generatePlacementWidthStyle,
  renderTypeCell,
  renderTypeTotalCell,
} from './tableCells.js';
import { getElementTypeDisplayName } from './format.js';
import { filterClickAttrs } from './filterAttrs.js';
import { generateDefinitionTabs } from './definitionTable.js';
import { DIFF_STATUS_VALUES } from '../../../config/diffFilterConfig.js';

/**
 * 要素タイプ別テーブル全体を生成する。
 * 配置要素（3D描画対象）は色別内訳のメインテーブル、
 * 非描画のSTB定義は下部タブの別テーブルに分離する。
 * @param {Object} stats - 統計データ
 * @param {Object} collapse - 後方互換のため受け取るビュー状態
 * @returns {string} HTML文字列
 */
function generateTypeTable(stats, collapse) {
  const elementTypeEntries = Object.entries(stats.elementTypes);
  let html = '<div class="diff-type-section">';
  html += '<div class="diff-type-toolbar">';
  html += '<div class="diff-type-heading">';
  html += '<div class="diff-type-title">要素タイプ別</div>';
  html +=
    '<div class="diff-type-note">対応要素数を3D表示と同じ色分類で内訳表示します。' +
    '色付き数値をクリックすると該当要素を3D表示に絞り込みます。</div>';
  html +=
    '<div class="diff-type-note">緑＝完全一致、黄＝位置許容差、橙＝インスタンス属性差、' +
    'シアン＝断面・タイプ差、紫＝複合差。断面・接合・開口などの非描画情報は下部タブで確認できます。</div>';
  html += '</div>';
  html += generateViewFilterToolbar();
  html += '</div>';

  if (elementTypeEntries.length <= 1) {
    html += '</div>';
    return html;
  }

  // 配置要素（3D描画対象）のみメインテーブルに描く。
  // 非描画のSTB定義（断面・接合・開口・その他）はグループ×カテゴリのタブ表示に分離する。
  const placementEntries = elementTypeEntries.filter(([, s]) => s.isRenderable);

  html += generatePlacementTable(placementEntries, stats, collapse);
  html += generateDefinitionTabs(stats.sectionDefinitionDimensions);

  html += '</div>';
  return html;
}

/**
 * 配置要素テーブルを生成する。
 * 「対応」列の右側は排他的な5状態なので、その合計は各行の「対応」と一致する。
 * 合計行は非描画STB定義を混ぜず、画面に表示している配置要素行だけを合算する。
 * @param {Array<[string, Object]>} entries - 配置要素タイプの [type, typeStats] 配列
 * @param {Object} stats - 統計データ（スコープマーカー判定に使用）
 * @param {Object} collapse - 後方互換のため受け取るビュー状態
 * @returns {string} HTML文字列
 */
function generatePlacementTable(entries, stats, collapse) {
  const columns = getPlacementMetricColumns(collapse);
  let html = `<div class="diff-type-table-frame" style="${generatePlacementWidthStyle(columns)}">`;
  html += generatePlacementParentHeader();
  html += generatePlacementAxisHeader();
  html += '<table class="diff-type-table">';
  html += generateMetricColgroup(columns);
  html += generatePlacementLeafHeader(columns);

  html += '<tbody>';
  entries.forEach(([elementType, typeStats]) => {
    html += generateTypeRow(elementType, typeStats, columns, stats);
  });
  html += '</tbody>';

  html += '<tfoot><tr class="diff-type-total-row">';
  html += '<td class="diff-col-name">合計</td>';
  for (const col of columns) {
    const visibleTotal = entries.reduce((sum, [, typeStats]) => sum + (col.per(typeStats) || 0), 0);
    html += renderTypeTotalCell(visibleTotal, col.cls, col.statuses, col.criteria);
  }
  html += '</tr></tfoot></table></div>';
  return html;
}

/**
 * 要素タイプ別テーブルの本体1行（タイプ名セル + 各実列の数値セル）を生成する。
 * @param {string} elementType - 要素タイプ
 * @param {Object} typeStats - 当該タイプの統計
 * @param {Array<Object>} columns - 実列の配列
 * @param {Object} stats - 統計データ（スコープマーカー判定に使用）
 * @returns {string} HTML文字列（<tr>...</tr>）
 */
function generateTypeRow(elementType, typeStats, columns, stats) {
  const typeName = getElementTypeDisplayName(elementType);
  // 3D描画されないタイプ（STB定義等）はクリックしても絞り込めないため対象外
  const clickType = typeStats.isRenderable ? elementType : null;
  // 非描画タイプは3D絞り込みの代わりに生XMLで確認できるようにする（差分がある場合のみ）
  const hasDefinitionDiffs =
    !typeStats.isRenderable &&
    (typeStats.attributeMismatch || 0) + (typeStats.onlyA || 0) + (typeStats.onlyB || 0) > 0;
  let nameAttrs;
  if (clickType) {
    nameAttrs = ` class="diff-col-name diff-clickable" title="クリックで${typeName}のみ3D表示"${filterClickAttrs(DIFF_STATUS_VALUES, clickType)}`;
  } else if (hasDefinitionDiffs) {
    nameAttrs = ` class="diff-col-name diff-clickable" title="クリックで${typeName}の非ジオメトリ差分を生XML表示" data-raw-xml-type="${elementType}"`;
  } else {
    nameAttrs = ' class="diff-col-name"';
  }
  // A5: 片側欠落カテゴリ（異ソフト間モード時のみ検出）には注記マーカーを付ける
  const scopeMarker = stats.crossSoftware?.oneSidedTypes?.has(elementType)
    ? ' <span class="diff-scope-marker" title="片側のモデルにのみ存在するカテゴリ（出力範囲の違いの可能性）">※</span>'
    : '';
  let html = '<tr>';
  html += `<td${nameAttrs}>${typeName}${scopeMarker}</td>`;
  for (const col of columns) {
    const clickTarget = col.statuses ? clickType : null;
    html += renderTypeCell(
      col.per(typeStats) || 0,
      col.cls,
      col.statuses,
      clickTarget,
      col.criteria,
    );
  }
  html += '</tr>';
  return html;
}

/**
 * 要素タイプ別表と同じ操作面に置く3D表示フィルタ（固定部）を生成する。
 * クリックで文字が入れ替わる動的部（絞り込み状態・件数・タイプチップ）は
 * generateViewFilterFooter() でサマリー最下部のフッターに分離している。
 * @returns {string} HTML文字列
 */
function generateViewFilterToolbar() {
  return `
    <div id="diff-filter-settings" class="diff-filter-settings diff-view-filter-settings diff-view-filter-toolbar">
      <div class="diff-view-filter-fixed">
        <span class="diff-view-filter-title">表示</span>
        <div class="diff-filter-presets">
          <button type="button" class="btn btn-sm preset-btn" data-preset="all" title="すべての要素を表示">
            全体表示
          </button>
          <button type="button" class="btn btn-sm preset-btn" data-preset="differencesOnly" title="差分（モデルA/Bのみ）を表示">
            差分のみ
          </button>
          <button type="button" class="btn btn-sm preset-btn" data-preset="matchedOnly" title="両方のモデルにある要素を表示">
            共通のみ
          </button>
          <button type="button" class="btn btn-sm preset-btn" data-preset="changesOnly" title="変更があった要素のみ表示">
            変更のみ
          </button>
        </div>
      </div>
    </div>
  `;
}

/**
 * クリックで内容が書き換わる動的部（絞り込み状態・3D表示件数・タイプチップ）を
 * サマリー最下部の固定フッターとして生成する。
 * @returns {string} HTML文字列
 */
function generateViewFilterFooter() {
  return `
    <div class="diff-summary-footer">
      <div class="diff-view-filter-dynamic">
        <span id="diff-view-filter-state" class="diff-view-filter-state">全表示</span>
        <span class="diff-filter-summary">3D表示中: <strong id="diff-visible-count">0</strong> /
          <span id="diff-total-count">0</span> 要素</span>
        <div id="diff-filter-active-type" class="diff-filter-active-type" hidden></div>
      </div>
    </div>
  `;
}

/**
 * 段1（親）ヘッダを生成する。
 * 全体列の上は空白、色別5列の上に「対応要素数」、末尾にA/Bのみを配置する。
 * @returns {string} HTML文字列
 */
function generatePlacementParentHeader() {
  const leadSpan = 1 + FLAT_LEADING_COLUMNS.length; // 名前列 + 全体列
  let html = '<div class="diff-type-group-header-grid diff-type-parent-header-grid" role="row">';
  html += `<div class="diff-group-spacer" aria-hidden="true" style="grid-column: span ${leadSpan}"></div>`;
  html += `<div class="diff-group-parent" role="columnheader" style="grid-column: span ${CORRESPONDING_STATUS_COLUMNS.length}" title="モデルA/Bで対応した配置要素を、3D表示と同じ排他的な色分類で分解します">対応要素数</div>`;
  html += `<div class="diff-group-spacer" aria-hidden="true" style="grid-column: span ${AB_ONLY_COLUMNS.length}"></div>`;
  html += '</div>';
  return html;
}

/**
 * 段2（分類）ヘッダを生成する。
 * 対応要素数の内訳を「一致」1列と「差分」4列へ明示的に分ける。
 * @returns {string} HTML文字列
 */
function generatePlacementAxisHeader() {
  let html =
    '<div class="diff-type-group-header-grid" role="row"><div class="diff-group-spacer" aria-hidden="true"></div>';
  html += `<div class="diff-group-static" role="columnheader" style="grid-column: span ${FLAT_LEADING_COLUMNS.length}">全体</div>`;
  html +=
    '<div class="diff-group-static" role="columnheader" style="grid-column: span 1">一致</div>';
  html += `<div class="diff-group-static" role="columnheader" style="grid-column: span ${CORRESPONDING_STATUS_COLUMNS.length - 1}">差分</div>`;
  html += `<div class="diff-group-static" role="columnheader" style="grid-column: span ${AB_ONLY_COLUMNS.length}">A/Bのみ</div>`;
  html += '</div>';
  return html;
}

/**
 * 段3（葉）ヘッダ行を生成する。色別列は見出し文字にも3D色を適用する。
 * @param {Array<Object>} columns - 実列の配列
 * @returns {string} HTML文字列
 */
function generatePlacementLeafHeader(columns) {
  let labelRow = '<tr class="diff-column-header"><th class="diff-col-name" scope="col">タイプ</th>';
  for (const col of columns) {
    const classAttr = col.headerCls ? ` class="${col.headerCls}"` : '';
    labelRow += `<th scope="col"${classAttr} title="${col.title}">${col.label}</th>`;
  }
  labelRow += '</tr>';
  return `<thead>${labelRow}</thead>`;
}

export { generateTypeTable, generateViewFilterFooter };
