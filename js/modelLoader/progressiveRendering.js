/**
 * @fileoverview 谿ｵ髫守噪繝ｬ繝ｳ繝繝ｪ繝ｳ繧ｰ邨ｱ蜷医Δ繧ｸ繝･繝ｼ繝ｫ
 *
 * 縺薙・繝｢繧ｸ繝･繝ｼ繝ｫ縺ｯ譌｢蟄倥・繝ｬ繝ｳ繝繝ｪ繝ｳ繧ｰ繧ｷ繧ｹ繝・Β縺ｨ谿ｵ髫守噪繝ｭ繝ｼ繝・ぅ繝ｳ繧ｰ繧堤ｵｱ蜷医＠縲・
 * 繝代ヵ繧ｩ繝ｼ繝槭Φ繧ｹ繧貞髄荳翫＆縺帙∪縺吶・
 *
 * Adapter螻､邨ｱ蜷・
 * - convertToDiffRenderModel()繧剃ｽｿ逕ｨ縺励※豈碑ｼ・ｵ先棡繧奪iffRenderModel縺ｫ螟画鋤
 * - DiffRenderModel縺ｮ邨ｱ險域ュ蝣ｱ繧偵Ο繧ｰ蜃ｺ蜉帙↓豢ｻ逕ｨ
 */

import * as THREE from 'three';
import { createLogger } from '../utils/logger.js';
import { ELEMENT_PRIORITY } from '../constants/elementPriority.js';
import { eventBus } from '../data/events/eventBus.js';
import { LoadingIndicatorEvents } from '../constants/eventTypes.js';
import {
  elementGroups,
  drawNodes,
  drawNodesBatched,
  drawLineElements,
  drawPolyElements,
  drawLineElementsBatched,
  shouldUseBatchRendering,
  displayModeManager,
  labelDisplayManager,
} from '../viewer/index.js';
import { convertToDiffRenderModel, getDiffStatistics } from '../data/converters/index.js';
import { renderAuxiliaryElements } from './renderingOrchestrator.js';

const log = createLogger('modelLoader/progressiveRendering');

/**
 * 谿ｵ髫守噪繝ｬ繝ｳ繝繝ｪ繝ｳ繧ｰ繧呈怏蜉ｹ縺ｫ縺吶ｋ縺九←縺・°縺ｮ繝輔Λ繧ｰ
 * 繝代ヵ繧ｩ繝ｼ繝槭Φ繧ｹ繝・せ繝医ｄ蝠城｡檎匱逕滓凾縺ｫ蛻・ｊ譖ｿ縺亥庄閭ｽ
 */
const progressiveRenderingEnabled = true;

/**
 * 繝舌ャ繝√Ξ繝ｳ繝繝ｪ繝ｳ繧ｰ繧呈怏蜉ｹ縺ｫ縺吶ｋ縺九←縺・°縺ｮ繝輔Λ繧ｰ
 */
const batchRenderingEnabled = true;

/**
 * 谿ｵ髫守噪繝ｬ繝ｳ繝繝ｪ繝ｳ繧ｰ縺梧怏蜉ｹ縺九←縺・°繧貞叙蠕・
 * @returns {boolean}
 */
export function isProgressiveRenderingEnabled() {
  return progressiveRenderingEnabled;
}

/**
 * 谿ｵ髫守噪縺ｫ繝ｬ繝ｳ繝繝ｪ繝ｳ繧ｰ繧貞ｮ溯｡・
 *
 * @param {Map} comparisonResults - 豈碑ｼ・ｵ先棡
 * @param {THREE.Box3} modelBounds - 繝｢繝・Ν蠅・阜
 * @param {Object} globalData - 繧ｰ繝ｭ繝ｼ繝舌Ν繝・・繧ｿ・・tories, axesData, nodeMapA, nodeMapB・・
 * @param {function} scheduleRender - 蜀肴緒逕ｻ髢｢謨ｰ
 * @returns {Promise<Object>} 繝ｬ繝ｳ繝繝ｪ繝ｳ繧ｰ邨先棡
 */
export async function orchestrateProgressiveRendering(
  comparisonResults,
  modelBounds,
  globalData,
  scheduleRender,
) {
  // 谿ｵ髫守噪繝ｬ繝ｳ繝繝ｪ繝ｳ繧ｰ縺檎┌蜉ｹ縺ｪ蝣ｴ蜷医・蠕捺擂縺ｮ譁ｹ豕輔ｒ菴ｿ逕ｨ
  if (!progressiveRenderingEnabled) {
    return orchestrateSynchronousRendering(comparisonResults, modelBounds, globalData);
  }

  // Adapter螻､: 豈碑ｼ・ｵ先棡繧奪iffRenderModel縺ｫ螟画鋤
  // 迴ｾ譎らせ縺ｧ縺ｯ邨ｱ險域ュ蝣ｱ縺ｮ蜿門ｾ励↓蛻ｩ逕ｨ縲∝ｰ・擂逧・↓縺ｯ謠冗判髢｢謨ｰ縺ｫ逶ｴ謗･貂｡縺・
  const diffRenderModel = convertToDiffRenderModel(comparisonResults, {
    nodeMapA: globalData.nodeMapA,
    nodeMapB: globalData.nodeMapB,
  });

  // DiffRenderModel縺ｮ邨ｱ險域ュ蝣ｱ繧偵Ο繧ｰ蜃ｺ蜉・
  getDiffStatistics(diffRenderModel);

  eventBus.emit(LoadingIndicatorEvents.SHOW, { message: '3Dモデルを描画中...' });

  const renderingResults = {
    nodeLabels: [],
    renderedElements: new Map(),
    errors: [],
    diffRenderModel, // DiffRenderModel繧堤ｵ先棡縺ｫ蜷ｫ繧√ｋ・亥ｰ・擂縺ｮ蜿ら・逕ｨ・・
  };

  // 隕∫ｴ繧ｿ繧､繝励ｒ蜆ｪ蜈亥ｺｦ鬆・↓繧ｽ繝ｼ繝・
  const sortedElementTypes = Array.from(comparisonResults.keys()).sort((a, b) => {
    const priorityA = ELEMENT_PRIORITY[`Stb${a}`] || ELEMENT_PRIORITY[a] || 99;
    const priorityB = ELEMENT_PRIORITY[`Stb${b}`] || ELEMENT_PRIORITY[b] || 99;
    return priorityA - priorityB;
  });

  // 邱剰ｦ∫ｴ謨ｰ繧定ｨ育ｮ・
  let totalElements = 0;
  let processedElements = 0;
  for (const result of comparisonResults.values()) {
    totalElements +=
      (result.matched?.length || 0) + (result.onlyA?.length || 0) + (result.onlyB?.length || 0);
  }

  // 繝輔ぉ繝ｼ繧ｺ縺斐→縺ｫ蜃ｦ逅・
  for (const elementType of sortedElementTypes) {
    const comparisonResult = comparisonResults.get(elementType);
    if (!comparisonResult) continue;

    // 騾ｲ謐玲峩譁ｰ
    const elementCount =
      (comparisonResult.matched?.length || 0) +
      (comparisonResult.onlyA?.length || 0) +
      (comparisonResult.onlyB?.length || 0);

    eventBus.emit(LoadingIndicatorEvents.UPDATE, {
      progress: Math.round((processedElements / totalElements) * 100),
      message: `描画中: ${elementType}`,
      detail: `${processedElements}/${totalElements} 要素`,
    });

    try {
      const elementRenderResult = await renderElementTypeAsync(
        elementType,
        comparisonResult,
        modelBounds,
        globalData,
      );

      renderingResults.renderedElements.set(elementType, elementRenderResult);

      if (elementRenderResult.labels) {
        renderingResults.nodeLabels.push(...elementRenderResult.labels);
      }

      // 繝輔ぉ繝ｼ繧ｺ螳御ｺ・ｾ後↓謠冗判譖ｴ譁ｰ
      if (scheduleRender) {
        scheduleRender();
      }
    } catch (error) {
      log.error(`Error rendering ${elementType}:`, error);
      renderingResults.errors.push({
        elementType,
        error: error.message,
      });
    }

    processedElements += elementCount;

    // UI繧ｹ繝ｬ繝・ラ縺ｫ蛻ｶ蠕｡繧呈綾縺・
    await yieldToMain();
  }

  // 陬懷勧隕∫ｴ・磯壹ｊ闃ｯ繝ｻ髫趣ｼ峨ｒ謠冗判
  try {
    await renderAuxiliaryElementsAsync(globalData, renderingResults, modelBounds);
    if (scheduleRender) {
      scheduleRender();
    }
  } catch (error) {
    log.error('Error rendering auxiliary elements:', error);
    renderingResults.errors.push({
      elementType: 'auxiliary',
      error: error.message,
    });
    eventBus.emit(LoadingIndicatorEvents.UPDATE, {
      progress: 95,
      message: '描画エラー',
      detail: error.message,
    });
  }

  return renderingResults;
}

/**
 * 蜷梧悄逧・↑繝ｬ繝ｳ繝繝ｪ繝ｳ繧ｰ・亥ｾ捺擂譁ｹ蠑擾ｼ・
 *
 * @param {Map} comparisonResults - 豈碑ｼ・ｵ先棡
 * @param {THREE.Box3} modelBounds - 繝｢繝・Ν蠅・阜
 * @param {Object} globalData - 繧ｰ繝ｭ繝ｼ繝舌Ν繝・・繧ｿ
 * @returns {Object} 繝ｬ繝ｳ繝繝ｪ繝ｳ繧ｰ邨先棡
 */
function orchestrateSynchronousRendering(comparisonResults, modelBounds, globalData) {
  const renderingResults = {
    nodeLabels: [],
    renderedElements: new Map(),
    errors: [],
  };

  for (const [elementType, comparisonResult] of comparisonResults.entries()) {
    try {
      const elementRenderResult = renderElementTypeSync(
        elementType,
        comparisonResult,
        modelBounds,
        globalData,
      );

      renderingResults.renderedElements.set(elementType, elementRenderResult);

      if (elementRenderResult.labels) {
        renderingResults.nodeLabels.push(...elementRenderResult.labels);
      }
    } catch (error) {
      log.error(`Error rendering ${elementType}:`, error);
      renderingResults.errors.push({
        elementType,
        error: error.message,
      });
    }
  }

  // 陬懷勧隕∫ｴ繧呈緒逕ｻ
  renderAuxiliaryElements(globalData, renderingResults, modelBounds);

  return renderingResults;
}

/**
 * 隕∫ｴ繧ｿ繧､繝励ｒ髱槫酔譛溘〒繝ｬ繝ｳ繝繝ｪ繝ｳ繧ｰ
 *
 * @param {string} elementType - 隕∫ｴ繧ｿ繧､繝・
 * @param {Object} comparisonResult - 豈碑ｼ・ｵ先棡
 * @param {THREE.Box3} modelBounds - 繝｢繝・Ν蠅・阜
 * @param {Object} globalData - 繧ｰ繝ｭ繝ｼ繝舌Ν繝・・繧ｿ
 * @returns {Promise<Object>} 繝ｬ繝ｳ繝繝ｪ繝ｳ繧ｰ邨先棡
 */
async function renderElementTypeAsync(elementType, comparisonResult, modelBounds, _globalData) {
  // 蝓ｺ譛ｬ逧・↓縺ｯ蜷梧悄蜃ｦ逅・→蜷後§縺縺後∝､ｧ驥剰ｦ∫ｴ縺ｮ蝣ｴ蜷医・繝舌ャ繝∝・逅・
  return renderElementTypeSync(elementType, comparisonResult, modelBounds, _globalData);
}

/**
 * 隕∫ｴ繧ｿ繧､繝励ｒ蜷梧悄逧・↓繝ｬ繝ｳ繝繝ｪ繝ｳ繧ｰ
 *
 * @param {string} elementType - 隕∫ｴ繧ｿ繧､繝・
 * @param {Object} comparisonResult - 豈碑ｼ・ｵ先棡
 * @param {THREE.Box3} modelBounds - 繝｢繝・Ν蠅・阜
 * @param {Object} globalData - 繧ｰ繝ｭ繝ｼ繝舌Ν繝・・繧ｿ
 * @returns {Object} 繝ｬ繝ｳ繝繝ｪ繝ｳ繧ｰ邨先棡
 */
function renderElementTypeSync(elementType, comparisonResult, modelBounds, _globalData) {
  const group = elementGroups[elementType];
  if (!group) {
    if (comparisonResult?.isRenderable === false) {
      return {
        meshCount: 0,
        labels: [],
        groupVisible: false,
        skipped: true,
      };
    }
    throw new Error(`Element group not found for type: ${elementType}`);
  }

  group.visible = comparisonResult.isSelected;

  const result = {
    meshCount: 0,
    labels: [],
    groupVisible: group.visible,
  };

  if (comparisonResult.error) {
    log.warn(`[Render] ${elementType}: 豈碑ｼ・お繝ｩ繝ｼ縺ｮ縺溘ａ繧ｹ繧ｭ繝・・`);
    return result;
  }

  labelDisplayManager.syncWithCheckbox(elementType);
  const createLabels = labelDisplayManager.isLabelVisible(elementType);

  // 繝舌ャ繝∝・逅・ｒ菴ｿ逕ｨ縺吶ｋ縺九←縺・°繧貞愛螳・
  const useBatch = batchRenderingEnabled && shouldUseBatchRendering(comparisonResult);

  switch (elementType) {
    case 'Node':
      // 隕∫ｴ謨ｰ縺悟､壹＞蝣ｴ蜷医・繝舌ャ繝∝・逅・ｼ・nstancedMesh・峨ｒ菴ｿ逕ｨ
      if (useBatch) {
        // batched API縺ｯ莠呈鋤諤ｧ縺ｮ縺溘ａ隨ｬ2蠑墓焚縺ｫmaterials繧ｹ繝ｭ繝・ヨ繧呈戟縺､・育樟蝨ｨ譛ｪ菴ｿ逕ｨ・・
        result.labels = drawNodesBatched(comparisonResult, null, group, createLabels, modelBounds);
      } else {
        result.labels = drawNodes(comparisonResult, group, createLabels, modelBounds);
      }
      break;

    case 'Column':
    case 'Post':
    case 'Girder':
    case 'Beam':
    case 'Brace':
    case 'Pile':
    case 'Footing':
    case 'StripFooting':
    case 'FoundationColumn':
    case 'Joint':
    case 'Parapet':
    case 'IsolatingDevice':
    case 'DampingDevice':
      // solid繝｢繝ｼ繝峨・蝣ｴ蜷医・邱壼・謠冗判繧偵せ繧ｭ繝・・・・pplyInitialDisplayModes縺ｧ遶倶ｽ捺緒逕ｻ縺輔ｌ繧具ｼ・
      if (displayModeManager.isSolidMode(elementType)) break;
      // 隕∫ｴ謨ｰ縺悟､壹＞蝣ｴ蜷医・繝舌ャ繝∝・逅・ｒ菴ｿ逕ｨ
      if (useBatch) {
        result.labels = drawLineElementsBatched(
          comparisonResult,
          null,
          group,
          elementType,
          createLabels,
          modelBounds,
        );
      } else {
        result.labels = drawLineElements(
          comparisonResult,
          group,
          elementType,
          createLabels,
          modelBounds,
        );
      }
      break;

    case 'Slab':
    case 'Wall':
    case 'FrameDampingDevice':
      // solid繝｢繝ｼ繝峨・蝣ｴ蜷医・繧ｹ繧ｭ繝・・・・pplyInitialDisplayModes縺ｧ謠冗判縺輔ｌ繧具ｼ・
      if (displayModeManager.isSolidMode(elementType)) break;
      result.labels = drawPolyElements(comparisonResult, group, createLabels, modelBounds);
      break;

    case 'Undefined':
      // Undefined隕∫ｴ縺ｯapplyInitialDisplayModes縺ｧ謠冗判縺輔ｌ繧・
      result.labels = [];
      break;

    default:
      log.warn(`[Render] 荳肴・縺ｪ隕∫ｴ繧ｿ繧､繝・ ${elementType}`);
  }

  result.meshCount = countMeshesInGroup(group);

  return result;
}

/**
 * 陬懷勧隕∫ｴ繧帝撼蜷梧悄縺ｧ繝ｬ繝ｳ繝繝ｪ繝ｳ繧ｰ
 *
 * @param {Object} globalData - 繧ｰ繝ｭ繝ｼ繝舌Ν繝・・繧ｿ
 * @param {Object} renderingResults - 繝ｬ繝ｳ繝繝ｪ繝ｳ繧ｰ邨先棡
 * @param {THREE.Box3} modelBounds - 繝｢繝・Ν蠅・阜
 */
async function renderAuxiliaryElementsAsync(globalData, renderingResults, modelBounds) {
  renderAuxiliaryElements(globalData, renderingResults, modelBounds);
}

/**
 * 繧ｰ繝ｫ繝ｼ繝怜・縺ｮ繝｡繝・す繝･謨ｰ繧偵き繧ｦ繝ｳ繝・
 *
 * @param {THREE.Group} group
 * @returns {number}
 */
function countMeshesInGroup(group) {
  let count = 0;
  group.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
      count++;
    }
  });
  return count;
}

/**
 * 繝｡繧､繝ｳ繧ｹ繝ｬ繝・ラ縺ｫ蛻ｶ蠕｡繧定ｭｲ繧・
 *
 * @returns {Promise<void>}
 */
function yieldToMain() {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(resolve, { timeout: 16 });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * 隱ｭ縺ｿ霎ｼ縺ｿ髢句ｧ区凾縺ｮUI譖ｴ譁ｰ
 */
export function onLoadingStart() {
  eventBus.emit(LoadingIndicatorEvents.SHOW, { message: 'モデルを読み込み中...' });
}

/**
 * 隱ｭ縺ｿ霎ｼ縺ｿ螳御ｺ・凾縺ｮUI譖ｴ譁ｰ
 */
export function onLoadingComplete() {
  eventBus.emit(LoadingIndicatorEvents.COMPLETE, { message: '読み込み完了' });
}

/**
 * 隱ｭ縺ｿ霎ｼ縺ｿ繧ｨ繝ｩ繝ｼ譎ゅ・UI譖ｴ譁ｰ
 * @param {string} message
 */
export function onLoadingError(message) {
  eventBus.emit(LoadingIndicatorEvents.ERROR, { message });
}
