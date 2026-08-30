/**
 * @fileoverview 3D要素の選択状態と選択通知を管理するサービス
 */

import * as THREE from 'three';

import { InteractionEvents, SelectionEvents } from '../../../constants/eventTypes.js';
import {
  buildMultiSelectionSummaryData,
  findSelectableAncestor,
  getElementIds,
  normalizeSelectedElementType,
  resolveTwoObjectComparisonTarget,
} from './selectionInfoUtils.js';

const DEFAULT_MAX_SELECTION_COUNT = 100;

const EMPTY_INFO_PAYLOAD = Object.freeze({
  idA: null,
  idB: null,
  elementType: null,
  modelSource: null,
});

/**
 * 選択サービスを生成する。
 * viewer固有処理は依存注入し、このモジュールからcontrollerへ逆依存させない。
 *
 * @param {Object} dependencies
 * @returns {Object}
 */
export function createSelectionService(dependencies = {}) {
  const {
    eventBus = { emit() {} },
    getAdapter = () => null,
    render = null,
    clock = () => Date.now(),
    logger = { warn() {} },
    controls = null,
    applyHighlightMaterial = () => false,
    getBatchElementCenter = () => null,
    createOrUpdateOrbitCenterHelper = () => {},
    hideOrbitCenterHelper = () => {},
    clearPendingSelection = () => {},
    maxSelectionCount = DEFAULT_MAX_SELECTION_COUNT,
  } = dependencies;

  /** @type {THREE.Object3D[]} */
  let selectedObjects = [];
  /** @type {Map<THREE.Object3D, THREE.Material|THREE.Material[]>} */
  const originalMaterials = new Map();

  const selectionLimit = Number.isFinite(maxSelectionCount)
    ? Math.max(0, Math.trunc(maxSelectionCount))
    : DEFAULT_MAX_SELECTION_COUNT;

  function requestRender(scheduleRender = render) {
    if (typeof scheduleRender === 'function') scheduleRender();
  }

  function warn(message, error) {
    if (typeof logger?.warn === 'function') logger.warn(message, error);
  }

  function isSelectable(obj, userData = obj?.userData) {
    if (!obj || !userData) return false;
    const elementType = userData.elementType || userData.stbNodeType;
    return Boolean(elementType && elementType !== 'Axis' && elementType !== 'Story');
  }

  function restoreMaterial(obj) {
    if (!originalMaterials.has(obj)) return;
    obj.material = originalMaterials.get(obj);
    originalMaterials.delete(obj);
  }

  function setOrbitCenter(center) {
    if (!center) return false;
    try {
      if (controls && typeof controls.setOrbitPoint === 'function') {
        controls.stop?.();
        controls.setOrbitPoint(center.x, center.y, center.z);
      } else if (controls?.target && typeof controls.target.copy === 'function') {
        controls.target.copy(center);
      }
      createOrUpdateOrbitCenterHelper(center);
      return true;
    } catch (error) {
      warn('選択: 回転中心の更新失敗', error);
      return false;
    }
  }

  function getObjectCenter(obj) {
    try {
      const mainObject = findSelectableAncestor(obj) || obj;
      const box = new THREE.Box3().setFromObject(mainObject);
      if (!box.isEmpty()) return box.getCenter(new THREE.Vector3());
    } catch (error) {
      warn('選択: オブジェクト中心の計算失敗', error);
    }
    return null;
  }

  function getSelectedObjects() {
    return [...selectedObjects];
  }

  function getSelectedCenter() {
    if (selectedObjects.length === 0) return null;
    try {
      const combinedBox = new THREE.Box3();
      for (const obj of selectedObjects) {
        const mainObject = findSelectableAncestor(obj) || obj;
        combinedBox.union(new THREE.Box3().setFromObject(mainObject));
      }
      return combinedBox.isEmpty() ? null : combinedBox.getCenter(new THREE.Vector3());
    } catch (error) {
      warn('選択中心取得: 計算失敗', error);
      return null;
    }
  }

  function highlightObject(obj) {
    if (
      !isSelectable(obj) ||
      selectedObjects.includes(obj) ||
      selectedObjects.length >= selectionLimit
    ) {
      return false;
    }

    if (Array.isArray(obj.material)) {
      originalMaterials.set(
        obj,
        obj.material.map((material) => material.clone()),
      );
    } else if (obj.material) {
      originalMaterials.set(obj, obj.material.clone());
    }

    applyHighlightMaterial(obj, 'highlight');
    selectedObjects.push(obj);
    return true;
  }

  function deselectObject(obj) {
    const index = selectedObjects.indexOf(obj);
    if (index < 0) return false;
    restoreMaterial(obj);
    selectedObjects.splice(index, 1);
    return true;
  }

  function toggleObject(obj) {
    if (selectedObjects.includes(obj)) return deselectObject(obj);
    if (selectedObjects.length >= selectionLimit) {
      warn(`選択: 上限到達 (${selectionLimit}要素)`);
      return false;
    }
    return highlightObject(obj);
  }

  function clearElementInfoPanel() {
    eventBus.emit(InteractionEvents.DISPLAY_ELEMENT_INFO, { ...EMPTY_INFO_PAYLOAD });
  }

  function resetSelection(scheduleRender = render) {
    clearPendingSelection();

    const adapter = getAdapter?.();
    adapter?.clearSelection?.();

    const hadSelection = selectedObjects.length > 0;
    for (const obj of selectedObjects) restoreMaterial(obj);
    selectedObjects = [];
    originalMaterials.clear();

    if (hadSelection) {
      clearElementInfoPanel();
      eventBus.emit(SelectionEvents.SELECTION_CLEARED, { timestamp: clock() });
    }
    hideOrbitCenterHelper();
    requestRender(scheduleRender);
    return hadSelection;
  }

  function showElementInfo() {
    if (selectedObjects.length === 0) {
      clearElementInfoPanel();
      return;
    }

    if (selectedObjects.length === 1) {
      const userData = selectedObjects[0].userData || {};
      const elementType = normalizeSelectedElementType(userData);
      let idA;
      let idB;
      if (elementType === 'Joint') {
        const isModelB = userData.modelSource === 'B' || userData.modelSource === 'onlyB';
        idA = isModelB ? null : userData.id;
        idB = isModelB ? userData.id : null;
      } else {
        ({ idA, idB } = getElementIds(userData));
      }

      const elementId = idA || idB;
      eventBus.emit(InteractionEvents.DISPLAY_ELEMENT_INFO, {
        idA,
        idB,
        elementType,
        modelSource: userData.modelSource,
      });
      eventBus.emit(SelectionEvents.ELEMENT_SELECTED, {
        elementType,
        elementId,
        elementIdA: idA,
        elementIdB: idB,
        modelSource: userData.modelSource,
        timestamp: clock(),
      });
      if (elementId) {
        eventBus.emit(InteractionEvents.SELECT_ELEMENT_IN_TREE, {
          elementType,
          elementId,
          modelSource: userData.modelSource,
        });
      }
      return;
    }

    const comparisonTarget = resolveTwoObjectComparisonTarget(selectedObjects);
    if (comparisonTarget) {
      eventBus.emit(InteractionEvents.DISPLAY_ELEMENT_INFO, comparisonTarget);
    } else {
      eventBus.emit(
        InteractionEvents.DISPLAY_MULTI_SELECTION_INFO,
        buildMultiSelectionSummaryData(selectedObjects),
      );
    }

    eventBus.emit(SelectionEvents.MULTI_SELECT, {
      selectedElements: selectedObjects.map((obj) => {
        const userData = obj.userData || {};
        return {
          elementType: normalizeSelectedElementType(userData),
          elementId: userData.elementId || userData.elementIdA || userData.elementIdB,
          modelSource: userData.modelSource,
        };
      }),
      count: selectedObjects.length,
      timestamp: clock(),
    });
  }

  function selectElement3D(obj, scheduleRender = render, options = {}) {
    if (!obj?.userData) {
      warn('選択: 無効なオブジェクトが指定されました');
      return false;
    }

    const batchHit = options.batchHit?.kind !== 'object' ? options.batchHit || null : null;
    const userData = batchHit?.userData || obj.userData;
    if (!isSelectable(obj, userData)) return false;

    const adapter = getAdapter?.();
    if (adapter) {
      const elementId = userData.elementId || userData.elementIdA || userData.elementIdB;
      const modelSource = userData.modelSource || 'A';
      // clearを先に行い、新しい選択を直後に消さない。
      resetSelection(null);
      adapter.selectElement?.(elementId, modelSource);
      adapter.focusOnElement?.(elementId, modelSource);
      return true;
    }

    resetSelection(null);
    if (batchHit) {
      setOrbitCenter(getBatchElementCenter(batchHit));
    } else {
      highlightObject(obj);
      setOrbitCenter(getObjectCenter(obj));
    }
    requestRender(scheduleRender);
    return true;
  }

  function selectMultipleElements3D(objects, scheduleRender = render, options = {}) {
    const { clearPrevious = true } = options;
    if (clearPrevious) resetSelection(null);

    const candidates = Array.isArray(objects) ? objects : [];
    let addedCount = 0;
    let wasLimited = false;
    for (const obj of candidates) {
      if (!isSelectable(obj) || selectedObjects.includes(obj)) continue;
      if (selectedObjects.length >= selectionLimit) {
        wasLimited = true;
        continue;
      }
      if (highlightObject(obj)) addedCount++;
    }
    if (wasLimited) warn(`選択: 上限到達 (${selectionLimit}要素)`);

    setOrbitCenter(getSelectedCenter());
    requestRender(scheduleRender);
    return addedCount;
  }

  function updateOrbitCenter() {
    return setOrbitCenter(getSelectedCenter());
  }

  return {
    getSelectedCenter,
    getSelectedObjects,
    resetSelection,
    selectElement3D,
    selectMultipleElements3D,
    highlightObject,
    deselectObject,
    toggleObject,
    updateOrbitCenter,
    showElementInfo,
    clearElementInfoPanel,
  };
}
