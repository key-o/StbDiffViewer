/**
 * @fileoverview 比較テーブルのCSSスタイル生成
 */

import { getValidationStyles } from '../../../common-stb/validation/validationHtmlRenderer.js';

/**
 * 統合比較テーブルのCSSスタイルを生成
 * @param {boolean} showSingleColumn - 単一モデル表示かどうか
 * @returns {string} CSSスタイル文字列
 */
export function generateTableStyles(showSingleColumn) {
  return `
    /* --- 統合比較テーブル --- */
    .unified-comparison-table {
        width: 100%; border-collapse: collapse; margin-bottom: 1em; font-size: var(--font-size-sm);
        font-family: var(--font-family-app, var(--font-family-base));
        line-height: var(--line-height-base, 1.45);
        table-layout: fixed;
    }
    .unified-comparison-table th, .unified-comparison-table td {
        border-bottom: 1px solid var(--border-color); padding: 6px 8px; text-align: left; vertical-align: middle;
        font-family: inherit;
        white-space: normal;
        overflow-wrap: anywhere;
        word-break: break-word;
        line-height: var(--line-height-base, 1.45);
    }
    /* スティッキーヘッダー */
    .unified-comparison-table thead {
        position: sticky;
        top: 0;
        z-index: 10;
    }
    .unified-comparison-table th { background-color: var(--bg-secondary); font-weight: var(--font-weight-semibold); color: var(--text-heading); }

    /* 要素名の行 */
    .unified-comparison-table tr.element-row > td:first-child {
         background-color: var(--bg-hover); /* 要素行の背景色を少し薄く */
         white-space: normal;
         font-weight: var(--font-weight-semibold);
         color: var(--color-primary);
         border-bottom: 2px solid var(--border-color-light); /* 区切りを少し強調 */
    }
    /* 属性名/ラベルの行 */
    .unified-comparison-table tr:not(.element-row):hover {
         background-color: var(--bg-hover, rgba(0, 0, 0, 0.05));
    }
    .unified-comparison-table tr:not(.element-row) > td:first-child {
         color: var(--text-secondary); /* 属性名/ラベルの色 */
         white-space: normal;
         padding-left: 12px; /* インデントを模倣 */
    }
    /* 差分ハイライト */
    .unified-comparison-table td.differs {
        background-color: #fff3cd;
        font-weight: var(--font-weight-bold);
        color: var(--color-warning); /* 文字色も警告色に */
    }
    .unified-comparison-table td.validation-error {
        background-color: #ffebee;
        color: #b71c1c;
    }
    .unified-comparison-table td.validation-warning {
        background-color: #fff8e1;
        color: #8d5200;
    }
    .unified-comparison-table td.differs.validation-error {
        background-color: #ffcdd2;
    }
    .unified-comparison-table td.differs.validation-warning {
        background-color: #ffe0b2;
    }
    /* 断面情報ヘッダー行 */
    .unified-comparison-table tr.section-header-row > td {
        background-color: var(--bg-secondary);
        font-weight: var(--font-weight-semibold);
        text-align: center;
        padding: 8px;
        border-top: 2px solid var(--border-color); /* 上に区切り線 */
    }

    /*
     * タグ名・属性名・値を含め、要素情報パネルでは同一フォントファミリを使用する。
     * _ / - の判別は BIZ UDGothic の字形で担保し、項目名だけ別の等幅フォントへ切り替えない。
     */
    .unified-comparison-table .tag-name,
    .unified-comparison-table .attr-name,
    .unified-comparison-table .attr-value,
    .unified-comparison-table .text-label,
    .unified-comparison-table .text-content {
        font-family: inherit;
        font-size: var(--font-size-sm);
        line-height: var(--line-height-base, 1.45);
        font-variant-ligatures: none;
        letter-spacing: 0;
    }
    .unified-comparison-table .attr-name {
        overflow-wrap: anywhere;
        word-break: break-word;
    }
    .unified-comparison-table .attr-value { color: #007acc; }
    .unified-comparison-table .text-label { color: #555; }
    .unified-comparison-table .text-content {
        color: #555;
        white-space: pre-wrap;
        word-break: break-all;
    }
    /* 値がない場合のスタイル */
    .unified-comparison-table .no-value {
         color: #999;
         font-family: inherit;
    }

    /* --- 編集モード ---
     * ComparisonRendererの鉛筆ボタンは互換用データキャリアとしてのみ残し、表示しない。
     * 通常属性はセルと同じ行高のinputへ置換し、ルール付き属性はセル自体をクリックする。
     */
    .unified-comparison-table .edit-btn {
        display: none !important;
    }
    .unified-comparison-table td.inline-edit-cell {
        padding-top: 6px;
        padding-bottom: 6px;
    }
    .unified-comparison-table .inline-attr-input {
        display: block;
        width: 100%;
        min-width: 0;
        height: auto;
        margin: 0;
        padding: 0;
        border: 0;
        border-bottom: 1px solid transparent;
        border-radius: 0;
        outline: 0;
        box-sizing: border-box;
        background: transparent;
        color: inherit;
        font: inherit;
        line-height: var(--line-height-base, 1.45);
    }
    .unified-comparison-table .inline-attr-input:hover {
        border-bottom-color: color-mix(in srgb, var(--color-primary) 35%, transparent);
    }
    .unified-comparison-table .inline-attr-input:focus {
        border-bottom-color: var(--color-primary);
        box-shadow: 0 1px 0 var(--color-primary);
    }
    .unified-comparison-table td.rule-edit-cell {
        cursor: pointer;
        position: relative;
    }
    .unified-comparison-table td.rule-edit-cell:hover,
    .unified-comparison-table td.rule-edit-cell:focus-visible {
        background-image: linear-gradient(
          color-mix(in srgb, var(--color-primary) 7%, transparent),
          color-mix(in srgb, var(--color-primary) 7%, transparent)
        );
        outline: none;
    }

    /* 単一モデル表示時のパネル幅調整 */
    ${
      showSingleColumn
        ? `
    .unified-comparison-table th:first-child,
    .unified-comparison-table td:first-child {
        width: 50% !important;
    }
    .unified-comparison-table th:last-child,
    .unified-comparison-table td:last-child {
        width: 50% !important;
    }
    `
        : `
    /* 比較モード時は3カラムのままでCSSによる幅制御は最小限に */
    `
    }

    /* バリデーション情報スタイル */
    ${getValidationStyles()}
  `;
}