/**
 * @fileoverview Working structural add 後の label lifecycle。
 *
 * Working Document の structural add は element-ID 単位で scene へ挿入されるため、
 * 通常の型全体 redraw が生成していた label も同じ操作内で補完する。
 * delete 側は targetedRenderableReplacement が renderable と対応 label を同時削除する。
 *
 * comparison visual lifecycle より後段で実行し、Undo/Discard で復元された matched 要素は
 * scene renderable に復元済みの elementIdA/B / modelSource を使って元の比較ラベル形式へ戻す。
 */

import * as THREE from 'three';

import { eventBus, EditEvents } from '../../data/events/index.js';
import { getState } from '../../data/state/globalState.js';
import { scheduleRender } from '../../utils/renderScheduler.js';
import { resolveElementTagName } from '../editing/attributeCommandUtils.js';
import {
  createLabelSprite,
  elementGroups,
  generateLabelText,
  labelDisplayManager,
} from '../../viewer/index.js';

const DEFAULT_DEPENDENCIES = {
  eventBus,
  getState,
  scheduleRender,
  elementGroups,
  labelDisplayManager,
  createLabelSprite,
  generateLabelText,
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

function matchesIdentity(object, elementType, elementId) {
  return (
    object?.userData?.elementType === elementType &&
    isEditableModelA(object.userData) &&
    getElementIds(object.userData).includes(String(elementId))
  );
}

function findElement(document, elementType, elementId) {
  const tagName = resolveElementTagName(elementType);
  if (!document || !tagName || elementId === null || elementId === undefined) return null;
  return [...document.getElementsByTagName(tagName)].find(
    (element) => String(element.getAttribute('id')) === String(elementId),
  );
}

function toPlainElementData(element) {
  const data = {};
  for (const attr of Array.from(element?.attributes || [])) data[attr.name] = attr.value;
  return data;
}

function collectRenderableFacts(group, elementType, elementId) {
  const box = new THREE.Box3();
  let found = false;
  let identity = null;
  group?.traverse?.((object) => {
    if (!matchesIdentity(object, elementType, elementId) || object.isSprite) return;
    object.updateMatrixWorld?.(true);
    const objectBox = new THREE.Box3().setFromObject(object);
    if (!objectBox.isEmpty()) {
      box.union(objectBox);
      found = true;
    }
    if (!identity && object.userData?.isOpeningOutline !== true) identity = object.userData;
  });
  return {
    center: found ? box.getCenter(new THREE.Vector3()) : null,
    identity,
  };
}

function hasLabel(group, elementType, elementId) {
  let found = false;
  group?.traverse?.((object) => {
    if (found || !object.isSprite) return;
    if (matchesIdentity(object, elementType, elementId)) found = true;
  });
  return found;
}

function buildLabelDescriptor(deps, targetDocument, elementType, elementId, identity) {
  const elementA = findElement(targetDocument, elementType, elementId);
  if (!elementA) return null;
  const textA = deps.generateLabelText?.(toPlainElementData(elementA), elementType) || elementId;

  if (identity?.modelSource === 'matched') {
    const idA = String(identity.elementIdA || elementId);
    const idB =
      identity.elementIdB === undefined || identity.elementIdB === null
        ? null
        : String(identity.elementIdB);
    const elementB = idB
      ? findElement(deps.getState?.('models.documentB'), elementType, idB)
      : null;
    const textB = elementB
      ? deps.generateLabelText?.(toPlainElementData(elementB), elementType) || idB
      : idB || '?';
    return {
      text: `${textA || idA} / ${textB}`,
      userData: {
        elementType,
        elementId: idA,
        elementIdA: idA,
        ...(idB ? { elementIdB: idB } : {}),
        modelSource: 'matched',
      },
    };
  }

  return {
    text: `A: ${textA}`,
    userData: {
      elementType,
      elementId: String(elementId),
      modelSource: 'A',
    },
  };
}

/**
 * @param {Object} [dependencies]
 * @returns {{start:Function,stop:Function,handlePayload:Function,insertLabelForAdd:Function}}
 */
export function createWorkingAddLabelLifecycleController(dependencies = {}) {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  let removeListener = null;
  let generation = 0;

  function insertLabelForAdd(change, targetDocument) {
    if (change?.operation !== 'add' || !change.elementType || change.elementId === undefined) {
      return false;
    }

    const elementType = String(change.elementType);
    const elementId = String(change.elementId);
    if (deps.labelDisplayManager?.isLabelVisible?.(elementType) !== true) return false;

    const group = deps.elementGroups?.[elementType];
    if (!group?.traverse || !group?.add) return false;
    if (hasLabel(group, elementType, elementId)) return false;

    const facts = collectRenderableFacts(group, elementType, elementId);
    if (!facts.center) return false;

    const descriptor = buildLabelDescriptor(
      deps,
      targetDocument,
      elementType,
      elementId,
      facts.identity,
    );
    if (!descriptor) return false;

    const sprite = deps.createLabelSprite?.(descriptor.text, facts.center, group, elementType);
    if (!sprite) return false;

    sprite.userData = {
      ...(sprite.userData || {}),
      ...descriptor.userData,
    };
    return true;
  }

  function handlePayload(payload = {}, expectedGeneration = generation) {
    if (expectedGeneration !== generation) return 0;
    const targetDocument = payload.targetDocument || payload.workingDocument || null;
    const changes = Array.isArray(payload.structuralChanges) ? payload.structuralChanges : [];
    if (!targetDocument || changes.length === 0) return 0;

    let created = 0;
    for (const change of changes) {
      if (insertLabelForAdd(change, targetDocument)) created += 1;
    }
    if (created > 0) deps.scheduleRender?.();
    return created;
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

  return { start, stop, handlePayload, insertLabelForAdd };
}

const controller = createWorkingAddLabelLifecycleController();

export function initWorkingAddLabelLifecycle() {
  return controller.start();
}

export function resetWorkingAddLabelLifecycleForTest() {
  controller.stop();
}
