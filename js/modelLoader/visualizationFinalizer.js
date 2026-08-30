/**
 * @fileoverview 可視化最終処理モジュール
 *
 * このモジュールはモデル可視化の最終ステップを処理します：
 * - UI更新と状態同期
 * - カメラポジショニングとビューフィッティング
 * - グリッドヘルパー作成
 * - モデル可視性管理
 * - グローバル状態更新
 *
 * 保守性向上のため、巨大なcompareModels()関数から抽出されました。
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('modelLoader:finalizer');

import { getLoaderInitViewModes, getLoaderUpdateModelVisibility } from './loaderDependencies.js';
import { createOrUpdateGridHelper, setView, VIEW_DIRECTIONS } from '../viewer/index.js';
import { eventBus } from '../data/events/eventBus.js';
import { ModelEvents, AxisEvents, FinalizationEvents } from '../constants/eventTypes.js';

/**
 * Finalize visualization after rendering completion
 * @param {Object} finalizationData - Data needed for finalization
 * @param {Function} scheduleRender - Render scheduling function
 * @param {Object} cameraControls - Camera and controls objects
 * @returns {Promise<Object>} Finalization result
 */
export async function finalizeVisualization(finalizationData, scheduleRender, _cameraControls) {
  const {
    nodeLabels,
    stories,
    axesData,
    modelBounds,
    renderingStats,
    modelADocument,
    modelBDocument,
  } = finalizationData;

  // Update global UI state via events (avoids L3->L5 layer violation)
  eventBus.emit(FinalizationEvents.SET_GLOBAL_STATE, { nodeLabels, stories, axesData });
  eventBus.emit(FinalizationEvents.UPDATE_SELECTORS);

  // Initialize view modes
  const initViewModes = getLoaderInitViewModes();
  const updateModelVisibility = getLoaderUpdateModelVisibility();
  const initViewModesResult = await Promise.resolve(
    initViewModes(finalizationData, scheduleRender),
  );

  // Setup camera and grid
  createOrUpdateGridHelper(modelBounds);
  setView(VIEW_DIRECTIONS.ISOMETRIC, modelBounds, false);
  eventBus.emit(ModelEvents.BOUNDS_UPDATED, { modelBounds });

  // 通り芯を最終的なmodelBoundsで再描画
  eventBus.emit(AxisEvents.REDRAW_REQUESTED, {
    axesData,
    stories,
    modelBounds,
    labelToggle: true,
    targetStoryId: 'all',
  });
  logger.info('Axes redrawn with final model bounds');

  updateModelVisibility(scheduleRender);

  // 3D配筋などのオーバーレイ表示の作り直しは購読側（app層）へ委ねる
  eventBus.emit(FinalizationEvents.COMPLETED, {
    hasBothModels: !!modelADocument && !!modelBDocument,
  });

  if (initViewModesResult?.errors?.length > 0) {
    logger.warn('Initial display mode redraw completed with errors:', initViewModesResult.errors);
  }

  return {
    stats: renderingStats,
    initViewModesResult,
  };
}

/**
 * Handle finalization errors and cleanup
 * @param {Error} error - Error that occurred
 */
export function handleFinalizationError(error) {
  logger.error('Finalization error occurred:', error);

  try {
    eventBus.emit(FinalizationEvents.SET_GLOBAL_STATE, {
      nodeLabels: [],
      stories: [],
      axesData: { xAxes: [], yAxes: [] },
    });
    eventBus.emit(FinalizationEvents.UPDATE_SELECTORS);
  } catch (cleanupError) {
    logger.error('Error during cleanup:', cleanupError);
  }
}

/**
 * Create finalization summary
 * @param {Object} modelData - Complete model data
 * @param {Object} renderingStats - Rendering statistics
 * @returns {Object} Summary object
 */
export function createFinalizationSummary(modelData, renderingStats) {
  const { modelADocument, modelBDocument, nodeMapA, nodeMapB, stories, axesData, nodeLabels } =
    modelData;
  const { totalMeshes, totalLabels, errors, elementTypes } = renderingStats;

  return {
    models: {
      hasModelA: !!modelADocument,
      hasModelB: !!modelBDocument,
      nodesA: nodeMapA.size,
      nodesB: nodeMapB.size,
    },
    structure: {
      stories: stories.length,
      xAxes: axesData.xAxes.length,
      yAxes: axesData.yAxes.length,
      labels: nodeLabels.length,
    },
    rendering: {
      totalMeshes,
      totalLabels,
      errors,
      elementTypes: Object.keys(elementTypes).length,
    },
    timestamp: new Date().toISOString(),
  };
}
