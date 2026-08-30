/**
 * @fileoverview ユーザーインタラクション処理モジュール
 *
 * このファイルは、3Dビューワーでのユーザー操作に関する機能を提供します:
 * - マウスによる要素選択と強調表示
 * - 選択要素の情報表示
 * - 要素のハイライト処理
 * - 選択状態のリセット
 *
 * このモジュールは、Three.jsのレイキャスト機能を利用して、
 * ユーザーがクリックした3D要素を特定し、適切な情報表示を行います。
 */

import * as THREE from 'three';
import { createLogger, WarnCategory } from '../../utils/logger.js';

const logger = createLogger('interaction');
import {
  scene,
  camera,
  getActiveCamera,
  renderer,
  controls,
  elementGroups,
  getBatchElementCenter,
} from '../../viewer/index.js';
import { getState } from '../../data/state/globalState.js';
import { eventBus, InteractionEvents, ToastEvents } from '../../data/events/index.js';
import { CAMERA_CONTROLS } from '../../config/renderingConstants.js';
import {
  createOrUpdateOrbitCenterHelper,
  hideOrbitCenterHelper,
} from './interaction/orbitCenterHelper.js';
import {
  getElementIds,
  normalizeSelectedElementType,
  normalizeSelectionModelSide,
  resolveTwoObjectComparisonTarget,
} from './interaction/selectionInfoUtils.js';
import { applyHighlightMaterial } from './interaction/selectionHighlight.js';
import { createSelectionService } from './interaction/selectionService.js';
import {
  createSelectionCandidateSession,
  getNextSelectionCandidateIndex,
} from './interaction/selectionCandidateSession.js';
import {
  syncMeasurementHoverPreview,
  clearMeasurementHoverPreview,
  hasMeasurementHoverPreview,
} from './interaction/measurementHover.js';
import { handleContextMenu } from './interaction/contextMenu3D.js';

// 分割モジュールの公開APIを従来通り本モジュールから提供する
export {
  createOrUpdateOrbitCenterHelper,
  getNextSelectionCandidateIndex,
  hideOrbitCenterHelper,
  resolveTwoObjectComparisonTarget,
};

// レイキャスト用オブジェクト
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

/** common/viewerモードが有効でアダプターが利用可能かを返す */
function isCommonViewerReady() {
  return getState('viewer.useCommonViewer') && !!getState('viewer.adapter');
}

let interactionScheduleRender = null;
let isInteractionListenersBound = false;
let boundInteractionCanvasElement = null;
/** @type {(event: MouseEvent) => void | null} */
let handleCanvasMouseEnterRef = null;
/** @type {(event: MouseEvent) => void | null} */
let handleCanvasMouseMoveRef = null;
/** @type {() => void | null} */
let handleCanvasMouseLeaveRef = null;
/** @type {(event: MouseEvent) => void | null} */
let handleCanvasClickRef = null;
/** @type {(event: PointerEvent) => void | null} */
let handleCanvasContextMenuRef = null;
/** @type {(event: MouseEvent) => void | null} */
let handleWindowMouseMoveRef = null;
/** @type {() => void | null} */
let handleWindowMouseUpRef = null;
/** @type {(event: KeyboardEvent) => void | null} */
let handleWindowKeyDownRef = null;
/** @type {() => void | null} */
let handleWindowBlurRef = null;
/** @type {(event: MouseEvent) => void | null} */
let handleCanvasMouseDownRef = null;
/** @type {() => void | null} */
let handleControlsEndRef = null;
// Tab選択サイクリングの候補数上限（安定性のため）
const MAX_SELECTION_CANDIDATES = 10;

// ホバー時のレイキャストのスロットリング間隔（ms）
const HOVER_RAYCAST_INTERVAL_MS = 50;
let lastHoverRaycastTime = 0;

const selectionCandidateSession = createSelectionCandidateSession({
  collectCandidates: collectSelectionCandidates,
  raycast: performRaycast,
  applyPreview: (candidate) => applyHighlightMaterial(candidate, 'selectionCandidate'),
  restorePreview: (candidate, material) => {
    candidate.material = material;
  },
  render: () => interactionScheduleRender?.(),
  showCandidate: ({ message }) => {
    eventBus.emit(ToastEvents.SHOW_INFO, {
      message,
      options: { duration: 1500, closable: false },
    });
  },
  formatCandidateMessage: buildPendingSelectionCandidateMessage,
  onPreviewRestoreError: (error) =>
    logger.warn(`${WarnCategory.UI} 選択候補プレビュー復元に失敗`, error),
});

// controls は viewer/index.js のライブバインディング。Proxy を挟まず直接渡すと
// selectionService 生成時点の値（未初期化の可能性）でスナップショットされるため、
// アクセスのたびに現在の controls を遅延参照する。
const dynamicControls = new Proxy(
  {},
  {
    get(_target, property) {
      const value = controls?.[property];
      return typeof value === 'function' ? value.bind(controls) : value;
    },
  },
);

const selectionService = createSelectionService({
  eventBus,
  getAdapter: () => (isCommonViewerReady() ? getState('viewer.adapter') : null),
  controls: dynamicControls,
  applyHighlightMaterial,
  getBatchElementCenter,
  createOrUpdateOrbitCenterHelper,
  hideOrbitCenterHelper,
  clearPendingSelection: () => {
    selectionCandidateSession.clearPreview();
    selectionCandidateSession.clearCandidates();
    selectionCandidateSession.cancelQueuedCycle();
  },
  logger: {
    warn: (message, error) => logger.warn(`${WarnCategory.UI} ${message}`, error),
  },
});

export const getSelectedCenter = () => selectionService.getSelectedCenter();
export const getSelectedObjects = () => selectionService.getSelectedObjects();
export const resetSelection = (scheduleRender) => selectionService.resetSelection(scheduleRender);
export const selectElement3D = (obj, scheduleRender, options = {}) =>
  selectionService.selectElement3D(obj, scheduleRender, options);
export const selectMultipleElements3D = (objects, scheduleRender, options = {}) =>
  selectionService.selectMultipleElements3D(objects, scheduleRender, options);

/**
 * interactionManager向けに依存性注入で使用する操作ハンドラを返す
 * @returns {Object} interactionManagerに渡すサービス群
 */
export function getInteractionManagerServices() {
  return {
    getSelectedCenter,
    getSelectedObjects,
    createOrUpdateOrbitCenterHelper,
    hideOrbitCenterHelper,
    resetSelection,
  };
}

// 左ボタン押下中かどうか
let isPointerDownLeft = false;
// ドラッグ開始判定用の押下座標
const pointerDownPos = { x: 0, y: 0 };
// このドラッグ中に適用済みか
let appliedThisDrag = false;
// 右ボタン押下中かどうか
let isPointerDownRight = false;
// 右クリックドラッグ開始判定用の押下座標
const rightPointerDownPos = { x: 0, y: 0 };
// 右クリックドラッグが発生したか（contextmenu 抑制用）
let appliedThisRightDrag = false;
// ドラッグ判定のピクセル閾値
const DRAG_APPLY_THRESHOLD_PX = CAMERA_CONTROLS.DRAG_THRESHOLD_PX;

function handleInteractionCanvasMouseEnter(event) {
  if (!interactionScheduleRender) {
    return;
  }

  selectionCandidateSession.updatePointer(event);
  selectionCandidateSession.refresh(null, event);
  selectionCandidateSession.syncPreview();
}

function handleInteractionCanvasMouseMove(event) {
  if (!interactionScheduleRender) {
    return;
  }

  selectionCandidateSession.updatePointer(event);
  const now = performance.now();
  if (now - lastHoverRaycastTime < HOVER_RAYCAST_INTERVAL_MS) {
    return;
  }

  lastHoverRaycastTime = now;

  if (getMeasurementModeActive && getMeasurementModeActive()) {
    const intersects = performRaycast(selectionCandidateSession.getState().pointer) || [];
    const hit = intersects.find((i) => i.object?.userData?.elementType !== 'Measurement');
    syncMeasurementHoverPreview(hit?.object || null, getMeasurementStep, interactionScheduleRender);
    return;
  }

  // 測定モード解除直後にhoverが残らないようクリア
  if (hasMeasurementHoverPreview()) clearMeasurementHoverPreview();

  selectionCandidateSession.refresh(null, event);
  selectionCandidateSession.syncPreview();
}

function handleInteractionCanvasMouseLeave() {
  if (!interactionScheduleRender) {
    return;
  }

  selectionCandidateSession.setPointerInsideCanvas(false);
  clearMeasurementHoverPreview();
  selectionCandidateSession.clear();
}

function handleInteractionCanvasClick(event) {
  if (!interactionScheduleRender) {
    return;
  }

  // mousedown からの移動距離が閾値以上の場合はドラッグ操作なので選択・測定をスキップ
  // （mouseup 後に click が発火するため appliedThisDrag は使えない）
  const clickDx = event.clientX - pointerDownPos.x;
  const clickDy = event.clientY - pointerDownPos.y;
  if (Math.hypot(clickDx, clickDy) >= DRAG_APPLY_THRESHOLD_PX) {
    return;
  }

  // 節点ピックモード中: クリックで節点を1つ拾って NODE_PICKED を発行し、通常の選択処理は抑止する。
  // 節点以外がヒットした場合は無視してモードを継続する（AddMemberForm 等が購読）。
  // バッチ描画（InstancedMesh）の節点は intersect.instanceId から個別 userData を解決する。
  if (getState('ui.nodePick')?.active) {
    const pickIntersects = performRaycast(event) || [];
    for (const intersect of pickIntersects) {
      const obj = intersect.object;
      const baseType = obj?.userData?.elementType || obj?.userData?.stbNodeType;
      if (baseType !== 'Node') continue;
      // 非表示の節点グループ・クリップ範囲外はピック対象外（通常選択と同じ可視性条件）
      if (!obj.visible || !elementGroups.Node?.visible || isPointClipped(intersect.point)) continue;

      const ud =
        obj.userData.isInstanced &&
        Array.isArray(obj.userData.instances) &&
        intersect.instanceId != null
          ? obj.userData.instances[intersect.instanceId]
          : obj.userData;
      const { idA, idB } = getElementIds(ud || {});
      const nodeId = idA || idB;
      if (nodeId) {
        eventBus.emit(InteractionEvents.NODE_PICKED, {
          nodeId,
          idA,
          idB,
          modelSource: ud?.modelSource,
        });
      }
      break;
    }
    return;
  }

  if (getMeasurementModeActive && getMeasurementModeActive()) {
    clearMeasurementHoverPreview();
    const intersects = performRaycast(event);
    if (intersects && intersects.length > 0) {
      const hit = intersects.find((i) => i.object?.userData?.elementType !== 'Measurement');
      if (hit && dispatchToMeasurementManager) {
        dispatchToMeasurementManager(hit);
      }
    }
    return;
  }

  processElementSelection(event, interactionScheduleRender);
}

function handleInteractionCanvasContextMenu(event) {
  if (!interactionScheduleRender) {
    return;
  }

  event.preventDefault();

  // 右クリックドラッグ（カメラ操作）後はメニューを表示しない
  if (appliedThisRightDrag) {
    appliedThisRightDrag = false;
    return;
  }
  appliedThisRightDrag = false;

  handleContextMenu(event, interactionScheduleRender, {
    performRaycast,
    getSelectedObjects,
    resetSelection,
    selectElement3D,
    getContextMenuActionCallback: () => contextMenuActionCallback,
  });
}

function handleInteractionCanvasMouseDown(event) {
  if (!interactionScheduleRender) {
    return;
  }

  if (event.button === 0) {
    isPointerDownLeft = true;
    appliedThisDrag = false;
    pointerDownPos.x = event.clientX;
    pointerDownPos.y = event.clientY;
  } else if (event.button === 2) {
    isPointerDownRight = true;
    appliedThisRightDrag = false;
    rightPointerDownPos.x = event.clientX;
    rightPointerDownPos.y = event.clientY;
  }
}

function handleInteractionWindowMouseMove(event) {
  if (!interactionScheduleRender) {
    return;
  }

  if (isPointerDownLeft && !appliedThisDrag) {
    const dx = event.clientX - pointerDownPos.x;
    const dy = event.clientY - pointerDownPos.y;
    if (Math.hypot(dx, dy) >= DRAG_APPLY_THRESHOLD_PX) {
      appliedThisDrag = true;
      if (interactionScheduleRender) {
        interactionScheduleRender();
      }
    }
  }

  if (isPointerDownRight && !appliedThisRightDrag) {
    const dx = event.clientX - rightPointerDownPos.x;
    const dy = event.clientY - rightPointerDownPos.y;
    if (Math.hypot(dx, dy) >= DRAG_APPLY_THRESHOLD_PX) {
      appliedThisRightDrag = true;
    }
  }
}

function handleInteractionWindowMouseUp(event) {
  if (event.button === 0) {
    isPointerDownLeft = false;
    appliedThisDrag = false;
  } else if (event.button === 2) {
    isPointerDownRight = false;
    // appliedThisRightDrag は contextmenu ハンドラーが使うため、そこでリセット
  }
}

function handleInteractionWindowKeyDown(event) {
  selectionCandidateSession.handleKeyDown(event);
}

function handleInteractionWindowBlur() {
  if (!interactionScheduleRender) {
    return;
  }

  selectionCandidateSession.clear();
}

function clearInteractionListeners() {
  selectionCandidateSession.clear();
  if (!isInteractionListenersBound) {
    return;
  }

  if (boundInteractionCanvasElement) {
    if (handleCanvasMouseEnterRef) {
      boundInteractionCanvasElement.removeEventListener(
        'mouseenter',
        handleCanvasMouseEnterRef,
        false,
      );
      boundInteractionCanvasElement.removeEventListener(
        'mousemove',
        handleCanvasMouseMoveRef,
        false,
      );
      boundInteractionCanvasElement.removeEventListener(
        'mouseleave',
        handleCanvasMouseLeaveRef,
        false,
      );
      boundInteractionCanvasElement.removeEventListener('click', handleCanvasClickRef, false);
      boundInteractionCanvasElement.removeEventListener(
        'contextmenu',
        handleCanvasContextMenuRef,
        false,
      );
      boundInteractionCanvasElement.removeEventListener(
        'mousedown',
        handleCanvasMouseDownRef,
        false,
      );
    }
  }

  if (handleWindowMouseMoveRef) {
    window.removeEventListener('mousemove', handleWindowMouseMoveRef, false);
  }
  if (handleWindowMouseUpRef) {
    window.removeEventListener('mouseup', handleWindowMouseUpRef, false);
  }
  if (handleWindowKeyDownRef) {
    window.removeEventListener('keydown', handleWindowKeyDownRef, true);
  }
  if (handleWindowBlurRef) {
    window.removeEventListener('blur', handleWindowBlurRef, false);
  }
  if (controls && typeof controls.removeEventListener === 'function' && handleControlsEndRef) {
    controls.removeEventListener('end', handleControlsEndRef);
  }

  isInteractionListenersBound = false;
  boundInteractionCanvasElement = null;
  handleCanvasMouseEnterRef = null;
  handleCanvasMouseMoveRef = null;
  handleCanvasMouseLeaveRef = null;
  handleCanvasClickRef = null;
  handleCanvasContextMenuRef = null;
  handleWindowMouseMoveRef = null;
  handleWindowMouseUpRef = null;
  handleWindowKeyDownRef = null;
  handleWindowBlurRef = null;
  handleCanvasMouseDownRef = null;
  handleControlsEndRef = null;
  interactionScheduleRender = null;
}

/**
 * レイキャストを実行して交差オブジェクトを取得
 * @param {Event} event - マウスイベント
 * @returns {THREE.Intersection[]|null} 交差結果の配列、キャンバスが見つからない場合はnull
 */
function performRaycast(event) {
  const canvas = document.getElementById('three-canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();

  // マウス座標を正規化デバイス座標 (-1 to +1) に変換
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, getActiveCamera() || camera);

  return raycaster.intersectObjects(scene.children, true);
}

export function collectSelectionCandidates(intersects, options = {}) {
  const { includeAxisStory = true } = options;
  const lineCandidates = [];
  const meshOrSpriteCandidates = [];
  const axisOrStoryCandidates = [];
  const seenObjects = new Set();

  for (const intersect of Array.isArray(intersects) ? intersects : []) {
    const obj = intersect?.object;
    const userData = obj?.userData;
    const elementType = userData?.elementType || userData?.stbNodeType;
    const groupVisible = elementType ? elementGroups[elementType]?.visible : false;

    if (!obj || !elementType || !groupVisible || !obj.visible || isPointClipped(intersect?.point)) {
      continue;
    }
    if (seenObjects.has(obj)) {
      continue;
    }
    seenObjects.add(obj);

    const isAxisOrStory = elementType === 'Axis' || elementType === 'Story';
    if (isAxisOrStory) {
      if (includeAxisStory) {
        axisOrStoryCandidates.push(obj);
      }
      continue;
    }

    if (obj instanceof THREE.Line) {
      lineCandidates.push(obj);
    } else if (obj instanceof THREE.Mesh || obj instanceof THREE.Sprite) {
      meshOrSpriteCandidates.push(obj);
    }
  }

  const merged = [...lineCandidates, ...meshOrSpriteCandidates, ...axisOrStoryCandidates];
  return merged.length > MAX_SELECTION_CANDIDATES
    ? merged.slice(0, MAX_SELECTION_CANDIDATES)
    : merged;
}

/**
 * 交差点がレンダラーのクリッピング平面によって切り取られているか判定する
 * @param {THREE.Vector3} point - 交差点のワールド座標
 * @returns {boolean} クリップされている（不可視）場合 true
 */
function isPointClipped(point) {
  if (!renderer || !renderer.localClippingEnabled) return false;
  const planes = renderer.clippingPlanes;
  if (!planes || planes.length === 0) return false;
  for (const plane of planes) {
    if (plane.distanceToPoint(point) < 0) return true;
  }
  return false;
}

/**
 * 交差結果から優先度に基づいて最適なオブジェクトを選択
 * 優先順位: 線要素 > 面要素 > Axis/Story
 * @param {THREE.Intersection[]} intersects - レイキャストの交差結果
 * @returns {THREE.Object3D|null} 選択すべきオブジェクト
 */
function findBestIntersection(intersects) {
  return collectSelectionCandidates(intersects, { includeAxisStory: false })[0] || null;
}

function buildPendingSelectionCandidateMessage(candidate, candidateIndex, candidateCount) {
  const userData = candidate?.userData || {};
  const elementType =
    normalizeSelectedElementType(userData) ||
    userData.elementType ||
    userData.stbNodeType ||
    'Unknown';
  const { idA, idB } = getElementIds(userData);
  const elementId = idA || idB || userData.elementId || userData.id || '-';
  const modelSource =
    userData.modelSource === 'matched'
      ? 'A/B'
      : normalizeSelectionModelSide(userData.modelSource) || userData.modelSource || '-';

  return `選択候補 ${candidateIndex + 1}/${candidateCount}: ${elementType} ${elementId} [${modelSource}]`;
}

export function cyclePendingSelectionCandidate(options = {}, scheduleRender = null) {
  if (scheduleRender) interactionScheduleRender = scheduleRender;
  return selectionCandidateSession.cycle(options);
}

/**
 * クリックイベント処理関数（複数選択対応）
 * @param {Event} event - マウスイベント
 * @param {Function} scheduleRender - 再描画要求関数
 */
function processElementSelection(event, scheduleRender) {
  event.preventDefault();
  selectionCandidateSession.updatePointer(event);

  const intersects = performRaycast(event);
  if (!intersects) return;

  // Ctrlキーが押されているか確認（複数選択モード）
  const isMultiSelectMode = event.ctrlKey || event.metaKey;

  // Ctrlなしの場合は既存の選択を解除
  if (!isMultiSelectMode) {
    resetSelection(scheduleRender);
  }

  // プレ選択候補がある場合は現在の候補を使用、なければレイキャストから取得
  const candidates = selectionCandidateSession.refresh(intersects, event);
  const { currentCandidate } = selectionCandidateSession.getState();
  const objectToSelect =
    candidates.length > 0 ? currentCandidate || candidates[0] : findBestIntersection(intersects);

  // クリック確定後はプレビュー状態と候補をクリア
  selectionCandidateSession.clear();

  if (objectToSelect && objectToSelect.userData) {
    const userData = objectToSelect.userData;
    const elementType = userData.elementType || userData.stbNodeType;

    // Axis と Story 以外の場合のみハイライト処理を実行
    if (elementType && elementType !== 'Axis' && elementType !== 'Story') {
      if (isMultiSelectMode) {
        selectionService.toggleObject(objectToSelect);
      } else {
        selectionService.highlightObject(objectToSelect);
      }

      selectionService.updateOrbitCenter();
      selectionService.showElementInfo();
    } else if (elementType === 'Axis' || elementType === 'Story') {
      // Axis/Story がクリックされた場合: ハイライトせず、情報パネルをクリア
      if (!isMultiSelectMode) {
        selectionService.clearElementInfoPanel();
      }
    }
  } else if (!isMultiSelectMode) {
    // 何もない場所をクリック（Ctrlなし）→ 選択解除は既に実行済み
    // 情報パネルのクリアのみ
    if (getSelectedObjects().length === 0) {
      selectionService.clearElementInfoPanel();
    }
  }

  // 再描画要求
  if (scheduleRender) scheduleRender();
}

/** @type {Function|null} */
let contextMenuActionCallback = null;
/** @type {Function|null} */
let getMeasurementModeActive = null;
/** @type {Function|null} */
let dispatchToMeasurementManager = null;
/** @type {Function|null} 現在のステップ（'idle'|'firstPicked'）を返す */
let getMeasurementStep = null;

/**
 * インタラクションイベントリスナーを設定
 * @param {Function} scheduleRender - 再描画要求関数
 * @param {Object} [options] - オプション
 * @param {Function} [options.onContextMenuAction] - コンテキストメニューアクションのコールバック
 * @param {Function} [options.getMeasurementModeActive] - 測定モード判定関数
 * @param {Function} [options.dispatchToMeasurementManager] - 測定クリック委譲関数
 * @param {Function} [options.getMeasurementStep] - 現在の測定ステップを返す関数
 */
export function setupInteractionListeners(scheduleRender, options = {}) {
  clearInteractionListeners();
  interactionScheduleRender = scheduleRender;
  contextMenuActionCallback = options.onContextMenuAction || null;
  getMeasurementModeActive = options.getMeasurementModeActive || null;
  dispatchToMeasurementManager = options.dispatchToMeasurementManager || null;
  getMeasurementStep = options.getMeasurementStep || null;

  // コンテキストメニューを初期化
  eventBus.emit(InteractionEvents.INIT_CONTEXT_MENU);

  const canvasElement = document.getElementById('three-canvas');
  if (!canvasElement) {
    logger.error('Canvas element not found for click listener.');
    return;
  }

  handleCanvasMouseEnterRef = handleInteractionCanvasMouseEnter;
  handleCanvasMouseMoveRef = handleInteractionCanvasMouseMove;
  handleCanvasMouseLeaveRef = handleInteractionCanvasMouseLeave;
  handleCanvasClickRef = handleInteractionCanvasClick;
  handleCanvasContextMenuRef = handleInteractionCanvasContextMenu;
  handleCanvasMouseDownRef = handleInteractionCanvasMouseDown;
  handleWindowMouseMoveRef = handleInteractionWindowMouseMove;
  handleWindowMouseUpRef = handleInteractionWindowMouseUp;
  handleWindowKeyDownRef = handleInteractionWindowKeyDown;
  handleWindowBlurRef = handleInteractionWindowBlur;

  canvasElement.addEventListener('mouseenter', handleCanvasMouseEnterRef, false);
  canvasElement.addEventListener('mousemove', handleCanvasMouseMoveRef, false);
  canvasElement.addEventListener('mouseleave', handleCanvasMouseLeaveRef, false);
  canvasElement.addEventListener('click', handleCanvasClickRef, false);
  canvasElement.addEventListener('contextmenu', handleCanvasContextMenuRef, false);
  canvasElement.addEventListener('mousedown', handleCanvasMouseDownRef, false);

  window.addEventListener('mousemove', handleWindowMouseMoveRef, false);
  window.addEventListener('mouseup', handleWindowMouseUpRef, false);
  // キャプチャフェーズで登録: ブラウザのTab移動処理より先にpreventDefaultが確実に効き、
  // 大量のフォーカス可能要素がある場合のフリーズを防ぐ
  window.addEventListener('keydown', handleWindowKeyDownRef, true);
  window.addEventListener('blur', handleWindowBlurRef, false);

  if (controls && typeof controls.addEventListener === 'function') {
    handleControlsEndRef = () => {
      appliedThisDrag = false;
      appliedThisRightDrag = false;
    };
    controls.addEventListener('end', handleControlsEndRef);
  }

  isInteractionListenersBound = true;
  boundInteractionCanvasElement = canvasElement;
}

// コンテキストメニュー処理は interaction/contextMenu3D.js に分離。
// 選択状態・レイキャストへのアクセスは handleInteractionCanvasContextMenu で
// deps として注入する。
