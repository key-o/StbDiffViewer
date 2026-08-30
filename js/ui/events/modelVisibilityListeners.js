/**
 * @fileoverview モデル可視性切り替えイベントリスナー
 *
 * モデルA/Bの表示切り替えを処理するイベントリスナー。
 *
 * @module ui/events/modelVisibilityListeners
 */

import { scheduleRender } from '../../utils/renderScheduler.js';
import { setModelVisibility } from '../../app/viewModes/index.js';

function createModelToggleDefinition(model) {
  return {
    model,
    checkbox: document.getElementById(`toggleModel${model}`),
    handleChange(event) {
      setModelVisibility(model, event.target.checked, scheduleRender);
    },
  };
}

const modelToggleDefinitions = [createModelToggleDefinition('A'), createModelToggleDefinition('B')];

function getModelToggleDefinition(model) {
  return modelToggleDefinitions.find((definition) => definition.model === model);
}

/**
 * Setup model visibility toggle listeners
 */
export function setupModelVisibilityListeners() {
  modelToggleDefinitions.forEach(({ checkbox, handleChange }) => {
    checkbox?.addEventListener('change', handleChange);
  });
}

/**
 * Teardown model visibility toggle listeners
 */
export function teardownModelVisibilityListeners() {
  modelToggleDefinitions.forEach(({ checkbox, handleChange }) => {
    checkbox?.removeEventListener('change', handleChange);
  });
}

function toggleModelVisibility(model) {
  const checkbox = getModelToggleDefinition(model)?.checkbox;
  if (checkbox) {
    checkbox.checked = !checkbox.checked;
    checkbox.dispatchEvent(new Event('change'));
  }
}

/**
 * Toggle Model A visibility programmatically
 */
export function toggleModelAVisibility() {
  toggleModelVisibility('A');
}

/**
 * Toggle Model B visibility programmatically
 */
export function toggleModelBVisibility() {
  toggleModelVisibility('B');
}

/**
 * Get model visibility checkbox status
 * @returns {{ modelA: boolean, modelB: boolean }} Visibility status
 */
export function getModelVisibilityStatus() {
  const modelA = getModelToggleDefinition('A');
  const modelB = getModelToggleDefinition('B');
  return {
    modelA: !!modelA?.checkbox,
    modelB: !!modelB?.checkbox,
  };
}
