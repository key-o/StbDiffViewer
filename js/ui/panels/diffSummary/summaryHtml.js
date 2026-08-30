/**
 * @fileoverview 差分サマリー全体のHTML生成
 *
 * 統計データから差分サマリーパネル全体のHTML文字列を組み立てます。
 * クロスバージョン警告・異ソフト間注記・要素タイプ別テーブル・対応率見出し・
 * 集計範囲注記・割合バー・凡例（4カテゴリ＋一致内訳のサブ行）・
 * 一致の次元別分析セクション・アクションボタン・ビューフィルタフッターを
 * 統合し、公開API generateSummaryHTML として提供します。
 */

import { getGroupCollapse } from './state.js';
import { formatPct } from './format.js';
import { filterClickAttrs } from './filterAttrs.js';
import {
  SUMMARY_CATEGORY_STATUSES,
  DIFF_STATUS_VALUE_CLASSES,
  POSITION_EXACT_STATUSES,
  POSITION_TOLERANCE_STATUSES,
  PAIRED_STATUSES,
  DIFF_STATUS_COLOR_VARS,
} from './statusMaps.js';
import { generateTypeTable, generateViewFilterFooter } from './typeTable.js';
import { generateCrossSoftwareNotices } from './crossSoftware.js';
import { getCurrentVersionInfo, shouldShowVersionSpecificDifferences } from '../versionPanel.js';
import { DIFF_STATUS } from '../../../config/diffFilterConfig.js';

/**
 * 統計データからHTMLを生成する
 * @param {Object} stats - 統計データ
 * @param {Object} [collapse] - 要素タイプ別表の列グループ折りたたみ状態
 * @returns {string} HTML文字列
 */
export function generateSummaryHTML(stats, collapse = getGroupCollapse()) {
  if (stats.totalElements === 0) {
    return '<div class="diff-stat-item">比較対象の要素がありません</div>';
  }

  let html = '';

  // クロスバージョン警告を先頭に表示
  const versionInfo = getCurrentVersionInfo();
  if (versionInfo.isCrossVersion) {
    html += `
      <div class="version-notice cross-version" style="display: flex; align-items: flex-start; gap: 8px; padding: 8px; margin-bottom: 10px; background: var(--bg-secondary, #f3f4f6); border-radius: 4px; border-left: 3px solid var(--color-warning, #d97706);">
        <span style="font-size: var(--font-size-base);">⚠️</span>
        <span style="font-size: var(--font-size-sm); color: var(--text-primary, #374151);">異なるバージョン間の比較です</span>
      </div>
      <div class="version-filter-option" style="margin-bottom: 10px; padding: 8px; background: var(--bg-secondary, #f3f4f6); border-radius: 4px;">
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: var(--font-size-sm);">
          <input type="checkbox" id="version-diff-filter" ${shouldShowVersionSpecificDifferences() ? 'checked' : ''} style="width: 14px; height: 14px; cursor: pointer;">
          <span>バージョン固有の差異も表示</span>
        </label>
      </div>
    `;
  }

  // 異ソフト間比較モードの注記（C2 別建物警告 / A5 片側欠落カテゴリ）。モードOFF時は空文字。
  html += generateCrossSoftwareNotices(stats);

  const total = stats.totalElements;

  // 要素タイプ別の数値表を最上部に配置する（走査の起点となるため）
  html += generateTypeTable(stats, collapse);

  // 見出し: 対応率（比較キーずれ等の兆候にすぐ気付けるよう最上部に大きく表示）
  html += `
    <div class="diff-summary-headline">
      <span class="diff-headline-label">対応率</span>
      <span class="diff-headline-value diff-stat-matched">${formatPct(stats.totalCorresponding, total)}</span>
      <span class="diff-headline-sub">${stats.totalCorresponding} / ${total}</span>
    </div>
  `;

  // 集計範囲の注記: サマリーは全比較対象、色付けフィルタは3D描画要素のみ。
  // 非描画のSTB定義（断面・継手定義など）を含む場合、両者の総数がずれる理由を明示する。
  html += generateScopeNote(stats);

  // 割合バー（4カテゴリの構成比を視覚化）
  html += generateProportionBar(stats);

  // 凡例（バーと対応。0件でも並びを崩さず常に4行表示）
  html += '<div class="diff-legend">';
  html += renderLegendRow(
    '✅',
    '対応要素あり',
    stats.totalCorresponding,
    total,
    'diff-stat-matched',
    SUMMARY_CATEGORY_STATUSES.corresponding,
  );
  // 対応要素の階層分解（完全一致 / 位置許容差内 / 属性差あり）
  html += renderSubLegendRow(
    '完全一致',
    stats.totalExact,
    total,
    [DIFF_STATUS.MATCHED],
    DIFF_STATUS_VALUE_CLASSES[DIFF_STATUS.MATCHED],
  );
  if (stats.totalWithinTolerance > 0) {
    html += renderSubLegendRow(
      '位置許容差内',
      stats.totalWithinTolerance,
      total,
      [DIFF_STATUS.POSITION_TOLERANCE],
      DIFF_STATUS_VALUE_CLASSES[DIFF_STATUS.POSITION_TOLERANCE],
    );
  }
  // 「属性差あり」を diffStatus 別の色付きサブ行に分解し、各行の文字色を3Dジオメトリ色に一致させる。
  // インスタンス=橙 / 断面・タイプ=シアン / 両方=紫 / 位置許容差＋属性差(combined)=紫 / 未分類=橙。
  // 各ステータス数の合計は totalAttributeMismatch と一致するため、対応要素あり内訳の総和は保たれる。
  const attributeBreakdown = [
    [
      'インスタンス属性差',
      stats.statusCounts?.attributeMismatchInstance,
      DIFF_STATUS.ATTRIBUTE_MISMATCH_INSTANCE,
    ],
    [
      '断面・タイプ差',
      stats.statusCounts?.attributeMismatchType,
      DIFF_STATUS.ATTRIBUTE_MISMATCH_TYPE,
    ],
    [
      '両方（属性＋タイプ）',
      stats.statusCounts?.attributeMismatchBoth,
      DIFF_STATUS.ATTRIBUTE_MISMATCH_BOTH,
    ],
    ['位置許容差＋属性差', stats.statusCounts?.combined, DIFF_STATUS.COMBINED],
    ['属性差（未分類）', stats.statusCounts?.attributeMismatch, DIFF_STATUS.ATTRIBUTE_MISMATCH],
  ];
  for (const [label, count, status] of attributeBreakdown) {
    if (count > 0) {
      html += renderSubLegendRow(label, count, total, [status], DIFF_STATUS_VALUE_CLASSES[status]);
    }
  }
  html += renderLegendRow(
    '🔵',
    'モデルAのみ',
    stats.totalOnlyA,
    total,
    'diff-stat-only-a',
    SUMMARY_CATEGORY_STATUSES.onlyA,
  );
  html += renderLegendRow(
    '🔴',
    'モデルBのみ',
    stats.totalOnlyB,
    total,
    'diff-stat-only-b',
    SUMMARY_CATEGORY_STATUSES.onlyB,
  );
  html += '</div>';

  // 一致の次元別分析（位置・断面/タイプ・インスタンス属性）
  html += generateMatchDimensionSection(stats.matchDimensions);

  // アクションボタン（差分一覧 / 異ソフト間モード時のみ断面対応表）
  const actionButtons = [];
  if (stats.totalOnlyA > 0 || stats.totalOnlyB > 0 || stats.totalAttributeMismatch > 0) {
    actionButtons.push(`
      <button type="button" id="open-diff-list-from-summary" class="btn btn-sm btn-secondary diff-list-btn">
        📋 差分一覧を表示
      </button>
    `);
  }
  if (stats.crossSoftware) {
    actionButtons.push(`
      <button type="button" id="open-section-correspondence-btn" class="btn btn-sm btn-secondary diff-list-btn"
        title="トップレベル断面の1:1対応と形状の一致/差を表示">
        📑 断面対応表
      </button>
    `);
  }
  if (actionButtons.length > 0) {
    html += `<div class="diff-summary-actions">${actionButtons.join('')}</div>`;
  }

  // クリックで文字が入れ替わる動的部（絞り込み状態・件数）は最下部フッターに固定する
  html += generateViewFilterFooter();

  return html;
}

/**
 * サマリーの集計範囲を説明する注記を生成する。
 *
 * 差分サマリーは「全比較対象」を数えるのに対し、表内のビューフィルタは
 * 3Dに描画される要素のみを数えるため、非描画のSTB定義（断面・継手定義など）が
 * あると両者の総数が一致しない。その内訳と理由を明示してユーザーの混乱を防ぐ。
 *
 * @param {Object} stats - 統計データ
 * @returns {string} HTML文字列（非描画要素が無い場合は空文字）
 */
function generateScopeNote(stats) {
  if (stats.totalNonRenderable <= 0) {
    return '';
  }

  return `
    <div class="diff-scope-note">
      <span class="diff-scope-label">総数 ${stats.totalElements} の内訳</span>
      <span class="diff-scope-parts">
        <span class="diff-scope-3d">3D表示対象 ${stats.totalRenderable}</span>
        <span class="diff-scope-plus">＋</span>
        <span class="diff-scope-def">非描画のSTB定義 ${stats.totalNonRenderable}</span>
      </span>
      <span class="diff-scope-hint">表内のビューフィルタは 3D表示対象（${stats.totalRenderable}）のみを集計します</span>
    </div>
  `;
}

/**
 * 4カテゴリの構成比を表す横積みバーのHTMLを生成する
 * @param {Object} stats - 統計データ
 * @returns {string} HTML文字列
 */
function generateProportionBar(stats) {
  const total = stats.totalElements;
  const segments = [
    [
      '対応要素あり',
      stats.totalCorresponding,
      'var(--color-matched)',
      SUMMARY_CATEGORY_STATUSES.corresponding,
    ],
    ['モデルAのみ', stats.totalOnlyA, 'var(--color-only-a)', SUMMARY_CATEGORY_STATUSES.onlyA],
    ['モデルBのみ', stats.totalOnlyB, 'var(--color-only-b)', SUMMARY_CATEGORY_STATUSES.onlyB],
  ];

  let bar = '<div class="diff-proportion-bar">';
  for (const [label, value, color, statuses] of segments) {
    if (value > 0) {
      const width = (value / total) * 100;
      bar += `<span class="diff-proportion-seg diff-clickable" style="width:${width}%;background:${color};" title="${label} ${value} (${formatPct(value, total)})：クリックで3D表示を絞り込み"${filterClickAttrs(statuses)}></span>`;
    }
  }
  bar += '</div>';
  return bar;
}

/**
 * 凡例の1行を生成する
 * @param {string} icon - アイコン絵文字
 * @param {string} label - ラベル
 * @param {number} value - 件数
 * @param {number} total - 全体件数
 * @param {string} valueClass - 値に付与する色クラス
 * @param {Array<string>} [statuses] - クリック時に適用する差分ステータス群（0件時は付与しない）
 * @returns {string} HTML文字列
 */
function renderLegendRow(icon, label, value, total, valueClass, statuses) {
  const clickable = statuses && value > 0;
  const rowAttrs = clickable
    ? ` title="クリックで3D表示を絞り込み"${filterClickAttrs(statuses)}`
    : '';
  return `<div class="diff-legend-row${clickable ? ' diff-clickable' : ''}"${rowAttrs}><span class="diff-legend-label">${icon} ${label}</span><span class="diff-legend-value ${valueClass}">${value}</span><span class="diff-legend-pct">${formatPct(value, total)}</span></div>`;
}

/**
 * 一致の内訳を示すサブ凡例行を生成する（一致行の下にインデント表示）
 * @param {string} label - ラベル
 * @param {number} value - 件数
 * @param {number} total - 全体件数
 * @param {Array<string>} [statuses] - クリック時に適用する差分ステータス群（0件時は付与しない）
 * @param {string} [valueClass] - 値に付与する色クラス
 * @returns {string} HTML文字列
 */
function renderSubLegendRow(label, value, total, statuses, valueClass = '') {
  const clickable = statuses && value > 0;
  const rowAttrs = clickable
    ? ` title="クリックで3D表示を絞り込み"${filterClickAttrs(statuses)}`
    : '';
  const classAttr = valueClass ? ` ${valueClass}` : '';
  return `<div class="diff-legend-row diff-legend-sub${clickable ? ' diff-clickable' : ''}"${rowAttrs}><span class="diff-legend-label">└ ${label}</span><span class="diff-legend-value${classAttr}">${value}</span><span class="diff-legend-pct">${formatPct(value, total)}</span></div>`;
}

/**
 * 一致要素の次元別分析セクション（位置・断面/タイプ・インスタンス属性）を生成する。
 * 各次元を積み上げバーと件数内訳で表示する。
 * @param {Object} dims - computeMatchDimensions/accumulateMatchDimensions の集計結果
 * @returns {string} HTML文字列
 */
function generateMatchDimensionSection(dims) {
  if (!dims || dims.pairsTotal === 0) {
    return '';
  }

  const unknownColor = 'var(--border-color, #ced4da)';
  // 各セグメントに対応する差分フィルタステータス（近似対応。
  // 次元集計は attributeMismatchKind ベースのため、フィルタの9カテゴリでは
  // 厳密に表現できないセグメントは最も近いステータス群にマップする）
  const rows = [
    {
      label: '位置',
      segments: [
        [
          '完全一致',
          dims.positionExact,
          'var(--color-matched)',
          POSITION_EXACT_STATUSES,
          { positionStates: ['exact'] },
        ],
        [
          '許容差内',
          dims.positionTolerance,
          DIFF_STATUS_COLOR_VARS[DIFF_STATUS.POSITION_TOLERANCE],
          POSITION_TOLERANCE_STATUSES,
          { positionStates: ['withinTolerance'] },
        ],
      ],
    },
    {
      label: '断面・タイプ',
      segments: [
        [
          '一致',
          dims.sectionMatch,
          'var(--color-matched)',
          PAIRED_STATUSES,
          { sectionStates: ['match'] },
        ],
        [
          '相違',
          dims.sectionMismatch,
          DIFF_STATUS_COLOR_VARS[DIFF_STATUS.ATTRIBUTE_MISMATCH_TYPE],
          [DIFF_STATUS.ATTRIBUTE_MISMATCH_TYPE, DIFF_STATUS.ATTRIBUTE_MISMATCH_BOTH],
          { sectionStates: ['mismatch'] },
        ],
        [
          '未分類',
          dims.sectionUnknown,
          unknownColor,
          [DIFF_STATUS.ATTRIBUTE_MISMATCH, DIFF_STATUS.COMBINED],
        ],
      ],
    },
    {
      label: 'インスタンス属性',
      segments: [
        [
          '一致',
          dims.instanceMatch,
          'var(--color-matched)',
          PAIRED_STATUSES,
          { instanceStates: ['match'] },
        ],
        [
          '相違',
          dims.instanceMismatch,
          DIFF_STATUS_COLOR_VARS[DIFF_STATUS.ATTRIBUTE_MISMATCH_INSTANCE],
          [DIFF_STATUS.ATTRIBUTE_MISMATCH_INSTANCE, DIFF_STATUS.ATTRIBUTE_MISMATCH_BOTH],
          { instanceStates: ['mismatch'] },
        ],
        [
          '未分類',
          dims.instanceUnknown,
          unknownColor,
          [DIFF_STATUS.ATTRIBUTE_MISMATCH, DIFF_STATUS.COMBINED],
        ],
      ],
    },
  ];

  const total = dims.pairsTotal;
  let html = '<div class="diff-dim-section">';
  html += `<div class="diff-type-title">対応要素の内訳 <span class="diff-dim-total">${total}件</span></div>`;

  for (const row of rows) {
    const active = row.segments.filter(([, value]) => value > 0);
    html += '<div class="diff-dim-row">';
    html += `<div class="diff-dim-head"><span class="diff-dim-label">${row.label}</span>`;
    html += `<span class="diff-dim-counts">${active
      .map(([label, value]) => `${label} ${value}`)
      .join(' / ')}</span></div>`;
    html += '<div class="diff-dim-bar">';
    for (const [label, value, color, statuses, criteria] of active) {
      const width = (value / total) * 100;
      html += `<span class="diff-dim-seg diff-clickable" style="width:${width}%;background:${color};" title="${label} ${value} (${formatPct(value, total)})：クリックで関連カテゴリを絞り込み"${filterClickAttrs(statuses, null, criteria)}></span>`;
    }
    html += '</div>';
    html += '</div>';
  }

  html += '</div>';
  return html;
}
