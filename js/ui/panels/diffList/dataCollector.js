/**
 * @fileoverview 比較結果から差分一覧用データを収集するメソッド
 *
 * 比較結果（Map / Object）を走査し、onlyA / onlyB / attributeMismatch /
 * versionDifferences の各カテゴリへ振り分けて this.diffData を更新する。
 * DiffListPanel.prototype へ Object.assign して合成する（`this` はパネルインスタンス）。
 *
 * @module ui/panels/diffList/dataCollector
 */

import { shouldShowVersionSpecificDifferences, getCurrentVersionInfo } from '../versionPanel.js';

export const diffListDataCollectorMethods = {
  /**
   * 差分データを更新
   * @param {Map} comparisonResults - 比較結果
   */
  updateDiffList(comparisonResults) {
    this.diffData = {
      onlyA: [],
      onlyB: [],
      attributeMismatch: [],
      matched: [],
      versionDifferences: [],
    };
    this.elementTypes.clear();

    // バージョン情報を取得
    const versionInfo = getCurrentVersionInfo();
    this.versionInfo = versionInfo;

    if (!comparisonResults) return;

    // MapまたはObjectを処理
    const entries =
      comparisonResults instanceof Map
        ? comparisonResults.entries()
        : Object.entries(comparisonResults);

    for (const [elementType, result] of entries) {
      if (!result) continue;

      this.elementTypes.add(elementType);

      // 3D描画されないタイプ（STB定義等）はonlyA/onlyBもフォーカス不可（生XMLで確認する）
      const isRenderable = result.isRenderable !== false;

      // onlyA要素を追加
      if (result.onlyA && Array.isArray(result.onlyA)) {
        result.onlyA.forEach((item) => {
          this.diffData.onlyA.push({
            elementType,
            id: item.id,
            name: item.name || item.id,
            category: 'onlyA',
            data: item,
            isVersionSpecificOnly: false,
            isRenderable,
          });
        });
      }

      // onlyB要素を追加
      if (result.onlyB && Array.isArray(result.onlyB)) {
        result.onlyB.forEach((item) => {
          this.diffData.onlyB.push({
            elementType,
            id: item.id,
            name: item.name || item.id,
            category: 'onlyB',
            data: item,
            isVersionSpecificOnly: false,
            isRenderable,
          });
        });
      }

      if (result.attributeMismatch && Array.isArray(result.attributeMismatch)) {
        result.attributeMismatch.forEach((item) => {
          const id = item.dataA?.id || item.dataB?.id || item.id;
          const name = item.dataA?.name || item.dataB?.name || id;
          this.diffData.attributeMismatch.push({
            elementType,
            id,
            name,
            category: 'attributeMismatch',
            diffStatus: item.diffStatus || 'attributeMismatch',
            attributeMismatchKind: item.attributeMismatchKind || null,
            data: item,
            isVersionSpecificOnly: false,
            isRenderable: result.isRenderable !== false,
          });
        });
      }

      // matched要素からバージョン固有差分を抽出
      if (result.matched && Array.isArray(result.matched)) {
        result.matched.forEach((match) => {
          // versionComparisonがある場合（compareElementsVersionAwareの結果）
          if (match.versionComparison && match.hasVersionOnlyDiff) {
            this.diffData.versionDifferences.push({
              elementType,
              id: match.dataA?.id || match.dataB?.id,
              name: match.dataA?.name || match.dataB?.name || match.dataA?.id,
              category: 'versionOnly',
              data: match,
              isVersionSpecificOnly: true,
              versionDifferences: match.versionDifferences || [],
            });
          }
        });
      }

      // versionDifferencesが直接含まれる場合（別の形式）
      if (result.versionDifferences && Array.isArray(result.versionDifferences)) {
        result.versionDifferences.forEach((item) => {
          this.diffData.versionDifferences.push({
            elementType,
            id: item.elementA?.id || item.elementB?.id,
            name: item.elementA?.name || item.elementB?.name || item.elementA?.id,
            category: 'versionOnly',
            data: item,
            isVersionSpecificOnly: true,
            versionDifferences: item.differences || [],
          });
        });
      }
    }

    // 要素タイプフィルタを更新
    this.updateElementTypeFilter();

    // フィルタ状態を同期
    this.currentFilter.showVersionDifferences = shouldShowVersionSpecificDifferences();

    // 表示を更新
    if (this.isVisible) {
      this.renderList();
    }
  },
};
