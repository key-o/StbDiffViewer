/**
 * @fileoverview バッチ描画対応の3D要素ルックアップ
 *
 * ID→3Dオブジェクトの検索では、要素数が閾値を超えるとバッチ描画に切り替わる点に
 * 注意が必要です。バッチ描画では個別要素のuserDataが1つのメッシュに集約されます:
 * - 節点: InstancedMesh の `userData.instances[]`
 * - 線要素(線分モード): LineSegmentsバッチの `userData.segments[].userData`
 *
 * 通常の `group.traverse()` で `child.userData.elementId` を直接見る検索は
 * これらのバッチ要素を見つけられないため、本モジュールで一元的に吸収します。
 */

import * as THREE from 'three';

/**
 * userDataのIDとモデルソースが検索条件に一致するか判定する
 * @param {Object} userData - 判定対象のuserData（メッシュ/インスタンス/セグメント）
 * @param {string} elementId - 要素ID
 * @param {string} modelSource - モデルソース ('matched' | 'onlyA' | 'onlyB' | 'A' | 'B')
 * @returns {boolean}
 */
function userDataMatches(userData, elementId, modelSource) {
  if (!userData) return false;
  const ids = [userData.elementId, userData.elementIdA, userData.elementIdB]
    .filter((id) => id != null)
    .map((id) => String(id));
  if (!ids.includes(String(elementId))) return false;
  return (
    userData.modelSource === modelSource ||
    (modelSource === 'onlyA' && userData.modelSource === 'A') ||
    (modelSource === 'onlyB' && userData.modelSource === 'B') ||
    (modelSource === 'matched' && userData.modelSource === 'matched')
  );
}

/**
 * バッチ要素検索の結果
 * @typedef {Object} BatchElementHit
 * @property {THREE.Object3D} object - 見つかった3Dオブジェクト（バッチ時は集約メッシュ）
 * @property {'object'|'instance'|'segment'} kind - 要素の格納形態
 * @property {number|null} index - instances[]/segments[] のインデックス（通常オブジェクトはnull）
 * @property {Object} userData - 該当要素のuserData（バッチ時は個別要素のもの）
 */

/**
 * 要素グループから要素タイプ/ID/モデルソースで要素を検索する。
 * 通常オブジェクト・InstancedMesh(instances[])・LineSegmentsバッチ(segments[])に対応。
 *
 * @param {THREE.Object3D} group - 検索対象の要素グループ
 * @param {string} elementType - 要素タイプ
 * @param {string} elementId - 要素ID
 * @param {string} modelSource - モデルソース
 * @returns {BatchElementHit|null}
 */
export function findElementInGroup(group, elementType, elementId, modelSource) {
  if (!group) return null;

  let hit = null;
  group.traverse((obj) => {
    if (hit) return;
    const ud = obj.userData;
    if (!ud) return;

    // InstancedMesh バッチ（節点）: 個別要素は userData.instances[] に格納
    if (ud.isInstanced && Array.isArray(ud.instances)) {
      for (let i = 0; i < ud.instances.length; i++) {
        const inst = ud.instances[i];
        if (
          inst &&
          inst.elementType === elementType &&
          userDataMatches(inst, elementId, modelSource)
        ) {
          hit = { object: obj, kind: 'instance', index: i, userData: inst };
          return;
        }
      }
      return;
    }

    // LineSegments バッチ（線要素）: 個別要素は userData.segments[].userData に格納
    if (ud.isBatched && Array.isArray(ud.segments)) {
      for (let i = 0; i < ud.segments.length; i++) {
        const sud = ud.segments[i]?.userData;
        if (
          sud &&
          sud.elementType === elementType &&
          userDataMatches(sud, elementId, modelSource)
        ) {
          hit = { object: obj, kind: 'segment', index: i, userData: sud };
          return;
        }
      }
      return;
    }

    // 通常オブジェクト
    if (ud.elementType === elementType && userDataMatches(ud, elementId, modelSource)) {
      hit = { object: obj, kind: 'object', index: null, userData: ud };
    }
  });

  return hit;
}

/**
 * バッチ要素（instance/segment）のワールド中心座標を求める。
 * 通常オブジェクト（kind === 'object'）は呼び出し側でバウンディングボックスを
 * 使うべきなので null を返す。
 *
 * @param {BatchElementHit} hit - findElementInGroup の結果
 * @returns {THREE.Vector3|null}
 */
export function getBatchElementCenter(hit) {
  if (!hit || hit.kind === 'object') return null;

  const { object, kind, index } = hit;
  try {
    const center = new THREE.Vector3();

    if (kind === 'instance') {
      const matrix = new THREE.Matrix4();
      object.getMatrixAt(index, matrix);
      center.setFromMatrixPosition(matrix);
    } else if (kind === 'segment') {
      const segment = object.userData.segments[index];
      const position = object.geometry?.getAttribute('position');
      if (!segment || !position) return null;
      const start = new THREE.Vector3().fromBufferAttribute(position, segment.startIndex);
      const end = new THREE.Vector3().fromBufferAttribute(position, segment.endIndex);
      center.addVectors(start, end).multiplyScalar(0.5);
    } else {
      return null;
    }

    object.localToWorld(center);
    return center;
  } catch {
    return null;
  }
}

// 編集時の局所Geometry更新も、通常/バッチ格納差を同じviewer境界で吸収する。
export {
  updateNodeRenderablesInGroup,
  updateLineRenderablesInGroup,
} from '../editing/targetedGeometryUpdater.js';
export {
  insertElementRenderablesInGroup,
  removeElementRenderablesInGroup,
  replaceElementRenderablesInGroup,
} from '../editing/targetedRenderableReplacement.js';
