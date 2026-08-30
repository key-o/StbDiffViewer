/**
 * @fileoverview 差分一覧パネルのHTMLテンプレート生成メソッド
 *
 * フィルタ・サマリー・凡例・リストコンテナを含むフローティングウィンドウの骨組みを生成する。
 * DiffListPanel.prototype へ Object.assign して合成する（`this` はパネルインスタンス）。
 *
 * @module ui/panels/diffList/panelTemplate
 */

export const diffListPanelTemplateMethods = {
  /**
   * パネルのHTMLを作成
   */
  createPanelHTML() {
    const panelHTML = `
      <div id="diff-list-panel" class="floating-window diff-list-panel">
        <div class="float-window-header" id="diff-list-header">
          <span class="float-window-title">📋 差分一覧</span>
          <div class="float-window-sceneController.getCameraControls()">
            <button class="float-window-btn" id="diff-list-refresh" title="更新">🔄</button>
            <button class="float-window-btn" id="diff-list-close">✕</button>
          </div>
        </div>
        <div class="float-window-content">
          <!-- フィルタセクション -->
          <div class="diff-list-filters">
            <div class="filter-row">
              <label>カテゴリ:</label>
              <select id="diff-category-filter">
                <option value="all">すべて</option>
                <option value="attributeMismatch">属性不一致</option>
                <option value="attributeMismatchInstance">インスタンス属性差</option>
                <option value="attributeMismatchType">タイプ情報差</option>
                <option value="attributeMismatchBoth">属性+タイプ差</option>
                <option value="onlyA">モデルAのみ</option>
                <option value="onlyB">モデルBのみ</option>
                <option value="versionOnly">バージョン差のみ</option>
              </select>
            </div>
            <div class="filter-row">
              <label>要素タイプ:</label>
              <select id="diff-element-type-filter">
                <option value="all">すべて</option>
              </select>
            </div>
          </div>

          <!-- サマリー表示 -->
          <div class="diff-list-summary">
            <span class="summary-item onlyA">
              <span class="color-indicator"></span>
              🔵 Aのみ: <strong id="diff-count-onlyA">0</strong>
            </span>
            <span class="summary-item onlyB">
              <span class="color-indicator"></span>
              🔴 Bのみ: <strong id="diff-count-onlyB">0</strong>
            </span>
            <span class="summary-item attributeMismatch">
              <span class="color-indicator"></span>
              🟠 属性: <strong id="diff-count-attributeMismatch">0</strong>
            </span>
            <span class="summary-item versionOnly" style="display: none;">
              <span class="color-indicator"></span>
              ⚪ Ver差: <strong id="diff-count-version">0</strong>
            </span>
            <span class="summary-item total">
              合計: <strong id="diff-count-total">0</strong>
            </span>
          </div>

          <!-- 凡例（クロスバージョン時のみ表示） -->
          <div class="diff-list-legend" id="diff-list-legend" style="display: none;">
            <span class="legend-item">🔵 新規(A)</span>
            <span class="legend-item">🔴 削除(B)</span>
            <span class="legend-item">⚪ バージョン差</span>
          </div>

          <!-- 差分リスト -->
          <div class="diff-list-container" id="diff-list-container">
            <div class="diff-list-empty">
              モデルを比較すると差分が表示されます
            </div>
          </div>
        </div>
      </div>
    `;

    this.containerElement.insertAdjacentHTML('beforeend', panelHTML);
  },
};
