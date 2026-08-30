/**
 * @fileoverview 断面ツリーの使用状況マップ作成・要素グルーピング処理
 *
 * SectionTreeView のプロトタイプへ Object.assign で合成されるメソッド群。
 * 可変状態（groupingMode など）は SectionTreeView インスタンス（this）にのみ存在し、
 * このモジュールはモジュールスコープの状態を一切保持しない。
 *
 * @module ui/panels/sectionTree/sectionTreeGrouping
 */

import { createLogger } from '../../../utils/logger.js';

const log = createLogger('sectionTreeView');

export const sectionTreeGroupingMethods = {
  /**
   * 断面の使用状況マップを作成
   * @param {Object} comparisonResult - 比較結果
   * @returns {Object} 断面使用状況マップ
   * @private
   */
  _createSectionUsageMap(comparisonResult) {
    const usageMap = {};

    if (!comparisonResult) {
      log.warn('comparisonResult is null or undefined');
      return usageMap;
    }

    // matched要素を処理
    if (comparisonResult.matched) {
      comparisonResult.matched.forEach((item) => {
        const elementA = item.elementA || item;
        const elementType = item.elementType;

        // 要素Aの断面情報
        if (elementA && elementA.element?.id_section) {
          this._addToUsageMap(usageMap, elementType, elementA.element.id_section, {
            elementId: elementA.id,
            elementType: elementType,
            modelSource: 'matched',
            name: elementA.name,
            guid: elementA.guid,
            coords: elementA.startCoords || elementA.coords,
          });
        }
      });
    }

    // onlyA要素を処理
    if (comparisonResult.onlyA) {
      comparisonResult.onlyA.forEach((item) => {
        const element = item.element || item;
        const elementType = item.elementType;

        if (element && element.id_section) {
          this._addToUsageMap(usageMap, elementType, element.id_section, {
            elementId: item.id || element.id,
            elementType: elementType,
            modelSource: 'onlyA',
            name: item.name,
            guid: item.guid,
            coords: item.coords,
          });
        }
      });
    }

    // onlyB要素を処理
    if (comparisonResult.onlyB) {
      comparisonResult.onlyB.forEach((item) => {
        const element = item.element || item;
        const elementType = item.elementType;

        if (element && element.id_section) {
          this._addToUsageMap(usageMap, elementType, element.id_section, {
            elementId: item.id || element.id,
            elementType: elementType,
            modelSource: 'onlyB',
            name: item.name,
            guid: item.guid,
            coords: item.coords,
          });
        }
      });
    }

    return usageMap;
  },

  /**
   * 使用状況マップに要素を追加
   * @param {Object} usageMap - 使用状況マップ
   * @param {string} elementType - 要素タイプ
   * @param {string} sectionId - 断面ID
   * @param {Object} elementInfo - 要素情報
   * @private
   */
  _addToUsageMap(usageMap, elementType, sectionId, elementInfo) {
    if (!usageMap[elementType]) {
      usageMap[elementType] = {};
    }
    if (!usageMap[elementType][sectionId]) {
      usageMap[elementType][sectionId] = [];
    }
    usageMap[elementType][sectionId].push(elementInfo);
  },

  /**
   * 要素をグループ化
   * @param {Array} elements - 要素のリスト
   * @returns {Object} グループ化された要素
   * @private
   */
  _groupElements(elements) {
    const groups = {};

    elements.forEach((elem) => {
      let groupKey;

      if (this.groupingMode === 'floor') {
        // 階ごとにグループ化
        const floor = this._extractFloorFromId(elem.elementId);
        groupKey = floor || '不明';
      } else if (this.groupingMode === 'code') {
        // 符号ごとにグループ化
        const code = this._extractCodeFromId(elem.elementId);
        groupKey = code || elem.elementId;
      } else {
        // グループ化なし
        groupKey = 'all';
      }

      if (!groups[groupKey]) {
        groups[groupKey] = [];
      }
      groups[groupKey].push(elem);
    });

    return groups;
  },

  /**
   * 要素IDから階番号を抽出
   * @param {string} elementId - 要素ID
   * @returns {string|null} 階番号（例: "1F", "2F"）
   * @private
   */
  _extractFloorFromId(elementId) {
    if (!elementId) return null;

    // パターン1: "1C1", "2G3" などの先頭が数字の場合
    const match1 = elementId.match(/^(\d+)[A-Z]/);
    if (match1) {
      return `${match1[1]}階`;
    }

    // パターン2: "F1C1", "F2G3" などのF+数字の場合
    const match2 = elementId.match(/^F(\d+)/i);
    if (match2) {
      return `${match2[1]}階`;
    }

    // パターン3: アンダースコア区切り "1_C1", "2_G3"
    const match3 = elementId.match(/^(\d+)_/);
    if (match3) {
      return `${match3[1]}階`;
    }

    return null;
  },

  /**
   * 要素IDから符号（階番号を除いた部分）を抽出
   * @param {string} elementId - 要素ID
   * @returns {string} 符号
   * @private
   */
  _extractCodeFromId(elementId) {
    if (!elementId) return elementId;

    // パターン1: "1C1" → "C1"
    const match1 = elementId.match(/^\d+([A-Z]\d+)/);
    if (match1) {
      return match1[1];
    }

    // パターン2: "F1C1" → "C1"
    const match2 = elementId.match(/^F\d+([A-Z]\d+)/i);
    if (match2) {
      return match2[1];
    }

    // パターン3: "1_C1" → "C1"
    const match3 = elementId.match(/^\d+_(.+)/);
    if (match3) {
      return match3[1];
    }

    return elementId;
  },
};

export default sectionTreeGroupingMethods;
