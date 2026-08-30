/**
 * @fileoverview 差分一覧の描画メソッド
 *
 * リスト本体・要素タイプグループ・差分アイテム・属性差詳細・サマリーのHTML生成と、
 * 詳細の展開／折りたたみを担う。
 * DiffListPanel.prototype へ Object.assign して合成する（`this` はパネルインスタンス）。
 *
 * @module ui/panels/diffList/renderers
 */

import { getCurrentVersionInfo } from '../versionPanel.js';
import { escapeHtml } from '../../../utils/htmlUtils.js';
import { diffDefinitionElements } from '../../../common-stb/comparison/stbDefinitionComparator.js';

export const diffListRendererMethods = {
  /**
   * リストを再描画
   */
  renderList() {
    const container = document.getElementById('diff-list-container');
    if (!container) return;

    // バージョン情報を同期
    const currentVersionInfo = getCurrentVersionInfo();
    this.versionInfo = currentVersionInfo;

    // 凡例の表示/非表示を制御
    const legend = document.getElementById('diff-list-legend');
    if (legend) {
      legend.style.display = this.versionInfo.isCrossVersion ? 'flex' : 'none';
    }

    // バージョン差分サマリーの表示/非表示
    const versionSummaryItem = document.querySelector('.summary-item.versionOnly');
    if (versionSummaryItem) {
      versionSummaryItem.style.display = this.versionInfo.isCrossVersion ? 'inline-flex' : 'none';
    }

    // フィルタリングされたデータを取得
    const filteredData = this.getFilteredData();

    // サマリーを更新
    this.updateSummary(filteredData);

    // リストが空の場合
    if (filteredData.length === 0) {
      container.innerHTML = `
        <div class="diff-list-empty">
          ${
            this.diffData.onlyA.length + this.diffData.onlyB.length === 0
              ? 'モデルを比較すると差分が表示されます'
              : 'フィルタ条件に一致する差分はありません'
          }
        </div>
      `;
      return;
    }

    // 要素タイプでグループ化
    const grouped = this.groupByElementType(filteredData);

    // HTMLを生成
    let html = '';
    for (const [elementType, items] of Object.entries(grouped)) {
      html += this.renderElementTypeGroup(elementType, items);
    }

    container.innerHTML = html;

    // クリックイベントを設定
    this.setupItemClickHandlers(container);
  },

  /**
   * 要素タイプグループのHTMLを生成
   * @param {string} elementType - 要素タイプ
   * @param {Array} items - アイテム配列
   * @returns {string} HTML文字列
   */
  renderElementTypeGroup(elementType, items) {
    const displayName = escapeHtml(this.getElementTypeDisplayName(elementType));
    const onlyACount = items.filter((i) => i.category === 'onlyA').length;
    const onlyBCount = items.filter((i) => i.category === 'onlyB').length;
    const attributeMismatchItems = items.filter((i) => i.category === 'attributeMismatch');
    const attributeMismatchCount = attributeMismatchItems.length;
    const attributeMismatchTypeCount = attributeMismatchItems.filter(
      (i) => i.diffStatus === 'attributeMismatchType',
    ).length;
    const attributeMismatchInstanceCount = attributeMismatchItems.filter(
      (i) => i.diffStatus === 'attributeMismatchInstance',
    ).length;
    const attributeMismatchBothCount = attributeMismatchItems.filter(
      (i) => i.diffStatus === 'attributeMismatchBoth',
    ).length;
    const versionOnlyCount = items.filter((i) => i.category === 'versionOnly').length;

    let html = `
      <div class="diff-group">
        <div class="diff-group-header">
          <span class="group-name">${displayName}</span>
          <span class="group-counts">
            ${onlyACount > 0 ? `<span class="count-a">🔵 ${onlyACount}</span>` : ''}
            ${onlyBCount > 0 ? `<span class="count-b">🔴 ${onlyBCount}</span>` : ''}
            ${
              attributeMismatchCount > 0
                ? `<span class="count-attr">🟠 ${attributeMismatchCount}</span>`
                : ''
            }
            ${
              attributeMismatchInstanceCount > 0
                ? `<span class="count-attr">I ${attributeMismatchInstanceCount}</span>`
                : ''
            }
            ${
              attributeMismatchTypeCount > 0
                ? `<span class="count-attr">T ${attributeMismatchTypeCount}</span>`
                : ''
            }
            ${
              attributeMismatchBothCount > 0
                ? `<span class="count-attr">B ${attributeMismatchBothCount}</span>`
                : ''
            }
            ${versionOnlyCount > 0 ? `<span class="count-version">⚪ ${versionOnlyCount}</span>` : ''}
          </span>
        </div>
        <div class="diff-group-items">
    `;

    for (const item of items) {
      html += this.renderDiffItem(item);
    }

    html += '</div></div>';
    return html;
  },

  /**
   * 差分アイテムのHTMLを生成
   * @param {Object} item - 差分アイテム
   * @returns {string} HTML文字列
   */
  renderDiffItem(item) {
    // バージョン固有差分の場合
    if (item.isVersionSpecificOnly) {
      return this.renderVersionDiffItem(item);
    }

    const categoryClass =
      item.category === 'onlyA'
        ? 'item-onlyA'
        : item.category === 'onlyB'
          ? 'item-onlyB'
          : 'item-attributeMismatch';
    const categoryLabel =
      item.category === 'onlyA'
        ? 'A'
        : item.category === 'onlyB'
          ? 'B'
          : this.getAttributeMismatchLabel(item);
    const icon =
      item.category === 'onlyA'
        ? '🔵'
        : item.category === 'onlyB'
          ? '🔴'
          : this.getAttributeMismatchIcon(item);
    const isRenderable = item.isRenderable !== false;
    // 3D描画される要素は「クリック→3Dで確認」、非描画要素は「クリック→生XMLで確認」
    const title = isRenderable ? '3Dビューで表示' : '生XMLを表示';
    const renderableClass = isRenderable ? '' : ' item-non-renderable';
    const actionLabel = isRenderable ? '👁' : '🔍';
    const actionClass = isRenderable ? 'item-action' : 'item-action item-raw-xml';

    // 属性不一致は展開トグルで属性差の詳細（A/B値）を確認できる
    const detailToggle =
      item.category === 'attributeMismatch'
        ? '<span class="item-detail-toggle" title="属性差の詳細を表示">▸</span>'
        : '';

    return `
      <div class="diff-item ${categoryClass}${renderableClass}"
           data-element-type="${escapeHtml(item.elementType)}"
           data-element-id="${escapeHtml(item.id)}"
           data-category="${escapeHtml(item.category)}"
           data-renderable="${isRenderable}">
        ${detailToggle}
        <span class="diff-icon">${escapeHtml(icon)}</span>
        <span class="item-category">${escapeHtml(categoryLabel)}</span>
        <span class="item-id">${escapeHtml(item.id)}</span>
        <span class="${actionClass}" title="${escapeHtml(title)}">${escapeHtml(actionLabel)}</span>
      </div>
    `;
  },

  getAttributeMismatchLabel(item) {
    switch (item.attributeMismatchKind || item.diffStatus) {
      case 'instance':
      case 'attributeMismatchInstance':
        return '属性';
      case 'type':
      case 'attributeMismatchType':
        return 'タイプ';
      case 'both':
      case 'attributeMismatchBoth':
        return '両方';
      default:
        return '属性';
    }
  },

  getAttributeMismatchIcon(item) {
    switch (item.attributeMismatchKind || item.diffStatus) {
      case 'type':
      case 'attributeMismatchType':
        return '🔷';
      case 'both':
      case 'attributeMismatchBoth':
        return '🟣';
      default:
        return '🟠';
    }
  },

  /**
   * 属性差詳細の展開/折りたたみを切り替える
   * @param {HTMLElement} rowElement - 差分アイテムの行要素
   */
  toggleItemDetails(rowElement) {
    const toggle = rowElement.querySelector('.item-detail-toggle');
    const next = rowElement.nextElementSibling;
    if (next && next.classList.contains('diff-item-details')) {
      next.remove();
      if (toggle) toggle.textContent = '▸';
      return;
    }

    const item = this.findAttributeMismatchItem(
      rowElement.dataset.elementType,
      rowElement.dataset.elementId,
    );
    const details = item ? this.buildItemDiffDetails(item) : null;
    rowElement.insertAdjacentHTML('afterend', this.renderItemDetailsHTML(details));
    if (toggle) toggle.textContent = '▾';
  },

  /**
   * 属性不一致アイテムを要素タイプ＋IDで検索する
   * @param {string} elementType - 要素タイプ
   * @param {string} elementId - 要素ID
   * @returns {Object|null} 差分アイテム
   */
  findAttributeMismatchItem(elementType, elementId) {
    return (
      this.diffData.attributeMismatch.find(
        (item) => item.elementType === elementType && String(item.id) === String(elementId),
      ) || null
    );
  },

  /**
   * 差分アイテムから表示用の属性差詳細を構築する。
   * 配置要素は比較結果に付与済みの attributeDiffDetails（インスタンス属性差＋断面シグネチャ差）を、
   * STB定義など詳細を持たないペアは rawElement から属性差を動的に算出して用いる。
   * @param {Object} item - 差分アイテム
   * @returns {{attributes: Array, sectionSignatures: Object|null, childrenDiffer: boolean}|null}
   */
  buildItemDiffDetails(item) {
    const pair = item.data || {};
    const details = pair.attributeDiffDetails;
    const instanceDiffs = Array.isArray(details?.instance) ? details.instance : [];
    const typeDiff = details?.type || null;

    if (instanceDiffs.length > 0 || typeDiff) {
      return { attributes: instanceDiffs, sectionSignatures: typeDiff, childrenDiffer: false };
    }

    const elementA = pair.dataA?.rawElement;
    const elementB = pair.dataB?.rawElement;
    if (elementA?.attributes && elementB?.attributes) {
      const definitionDiff = diffDefinitionElements(elementA, elementB);
      return {
        attributes: definitionDiff.attributes,
        sectionSignatures: null,
        childrenDiffer: definitionDiff.childrenDiffer,
      };
    }

    return null;
  },

  /**
   * 属性差詳細のHTMLを生成する
   * @param {Object|null} details - buildItemDiffDetails の結果
   * @returns {string} HTML文字列
   */
  renderItemDetailsHTML(details) {
    const hasContent =
      details &&
      (details.attributes.length > 0 || details.sectionSignatures || details.childrenDiffer);
    if (!hasContent) {
      return '<div class="diff-item-details"><div class="detail-empty">属性差の詳細情報はありません</div></div>';
    }

    let html = '<div class="diff-item-details">';

    if (details.attributes.length > 0) {
      html += '<table class="diff-detail-table">';
      html += '<thead><tr><th>属性</th><th>モデルA</th><th>モデルB</th></tr></thead><tbody>';
      for (const diff of details.attributes) {
        html += `<tr>
          <td class="detail-attr">${escapeHtml(diff.attribute)}</td>
          <td class="detail-a">${escapeHtml(this.formatDetailValue(diff.valueA))}</td>
          <td class="detail-b">${escapeHtml(this.formatDetailValue(diff.valueB))}</td>
        </tr>`;
      }
      html += '</tbody></table>';
    }

    if (details.sectionSignatures) {
      const sigA = this.formatDetailValue(details.sectionSignatures.sectionSignatureA);
      const sigB = this.formatDetailValue(details.sectionSignatures.sectionSignatureB);
      // シグネチャは長大なJSONになりうるため、最初の差分位置の近傍のみを表示する
      let diffIndex = 0;
      while (
        diffIndex < sigA.length &&
        diffIndex < sigB.length &&
        sigA[diffIndex] === sigB[diffIndex]
      ) {
        diffIndex++;
      }
      const from = Math.max(0, diffIndex - 60);
      const excerpt = (text) => {
        const slice = text.slice(from, from + 240);
        return `${from > 0 ? '…' : ''}${slice}${from + 240 < text.length ? '…' : ''}`;
      };
      html += `<div class="detail-signature">
        <div class="detail-signature-title">断面構成（タイプ差分・差分近傍を抜粋）</div>
        <div class="detail-signature-row"><span class="detail-a">A:</span> <code>${escapeHtml(excerpt(sigA))}</code></div>
        <div class="detail-signature-row"><span class="detail-b">B:</span> <code>${escapeHtml(excerpt(sigB))}</code></div>
      </div>`;
    }

    if (details.childrenDiffer) {
      html += '<div class="detail-note">子要素（寸法・配筋・鋼材構成など）にも差分があります</div>';
    }

    html += '</div>';
    return html;
  },

  /**
   * 属性値を表示用文字列へ変換する
   * @param {*} value - 属性値
   * @returns {string} 表示文字列
   */
  formatDetailValue(value) {
    if (value === undefined || value === null || value === '') {
      return '（なし）';
    }
    return String(value);
  },

  /**
   * バージョン固有差分アイテムのHTMLを生成
   * @param {Object} item - バージョン固有差分アイテム
   * @returns {string} HTML文字列
   */
  renderVersionDiffItem(item) {
    const diffCount = item.versionDifferences?.length || 0;
    const diffAttrs = item.versionDifferences?.map((d) => d.attribute).join(', ') || '';
    const tooltip = diffAttrs ? `バージョン固有: ${diffAttrs}` : 'バージョン固有の差異';

    return `
      <div class="diff-item item-versionOnly"
           data-element-type="${escapeHtml(item.elementType)}"
           data-element-id="${escapeHtml(item.id)}"
           data-category="versionOnly"
           title="${escapeHtml(tooltip)}">
        <span class="diff-icon">⚪</span>
        <span class="item-category version-badge">Ver</span>
        <span class="item-id">${escapeHtml(item.id)}</span>
        <span class="version-diff-count">${escapeHtml(diffCount)}件</span>
        <span class="item-action" title="3Dビューで表示">👁</span>
      </div>
    `;
  },

  /**
   * サマリーを更新
   * @param {Array} filteredData - フィルタ済みデータ
   */
  updateSummary(filteredData) {
    const onlyACount =
      this.currentFilter.category === 'onlyB'
        ? 0
        : filteredData.filter((i) => i.category === 'onlyA').length;
    const onlyBCount =
      this.currentFilter.category === 'onlyA'
        ? 0
        : filteredData.filter((i) => i.category === 'onlyB').length;
    const attributeMismatchCount = filteredData.filter(
      (i) => i.category === 'attributeMismatch',
    ).length;
    const versionOnlyCount = filteredData.filter((i) => i.category === 'versionOnly').length;

    document.getElementById('diff-count-onlyA').textContent = onlyACount;
    document.getElementById('diff-count-onlyB').textContent = onlyBCount;
    const attributeCountEl = document.getElementById('diff-count-attributeMismatch');
    if (attributeCountEl) {
      attributeCountEl.textContent = attributeMismatchCount;
    }
    document.getElementById('diff-count-total').textContent = filteredData.length;

    // バージョン固有差分カウントの要素があれば更新
    const versionCountEl = document.getElementById('diff-count-version');
    if (versionCountEl) {
      versionCountEl.textContent = versionOnlyCount;
    }

    // バージョン固有差分サマリーの表示/非表示
    const versionSummaryItem = document.querySelector('.summary-item.versionOnly');
    if (versionSummaryItem) {
      versionSummaryItem.style.display = this.versionInfo.isCrossVersion ? 'inline-flex' : 'none';
    }
  },
};
