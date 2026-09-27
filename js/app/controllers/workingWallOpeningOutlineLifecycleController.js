/**
 * @fileoverview Working Wall / ShearWall の非solid開口輪郭を element-ID 単位で同期する。
 *
 * Wall solid は Working parse の openingElements を使って局所再生成されるが、line/panel 表示の
 * 開口輪郭は通常 redraw の drawWallOpeningOutlines() が別途生成している。Working edit では
 * full redraw を通さないため、affected Wall だけ既存 Model A/matched outline を除去し、
 * Working Document の最新 wall/opening から描き直す。
 *
 * 明示比較と編集は分離されているため、既存 Wall の comparison snapshot は再比較まで維持する。
 * 再生成した opening outline も host Wall の modelSource / diff metadata / 現在色を継承し、
 * Working edit だけで matched を onlyA に誤分類しない。
 */

import * as THREE from 'three';

import { eventBus, EditEvents } from '../../data/events/index.js';
import { scheduleRender } from '../../utils/renderScheduler.js';
import { getViewerWallElementType } from '../../common-stb/walls/wallClassification.js';
import { WorkingNodeVectorView } from '../editing/workingSolidGenerator.js';
import { drawWallOpeningOutlines } from '../viewModes/elementRedrawWalls.js';
import { displayModeManager, elementGroups, parseStbFile } from '../../viewer/index.js';

const DEFAULT_DEPENDENCIES = {
  eventBus,
  scheduleRender,
  displayModeManager,
  elementGroups,
  parseStbFile,
  drawWallOpeningOutlines,
  queueTask: (callback) => globalThis.queueMicrotask(callback),
};

const COMPARISON_METADATA_KEYS = Object.freeze([
  'modelSource',
  'category',
  'toleranceState',
  'positionState',
  'attributeState',
  'diffStatus',
  'attributeMismatchKind',
]);

function isWallViewerType(elementType) {
  return elementType === 'Wall' || elementType === 'ShearWall';
}

function findRawWall(document, wallId) {
  if (!document) return null;
  return [...document.getElementsByTagName('StbWall')].find(
    (wall) => String(wall.getAttribute('id')) === String(wallId),
  );
}

function getMapValueById(map, id) {
  if (!(map instanceof Map)) return null;
  if (map.has(id)) return map.get(id);
  const target = String(id);
  if (map.has(target)) return map.get(target);
  for (const [key, value] of map.entries()) {
    if (String(key) === target) return value;
  }
  return null;
}

function wallVertexCoords(wall, parsedData, workingNodeMap) {
  const nodeIds = Array.isArray(wall?.node_ids) ? wall.node_ids : [];
  if (nodeIds.length < 3) return null;
  const nodes = new WorkingNodeVectorView(parsedData?.nodes, workingNodeMap);
  const result = [];
  for (const nodeId of nodeIds) {
    const node = nodes.get(nodeId);
    if (!node) return null;
    const offset = getMapValueById(wall.offsets, nodeId) || {};
    const point = {
      x: Number(node.x) + Number(offset.offset_X || 0),
      y: Number(node.y) + Number(offset.offset_Y || 0),
      z: Number(node.z) + Number(offset.offset_Z || 0),
    };
    if (!Object.values(point).every(Number.isFinite)) return null;
    result.push(point);
  }
  return result;
}

function getElementIds(userData) {
  return [userData?.elementId, userData?.elementIdA, userData?.elementIdB]
    .filter((id) => id !== null && id !== undefined && String(id) !== '')
    .map(String);
}

function isEditableModelA(userData) {
  if (!userData || userData.isOverlayModelB) return false;
  return !['B', 'onlyB'].includes(userData.modelSource);
}

function matchesEditableOutline(object, elementType, wallId) {
  const userData = object?.userData;
  return (
    userData?.isOpeningOutline === true &&
    userData?.elementType === elementType &&
    String(userData?.hostElementId) === String(wallId) &&
    isEditableModelA(userData)
  );
}

function matchesHostWall(object, elementType, wallId) {
  const userData = object?.userData;
  return (
    !object?.isSprite &&
    userData?.isOpeningOutline !== true &&
    userData?.elementType === elementType &&
    isEditableModelA(userData) &&
    getElementIds(userData).includes(String(wallId))
  );
}

function findHostWallRenderable(group, elementType, wallId) {
  let result = null;
  group?.traverse?.((object) => {
    if (!result && matchesHostWall(object, elementType, wallId)) result = object;
  });
  return result;
}

function collectEditableOutlines(group, elementType, wallId) {
  const result = [];
  group?.traverse?.((object) => {
    if (matchesEditableOutline(object, elementType, wallId)) result.push(object);
  });
  return result;
}

function removeExistingOutlines(group, elementType, wallId) {
  const targets = collectEditableOutlines(group, elementType, wallId);
  const materials = new Set();
  for (const object of targets) {
    if (Array.isArray(object.material))
      object.material.forEach((material) => materials.add(material));
    else if (object.material) materials.add(object.material);
  }
  for (const object of targets) {
    object.geometry?.dispose?.();
    object.removeFromParent?.();
  }
  for (const material of materials) material?.dispose?.();
  return targets.length;
}

function inheritHostComparisonSnapshot(outline, host) {
  if (!outline?.userData || !host?.userData) return;
  for (const key of COMPARISON_METADATA_KEYS) {
    if (host.userData[key] !== undefined) outline.userData[key] = host.userData[key];
    else delete outline.userData[key];
  }

  const hostMaterial = Array.isArray(host.material) ? host.material[0] : host.material;
  const outlineMaterials = Array.isArray(outline.material) ? outline.material : [outline.material];
  if (!hostMaterial?.color) return;
  for (const material of outlineMaterials) {
    material?.color?.copy?.(hostMaterial.color);
  }
}

/**
 * @param {Object} [dependencies]
 * @returns {{start:Function,stop:Function,handlePayload:Function,refreshWall:Function}}
 */
export function createWorkingWallOpeningOutlineLifecycleController(dependencies = {}) {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  let removeListener = null;
  let generation = 0;

  function refreshWall(targetDocument, targetNodeMap, elementType, wallId) {
    if (!isWallViewerType(elementType)) return { supported: false, removed: 0, added: 0 };
    if (deps.displayModeManager?.getDisplayMode?.(elementType) !== 'line') {
      return { supported: false, removed: 0, added: 0 };
    }

    const group = deps.elementGroups?.[elementType];
    if (!group?.traverse || !group?.add || !targetDocument) {
      return { supported: false, removed: 0, added: 0 };
    }

    const parsedData = deps.parseStbFile?.(targetDocument, { modelKey: null });
    const rawWall = findRawWall(targetDocument, wallId);
    const wall = Array.isArray(parsedData?.wallElements)
      ? parsedData.wallElements.find((candidate) => String(candidate?.id) === String(wallId))
      : null;

    // delete/discard 等で対象 wall が無くなった場合でも stale outline は除去する。
    if (!wall || !rawWall || getViewerWallElementType(rawWall) !== elementType) {
      const removed = removeExistingOutlines(group, elementType, wallId);
      return { supported: true, removed, added: 0 };
    }

    const vertexCoordsList = wallVertexCoords(wall, parsedData, targetNodeMap);
    if (!vertexCoordsList) {
      return { supported: false, removed: 0, added: 0 };
    }

    // Geometry sync はこの controller より先に対象 polygon を置換するため、ここで得る host は
    // Working geometry だが comparison metadata/material は最後の明示比較 snapshot を保持している。
    const hostRenderable = findHostWallRenderable(group, elementType, wallId);
    const removed = removeExistingOutlines(group, elementType, wallId);
    const beforeObjects = new Set(collectEditableOutlines(group, elementType, wallId));

    deps.drawWallOpeningOutlines?.(
      {
        matched: [],
        onlyA: [
          {
            id: String(wall.id),
            vertexCoordsList,
            rawElement: rawWall,
          },
        ],
        onlyB: [],
      },
      group,
      new THREE.Box3(),
      new Map([[String(wall.id), wall]]),
      new Map(),
      parsedData?.openingElements || null,
      null,
      elementType,
    );

    const currentOutlines = collectEditableOutlines(group, elementType, wallId);
    const addedOutlines = currentOutlines.filter((outline) => !beforeObjects.has(outline));
    if (hostRenderable) {
      for (const outline of addedOutlines) inheritHostComparisonSnapshot(outline, hostRenderable);
    }
    return { supported: true, removed, added: addedOutlines.length };
  }

  function handlePayload(payload = {}, expectedGeneration = generation) {
    if (expectedGeneration !== generation) return { refreshed: 0, removed: 0, added: 0 };
    const targetDocument = payload.targetDocument || payload.workingDocument || null;
    const targetNodeMap = payload.targetNodeMap || payload.workingNodeMap || null;
    const affected = Array.isArray(payload.affectedElements) ? payload.affectedElements : [];
    if (!targetDocument || affected.length === 0) return { refreshed: 0, removed: 0, added: 0 };

    const unique = new Map();
    for (const element of affected) {
      if (!isWallViewerType(element?.elementType) || element.elementId === undefined) continue;
      const key = `${element.elementType}:${String(element.elementId)}`;
      if (!unique.has(key)) {
        unique.set(key, {
          elementType: String(element.elementType),
          elementId: String(element.elementId),
        });
      }
    }

    let refreshed = 0;
    let removed = 0;
    let added = 0;
    for (const element of unique.values()) {
      const result = refreshWall(
        targetDocument,
        targetNodeMap,
        element.elementType,
        element.elementId,
      );
      if (!result.supported) continue;
      refreshed += 1;
      removed += result.removed;
      added += result.added;
    }
    if (removed > 0 || added > 0) deps.scheduleRender?.();
    return { refreshed, removed, added };
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

  return { start, stop, handlePayload, refreshWall };
}

const controller = createWorkingWallOpeningOutlineLifecycleController();

export function initWorkingWallOpeningOutlineLifecycle() {
  return controller.start();
}

export function resetWorkingWallOpeningOutlineLifecycleForTest() {
  controller.stop();
}
