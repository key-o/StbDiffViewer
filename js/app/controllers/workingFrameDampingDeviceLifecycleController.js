/**
 * @fileoverview Working FrameDampingDevice の非solid polygon targeted lifecycle。
 *
 * 4節点指定型制振装置は full redraw では polygon として描画されるが、Working geometry
 * sync の汎用2節点line経路では扱えない。Working Document の StbNodeIdOrder と
 * StbFrameDampingDeviceOffset を semantic source とし、add / delete / replace を ID 単位で行う。
 */

import { eventBus, EditEvents } from '../../data/events/index.js';
import { RenderableLifecycleEvents } from '../../constants/renderableLifecycleEvents.js';
import { scheduleRender } from '../../utils/renderScheduler.js';
import {
  displayModeManager,
  elementGroups,
  insertElementRenderablesInGroup,
  removeElementRenderablesInGroup,
  replaceElementRenderablesInGroup,
} from '../../viewer/index.js';

const ELEMENT_TYPE = 'FrameDampingDevice';
const TAG_NAME = 'StbFrameDampingDevice';
const OFFSET_TAG = 'StbFrameDampingDeviceOffset';

const DEFAULT_DEPENDENCIES = {
  eventBus,
  scheduleRender,
  displayModeManager,
  elementGroups,
  insertElementRenderablesInGroup,
  removeElementRenderablesInGroup,
  replaceElementRenderablesInGroup,
  queueTask: (callback) => globalThis.queueMicrotask(callback),
};

function normalizePosition(value) {
  if (!value || typeof value !== 'object') return null;
  const result = { x: Number(value.x), y: Number(value.y), z: Number(value.z) };
  return Object.values(result).every(Number.isFinite) ? result : null;
}

function getNodeMapEntry(nodeMap, nodeId) {
  if (!(nodeMap instanceof Map)) return null;
  const target = String(nodeId);
  if (nodeMap.has(target)) return nodeMap.get(target);
  for (const [key, value] of nodeMap.entries()) {
    if (String(key) === target) return value;
  }
  return null;
}

function findById(document, tagName, id) {
  if (!document) return null;
  return [...document.getElementsByTagName(tagName)].find(
    (element) => String(element.getAttribute('id')) === String(id),
  );
}

function getNodePosition(document, nodeMap, nodeId) {
  const fromMap = normalizePosition(getNodeMapEntry(nodeMap, nodeId));
  if (fromMap) return fromMap;
  const node = findById(document, 'StbNode', nodeId);
  if (!node) return null;
  return normalizePosition({
    x: node.getAttribute('X'),
    y: node.getAttribute('Y'),
    z: node.getAttribute('Z'),
  });
}

function findOffset(element, nodeId) {
  return [...element.getElementsByTagName(OFFSET_TAG)].find(
    (offset) => String(offset.getAttribute('id_node')) === String(nodeId),
  );
}

export function getWorkingFrameDampingDeviceDescriptor(document, nodeMap, elementId) {
  const element = findById(document, TAG_NAME, elementId);
  if (!element) return null;
  const order = element.getElementsByTagName('StbNodeIdOrder')[0];
  const nodeIds = String(order?.textContent || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (nodeIds.length < 3) return null;

  const points = [];
  for (const nodeId of nodeIds) {
    const position = getNodePosition(document, nodeMap, nodeId);
    if (!position) return null;
    const offset = findOffset(element, nodeId);
    const point = {
      x: position.x + Number(offset?.getAttribute('offset_X') || 0),
      y: position.y + Number(offset?.getAttribute('offset_Y') || 0),
      z: position.z + Number(offset?.getAttribute('offset_Z') || 0),
    };
    if (!Object.values(point).every(Number.isFinite)) return null;
    points.push(point);
  }
  return { kind: 'working-polygon', points };
}

function getStructuralChanges(payload) {
  return Array.isArray(payload?.structuralChanges)
    ? payload.structuralChanges
        .filter(
          (change) =>
            change?.elementType === ELEMENT_TYPE &&
            ['add', 'delete'].includes(change.operation) &&
            change.elementId !== undefined &&
            change.elementId !== null,
        )
        .map((change) => ({ operation: change.operation, elementId: String(change.elementId) }))
    : [];
}

function getAffectedIds(payload) {
  const ids = new Set();
  for (const element of Array.isArray(payload?.affectedElements) ? payload.affectedElements : []) {
    if (element?.elementType === ELEMENT_TYPE && element.elementId !== undefined) {
      ids.add(String(element.elementId));
    }
  }
  return ids;
}

function emitReplacement(deps, elementId, replacement) {
  const replacementPairs = replacement?.replacementPairs || [];
  if (replacement?.replaced === true && replacementPairs.length > 0) {
    deps.eventBus?.emit?.(RenderableLifecycleEvents.RENDERABLES_REPLACED, {
      elementType: ELEMENT_TYPE,
      elementId: String(elementId),
      replacementPairs,
    });
  }
}

/**
 * @param {Object} [dependencies]
 * @returns {{start:Function,stop:Function,handlePayload:Function}}
 */
export function createWorkingFrameDampingDeviceLifecycleController(dependencies = {}) {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  let removeListener = null;
  let generation = 0;

  function handlePayload(payload = {}, expectedGeneration = generation) {
    if (expectedGeneration !== generation) {
      return { inserted: 0, removed: 0, replaced: 0 };
    }
    if (deps.displayModeManager?.getDisplayMode?.(ELEMENT_TYPE) !== 'line') {
      return { inserted: 0, removed: 0, replaced: 0 };
    }

    const document = payload.targetDocument || payload.workingDocument || null;
    const nodeMap = payload.targetNodeMap || payload.workingNodeMap || null;
    const group = deps.elementGroups?.[ELEMENT_TYPE];
    if (!document || !group?.traverse || !group?.add) {
      return { inserted: 0, removed: 0, replaced: 0 };
    }

    let inserted = 0;
    let removed = 0;
    let replaced = 0;
    const structuralKeys = new Set();

    for (const change of getStructuralChanges(payload)) {
      structuralKeys.add(change.elementId);
      if (change.operation === 'delete') {
        const result = deps.removeElementRenderablesInGroup?.(
          group,
          ELEMENT_TYPE,
          change.elementId,
        );
        if (result?.removed) removed += 1;
        continue;
      }

      const descriptor = getWorkingFrameDampingDeviceDescriptor(
        document,
        nodeMap,
        change.elementId,
      );
      if (!descriptor) continue;
      const result = deps.insertElementRenderablesInGroup?.(
        group,
        ELEMENT_TYPE,
        change.elementId,
        descriptor,
      );
      if (result?.inserted) inserted += 1;
    }

    for (const elementId of getAffectedIds(payload)) {
      if (structuralKeys.has(elementId)) continue;
      const descriptor = getWorkingFrameDampingDeviceDescriptor(document, nodeMap, elementId);
      if (!descriptor) continue;
      const result = deps.replaceElementRenderablesInGroup?.(
        group,
        ELEMENT_TYPE,
        elementId,
        descriptor,
      );
      if (result?.replaced) {
        replaced += 1;
        emitReplacement(deps, elementId, result);
      }
    }

    if (inserted > 0 || removed > 0 || replaced > 0) deps.scheduleRender?.();
    return { inserted, removed, replaced };
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

  return { start, stop, handlePayload };
}

const controller = createWorkingFrameDampingDeviceLifecycleController();

export function initWorkingFrameDampingDeviceLifecycle() {
  return controller.start();
}

export function resetWorkingFrameDampingDeviceLifecycleForTest() {
  controller.stop();
}
