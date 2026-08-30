/**
 * @fileoverview ラベル表示切り替えイベントリスナー
 *
 * ラベルの表示切り替えとコンテンツ変更を処理するイベントリスナー。
 *
 * @module ui/events/labelVisibilityListeners
 */

import { regenerateAllLabels, updateLabelVisibility } from '../viewer3d/unifiedLabelManager.js';
import { setState } from '../../data/state/globalState.js';
import { renderingController } from '../../app/controllers/renderingController.js';
import { REDRAW_REQUIRED_ELEMENT_TYPES } from '../../config/uiElementConfig.js';
import { eventBus, RenderEvents } from '../../data/events/index.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('ui:events:labelVisibilityListeners');

/**
 * 要素タイプと再描画関数名のマッピング
 * @type {Object.<string, string>}
 */
const ELEMENT_REDRAW_FUNCTION_MAP = {
  Node: 'redrawNodesForViewMode',
  Column: 'redrawColumnsForViewMode',
  Post: 'redrawPostsForViewMode',
  Girder: 'redrawBeamsForViewMode',
  Beam: 'redrawBeamsForViewMode',
  Brace: 'redrawBracesForViewMode',
  IsolatingDevice: 'redrawIsolatingDevicesForViewMode',
  DampingDevice: 'redrawDampingDevicesForViewMode',
  FrameDampingDevice: 'redrawFrameDampingDevicesForViewMode',
  Pile: 'redrawPilesForViewMode',
  Footing: 'redrawFootingsForViewMode',
  FoundationColumn: 'redrawFoundationColumnsForViewMode',
};

/** @type {Array<{el: Element, handler: Function}>} */
let _labelListeners = [];
/** @type {{el: Element, handler: Function}|null} */
let _labelContentListener = null;

/**
 * Setup label toggle checkbox listeners to update label visibility
 */
export function setupLabelToggleListeners() {
  teardownLabelToggleListeners();
  const labelToggles = document.querySelectorAll('input[name="labelToggle"]');
  labelToggles.forEach((checkbox) => {
    const handler = () => {
      const elementType = checkbox.value;

      // labelDisplayManagerと同期
      renderingController.setLabelVisibility(elementType, checkbox.checked);

      // 立体表示モードの場合は再描画が必要
      const needsRedraw = checkIfRedrawNeeded(elementType);

      if (needsRedraw) {
        // 立体表示モードの再描画を実行
        triggerViewModeRedraw(elementType);
      } else {
        // 通常のラベル表示更新
        updateLabelVisibility();
        // Request render via EventBus
        eventBus.emit(RenderEvents.REQUEST_RENDER);
      }
    };
    checkbox.addEventListener('change', handler);
    _labelListeners.push({ el: checkbox, handler });
  });
}

/**
 * Teardown label toggle checkbox listeners
 */
export function teardownLabelToggleListeners() {
  for (const { el, handler } of _labelListeners) {
    el.removeEventListener('change', handler);
  }
  _labelListeners = [];
}

/**
 * Check if redraw is needed for solid view modes
 * 設定ファイルの REDRAW_REQUIRED_ELEMENT_TYPES を使用
 * @param {string} elementType - Element type
 * @returns {boolean} Whether redraw is needed
 */
function checkIfRedrawNeeded(elementType) {
  return REDRAW_REQUIRED_ELEMENT_TYPES.has(elementType);
}

/**
 * Trigger view mode redraw for specific element types
 * @param {string} elementType - Element type
 */
function triggerViewModeRedraw(elementType) {
  const functionName = ELEMENT_REDRAW_FUNCTION_MAP[elementType];
  if (!functionName) {
    // 未サポートの要素タイプは通常のラベル更新
    updateLabelVisibility();
    eventBus.emit(RenderEvents.REQUEST_RENDER);
    return;
  }

  // Import redraw functions dynamically to avoid circular dependencies
  import('../../app/viewModes/index.js')
    .then((viewModes) => {
      const scheduleRender = () => eventBus.emit(RenderEvents.REQUEST_RENDER);
      const redrawFn = viewModes[functionName];
      if (redrawFn) {
        redrawFn(scheduleRender);
      }
    })
    .catch((error) => {
      log.error('Failed to import view mode functions:', error);
      // Fallback to normal label update
      updateLabelVisibility();
      eventBus.emit(RenderEvents.REQUEST_RENDER);
    });
}

/**
 * Setup label content selector listener
 */
export function setupLabelContentListener() {
  teardownLabelContentListener();
  const labelContentSelector = document.getElementById('labelContentSelector');

  if (labelContentSelector) {
    labelContentSelector.addEventListener('change', handleLabelContentChange);
    _labelContentListener = { el: labelContentSelector, handler: handleLabelContentChange };
  } else {
    log.warn('[UI] ラベル: コンテンツセレクタが見つかりません');
  }
}

/**
 * Teardown label content selector listener
 */
export function teardownLabelContentListener() {
  if (!_labelContentListener) return;
  const { el, handler } = _labelContentListener;
  el.removeEventListener('change', handler);
  _labelContentListener = null;
}

/**
 * Handle label content type change
 * @param {Event} event - Change event
 */
function handleLabelContentChange(event) {
  const newContentType = event.target.value;
  log.info(`[Event] ラベル内容変更: ${newContentType}`);

  // Update global state
  setState('ui.labelContentType', newContentType);

  // Trigger label regeneration
  regenerateAllLabels();

  // Request render update via EventBus
  eventBus.emit(RenderEvents.REQUEST_RENDER);
}
