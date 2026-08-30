/**
 * @fileoverview カメラモード管理モジュール
 *
 * PerspectiveCamera（3Dモード）とOrthographicCamera（2Dモード）の
 * 切り替えを管理します。
 */

import * as THREE from 'three';
import {
  camera,
  orthographicCamera,
  controls,
  renderer,
  getActiveCamera,
  setActiveCamera,
} from '../core/core.js';
import { getCanvasAspect } from '../core/viewportMetrics.js';
import {
  getOrthographicAspect,
  matchOrthographicToPerspective,
  setOrthographicViewHeight,
} from '../core/orthographicProjection.js';
import { CAMERA_MODES, CAMERA_CONTEXTS } from '../../constants/displayModes.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('viewer:camera:cameraManagerImpl');

// 現在のカメラモード
let currentMode = CAMERA_MODES.PERSPECTIVE;
let currentContext = CAMERA_CONTEXTS.SOLID;

/**
 * 現在のカメラモードを取得
 * @returns {string} 現在のカメラモード
 */
export function getCameraMode() {
  return currentMode;
}

export function getCameraContext() {
  return currentContext;
}

export function setCameraContext(context) {
  if (context !== CAMERA_CONTEXTS.SOLID && context !== CAMERA_CONTEXTS.DRAWING) {
    log.warn('[CameraManager] Invalid camera context:', context);
    return false;
  }

  currentContext = context;
  updateControlsForMode(currentMode, currentContext);
  return true;
}

/**
 * カメラモードを切り替え
 * @param {string} mode - 新しいカメラモード（'perspective' または 'orthographic'）
 * @param {number} [_transitionDuration=0] - トランジション時間（ミリ秒、未実装）
 * @returns {boolean} 切り替えが成功したかどうか
 */
export function setCameraMode(mode, _transitionDuration = 0) {
  if (mode !== CAMERA_MODES.PERSPECTIVE && mode !== CAMERA_MODES.ORTHOGRAPHIC) {
    log.warn('[CameraManager] Invalid camera mode:', mode);
    return false;
  }

  if (currentMode === mode) {
    return false; // 既に同じモード
  }

  const oldCamera = getActiveCamera();
  const newCamera = mode === CAMERA_MODES.PERSPECTIVE ? camera : orthographicCamera;

  if (!newCamera) {
    log.error('[CameraManager] Camera not initialized:', mode);
    return false;
  }

  // 現在のカメラの位置と向きを新しいカメラにコピー
  if (oldCamera && oldCamera !== newCamera) {
    newCamera.position.copy(oldCamera.position);
    newCamera.up.copy(oldCamera.up);
    newCamera.rotation.copy(oldCamera.rotation);

    // 3D Perspective の現在の見かけスケールを正投影へ引き継ぐ。
    // FOV/位置/targetは変更せず、Orthographic側のfrustumだけを調整する。
    if (
      newCamera.isOrthographicCamera &&
      oldCamera.isPerspectiveCamera &&
      controls &&
      controls._cc
    ) {
      const target = controls._cc.getTarget(new THREE.Vector3());
      const aspect = getCanvasAspect(renderer?.domElement);
      matchOrthographicToPerspective(newCamera, oldCamera, target, aspect);
    }

    newCamera.updateProjectionMatrix();
  }

  // カメラを切り替え
  setActiveCamera(newCamera);
  currentMode = mode;

  // コントロールのカメラを更新
  if (controls && controls._cc) {
    const oldTarget = controls._cc.getTarget(new THREE.Vector3());
    controls._cc.camera = newCamera;
    // ターゲットを維持
    controls._cc.setTarget(oldTarget.x, oldTarget.y, oldTarget.z, false);
    // upベクトルを同期（重要：これがないとマウス操作の方向がおかしくなる）
    if (typeof controls._cc.updateCameraUp === 'function') {
      controls._cc.updateCameraUp();
    }
  }

  // カメラモードに応じてコントロールを更新
  updateControlsForMode(mode, currentContext);

  return true;
}

/**
 * カメラモードに応じてコントロールを更新
 * @param {string} mode - カメラモード
 * @private
 */
function updateControlsForMode(mode, context = currentContext) {
  if (!controls) return;

  const isDrawingOrthographic =
    mode === CAMERA_MODES.ORTHOGRAPHIC && context === CAMERA_CONTEXTS.DRAWING;

  if (isDrawingOrthographic) {
    // 2Dモード: 回転を無効化し、ズームとパンを有効化
    controls.enableRotate = false;
    controls.enableZoom = true; // CameraControls の標準ズーム（Orthographic では zoom 変更）
    controls.enablePan = true;

    // Orthographic 用の各種設定
    if ('dollyToCursor' in controls) controls.dollyToCursor = true;
    // infinityDolly は OrthographicCamera では無関係なので設定しない
    // if ("infinityDolly" in controls) controls.infinityDolly = true;

    // ズーム範囲と速度（必要に応じて調整可）
    if (controls._cc) {
      controls._cc.minZoom = 0.01;
      controls._cc.maxZoom = 50;
      controls._cc.dollySpeed = 1.0;
    }

    // 左ドラッグでパン、ホイールでズーム
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
  } else {
    // 3Dモード: 回転・ズーム・パンすべて有効
    controls.enableRotate = true;
    controls.enableZoom = true;
    controls.enablePan = true;

    if ('dollyToCursor' in controls) controls.dollyToCursor = false;
    if ('infinityDolly' in controls) controls.infinityDolly = false;

    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };

    // Orthographic モードで設定された値をリセット + 回転基準をリセット
    if (controls._cc) {
      controls._cc.minZoom = 0.01;
      controls._cc.maxZoom = mode === CAMERA_MODES.ORTHOGRAPHIC ? 50 : Infinity;
      controls._cc.dollySpeed = 1.0;
      controls._cc.normalizeRotations();
      controls._cc.update(0);
    }
  }

  if (controls._cc && isDrawingOrthographic) {
    controls._cc.normalizeRotations();
    controls._cc.update(0);
  }
}

/**
 * 現在のカメラモードのコントロール設定を再適用
 * ビュー変更後にコントロールの整合性を保証するために使用
 */
export function reaffirmControlsForCurrentMode() {
  updateControlsForMode(currentMode, currentContext);
}

/**
 * カメラモードをトグル（3D ↔ 2D）
 * @returns {string} 新しいカメラモード
 */
export function toggleCameraMode() {
  const newMode =
    currentMode === CAMERA_MODES.PERSPECTIVE ? CAMERA_MODES.ORTHOGRAPHIC : CAMERA_MODES.PERSPECTIVE;

  setCameraMode(newMode);
  return newMode;
}

/**
 * OrthographicCameraのズームサイズを設定
 * @param {number} size - frustumサイズ（mm単位）
 */
export function setOrthographicSize(size) {
  if (!orthographicCamera) {
    log.warn('[CameraManager] OrthographicCamera not initialized');
    return;
  }

  const aspect = getOrthographicAspect(orthographicCamera);
  setOrthographicViewHeight(orthographicCamera, size, aspect, { resetZoom: false });
}

/**
 * カメラマネージャーの状態をデバッグ出力
 * @returns {Object} デバッグ情報
 */
export function getDebugInfo() {
  return {
    currentMode,
    currentContext,
    activeCameraType: getActiveCamera()?.type || 'none',
    perspectiveCameraExists: !!camera,
    orthographicCameraExists: !!orthographicCamera,
    controlsEnabled: {
      rotate: controls?.enableRotate,
      zoom: controls?.enableZoom,
      pan: controls?.enablePan,
    },
  };
}
