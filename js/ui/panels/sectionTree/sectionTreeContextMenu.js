/**
 * @fileoverview 断面ツリーのコンテキストメニュー処理
 *
 * SectionTreeView のプロトタイプへ Object.assign で合成されるメソッド群。
 * 可変状態は SectionTreeView インスタンス（this）にのみ存在し、
 * このモジュールはモジュールスコープの状態を一切保持しない。
 *
 * @module ui/panels/sectionTree/sectionTreeContextMenu
 */

import { showContextMenu } from '../../common/contextMenu.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('sectionTreeView');

export const sectionTreeContextMenuMethods = {
  /**
   * 断面のコンテキストメニューを表示
   * @param {number} x - X座標
   * @param {number} y - Y座標
   * @param {string} sectionId - 断面ID
   * @param {Object} sectionData - 断面データ
   * @param {Array} elements - この断面を使用している要素のリスト
   * @param {string} elementType - 要素タイプ
   * @private
   */
  _showSectionContextMenu(x, y, sectionId, sectionData, elements, elementType) {
    const menuItems = [
      {
        label: 'この断面の要素をすべて選択',
        icon: '☑️',
        action: () =>
          this._handleSelectAllSectionElements(sectionId, sectionData, elements, elementType),
        disabled: elements.length === 0,
      },
      { separator: true },
      {
        label: '断面情報をコピー',
        icon: '📋',
        action: () => this._handleCopySectionInfo(sectionId, sectionData, elements),
      },
      { separator: true },
      {
        label: `使用要素数: ${elements.length}`,
        icon: '📊',
        disabled: true,
      },
    ];

    showContextMenu(x, y, menuItems);
  },

  /**
   * 断面の全要素を選択
   * @param {string} sectionId - 断面ID
   * @param {Object} sectionData - 断面データ
   * @param {Array} elements - 要素リスト
   * @param {string} elementType - 要素タイプ
   * @private
   */
  _handleSelectAllSectionElements(sectionId, sectionData, elements, elementType) {
    if (!elements || elements.length === 0) {
      return;
    }

    // 選択上限チェック（100件）
    const limitedElements = elements.slice(0, 100);
    if (elements.length > 100) {
      log.warn(`選択上限（100要素）を超えました。最初の100要素のみ選択されます。`);
    }

    const selectedElements = limitedElements.map((elem) => ({
      elementType: elementType,
      elementId: elem.displayId || elem.id,
      modelSource: elem.modelSource,
    }));

    if (this.onElementSelectCallback) {
      this.onElementSelectCallback({
        multiSelect: true,
        selectedElements: selectedElements,
        sectionId: sectionId,
        sectionName: sectionData?.name || sectionData?.shapeName || sectionId,
      });
    }

    log.info(`断面「${sectionId}」の要素を${selectedElements.length}個選択しました`);
  },

  /**
   * 断面情報をクリップボードにコピー
   * @param {string} sectionId - 断面ID
   * @param {Object} sectionData - 断面データ
   * @param {Array} elements - 要素リスト
   * @private
   */
  _handleCopySectionInfo(sectionId, sectionData, elements) {
    const info = {
      断面ID: sectionId,
      断面名: sectionData?.name || sectionData?.shapeName || '-',
      断面タイプ: sectionData?.section_type || sectionData?.kind || '-',
      使用要素数: elements.length,
    };

    // 詳細情報があれば追加
    if (sectionData?.A) {
      info['面積(A)'] = sectionData.A;
    }
    if (sectionData?.Ix || sectionData?.Iy) {
      info['断面二次モーメント(Ix)'] = sectionData.Ix || '-';
      info['断面二次モーメント(Iy)'] = sectionData.Iy || '-';
    }
    if (sectionData?.Zx || sectionData?.Zy) {
      info['断面係数(Zx)'] = sectionData.Zx || '-';
      info['断面係数(Zy)'] = sectionData.Zy || '-';
    }

    const text = Object.entries(info)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');

    navigator.clipboard
      .writeText(text)
      .then(() => {
        log.info('断面情報をクリップボードにコピーしました');
        if (this.onContextMenuActionCallback) {
          this.onContextMenuActionCallback({
            action: 'copySectionInfo',
            success: true,
            sectionId: sectionId,
            info: info,
          });
        }
      })
      .catch((err) => {
        log.error('クリップボードへのコピーに失敗しました:', err);
      });
  },
};

export default sectionTreeContextMenuMethods;
