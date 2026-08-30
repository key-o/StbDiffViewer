/**
 * @fileoverview 要素ツリーの選択状態操作
 *
 * ElementTreeView のプロトタイプへ Object.assign で合成されるメソッド群。
 * 選択状態（selectedElementKeys / lastClickedElementKey）は
 * ElementTreeView インスタンス（this）が唯一の保持者であり、
 * このモジュールはモジュールスコープの状態を一切保持しない。
 *
 * @module ui/panels/elementTree/elementTreeSelection
 */

export const elementTreeSelectionMethods = {
  /**
   * 選択をクリア
   */
  clearTreeSelection() {
    if (this.treeContainer) {
      const previouslySelected = this.treeContainer.querySelectorAll('.tree-node-header.selected');
      previouslySelected.forEach((el) => el.classList.remove('selected'));
    }
    this.selectedElementKeys.clear();
    this.lastClickedElementKey = null;
  },

  /**
   * 3Dビューアーからの選択に応じてツリー内の要素を選択
   * @param {string} elementType - 要素タイプ
   * @param {string} elementId - 要素ID
   * @param {string} modelSource - モデルソース (matched, onlyA, onlyB)
   */
  selectElementInTree(elementType, elementId, modelSource) {
    if (!this.treeContainer) {
      return;
    }

    const elementKey = `${elementType}_${elementId}_${modelSource}`;

    // 仮想スクロールが有効な要素タイプかチェック
    const virtualManager = this.virtualScrollManagers.get(elementType);

    if (virtualManager && virtualManager.isVirtualScrollEnabled()) {
      // 仮想スクロールの場合: アイテムを検索してスクロール
      const index = virtualManager.scrollToItem((item) => {
        const itemKey = `${elementType}_${item.displayId}_${item.modelSource}`;
        return itemKey === elementKey;
      }, 'center');

      if (index !== -1) {
        // 少し遅延してから選択状態を更新（レンダリング完了後）
        setTimeout(() => {
          const node = this.treeContainer.querySelector(`[data-element-key="${elementKey}"]`);
          if (node) {
            const header = node.querySelector('.tree-node-header');
            this._selectTreeElement(elementKey, header);
          }
        }, 50);
      }
      return;
    }

    // 通常のツリーノード検索
    const leafNodes = this.treeContainer.querySelectorAll('.tree-leaf-node');

    for (const node of leafNodes) {
      if (node.dataset.elementKey === elementKey) {
        const header = node.querySelector('.tree-node-header');
        this._selectTreeElement(elementKey, header);

        // ノードが見えるようにスクロール
        node.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
        });

        break;
      }
    }
  },

  /**
   * ツリー要素を選択（複数選択対応）
   * @param {string} elementKey - 要素キー
   * @param {HTMLElement} headerElement - ヘッダー要素
   * @param {Object} options - オプション
   * @param {boolean} options.addToSelection - 既存選択に追加
   * @param {boolean} options.rangeSelect - 範囲選択
   * @private
   */
  _selectTreeElement(elementKey, headerElement, options = {}) {
    const { addToSelection = false, rangeSelect = false } = options;

    if (rangeSelect && this.lastClickedElementKey && this.treeContainer) {
      // Shift+クリック: 範囲選択
      const allLeafNodes = Array.from(this.treeContainer.querySelectorAll('.tree-leaf-node'));
      const startKey = this.lastClickedElementKey;
      const endKey = elementKey;

      let startIdx = allLeafNodes.findIndex((n) => n.dataset.elementKey === startKey);
      let endIdx = allLeafNodes.findIndex((n) => n.dataset.elementKey === endKey);

      if (startIdx !== -1 && endIdx !== -1) {
        // 順序を調整
        if (startIdx > endIdx) {
          [startIdx, endIdx] = [endIdx, startIdx];
        }

        // 範囲内の要素を選択
        for (let i = startIdx; i <= endIdx; i++) {
          const node = allLeafNodes[i];
          const key = node.dataset.elementKey;
          this.selectedElementKeys.add(key);
          const header = node.querySelector('.tree-node-header');
          if (header) header.classList.add('selected');
        }
      }
    } else if (addToSelection) {
      // Ctrl+クリック: 追加選択またはトグル
      if (this.selectedElementKeys.has(elementKey)) {
        // 既に選択済み → 選択解除
        this.selectedElementKeys.delete(elementKey);
        if (headerElement) headerElement.classList.remove('selected');
      } else {
        // 新規追加
        this.selectedElementKeys.add(elementKey);
        if (headerElement) headerElement.classList.add('selected');
      }
    } else {
      // 通常クリック: 単一選択（既存選択を解除）
      if (this.treeContainer) {
        const previouslySelected = this.treeContainer.querySelectorAll(
          '.tree-node-header.selected',
        );
        previouslySelected.forEach((el) => el.classList.remove('selected'));
      }
      this.selectedElementKeys.clear();

      if (headerElement) {
        headerElement.classList.add('selected');
      }
      this.selectedElementKeys.add(elementKey);
    }

    // 最後にクリックした要素を記録（範囲選択用）
    this.lastClickedElementKey = elementKey;
  },

  /**
   * 選択されているすべてのツリー要素のキーを取得
   * @returns {string[]}
   * @private
   */
  _getSelectedTreeElementKeys() {
    return Array.from(this.selectedElementKeys);
  },
};

export default elementTreeSelectionMethods;
