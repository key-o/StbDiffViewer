/**
 * @fileoverview 編集時の element-ID 単位 Geometry 更新プリミティブ
 *
 * Node marker と線表示部材について、通常オブジェクトとバッチ描画の双方を
 * group 全再生成なしで更新する。ソリッド・ポリゴンの再生成は上位controllerが担当する。
 */

import * as THREE from 'three';

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

function toFiniteNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeDelta(delta) {
  const vector =
    delta instanceof THREE.Vector3
      ? delta.clone()
      : new THREE.Vector3(
          toFiniteNumber(delta?.x),
          toFiniteNumber(delta?.y),
          toFiniteNumber(delta?.z),
        );
  if (![vector.x, vector.y, vector.z].every(Number.isFinite)) {
    throw new Error('Geometry 更新差分は有限値で指定してください。');
  }
  return vector;
}

function normalizePosition(position) {
  const vector =
    position instanceof THREE.Vector3
      ? position.clone()
      : new THREE.Vector3(
          toFiniteNumber(position?.x),
          toFiniteNumber(position?.y),
          toFiniteNumber(position?.z),
        );
  if (![vector.x, vector.y, vector.z].every(Number.isFinite)) {
    throw new Error('Node 表示位置は有限値で指定してください。');
  }
  return vector;
}

function translateAttributePoint(attribute, index, delta) {
  attribute.setXYZ(
    index,
    attribute.getX(index) + delta.x,
    attribute.getY(index) + delta.y,
    attribute.getZ(index) + delta.z,
  );
}

function markGeometryUpdated(geometry) {
  const position = geometry?.getAttribute?.('position');
  if (position) position.needsUpdate = true;
  geometry?.computeBoundingBox?.();
  geometry?.computeBoundingSphere?.();
}

/**
 * Node の通常メッシュ・ラベル・InstancedMesh instance を局所移動する。
 * @param {THREE.Object3D} group
 * @param {string|number} nodeId
 * @param {{x:number,y:number,z:number}|THREE.Vector3} position
 * @returns {{objects:number, instances:number}}
 */
export function updateNodeRenderablesInGroup(group, nodeId, position) {
  if (!group?.traverse) return { objects: 0, instances: 0 };
  const target = normalizePosition(position);
  let objects = 0;
  let instances = 0;

  group.traverse((object) => {
    const userData = object.userData;
    if (!userData) return;

    if (userData.isInstanced && Array.isArray(userData.instances) && object.isInstancedMesh) {
      const matrix = new THREE.Matrix4();
      for (let i = 0; i < userData.instances.length; i += 1) {
        const instanceData = userData.instances[i];
        if (!matchesElement(instanceData, 'Node', nodeId)) continue;
        object.getMatrixAt(i, matrix);
        matrix.setPosition(target);
        object.setMatrixAt(i, matrix);
        instances += 1;
      }
      if (instances > 0 && object.instanceMatrix) object.instanceMatrix.needsUpdate = true;
      return;
    }

    if (!matchesElement(userData, 'Node', nodeId)) return;
    if (object.position?.set) {
      object.position.set(target.x, target.y, target.z);
      objects += 1;
    }
  });

  return { objects, instances };
}

/**
 * 2節点線要素の端点だけを局所移動する。
 * バッチ LineSegments の segment、通常 THREE.Line、対応ラベルを同じdeltaで更新する。
 * ラベルは端点1つの移動なら delta/2、両端なら delta だけ平行移動する。
 *
 * @param {THREE.Object3D} group
 * @param {string} elementType
 * @param {string|number} elementId
 * @param {{delta:{x:number,y:number,z:number}|THREE.Vector3, moveStart?:boolean, moveEnd?:boolean}} options
 * @returns {{lines:number, segments:number, labels:number}}
 */
export function updateLineRenderablesInGroup(group, elementType, elementId, options = {}) {
  if (!group?.traverse) return { lines: 0, segments: 0, labels: 0 };
  const delta = normalizeDelta(options.delta);
  const moveStart = options.moveStart === true;
  const moveEnd = options.moveEnd === true;
  if (!moveStart && !moveEnd) return { lines: 0, segments: 0, labels: 0 };

  let lines = 0;
  let segments = 0;
  let labels = 0;
  const labelFactor = (Number(moveStart) + Number(moveEnd)) / 2;

  group.traverse((object) => {
    const userData = object.userData;
    if (!userData) return;

    if (userData.isBatched && Array.isArray(userData.segments)) {
      const position = object.geometry?.getAttribute?.('position');
      if (!position) return;
      let objectChanged = false;
      for (const segment of userData.segments) {
        if (!matchesElement(segment?.userData, elementType, elementId)) continue;
        if (moveStart) translateAttributePoint(position, segment.startIndex, delta);
        if (moveEnd) translateAttributePoint(position, segment.endIndex, delta);
        segments += 1;
        objectChanged = true;
      }
      if (objectChanged) markGeometryUpdated(object.geometry);
      return;
    }

    if (!matchesElement(userData, elementType, elementId)) return;

    if (object.isSprite) {
      object.position.addScaledVector(delta, labelFactor);
      labels += 1;
      return;
    }

    if (object.isLine) {
      const position = object.geometry?.getAttribute?.('position');
      if (!position || position.count < 2) return;
      if (moveStart) translateAttributePoint(position, 0, delta);
      if (moveEnd) translateAttributePoint(position, 1, delta);
      markGeometryUpdated(object.geometry);
      lines += 1;
    }
  });

  return { lines, segments, labels };
}
