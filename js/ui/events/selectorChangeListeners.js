/**
 * @fileoverview セレクター変更イベントリスナー
 *
 * 階・軸セレクターの変更を処理するイベントリスナー。
 *
 * @module ui/events/selectorChangeListeners
 */

import { updateLabelVisibility } from '../viewer3d/unifiedLabelManager.js';
import {
  getStoryClipBounds,
  getAxisClipBounds,
  DEFAULT_STORY_CLIP_RANGE,
  DEFAULT_AXIS_CLIP_RANGE,
} from '../viewer3d/clipping.js';
import { activateSectionBoxForBounds, deactivateSectionBox } from '../viewer3d/sectionBox.js';
import { eventBus, AxisEvents, RenderEvents } from '../../data/events/index.js';
import { getState } from '../../data/state/globalState.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('ui:events:selectorChangeListeners');

/**
 * Setup selector change listeners
 */
export function setupSelectorChangeListeners() {
  const storySelector = document.getElementById('storySelector');
  const xAxisSelector = document.getElementById('xAxisSelector');
  const yAxisSelector = document.getElementById('yAxisSelector');
  const dimToggle = document.getElementById('showAxisDimensions');

  if (storySelector) {
    storySelector.addEventListener('change', handleStorySelectionChange);
  }

  if (xAxisSelector) {
    xAxisSelector.addEventListener('change', handleXAxisSelectionChange);
  }

  if (yAxisSelector) {
    yAxisSelector.addEventListener('change', handleYAxisSelectionChange);
  }

  if (dimToggle) {
    dimToggle.addEventListener('change', handleDimensionToggleChange);
  }
}

/**
 * Teardown selector change listeners
 */
export function teardownSelectorChangeListeners() {
  const storySelector = document.getElementById('storySelector');
  const xAxisSelector = document.getElementById('xAxisSelector');
  const yAxisSelector = document.getElementById('yAxisSelector');
  const dimToggle = document.getElementById('showAxisDimensions');

  storySelector?.removeEventListener('change', handleStorySelectionChange);
  xAxisSelector?.removeEventListener('change', handleXAxisSelectionChange);
  yAxisSelector?.removeEventListener('change', handleYAxisSelectionChange);
  dimToggle?.removeEventListener('change', handleDimensionToggleChange);
}

/**
 * Handle story selection change
 * @param {Event} event - Change event
 */
function handleStorySelectionChange(event) {
  const selectedStoryId = event.target.value;
  const storyRange = parseInt(
    document.getElementById('storyClipRange')?.value || DEFAULT_STORY_CLIP_RANGE,
    10,
  );

  if (selectedStoryId !== 'all') {
    const bounds = getStoryClipBounds(selectedStoryId, storyRange);
    if (bounds) {
      activateSectionBoxForBounds(bounds);
      updateClipControlsVisibility('story');
    }
  } else {
    deactivateSectionBox();
    updateClipControlsVisibility(null);
  }

  // Redraw axes at the selected story level
  redrawAxesAtStory(selectedStoryId);

  // Update label visibility
  updateLabelVisibility();

  // Request render update via EventBus
  eventBus.emit(RenderEvents.REQUEST_RENDER);
}

/**
 * Redraw axes at the specified story level
 * EventBusを使用してViewer層に描画をリクエストします。
 * @param {string} targetStoryId - Target story ID ('all' for lowest story)
 */
export function redrawAxesAtStory(targetStoryId) {
  try {
    const stories = getState('models.stories') || [];
    const axesData = getState('models.axesData') || { xAxes: [], yAxes: [] };
    const modelBounds = getState('models.modelBounds') || null;

    if (!axesData || (!axesData.xAxes?.length && !axesData.yAxes?.length)) {
      return;
    }

    // Get label toggle state from the checkbox
    const labelCheckbox = document.getElementById('toggleLabel-Axis');
    const labelToggle = labelCheckbox ? labelCheckbox.checked : true;

    const dimensionCheckbox = document.getElementById('showAxisDimensions');
    const showDimensions = dimensionCheckbox ? dimensionCheckbox.checked : false;

    // EventBusを通じてViewer層に軸再描画をリクエスト
    eventBus.emit(AxisEvents.REDRAW_REQUESTED, {
      axesData,
      stories,
      modelBounds,
      labelToggle,
      showDimensions,
      targetStoryId,
    });
  } catch (error) {
    log.error('Error redrawing axes at story:', error);
  }
}

/**
 * Handle X-axis selection change
 * @param {Event} event - Change event
 */
function handleAxisSelectionChange(event, axisType, rangeElementId, controlsType) {
  const selectedAxisId = event.target.value;
  const axisRange = parseInt(
    document.getElementById(rangeElementId)?.value || DEFAULT_AXIS_CLIP_RANGE,
    10,
  );

  if (selectedAxisId !== 'all') {
    const bounds = getAxisClipBounds(axisType, selectedAxisId, axisRange);
    if (bounds) {
      activateSectionBoxForBounds(bounds);
      updateClipControlsVisibility(controlsType);
    }
  } else {
    deactivateSectionBox();
    updateClipControlsVisibility(null);
  }

  // Update label visibility
  updateLabelVisibility();

  // Request render update via EventBus
  eventBus.emit(RenderEvents.REQUEST_RENDER);
}

/**
 * Handle X-axis selection change
 * @param {Event} event - Change event
 */
function handleXAxisSelectionChange(event) {
  handleAxisSelectionChange(event, 'X', 'xAxisClipRange', 'xAxis');
}

/**
 * Handle Y-axis selection change
 * @param {Event} event - Change event
 */
function handleYAxisSelectionChange(event) {
  handleAxisSelectionChange(event, 'Y', 'yAxisClipRange', 'yAxis');
}

/**
 * Reset all selectors to default values
 */
export function resetAllSelectors() {
  const storySelector = document.getElementById('storySelector');
  const xAxisSelector = document.getElementById('xAxisSelector');
  const yAxisSelector = document.getElementById('yAxisSelector');

  if (storySelector) storySelector.value = 'all';
  if (xAxisSelector) xAxisSelector.value = 'all';
  if (yAxisSelector) yAxisSelector.value = 'all';

  // Clear clipping planes
  if (typeof window.clearClippingPlanes === 'function') {
    window.clearClippingPlanes();
  }

  // Update label visibility
  updateLabelVisibility();

  // Request render update via EventBus
  eventBus.emit(RenderEvents.REQUEST_RENDER);

  log.info('[Event] 全セレクタをリセット');
}

/**
 * Handle dimension toggle change
 */
function handleDimensionToggleChange() {
  const storySelector = document.getElementById('storySelector');
  const targetStoryId = storySelector ? storySelector.value : 'all';
  redrawAxesAtStory(targetStoryId);
  eventBus.emit(RenderEvents.REQUEST_RENDER);
}

/**
 * Get selector status
 * @returns {Object} Selector element status
 */
export function getSelectorStatus() {
  return {
    storySelector: !!document.getElementById('storySelector'),
    xAxisSelector: !!document.getElementById('xAxisSelector'),
    yAxisSelector: !!document.getElementById('yAxisSelector'),
  };
}

/**
 * どのクリッピング範囲UIを表示するか更新
 * @param {'story'|'xAxis'|'yAxis'|null} type
 */
function updateClipControlsVisibility(type) {
  const controlIds = ['storyClipControls', 'xAxisClipControls', 'yAxisClipControls'];
  controlIds.forEach((id) => {
    const element = document.getElementById(id);
    if (element) {
      element.classList.add('hidden');
    }
  });

  const groups = document.querySelectorAll('.clipping-group');
  groups.forEach((group) => {
    group.classList.remove('active', 'clipping-active');
  });

  if (!type) {
    return;
  }

  const controlElement = document.getElementById(`${type}ClipControls`);
  if (controlElement) {
    controlElement.classList.remove('hidden');
    const groupElement = controlElement.closest('.clipping-group');
    if (groupElement) {
      groupElement.classList.add('active', 'clipping-active');
    }
  }
}
