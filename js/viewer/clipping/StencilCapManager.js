/**
 * @fileoverview スタンシルベースのクリッピングキャップ管理
 *
 * SectionBoxでクリッピングしたとき、断面に「蓋」を描画して
 * 中空ではなくソリッドに見せるためのスタンシルバッファ利用実装。
 *
 * 重要な契約:
 * - SectionBoxを追加しただけで、切断していない要素用の描画は追加しない。
 * - Stencil/Capは、対象クリッピング面を実際に横切る可視Meshだけから生成する。
 * - 非表示要素、参照要素、Model B overlay、SectionBox/Stencil自身は入力にしない。
 *
 * 仕組み:
 *   各クリッピング平面 P[i] に対して:
 *     1. P[i] を実際に横切り、残り5面の保持側にも到達し得るMeshだけを抽出
 *     2. ステンシル書き込みメッシュ (背面: +1, 前面: -1) を生成
 *        → 対象平面 P[i] 自身でクリップし、その切断面だけをステンシル化する
 *     3. キャップ平面 (stencil != 0 の領域のみ描画) を生成
 *        → 他の5平面でボックス面内に制限し、描画後にステンシルを 0 にリセット
 *
 * renderOrder:
 *   ステンシル書き込み / キャップ描画は、実際に切断候補がある色グループだけに割り当てる。
 */

import * as THREE from 'three';
import { ELEMENT_CATEGORIES } from '../../constants/elementTypes.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('viewer:stencilCap');

/** ステンシルキャップ対象外の要素タイプ（参照要素: Story/Axis/Node） */
const EXCLUDED_ELEMENT_TYPES = new Set(ELEMENT_CATEGORIES.REFERENCE);

/** キャップ平面のデフォルト色 */
const DEFAULT_CAP_COLOR = 0xaaaaaa;

/** キャップ平面のサイズ (mm) - 建物全体を覆う十分な大きさ */
const CAP_PLANE_SIZE = 500000;

/**
 * Planeとの交差判定許容値 (mm)。
 * 面への単なる接触は「切断」と見なさず、両側へ実体がある場合だけcap対象とする。
 */
const CAP_INTERSECTION_EPSILON = 1e-3;

export class StencilCapManager {
  /**
   * @param {(() => Object<string, THREE.Object3D>|THREE.Object3D[])|null} [renderRootsProvider]
   */
  constructor(renderRootsProvider = null) {
    /** @type {THREE.Scene|null} */
    this._scene = null;
    /** @type {Array<{group: THREE.Group, cap: THREE.Mesh}>} */
    this._objects = [];
    this._renderRootsProvider =
      typeof renderRootsProvider === 'function' ? renderRootsProvider : null;
  }

  /**
   * @param {(() => Object<string, THREE.Object3D>|THREE.Object3D[])|null} provider
   */
  setRenderRootsProvider(provider) {
    this._renderRootsProvider = typeof provider === 'function' ? provider : null;
  }

  /**
   * スタンシルキャップを有効化する。
   * SectionBox全体の全Meshを複製せず、各面を実際に横切る可視Meshだけを入力にする。
   * @param {THREE.Scene} scene
   * @param {THREE.Plane[]} clipPlanes - セクションボックスのクリッピング平面
   * @param {number} [capColor] - 色取得できない場合のキャップ既定色
   * @param {Object<string, THREE.Object3D>|THREE.Object3D[]|THREE.Object3D|null} [renderRoots]
   */
  activate(scene, clipPlanes, capColor = DEFAULT_CAP_COLOR, renderRoots = null) {
    this.deactivate();

    if (!clipPlanes || clipPlanes.length === 0) return;

    const roots = renderRoots ?? this._renderRootsProvider?.() ?? null;
    const candidates = _collectVisibleCapCandidates(roots, capColor);
    if (candidates.length === 0) {
      log.debug('No visible element meshes found for stencil caps');
      return;
    }

    this._scene = scene;
    let renderOrder = 100;
    let contributingPlaneCount = 0;
    let sourceReferenceCount = 0;

    for (let i = 0; i < clipPlanes.length; i++) {
      const targetPlane = clipPlanes[i];
      const stencilPlanes = [targetPlane];
      const otherPlanes = clipPlanes.filter((_, j) => j !== i);
      const meshColorGroups = _groupCapCandidatesForPlane(candidates, targetPlane, otherPlanes);

      if (meshColorGroups.length === 0) continue;
      contributingPlaneCount++;

      for (let colorIndex = 0; colorIndex < meshColorGroups.length; colorIndex++) {
        const { color, meshes } = meshColorGroups[colorIndex];
        if (meshes.length === 0) continue;

        sourceReferenceCount += meshes.length;
        const stencilRO = renderOrder++;
        const capRO = renderOrder++;

        // ステンシル書き込みグループ。
        // ここに入るのは対象面を実際に横切る可視Meshだけ。
        const group = new THREE.Group();
        group.name = `StencilCap_${i}_${colorIndex}`;
        group.userData.isStencilCap = true;
        group.userData.clipPlaneIndex = i;
        group.userData.sourceMeshCount = meshes.length;

        for (const src of meshes) {
          const backMat = createStencilMaterial(
            THREE.BackSide,
            THREE.IncrementWrapStencilOp,
            stencilPlanes,
          );
          const frontMat = createStencilMaterial(
            THREE.FrontSide,
            THREE.DecrementWrapStencilOp,
            stencilPlanes,
          );
          group.add(_makeStencilMesh(src, backMat, stencilRO));
          group.add(_makeStencilMesh(src, frontMat, stencilRO));
        }

        scene.add(group);

        // キャップ平面（色グループ別）。切断候補が0件ならそもそも生成しない。
        const cap = createCapPlaneMesh(targetPlane, otherPlanes, color, capRO);
        cap.userData.clipPlaneIndex = i;
        cap.userData.sourceMeshCount = meshes.length;
        scene.add(cap);

        this._objects.push({ group, cap });
      }
    }

    if (this._objects.length === 0) {
      // SectionBoxがモデル全体を包含している場合など、実際の切断がなければ
      // Stencil/Cap renderableを1つも追加しない。
      this._scene = null;
      log.debug('SectionBox does not cut any visible meshes; no stencil caps created');
      return;
    }

    log.info(
      `Stencil caps activated: ${this._objects.length} cap surface(s), ${contributingPlaneCount}/${clipPlanes.length} clipping plane(s), ${sourceReferenceCount} source mesh reference(s)`,
    );
  }

  /**
   * スタンシルキャップを無効化してリソースを解放する
   */
  deactivate() {
    if (!this._scene) {
      this._objects = [];
      return;
    }

    for (const { group, cap } of this._objects) {
      this._scene.remove(group);
      // ジオメトリは元のメッシュと共有しているので dispose しない
      group.traverse((child) => {
        if (child.material) child.material.dispose();
      });

      this._scene.remove(cap);
      if (cap.geometry) cap.geometry.dispose();
      if (cap.material) cap.material.dispose();
    }

    this._objects = [];
    this._scene = null;
    log.debug('Stencil caps deactivated');
  }

  /** @returns {boolean} */
  isActive() {
    return this._objects.length > 0;
  }

  /**
   * E2E/診断用。実際に追加された補助描画数だけを返す。
   * @returns {{capCount:number, stencilMeshCount:number, sourceMeshReferences:number, planeIndices:number[]}}
   */
  getStats() {
    let stencilMeshCount = 0;
    let sourceMeshReferences = 0;
    const planeIndices = new Set();

    for (const { group, cap } of this._objects) {
      stencilMeshCount += group.children.length;
      sourceMeshReferences += group.userData?.sourceMeshCount ?? 0;
      const planeIndex = cap.userData?.clipPlaneIndex;
      if (Number.isInteger(planeIndex)) planeIndices.add(planeIndex);
    }

    return {
      capCount: this._objects.length,
      stencilMeshCount,
      sourceMeshReferences,
      planeIndices: [...planeIndices].sort((a, b) => a - b),
    };
  }
}

// ============================================
// ヘルパー関数
// ============================================

function normalizeRenderRoots(renderRoots) {
  if (!renderRoots) return [];
  if (renderRoots instanceof THREE.Object3D) {
    return [{ type: null, root: renderRoots }];
  }
  if (Array.isArray(renderRoots)) {
    return renderRoots
      .filter((root) => root instanceof THREE.Object3D)
      .map((root) => ({ type: null, root }));
  }
  if (typeof renderRoots === 'object') {
    return Object.entries(renderRoots)
      .filter(([, root]) => root instanceof THREE.Object3D)
      .map(([type, root]) => ({ type, root }));
  }
  return [];
}

function _hasVisibleMaterial(mesh) {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return materials.some((material) => material && material.visible !== false);
}

function _getWorldBoundingBox(mesh) {
  const geometry = mesh.geometry;
  if (!geometry) return null;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  if (!geometry.boundingBox || geometry.boundingBox.isEmpty()) return null;

  mesh.updateWorldMatrix(true, false);
  return geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
}

/**
 * 注入されたrender rootsから、現在の表示状態でcap入力になり得るMeshを収集する。
 * traverseVisibleを使い、非表示group配下のgeometryをcapだけで復活させない。
 * @param {Object<string, THREE.Object3D>|THREE.Object3D[]|THREE.Object3D|null} renderRoots
 * @param {number} fallbackColor
 * @returns {Array<{color:number, mesh:THREE.Mesh, bounds:THREE.Box3}>}
 */
function _collectVisibleCapCandidates(renderRoots, fallbackColor) {
  const candidates = [];

  for (const { type, root } of normalizeRenderRoots(renderRoots)) {
    if (type && EXCLUDED_ELEMENT_TYPES.has(type)) continue;

    root.traverseVisible((child) => {
      const childType = child.userData?.elementType || type;
      if (childType && EXCLUDED_ELEMENT_TYPES.has(childType)) return;
      if (
        !(child instanceof THREE.Mesh) ||
        child.userData?.isSectionBox === true ||
        child.userData?.isStencilCap === true ||
        child.userData?.isOverlayModelB === true ||
        !_hasVisibleMaterial(child)
      ) {
        return;
      }

      const bounds = _getWorldBoundingBox(child);
      if (!bounds) return;

      candidates.push({
        color: _extractMeshColorHex(child, fallbackColor),
        mesh: child,
        bounds,
      });
    });
  }

  return candidates;
}

/**
 * AABBについてPlane signed distanceの最小/最大値を求める。
 * 全8頂点を生成せず、中心+support radiusで判定する。
 * @param {THREE.Box3} box
 * @param {THREE.Plane} plane
 */
function _getPlaneDistanceRange(box, plane) {
  const center = box.getCenter(new THREE.Vector3());
  const halfSize = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const centerDistance = plane.distanceToPoint(center);
  const radius =
    Math.abs(plane.normal.x) * halfSize.x +
    Math.abs(plane.normal.y) * halfSize.y +
    Math.abs(plane.normal.z) * halfSize.z;

  return {
    min: centerDistance - radius,
    max: centerDistance + radius,
  };
}

/**
 * 対象Planeを実際に横切り、かつ他のSectionBox面の保持側へ到達し得るか。
 * bbox prefilterなので多少のfalse positiveは許容するが、false negativeは避ける。
 * @param {THREE.Box3} bounds
 * @param {THREE.Plane} targetPlane
 * @param {THREE.Plane[]} otherPlanes
 */
function _boundsCanContributeToCap(bounds, targetPlane, otherPlanes) {
  const targetRange = _getPlaneDistanceRange(bounds, targetPlane);

  // 単なる接触や完全片側は切断ではない。Plane両側へbboxが存在する場合だけ残す。
  if (targetRange.min >= -CAP_INTERSECTION_EPSILON || targetRange.max <= CAP_INTERSECTION_EPSILON) {
    return false;
  }

  // 他のbox面のうち1面でも完全にクリップ側なら、そのMeshは対象cap領域へ寄与しない。
  for (const plane of otherPlanes) {
    const range = _getPlaneDistanceRange(bounds, plane);
    if (range.max < -CAP_INTERSECTION_EPSILON) return false;
  }

  return true;
}

/**
 * 1つのSectionBox面について、実際に切断候補となるMeshだけを色別にまとめる。
 * @param {Array<{color:number, mesh:THREE.Mesh, bounds:THREE.Box3}>} candidates
 * @param {THREE.Plane} targetPlane
 * @param {THREE.Plane[]} otherPlanes
 * @returns {Array<{color:number, meshes:THREE.Mesh[]}>}
 */
function _groupCapCandidatesForPlane(candidates, targetPlane, otherPlanes) {
  const colorToMeshes = new Map();

  for (const candidate of candidates) {
    if (!_boundsCanContributeToCap(candidate.bounds, targetPlane, otherPlanes)) continue;

    if (!colorToMeshes.has(candidate.color)) {
      colorToMeshes.set(candidate.color, []);
    }
    colorToMeshes.get(candidate.color).push(candidate.mesh);
  }

  return Array.from(colorToMeshes.entries()).map(([color, meshes]) => ({ color, meshes }));
}

/**
 * メッシュの表示色(HEX)を抽出する
 * @param {THREE.Mesh} mesh
 * @param {number} fallbackColor
 * @returns {number}
 */
function _extractMeshColorHex(mesh, fallbackColor) {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const mat of materials) {
    if (!mat || mat.visible === false || !mat.color || !mat.color.isColor) continue;
    return mat.color.getHex();
  }
  return fallbackColor;
}

/**
 * ステンシル書き込み用マテリアルを作成する
 * @param {THREE.Side} side
 * @param {number} stencilZPass
 * @param {THREE.Plane[]} clippingPlanes - 対象断面のクリッピング平面（通常1面）
 * @returns {THREE.MeshBasicMaterial}
 */
export function createStencilMaterial(side, stencilZPass, clippingPlanes) {
  return new THREE.MeshBasicMaterial({
    side,
    // 対象断面自身でジオメトリを開き、背面の加算と前面の減算の不均衡を
    // その断面位置だけに発生させる。
    depthTest: false,
    depthWrite: false,
    colorWrite: false,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass,
    clippingPlanes,
  });
}

/**
 * ステンシル書き込み用メッシュを作成する
 * ジオメトリは元メッシュと共有し、ワールド行列とlayerをコピーする。
 * @param {THREE.Mesh} src - 元のメッシュ
 * @param {THREE.Material} material
 * @param {number} renderOrder
 * @returns {THREE.Mesh}
 */
function _makeStencilMesh(src, material, renderOrder) {
  const mesh = new THREE.Mesh(src.geometry, material);
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(src.matrixWorld);
  mesh.layers.mask = src.layers.mask;
  mesh.renderOrder = renderOrder;
  mesh.userData.isStencilCap = true;
  return mesh;
}

/**
 * キャップ平面メッシュを作成する
 * @param {THREE.Plane} clipPlane - 対象のクリッピング平面
 * @param {THREE.Plane[]} otherPlanes - 他のクリッピング平面（このキャップをクリップする）
 * @param {number} capColor
 * @param {number} renderOrder
 * @returns {THREE.Mesh}
 */
export function createCapPlaneMesh(clipPlane, otherPlanes, capColor, renderOrder) {
  const geometry = new THREE.PlaneGeometry(CAP_PLANE_SIZE, CAP_PLANE_SIZE);

  const material = createCapMaterial(capColor, otherPlanes);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = renderOrder;
  mesh.userData.isStencilCap = true;

  // クリッピング平面の位置と向きに正確に合わせる。
  // 平面方程式: normal·point + constant = 0  →  point = normal * (-constant)
  const planePoint = clipPlane.normal.clone().multiplyScalar(-clipPlane.constant);
  mesh.position.copy(planePoint);

  // PlaneGeometry は +Z 向きなので clipPlane.normal 方向に回転
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    clipPlane.normal.clone(),
  );
  mesh.quaternion.copy(q);

  return mesh;
}

/**
 * 断面キャップ用マテリアルを作成する
 * @param {number} capColor
 * @param {THREE.Plane[]} clippingPlanes - 対象断面を除く他のクリッピング平面
 * @returns {THREE.MeshBasicMaterial}
 */
export function createCapMaterial(capColor, clippingPlanes) {
  return new THREE.MeshBasicMaterial({
    color: capColor,
    side: THREE.DoubleSide,
    // 通常面より手前にある切断面だけを描く。
    depthTest: true,
    // キャップ同士や後続の比較オーバーレイの深度を汚染しない。
    // 切断面の可視性はステンシルで決まるため、深度書き込みは不要。
    depthWrite: false,
    // 既存面と同一深度の場合は既存面を優先し、z-fightingを避ける。
    depthFunc: THREE.LessDepth,
    stencilWrite: true,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilRef: 0,
    stencilFail: THREE.ZeroStencilOp,
    stencilZFail: THREE.ZeroStencilOp,
    stencilZPass: THREE.ZeroStencilOp,
    clippingPlanes,
  });
}
