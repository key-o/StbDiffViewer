/**
 * @fileoverview 3D要素の選択状態と選択通知を管理するサービス
 */

import * as THREE from 'three';

import { InteractionEvents, SelectionEvents } from '../../../constants/eventTypes.js';
import { RenderableLifecycleEvents } from '../../../constants/renderableLifecycleEvents.js';
import {
  cloneSemanticSelectionIdentity,
  createSemanticSelectionIdentity,
  sameSemanticSelectionIdentity,
} from './semanticSelection.js';
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
    clearHighlightMaterial = (obj, material) => {
      if (material) obj.material = material;
    },
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
  /** Object3D は差し替わり得るため、選択意味を semantic identity として別管理する。 */
  const semanticSelections = new Map();

  const selectionLimit = Number.isFinite(maxSelectionCount)
    ? Math.max(0, Math.trunc(maxSelectionCount))
    : DEFAULT_MAX_SELECTION_COUNT;

  function requestRender(scheduleRender = render) {
    if (typeof scheduleRender === 'function') scheduleRender();
  }

  function warn(message, error) {
    if (typeof logger?.warn === 'function') logger.warn(message, error);
  }

  function cloneMaterialSnapshot(material) {
    if (Array.isArray(material)) {
      return material.map((item) => item?.clone?.() || item);
    }
    return material?.clone?.() || material || null;
  }

  function disposeMaterialSnapshot(material) {
    if (Array.isArray(material)) {
      material.forEach((item) => item?.dispose?.());
      return;
    }
    material?.dispose?.();
  }

  function isSelectable(obj, userData = obj?.userData) {
    if (!obj || !userData) return false;
    const elementType = userData.elementType || userData.stbNodeType;
    return Boolean(
      (userData.isRebarInstanceSelection || elementType) &&
      elementType !== 'Axis' &&
      elementType !== 'Story',
    );
  }

  function restoreMaterial(obj) {
    const originalMaterial = originalMaterials.get(obj);
    if (originalMaterial || obj?.userData?.isRebarInstanceSelection) {
      clearHighlightMaterial(obj, originalMaterial);
    }
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

  function getSelectedIdentities() {
    return selectedObjects
      .map(
        (object) =>
          semanticSelections.get(object) || createSemanticSelectionIdentity(object?.userData),
      )
      .filter(Boolean)
      .map(cloneSemanticSelectionIdentity);
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
    }
    return null;
  }

  function highlightObject(obj) {
    if (
      !isSelectable(obj) ||
      selectedObjects.includes(obj) ||
      selectedObjects.length >= selectionLimit
    ) {
      return false;
    }

    const snapshot = obj.userData?.isRebarInstanceSelection
      ? obj.userData.sourceMesh?.material
      : cloneMaterialSnapshot(obj.material);
    if (snapshot) originalMaterials.set(obj, snapshot);

    applyHighlightMaterial(obj, 'highlight');
    selectedObjects.push(obj);
    const identity = createSemanticSelectionIdentity(obj.userData);
    if (identity) semanticSelections.set(obj, identity);
    return true;
  }

  /**
   * 色モードや配筋ghost切替で選択中オブジェクトへベース材が再適用された後、
   * その材を新しい復元元として保存し直して選択ハイライトを再適用する。
   * これにより、配筋ON/OFFを選択後に切り替えても選択色を維持し、解除時には
   * 現在の透明度・色モードへ正しく復元できる。
   *
   * @param {Function|null} [scheduleRender] - 再描画コールバック
   * @returns {number} ハイライトを再適用した選択数
   */
  function refreshSelectedMaterials(scheduleRender = render) {
    let refreshedCount = 0;

    for (const obj of selectedObjects) {
      if (!obj?.material) continue;

      const isRebarSelection = obj.userData?.isRebarInstanceSelection === true;
      const baseMaterial = isRebarSelection ? obj.userData.sourceMesh?.material : obj.material;
      const nextSnapshot = isRebarSelection ? baseMaterial : cloneMaterialSnapshot(baseMaterial);
      if (!nextSnapshot) continue;

      const previousSnapshot = originalMaterials.get(obj);
      if (previousSnapshot && !isRebarSelection) disposeMaterialSnapshot(previousSnapshot);
      originalMaterials.set(obj, nextSnapshot);

      if (applyHighlightMaterial(obj, 'highlight')) refreshedCount += 1;
    }

    if (refreshedCount > 0) requestRender(scheduleRender);
    return refreshedCount;
  }

  function deselectObject(obj) {
    const index = selectedObjects.indexOf(obj);
    if (index < 0) return false;
    restoreMaterial(obj);
    semanticSelections.delete(obj);
    selectedObjects.splice(index, 1);
    return true;
  }

  function toggleObject(obj) {
    if (obj?.userData?.isRebarInstanceSelection) {
      const identity = createSemanticSelectionIdentity(obj.userData);
      const selectedMatch = selectedObjects.find((selectedObject) => {
        const selectedIdentity =
          semanticSelections.get(selectedObject) ||
          createSemanticSelectionIdentity(selectedObject?.userData);
        return sameSemanticSelectionIdentity(identity, selectedIdentity);
      });
      if (selectedMatch) return deselectObject(selectedMatch);
    }
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
    semanticSelections.clear();

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
      if (userData.isRebarInstanceSelection) {
        eventBus.emit(InteractionEvents.DISPLAY_REBAR_INFO, {
          rebarKind: userData.rebarKind,
          barDiameterMm: userData.barDiameterMm,
          instanceId: userData.rebarInstanceId,
          modelSource: userData.modelSource,
        });
        return;
      }

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

  /**
   * element-ID局所再生成で Object3D が差し替わった後、選択状態を semantic identity のまま
   * replacement object へ移送する。oldObject は scene から除去済みでも参照可能である。
   *
   * @param {Array<{oldObject:THREE.Object3D,newObject:THREE.Object3D}>} replacementPairs
   * @param {Function|null} [scheduleRender]
   * @returns {number} 移送した選択数
   */
  function rebindSelectedObjects(replacementPairs, scheduleRender = render) {
    const pairMap = new Map();
    for (const pair of Array.isArray(replacementPairs) ? replacementPairs : []) {
      if (pair?.oldObject && pair?.newObject) pairMap.set(pair.oldObject, pair.newObject);
    }
    if (pairMap.size === 0 || selectedObjects.length === 0) return 0;

    const nextSelected = [];
    let reboundCount = 0;

    for (const oldObject of selectedObjects) {
      const newObject = pairMap.get(oldObject) || oldObject;
      if (newObject !== oldObject) {
        reboundCount += 1;
        const materialSnapshot = originalMaterials.get(oldObject);
        if (materialSnapshot) {
          if (!originalMaterials.has(newObject)) originalMaterials.set(newObject, materialSnapshot);
          else disposeMaterialSnapshot(materialSnapshot);
          originalMaterials.delete(oldObject);
        }

        const identity =
          semanticSelections.get(oldObject) || createSemanticSelectionIdentity(oldObject.userData);
        semanticSelections.delete(oldObject);
        if (identity) semanticSelections.set(newObject, identity);

        // replacementが現在のhighlight materialを継承していない実装でも選択表示を維持する。
        if (newObject.material !== oldObject.material) {
          applyHighlightMaterial(newObject, 'highlight');
        }
      }

      if (!nextSelected.includes(newObject)) nextSelected.push(newObject);
    }

    selectedObjects = nextSelected;
    if (reboundCount > 0) requestRender(scheduleRender);
    return reboundCount;
  }

  function updateOrbitCenter() {
    return setOrbitCenter(getSelectedCenter());
  }

  if (typeof eventBus?.on === 'function') {
    eventBus.on(RenderableLifecycleEvents.MATERIALS_CHANGED, () => {
      refreshSelectedMaterials();
    });
    eventBus.on(RenderableLifecycleEvents.RENDERABLES_REPLACED, ({ replacementPairs } = {}) => {
      rebindSelectedObjects(replacementPairs, null);
    });
    eventBus.on(RenderableLifecycleEvents.REBAR_MESHES_REMOVED, ({ meshes } = {}) => {
      const removedMeshes = new Set(Array.isArray(meshes) ? meshes : []);
      const removedSelections = selectedObjects.filter((obj) =>
        removedMeshes.has(obj?.userData?.sourceMesh),
      );
      if (removedSelections.length === 0) return;
      for (const obj of removedSelections) deselectObject(obj);
      showElementInfo();
      hideOrbitCenterHelper();
      requestRender();
    });
  }

  return {
    getSelectedCenter,
    getSelectedObjects,
    getSelectedIdentities,
    resetSelection,
    selectElement3D,
    selectMultipleElements3D,
    highlightObject,
    refreshSelectedMaterials,
    deselectObject,
    toggleObject,
    rebindSelectedObjects,
    updateOrbitCenter,
    showElementInfo,
    clearElementInfoPanel,
  };
}
