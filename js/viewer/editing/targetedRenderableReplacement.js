/**
 * @fileoverview element-ID 単位の renderable 差し替えライフサイクル
 *
 * Working Document から再生成した solid / polygon object を、既存 group 全体を
 * 作り直さず対象要素だけ差し替える。Model B / overlay は触らず、ラベル位置、
 * ElementRegistry、clipping lifecycle を同時に整合させる。
 */

import * as THREE from 'three';

import { finalizeRenderableBatch } from '../rendering/renderableLifecycle.js';
import { getMaterialForElementWithMode } from '../rendering/materials.js';
import { getSharedNodeSphereGeometry } from '../rendering/elementsShared.js';
import { getElementRegistry } from '../utils/ElementRegistry.js';
import { disposeRecursive } from '../utils/ResourceDisposer.js';

function getElementIds(userData) {
  return [userData?.elementId, userData?.elementIdA, userData?.elementIdB]
    .filter((id) => id !== null && id !== undefined && String(id) !== '')
    .map(String);
}

function isEditableModelAUserData(userData) {
  if (!userData || userData.isOverlayModelB) return false;
  return !['B', 'onlyB'].includes(userData.modelSource);
}

function matchesElement(userData, elementType, elementId) {
  return (
    userData?.elementType === elementType &&
    isEditableModelAUserData(userData) &&
    getElementIds(userData).includes(String(elementId))
  );
}

function collectTargets(group, elementType, elementId) {
  const renderables = [];
  const labels = [];
  group?.traverse?.((object) => {
    if (!matchesElement(object.userData, elementType, elementId)) return;
    if (object.isSprite) labels.push(object);
    else renderables.push(object);
  });
  return { renderables, labels };
}

function hasEditableTarget(group, elementType, elementId) {
  let found = false;
  group?.traverse?.((object) => {
    if (found) return;
    if (matchesElement(object.userData, elementType, elementId)) {
      found = true;
      return;
    }
    const instances = object.userData?.instances;
    if (
      Array.isArray(instances) &&
      instances.some((item) => matchesElement(item, elementType, elementId))
    ) {
      found = true;
      return;
    }
    const segments = object.userData?.segments;
    if (
      Array.isArray(segments) &&
      segments.some((segment) => matchesElement(segment?.userData, elementType, elementId))
    ) {
      found = true;
    }
  });
  return found;
}

function normalizeVector3(value, label) {
  if (value instanceof THREE.Vector3) return value.clone();
  const vector = new THREE.Vector3(Number(value?.x), Number(value?.y), Number(value?.z));
  if (![vector.x, vector.y, vector.z].every(Number.isFinite)) {
    throw new Error(`${label} は有限値で指定してください。`);
  }
  return vector;
}

function createPolygonRenderable(addition, elementType, elementId) {
  const points = (Array.isArray(addition.points) ? addition.points : []).map((point, index) =>
    normalizeVector3(point, `Polygon頂点${index + 1}`),
  );
  if (points.length < 3) {
    throw new Error('Polygon表示には3点以上の頂点が必要です。');
  }

  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const indices = [];
  for (let index = 1; index < points.length - 1; index += 1) {
    indices.push(0, index, index + 1);
  }
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(
    geometry,
    getMaterialForElementWithMode(elementType, 'onlyA', false, true, elementId),
  );
  mesh.userData = {
    elementType,
    elementId: String(elementId),
    modelSource: 'A',
    originalId: String(elementId),
    id: String(elementId),
    isPoly: true,
  };
  return mesh;
}

function createRenderableFromDescriptor(addition, elementType, elementId) {
  if (!addition || addition.isObject3D) return addition;
  if (addition.kind === 'working-node') {
    const position = normalizeVector3(addition.position, 'Node表示位置');
    const mesh = new THREE.Mesh(
      getSharedNodeSphereGeometry().clone(),
      getMaterialForElementWithMode('Node', 'onlyA', false, false, elementId),
    );
    mesh.position.copy(position);
    mesh.userData = { elementType: 'Node', elementId: String(elementId), modelSource: 'A' };
    return mesh;
  }
  if (addition.kind === 'working-line') {
    const start = normalizeVector3(addition.start, 'Line始点');
    const end = normalizeVector3(addition.end, 'Line終点');
    const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
    const line = new THREE.Line(
      geometry,
      getMaterialForElementWithMode(elementType, 'onlyA', true, false, elementId),
    );
    line.userData = {
      elementType,
      elementId: String(elementId),
      modelSource: 'A',
      isLine: true,
    };
    return line;
  }
  if (addition.kind === 'working-polygon') {
    return createPolygonRenderable(addition, elementType, elementId);
  }
  return addition;
}

function getCombinedCenter(objects) {
  const box = new THREE.Box3();
  let found = false;
  for (const object of objects) {
    if (!object) continue;
    object.updateMatrixWorld?.(true);
    const objectBox = new THREE.Box3().setFromObject(object);
    if (objectBox.isEmpty()) continue;
    box.union(objectBox);
    found = true;
  }
  return found ? box.getCenter(new THREE.Vector3()) : null;
}

function inheritIdentityMetadata(replacement, sourceUserData, elementType, elementId) {
  const inheritedKeys = [
    'elementId',
    'elementIdA',
    'elementIdB',
    'modelSource',
    'originalId',
    'id',
    'category',
    'positionState',
    'attributeState',
    'diffStatus',
    'attributeMismatchKind',
    'importance',
    'sectionId',
  ];
  const inherited = {};
  for (const key of inheritedKeys) {
    if (sourceUserData?.[key] !== undefined) inherited[key] = sourceUserData[key];
  }

  replacement.userData = {
    ...(replacement.userData || {}),
    ...inherited,
    elementType,
  };

  if (!getElementIds(replacement.userData).includes(String(elementId))) {
    replacement.userData.elementId = String(elementId);
  }
}

function disposeReplacedRenderable(object) {
  // 通常の構造要素 material は共有キャッシュ由来のため解放しない。
  // geometry は対象object固有なので必ず解放する。
  disposeRecursive(object, {
    removeFromParent: true,
    disposeGeometry: true,
    disposeMaterial: false,
  });
}

function disposeRemovedRenderable(object, elementType) {
  // 通常Node描画は共有SphereGeometryを使うため、Nodeだけはgeometryを解放しない。
  disposeRecursive(object, {
    removeFromParent: true,
    disposeGeometry: elementType !== 'Node',
    disposeMaterial: false,
  });
}

function hasSelectionPreviewMaterial(objects) {
  return objects.some((object) => object?.material?.userData?.isSelectionPreviewMaterial === true);
}

function removeInstancedTargets(group, elementType, elementId) {
  let removedInstances = 0;
  const emptyBatches = [];
  const matrix = new THREE.Matrix4();

  group?.traverse?.((object) => {
    if (!object.isInstancedMesh || !Array.isArray(object.userData?.instances)) return;
    const instances = object.userData.instances;
    const indexes = [];
    for (let i = 0; i < instances.length; i += 1) {
      if (matchesElement(instances[i], elementType, elementId)) indexes.push(i);
    }
    if (indexes.length === 0) return;

    indexes.sort((a, b) => b - a);
    for (const index of indexes) {
      const lastIndex = instances.length - 1;
      if (index !== lastIndex) {
        object.getMatrixAt(lastIndex, matrix);
        object.setMatrixAt(index, matrix);
        instances[index] = instances[lastIndex];
      }
      instances.pop();
      removedInstances += 1;
    }
    object.count = instances.length;
    object.userData.instanceCount = instances.length;
    if (object.instanceMatrix) object.instanceMatrix.needsUpdate = true;
    if (instances.length === 0) emptyBatches.push(object);
  });

  for (const object of emptyBatches) object.removeFromParent?.();
  return removedInstances;
}

function rebuildBatchedLineGeometry(object, keptSegments) {
  const oldGeometry = object.geometry;
  const position = oldGeometry?.getAttribute?.('position');
  if (!position) return false;
  const color = oldGeometry.getAttribute?.('color') || null;
  const positions = [];
  const colors = [];
  const nextSegments = [];

  for (const segment of keptSegments) {
    const nextStartIndex = positions.length / 3;
    positions.push(
      position.getX(segment.startIndex),
      position.getY(segment.startIndex),
      position.getZ(segment.startIndex),
      position.getX(segment.endIndex),
      position.getY(segment.endIndex),
      position.getZ(segment.endIndex),
    );
    if (color) {
      colors.push(
        color.getX(segment.startIndex),
        color.getY(segment.startIndex),
        color.getZ(segment.startIndex),
        color.getX(segment.endIndex),
        color.getY(segment.endIndex),
        color.getZ(segment.endIndex),
      );
    }
    nextSegments.push({
      startIndex: nextStartIndex,
      endIndex: nextStartIndex + 1,
      userData: segment.userData,
    });
  }

  const nextGeometry = new THREE.BufferGeometry();
  nextGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (color) nextGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  nextGeometry.computeBoundingBox();
  nextGeometry.computeBoundingSphere();
  object.geometry = nextGeometry;
  object.userData.segments = nextSegments;
  object.userData.segmentCount = nextSegments.length;
  oldGeometry?.dispose?.();
  return true;
}

function removeBatchedLineTargets(group, elementType, elementId) {
  let removedSegments = 0;
  const emptyBatches = [];

  group?.traverse?.((object) => {
    const segments = object.userData?.segments;
    if (!object.userData?.isBatched || !Array.isArray(segments)) return;
    const kept = segments.filter(
      (segment) => !matchesElement(segment?.userData, elementType, elementId),
    );
    const removed = segments.length - kept.length;
    if (removed === 0) return;
    removedSegments += removed;
    if (kept.length === 0) {
      emptyBatches.push(object);
      return;
    }
    rebuildBatchedLineGeometry(object, kept);
  });

  for (const object of emptyBatches) {
    object.geometry?.dispose?.();
    object.removeFromParent?.();
  }
  return removedSegments;
}

/**
 * 既存 Model A renderable を replacement objects / descriptors へ差し替える。
 */
export function replaceElementRenderablesInGroup(
  group,
  elementType,
  elementId,
  replacements,
  options = {},
) {
  if (!group?.traverse || !group?.add) {
    throw new Error('差し替え対象 group が無効です。');
  }

  const nextObjects = (Array.isArray(replacements) ? replacements : [replacements])
    .filter(Boolean)
    .map((replacement) => createRenderableFromDescriptor(replacement, elementType, elementId))
    .filter(Boolean);
  if (nextObjects.length === 0) {
    throw new Error('差し替え後 renderable がありません。');
  }

  const { renderables: oldObjects, labels } = collectTargets(group, elementType, elementId);
  if (oldObjects.length === 0) {
    return {
      replaced: false,
      removedObjects: [],
      addedObjects: [],
      labelsMoved: 0,
      replacementPairs: [],
    };
  }

  if (hasSelectionPreviewMaterial(oldObjects)) {
    return {
      replaced: false,
      reason: 'selection-preview-active',
      removedObjects: [],
      addedObjects: [],
      labelsMoved: 0,
      replacementPairs: [],
    };
  }

  const registry = options.registry || getElementRegistry();
  const finalize = options.finalize || finalizeRenderableBatch;
  const preserveMaterial = options.preserveMaterial !== false;
  const oldCenter = getCombinedCenter(oldObjects);
  const sourceUserData = oldObjects[0].userData || {};
  const displayedMaterials = oldObjects.map((object) => object.material || null);

  for (const object of oldObjects) {
    registry?.unregister?.(object);
    disposeReplacedRenderable(object);
  }

  nextObjects.forEach((replacement, index) => {
    inheritIdentityMetadata(replacement, sourceUserData, elementType, elementId);
    if (preserveMaterial && displayedMaterials.length > 0) {
      const material = displayedMaterials[Math.min(index, displayedMaterials.length - 1)];
      if (material) replacement.material = material;
    }
    group.add(replacement);
    registry?.register?.(replacement);
  });

  const newCenter = getCombinedCenter(nextObjects);
  let labelsMoved = 0;
  if (oldCenter && newCenter) {
    const delta = newCenter.clone().sub(oldCenter);
    for (const label of labels) {
      label.position?.add?.(delta);
      labelsMoved += 1;
    }
  }

  finalize?.({ elementType, group });

  const replacementPairs = oldObjects.map((oldObject, index) => ({
    oldObject,
    newObject: nextObjects[Math.min(index, nextObjects.length - 1)],
  }));

  return {
    replaced: true,
    removedObjects: oldObjects,
    addedObjects: nextObjects,
    labelsMoved,
    replacementPairs,
  };
}

/**
 * Working Document で新規追加された Model A renderable を既存 group へ挿入する。
 * Object3D に加えて Working Node / 2節点Line / Polygon descriptor を受け付ける。
 */
export function insertElementRenderablesInGroup(
  group,
  elementType,
  elementId,
  additions,
  options = {},
) {
  if (!group?.traverse || !group?.add) {
    throw new Error('追加先 group が無効です。');
  }

  const nextObjects = (Array.isArray(additions) ? additions : [additions])
    .filter(Boolean)
    .map((addition) => createRenderableFromDescriptor(addition, elementType, elementId))
    .filter(Boolean);
  if (nextObjects.length === 0) {
    throw new Error('追加する renderable がありません。');
  }

  if (hasEditableTarget(group, elementType, elementId)) {
    return { inserted: false, reason: 'element-already-rendered', addedObjects: [] };
  }

  const registry = options.registry || getElementRegistry();
  const finalize = options.finalize || finalizeRenderableBatch;
  const targetId = String(elementId);

  for (const object of nextObjects) {
    if (!object?.isObject3D) {
      throw new Error('追加する renderable が Three.js Object3D ではありません。');
    }
    object.userData = { ...(object.userData || {}), elementType };
    if (!getElementIds(object.userData).includes(targetId)) object.userData.elementId = targetId;
    if (!object.userData.modelSource) object.userData.modelSource = 'A';
    group.add(object);
    registry?.register?.(object);
  }

  finalize?.({ elementType, group });
  return { inserted: true, addedObjects: nextObjects };
}

/**
 * Working Document から削除された Model A renderable と対応 label を group から除去する。
 * Node InstancedMesh / LineSegments batch 内の個別要素もID単位で除去する。
 */
export function removeElementRenderablesInGroup(group, elementType, elementId, options = {}) {
  if (!group?.traverse) {
    throw new Error('削除対象 group が無効です。');
  }

  const { renderables, labels } = collectTargets(group, elementType, elementId);
  const removedInstances = removeInstancedTargets(group, elementType, elementId);
  const removedSegments = removeBatchedLineTargets(group, elementType, elementId);
  if (
    renderables.length === 0 &&
    labels.length === 0 &&
    removedInstances === 0 &&
    removedSegments === 0
  ) {
    return {
      removed: false,
      removedObjects: [],
      removedLabels: [],
      removedInstances: 0,
      removedSegments: 0,
    };
  }

  const registry = options.registry || getElementRegistry();
  const finalize = options.finalize || finalizeRenderableBatch;

  for (const object of renderables) {
    registry?.unregister?.(object);
    disposeRemovedRenderable(object, elementType);
  }
  for (const label of labels) {
    disposeRecursive(label, {
      removeFromParent: true,
      disposeGeometry: true,
      disposeMaterial: true,
    });
  }

  finalize?.({ elementType, group });
  return {
    removed: true,
    removedObjects: renderables,
    removedLabels: labels,
    removedInstances,
    removedSegments,
  };
}
