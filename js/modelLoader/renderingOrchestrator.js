/**
 * @fileoverview レンダリング統制モジュール
 *
 * このモジュールはモデル比較の3Dレンダリング統制を処理します：
 * - 要素レンダリング調整
 * - ラベル作成と管理
 * - 材料割り当て
 * - 境界計算とカメラフィッティング
 *
 * 保守性向上のため、巨大なcompareModels()関数から抽出されました。
 *
 * Adapter層統合:
 * - convertToDiffRenderModel()を使用して比較結果をDiffRenderModelに変換
 * - DiffRenderModelの統計情報をログ出力に活用
 */

import * as THREE from 'three';
import { createLogger } from '../utils/logger.js';
import {
  elementGroups,
  drawNodes,
  drawLineElements,
  drawAxes,
  drawStories,
  getActiveCamera,
  displayModeManager,
  labelDisplayManager,
  getElementRegistry,
} from '../viewer/index.js';
import { convertToDiffRenderModel, getDiffStatistics } from '../data/converters/index.js';

const log = createLogger('modelLoader/renderingOrchestrator');

/**
 * Orchestrate rendering of all compared elements
 * @param {Map} comparisonResults - Results from element comparison
 * @param {THREE.Box3} modelBounds - Model bounds for rendering
 * @param {Object} globalData - Global data (stories, axes, etc.)
 * @returns {Object} Rendering result
 */
export function orchestrateElementRendering(comparisonResults, modelBounds, globalData) {
  // Adapter層: 比較結果をDiffRenderModelに変換
  // 現時点では統計情報の取得に利用、将来的には描画関数に直接渡す
  const diffRenderModel = convertToDiffRenderModel(comparisonResults, {
    nodeMapA: globalData.nodeMapA,
    nodeMapB: globalData.nodeMapB,
  });

  // DiffRenderModelの統計情報をログ出力
  getDiffStatistics(diffRenderModel);

  const renderingResults = {
    nodeLabels: [],
    renderedElements: new Map(),
    errors: [],
    diffRenderModel, // DiffRenderModelを結果に含める（将来の参照用）
  };

  // Process each element type for rendering
  // 現時点ではcomparisonResultsを直接使用（段階的移行）
  for (const [elementType, comparisonResult] of comparisonResults.entries()) {
    try {
      const elementRenderResult = renderElementType(
        elementType,
        comparisonResult,
        modelBounds,
        globalData,
      );

      renderingResults.renderedElements.set(elementType, elementRenderResult);

      // Collect node labels
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

  // Render auxiliary elements (axes and stories)
  try {
    renderAuxiliaryElements(globalData, renderingResults, modelBounds);
  } catch (error) {
    log.error('Error rendering auxiliary elements:', error);
    renderingResults.errors.push({
      elementType: 'auxiliary',
      error: error.message,
    });
  }

  // ElementRegistryに全要素を登録（高速検索用）
  registerElementsToRegistry();

  return renderingResults;
}

/**
 * 全要素グループの要素をElementRegistryに登録
 * これにより、要素検索がO(n)からO(1)に高速化される
 */
export function registerElementsToRegistry() {
  const registry = getElementRegistry();

  // 既存の登録をクリア
  registry.clear();

  // 全要素グループを走査して登録
  for (const group of Object.values(elementGroups)) {
    if (!group || !group.children) continue;

    group.traverse((child) => {
      if (child.userData && child.userData.elementType) {
        registry.register(child);
      }
    });
  }

  registry.getStats();
}

/**
 * Render a specific element type
 * @param {string} elementType - Type of element to render
 * @param {Object} comparisonResult - Comparison result for this element type
 * @param {THREE.Box3} modelBounds - Model bounds
 * @param {Object} globalData - Global data
 * @returns {Object} Rendering result for this element type
 */
function renderElementType(elementType, comparisonResult, modelBounds, _globalData) {
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

  // Set group visibility based on selection
  group.visible = comparisonResult.isSelected;

  const result = {
    meshCount: 0,
    labels: [],
    groupVisible: group.visible,
  };

  // Skip rendering if error occurred during comparison
  if (comparisonResult.error) {
    log.warn(`[Render] ${elementType}: 比較エラーのためスキップ`);
    return result;
  }

  // 初回ロード時はラベル表示設定を尊重し、非表示ラベルの生成を避ける。
  labelDisplayManager.syncWithCheckbox(elementType);
  const createLabels = labelDisplayManager.isLabelVisible(elementType);

  // Render based on element type
  switch (elementType) {
    case 'Node':
      result.labels = drawNodes(comparisonResult, group, createLabels, modelBounds);
      break;

    case 'Column':
    case 'Post':
    case 'Girder':
    case 'Beam':
    case 'Brace':
    case 'Parapet':
    case 'Pile':
    case 'Footing':
    case 'FoundationColumn':
    case 'StripFooting':
    case 'IsolatingDevice':
    case 'DampingDevice':
      // solidモードの場合は線分描画をスキップ（applyInitialDisplayModesで立体描画される）
      if (displayModeManager.isSolidMode(elementType)) break;
      result.labels = drawLineElements(
        comparisonResult,
        group,
        elementType,
        createLabels,
        modelBounds,
      );
      break;

    case 'Slab':
    case 'Wall':
    case 'FrameDampingDevice':
    case 'Joint':
    case 'Undefined':
      // applyInitialDisplayModesで適切なモードで描画される
      break;

    default:
      log.warn(`[Render] 不明な要素タイプ: ${elementType}`);
  }

  // Count meshes in group
  result.meshCount = countMeshesInGroup(group);

  return result;
}

/**
 * Render auxiliary elements (axes and stories)
 * @param {Object} globalData - Global data containing stories and axes
 * @param {Object} renderingResults - Rendering results to update
 * @param {THREE.Box3} modelBounds - Model bounds for rendering
 */
export function renderAuxiliaryElements(globalData, renderingResults, modelBounds) {
  const { stories, axesData } = globalData;

  // Render axes
  if (axesData && (axesData.xAxes.length > 0 || axesData.yAxes.length > 0)) {
    try {
      const dimCheckbox =
        typeof document !== 'undefined' ? document.getElementById('showAxisDimensions') : null;
      const axisLabels = drawAxes(
        axesData,
        stories,
        elementGroups['Axis'],
        modelBounds,
        true,
        getActiveCamera(),
        { showDimensions: dimCheckbox ? dimCheckbox.checked : false },
      );
      renderingResults.nodeLabels.push(...axisLabels);
    } catch (error) {
      log.error('Error rendering axes:', error);
    }
  }

  // Render stories
  if (stories && stories.length > 0) {
    try {
      const storyLabels = drawStories(stories, elementGroups['Story'], modelBounds, true);
      renderingResults.nodeLabels.push(...storyLabels);
    } catch (error) {
      log.error('Error rendering stories:', error);
    }
  }
}

/**
 * Count meshes in a Three.js group
 * @param {THREE.Group} group - Group to count meshes in
 * @returns {number} Number of meshes
 */
function countMeshesInGroup(group) {
  let count = 0;

  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      count++;
    }
  });

  return count;
}

/**
 * Calculate and update model bounds based on rendered elements
 * @param {Map} renderedElements - Map of rendered elements
 * @param {Map} nodeMapA - Node map for model A
 * @param {Map} nodeMapB - Node map for model B
 * @returns {THREE.Box3} Updated model bounds
 */
export function calculateRenderingBounds(renderedElements, nodeMapA, nodeMapB) {
  const bounds = new THREE.Box3();

  // Add all node positions
  for (const node of nodeMapA.values()) {
    bounds.expandByPoint(new THREE.Vector3(node.x, node.y, node.z));
  }

  for (const node of nodeMapB.values()) {
    bounds.expandByPoint(new THREE.Vector3(node.x, node.y, node.z));
  }

  // Add bounds from rendered geometry
  // Story, Axis はレイアウト要素であり、modelBounds を拡大してはいけない
  // これらを含めると境界が連鎖的に拡大し、通り芯とレベル面がずれる原因となる
  const excludeFromBounds = ['Story', 'Axis'];
  for (const [elementType, group] of Object.entries(elementGroups)) {
    if (excludeFromBounds.includes(elementType)) {
      continue; // レイアウト要素はスキップ
    }
    if (group && group.children.length > 0) {
      const groupBox = new THREE.Box3().setFromObject(group);
      if (!groupBox.isEmpty()) {
        bounds.union(groupBox);
      }
    }
  }

  // Ensure bounds are not empty
  if (bounds.isEmpty()) {
    bounds.expandByPoint(new THREE.Vector3(-1000, -1000, -1000));
    bounds.expandByPoint(new THREE.Vector3(1000, 1000, 1000));
    log.warn('[Render] 境界: 空のため初期値を使用');
  }

  return bounds;
}

/**
 * Get rendering statistics
 * @param {Object} renderingResults - Results from rendering
 * @returns {Object} Rendering statistics
 */
export function getRenderingStatistics(renderingResults) {
  const stats = {
    totalMeshes: 0,
    totalLabels: renderingResults.nodeLabels.length,
    elementTypes: {},
    errors: renderingResults.errors.length,
    errorDetails: renderingResults.errors,
  };

  for (const [elementType, result] of renderingResults.renderedElements.entries()) {
    stats.elementTypes[elementType] = {
      meshCount: result.meshCount,
      labelCount: result.labels.length,
      isVisible: result.groupVisible,
      hasError: !!result.error,
    };

    stats.totalMeshes += result.meshCount;
  }

  return stats;
}
