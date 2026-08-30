/**
 * @fileoverview 差分サマリーの非描画STB定義（断面/接合/開口/STB定義）タブ・カテゴリ別内訳テーブル生成
 *
 * 3D描画対象外のSTB定義（断面・接合・開口・その他）を、グループ×カテゴリのタブUIと
 * カテゴリ別内訳テーブルとして表示するための生成関数群を提供します。
 * 断面カテゴリの数値セルは該当断面を参照する配置要素への3Dフィルタ導線を、
 * それ以外のグループは生XML表示への導線を data 属性として付与します。
 */

import {
  SECTION_CATEGORY_COLUMNS,
  SECTION_COLUMN_FILTER,
  DEFINITION_COLUMN_RAW_XML_CATEGORIES,
  SECTION_CATEGORY_ORDER,
  SECTION_CATEGORY_TO_ELEMENT_TYPES,
  DEFINITION_TAB_DEFS,
} from './tableColumns.js';
import {
  generateMetricColgroup,
  generatePlacementWidthStyle,
  renderTypeCell,
  renderTypeTotalCell,
} from './tableCells.js';
import { getActiveDefTab, setActiveDefTab } from './state.js';

/**
 * 定義タブの表示可否を判定する。
 * 継手・開口は片側モデルにしか無い場合は比較しても無意味なのでタブを出さない
 * （A・B 両方に1件以上あるときのみ表示）。断面・STB定義は存在すれば表示する。
 * @param {string} group
 * @param {Object} byCategory - 当該グループの byCategory
 * @returns {boolean}
 */
function shouldShowDefinitionTab(group, byCategory) {
  const totals = sumCategoryTotals(byCategory);
  if (totals.totalA + totals.totalB === 0) return false;
  if (group === 'joint' || group === 'open') {
    return totals.totalA > 0 && totals.totalB > 0;
  }
  return true;
}

/** byCategory を合算して A計/B計/各数値の合計を返す */
function sumCategoryTotals(byCategory) {
  const totals = {
    totalA: 0,
    totalB: 0,
    corresponding: 0,
    sameNameMatch: 0,
    sameNameMismatch: 0,
    onlyA: 0,
    onlyB: 0,
  };
  for (const counts of Object.values(byCategory || {})) {
    totals.corresponding += counts.corresponding;
    totals.sameNameMatch += counts.sameNameMatch;
    totals.sameNameMismatch += counts.sameNameMismatch;
    totals.onlyA += counts.onlyA;
    totals.onlyB += counts.onlyB;
    totals.totalA += counts.corresponding + counts.onlyA;
    totals.totalB += counts.corresponding + counts.onlyB;
  }
  return totals;
}

/**
 * 非描画STB定義（断面/接合/開口/STB定義）をタブUIとして生成する。
 * 継手・開口が片側のみのときはそのタブを出さない。
 * @param {Object} dims - sectionDefinitionDimensions（groups を含む）
 * @returns {string} HTML文字列（表示するタブが無ければ空文字）
 */
function generateDefinitionTabs(dims) {
  const groups = dims?.groups;
  if (!groups) return '';

  const visibleTabs = DEFINITION_TAB_DEFS.filter((def) =>
    shouldShowDefinitionTab(def.group, groups[def.group]?.byCategory),
  );
  if (visibleTabs.length === 0) return '';

  // 保持中の選択タブが非表示になっていたら先頭タブへフォールバック
  if (!visibleTabs.some((def) => def.group === getActiveDefTab())) {
    setActiveDefTab(visibleTabs[0].group);
  }

  let html = '<div class="diff-def-tabs-section">';
  html += '<div class="diff-def-tabs-title">STB定義（非描画要素）の内訳</div>';

  // タブヘッダ
  html += '<div class="diff-def-tablist" role="tablist">';
  for (const def of visibleTabs) {
    const totals = sumCategoryTotals(groups[def.group].byCategory);
    const active = def.group === getActiveDefTab();
    const count = totals.corresponding + Math.max(totals.onlyA, totals.onlyB);
    html +=
      `<button type="button" class="diff-def-tab${active ? ' diff-def-tab--active' : ''}" ` +
      `role="tab" aria-selected="${active}" data-def-tab="${def.group}" title="${def.title}">` +
      `${def.label}<span class="diff-def-tab-count">${count}</span></button>`;
  }
  html += '</div>';

  // 各タブのパネル（非アクティブは hidden）
  for (const def of visibleTabs) {
    const active = def.group === getActiveDefTab();
    html += `<div class="diff-def-panel" role="tabpanel" data-def-panel="${def.group}"${active ? '' : ' hidden'}>`;
    html += generateDefinitionCategoryTable(def.group, groups[def.group].byCategory);
    html += '</div>';
  }

  html += '</div>';
  return html;
}

/**
 * 1グループぶんのカテゴリ別内訳テーブルを生成する。
 * 断面グループのカテゴリ行は3Dフィルタ導線（data-section-element-types）、
 * それ以外は生XML導線（data-raw-xml-group）を付与する。
 * @param {string} group - 'section' | 'joint' | 'open' | 'other'
 * @param {Object} byCategory - カテゴリ別カウンタ
 * @returns {string} HTML文字列
 */
function generateDefinitionCategoryTable(group, byCategory) {
  const present = orderedCategories(group, byCategory);
  const columns = SECTION_CATEGORY_COLUMNS;
  const nameHeader = group === 'section' ? 'カテゴリ' : '種別';

  let html = `<div class="diff-type-table-frame" style="${generatePlacementWidthStyle(columns)}">`;
  html += '<table class="diff-type-table">';
  html += generateMetricColgroup(columns);
  html += `<thead><tr class="diff-column-header"><th class="diff-col-name" scope="col">${nameHeader}</th>`;
  for (const col of columns) {
    html += `<th scope="col" title="${col.title}">${col.label}</th>`;
  }
  html += '</tr></thead><tbody>';

  const totals = Object.fromEntries(columns.map((col) => [col.key, 0]));
  for (const category of present) {
    const counts = byCategory[category];
    html += generateDefinitionCategoryRow(group, category, counts);
    for (const col of columns) totals[col.key] += categoryColumnValue(counts, col.key);
  }
  html += '</tbody>';

  html += '<tfoot><tr class="diff-type-total-row"><td class="diff-col-name">合計</td>';
  for (const col of columns) {
    html += renderTypeTotalCell(totals[col.key], col.cls, null, null);
  }
  html += '</tr></tfoot></table></div>';
  return html;
}

/** グループの表示カテゴリを順序付きで返す（未知カテゴリは末尾に付す） */
function orderedCategories(group, byCategory) {
  const keys = Object.keys(byCategory || {});
  if (group !== 'section') return keys; // 接合/開口/その他は単一カテゴリ
  const present = SECTION_CATEGORY_ORDER.filter((c) => byCategory[c]);
  for (const c of keys) {
    if (!present.includes(c)) present.push(c);
  }
  return present;
}

/** カテゴリ別カウンタから列値を取り出す（A計/B計は導出） */
function categoryColumnValue(counts, key) {
  if (key === 'totalA') return counts.corresponding + counts.onlyA;
  if (key === 'totalB') return counts.corresponding + counts.onlyB;
  return counts[key] || 0;
}

/**
 * カテゴリ別内訳テーブルの1行を生成する。
 * 断面カテゴリは3Dフィルタ導線、それ以外は生XML導線を名前セルに付与する。
 * @param {string} group
 * @param {string} category
 * @param {Object} counts
 * @returns {string} HTML文字列（<tr>...</tr>）
 */
function generateDefinitionCategoryRow(group, category, counts) {
  const columns = SECTION_CATEGORY_COLUMNS;
  const elementTypes = group === 'section' ? SECTION_CATEGORY_TO_ELEMENT_TYPES[category] : null;
  const hasAny = counts.corresponding + counts.onlyA + counts.onlyB > 0;
  const hasDiffs = counts.sameNameMismatch + counts.onlyA + counts.onlyB > 0;

  let nameAttrs;
  if (elementTypes && hasAny) {
    // 断面カテゴリ: クリックで該当配置要素のみを3D表示
    nameAttrs =
      ` class="diff-col-name diff-clickable" title="クリックで${category}の配置要素のみ3D表示"` +
      ` data-section-element-types="${elementTypes.join(' ')}"`;
  } else if (hasDiffs) {
    // 接合/開口/その他: クリックで該当グループの差分を生XML表示
    nameAttrs =
      ` class="diff-col-name diff-clickable" title="クリックで${category}の差分を生XML表示"` +
      ` data-raw-xml-group="${group}"`;
  } else {
    nameAttrs = ' class="diff-col-name"';
  }

  let html = `<tr><td${nameAttrs}>${category}</td>`;
  for (const col of columns) {
    const value = categoryColumnValue(counts, col.key);
    if (group === 'section' && SECTION_COLUMN_FILTER[col.key]) {
      html += renderSectionDefCell(value, col.cls, category, counts, col.key, elementTypes);
    } else if (group !== 'section' && DEFINITION_COLUMN_RAW_XML_CATEGORIES[col.key]) {
      html += renderDefinitionRawXmlCell(value, col.cls, group, category, col.key);
    } else {
      html += renderTypeCell(value, col.cls, null, null);
    }
  }
  html += '</tr>';
  return html;
}

/**
 * 断面以外の定義タブ（接合/開口/STB定義）の数値セルを生成する。
 * 値>0 なら、該当グループ・列の差分カテゴリを生XML表示するクリック導線を付与する。
 * @param {number} value - セルの件数
 * @param {string} valueClass - 色クラス
 * @param {string} group - 定義グループ（joint/open/other）
 * @param {string} category - カテゴリ表示名（サブタイトル添え）
 * @param {string} colKey - 列キー（corresponding/sameNameMatch/... ）
 * @returns {string} HTML文字列（<td>...</td>）
 */
function renderDefinitionRawXmlCell(value, valueClass, group, category, colKey) {
  if (value <= 0) {
    return '<td class="diff-cell-zero">0</td>';
  }
  const categories = DEFINITION_COLUMN_RAW_XML_CATEGORIES[colKey];
  return (
    `<td class="${valueClass} diff-clickable"` +
    ` title="クリックで${category}の該当差分を生XML表示"` +
    ` data-raw-xml-group="${group}" data-raw-xml-categories="${categories.join(' ')}">` +
    `${value}</td>`
  );
}

/**
 * 断面タブの数値セルを生成する。値>0 なら「該当断面を参照する配置要素」を3D絞り込み
 * するためのクリック導線（data-section-def-*）を付与する。
 * @param {number} value - セルの件数
 * @param {string} valueClass - 色クラス
 * @param {string} category - 断面カテゴリ名
 * @param {Object} counts - カテゴリ別カウンタ（ids を含む）
 * @param {string} colKey - 列キー（corresponding/sameNameMatch/... ）
 * @param {string[]|null} elementTypes - カテゴリ→配置要素タイプ（二重絞り込み用）
 * @returns {string} HTML文字列（<td>...</td>）
 */
function renderSectionDefCell(value, valueClass, category, counts, colKey, elementTypes) {
  if (value <= 0) {
    return '<td class="diff-cell-zero">0</td>';
  }
  const cfg = SECTION_COLUMN_FILTER[colKey];
  // 該当区分の断面定義idを重複除去して集める
  const idSet = new Set();
  for (const field of cfg.idsFields) {
    for (const id of counts.ids?.[field] || []) idSet.add(String(id));
  }
  // idが1件も無ければ配置要素と突合できないためクリック不可にする
  if (idSet.size === 0) {
    return `<td class="${valueClass}">${value}</td>`;
  }
  const ids = [...idSet].join(' ');
  const statuses = cfg.statuses.join(' ');
  const elemTypesAttr = elementTypes
    ? ` data-section-def-elem-types="${elementTypes.join(' ')}"`
    : '';
  const modelSourceAttr = cfg.modelSource
    ? ` data-section-def-model-source="${cfg.modelSource}"`
    : '';
  return (
    `<td class="${valueClass} diff-clickable"` +
    ` title="クリックで${category}の該当断面を参照する配置要素を3D表示"` +
    ` data-section-def-ids="${ids}" data-section-def-statuses="${statuses}"` +
    ` data-section-def-category="${category}"${elemTypesAttr}${modelSourceAttr}>` +
    `${value}</td>`
  );
}

export { generateDefinitionTabs };
