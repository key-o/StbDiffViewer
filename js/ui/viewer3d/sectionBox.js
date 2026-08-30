/**
 * @fileoverview セクションボックスUI統合モジュール
 *
 * セクションボックスのトグル制御と既存クリッピングとの連携を管理する。
 * Renderable再生成後のclipping/stencil同期もこの境界で行う。
 *
 * @module ui/viewer3d/sectionBox
 */

import * as THREE from 'three';
import {
  scene,
  getActiveCamera,
  renderer,
  controls,
  getModelBounds,
  getCameraContext,
  getCameraMode,
  elementGroups,
  LifecycleSectionBox,
} from '../../viewer/index.js';
import { RenderableLifecycleEvents } from '../../constants/renderableLifecycleEvents.js';
import { scheduleRender } from '../../utils/renderScheduler.js';
import { showWarning } from '../common/toast.js';
import { createLogger } from '../../utils/logger.js';
import { eventBus } from '../../data/events/eventBus.js';
import {
  FinalizationEvents,
  ModelEvents,
  ViewEvents,
} from '../../constants/eventTypes.js';
import { CAMERA_CONTEXTS, CAMERA_MODES } from '../../constants/displayModes.js';
import { resolveDrawingDepthAxis } from './sectionBoxHandleVisibility.js';

const log = createLogger('ui:sectionBox');

/** @type {LifecycleSectionBox|null} */
let sectionBoxInstance = null;
let lifecycleSyncQueued = false;
let listenersInitialized = false;
let currentViewDirection = null;

function createSectionBoxInstance() {
  return new LifecycleSectionBox(
    scene,
    () => getActiveCamera(),
    renderer,
    renderer.domElement,
    controls,
    // ClippingはScene全体へ適用する。elementGroups外にあるGridHelper等も
    // 3D空間上の位置がSectionBox外なら描画させない。
    () => scene,
    // StencilCapは構造要素だけを入力とし、GridHelperや計測補助線を断面生成へ混ぜない。
    () => elementGroups,
  );
}

/**
 * Geometry/Materialのバッチ更新後にSectionBox状態を1回だけ同期する。
 * 複数イベントが同一tickで発生してもStencil再生成を重複させない。
 */
function queueSectionBoxLifecycleSync() {
  if (lifecycleSyncQueued) return;
  lifecycleSyncQueued = true;

  globalThis.queueMicrotask(() => {
    lifecycleSyncQueued = false;
    if (!sectionBoxInstance?.isActive()) return;
    sectionBoxInstance.syncRenderables();
    scheduleRender();
  });
}

/**
 * セクションボックスのON/OFFを切り替える
 */
export function toggleSectionBox() {
  if (sectionBoxInstance && sectionBoxInstance.isActive()) {
    deactivateSectionBox();
    return;
  }

  const modelBounds = getModelBounds();
  if (!modelBounds || modelBounds.isEmpty()) {
    showWarning('モデルが読み込まれていません');
    return;
  }

  // 通常クリッピングはClippingStateManager側で保持する。
  // SectionBox開始時にclearしないことで、解除時に元状態へ復帰できる。

  // モデル範囲に5%のマージンを追加
  const size = modelBounds.getSize(new THREE.Vector3());
  const margin = size.multiplyScalar(0.05);
  const expandedBox = modelBounds.clone();
  expandedBox.min.sub(margin);
  expandedBox.max.add(margin);

  sectionBoxInstance = createSectionBoxInstance();
  sectionBoxInstance.activate(expandedBox);
  updateDepthHandleVisibility();

  updateToggleButtonState(true);
  updateHintVisibility(true);

  scheduleRender();
  log.info('Section box activated via UI');
}

/**
 * セクションボックスを解除する
 */
export function deactivateSectionBox() {
  if (sectionBoxInstance) {
    sectionBoxInstance.deactivate();
    sectionBoxInstance.dispose();
    sectionBoxInstance = null;
  }

  updateToggleButtonState(false);
  updateHintVisibility(false);

  scheduleRender();
  log.info('Section box deactivated via UI');
}

/**
 * クリッピング範囲データからセクションボックスを起動する
 *
 * 階クリップの場合はZ方向のみ、軸クリップの場合はX/Y方向のみを制限し、
 * その他の方向はモデル全体の範囲を使用する。
 *
 * @param {Object} boundsData - getStoryClipBounds / getAxisClipBounds の戻り値
 */
export function activateSectionBoxForBounds(boundsData) {
  const modelBounds = getModelBounds();
  if (!modelBounds || modelBounds.isEmpty()) {
    showWarning('モデルが読み込まれていません');
    return;
  }

  // モデル全体の範囲をベースにクリッピング方向のみ上書き
  const box3 = modelBounds.clone();

  if (boundsData.type === 'story') {
    box3.min.z = boundsData.lowerBound;
    box3.max.z = boundsData.upperBound;
  } else if (boundsData.type === 'axis') {
    if (boundsData.axisType === 'X') {
      box3.min.x = boundsData.lowerBound;
      box3.max.x = boundsData.upperBound;
    } else if (boundsData.axisType === 'Y') {
      box3.min.y = boundsData.lowerBound;
      box3.max.y = boundsData.upperBound;
    }
  }

  // 既存インスタンスがある場合は範囲のみ更新（再生成コストを避ける）。
  // updateBox()はhandle geometryを再生成するため、図面表示の奥行きhandle非表示も再適用する。
  if (sectionBoxInstance && sectionBoxInstance.isActive()) {
    sectionBoxInstance.updateBox(box3);
    updateDepthHandleVisibility();
    scheduleRender();
    log.info('Section box updated for bounds', boundsData.type);
    return;
  }

  // 新規作成
  if (sectionBoxInstance) {
    sectionBoxInstance.dispose();
    sectionBoxInstance = null;
  }

  sectionBoxInstance = createSectionBoxInstance();
  sectionBoxInstance.activate(box3);
  updateDepthHandleVisibility();

  updateToggleButtonState(true);
  updateHintVisibility(true);

  scheduleRender();
  log.info('Section box activated for bounds', boundsData.type);
}

/**
 * 指定したバウンディングボックスでセクションボックスを起動する
 *
 * 選択要素のバウンディングボックスなど、任意のBox3を渡してセクションボックスを適用する。
 * ボックスの各方向に10%のマージンを追加する。
 *
 * @param {THREE.Box3} box3 - セクションボックスの範囲
 */
export function activateSectionBoxForBox(box3) {
  if (!box3 || box3.isEmpty()) {
    showWarning('バウンディングボックスが空です');
    return;
  }

  // マージンを追加（各方向に10%）
  const size = box3.getSize(new THREE.Vector3());
  const margin = size.multiplyScalar(0.1);
  // 最小マージンを保証（小さい部材でも操作しやすいように）
  const MIN_MARGIN = 500; // 500mm
  margin.x = Math.max(margin.x, MIN_MARGIN);
  margin.y = Math.max(margin.y, MIN_MARGIN);
  margin.z = Math.max(margin.z, MIN_MARGIN);

  const expandedBox = box3.clone();
  expandedBox.min.sub(margin);
  expandedBox.max.add(margin);

  // 既存インスタンスがある場合は範囲のみ更新。
  // updateBox()でhandleが再生成されるため、現在の図面方向に応じた非表示も再適用する。
  if (sectionBoxInstance && sectionBoxInstance.isActive()) {
    sectionBoxInstance.updateBox(expandedBox);
    updateDepthHandleVisibility();
    scheduleRender();
    log.info('Section box updated for selection');
    return;
  }

  // 新規作成
  if (sectionBoxInstance) {
    sectionBoxInstance.dispose();
    sectionBoxInstance = null;
  }

  sectionBoxInstance = createSectionBoxInstance();
  sectionBoxInstance.activate(expandedBox);
  updateDepthHandleVisibility();

  updateToggleButtonState(true);
  updateHintVisibility(true);

  scheduleRender();
  log.info('Section box activated for selection');
}

/**
 * セクションボックスがアクティブかどうか
 * @returns {boolean}
 */
export function isSectionBoxActive() {
  return sectionBoxInstance !== null && sectionBoxInstance.isActive();
}

/**
 * トグルボタンの表示状態を更新する
 * @param {boolean} active
 */
function updateToggleButtonState(active) {
  const btn = document.getElementById('toggleSectionBoxButton');
  if (!btn) return;

  if (active) {
    btn.classList.add('active');
    btn.textContent = 'セクションボックス解除';
  } else {
    btn.classList.remove('active');
    btn.textContent = 'セクションボックス';
  }
}

/**
 * ヒントテキストの表示/非表示を切り替える
 * @param {boolean} visible
 */
function updateHintVisibility(visible) {
  const hint = document.getElementById('sectionBoxHint');
  if (!hint) return;

  if (visible) {
    hint.classList.remove('hidden');
  } else {
    hint.classList.add('hidden');
  }
}

function getCameraDirection() {
  const camera = getActiveCamera();
  if (!camera) return null;
  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction);
  return direction;
}

/**
 * 図面表示（正投影）では、画面奥行きと平行なSectionBoxハンドルは
 * 画面上のドラッグで変位を決められないため非表示にする。
 *
 * Top/Bottom: Z、Front/Back: Y、Right/Left: X を隠す。
 * Iso/斜めビューでは単一world axisが奥行きにならないため全ハンドルを表示する。
 * viewTypeが未通知の初期化経路では実カメラ方向からaxis-alignedの場合だけfallback判定する。
 *
 * @param {string} [mode]
 * @param {string} [context]
 * @param {string|null} [viewType]
 */
function updateDepthHandleVisibility(
  mode = getCameraMode(),
  context = getCameraContext(),
  viewType = currentViewDirection,
) {
  if (!sectionBoxInstance || !sectionBoxInstance.isActive()) return;

  // 3D/立体表示へ戻した場合を含め、まず全方向を操作可能状態へ戻す。
  for (const axis of ['x', 'y', 'z']) {
    sectionBoxInstance.setHandleVisibilityByAxis(axis, true);
  }

  const isDrawingOrthographic =
    mode === CAMERA_MODES.ORTHOGRAPHIC && context === CAMERA_CONTEXTS.DRAWING;

  if (isDrawingOrthographic) {
    const depthAxis = resolveDrawingDepthAxis(viewType, getCameraDirection());
    if (depthAxis) {
      sectionBoxInstance.setHandleVisibilityByAxis(depthAxis, false);
    }
  }

  scheduleRender();
}

/**
 * セクションボックスのイベントリスナーを初期化する
 */
export function initSectionBoxEventListeners() {
  if (listenersInitialized) return;
  listenersInitialized = true;

  eventBus.on(ViewEvents.CAMERA_MODE_CHANGED, ({ mode, context }) => {
    updateDepthHandleVisibility(mode, context);
  });

  eventBus.on(ViewEvents.VIEW_DIRECTION_CHANGED, ({ viewType }) => {
    currentViewDirection = viewType ?? null;
    updateDepthHandleVisibility(undefined, undefined, currentViewDirection);
  });

  // group再生成完了単位のGeometryChangedを購読する。
  eventBus.on(RenderableLifecycleEvents.GEOMETRY_CHANGED, queueSectionBoxLifecycleSync);

  // Material差替えが同期・非同期を問わず完了した時点でStencil/Capを再構築する。
  // COLOR_MODE_CHANGEDはUI状態通知として扱い、SectionBoxの完了判定には使用しない。
  eventBus.on(RenderableLifecycleEvents.MATERIALS_CHANGED, queueSectionBoxLifecycleSync);

  // モデル最終化後はMesh集合が入れ替わるため、現在のRenderable集合から
  // clipping/stencilを再構築する。
  eventBus.on(FinalizationEvents.COMPLETED, queueSectionBoxLifecycleSync);

  // モデルclear時に旧geometryを参照するStencilを残さない。
  eventBus.on(ModelEvents.CLEARED, () => {
    if (sectionBoxInstance?.isActive()) {
      deactivateSectionBox();
    }
  });
}
