/**
 * @fileoverview クリッピング平面管理モジュール
 *
 * このモジュールは3Dクリッピング平面操作を管理します：
 * - 階ベースのクリッピング平面適用
 * - 軸ベースのクリッピング平面適用
 * - クリッピング平面のクリアとリセット
 * - クリッピング平面座標計算
 *
 * より良い整理のため、大きなui.jsモジュールから分割されました。
 */

import * as THREE from 'three';
import { createAxisRangeClippingPlanes, createBoxClippingPlanes } from '../../viewer/index.js';
import { getCurrentStories, getCurrentAxesData } from '../state.js';
import { sceneController } from '../../app/controllers/sceneController.js';
import { scheduleRender } from '../../utils/renderScheduler.js';
import { showWarning } from '../common/toast.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('clipping');

// デフォルトクリッピング範囲（mm） - 定義の一元化
export const DEFAULT_STORY_CLIP_RANGE = 1000; // 階クリッピング: デフォルト1m
export const DEFAULT_AXIS_CLIP_RANGE = 2000; // 軸クリッピング: デフォルト2m

// Current clipping state
let currentClippingState = {
  type: null, // 'story', 'xAxis', 'yAxis'
  id: null,
  range: null,
  bounds: null,
};

// Camera state for restoration
const previousCameraState = {
  position: null,
  target: null,
  saved: false,
};

/**
 * Save current camera state before applying clipping
 * Captures camera position and controls target for later restoration.
 */
async function saveCameraState() {
  try {
    const { camera, controls } = await import('../../viewer/index.js');
    if (camera && controls) {
      previousCameraState.position = camera.position.clone();
      previousCameraState.target = controls.target.clone();
      previousCameraState.saved = true;
    }
  } catch (error) {
    log.warn('Could not save camera state:', error);
  }
}

/**
 * Apply story-based clipping plane
 * @param {string} storyId - Story ID to clip to (optional)
 * @param {number} customRange - Custom range in mm (optional)
 */
export async function applyStoryClip(storyId = null, customRange = null) {
  if (!storyId || storyId === 'all') {
    clearCurrentClipping();
    return;
  }

  const stories = getCurrentStories();
  const selectedStory = stories.find((story) => story.id === storyId);

  if (!selectedStory) {
    log.warn(`Story with ID ${storyId} not found`);
    return;
  }

  // Save camera state before first clipping
  if (!currentClippingState.type) {
    await saveCameraState();
  }

  // Use custom range or default
  const range = customRange || DEFAULT_STORY_CLIP_RANGE;

  // Calculate clipping bounds for the story with custom range
  const storyBounds = calculateStoryBoundsWithRange(selectedStory, stories, range);

  if (storyBounds) {
    const clippingPlanes = createStoryClippingPlanes(storyBounds);

    if (sceneController.applyClipping && clippingPlanes.length > 0) {
      sceneController.applyClipping(clippingPlanes);

      // Update current clipping state
      currentClippingState = {
        type: 'story',
        id: storyId,
        range: range,
        bounds: storyBounds,
      };

      showClippingControls('story');
    }
  }
}

/**
 * Apply axis-based clipping plane
 * @param {string} axisType - "X" or "Y"
 * @param {string} axisId - Axis ID to clip to (optional)
 * @param {number} customRange - Custom range in mm (optional)
 */
export async function applyAxisClip(axisType, axisId = null, customRange = null) {
  // First, check what's in the dropdown selector
  const selectorId = axisType === 'X' ? 'xAxisSelector' : 'yAxisSelector';
  const selector = document.getElementById(selectorId);
  if (!selector) {
    log.warn(`${axisType}-axis selector not found in DOM`);
  }

  if (!axisId || axisId === 'all') {
    clearCurrentClipping();
    return;
  }

  const axesData = getCurrentAxesData();

  const axes = axisType === 'X' ? axesData.xAxes : axesData.yAxes;

  const selectedAxis = axes.find((axis) => axis.id === axisId);

  if (!selectedAxis) {
    log.warn(`${axisType}-axis with ID ${axisId} not found in axes array:`, axes);

    // Check if axes data is empty
    if (axes.length === 0) {
      showWarning(
        `${axisType}軸データが読み込まれていません。STBファイルに軸情報が含まれているか確認してください。`,
      );
    } else {
      showWarning(`選択された${axisType}軸（ID: ${axisId}）が見つかりません。`);
    }
    return;
  }

  if (selectedAxis.axisKind && selectedAxis.axisKind !== 'parallel') {
    showWarning('円弧軸・放射軸の通り芯クリップは未対応です。');
    return;
  }

  // Save camera state before first clipping
  if (!currentClippingState.type) {
    await saveCameraState();
  }

  // Use custom range or default
  const range = customRange || DEFAULT_AXIS_CLIP_RANGE;

  // Calculate clipping bounds for the axis with custom range
  const axisBounds = calculateAxisBoundsWithRange(selectedAxis, axisType, axes, range);

  if (axisBounds) {
    const clippingPlanes = createAxisClippingPlanes(axisBounds, axisType);

    if (sceneController.applyClipping && clippingPlanes.length > 0) {
      sceneController.applyClipping(clippingPlanes);

      // Update current clipping state
      currentClippingState = {
        type: axisType.toLowerCase() + 'Axis',
        id: axisId,
        range: range,
        bounds: axisBounds,
      };

      showClippingControls(axisType.toLowerCase() + 'Axis');
    } else {
      log.error(
        `Failed to apply clipping planes. sceneController.applyClipping function available: ${!!sceneController.applyClipping}`,
      );
    }
  } else {
    log.error(`Failed to calculate axis bounds for ${axisType}-axis`);
  }
}

/**
 * Create clipping planes for story bounds
 * @param {Object} storyBounds - Story bounds data
 * @returns {Array<THREE.Plane>} Array of clipping planes
 */
function createStoryClippingPlanes(storyBounds) {
  try {
    return createAxisRangeClippingPlanes('Z', storyBounds.lowerBound, storyBounds.upperBound);
  } catch (error) {
    log.error('Error creating story clipping planes:', error);
    return [];
  }
}

/**
 * Create clipping planes for axis bounds
 * @param {Object} axisBounds - Axis bounds data
 * @param {string} axisType - "X" or "Y"
 * @returns {Array<THREE.Plane>} Array of clipping planes
 */
function createAxisClippingPlanes(axisBounds, axisType) {
  try {
    return createAxisRangeClippingPlanes(axisType, axisBounds.lowerBound, axisBounds.upperBound);
  } catch (error) {
    log.error('Error creating axis clipping planes:', error);
    return [];
  }
}

/**
 * Clear all clipping planes
 */
export function clearAllClippingPlanes() {
  clearCurrentClipping();
}

/**
 * Get current clipping plane information
 * @returns {Object} Clipping plane status
 */
export function getClippingStatus() {
  // This would need to query the actual clipping state from the renderer
  // For now, return a placeholder
  return {
    hasActiveClipping: false, // Would check actual state
    planeCount: 0,
    type: null, // 'story', 'axis', or 'custom'
    bounds: null,
  };
}

/**
 * Apply custom clipping planes
 * @param {Array<THREE.Plane>} planes - Custom clipping planes
 */
export function applyCustomClippingPlanes(planes) {
  if (!Array.isArray(planes) || planes.length === 0) {
    log.warn('Invalid clipping planes provided');
    return;
  }

  if (sceneController.applyClipping) {
    sceneController.applyClipping(planes);
  } else {
    log.warn('sceneController.applyClipping function not available');
  }
}

/**
 * Create a clipping plane from point and normal
 * @param {THREE.Vector3} point - Point on the plane
 * @param {THREE.Vector3} normal - Normal vector of the plane
 * @returns {THREE.Plane} Clipping plane
 */
export function createClippingPlaneFromPointAndNormal(point, normal) {
  const plane = new THREE.Plane();
  plane.setFromNormalAndCoplanarPoint(normal.normalize(), point);
  return plane;
}

/**
 * Create a box clipping region
 * @param {THREE.Box3} box - Bounding box to clip to
 * @returns {Array<THREE.Plane>} Array of 6 clipping planes
 */
export { createBoxClippingPlanes };

// === NEW FUNCTIONS FOR RANGE-ADJUSTABLE CLIPPING ===

/**
 * 指定された階のクリッピング範囲データを返す（セクションボックス用）
 * @param {string} storyId - Story ID
 * @param {number} range - Range in mm
 * @returns {Object|null} Story bounds data
 */
export function getStoryClipBounds(storyId, range) {
  if (!storyId || storyId === 'all') return null;
  const stories = getCurrentStories();
  const selectedStory = stories.find((story) => story.id === storyId);
  if (!selectedStory) return null;
  return calculateStoryBoundsWithRange(selectedStory, stories, range);
}

/**
 * 指定された軸のクリッピング範囲データを返す（セクションボックス用）
 * @param {string} axisType - "X" or "Y"
 * @param {string} axisId - Axis ID
 * @param {number} range - Range in mm
 * @returns {Object|null} Axis bounds data
 */
export function getAxisClipBounds(axisType, axisId, range) {
  if (!axisId || axisId === 'all') return null;
  const axesData = getCurrentAxesData();
  const axes = axisType === 'X' ? axesData.xAxes : axesData.yAxes;
  const selectedAxis = axes.find((axis) => axis.id === axisId);
  if (!selectedAxis) return null;
  if (selectedAxis.axisKind && selectedAxis.axisKind !== 'parallel') return null;
  return calculateAxisBoundsWithRange(selectedAxis, axisType, axes, range);
}

/**
 * Calculate story bounds with custom range
 * @param {Object} selectedStory - Selected story data
 * @param {Array} allStories - All story data
 * @param {number} range - Range in mm
 * @returns {Object|null} Story bounds
 */
function calculateStoryBoundsWithRange(selectedStory, allStories, range) {
  try {
    const storyHeight = selectedStory.height;

    return {
      type: 'story',
      storyId: selectedStory.id,
      storyName: selectedStory.name,
      height: storyHeight,
      lowerBound: storyHeight - range,
      upperBound: storyHeight + range,
    };
  } catch (error) {
    log.error('Error calculating story bounds with range:', error);
    return null;
  }
}

/**
 * Calculate axis bounds with custom range
 * @param {Object} selectedAxis - Selected axis data
 * @param {string} axisType - "X" or "Y"
 * @param {Array} allAxes - All axes
 * @param {number} range - Range in mm
 * @returns {Object|null} Axis bounds
 */
function calculateAxisBoundsWithRange(selectedAxis, axisType, allAxes, range) {
  try {
    const axisDistance = selectedAxis.distance;

    return {
      type: 'axis',
      axisType,
      axisId: selectedAxis.id,
      axisName: selectedAxis.name,
      distance: axisDistance,
      lowerBound: axisDistance - range,
      upperBound: axisDistance + range,
    };
  } catch (error) {
    log.error('Error calculating axis bounds with range:', error);
    return null;
  }
}

/**
 * Show clipping range controls for the specified type
 * @param {string} type - 'story', 'xAxis', or 'yAxis'
 */
function showClippingControls(type) {
  // Hide all controls first
  const controlIds = ['storyClipControls', 'xAxisClipControls', 'yAxisClipControls'];
  controlIds.forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.classList.add('hidden');
  });

  // Show the relevant control
  const controlId = type + 'ClipControls';
  const controlElement = document.getElementById(controlId);
  if (controlElement) {
    controlElement.classList.remove('hidden');

    // Mark the group as active
    const groupElement = controlElement.closest('.clipping-group');
    if (groupElement) {
      groupElement.classList.add('active', 'clipping-active');
    }
  }
}

/**
 * Hide all clipping range controls
 */
function hideAllClippingControls() {
  const controlIds = ['storyClipControls', 'xAxisClipControls', 'yAxisClipControls'];
  controlIds.forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.classList.add('hidden');
  });

  // Remove active states
  const groups = document.querySelectorAll('.clipping-group');
  groups.forEach((group) => {
    group.classList.remove('active', 'clipping-active');
  });
}

/**
 * Clear current clipping and reset UI
 */
async function clearCurrentClipping() {
  // Restore camera view if saved
  await restorePreviousCameraView();

  if (sceneController.clearClipping) {
    sceneController.clearClipping();
  } else {
    log.warn('sceneController.clearClipping function not available');
  }

  currentClippingState = {
    type: null,
    id: null,
    range: null,
    bounds: null,
  };

  hideAllClippingControls();

  // Reset selector values to "all"
  const storySelector = document.getElementById('storySelector');
  const xAxisSelector = document.getElementById('xAxisSelector');
  const yAxisSelector = document.getElementById('yAxisSelector');

  if (storySelector && storySelector.value !== 'all') {
    storySelector.value = 'all';
  }
  if (xAxisSelector && xAxisSelector.value !== 'all') {
    xAxisSelector.value = 'all';
  }
  if (yAxisSelector && yAxisSelector.value !== 'all') {
    yAxisSelector.value = 'all';
  }

  // Request render update
  scheduleRender();
}

/**
 * Update clipping range for current active clipping
 * @param {number} newRange - New range in mm
 */
export function updateClippingRange(newRange) {
  if (!currentClippingState.type || !currentClippingState.id) {
    log.warn('No active clipping to update');
    return;
  }

  const { type, id } = currentClippingState;

  switch (type) {
    case 'story':
      applyStoryClip(id, newRange);
      break;
    case 'xAxis':
      applyAxisClip('X', id, newRange);
      break;
    case 'yAxis':
      applyAxisClip('Y', id, newRange);
      break;
  }
}

/**
 * Get current clipping state
 * @returns {Object} Current clipping state
 */
export function getCurrentClippingState() {
  return { ...currentClippingState };
}

/**
 * Restore camera to previous view (public export)
 * @returns {Promise<void>}
 */
export async function restoreCameraView() {
  await restorePreviousCameraView();
}

// === CAMERA ADJUSTMENT FUNCTIONS ===

/**
 * Restore previously saved camera state
 * @param {THREE.Camera} camera - Camera to restore state to
 * @param {OrbitControls} controls - Controls to restore target to
 * @param {boolean} animate - Whether to animate the transition
 */
function restoreCameraState(camera, controls, animate = true) {
  if (!previousCameraState.saved || !camera || !controls) {
    log.warn('Cannot restore camera state: no saved state or missing camera/controls');
    return;
  }

  if (animate) {
    animateCameraTo(camera, controls, {
      position: previousCameraState.position,
      target: previousCameraState.target,
    });
  } else {
    camera.position.copy(previousCameraState.position);
    controls.target.copy(previousCameraState.target);
    controls.update();
  }
}

/**
 * Restore previous camera view with fallback handling
 */
async function restorePreviousCameraView() {
  try {
    const { camera, controls } = await import('../../viewer/index.js');
    if (camera && controls) {
      restoreCameraState(camera, controls);
    } else {
      log.warn('Camera or controls not available for view restoration');
    }
  } catch (error) {
    log.warn('Could not restore camera view:', error);
  } finally {
    // Reset saved flag after restoration attempt
    previousCameraState.saved = false;
  }
}

/**
 * Animate camera to new position smoothly
 * @param {THREE.Camera} camera - Camera to animate
 * @param {OrbitControls} controls - Camera controls
 * @param {Object} target - Target camera state {position, target, up}
 */
function animateCameraTo(camera, controls, target) {
  const duration = 1000; // 1 second animation
  const startTime = Date.now();

  const startPosition = camera.position.clone();
  const startTarget = controls.target.clone();
  const startUp = camera.up.clone();

  function animate() {
    const elapsed = Date.now() - startTime;
    const progress = Math.min(elapsed / duration, 1);

    // Smooth easing function
    const easeProgress = 1 - Math.pow(1 - progress, 3);

    // Interpolate position
    camera.position.lerpVectors(startPosition, target.position, easeProgress);

    // Interpolate target
    controls.target.lerpVectors(startTarget, target.target, easeProgress);

    // Interpolate up vector if provided
    if (target.up) {
      camera.up.lerpVectors(startUp, target.up, easeProgress);
    }

    controls.update();

    if (progress < 1) {
      requestAnimationFrame(animate);
    }
  }

  animate();
}
