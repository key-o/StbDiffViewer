/**
 * @fileoverview クリッピング平面を生成・更新する純粋関数群
 */

import * as THREE from 'three';

const AXIS_NORMALS = {
  X: new THREE.Vector3(1, 0, 0),
  Y: new THREE.Vector3(0, 1, 0),
  Z: new THREE.Vector3(0, 0, 1),
};

/**
 * 軸方向の範囲を囲む2枚のクリッピング平面を生成する。
 * @param {'X'|'Y'|'Z'} axis
 * @param {number} lowerBound
 * @param {number} upperBound
 * @returns {THREE.Plane[]}
 */
export function createAxisRangeClippingPlanes(axis, lowerBound, upperBound) {
  const normal = AXIS_NORMALS[axis];
  if (!normal) return [];

  return [
    new THREE.Plane(normal.clone(), -lowerBound),
    new THREE.Plane(normal.clone().negate(), upperBound),
  ];
}

/**
 * Box3の内側を残す6枚のクリッピング平面を生成する。
 * @param {THREE.Box3} box
 * @returns {THREE.Plane[]}
 */
export function createBoxClippingPlanes(box) {
  return updateBoxClippingPlanes([], box);
}

/**
 * Box3用6面を既存Planeへin-place更新する。
 * 6枚が渡されなかった場合だけ新規生成する。
 *
 * 順序: +X, -X, +Y, -Y, +Z, -Z
 * @param {THREE.Plane[]} planes
 * @param {THREE.Box3} box
 * @returns {THREE.Plane[]} 同じ配列（初期生成時を除く）
 */
export function updateBoxClippingPlanes(planes, box) {
  const target =
    Array.isArray(planes) && planes.length === 6
      ? planes
      : Array.from({ length: 6 }, () => new THREE.Plane());

  target[0].normal.set(1, 0, 0);
  target[0].constant = -box.min.x;
  target[1].normal.set(-1, 0, 0);
  target[1].constant = box.max.x;

  target[2].normal.set(0, 1, 0);
  target[2].constant = -box.min.y;
  target[3].normal.set(0, -1, 0);
  target[3].constant = box.max.y;

  target[4].normal.set(0, 0, 1);
  target[4].constant = -box.min.z;
  target[5].normal.set(0, 0, -1);
  target[5].constant = box.max.z;

  return target;
}
