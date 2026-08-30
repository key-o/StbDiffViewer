/**
 * @fileoverview 要素ツリーのDOMノード生成処理
 *
 * ElementTreeView のプロトタイプへ Object.assign で合成されるメソッド群。
 * 可変状態は ElementTreeView インスタンス（this）にのみ存在し、
 * このモジュールはモジュールスコープの状態を一切保持しない。
 *
 * @module ui/panels/elementTree/elementTreeNodes
 */

import { highlightSearchMatch } from '../treeSearch.js';
import { ELEMENT_ICONS, ELEMENT_LABELS } from '../../../config/elementLabels.js';
import { VIRTUAL_SCROLL_CONFIG } from '../../../config/virtualScrollConfig.js';

// 仮想スクロール関連（SSOT: virtualScrollConfig.js）
const VIRTUAL_SCROLL_THRESHOLD = VIRTUAL_SCROLL_CONFIG.THRESHOLD;
const VIRTUAL_ITEM_HEIGHT = VIRTUAL_SCROLL_CONFIG.ITEM_HEIGHT.element;

export const elementTreeNodeMethods = {
  /**
   * 要素タイプノードを作成
   * @param {string} elementType - 要素タイプ
   * @param {Array} elements - 要素配列
   * @param {Object} searchPattern - 検索パターン（オプション）
   * @returns {HTMLElement} タイプノード
   * @private
   */
  _createTypeNode(elementType, elements, searchPattern = null) {
    const node = document.createElement('div');
    node.className = 'tree-node';
    node.dataset.elementType = elementType;

    const header = document.createElement('div');
    header.className = 'tree-node-header';

    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle';
    toggle.textContent = '\u25BC';

    const label = document.createElement('div');
    label.className = 'tree-node-label';

    const icon = document.createElement('span');
    icon.className = 'tree-node-icon';
    icon.textContent = ELEMENT_ICONS[elementType] || '\u25C9';

    const text = document.createElement('span');
    text.className = 'tree-node-text';
    text.textContent = ELEMENT_LABELS[elementType] || elementType;

    const count = document.createElement('span');
    count.className = 'tree-node-count';
    count.textContent = `(${elements.length})`;

    // 仮想スクロールが有効な場合はバッジを表示
    if (elements.length >= VIRTUAL_SCROLL_THRESHOLD) {
      const virtualBadge = document.createElement('span');
      virtualBadge.className = 'tree-virtual-badge';
      virtualBadge.textContent = '\u4EEE\u60F3';
      virtualBadge.title =
        '\u4EEE\u60F3\u30B9\u30AF\u30ED\u30FC\u30EB\u304C\u6709\u52B9\uFF08\u30D1\u30D5\u30A9\u30FC\u30DE\u30F3\u30B9\u6700\u9069\u5316\uFF09';
      virtualBadge.style.cssText = `
        font-size: var(--font-size-xs);
        background: #228be6;
        color: white;
        padding: 1px 4px;
        border-radius: 3px;
        margin-left: 4px;
      `;
      count.appendChild(virtualBadge);
    }

    label.appendChild(icon);
    label.appendChild(text);
    label.appendChild(count);

    header.appendChild(toggle);
    header.appendChild(label);

    // 子要素コンテナー
    const children = document.createElement('div');
    children.className = 'tree-node-children expanded';

    this._renderItemCollection(children, elements, {
      managerKey: elementType,
      threshold: VIRTUAL_SCROLL_THRESHOLD,
      itemHeight: VIRTUAL_ITEM_HEIGHT,
      bufferSize: VIRTUAL_SCROLL_CONFIG.BUFFER_SIZE,
      renderItem: (element) => this._createLeafNode(element, elementType, searchPattern),
      virtualContainerStyle: {
        height: '400px',
        overflow: 'hidden',
        position: 'relative',
      },
    });

    node.appendChild(header);
    node.appendChild(children);

    // トグル機能
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleNode(toggle, children);
    });

    header.addEventListener('click', (e) => {
      if (e.target !== toggle) {
        this._toggleNode(toggle, children);
      }
    });

    return node;
  },

  /**
   * 要素のリーフノードを作成
   * @param {Object} element - 要素データ
   * @param {string} elementType - 要素タイプ
   * @param {Object} searchPattern - 検索パターン（オプション）
   * @returns {HTMLElement} リーフノード
   * @private
   */
  _createLeafNode(element, elementType, searchPattern = null) {
    const node = document.createElement('div');
    node.className = 'tree-node tree-leaf-node';

    const header = document.createElement('div');
    header.className = 'tree-node-header';

    const label = document.createElement('div');
    label.className = 'tree-node-label';

    // ID と名前を表示
    const elementInfo = document.createElement('div');
    elementInfo.className = 'tree-element-info';

    const elementId = document.createElement('span');
    elementId.className = 'tree-element-id';
    const idText = element.displayId || element.id || 'N/A';
    const nameText = element.name;

    // ID と名前を組み合わせて表示（検索ハイライト付き）
    if (searchPattern && searchPattern.pattern) {
      elementId.appendChild(highlightSearchMatch(idText, searchPattern));
      if (nameText && nameText !== idText) {
        elementId.appendChild(document.createTextNode(' ('));
        elementId.appendChild(highlightSearchMatch(nameText, searchPattern));
        elementId.appendChild(document.createTextNode(')'));
      }
    } else {
      if (nameText && nameText !== idText) {
        elementId.textContent = `${idText} (${nameText})`;
      } else {
        elementId.textContent = idText;
      }
    }

    elementInfo.appendChild(elementId);

    // GUID を小さく表示（存在する場合）
    if (element.guid) {
      const guidSpan = document.createElement('div');
      guidSpan.className = 'tree-element-guid';
      // GUIDが長い場合は短縮表示
      const guidText =
        element.guid.length > 20 ? element.guid.substring(0, 20) + '...' : element.guid;

      // 検索ハイライト付き
      if (searchPattern && searchPattern.pattern) {
        guidSpan.appendChild(document.createTextNode('GUID: '));
        guidSpan.appendChild(highlightSearchMatch(guidText, searchPattern));
      } else {
        guidSpan.textContent = `GUID: ${guidText}`;
      }
      guidSpan.title = element.guid; // ツールチップに完全なGUIDを表示
      elementInfo.appendChild(guidSpan);
    }

    label.appendChild(elementInfo);

    // ステータスバッジを追加
    const status = document.createElement('span');
    status.className = `tree-element-status ${element.modelSource}`;

    if (element.modelSource === 'matched') {
      status.textContent = '\u4E00\u81F4';
    } else if (element.modelSource === 'onlyA') {
      status.textContent = 'A\u306E\u307F';
    } else if (element.modelSource === 'onlyB') {
      status.textContent = 'B\u306E\u307F';
    }

    label.appendChild(status);

    header.appendChild(label);
    node.appendChild(header);

    // クリックイベント（複数選択対応）
    const elementKey = `${elementType}_${element.displayId}_${element.modelSource}`;
    header.addEventListener('click', (event) => {
      const isMultiSelect = event.ctrlKey || event.metaKey;
      const isRangeSelect = event.shiftKey;

      this._selectTreeElement(elementKey, header, {
        addToSelection: isMultiSelect,
        rangeSelect: isRangeSelect,
      });

      // コールバック呼び出し
      if (this.onElementSelectCallback) {
        // 複数選択の場合は選択された全要素の情報を渡す
        const selectedKeys = this._getSelectedTreeElementKeys();
        if (selectedKeys.length > 1) {
          // 複数選択: 選択されたすべての要素情報を収集
          const selectedElements = selectedKeys.map((key) => {
            const parts = key.split('_');
            const modelSource = parts.pop();
            const elementId = parts.pop();
            const elemType = parts.join('_');
            return {
              elementType: elemType,
              elementId: elementId,
              modelSource: modelSource,
            };
          });
          this.onElementSelectCallback({
            multiSelect: true,
            selectedElements: selectedElements,
            // 最後にクリックした要素の情報も含める
            elementType: elementType,
            elementId: element.displayId,
            modelSource: element.modelSource,
            element: element,
          });
        } else {
          // 単一選択: 従来通り
          this.onElementSelectCallback({
            multiSelect: false,
            elementType: elementType,
            elementId: element.displayId,
            modelSource: element.modelSource,
            element: element,
          });
        }
      }
    });

    // データ属性を設定
    node.dataset.elementKey = elementKey;
    node.dataset.elementType = elementType;
    node.dataset.elementId = element.displayId;
    node.dataset.modelSource = element.modelSource;

    // 右クリックイベント（コンテキストメニュー）
    header.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();

      // まず要素を選択状態にする（まだ選択されていない場合）
      if (!this.selectedElementKeys.has(elementKey)) {
        this._selectTreeElement(elementKey, header, { addToSelection: false });
      }

      // コンテキストメニューを表示
      this._showElementContextMenu(event.clientX, event.clientY, element, elementType);
    });

    return node;
  },

  /**
   * ノードの展開/折りたたみをトグル
   * @param {HTMLElement} toggle - トグル要素
   * @param {HTMLElement} children - 子要素コンテナ
   * @private
   */
  _toggleNode(toggle, children) {
    if (children.classList.contains('expanded')) {
      children.classList.remove('expanded');
      children.classList.add('collapsed');
      toggle.classList.add('collapsed');
    } else {
      children.classList.remove('collapsed');
      children.classList.add('expanded');
      toggle.classList.remove('collapsed');
    }
  },
};

export default elementTreeNodeMethods;
