/**
 * @fileoverview 断面ツリーのDOMノード生成処理
 *
 * SectionTreeView のプロトタイプへ Object.assign で合成されるメソッド群。
 * 可変状態（groupingMode など）は SectionTreeView インスタンス（this）にのみ存在し、
 * このモジュールはモジュールスコープの状態を一切保持しない。
 *
 * @module ui/panels/sectionTree/sectionTreeNodes
 */

import { highlightSearchMatch } from '../treeSearch.js';
import { SECTION_LABELS } from '../../../config/elementLabels.js';
import { VIRTUAL_SCROLL_CONFIG } from '../../../config/virtualScrollConfig.js';

// 仮想スクロール関連（SSOT: virtualScrollConfig.js）
const VIRTUAL_SCROLL_THRESHOLD = VIRTUAL_SCROLL_CONFIG.THRESHOLD;
const VIRTUAL_ITEM_HEIGHT = VIRTUAL_SCROLL_CONFIG.ITEM_HEIGHT.section;

// 断面タイプの日本語名マップ - elementLabels.jsからインポートしたSECTION_LABELSを使用
const SECTION_TYPE_NAMES = SECTION_LABELS;

export const sectionTreeNodeMethods = {
  /**
   * 断面タイプノードを作成
   * @param {string} elementType - 要素タイプ
   * @param {Array} usedSections - 使用されている断面のリスト
   * @param {Object} searchPattern - 検索パターン（オプション）
   * @returns {HTMLElement} 断面タイプノード
   * @private
   */
  _createSectionTypeNode(elementType, usedSections, searchPattern = null) {
    const typeContainer = document.createElement('div');
    typeContainer.className = 'section-type-container';

    const typeHeader = document.createElement('div');
    typeHeader.className = 'section-type-header';

    // 検索中の場合は初期状態で展開
    const shouldExpand = !!(searchPattern && searchPattern.pattern);

    const toggleIcon = this._createToggleIcon(shouldExpand);

    const typeName = document.createElement('span');
    typeName.className = 'section-type-name';
    typeName.textContent = SECTION_TYPE_NAMES[elementType] || `${elementType}断面`;

    const sectionCount = document.createElement('span');
    sectionCount.className = 'section-count';
    sectionCount.textContent = `${usedSections.length}断面`;

    typeHeader.appendChild(toggleIcon);
    typeHeader.appendChild(typeName);
    typeHeader.appendChild(sectionCount);

    const sectionsContainer = document.createElement('div');
    sectionsContainer.className = 'sections-container';
    sectionsContainer.style.display = shouldExpand ? 'block' : 'none';

    // 各断面ノードを作成
    usedSections.forEach(({ sectionId, sectionData, elements }) => {
      const sectionNode = this._createSectionNode(
        elementType,
        sectionId,
        sectionData,
        elements,
        searchPattern,
      );
      sectionsContainer.appendChild(sectionNode);
    });

    // クリックで展開/折りたたみ
    typeHeader.addEventListener('click', () => {
      this._toggleNodeExpand(sectionsContainer, toggleIcon);
    });

    typeContainer.appendChild(typeHeader);
    typeContainer.appendChild(sectionsContainer);

    return typeContainer;
  },

  /**
   * 個別断面ノードを作成
   * @param {string} elementType - 要素タイプ
   * @param {string} sectionId - 断面ID
   * @param {Object} sectionData - 断面データ
   * @param {Array} elements - この断面を使用している要素のリスト
   * @param {Object} searchPattern - 検索パターン（オプション）
   * @returns {HTMLElement} 断面ノード
   * @private
   */
  _createSectionNode(elementType, sectionId, sectionData, elements, searchPattern = null) {
    const sectionContainer = document.createElement('div');
    sectionContainer.className = 'section-item-container';

    const sectionHeader = document.createElement('div');
    sectionHeader.className = 'section-item-header';

    const toggleIcon = this._createToggleIcon(false, 'section-toggle');

    const sectionIcon = document.createElement('span');
    sectionIcon.className = 'section-icon';
    sectionIcon.textContent = '📐';

    const sectionInfo = document.createElement('div');
    sectionInfo.className = 'section-info';

    const sectionName = document.createElement('span');
    sectionName.className = 'section-name';
    const displayName = sectionData?.name || sectionData?.shapeName || sectionId;

    // 検索ハイライトを適用
    if (searchPattern && searchPattern.pattern) {
      sectionName.appendChild(highlightSearchMatch(sectionId, searchPattern));
      if (displayName !== sectionId) {
        sectionName.appendChild(document.createTextNode(': '));
        sectionName.appendChild(highlightSearchMatch(displayName, searchPattern));
      }
    } else {
      sectionName.textContent = `${sectionId}${displayName !== sectionId ? `: ${displayName}` : ''}`;
    }

    const elementCount = document.createElement('span');
    elementCount.className = 'element-count';
    elementCount.textContent = `${elements.length}要素`;

    sectionInfo.appendChild(sectionName);
    if (sectionData?.section_type || sectionData?.kind) {
      const sectionType = document.createElement('div');
      sectionType.className = 'section-type-label';
      const typeText = sectionData.section_type || sectionData.kind || '';
      // 検索ハイライトを適用
      if (searchPattern && searchPattern.pattern) {
        sectionType.appendChild(highlightSearchMatch(typeText, searchPattern));
      } else {
        sectionType.textContent = typeText;
      }
      sectionInfo.appendChild(sectionType);
    }

    sectionHeader.appendChild(toggleIcon);
    sectionHeader.appendChild(sectionIcon);
    sectionHeader.appendChild(sectionInfo);
    sectionHeader.appendChild(elementCount);

    const elementsContainer = document.createElement('div');
    elementsContainer.className = 'section-elements-container';
    elementsContainer.style.display = 'none';

    // グループ化モードに応じて要素を整理
    const groupedElements = this._groupElements(elements);

    // 仮想スクロール用の変数
    let virtualManager = null;

    // グループごとにノードを作成
    Object.entries(groupedElements).forEach(([groupKey, groupElems]) => {
      if (this.groupingMode === 'floor' || this.groupingMode === 'code') {
        // グループヘッダーを作成
        const groupNode = this._createGroupNode(sectionId, groupKey, groupElems, elementType);
        elementsContainer.appendChild(groupNode);
      } else {
        // グループ化なしの場合
        virtualManager = this._renderItemCollection(elementsContainer, groupElems, {
          managerKey: this._createVirtualScrollManagerKey('section', sectionId, elementType),
          threshold: VIRTUAL_SCROLL_THRESHOLD,
          itemHeight: VIRTUAL_ITEM_HEIGHT,
          bufferSize: VIRTUAL_SCROLL_CONFIG.BUFFER_SIZE,
          renderItem: (elem) => this._createElementNode(elem, elementType),
          lazyInitialize: true,
          virtualContainerStyle: { height: '400px', overflow: 'hidden' },
        });
      }
    });

    // クリックで展開/折りたたみ または Ctrl+クリックで全要素選択
    sectionHeader.addEventListener('click', (e) => {
      e.stopPropagation();

      // Ctrl+クリック: この断面の全要素を選択
      if (e.ctrlKey || e.metaKey) {
        if (this.onElementSelectCallback && elements.length > 0) {
          // 全要素の情報を収集
          const selectedElements = elements.map((elem) => ({
            elementType: elementType,
            elementId: elem.displayId || elem.id,
            modelSource: elem.modelSource,
          }));

          this.onElementSelectCallback({
            multiSelect: true,
            selectedElements: selectedElements,
            sectionId: sectionId,
            sectionName: sectionData?.name || sectionData?.shapeName || sectionId,
          });
        }
        return;
      }

      // 通常クリック: 展開/折りたたみ
      const nowExpanded = this._toggleNodeExpand(elementsContainer, toggleIcon);

      // 仮想スクロールの初期化（初回展開時）
      if (nowExpanded && virtualManager && !virtualManager.isVirtualScrollEnabled()) {
        virtualManager.initialize(elements);
      }
    });

    // 右クリックイベント（コンテキストメニュー）
    sectionHeader.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._showSectionContextMenu(
        e.clientX,
        e.clientY,
        sectionId,
        sectionData,
        elements,
        elementType,
      );
    });

    sectionContainer.appendChild(sectionHeader);
    sectionContainer.appendChild(elementsContainer);

    return sectionContainer;
  },

  /**
   * グループノード（階や符号のグループ）を作成
   * @param {string} sectionId - 断面ID
   * @param {string} groupKey - グループキー
   * @param {Array} elements - グループ内の要素
   * @param {string} elementType - 要素タイプ
   * @returns {HTMLElement} グループノード
   * @private
   */
  _createGroupNode(sectionId, groupKey, elements, elementType) {
    const groupContainer = document.createElement('div');
    groupContainer.className = 'element-group-container';

    const groupHeader = document.createElement('div');
    groupHeader.className = 'element-group-header';

    const toggleIcon = this._createToggleIcon(false, 'group-toggle');

    const groupName = document.createElement('span');
    groupName.className = 'group-name';
    groupName.textContent = groupKey;

    const groupCount = document.createElement('span');
    groupCount.className = 'group-count';
    groupCount.textContent = `${elements.length}要素`;

    groupHeader.appendChild(toggleIcon);
    groupHeader.appendChild(groupName);
    groupHeader.appendChild(groupCount);

    const elementsContainer = document.createElement('div');
    elementsContainer.className = 'group-elements-container';
    elementsContainer.style.display = 'none';

    const virtualManager = this._renderItemCollection(elementsContainer, elements, {
      managerKey: this._createVirtualScrollManagerKey('group', sectionId, groupKey, elementType),
      threshold: VIRTUAL_SCROLL_THRESHOLD,
      itemHeight: VIRTUAL_ITEM_HEIGHT,
      bufferSize: VIRTUAL_SCROLL_CONFIG.BUFFER_SIZE,
      renderItem: (elem) => this._createElementNode(elem, elementType),
      lazyInitialize: true,
      virtualContainerStyle: { height: '400px', overflow: 'hidden' },
    });

    // クリックで展開/折りたたみ
    groupHeader.addEventListener('click', (e) => {
      e.stopPropagation();
      const nowExpanded = this._toggleNodeExpand(elementsContainer, toggleIcon);

      // 仮想スクロールの初期化（初回展開時）
      if (nowExpanded && virtualManager && !virtualManager.isVirtualScrollEnabled()) {
        virtualManager.initialize(elements);
      }
    });

    groupContainer.appendChild(groupHeader);
    groupContainer.appendChild(elementsContainer);

    return groupContainer;
  },

  /**
   * 個別要素ノードを作成
   * @param {Object} elementInfo - 要素情報
   * @param {string} elementType - 要素タイプ
   * @returns {HTMLElement} 要素ノード
   * @private
   */
  _createElementNode(elementInfo, elementType) {
    const elementNode = document.createElement('div');
    elementNode.className = 'section-tree-element-item';

    // 差分状態アイコン
    const diffIcon = document.createElement('span');
    diffIcon.className = `tree-diff-icon ${elementInfo.modelSource}`;
    if (elementInfo.modelSource === 'matched') {
      diffIcon.textContent = '●';
      diffIcon.style.color = '#12b886';
    } else if (elementInfo.modelSource === 'onlyA') {
      diffIcon.textContent = '●';
      diffIcon.style.color = '#37b24d';
    } else if (elementInfo.modelSource === 'onlyB') {
      diffIcon.textContent = '●';
      diffIcon.style.color = '#f03e3e';
    }

    // 要素情報
    const elementInfoDiv = document.createElement('div');
    elementInfoDiv.className = 'tree-element-info';

    const elementId = document.createElement('span');
    elementId.className = 'tree-element-id';

    const idText = elementInfo.elementId || 'N/A';
    const nameText = elementInfo.name;

    if (nameText && nameText !== idText) {
      elementId.textContent = `${idText} (${nameText})`;
    } else {
      elementId.textContent = idText;
    }

    elementInfoDiv.appendChild(elementId);

    // GUIDがあれば表示
    if (elementInfo.guid) {
      const guidSpan = document.createElement('div');
      guidSpan.className = 'tree-element-guid';
      const guidText =
        elementInfo.guid.length > 20 ? elementInfo.guid.substring(0, 20) + '...' : elementInfo.guid;
      guidSpan.textContent = `GUID: ${guidText}`;
      guidSpan.title = elementInfo.guid;
      elementInfoDiv.appendChild(guidSpan);
    }

    elementNode.appendChild(diffIcon);
    elementNode.appendChild(elementInfoDiv);

    // クリックで要素を選択
    elementNode.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.onElementSelectCallback) {
        this.onElementSelectCallback({
          elementType: elementType,
          elementId: elementInfo.elementId,
          modelSource: elementInfo.modelSource,
        });
      }
    });

    return elementNode;
  },
};

export default sectionTreeNodeMethods;
