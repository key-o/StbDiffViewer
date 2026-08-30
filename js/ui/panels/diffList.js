/**
 * @fileoverview 差分一覧表示機能
 *
 * このファイルは、モデル比較結果の差分を一覧表示し、
 * クリックで3Dビューの該当要素にジャンプする機能を提供します:
 * - 差分カテゴリ（モデルAのみ、モデルBのみ）別の表示
 * - 要素タイプでのフィルタリング
 * - 3Dビューとの連携（ハイライト・フォーカス）
 * - 統計情報との連携
 *
 * テンプレート生成・データ収集・フィルタ・描画・3D連携の各メソッドは
 * diffList/ 配下へ分割し、DiffListPanel.prototype へ合成する（`this` の意味は変えない）。
 *
 * @module ui/panels/diffList
 */

import { getState, setState } from '../../data/state/globalState.js';
import { floatingWindowManager } from './floatingWindowManager.js';
import { ComparisonEvents } from '../../data/events/index.js';
import { VersionEvents } from '../../constants/eventTypes.js';
import { createLogger } from '../../utils/logger.js';
import { UIComponent } from '../common/UIComponent.js';
import { diffListPanelTemplateMethods } from './diffList/panelTemplate.js';
import { diffListDataCollectorMethods } from './diffList/dataCollector.js';
import { diffListFilterMethods } from './diffList/filters.js';
import { diffListRendererMethods } from './diffList/renderers.js';
import { diffListInteractionMethods } from './diffList/interactions.js';

const log = createLogger('ui:panels:diffList');

/**
 * 差分一覧表示クラス
 */
export class DiffListPanel extends UIComponent {
  constructor() {
    super();
    this.isVisible = false;
    this.containerElement = null;
    this.diffData = {
      onlyA: [],
      onlyB: [],
      attributeMismatch: [],
      matched: [],
      versionDifferences: [], // バージョン固有差分を追跡
    };
    this.currentFilter = {
      category: 'all', // 'all', 'onlyA', 'onlyB', 'versionOnly'
      elementType: 'all',
      showVersionDifferences: true, // バージョン固有差分を表示するか
    };
    this.elementTypes = new Set();
    this.versionInfo = { versionA: null, versionB: null, isCrossVersion: false };

    this.setupEventListeners();
  }

  /**
   * イベントリスナーを設定
   */
  setupEventListeners() {
    // 比較結果更新時（EventBus経由）
    this.onBus(ComparisonEvents.UPDATE_STATISTICS, (data) => {
      if (data && data.comparisonResults) {
        this.updateDiffList(data.comparisonResults);
      }
    });

    // バージョンフィルタ変更時
    this.onBus(VersionEvents.FILTER_CHANGED, (data) => {
      this.currentFilter.showVersionDifferences = data.showVersionSpecificDifferences;
      if (this.isVisible) {
        this.renderList();
      }
    });

    // バージョン情報更新時
    this.onBus(VersionEvents.INFO_UPDATED, (data) => {
      if (data) {
        this.versionInfo = {
          versionA: data.versionA,
          versionB: data.versionB,
          isCrossVersion:
            data.versionA !== data.versionB &&
            data.versionA !== 'unknown' &&
            data.versionB !== 'unknown',
        };
      }
    });
  }

  /**
   * パネルを初期化
   * @param {HTMLElement} containerElement - パネルを配置するコンテナ
   */
  initialize(containerElement) {
    this.containerElement = containerElement;
    this.createPanelHTML();
    this.bindEvents();
    this.registerWithWindowManager();

    log.info('[Event] DiffListPanel初期化完了');
  }

  /**
   * Windowマネージャに登録
   */
  registerWithWindowManager() {
    floatingWindowManager.registerWindow({
      windowId: 'diff-list-panel',
      toggleButtonId: null,
      closeButtonId: 'diff-list-close',
      headerId: 'diff-list-header',
      draggable: true,
      autoShow: false,
      onShow: () => {
        this.isVisible = true;
        this.refreshList();
        setState('ui.diffListPanelVisible', true);
      },
      onHide: () => {
        this.isVisible = false;
        setState('ui.diffListPanelVisible', false);
      },
    });
  }

  /**
   * イベントを関連付け
   */
  bindEvents() {
    // 閉じるボタン
    document.getElementById('diff-list-close').addEventListener('click', () => {
      this.hide();
    });

    // 更新ボタン
    document.getElementById('diff-list-refresh').addEventListener('click', () => {
      this.refreshList();
    });

    // カテゴリフィルタ
    document.getElementById('diff-category-filter').addEventListener('change', (e) => {
      this.currentFilter.category = e.target.value;
      this.renderList();
    });

    // 要素タイプフィルタ
    document.getElementById('diff-element-type-filter').addEventListener('change', (e) => {
      this.currentFilter.elementType = e.target.value;
      this.renderList();
    });
  }

  /**
   * リストを更新
   */
  refreshList() {
    const comparisonResults = getState('comparisonResults');
    if (comparisonResults) {
      this.updateDiffList(comparisonResults);
      this.renderList();
    }
  }

  /**
   * パネルを表示
   */
  show() {
    floatingWindowManager.showWindow('diff-list-panel');
  }

  /**
   * パネルを非表示
   */
  hide() {
    floatingWindowManager.hideWindow('diff-list-panel');
  }

  /**
   * パネルの表示切り替え
   */
  toggle() {
    floatingWindowManager.toggleWindow('diff-list-panel');
  }

  /**
   * 差分データを取得
   * @returns {Object} 差分データ
   */
  getDiffData() {
    return this.diffData;
  }
}

// 責務ごとに分割したメソッド群をプロトタイプへ合成する
Object.assign(
  DiffListPanel.prototype,
  diffListPanelTemplateMethods,
  diffListDataCollectorMethods,
  diffListFilterMethods,
  diffListRendererMethods,
  diffListInteractionMethods,
);

// シングルトンインスタンス
let diffListPanelInstance = null;

/**
 * DiffListPanelのシングルトンインスタンスを取得
 * @returns {DiffListPanel} インスタンス
 */
function getDiffListPanel() {
  if (!diffListPanelInstance) {
    diffListPanelInstance = new DiffListPanel();
  }
  return diffListPanelInstance;
}

/**
 * 差分一覧パネルを初期化
 * @param {HTMLElement} containerElement - パネルを配置するコンテナ
 * @returns {DiffListPanel} 初期化済みのインスタンス
 */
export function initializeDiffListPanel(containerElement = document.body) {
  const panel = getDiffListPanel();
  panel.initialize(containerElement);
  return panel;
}

export default DiffListPanel;
