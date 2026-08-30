/**
 * @fileoverview 重要度フィルタリング機能
 *
 * このファイルは、重要度レベル別の要素表示フィルタリング機能を提供します:
 * - 重要度レベル別の表示切り替え
 * - 一括選択・解除機能
 * - プリセットフィルタ（高重要度のみ等）
 * - フィルタ状態のステータス表示
 * - リアルタイムフィルタリング
 *
 * ユーザーは必要な重要度レベルの要素のみを表示することで、
 * 作業に集中でき、視覚的ノイズを削減できます。
 */

import { IMPORTANCE_LEVELS } from '../../constants/importanceLevels.js';
import { UI_TIMING } from '../../config/uiTimingConfig.js';
import { eventBus, ImportanceEvents, ComparisonEvents } from '../../data/events/index.js';
import { createLogger } from '../../utils/logger.js';
import { BaseFilter } from './BaseFilter.js';

const log = createLogger('importanceFilter');

/**
 * 重要度フィルタリングクラス
 * 重要度レベル別の表示切り替えを管理
 */
export class ImportanceFilter extends BaseFilter {
  constructor() {
    super({
      log,
      eventBus,
      events: ImportanceEvents,
      filterName: 'Importance',
    });
    this.activeFilters = new Set(Object.values(IMPORTANCE_LEVELS));
    this.presets = this.createDefaultPresets();

    this.setupEventListeners();
  }

  /**
   * デフォルトプリセットを作成
   * @returns {Object} プリセット定義
   */
  createDefaultPresets() {
    return {
      all: {
        name: '全て表示',
        levels: new Set(Object.values(IMPORTANCE_LEVELS)),
        description: 'すべての重要度レベルを表示',
      },
      highOnly: {
        name: '高重要度のみ',
        levels: new Set([IMPORTANCE_LEVELS.REQUIRED]),
        description: '高重要度の要素のみ表示',
      },
      mediumHigh: {
        name: '中・高重要度',
        levels: new Set([IMPORTANCE_LEVELS.REQUIRED, IMPORTANCE_LEVELS.OPTIONAL]),
        description: '中重要度と高重要度の要素を表示',
      },
      lowExcluded: {
        name: '低重要度除外',
        levels: new Set([IMPORTANCE_LEVELS.REQUIRED, IMPORTANCE_LEVELS.OPTIONAL]),
        description: '低重要度と対象外を除いた要素を表示',
      },
      differencesOnly: {
        name: '差分のみ（カスタム）',
        levels: new Set([IMPORTANCE_LEVELS.REQUIRED, IMPORTANCE_LEVELS.OPTIONAL]),
        description: '差分要素で重要度が高い要素のみ表示',
      },
    };
  }

  /**
   * イベントリスナーを設定
   */
  setupEventListeners() {
    eventBus.on(ImportanceEvents.FILTER_CHANGED, (_data) => {
      this.handleFilterChange(_data);
    });

    eventBus.on(ImportanceEvents.SETTINGS_CHANGED, (_data) => {
      if (this.isEnabled) {
        this.applyFilter();
      }
    });

    eventBus.on(ComparisonEvents.UPDATE_STATISTICS, (_data) => {
      if (this.isEnabled) {
        setTimeout(() => this.applyFilter(), UI_TIMING.FILTER_APPLY_DELAY_MS);
      }
    });
  }

  /**
   * 特定重要度レベルの表示切り替え
   * @param {string} level - 重要度レベル
   */
  toggleImportanceLevel(level) {
    if (!Object.values(IMPORTANCE_LEVELS).includes(level)) {
      log.warn(`Invalid importance level: ${level}`);
      return;
    }

    const wasActive = this.activeFilters.has(level);

    if (wasActive) {
      this.activeFilters.delete(level);
    } else {
      this.activeFilters.add(level);
    }

    this.saveToHistory();
    this.applyFilter();
    this.notifyFilterChange('toggle', {
      level,
      wasActive,
      isActive: !wasActive,
    });
  }

  /**
   * 全ての重要度レベルを表示
   */
  showAllLevels() {
    this.setActiveFilters(new Set(Object.values(IMPORTANCE_LEVELS)));
  }

  /**
   * 全ての重要度レベルを非表示
   */
  hideAllLevels() {
    this.setActiveFilters(new Set());
  }

  /**
   * プリセットフィルタを適用
   * @param {string} presetName - プリセット名
   */
  applyPreset(presetName) {
    const preset = this.presets[presetName];
    if (!preset) {
      log.warn(`Unknown preset: ${presetName}`);
      return;
    }

    this.setActiveFilters(new Set(preset.levels));
    this.notifyFilterChange('preset', { presetName, preset });
  }

  /**
   * 要素からフィルタ値（重要度）を取得
   * @param {THREE.Object3D} element
   * @returns {string}
   */
  _getFilterValueFromElement(element) {
    return element.userData.importance;
  }

  /**
   * 要素が表示されるべきかを判定
   * @param {string} importance - 要素の重要度
   * @returns {boolean} 表示すべきかどうか
   */
  shouldElementBeVisible(importance) {
    const effectiveImportance = importance || IMPORTANCE_LEVELS.REQUIRED;
    return this.activeFilters.has(effectiveImportance);
  }

  /**
   * フィルタ変更を処理
   * @param {Object} details - 変更詳細
   */
  handleFilterChange(details) {
    if (details.action === 'setFilters' && details.filters) {
      this.setActiveFilters(new Set(details.filters));
    } else if (details.action === 'toggleLevel' && details.level) {
      this.toggleImportanceLevel(details.level);
    } else if (details.action === 'applyPreset' && details.preset) {
      this.applyPreset(details.preset);
    }
  }

  /**
   * デバッグ情報を出力
   */
  debug() {
    log.info('ImportanceFilter Debug Info');
    log.info('Active filters:', Array.from(this.activeFilters));
    log.info('Is enabled:', this.isEnabled);
    log.info('Presets:', this.presets);
    log.info('History:', this.filterHistory);
    log.info('Stats:', this.getStats());
    log.infoEnd();
  }
}

/**
 * フィルタ状態インジケーター
 * UIでフィルタ状態を表示するためのヘルパークラス
 */
export class FilterStatusIndicator {
  constructor(containerElement) {
    this.container = containerElement;
    this.filter = null;
    this.isVisible = false;

    this.createElement();
    this.setupEventListeners();
  }

  createElement() {
    const indicatorHTML = `
      <div id="importance-filter-indicator" class="filter-indicator" style="display: none;">
        <div class="filter-status">
          <span class="filter-icon">\u{1F50D}</span>
          <span class="filter-text">\u30D5\u30A3\u30EB\u30BF: </span>
          <span class="filter-count">-/-</span>
        </div>
        <div class="filter-controls">
          <button class="filter-btn" data-action="showAll" title="\u3059\u3079\u3066\u8868\u793A">\u5168</button>
          <button class="filter-btn" data-action="hideAll" title="\u3059\u3079\u3066\u975E\u8868\u793A">\u7121</button>
          <button class="filter-btn" data-action="undo" title="\u5143\u306B\u623B\u3059">\u21B6</button>
          <button class="filter-btn toggle-btn" data-action="toggle" title="\u30D5\u30A3\u30EB\u30BF\u5207\u308A\u66FF\u3048">\u25CF</button>
        </div>
      </div>
    `;

    this.container.insertAdjacentHTML('beforeend', indicatorHTML);
    this.element = document.getElementById('importance-filter-indicator');

    this.addStyles();
  }

  addStyles() {
    // スタイルは style/components/importance-*.css で定義
  }

  setupEventListeners() {
    this.element.addEventListener('click', (e) => {
      if (e.target.classList.contains('filter-btn')) {
        const action = e.target.dataset.action;
        this.handleAction(action);
      }
    });

    eventBus.on(ImportanceEvents.FILTER_CHANGED, (data) => {
      this.updateDisplay(data);
    });

    eventBus.on(ImportanceEvents.FILTER_APPLIED, (data) => {
      this.updateStats(data);
    });
  }

  setFilter(filter) {
    this.filter = filter;
    this.updateDisplay();
  }

  handleAction(action) {
    if (!this.filter) return;

    switch (action) {
      case 'showAll':
        this.filter.showAllLevels();
        break;
      case 'hideAll':
        this.filter.hideAllLevels();
        break;
      case 'undo':
        this.filter.undo();
        break;
      case 'toggle':
        this.filter.setEnabled(!this.filter.isEnabled);
        break;
    }
  }

  updateDisplay(_details = {}) {
    if (!this.filter) return;

    const stats = this.filter.getStats();
    const isActive =
      this.filter.isEnabled &&
      this.filter.activeFilters.size < Object.values(IMPORTANCE_LEVELS).length;

    this.element.style.display = isActive ? 'flex' : 'none';

    this.updateStats(stats);

    const toggleBtn = this.element.querySelector('[data-action="toggle"]');
    toggleBtn.classList.toggle('active', this.filter.isEnabled);
  }

  updateStats(stats) {
    const countElement = this.element.querySelector('.filter-count');
    countElement.textContent = `${stats.visibleElements}/${stats.totalElements}`;

    if (stats.filterEfficiency > 50) {
      countElement.style.color = '#28a745';
    } else if (stats.filterEfficiency > 20) {
      countElement.style.color = '#ffc107';
    } else {
      countElement.style.color = '#666';
    }
  }

  setVisible(visible) {
    this.isVisible = visible;
    this.element.style.display = visible ? 'flex' : 'none';
  }
}

// グローバルフィルタインスタンス
export const globalImportanceFilter = new ImportanceFilter();

/**
 * フィルタシステムの初期化
 * @param {HTMLElement} indicatorContainer - インジケーター配置先
 * @returns {Object} フィルタとインジケーターのインスタンス
 */
export function initializeImportanceFilterSystem(indicatorContainer = document.body) {
  const indicator = new FilterStatusIndicator(indicatorContainer);
  indicator.setFilter(globalImportanceFilter);

  log.info('Importance filter system initialized');

  return {
    filter: globalImportanceFilter,
    indicator,
  };
}
