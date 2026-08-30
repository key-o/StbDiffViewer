/**
 * 要素ツリー表示コンポーネント
 * BIMVisionのような階層構造のツリービューを提供
 *
 * 機能:
 * - 要素タイプ別の階層表示
 * - ソート機能（ID/名前/GUID順）
 * - テキスト検索（ID、名前、GUID）
 * - 正規表現サポート（/pattern/ 形式）
 * - 差分ステータスフィルタ（一致/Aのみ/Bのみ）
 */

import {
  parseSearchPattern,
  matchesSearch,
  DEFAULT_STATUS_FILTER,
  DEFAULT_ELEMENT_TARGET_FILTER,
} from './treeSearch.js';
import { VIRTUAL_SCROLL_CONFIG } from '../../config/virtualScrollConfig.js';
import { BaseTreeView } from './BaseTreeView.js';
import { createLogger } from '../../utils/logger.js';
import { elementTreeGroupingMethods } from './elementTree/elementTreeGrouping.js';
import { elementTreeNodeMethods } from './elementTree/elementTreeNodes.js';
import { elementTreeSelectionMethods } from './elementTree/elementTreeSelection.js';
import { elementTreeContextMenuMethods } from './elementTree/elementTreeContextMenu.js';

const log = createLogger('ui:panels:elementTreeView');

// 仮想スクロール関連（SSOT: virtualScrollConfig.js）
const VIRTUAL_SCROLL_THRESHOLD = VIRTUAL_SCROLL_CONFIG.THRESHOLD;
const VIRTUAL_ITEM_HEIGHT = VIRTUAL_SCROLL_CONFIG.ITEM_HEIGHT.element;

class ElementTreeView extends BaseTreeView {
  constructor() {
    super({
      name: 'elementTree',
      emptyMessage: 'モデルを読み込んでください',
      searchPlaceholder: '検索... (/正規表現/)',
      showStatusFilter: true,
      searchTargetOptions: [
        { key: 'id', label: 'ID' },
        { key: 'name', label: '名前' },
        { key: 'guid', label: 'GUID' },
      ],
      defaultTargetFilter: DEFAULT_ELEMENT_TARGET_FILTER,
      virtualScrollThreshold: VIRTUAL_SCROLL_THRESHOLD,
      virtualItemHeight: VIRTUAL_ITEM_HEIGHT,
    });

    /** @type {Set<string>} */
    this.selectedElementKeys = new Set();
    this.lastClickedElementKey = null;
    this.sortMode = 'id'; // 'id', 'name', or 'guid'
    this.currentStatusFilter = { ...DEFAULT_STATUS_FILTER };
    this.totalElementCount = 0;
    this.filteredElementCount = 0;
  }

  // --- テンプレートメソッド オーバーライド ---

  /**
   * 検索実行時フック: currentStatusFilter も設定する
   * @param {string} searchText - 検索テキスト
   * @param {Object} statusFilter - ステータスフィルタ
   * @param {Object} targetFilter - 検索対象フィルタ
   */
  _onSearch(searchText, statusFilter, targetFilter) {
    this.currentSearchText = searchText;
    this.currentStatusFilter = statusFilter;
    this.currentTargetFilter = targetFilter;
    this.rebuild();
  }

  /**
   * 検索クリア時フック: currentStatusFilter もリセットする
   */
  _onSearchClear() {
    this.currentSearchText = '';
    this.currentStatusFilter = { ...DEFAULT_STATUS_FILTER };
    this.currentTargetFilter = { ...this.config.defaultTargetFilter };
  }

  /**
   * ツリークリア時フック: selectedElementKeys をクリアする
   */
  _onTreeCleared() {
    this.selectedElementKeys.clear();
  }

  /**
   * ツリーを再構築
   */
  rebuild() {
    this.buildTree(this.currentComparisonResult);
  }

  // --- 公開メソッド ---

  /**
   * ツリーを構築して表示
   * @param {Object} comparisonResult - 比較結果データ
   */
  buildTree(comparisonResult) {
    if (!this.treeContainer) {
      log.error('ツリービューが初期化されていません');
      return;
    }

    // 比較結果を保存
    this.currentComparisonResult = comparisonResult;

    // 検索UIを保持してツリー部分のみクリア
    this.clearTreeContent();

    if (!comparisonResult) {
      const emptyMessage = document.createElement('div');
      emptyMessage.className = 'tree-empty-message';
      emptyMessage.style.cssText = 'padding: 10px; text-align: center; color: #666;';
      emptyMessage.textContent = 'モデルを読み込んでください';
      this.treeContainer.appendChild(emptyMessage);
      this.totalElementCount = 0;
      this.filteredElementCount = 0;
      this.updateResultCount(0, 0);
      return;
    }

    // 検索パターンを解析
    const searchPattern = parseSearchPattern(this.currentSearchText);

    // ルートノードを作成
    const rootNode = document.createElement('div');
    rootNode.className = 'tree-root';

    // 要素タイプ別にグループ化
    const elementsByType = this._groupElementsByType(comparisonResult);

    // 全要素数をカウント
    this.totalElementCount = 0;
    this.filteredElementCount = 0;

    Object.keys(elementsByType).forEach((elementType) => {
      this.totalElementCount += elementsByType[elementType].length;
    });

    // 各要素タイプのノードを作成（フィルタリング適用）
    Object.keys(elementsByType).forEach((elementType) => {
      const elements = elementsByType[elementType];
      if (elements.length > 0) {
        // フィルタリングを適用
        const filteredElements = elements.filter((element) =>
          matchesSearch(element, searchPattern, this.currentStatusFilter, this.currentTargetFilter),
        );

        this.filteredElementCount += filteredElements.length;

        if (filteredElements.length > 0) {
          const typeNode = this._createTypeNode(elementType, filteredElements, searchPattern);
          rootNode.appendChild(typeNode);
        }
      }
    });

    // フィルタで全要素が非表示になった場合のメッセージ
    if (this.filteredElementCount === 0 && this.totalElementCount > 0) {
      const noResultMessage = document.createElement('div');
      noResultMessage.className = 'tree-no-result-message';
      noResultMessage.style.cssText = 'padding: 20px; text-align: center; color: #868e96;';
      noResultMessage.textContent = '検索条件に一致する要素がありません';
      rootNode.appendChild(noResultMessage);
    }

    this.treeContainer.appendChild(rootNode);

    // 検索結果数を更新
    this.updateResultCount(this.filteredElementCount, this.totalElementCount);
  }

  /**
   * 指定した要素タイプのみ差分更新
   * @param {Object} comparisonResult - 更新対象の比較結果データ
   * @param {Array<string>} changedElementTypes - 更新された要素タイプ
   */
  updateElementTypes(comparisonResult, changedElementTypes = []) {
    if (
      !this.treeContainer ||
      !this.currentComparisonResult ||
      !Array.isArray(changedElementTypes)
    ) {
      this.buildTree(comparisonResult || this.currentComparisonResult);
      return;
    }

    const changedTypeSet = new Set(changedElementTypes);
    this.currentComparisonResult = this._mergeComparisonResult(
      this.currentComparisonResult,
      comparisonResult,
      changedTypeSet,
    );

    const rootNode = this.treeContainer.querySelector('.tree-root');
    if (!rootNode) {
      this.buildTree(this.currentComparisonResult);
      return;
    }

    const searchPattern = parseSearchPattern(this.currentSearchText);
    const elementsByType = this._groupElementsByType(this.currentComparisonResult);

    for (const elementType of changedTypeSet) {
      const existingNode = rootNode.querySelector(`.tree-node[data-element-type="${elementType}"]`);
      if (existingNode) {
        existingNode.remove();
      }

      this._destroyVirtualScrollManager(elementType);

      const elements = elementsByType[elementType] || [];
      const filteredElements = elements.filter((element) =>
        matchesSearch(element, searchPattern, this.currentStatusFilter, this.currentTargetFilter),
      );

      if (filteredElements.length > 0) {
        const typeNode = this._createTypeNode(elementType, filteredElements, searchPattern);
        this._insertTypeNodeInOrder(rootNode, typeNode, elementType);
      }
    }

    this._refreshTreeCountsAndEmptyState(searchPattern, rootNode);
  }

  // --- 内部メソッド ---

  _refreshTreeCountsAndEmptyState(searchPattern, rootNode) {
    const elementsByType = this._groupElementsByType(this.currentComparisonResult);
    this.totalElementCount = 0;
    this.filteredElementCount = 0;

    Object.keys(elementsByType).forEach((elementType) => {
      const elements = elementsByType[elementType];
      this.totalElementCount += elements.length;
      this.filteredElementCount += elements.filter((element) =>
        matchesSearch(element, searchPattern, this.currentStatusFilter, this.currentTargetFilter),
      ).length;
    });

    const noResultMessage = rootNode.querySelector('.tree-no-result-message');
    if (this.filteredElementCount === 0 && this.totalElementCount > 0) {
      if (!noResultMessage) {
        const message = document.createElement('div');
        message.className = 'tree-no-result-message';
        message.style.cssText = 'padding: 20px; text-align: center; color: #868e96;';
        message.textContent = '検索条件に一致する要素がありません';
        rootNode.appendChild(message);
      }
    } else if (noResultMessage) {
      noResultMessage.remove();
    }

    this.updateResultCount(this.filteredElementCount, this.totalElementCount);
  }
}

// 責務ごとに分割したメソッド群をプロトタイプへ合成
// （可変状態は ElementTreeView インスタンスにのみ存在する）
Object.assign(
  ElementTreeView.prototype,
  elementTreeGroupingMethods,
  elementTreeNodeMethods,
  elementTreeSelectionMethods,
  elementTreeContextMenuMethods,
);

// シングルトンインスタンス
const instance = new ElementTreeView();

// 既存APIとの互換ラッパー関数

/**
 * ツリー表示を初期化
 * @param {string} containerId - ツリーを表示するコンテナーのID
 * @param {Function} onElementSelect - 要素選択時のコールバック関数
 * @param {Object} [options] - オプション
 * @param {Function} [options.onContextMenuAction] - コンテキストメニューアクションのコールバック
 */
export function initializeTreeView(containerId, onElementSelect, options) {
  instance.initialize(containerId, onElementSelect, options);
}

/**
 * ツリーを構築して表示
 * @param {Object} comparisonResult - 比較結果データ
 */
export function buildTree(comparisonResult) {
  instance.buildTree(comparisonResult);
}

/**
 * 指定した要素タイプのみツリーを差分更新
 * @param {Object} comparisonResult - 比較結果データ
 * @param {Array<string>} changedElementTypes - 更新された要素タイプ
 */
export function updateTreeElementTypes(comparisonResult, changedElementTypes) {
  instance.updateElementTypes(comparisonResult, changedElementTypes);
}

/**
 * 選択をクリア
 */
export function clearTreeSelection() {
  instance.clearTreeSelection();
}

/**
 * 3Dビューアーからの選択に応じてツリー内の要素を選択
 * @param {string} elementType - 要素タイプ
 * @param {string} elementId - 要素ID
 * @param {string} modelSource - モデルソース (matched, onlyA, onlyB)
 */
export function selectElementInTree(elementType, elementId, modelSource) {
  instance.selectElementInTree(elementType, elementId, modelSource);
}

/**
 * ツリーをクリア
 */
export function clearTree() {
  instance.clearTree();
}
