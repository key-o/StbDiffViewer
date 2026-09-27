/**
 * @fileoverview App→UIイベントブリッジ
 *
 * app層がeventBusで発行したイベントを受け取り、実際のUI関数を呼び出します。
 * これにより app/ が ui/ に直接依存する R1 違反を解消します。
 *
 * @module ui/events/appEventBridge
 */

import {
  eventBus,
  AppEvents,
  InteractionEvents,
  LoadingIndicatorEvents,
  FinalizationEvents,
  ComparisonEvents,
  ViewEvents,
  RenderEvents,
} from '../../data/events/index.js';
import { floatingWindowManager } from '../panels/floatingWindowManager.js';

import { clearUIState, setGlobalStateForUI } from '../state.js';
import {
  clearTree,
  clearTreeSelection,
  selectElementInTree,
  buildTree,
  updateTreeElementTypes,
} from '../panels/elementTreeView.js';
import { clearSectionTree } from '../panels/sectionTreeView.js';
import { showContextMenu, initializeContextMenu } from '../common/contextMenu.js';
import {
  displayElementInfo,
  displayMultiSelectionSummary,
} from '../panels/element-info/ElementInfoDisplay.js';
import { displayRebarInfo } from '../panels/element-info/RebarElementInfo.js';
import { mountBatchPropertyEditor } from '../panels/element-info/editMode/batchPropertyEditor.js';
import { mountCadOperationPanel } from '../panels/element-info/editMode/cadOperationPanel.js';
import { activateSectionBoxForBox } from '../viewer3d/sectionBox.js';
import {
  getLoadingIndicator,
  showLoading,
  hideLoading,
  completeLoading,
} from '../common/loadingIndicator.js';
import { updateStorySelector, updateAxisSelectors } from '../viewer3d/selectors.js';
import { updateLabelVisibility, handleColorModeChange } from '../viewer3d/unifiedLabelManager.js';
import { updateLegendContent } from './legendListeners.js';
import { refreshElementInfoPanel } from '../panels/element-info/ElementInfoDisplay.js';
import { convertComparisonResultsForTree } from '../../data/converters/comparison-to-tree.js';

function scheduleUiIdle(task) {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(task, { timeout: 100 });
  } else {
    setTimeout(task, 0);
  }
}

/**
 * app層イベントをUI関数に接続するブリッジを初期化
 */
export function setupAppEventBridge() {
  // --- AppEvents ---
  eventBus.on(AppEvents.CLEAR_UI_STATE, clearUIState);

  eventBus.on(AppEvents.CLEAR_TREE, () => {
    clearTree();
    clearTreeSelection();
  });

  eventBus.on(AppEvents.CLEAR_SECTION_TREE, clearSectionTree);

  // --- InteractionEvents ---
  eventBus.on(
    InteractionEvents.DISPLAY_ELEMENT_INFO,
    ({ idA, idB, elementType, modelSource } = {}) => {
      displayElementInfo(idA, idB, elementType, modelSource);
      mountCadOperationPanel();
    },
  );

  eventBus.on(InteractionEvents.DISPLAY_REBAR_INFO, (rebarInfo = {}) => {
    displayElementInfo(null, null, null);
    displayRebarInfo(rebarInfo);
  });

  eventBus.on(InteractionEvents.DISPLAY_MULTI_SELECTION_INFO, (summaryData = {}) => {
    displayMultiSelectionSummary(summaryData);
    mountBatchPropertyEditor();
    mountCadOperationPanel();
  });

  eventBus.on(
    InteractionEvents.SELECT_ELEMENT_IN_TREE,
    ({ elementType, elementId, modelSource } = {}) => {
      selectElementInTree(elementType, elementId, modelSource);
    },
  );

  eventBus.on(InteractionEvents.SHOW_CONTEXT_MENU, ({ x, y, menuItems } = {}) => {
    showContextMenu(x, y, menuItems);
  });

  eventBus.on(InteractionEvents.INIT_CONTEXT_MENU, initializeContextMenu);

  // 右クリックメニュー等からの表示系ウィンドウ表示要求（トグルではなく確実に開く）
  eventBus.on(InteractionEvents.OPEN_WINDOW, ({ windowId } = {}) => {
    if (windowId) {
      floatingWindowManager.showWindow(windowId);
    }
  });

  // モデル読み込み完了時に要素情報パネルを自動表示（差分サマリーと同様）。
  // 中身は空（要素未選択）で表示され、以後の選択で内容が更新される。
  eventBus.on(RenderEvents.MODEL_LOADED, () => {
    floatingWindowManager.showWindow('component-info');
  });

  eventBus.on(InteractionEvents.ACTIVATE_SECTION_BOX_FOR_SELECTION, ({ box3 } = {}) => {
    if (box3) {
      activateSectionBoxForBox(box3);
    }
  });

  // --- LoadingIndicatorEvents ---
  eventBus.on(LoadingIndicatorEvents.SHOW, ({ message } = {}) => {
    showLoading(message);
  });

  eventBus.on(LoadingIndicatorEvents.UPDATE, ({ progress, message, detail } = {}) => {
    const indicator = getLoadingIndicator();
    indicator.update(progress, message, detail);
  });

  eventBus.on(LoadingIndicatorEvents.COMPLETE, ({ message } = {}) => {
    completeLoading(message);
  });

  eventBus.on(LoadingIndicatorEvents.HIDE, () => {
    hideLoading();
  });

  eventBus.on(LoadingIndicatorEvents.ERROR, ({ message } = {}) => {
    const indicator = getLoadingIndicator();
    indicator.error(message);
    setTimeout(() => hideLoading(), 3000);
  });

  // --- FinalizationEvents ---
  eventBus.on(FinalizationEvents.SET_GLOBAL_STATE, ({ nodeLabels, stories, axesData } = {}) => {
    setGlobalStateForUI(nodeLabels, stories, axesData);
  });

  eventBus.on(FinalizationEvents.UPDATE_SELECTORS, () => {
    scheduleUiIdle(() => {
      updateStorySelector();
      updateAxisSelectors();
    });
    scheduleUiIdle(() => {
      updateLabelVisibility();
    });
  });

  // --- ViewEvents (色付けモード変更通知) ---
  eventBus.on(ViewEvents.COLOR_MODE_CHANGED, (_payload) => {
    // ラベル管理システムに通知
    handleColorModeChange();

    // 凡例を表示中の場合は内容を更新
    const legendPanel = document.getElementById('legendPanel');
    if (legendPanel && legendPanel.style.display !== 'none') {
      updateLegendContent();
    }

    // 要素情報パネルを更新
    refreshElementInfoPanel();
  });

  // --- ComparisonEvents (編集後の再比較でTree View を再構築) ---
  eventBus.on(
    ComparisonEvents.UPDATE_STATISTICS,
    ({ reason, comparisonResults, changedElementTypes } = {}) => {
      if (!comparisonResults) {
        return;
      }

      const hasChangedElementTypes =
        Array.isArray(changedElementTypes) && changedElementTypes.length > 0;

      // modelComparison は既存フローで buildTree されるためここでは無視
      if (reason === 'modelComparison') {
        return;
      }

      if (hasChangedElementTypes) {
        const treeData = convertComparisonResultsForTree(comparisonResults, changedElementTypes);
        updateTreeElementTypes(treeData, changedElementTypes);
        return;
      }

      // reason が editRecomparison 以外でも、type 指定が無い統計更新は全体更新で安全側に倒す
      const treeData = convertComparisonResultsForTree(comparisonResults);
      buildTree(treeData);
    },
  );
}
