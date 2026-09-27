/**
 * @fileoverview 3D建築モデルビューワーのコアモジュール
 *
 * このファイルは、Three.jsを使用した3D建築モデルビューワーの中心となる機能を提供します:
 * - 3Dシーン、カメラ、レンダラー、コントロールの初期化と設定
 * - 建築要素（柱、梁、床など）の3D表示のためのグループ管理
 * - mmスケールでの3D表示（建築モデル用に最適化）
 * - 軸表示、グリッド表示などの補助機能
 * - ライト設定と視覚効果の管理
 * - アニメーションループとレンダリング処理
 * - ウィンドウリサイズへの対応
 *
 * このモジュールは、Three.jsをベースとした3D表示の基盤となり、
 * 他のモジュールがこの上に構築される形で機能します。
 */

import * as THREE from 'three';
import { createLogger } from '../../utils/logger.js';
import { OrbitLikeControlsShim, MinimalControls } from '../controls/orbitLikeControlsShim.js';
import { getFrustumCuller } from '../rendering/FrustumCuller.js';
import { getLabelVisibilityCuller } from '../annotations/labelVisibilityCuller.js';
import { resizeOrthographicFrustum } from './orthographicProjection.js';
import { getCanvasDisplaySize } from './viewportMetrics.js';
import { AnimationLoopController, ViewportResizeController } from './runtimeLifecycle.js';

const log = createLogger('viewer/core/core');

// CameraControls を使用（OrbitControls から移行）
// CameraControls is only needed in the browser. Dynamically import it there to avoid
// attempting to load remote ESM modules in Node (which would fail the tests).
let CameraControls = null;
let CameraControlsPromise = null;
if (typeof window !== 'undefined') {
  // Start loading CameraControls asynchronously and keep the promise so
  // initRenderer can wait for it before instantiating controls.
  CameraControlsPromise = import('camera-controls')
    .then((mod) => {
      CameraControls = mod.default || mod;
      // install THREE reference into CameraControls (some distributions require this)
      if (CameraControls && typeof CameraControls.install === 'function') {
        CameraControls.install({ THREE });
      }
    })
    .catch((err) => {
      log.warn('CameraControls の読み込みに失敗しました:', err);
      CameraControls = null;
    });
}

// --- 定数 ---
// 要素タイプ定義は js/config/elementTypes.js で一元管理
// three依存を持たないため、テスト環境でも安全にインポート可能
import { SUPPORTED_ELEMENTS } from '../../constants/elementTypes.js';

// --- Three.js シーン / カメラ / レンダラー ---
// エクスポートは必ず行うが、Node (tests) 環境ではブラウザ用初期化を行わない
export let scene;
export let camera; // PerspectiveCamera（デフォルト・3Dモード用）
export let orthographicCamera; // OrthographicCamera（2Dモード用）
export let renderer = null;
export let controls = null;
let renderRequested = true;

// --- アクティブカメラ管理 ---
// 複数のカメラ（Perspective/Orthographic）を切り替え可能にする
// デフォルトはPerspectiveCamera（3Dモード）
export let activeCamera = null; // 初期化後にcameraを代入
let viewportResizeController = null;
let animationScene = null;
let animationCameraOverride = null;
let cullingFrameCounter = 0;
const CULLING_INTERVAL = 3;

if (typeof window !== 'undefined') {
  // ブラウザ環境での初期化
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf0f0f0);

  camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    // ★★★ near/far を mm スケールに調整 ★★★
    10, // near: 10mm
    50000000, // far: 50km
  );
  camera.position.set(10000, -10000, 10000);
  camera.up.set(0, 0, 1);

  // OrthographicCamera を初期化（2Dモード用）
  const aspect = window.innerWidth / window.innerHeight;
  const frustumSize = 20000; // モデルサイズに応じて調整可能（デフォルト20m）
  orthographicCamera = new THREE.OrthographicCamera(
    (-frustumSize * aspect) / 2, // left
    (frustumSize * aspect) / 2, // right
    frustumSize / 2, // top
    -frustumSize / 2, // bottom
    1, // near
    50000000, // far: 50km
  );
  orthographicCamera.position.set(0, 0, 20000); // 上から見下ろす位置
  orthographicCamera.up.set(0, 1, 0); // Y軸が上

  // アクティブカメラを初期化（デフォルトはPerspectiveCamera）
  activeCamera = camera;

  // renderer/controls は initRenderer で初期化する想定だが、ここではプレースホルダを用意
  renderer = null;
  controls = null;
} else {
  // Node 環境（テスト実行）向けの軽量な代替を用意
  // Three.js の基本オブジェクトは Node でも動作するため簡易カメラとシーンを作成する
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(75, 1, 10, 50000000);

  // OrthographicCamera（テスト環境用）
  const frustumSize = 20000;
  orthographicCamera = new THREE.OrthographicCamera(
    -frustumSize / 2,
    frustumSize / 2,
    frustumSize / 2,
    -frustumSize / 2,
    1,
    50000000,
  );

  activeCamera = camera; // テスト環境でもactiveCameraを設定
  renderer = null;
  controls = null;
}

/**
 * アクティブカメラを取得
 * @returns {THREE.Camera} 現在アクティブなカメラ
 */
export function getActiveCamera() {
  return activeCamera;
}

/**
 * アクティブカメラを設定
 * @param {THREE.Camera} newCamera - 新しいアクティブカメラ
 */
export function setActiveCamera(newCamera) {
  activeCamera = newCamera;
}

/**
 * アクティブなコントロールを設定
 * common-viewerのCameraManagerからコントロールを同期する際に使用
 * @param {Object} newControls - 新しいコントロール
 */
export function setActiveControls(newControls) {
  detachControlsChangeListener(controls);
  controls = newControls;
  attachControlsChangeListener(controls);
  if (typeof window !== 'undefined') {
    window.controls = controls;
  }
  requestRender();
}

export function requestRender() {
  renderRequested = true;
}

function attachControlsChangeListener(targetControls) {
  if (targetControls && typeof targetControls.addEventListener === 'function') {
    targetControls.addEventListener('change', requestRender);
  }
}

function detachControlsChangeListener(targetControls) {
  if (targetControls && typeof targetControls.removeEventListener === 'function') {
    targetControls.removeEventListener('change', requestRender);
  }
}

// 後方互換性のためcore.jsからも公開するが、実装はviewportMetrics.jsに一元化する。
export { getCanvasDisplaySize };

// --- ライト設定 ---
// 以前は同方向のDirectionalLightを2灯（1.0 + 0.8）追加していたため、
// 見た目を変えずに1灯へ統合する。
export const directionalLight = new THREE.DirectionalLight(0xffffff, 1.8);
directionalLight.position.set(1, 1, 1).normalize();
scene.add(directionalLight);
const ambientLight = new THREE.AmbientLight(0xcccccc, 0.5);
scene.add(ambientLight);

// --- ヘルパー設定 ---
// ★★★ AxesHelper のサイズを mm スケールに調整 ★★★
export const axesHelper = new THREE.AxesHelper(5000); // 5m
axesHelper.visible = false; // デフォルトは非表示
scene.add(axesHelper);
// ★★★ GridHelper の初期サイズと分割数を mm スケールに調整 ★★★
export const gridHelper = new THREE.GridHelper(100000, 100); // 100m grid, 1m divisions
scene.add(gridHelper);

// --- 要素グループの初期化 ---
export const elementGroups = {};
SUPPORTED_ELEMENTS.forEach((type) => {
  const group = new THREE.Group();
  // ★★★ userData に elementType を設定 ★★★
  group.userData = { elementType: type };
  elementGroups[type] = group;
  scene.add(elementGroups[type]);
});

// --- レンダラー初期化 ---
/**
 * レンダラーを初期化し、DOMに追加する
 * @returns {boolean} 初期化が成功したかどうか
 */
export async function initRenderer() {
  try {
    // 再初期化時に旧Controls/loopの副作用を残さない。
    const restartAnimationLoop = animationLoopController.isRunning();
    if (restartAnimationLoop) animationLoopController.stop();
    detachControlsChangeListener(controls);
    controls?.dispose?.();

    const canvas = document.getElementById('three-canvas');
    if (!canvas) {
      log.error("ID 'three-canvas'のキャンバス要素が見つかりません。");
      return false;
    }
    renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      antialias: true,
      // HTMLレポート出力時にcanvas.toDataURL()で画像取得できるようにする
      preserveDrawingBuffer: true,
    });
    // 出力してWebGLコンテキストが取得できているか確認
    try {
      renderer.getContext && renderer.getContext();
    } catch (e) {
      log.warn('WebGL context check failed:', e);
    }
    canvas.style.width = '';
    canvas.style.height = '';
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    updateViewportSize();
    renderer.localClippingEnabled = true;
    // WebXR対応: xr.enabledをtrueにしても通常モードには影響なし
    renderer.xr.enabled = true;

    // CameraControls の読み込みが進行中であれば待機する
    if (CameraControlsPromise) {
      try {
        await CameraControlsPromise;
      } catch (e) {
        // 既に警告は出しているが、ここではフォールバックとして続行
        log.warn('CameraControls の初期化待機中にエラーが発生しました:', e);
      }
    }

    // ★★★ CameraControls ベースの互換ラッパーをインスタンス化 ★★★
    // CameraControls が利用できない場合は、致命的エラーにせず
    // 最小限のフォールバックコントロールを用意してレンダリングを継続する
    if (CameraControls) {
      controls = new OrbitLikeControlsShim(camera, renderer.domElement, CameraControls);
    } else {
      log.warn('CameraControls が利用できません。フォールバックの最小コントロールを使用します。');
      controls = new MinimalControls(camera, renderer.domElement);
    }

    // グローバルアクセス用にwindowオブジェクトに設定
    window.controls = controls;

    // ★★★ コントロールの設定（以前の値を踏襲） ★★★
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.screenSpacePanning = true;
    controls.minDistance = 100; // 100mm (10cm)
    controls.maxDistance = 50000000; // 50km 相当（大規模モデルでも十分）
    controls.maxPolarAngle = Math.PI;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };

    attachControlsChangeListener(controls);
    if (restartAnimationLoop) animationLoopController.start();

    requestRender();

    return true;
  } catch (error) {
    log.error('レンダラーの初期化に失敗しました:', error);
    controls = null; // エラー時は controls も null に戻す
    return false;
  }
}

// 回転中心変更中のフラグ（interaction.jsから制御される）
let skipControlsUpdate = false;
export function setSkipControlsUpdate(skip) {
  skipControlsUpdate = skip;
}

// フラスタムカリングの有効/無効フラグ
let frustumCullingEnabled = false;
let labelVisibilityCullingProvider = null;

/**
 * フラスタムカリングの有効/無効を設定
 * @param {boolean} enabled - true で有効化
 */
export function setFrustumCullingEnabled(enabled) {
  frustumCullingEnabled = enabled;
  const culler = getFrustumCuller(activeCamera);
  culler.setEnabled(enabled, scene);
}

/**
 * フラスタムカリングの状態を取得
 * @returns {boolean}
 */
export function isFrustumCullingEnabled() {
  return frustumCullingEnabled;
}

/**
 * ラベルカリング用のラベル取得プロバイダーを設定する。
 * viewer 層から ui 層へ直接依存しないための注入口。
 * @param {{getLabels: Function}|null} provider
 */
export function setLabelVisibilityCullingProvider(provider) {
  labelVisibilityCullingProvider =
    provider && typeof provider.getLabels === 'function' ? provider : null;
}

// --- AR/XRセッション状態 ---
let _xrSessionActive = false;
let _xrFrameHandler = null;

/**
 * XRセッションのアクティブ状態を設定
 * @param {boolean} active - true でXRセッション中
 */
export function setXRSessionActive(active) {
  _xrSessionActive = !!active;
}

/**
 * XRセッションがアクティブかどうかを取得
 * @returns {boolean}
 */
export function isXRSessionActive() {
  return _xrSessionActive;
}

/**
 * XRフレームごとのコールバックを設定
 * @param {((frame: XRFrame) => void)|null} handler
 */
export function setXRFrameHandler(handler) {
  _xrFrameHandler = typeof handler === 'function' ? handler : null;
}

// --- アニメーションループ ---
let _clock = new THREE.Clock();

function frameUpdate(_timestamp, xrFrame) {
  if (!renderer) return;

  let shouldRender = renderRequested || _xrSessionActive;
  if (!skipControlsUpdate && !_xrSessionActive) {
    const dt = _clock.getDelta();
    const currentControls = controls;
    if (currentControls && typeof currentControls.update === 'function') {
      const controlsChanged = currentControls.update(dt);
      shouldRender = shouldRender || controlsChanged === true;
    }
  }

  const renderCamera = animationCameraOverride || activeCamera;
  const renderScene = animationScene || scene;
  if (!renderCamera || !renderScene) return;

  if (frustumCullingEnabled) {
    cullingFrameCounter++;
    if (cullingFrameCounter >= CULLING_INTERVAL) {
      cullingFrameCounter = 0;
      const culler = getFrustumCuller(renderCamera);
      culler.cullElementGroups(elementGroups);
      shouldRender = true;
    }
  }

  if (_xrSessionActive && xrFrame && _xrFrameHandler) {
    try {
      _xrFrameHandler(xrFrame);
    } catch (e) {
      log.warn('XRフレームハンドラ実行中にエラーが発生しました:', e);
    }
  }

  if (!shouldRender) return;

  if (labelVisibilityCullingProvider) {
    const labels = labelVisibilityCullingProvider.getLabels();
    getLabelVisibilityCuller().cullLabels(labels, renderCamera);
  }
  renderer.render(renderScene, renderCamera);
  renderRequested = false;
}

const animationLoopController = new AnimationLoopController({
  getRenderer: () => renderer,
  frameHandler: frameUpdate,
});

/**
 * アニメーションループを開始する。
 * 2回目以降の呼び出しではloopを重複登録せず、scene/camera/controls参照だけを更新する。
 * @param {Object} nextControls - カメラコントロール
 * @param {THREE.Scene} nextScene - レンダリングするシーン
 * @param {THREE.Camera} [nextCamera] - 固定カメラ。省略時は毎frame activeCameraを参照する
 */
export function animate(nextControls = controls, nextScene = scene, nextCamera = null) {
  if (nextControls !== controls) {
    setActiveControls(nextControls);
  }
  animationScene = nextScene || scene;
  animationCameraOverride = nextCamera || null;

  if (!animationLoopController.isRunning()) {
    _clock = new THREE.Clock();
    cullingFrameCounter = 0;
  }

  requestRender();
  animationLoopController.start();
}

// --- ウィンドウリサイズ処理 ---
/**
 * ビューポートサイズをウィンドウに合わせて更新
 * カメラのアスペクト比とレンダラーサイズを再計算する
 */
export function updateViewportSize() {
  if (!renderer) return;

  const canvas = renderer.domElement;
  const { width: w, height: h } = getCanvasDisplaySize(canvas);
  const aspect = w / h;

  // PerspectiveCamera の更新。既存3DビューのFOV/位置は変更しない。
  if (camera && camera.aspect !== undefined) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  }

  // OrthographicCamera は共通Projectionへ委譲し、現在の表示高さを維持してaspectだけ更新する。
  if (orthographicCamera) {
    resizeOrthographicFrustum(orthographicCamera, aspect);
  }

  renderer.setSize(w, h, false);
  requestRender();
}

/**
 * ビューポートリサイズハンドラーを設定
 * PerspectiveCameraとOrthographicCameraの両方に対応
 * @param {THREE.Camera} _defaultCamera - デフォルトカメラ（後方互換性のため）
 */
export function setupViewportResizeHandler(_defaultCamera) {
  if (!viewportResizeController) {
    viewportResizeController = new ViewportResizeController({
      getCanvas: () => renderer?.domElement || null,
      isBlocked: () => _xrSessionActive || renderer?.xr?.isPresenting === true,
      onResize: updateViewportSize,
    });
  }
  viewportResizeController.start();
}

/**
 * Viewer runtimeが登録した副作用を解除する。
 * テスト、SPA再初期化、将来の複数Viewer化で同じlistener/loopを残さないための明示的な終了点。
 * @param {{disposeRenderer?: boolean}} [options]
 */
export function disposeViewerRuntime(options = {}) {
  const { disposeRenderer = false } = options;

  animationLoopController.stop();
  viewportResizeController?.dispose();
  viewportResizeController = null;

  detachControlsChangeListener(controls);
  controls?.dispose?.();
  if (typeof window !== 'undefined' && window.controls === controls) {
    delete window.controls;
  }
  controls = null;

  if (disposeRenderer && renderer) {
    renderer.dispose?.();
    renderer = null;
  }

  animationScene = null;
  animationCameraOverride = null;
  cullingFrameCounter = 0;
  renderRequested = true;
}
