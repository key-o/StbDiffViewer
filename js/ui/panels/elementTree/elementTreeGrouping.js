/**
 * @fileoverview 要素ツリーのグルーピング・ソート・比較結果マージ処理
 *
 * ElementTreeView のプロトタイプへ Object.assign で合成されるメソッド群。
 * 可変状態は ElementTreeView インスタンス（this）にのみ存在し、
 * このモジュールはモジュールスコープの状態を一切保持しない。
 *
 * @module ui/panels/elementTree/elementTreeGrouping
 */

import { ELEMENT_LABELS } from '../../../config/elementLabels.js';

export const elementTreeGroupingMethods = {
  /**
   * 要素をタイプ別にグループ化してソート
   * @param {Object} comparisonResult - 比較結果
   * @returns {Object} タイプ別にグループ化され、ソートされた要素
   * @private
   */
  _groupElementsByType(comparisonResult) {
    const groups = {};

    // 全要素タイプを初期化
    Object.keys(ELEMENT_LABELS).forEach((type) => {
      groups[type] = [];
    });

    // matched要素を追加
    if (comparisonResult.matched) {
      comparisonResult.matched.forEach((item) => {
        const elementType = item.elementType || item.type;
        if (elementType && groups[elementType]) {
          const element = item.elementA || item.elementB || item;
          groups[elementType].push({
            ...item,
            modelSource: 'matched',
            displayId: item.elementA?.id || item.id,
            name: element.name,
            guid: element.guid,
          });
        }
      });
    }

    // onlyA要素を追加
    if (comparisonResult.onlyA) {
      comparisonResult.onlyA.forEach((item) => {
        const elementType = item.elementType || item.type;
        if (elementType && groups[elementType]) {
          groups[elementType].push({
            ...item,
            modelSource: 'onlyA',
            displayId: item.id,
            name: item.name,
            guid: item.guid,
          });
        }
      });
    }

    // onlyB要素を追加
    if (comparisonResult.onlyB) {
      comparisonResult.onlyB.forEach((item) => {
        const elementType = item.elementType || item.type;
        if (elementType && groups[elementType]) {
          groups[elementType].push({
            ...item,
            modelSource: 'onlyB',
            displayId: item.id,
            name: item.name,
            guid: item.guid,
          });
        }
      });
    }

    // 各グループ内の要素をソート
    Object.keys(groups).forEach((elementType) => {
      groups[elementType] = this._sortElements(groups[elementType]);
    });

    return groups;
  },

  /**
   * 要素配列をソートモードに応じてソート
   * @param {Array} elements - 要素配列
   * @returns {Array} ソートされた要素配列
   * @private
   */
  _sortElements(elements) {
    return elements.sort((a, b) => {
      let aValue, bValue;

      switch (this.sortMode) {
        case 'name':
          aValue = a.name || a.displayId || '';
          bValue = b.name || b.displayId || '';
          return aValue.localeCompare(bValue, 'ja');

        case 'guid':
          aValue = a.guid || a.displayId || '';
          bValue = b.guid || b.displayId || '';
          return aValue.localeCompare(bValue);

        case 'id':
        default:
          aValue = a.displayId || '';
          bValue = b.displayId || '';
          // 数値として比較を試みる
          const aNum = parseInt(aValue, 10);
          const bNum = parseInt(bValue, 10);
          if (!isNaN(aNum) && !isNaN(bNum)) {
            return aNum - bNum;
          }
          return aValue.localeCompare(bValue);
      }
    });
  },

  _mergeComparisonResult(currentResult, nextResult, changedTypeSet) {
    const merged = {
      matched: [],
      onlyA: [],
      onlyB: [],
    };

    for (const category of ['matched', 'onlyA', 'onlyB']) {
      const currentItems = Array.isArray(currentResult?.[category]) ? currentResult[category] : [];
      const nextItems = Array.isArray(nextResult?.[category]) ? nextResult[category] : [];
      const nextChangedItems = nextItems.filter((item) =>
        changedTypeSet.has(item.elementType || item.type),
      );

      merged[category] = [
        ...currentItems.filter((item) => !changedTypeSet.has(item.elementType || item.type)),
        ...nextChangedItems,
      ];
    }

    return merged;
  },

  _insertTypeNodeInOrder(rootNode, typeNode, elementType) {
    const orderedTypes = Object.keys(ELEMENT_LABELS);
    const elementIndex = orderedTypes.indexOf(elementType);

    if (elementIndex === -1) {
      rootNode.appendChild(typeNode);
      return;
    }

    const existingTypeNodes = Array.from(
      rootNode.querySelectorAll(':scope > .tree-node[data-element-type]'),
    );
    const nextNode = existingTypeNodes.find((node) => {
      const nodeIndex = orderedTypes.indexOf(node.dataset.elementType);
      return nodeIndex > elementIndex;
    });

    if (nextNode) {
      rootNode.insertBefore(typeNode, nextNode);
    } else {
      rootNode.appendChild(typeNode);
    }
  },

  /**
   * 要素から要素タイプを取得するヘルパー
   * @param {Object} element - 要素データ
   * @returns {string} 要素タイプ
   * @private
   */
  _getElementType(element) {
    // elementTypeプロパティがあればそれを使用
    if (element.elementType) {
      return element.elementType;
    }
    // typeプロパティがあればそれを使用
    if (element.type) {
      return element.type;
    }
    // それ以外はUnknown
    return 'Unknown';
  },
};

export default elementTreeGroupingMethods;
