/**
 * @fileoverview Working structural add/restoration の comparison visual provenance 同期。
 *
 * Issue #249 では編集操作と比較処理を分離する。したがって既存要素の Working replacement は
 * 最後の明示比較 material/metadata を保持し、comparisonResults 自体を更新しない。
 * 一方 structural add は scene に object が無いため material を継承できない。
 *
 * - source に存在しない真の Working add: Model A onlyA として provisional 表示
 * - Undo/Discard で source 要素を復元: 最後の明示 comparison snapshot を復元
 *
 * これにより generator 既定の matched material が新規 solid add に残る問題と、削除 Undo 後に
 * 既存 matched/差分カテゴリが onlyA へ落ちる問題を同時に防ぐ。
 */

import { eventBus, EditEvents } from '../../data/events/index.js';
import { getState } from '../../data/state/globalState.js';
import { scheduleRender } from '../../utils/renderScheduler.js';
import {
  applyComparisonSnapshotToUserData,
  resolveWorkingComparisonSnapshot,
} from '../editing/workingComparisonSnapshot.js';
import { elementGroups, getMaterialForElementWithMode } from '../../viewer/index.js';

const DEFAULT_DEPENDENCIES = {
  eventBus,
  getState,
  scheduleRender,
  elementGroups,
  getMaterialForElementWithMode,
  queueTask: (callback) => globalThis.queueMicrotask(callback),
};

function getElementIds(userData) {
  return [userData?.elementId, userData?.elementIdA, userData?.elementIdB]
    .filter((id) => id !== null && id !== undefined && String(id) !== '')
    .map(String);
}

function isEditableModelA(userData) {
  if (!userData || userData.isOverlayModelB) return false;
  return !['B', 'onlyB'].includes(userData.modelSource);
}

function matchesRenderable(object, elementType, elementId) {
  const userData = object?.userData;
  return (
    !object?.isSprite &&
    userData?.isOpeningOutline !== true &&
    userData?.elementType === elementType &&
    isEditableModelA(userData) &&
    getElementIds(userData).includes(String(elementId))
  );
}

function comparisonStateFromSnapshot(snapshot) {
  if (snapshot?.modelSource === 'A' || snapshot?.modelSource === 'onlyA') return 'onlyA';
  if (snapshot?.modelSource === 'B' || snapshot?.modelSource === 'onlyB') return 'onlyB';
  return 'matched';
}

function applySnapshotMaterial(deps, object, elementType, elementId, snapshot) {
  const userData = object.userData || {};
  const material = deps.getMaterialForElementWithMode?.(
    elementType,
    comparisonStateFromSnapshot(snapshot),
    object.isLine || userData.isLine === true,
    userData.isPoly === true,
    String(elementId),
    snapshot?.toleranceState || null,
    {
      modelSource: snapshot?.modelSource || null,
      diffStatus: snapshot?.diffStatus || null,
      positionState: snapshot?.positionState || null,
      attributeState: snapshot?.attributeState || null,
      isTransparent: userData.isSRCConcrete === true,
      srcComponentType: userData.srcComponentType || null,
    },
  );
  if (material) object.material = material;
}

/**
 * @param {Object} [dependencies]
 * @returns {{start:Function,stop:Function,handlePayload:Function,reclassifyStructuralAdd:Function}}
 */
export function createWorkingComparisonVisualLifecycleController(dependencies = {}) {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  let removeListener = null;
  let generation = 0;

  function reclassifyStructuralAdd(change, payload = {}) {
    if (change?.operation !== 'add' || !change.elementType || change.elementId === undefined) {
      return 0;
    }

    const elementType = String(change.elementType);
    const elementId = String(change.elementId);
    const group = deps.elementGroups?.[elementType];
    if (!group?.traverse) return 0;

    const editingState = deps.getState?.('models.editing') || null;
    const targetDocument = payload.targetDocument || payload.workingDocument || null;
    const sourceDocument =
      editingState?.sourceDocumentA || (payload.reset === true ? targetDocument : null);
    const snapshot = resolveWorkingComparisonSnapshot({
      comparisonResults: deps.getState?.('comparisonResults'),
      sourceDocument,
      elementType,
      elementId,
    });

    let updated = 0;
    group.traverse((object) => {
      if (!matchesRenderable(object, elementType, elementId)) return;
      object.userData = applyComparisonSnapshotToUserData(object.userData, snapshot);
      object.userData.elementType = elementType;
      object.userData.originalId ??= snapshot.elementId || elementId;
      object.userData.comparisonSnapshotOrigin = snapshot.origin;
      applySnapshotMaterial(deps, object, elementType, elementId, snapshot);
      updated += 1;
    });
    return updated;
  }

  function handlePayload(payload = {}, expectedGeneration = generation) {
    if (expectedGeneration !== generation) return 0;
    const changes = Array.isArray(payload.structuralChanges) ? payload.structuralChanges : [];
    if (changes.length === 0) return 0;

    let updated = 0;
    for (const change of changes) updated += reclassifyStructuralAdd(change, payload);
    if (updated > 0) deps.scheduleRender?.();
    return updated;
  }

  function start() {
    if (removeListener || typeof deps.eventBus?.on !== 'function') return false;
    generation += 1;
    removeListener = deps.eventBus.on(EditEvents.WORKING_DOCUMENT_CHANGED, (payload = {}) => {
      const expectedGeneration = generation;
      deps.queueTask?.(() => handlePayload(payload, expectedGeneration));
    });
    return true;
  }

  function stop() {
    generation += 1;
    removeListener?.();
    removeListener = null;
  }

  return { start, stop, handlePayload, reclassifyStructuralAdd };
}

const controller = createWorkingComparisonVisualLifecycleController();

export function initWorkingComparisonVisualLifecycle() {
  return controller.start();
}

export function resetWorkingComparisonVisualLifecycleForTest() {
  controller.stop();
}
