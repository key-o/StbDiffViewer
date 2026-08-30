/**
 * @fileoverview 差分一覧の行クリック → 3Dビュー／生XML連携メソッド
 *
 * 一覧アイテムのクリック委譲、3Dビューでの要素フォーカス（バッチ描画対応の要素検索を含む）、
 * 見つからない場合のトースト通知を担う。
 * DiffListPanel.prototype へ Object.assign して合成する（`this` はパネルインスタンス）。
 *
 * @module ui/panels/diffList/interactions
 */

import { sceneController } from '../../../app/controllers/sceneController.js';
import { selectElement3D } from '../../../app/controllers/interactionController.js';
import { findElementInGroup } from '../../../viewer/index.js';
import { UI_TIMING } from '../../../config/uiTimingConfig.js';
import { scheduleRender } from '../../../utils/renderScheduler.js';
import { createLogger } from '../../../utils/logger.js';
import { showRawXmlForElement } from '../rawXmlDiffViewer.js';

const log = createLogger('ui:panels:diffList');

export const diffListInteractionMethods = {
  /**
   * アイテムのクリックハンドラを設定（イベントデリゲーション使用）
   * @param {HTMLElement} container - コンテナ要素
   */
  setupItemClickHandlers(container) {
    // 既存のデリゲーションハンドラを削除
    if (this._containerClickHandler) {
      container.removeEventListener('click', this._containerClickHandler);
    }

    // イベントデリゲーション: コンテナに1つのリスナーのみ設定
    this._containerClickHandler = (event) => {
      const item = event.target.closest('.diff-item');
      if (!item) return;

      const elementType = item.dataset.elementType;
      const elementId = item.dataset.elementId;
      const category = item.dataset.category;
      const isRenderable = item.dataset.renderable !== 'false';

      // 生XMLアクション（非描画要素）クリック時は生XMLビューアで確認する
      if (event.target.closest('.item-raw-xml')) {
        showRawXmlForElement({ elementType, id: elementId, category });
        return;
      }

      // 展開トグルクリック時は3Dフォーカスせず属性差詳細を開閉する
      if (event.target.closest('.item-detail-toggle')) {
        this.toggleItemDetails(item);
        return;
      }

      if (elementType && elementId && isRenderable) {
        this.focusOnElement(elementType, elementId, category);
      } else if (elementType && elementId && category === 'attributeMismatch') {
        // 非描画（STB定義等）の属性不一致は行クリックでも詳細を開閉する
        this.toggleItemDetails(item);
      } else if (elementType && elementId) {
        // 非描画のA/Bのみ差分は行クリックでも生XMLで確認できるようにする
        showRawXmlForElement({ elementType, id: elementId, category });
      }
    };

    container.addEventListener('click', this._containerClickHandler);
  },

  /**
   * 3Dビューで要素にフォーカス
   * @param {string} elementType - 要素タイプ
   * @param {string} elementId - 要素ID
   * @param {string} category - カテゴリ ('onlyA' or 'onlyB')
   */
  focusOnElement(elementType, elementId, category) {
    const modelSource = this.getModelSourceForCategory(category);

    // 要素グループから該当要素を検索（バッチ描画: 節点/線要素にも対応）
    const group = sceneController.getElementGroups()[elementType];
    const hit = findElementInGroup(group, elementType, elementId, modelSource);

    if (!hit) {
      log.warn(`[UI] DiffList: 要素が見つかりません (type=${elementType}, id=${elementId})`);
      // 要素が見つからない場合のフィードバック
      this.showNotFoundMessage(elementType, elementId);
      return;
    }

    // 通常オブジェクト=ハイライト+回転中心 / バッチ要素=位置フォーカス+マーカー
    // を selectElement3D が hit の種別に応じて処理する。
    selectElement3D(hit.object, scheduleRender, { batchHit: hit });

    log.info(`[Event] 要素フォーカス: ${elementType} ${elementId} (${category})`);
  },

  /**
   * 差分カテゴリから3D側のモデルソースを取得
   * @param {string} category
   * @returns {'A'|'B'|'matched'}
   */
  getModelSourceForCategory(category) {
    if (category === 'onlyA') return 'A';
    if (category === 'onlyB') return 'B';
    return 'matched';
  },

  /**
   * 要素が見つからない場合のメッセージを表示
   * @param {string} elementType - 要素タイプ
   * @param {string} elementId - 要素ID
   */
  showNotFoundMessage(elementType, elementId) {
    this.showToast(`要素が見つかりません: ${elementType} ${elementId}`);
  },

  /**
   * 一時的なトースト通知を表示
   * @param {string} message
   */
  showToast(message) {
    // 既存のトーストを削除
    const existingToast = document.querySelector('.diff-list-toast');
    if (existingToast) {
      existingToast.remove();
    }

    // 新しいトーストを作成
    const toast = document.createElement('div');
    toast.className = 'diff-list-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    // 自動削除
    setTimeout(() => {
      toast.remove();
    }, UI_TIMING.TOAST_DURATION_MS);
  },
};
