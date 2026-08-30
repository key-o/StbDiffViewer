/**
 * @fileoverview 要素ツリーのコンテキストメニュー処理
 *
 * ElementTreeView のプロトタイプへ Object.assign で合成されるメソッド群。
 * 可変状態は ElementTreeView インスタンス（this）にのみ存在し、
 * このモジュールはモジュールスコープの状態を一切保持しない。
 *
 * @module ui/panels/elementTree/elementTreeContextMenu
 */

import { showContextMenu } from '../../common/contextMenu.js';
import { ELEMENT_LABELS } from '../../../config/elementLabels.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('ui:panels:elementTreeView');

export const elementTreeContextMenuMethods = {
  /**
   * 要素のコンテキストメニューを表示
   * @param {number} x - X座標
   * @param {number} y - Y座標
   * @param {Object} element - 要素データ
   * @param {string} elementType - 要素タイプ
   * @private
   */
  _showElementContextMenu(x, y, element, elementType) {
    const selectedCount = this.selectedElementKeys.size;
    const isMultipleSelected = selectedCount > 1;

    const menuItems = [
      {
        label: isMultipleSelected
          ? `${selectedCount}\u500B\u306E\u8981\u7D20\u3092\u975E\u8868\u793A`
          : '\u8981\u7D20\u3092\u975E\u8868\u793A',
        icon: '\uD83D\uDC41\uFE0F',
        action: () => this._handleHideElements(element, elementType),
      },
      { separator: true },
      {
        label: '\u540C\u3058\u30BF\u30A4\u30D7\u306E\u8981\u7D20\u3092\u5168\u9078\u629E',
        icon: '\u2611\uFE0F',
        action: () => this._handleSelectAllOfType(elementType),
      },
      { separator: true },
      {
        label: '\u30D7\u30ED\u30D1\u30C6\u30A3\u3092\u30B3\u30D4\u30FC',
        icon: '\uD83D\uDCCB',
        action: () => this._handleCopyProperties(element, elementType),
        disabled: isMultipleSelected,
      },
    ];

    showContextMenu(x, y, menuItems);
  },

  /**
   * 要素を非表示にする
   * @param {Object} element - 要素データ
   * @param {string} elementType - 要素タイプ
   * @private
   */
  _handleHideElements(element, elementType) {
    const selectedKeys = Array.from(this.selectedElementKeys);

    if (selectedKeys.length > 1) {
      // 複数選択の場合
      const elements = selectedKeys.map((key) => {
        const parts = key.split('_');
        const modelSource = parts.pop();
        const elementId = parts.pop();
        const elemType = parts.join('_');
        return { elementType: elemType, elementId, modelSource };
      });

      if (this.onContextMenuActionCallback) {
        this.onContextMenuActionCallback({
          action: 'hide',
          multiple: true,
          elements: elements,
        });
      }
    } else {
      // 単一選択の場合
      if (this.onContextMenuActionCallback) {
        this.onContextMenuActionCallback({
          action: 'hide',
          multiple: false,
          elementType: elementType,
          elementId: element.displayId,
          modelSource: element.modelSource,
          element: element,
        });
      }
    }
  },

  /**
   * 同じタイプの要素を全選択
   * @param {string} elementType - 要素タイプ
   * @private
   */
  _handleSelectAllOfType(elementType) {
    if (!this.treeContainer || !this.currentComparisonResult) {
      return;
    }

    // 同じタイプの全要素を収集
    const elementsOfType = [];

    // matched
    if (this.currentComparisonResult.matched) {
      this.currentComparisonResult.matched.forEach((pair) => {
        if (pair.a && this._getElementType(pair.a) === elementType) {
          elementsOfType.push({
            elementType: elementType,
            elementId: pair.a.displayId || pair.a.id,
            modelSource: 'matched',
          });
        }
      });
    }

    // onlyA
    if (this.currentComparisonResult.onlyA) {
      this.currentComparisonResult.onlyA.forEach((elem) => {
        if (this._getElementType(elem) === elementType) {
          elementsOfType.push({
            elementType: elementType,
            elementId: elem.displayId || elem.id,
            modelSource: 'onlyA',
          });
        }
      });
    }

    // onlyB
    if (this.currentComparisonResult.onlyB) {
      this.currentComparisonResult.onlyB.forEach((elem) => {
        if (this._getElementType(elem) === elementType) {
          elementsOfType.push({
            elementType: elementType,
            elementId: elem.displayId || elem.id,
            modelSource: 'onlyB',
          });
        }
      });
    }

    // ツリー上の対応するノードを選択
    this.clearTreeSelection();

    elementsOfType.forEach((elem) => {
      const elementKey = `${elem.elementType}_${elem.elementId}_${elem.modelSource}`;
      const node = this.treeContainer.querySelector(`[data-element-key="${elementKey}"]`);
      if (node) {
        const header = node.querySelector('.tree-node-header');
        if (header) {
          this.selectedElementKeys.add(elementKey);
          header.classList.add('selected');
        }
      }
    });

    // 選択数の上限チェック（100件）
    if (this.selectedElementKeys.size > 100) {
      log.warn(
        '\u9078\u629E\u4E0A\u9650\uFF08100\u8981\u7D20\uFF09\u3092\u8D85\u3048\u307E\u3057\u305F\u3002\u6700\u521D\u306E100\u8981\u7D20\u306E\u307F\u9078\u629E\u3055\u308C\u307E\u3059\u3002',
      );
      const keysArray = Array.from(this.selectedElementKeys);
      this.selectedElementKeys.clear();
      keysArray.slice(0, 100).forEach((key) => this.selectedElementKeys.add(key));
    }

    // コールバックを呼び出す
    if (this.onElementSelectCallback && elementsOfType.length > 0) {
      this.onElementSelectCallback({
        multiSelect: true,
        selectedElements: elementsOfType.slice(0, 100),
      });
    }

    log.info(
      `${elementType}\u30BF\u30A4\u30D7\u306E\u8981\u7D20\u3092${Math.min(elementsOfType.length, 100)}\u500B\u9078\u629E\u3057\u307E\u3057\u305F`,
    );
  },

  /**
   * 要素のプロパティをクリップボードにコピー
   * @param {Object} element - 要素データ
   * @param {string} elementType - 要素タイプ
   * @private
   */
  _handleCopyProperties(element, elementType) {
    const properties = {
      '\u30BF\u30A4\u30D7': ELEMENT_LABELS[elementType] || elementType,
      ID: element.displayId || element.id,
      '\u540D\u524D': element.name || '-',
      GUID: element.guid || '-',
      '\u30B9\u30C6\u30FC\u30BF\u30B9':
        element.modelSource === 'matched'
          ? '\u4E00\u81F4'
          : element.modelSource === 'onlyA'
            ? 'A\u306E\u307F'
            : element.modelSource === 'onlyB'
              ? 'B\u306E\u307F'
              : '-',
    };

    // 追加のプロパティがあれば追加
    if (element.section) {
      properties['\u65AD\u9762'] = element.section;
    }
    if (element.material) {
      properties['\u6750\u8CEA'] = element.material;
    }

    const text = Object.entries(properties)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');

    navigator.clipboard
      .writeText(text)
      .then(() => {
        log.info(
          '\u30D7\u30ED\u30D1\u30C6\u30A3\u3092\u30AF\u30EA\u30C3\u30D7\u30DC\u30FC\u30C9\u306B\u30B3\u30D4\u30FC\u3057\u307E\u3057\u305F',
        );
        // 簡易的なフィードバック（将来的にトースト通知に置き換え）
        if (this.onContextMenuActionCallback) {
          this.onContextMenuActionCallback({
            action: 'copyProperties',
            success: true,
            elementType: elementType,
            elementId: element.displayId,
            properties: properties,
          });
        }
      })
      .catch((err) => {
        log.error(
          '\u30AF\u30EA\u30C3\u30D7\u30DC\u30FC\u30C9\u3078\u306E\u30B3\u30D4\u30FC\u306B\u5931\u6557\u3057\u307E\u3057\u305F:',
          err,
        );
      });
  },
};

export default elementTreeContextMenuMethods;
