/**
 * @fileoverview UIイベント処理モジュール - エントリーポイント
 *
 * このモジュールはUIイベントリスナーと相互作用を管理します：
 * - イベントリスナー設定と管理
 * - UI相互作用処理
 * - イベント委譲と調整
 * - モデル可視性切り替え処理
 *
 * より良い整理のため、大きなui.jsモジュールから分割されました。
 *
 * @module ui/events
 */

// --- 各モジュールからのエクスポート ---
import {
  setupModelVisibilityListeners,
  teardownModelVisibilityListeners,
  toggleModelAVisibility,
  toggleModelBVisibility,
  getModelVisibilityStatus,
} from './modelVisibilityListeners.js';

import {
  setupSelectorChangeListeners,
  teardownSelectorChangeListeners,
  redrawAxesAtStory,
  resetAllSelectors,
  getSelectorStatus,
} from './selectorChangeListeners.js';

import {
  setupLabelToggleListeners,
  teardownLabelToggleListeners,
  setupLabelContentListener,
  teardownLabelContentListener,
} from './labelVisibilityListeners.js';

import {
  setupIfcExportListener,
  setupStbExportListener,
  setupReportExportListener,
  setupSs7ExportListener,
} from './exportListeners.js';

import {
  setupClippingRangeListeners,
  setupClippingButtonListeners,
  teardownClippingListeners,
} from './clippingListeners.js';

import {
  setupAccordionListeners,
  teardownAccordionListeners,
  expandAllAccordions,
  collapseAllAccordions,
  getAccordionSectionCount,
} from './accordionListeners.js';

import { toggleLegend, updateLegendContent, hasLegendPanel } from './legendListeners.js';

import { setupKeyboardShortcuts, setupWindowResizeListener } from './keyboardListeners.js';

import { setupMasterToggleListeners } from './masterToggleListeners.js';

import { setupFileDropListeners } from './fileDropListeners.js';

import { setupAppEventBridge } from './appEventBridge.js';
import { SS7_ENABLED } from '../../config/featureFlags.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('ui:events:index');

// --- 統合リスナー設定関数 ---

/**
 * Setup all UI event listeners
 */
export function setupUIEventListeners() {
  try {
    setupAppEventBridge();
    setupModelVisibilityListeners();
    setupSelectorChangeListeners();
    setupLabelToggleListeners();
    setupLabelContentListener();
    setupIfcExportListener();
    setupStbExportListener();
    setupReportExportListener();
    if (SS7_ENABLED) {
      setupSs7ExportListener();
    } else {
      // 公開ビルド（SS7無効）では SS7 CSV出力ボタンを DOM から除去する
      document.getElementById('exportSs7Btn')?.remove();
    }
    setupAccordionListeners();
    setupClippingRangeListeners();
    setupClippingButtonListeners();
    setupKeyboardShortcuts();
    setupWindowResizeListener();
    setupMasterToggleListeners();
    setupFileDropListeners();
  } catch (error) {
    log.error('UIイベントリスナーの設定中にエラーが発生しました:', error);
  }
}

/**
 * Teardown all UI event listeners
 */
export function teardownUIEventListeners() {
  try {
    teardownModelVisibilityListeners();
    teardownSelectorChangeListeners();
    teardownLabelToggleListeners();
    teardownLabelContentListener();
    teardownAccordionListeners();
    teardownClippingListeners();
  } catch (error) {
    log.error('UIイベントリスナーの解除中にエラーが発生しました:', error);
  }
}

/**
 * Get current UI event listener status
 * @returns {Object} Event listener status
 */
export function getEventListenerStatus() {
  const modelStatus = getModelVisibilityStatus();
  const selectorStatus = getSelectorStatus();

  return {
    modelAToggle: modelStatus.modelA,
    modelBToggle: modelStatus.modelB,
    legendPanel: hasLegendPanel(),
    storySelector: selectorStatus.storySelector,
    xAxisSelector: selectorStatus.xAxisSelector,
    yAxisSelector: selectorStatus.yAxisSelector,
    // toggleLegendBtn: removed
    accordionSections: getAccordionSectionCount(),
    clippingRangeSliders: document.querySelectorAll('.clip-range-slider').length,
  };
}

// --- Re-exports for backward compatibility ---
export {
  // Model visibility
  toggleModelAVisibility,
  toggleModelBVisibility,
  // Selectors
  redrawAxesAtStory,
  resetAllSelectors,
  // Legend
  toggleLegend,
  updateLegendContent,
  // Accordion
  expandAllAccordions,
  collapseAllAccordions,
  // Master toggle
  setupMasterToggleListeners,
};
