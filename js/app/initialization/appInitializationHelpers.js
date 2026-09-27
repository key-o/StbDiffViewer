/**
 * @fileoverview アプリケーション初期化ヘルパー
 */
/* global PointerEvent */

import * as THREE from 'three';
import { createLogger } from '../../utils/logger.js';
import {
  scene,
  camera,
  controls,
  renderer,
  elementGroups,
  animate,
  setupViewportResizeHandler,
  createOrUpdateGridHelper,
  getActiveCamera,
  colorManager,
} from '../../viewer/index.js';
import {
  setupInteractionListeners,
  getInteractionManagerServices,
} from '../controllers/interactionController.js';
import {
  installInteractionManager,
  getSelectedCenter,
} from '../../viewer/interaction/interactionManager.js';
import {
  setupViewModeListeners,
  setupCameraModeListeners,
  initViewModes,
  updateModelVisibility,
} from '../viewModes/index.js';
import { setupColorModeListeners, setFloatingWindowManager } from '../../colorModes/index.js';
import { floatingWindowManager } from '../../ui/panels/floatingWindowManager.js';
import {
  setupUIEventListeners,
  toggleLegend,
  applyStoryClip,
  applyAxisClip,
} from '../../ui/index.js';
import { initDepth2DClippingUI } from '../../ui/viewer3d/clipping2DImpl.js';
import { displayElementInfo } from '../../ui/panels/element-info/index.js';
import { regenerateAllLabels } from '../../ui/viewer3d/labelRegeneration.js';
import { clearClippingPlanes } from '../../viewer/index.js';
import { getState, setState, registerGlobalFunction } from '../../data/state/globalState.js';
import { viewerEventBridge } from '../../viewer/services/viewerEventBridge.js';
import { initializeGlobalMessenger } from '../moduleMessaging.js';
import { initializeImportanceManager, getImportanceManager } from '../importanceManager.js';
import { notify } from '../controllers/notificationController.js';
import { normalizeSectionData } from '../sectionEquivalenceEngine.js';
import { setupDiffSummaryEventListeners } from '../../ui/panels/diffSummary/index.js';
import { setRenderFunction } from '../../utils/renderScheduler.js';
import { initKeyboardShortcuts } from '../../viewer/interaction/keyboard-shortcuts.js';
import { initializeViewCube } from '../../ui/viewer3d/viewCube/ViewCube.js';
import { CAMERA_ORTHOGRAPHIC } from '../../config/renderingConstants.js';
import { renderElementSettingsRows } from '../../ui/panels/elementSettingsTable.js';
import {
  renderRebarDetailingChoiceSettings,
  setRebarDetailingJointAssemblyCheckProvider,
  setRebarDetailingWidthCheckProvider,
} from '../../ui/panels/rebarDetailingChoiceSettings.js';
import { collectRebarAppendixA2JointAssemblyChecks } from '../../data/extractors/rebar3d/rebarAppendixA2JointAssemblyChecks.js';
import { collectRebarAppendixA3WidthChecks } from '../../data/extractors/rebar3d/rebarAppendixA3SectionWidthChecks.js';
import { getModelContext } from '../viewModes/modelContext.js';
import { setModelLoaderDependencies } from '../../modelLoader/loaderDependencies.js';
import {
  initMeasurementManager,
  isMeasurementModeActive,
  getMeasurementStep,
  handleMeasurementClick,
  enterMeasurementMode,
  exitMeasurementMode,
  deleteMeasurement,
} from '../../viewer/measurement/measurementManager.js';
import { initMeasurementUI } from '../../ui/measurement/measurementUIController.js';
import { connectElementColorPreferences } from '../elementColorPreferencesBridge.js';

const log = createLogger('appInitializationHelpers');

const ORTHOGRAPHIC_ZOOM_FACTOR = CAMERA_ORTHOGRAPHIC.ZOOM_FACTOR;
const ORTHOGRAPHIC_MIN_ZOOM = CAMERA_ORTHOGRAPHIC.MIN_ZOOM;
const ORTHOGRAPHIC_MAX_ZOOM = CAMERA_ORTHOGRAPHIC.MAX_ZOOM;

/**
 * グローバル関数を登録
 * @param {Function} scheduleRender - 再描画関数
 */
export function registerAppGlobals(scheduleRender) {
  registerGlobalFunction('toggleLegend', toggleLegend);
  registerGlobalFunction('applyStoryClip', applyStoryClip);
  registerGlobalFunction('applyAxisClip', applyAxisClip);
  registerGlobalFunction('displayElementInfo', displayElementInfo);
  registerGlobalFunction('clearClippingPlanes', clearClippingPlanes);
  registerGlobalFunction('regenerateAllLabels', regenerateAllLabels);
  registerGlobalFunction('scheduleRender', scheduleRender);
  registerGlobalFunction('requestRender', scheduleRender);

  window.toggleLegend = toggleLegend;
  window.applyStoryClip = applyStoryClip;
  window.applyAxisClip = applyAxisClip;
  window.displayElementInfo = displayElementInfo;
  window.clearClippingPlanes = clearClippingPlanes;
  window.requestRender = /** @type {() => void} */ (scheduleRender);

  setState('rendering.scheduleRender', scheduleRender);
  setState('rendering.requestRender', scheduleRender);
  setRenderFunction(scheduleRender);

  log.info('グローバル関数を登録しました');
}

/**
 * アプリケーションサービスを初期化
 * @param {boolean} rendererInitialized - レンダラー初期化フラグ
 */
export function initializeApplicationServices(rendererInitialized) {
  connectElementColorPreferences(colorManager);
  setState('rendering.rendererInitialized', rendererInitialized);
  setState('rendering.scene', scene);
  setState('elementGroups', elementGroups);
  installInteractionManager(getInteractionManagerServices());

  initializeGlobalMessenger();
  viewerEventBridge.initialize();
  log.info('ViewerEventBridgeを初期化しました');

  setModelLoaderDependencies({
    getState,
    setState,
    notify,
    getImportanceManager,
    normalizeSectionData,
    initViewModes,
    updateModelVisibility,
  });
  log.info('modelLoader依存関係が注入されました');

  initializeImportanceManager()
    .then(() => {
      log.info('重要度マネージャーが初期化されました');
    })
    .catch((error) => {
      log.error('重要度マネージャーの初期化に失敗しました:', error);
    });

  renderElementSettingsRows();
  setRebarDetailingJointAssemblyCheckProvider(() => {
    const { modelADocument, modelBDocument } = getModelContext();
    return {
      A: collectRebarAppendixA2JointAssemblyChecks(modelADocument),
      B: collectRebarAppendixA2JointAssemblyChecks(modelBDocument),
    };
  });
  setRebarDetailingWidthCheckProvider(() => {
    const { modelADocument, modelBDocument } = getModelContext();
    return {
      A: collectRebarAppendixA3WidthChecks(modelADocument),
      B: collectRebarAppendixA3WidthChecks(modelBDocument),
    };
  });
  renderRebarDetailingChoiceSettings();
}

/**
 * UIとViewer関連のランタイムを初期化
 * @param {Function} scheduleRender - 再描画関数
 */
export function initializeRuntimeUI(scheduleRender) {
  setupUIEventListeners();
  setupViewportResizeHandler(camera);

  initMeasurementManager();
  setupInteractionListeners(scheduleRender, {
    getMeasurementModeActive: isMeasurementModeActive,
    dispatchToMeasurementManager: handleMeasurementClick,
    getMeasurementStep,
  });
  initMeasurementUI({
    enter: enterMeasurementMode,
    exit: exitMeasurementMode,
    deleteById: deleteMeasurement,
  });

  setupViewModeListeners(scheduleRender);
  setupCameraModeListeners(scheduleRender);
  initDepth2DClippingUI();
  setFloatingWindowManager(floatingWindowManager);
  setupColorModeListeners();
  setupDiffSummaryEventListeners();
  initKeyboardShortcuts();
  initializeViewCube();

  log.info('ViewCubeが初期化されました');
}

/**
 * ビューアーの描画ループを開始
 */
export function startViewerRuntime() {
  animate(controls, scene);
  createOrUpdateGridHelper(new THREE.Box3());
}

/**
 * 選択要素中心へのズーム動作を設定
 */
export function setupZoomToCursorBehavior() {
  try {
    const canvasElement = renderer?.domElement || document.getElementById('three-canvas');
    if (!canvasElement || canvasElement.hasWheelListener) {
      return;
    }

    canvasElement.hasWheelListener = true;
    canvasElement.addEventListener(
      'wheel',
      (event) => {
        const activeCamera = getActiveCamera();
        const isOrthographic = activeCamera?.isOrthographicCamera;

        if (isOrthographic && activeCamera) {
          event.preventDefault();
          event.stopPropagation();

          if (!controls?._cc) {
            log.warn('[WARN] CameraControls instance not ready; skipping orthographic zoom.');
            return;
          }

          const deltaZoom = -event.deltaY * ORTHOGRAPHIC_ZOOM_FACTOR;
          const minZoom = controls._cc.minZoom ?? ORTHOGRAPHIC_MIN_ZOOM;
          const maxZoom = controls._cc.maxZoom ?? ORTHOGRAPHIC_MAX_ZOOM;
          const targetZoom = THREE.MathUtils.clamp(activeCamera.zoom + deltaZoom, minZoom, maxZoom);
          controls._cc.zoomTo(targetZoom, false);
          controls._cc.update(0);
          return;
        }

        const center = getSelectedCenter?.();
        if (!center || !activeCamera) {
          return;
        }

        const pointer = createPointerMoveEvent(center, activeCamera, canvasElement);
        canvasElement.dispatchEvent(pointer);
      },
      { capture: true, passive: false },
    );

    log.info('選択範囲へのズーム動作を設定しました');
  } catch (error) {
    log.warn('選択範囲へのズーム動作の設定に失敗しました:', error);
  }
}

function createPointerMoveEvent(world, activeCamera, canvasElement) {
  const projected = world.clone().project(activeCamera);
  const rect = canvasElement.getBoundingClientRect();
  const clientX = (projected.x * 0.5 + 0.5) * rect.width + rect.left;
  const clientY = (-projected.y * 0.5 + 0.5) * rect.height + rect.top;

  return new PointerEvent('pointermove', {
    clientX,
    clientY,
    pointerId: 1,
    pointerType: 'mouse',
    bubbles: true,
  });
}
