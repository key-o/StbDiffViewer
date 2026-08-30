/**
 * @fileoverview 差分一覧のフィルタ・グループ化メソッド
 *
 * 要素タイプフィルタの選択肢更新、カテゴリ／要素タイプによる絞り込み、
 * 要素タイプ単位のグループ化を担う。
 * DiffListPanel.prototype へ Object.assign して合成する（`this` はパネルインスタンス）。
 *
 * @module ui/panels/diffList/filters
 */

import { ELEMENT_LABELS } from '../../../config/elementLabels.js';

export const diffListFilterMethods = {
  /**
   * 要素タイプフィルタの選択肢を更新
   */
  updateElementTypeFilter() {
    const select = document.getElementById('diff-element-type-filter');
    if (!select) return;

    // 現在の選択を保持
    const currentValue = select.value;

    // 選択肢を再構築
    select.innerHTML = '<option value="all">すべて</option>';

    for (const type of this.elementTypes) {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = this.getElementTypeDisplayName(type);
      select.appendChild(option);
    }

    // 可能なら以前の選択を復元
    if (this.elementTypes.has(currentValue)) {
      select.value = currentValue;
    }
  },

  /**
   * 要素タイプの表示名を取得
   * ELEMENT_LABELS（SSOT）を使用
   * @param {string} type - 要素タイプ
   * @returns {string} 表示名
   */
  getElementTypeDisplayName(type) {
    return ELEMENT_LABELS[type] || type;
  },

  /**
   * フィルタリングされたデータを取得
   * @returns {Array} フィルタ済みデータ
   */
  getFilteredData() {
    let data = [];

    // カテゴリフィルタ
    if (this.currentFilter.category === 'all') {
      data = [...this.diffData.attributeMismatch, ...this.diffData.onlyA, ...this.diffData.onlyB];
      // バージョン固有差分を含める（フィルタ設定に応じて）
      if (this.currentFilter.showVersionDifferences && this.versionInfo.isCrossVersion) {
        data = [...data, ...this.diffData.versionDifferences];
      }
    } else if (this.currentFilter.category === 'onlyA') {
      data = [...this.diffData.onlyA];
    } else if (this.currentFilter.category === 'onlyB') {
      data = [...this.diffData.onlyB];
    } else if (this.currentFilter.category === 'attributeMismatch') {
      data = [...this.diffData.attributeMismatch];
    } else if (
      ['attributeMismatchInstance', 'attributeMismatchType', 'attributeMismatchBoth'].includes(
        this.currentFilter.category,
      )
    ) {
      data = this.diffData.attributeMismatch.filter(
        (item) => item.diffStatus === this.currentFilter.category,
      );
    } else if (this.currentFilter.category === 'versionOnly') {
      // バージョン固有差分のみ
      data = [...this.diffData.versionDifferences];
    }

    // 要素タイプフィルタ
    if (this.currentFilter.elementType !== 'all') {
      data = data.filter((item) => item.elementType === this.currentFilter.elementType);
    }

    return data;
  },

  /**
   * 要素タイプでグループ化
   * @param {Array} data - データ配列
   * @returns {Object} グループ化されたデータ
   */
  groupByElementType(data) {
    const grouped = {};
    for (const item of data) {
      if (!grouped[item.elementType]) {
        grouped[item.elementType] = [];
      }
      grouped[item.elementType].push(item);
    }
    return grouped;
  },
};
