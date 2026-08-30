/**
 * @fileoverview 重要度設定UIパネル
 *
 * ST-Bridge要素の重要度設定を管理するUIコンポーネント。
 * タブ別の要素表示、重要度レベル変更、CSV入出力機能を提供します。
 */

import { getImportanceManager } from '../../app/importanceManager.js';
import { IMPORTANCE_LEVELS } from '../../constants/importanceLevels.js';
import { getState, setState } from '../../data/state/globalState.js';
import { comparisonController } from '../../app/controllers/comparisonController.js';
import { floatingWindowManager } from './floatingWindowManager.js';
import {
  eventBus,
  ImportanceEvents,
  ComparisonEvents,
  RenderEvents,
} from '../../data/events/index.js';
import { createLogger } from '../../utils/logger.js';
import {
  exportToCSV as csvExportToCSV,
  exportToJSON as csvExportToJSON,
  importFromCSV as csvImportFromCSV,
  importFromJSON as csvImportFromJSON,
  readFileAsText as csvReadFileAsText,
} from './importancePanelCsv.js';
import {
  resetToDefaults as presetsResetToDefaults,
  applyBulkImportance as presetsApplyBulkImportance,
} from './importancePanelPresets.js';
import { importancePanelTreeMethods } from './importancePanelTreeMethods.js';
import { importancePanelRenderMethods } from './importancePanelRenderMethods.js';
import { importancePanelStateMethods } from './importancePanelStateMethods.js';

const log = createLogger('importancePanel');

/**
 * 重要度設定パネルクラス
 */
class ImportancePanel {
  constructor() {
    this.manager = getImportanceManager();
    this.currentTab = 'StbCommon';
    this.filterText = '';
    this.filterImportance = 'all';
    this.categoryFilterText = '';
    this.parameterSortKey = 'paramName';
    this.parameterSortDirection = 'asc';
    this.isVisible = false;
    this.elementContainer = null;
    this.statisticsContainer = null;
    this.treeNodeCounter = 0;
    this._treeExpandedState = new Map(); // nodePath -> boolean

    this.setupEventListeners();
  }

  /**
   * イベントリスナーを設定する
   */
  setupEventListeners() {
    // 重要度設定変更イベント（EventBus経由）
    eventBus.on(ImportanceEvents.SETTINGS_CHANGED, (data) => {
      this.refreshCurrentTab();

      // 自動再描画を実行
      this.triggerAutoRedraw(data);
    });
  }

  /**
   * 重要度変更時の自動再描画を実行する
   * @param {Object} changeDetails - 変更の詳細情報
   */
  async triggerAutoRedraw(changeDetails = {}) {
    try {
      log.info('Starting auto-redraw after importance change:', changeDetails);

      // 比較結果の重要度情報を更新
      await this.updateVisualizationWithImportance();

      // 3D表示を再描画
      this.rerenderElements();

      // 統計情報を更新
      this.updateComparisonStatistics();

      log.info('Auto-redraw completed successfully');

      // 成功の通知イベントを発行（EventBus経由）
      eventBus.emit(ImportanceEvents.AUTO_REDRAW_COMPLETED, {
        success: true,
        changeDetails,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log.error('Auto-redraw failed:', error);

      // エラーの通知イベントを発行（EventBus経由）
      eventBus.emit(ImportanceEvents.AUTO_REDRAW_ERROR, {
        error: error.message,
        changeDetails,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * 重要度設定で比較結果の視覚化を更新する
   */
  async updateVisualizationWithImportance() {
    const currentResults = getState('comparisonResults');
    if (!currentResults) {
      log.info('No comparison results available for importance update');
      return;
    }

    log.info('Updating visualization with importance settings...');

    // 各要素タイプの比較結果を重要度で更新
    for (const [elementType, result] of currentResults.entries()) {
      try {
        const updatedResult = comparisonController.updateImportance(result, elementType);
        currentResults.set(elementType, updatedResult);
        log.info(`Updated importance for ${elementType}:`, {
          matched: updatedResult.matched.length,
          onlyA: updatedResult.onlyA.length,
          onlyB: updatedResult.onlyB.length,
        });
      } catch (error) {
        log.error(`Failed to update importance for ${elementType}:`, error);
      }
    }

    // 更新された結果をグローバル状態に保存
    setState('comparisonResults', currentResults);

    log.info('Visualization importance update completed');
  }

  /**
   * 3D要素の再描画を実行する
   */
  rerenderElements() {
    try {
      log.info('Rerendering 3D elements...');

      // 3Dビューアーの再描画を要求
      const viewer = getState('viewer');
      if (viewer && typeof viewer.requestRender === 'function') {
        viewer.requestRender();
      }

      // カスタム再描画イベントを発行（EventBus経由）
      eventBus.emit(RenderEvents.REQUEST_ELEMENT_RERENDER, {
        reason: 'importanceChange',
        timestamp: new Date().toISOString(),
      });

      log.info('Element rerender request completed');
    } catch (error) {
      log.error('Failed to rerender elements:', error);
      throw error;
    }
  }

  /**
   * 比較統計情報を更新する
   */
  updateComparisonStatistics() {
    try {
      log.info('Updating comparison statistics...');

      const currentResults = getState('comparisonResults');
      if (!currentResults) {
        return;
      }

      // 統計更新イベントを発行（EventBus経由）
      eventBus.emit(ComparisonEvents.UPDATE_STATISTICS, {
        comparisonResults: currentResults,
        reason: 'importanceChange',
        timestamp: new Date().toISOString(),
      });

      log.info('Comparison statistics update completed');
    } catch (error) {
      log.error('Failed to update comparison statistics:', error);
    }
  }

  /**
   * パネルを初期化する
   * @param {HTMLElement} containerElement - パネルを配置するコンテナー要素
   */
  initialize(containerElement) {
    this.containerElement = containerElement;
    this.createPanelHTML();

    // 要素参照の更新
    this.elementContainer = document.getElementById('importance-elements');
    this.statisticsContainer = document.getElementById('importance-statistics');
    this.categoryListContainer = document.getElementById('importance-category-list');

    this.bindEvents();

    // Windowマネージャに登録
    this.registerWithWindowManager();

    // 初期描画
    this.refreshCurrentTab();

    log.info('ImportancePanel initialized');
  }

  /**
   * Windowマネージャに登録
   */
  registerWithWindowManager() {
    floatingWindowManager.registerWindow({
      windowId: 'importance-panel',
      toggleButtonId: 'toggle-importance-panel-btn',
      closeButtonId: 'importance-panel-close',
      headerId: 'importance-panel-header',
      draggable: true,
      resizable: true,
      autoShow: false,
      onShow: () => {
        this.isVisible = true;
        this.refreshCurrentTab();
        setState('ui.importancePanelVisible', true);
      },
      onHide: () => {
        this.isVisible = false;
        setState('ui.importancePanelVisible', false);
      },
    });
  }

  /**
   * パネルのHTMLを作成する
   */
  createPanelHTML() {
    const panelHTML = `
      <div id="importance-panel" class="floating-window importance-panel">
        <div class="float-window-header" id="importance-panel-header">
          <span class="float-window-title">🏷️ 重要度設定</span>
          <div class="float-window-controls">
            <button class="float-window-btn" id="importance-panel-close">✕</button>
          </div>
        </div>
        
        <div class="importance-panel-body">
          <div class="importance-sidebar">
            <div class="importance-category-search">
              <input type="text" id="importance-category-filter" placeholder="カテゴリ検索...">
            </div>
            <ul id="importance-category-list" class="importance-category-list">
              <!-- カテゴリリストがここに表示される -->
            </ul>
          </div>
          
          <div class="importance-main-content">
            <div class="content-toolbar">
              <div class="mvd-config-section">
                <div id="importance-config-description" class="config-description">
                  S4はS2を包含します。各パラメータで S2 / S4 を個別に設定してください。
                </div>
              </div>

              <div class="importance-column-guide" aria-label="列説明">
                <span><strong>XSD必須</strong>: XSDで必須と定義される項目</span>
                <span><strong>項目名</strong>: 要素名/属性名</span>
                <span><strong>S2</strong>: チェック対象/対象外</span>
                <span><strong>S4</strong>: チェック対象/対象外</span>
              </div>

              <div class="search-box">
                 <input type="text" id="importance-filter-text" placeholder="パラメータ検索...">
              </div>
              
              <select id="importance-filter-level">
                <option value="all">全て</option>
                <option value="${IMPORTANCE_LEVELS.REQUIRED}">対象</option>
                <option value="${IMPORTANCE_LEVELS.NOT_APPLICABLE}">対象外</option>
              </select>

              <div class="dropdown-menu">
                <button class="btn-icon" id="importance-menu-btn">⋮</button>
                <div class="dropdown-content" id="importance-menu-content">
                   <button id="importance-export-csv" class="dropdown-item">CSV出力</button>
                   <button id="importance-import-csv-btn" class="dropdown-item">CSV読込</button>
                   <button id="importance-export-json" class="dropdown-item">JSON出力</button>
                   <button id="importance-import-json-btn" class="dropdown-item">JSON読込</button>
                   <button id="importance-reset-defaults" class="dropdown-item text-danger">デフォルトに戻す</button>
                   <input type="file" id="importance-import-csv" accept=".csv" style="display: none;" />
                   <input type="file" id="importance-import-json" accept=".json" style="display: none;" />
                </div>
              </div>
            </div>

            <div id="importance-elements" class="importance-table-container">
              <!-- パラメータテーブルがここに表示される -->
            </div>
            
            <div class="panel-controls importance-bulk-controls">
               <div class="control-group importance-bulk-group">
                  <label>一括変更:</label>
                  <select id="importance-bulk-level" class="importance-bulk-level">
                    <option value="">設定を選択...</option>
                    <option value="${IMPORTANCE_LEVELS.REQUIRED}">対象</option>
                    <option value="${IMPORTANCE_LEVELS.NOT_APPLICABLE}">対象外</option>
                  </select>
                  <button id="importance-bulk-apply" class="btn btn-sm btn-primary">適用</button>
               </div>
            </div>

            <div id="importance-statistics" class="statistics-bar">
              <!-- 簡易統計 -->
            </div>
          </div>
        </div>
      </div>
    `;

    this.containerElement.insertAdjacentHTML('beforeend', panelHTML);
    this.elementContainer = document.getElementById('importance-elements');
    this.statisticsContainer = document.getElementById('importance-statistics');
  }

  /**
   * イベントを関連付ける
   */
  bindEvents() {
    // パネル閉じるボタン
    document.getElementById('importance-panel-close').addEventListener('click', () => {
      this.hide();
    });

    // パラメータフィルター
    document.getElementById('importance-filter-text').addEventListener('input', (e) => {
      this.filterText = e.target.value;
      this.refreshParameterTable();
    });

    // カテゴリフィルター
    document.getElementById('importance-category-filter')?.addEventListener('input', (e) => {
      this.categoryFilterText = e.target.value || '';
      this.applyCategoryListFilter();
    });

    // ドロップダウンメニュー
    const menuBtn = document.getElementById('importance-menu-btn');
    const menuContent = document.getElementById('importance-menu-content');
    if (menuBtn && menuContent) {
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        menuContent.style.display = menuContent.style.display === 'block' ? 'none' : 'block';
      });
      document.addEventListener('click', () => {
        menuContent.style.display = 'none';
      });
      menuContent.addEventListener('click', (e) => e.stopPropagation());
    }

    document.getElementById('importance-filter-level').addEventListener('change', (e) => {
      this.filterImportance = e.target.value;
      this.refreshParameterTable();
    });

    // 一括適用
    document.getElementById('importance-bulk-apply').addEventListener('click', () => {
      this.applyBulkImportance();
    });

    // CSV機能
    document.getElementById('importance-export-csv').addEventListener('click', () => {
      this.exportToCSV();
      if (menuContent) menuContent.style.display = 'none';
    });

    document.getElementById('importance-import-csv-btn').addEventListener('click', () => {
      document.getElementById('importance-import-csv').click();
      if (menuContent) menuContent.style.display = 'none';
    });

    document.getElementById('importance-import-csv').addEventListener('change', (e) => {
      this.importFromCSV(e.target.files[0]);
    });

    // JSON機能
    document.getElementById('importance-export-json').addEventListener('click', () => {
      this.exportToJSON();
    });

    document.getElementById('importance-import-json-btn').addEventListener('click', () => {
      document.getElementById('importance-import-json').click();
      if (menuContent) menuContent.style.display = 'none';
    });

    document.getElementById('importance-import-json').addEventListener('change', (e) => {
      this.importFromJSON(e.target.files[0]);
      e.target.value = '';
    });

    // デフォルトリセット
    document.getElementById('importance-reset-defaults').addEventListener('click', () => {
      this.resetToDefaults();
      if (menuContent) menuContent.style.display = 'none';
    });
  }

  /**
   * パネルを表示する
   */
  show() {
    floatingWindowManager.showWindow('importance-panel');
  }

  /**
   * パネルを非表示にする
   */
  hide() {
    floatingWindowManager.hideWindow('importance-panel');
  }

  /**
   * パネルの表示状態を切り替える
   */
  toggle() {
    floatingWindowManager.toggleWindow('importance-panel');
  }

  /**
   * 現在のタブに一括で重要度を適用する（属性のみ）
   */
  applyBulkImportance() {
    presetsApplyBulkImportance(
      this.manager,
      this.currentTab,
      (paths) => this.filterElementPaths(paths),
      (level) => this.getBinaryLabel(level),
      () => this.refreshCurrentTab(),
    );
  }

  /**
   * CSV形式で設定をエクスポートする
   */
  exportToCSV() {
    csvExportToCSV(this.manager);
  }

  /**
   * JSON形式で設定をエクスポートする
   */
  exportToJSON() {
    csvExportToJSON(this.manager);
  }

  /**
   * JSONファイルから設定をインポートする
   * @param {File} file - JSONファイル
   */
  async importFromJSON(file) {
    await csvImportFromJSON(file, this.manager, () => this.refreshCurrentTab());
  }

  /**
   * CSVファイルから設定をインポートする
   * @param {File} file - CSVファイル
   */
  async importFromCSV(file) {
    await csvImportFromCSV(file, this.manager, () => this.refreshCurrentTab());
  }

  /**
   * ファイルをテキストとして読み込む
   * @param {File} file - 読み込むファイル
   * @returns {Promise<string>} ファイル内容
   */
  readFileAsText(file) {
    return csvReadFileAsText(file);
  }

  /**
   * 設定をデフォルトに戻す
   */
  resetToDefaults() {
    presetsResetToDefaults(this.manager, () => this.refreshCurrentTab());
  }

  /**
   * パネルのスタイルを動的に追加する
   * 注: スタイルは importance-*.css に外部化されました
   */
  static addStyles() {
    // スタイルは style/components/importance-*.css で定義
    // このメソッドは互換性のために残されています
  }
}

// スタイルを追加
Object.assign(
  ImportancePanel.prototype,
  importancePanelTreeMethods,
  importancePanelRenderMethods,
  importancePanelStateMethods,
);
ImportancePanel.addStyles();

// シングルトンインスタンス
let importancePanelInstance = null;

/**
 * ImportancePanelのシングルトンインスタンスを取得する
 * @returns {ImportancePanel} インスタンス
 */
export function getImportancePanel() {
  if (!importancePanelInstance) {
    importancePanelInstance = new ImportancePanel();
  }
  return importancePanelInstance;
}

/**
 * 重要度設定パネルを初期化する
 * @param {HTMLElement} containerElement - パネルを配置するコンテナー
 * @returns {ImportancePanel} 初期化済みのインスタンス
 */
export function initializeImportancePanel(containerElement = document.body) {
  const panel = getImportancePanel();
  panel.initialize(containerElement);
  return panel;
}

// デフォルトエクスポート
export default ImportancePanel;
