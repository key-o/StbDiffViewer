/**
 * @fileoverview 床形状生成モジュール
 *
 * BaseElementGeneratorを継承した統一アーキテクチャ:
 * - 複数ノード（StbNodeIdOrder）による多角形形状
 * - 各ノードへのオフセット対応（StbSlabOffset）
 * - 厚さ（depth）による押し出し形状
 * - STB形式とJSON形式の両対応
 *
 * 作成: 2025-12
 */

import * as THREE from 'three';
import { colorManager } from '../../rendering/colorManager.js';
import { BaseElementGenerator } from '../core/BaseElementGenerator.js';

/**
 * 床形状生成クラス
 */
export class SlabGenerator extends BaseElementGenerator {
  /**
   * ジェネレーター設定
   */
  static getConfig() {
    return {
      elementName: 'Slab',
      loggerName: 'viewer:geometry:slab',
      defaultElementType: 'Slab',
    };
  }

  /**
   * 床要素からメッシュを作成
   * @param {Array} slabElements - 床要素配列
   * @param {Map<string, THREE.Vector3>} nodes - ノードマップ
   * @param {Map<string, Object>} slabSections - 床断面マップ
   * @param {Map<string, Object>} steelSections - 鋼材形状マップ（未使用だがインターフェース統一のため）
   * @param {string} elementType - 要素タイプ（デフォルト: "Slab"）
   * @param {boolean} isJsonInput - JSON入力かどうか
   * @returns {Array<THREE.Mesh>} 生成されたメッシュ配列
   */
  static createSlabMeshes(
    slabElements,
    nodes,
    slabSections,
    steelSections,
    elementType = 'Slab',
    isJsonInput = false,
  ) {
    return this.createMeshes(
      slabElements,
      nodes,
      slabSections,
      steelSections,
      elementType,
      isJsonInput,
    );
  }

  /**
   * 単一床メッシュを作成（BaseElementGeneratorの抽象メソッドを実装）
   * @param {Object} slab - 床要素
   * @param {Object} context - コンテキスト
   * @returns {THREE.Mesh|null} メッシュまたはnull
   */
  static _createSingleMesh(slab, context) {
    const { nodes, sections, elementType, isJsonInput, log } = context;

    // 1. ノードIDリストの取得
    const nodeIds = slab.node_ids;
    if (!nodeIds || nodeIds.length < 3) {
      log.warn(`Skipping slab ${slab.id}: Insufficient nodes (need at least 3)`);
      return null;
    }

    // 2. 各ノードの座標を取得（オフセット適用）
    const vertices = [];
    const offsets = slab.offsets || new Map();

    for (const nodeId of nodeIds) {
      const node = nodes.get(nodeId);
      if (!node) {
        log.warn(`Skipping slab ${slab.id}: Node ${nodeId} not found`);
        return null;
      }

      // オフセットを適用
      const offset = offsets.get ? offsets.get(nodeId) : offsets[nodeId];
      const offsetX = offset?.offset_X || 0;
      const offsetY = offset?.offset_Y || 0;
      const offsetZ = offset?.offset_Z || 0;

      vertices.push(new THREE.Vector3(node.x + offsetX, node.y + offsetY, node.z + offsetZ));
    }

    // 3. 断面データの取得（厚さ）
    let depth = 150; // デフォルト厚さ (mm)

    if (sections) {
      // 型統一: sectionExtractorは数値IDを整数として保存するため変換
      const rawId = slab.id_section;
      const parsedId = parseInt(rawId, 10);
      const sectionId = isNaN(parsedId) ? rawId : parsedId;
      const sectionData = sections.get(sectionId);
      if (sectionData) {
        // depth属性を取得（様々なパターンに対応）
        depth =
          sectionData.depth ||
          sectionData.dimensions?.depth ||
          sectionData.t ||
          sectionData.thickness ||
          150;
      }
    }

    log.debug(`Creating slab ${slab.id}: ${vertices.length} vertices, depth=${depth}mm`);

    // 4. 頂点の中心を計算
    const center = new THREE.Vector3();
    for (const v of vertices) {
      center.add(v);
    }
    center.divideScalar(vertices.length);

    // 5. スラブ平面の法線ベクトルを計算（傾斜対応）
    const normal = this._calculatePlaneNormal(vertices);

    // 法線が下向きの場合は反転（スラブは上面が基準）
    if (normal.z < 0) {
      normal.negate();
    }

    // 6. 水平スラブの高速パス（大多数のケース）
    // 法線がほぼ(0,0,1)の場合、ExtrudeGeometry を避けて直接 BufferGeometry を構築
    const isHorizontal = Math.abs(normal.z) > 0.999;
    let geometry;

    if (isHorizontal && this._isConvexPolygon(vertices)) {
      geometry = this._createHorizontalSlabGeometry(vertices, center, depth);
    } else {
      geometry = this._createInclinedSlabGeometry(vertices, center, normal, depth);
    }

    if (!this._validateGeometry(geometry, slab, context)) {
      return null;
    }

    // 10. メッシュ作成
    const mesh = new THREE.Mesh(
      geometry,
      colorManager.getMaterial('diff', { comparisonState: 'matched' }),
    );

    // 11. 配置（中心位置に配置）
    mesh.position.copy(center);

    // 12. メタデータ設定
    const topZ = center.z;
    const bottomZ = topZ - depth * normal.z; // 傾斜を考慮した下面Z

    mesh.userData = {
      id: slab.id,
      elementId: slab.id, // プロパティ表示用に追加
      name: slab.name || `Slab_${slab.id}`,
      elementType: elementType,
      stbElementId: slab.id,
      isSTB: !isJsonInput,
      sectionId: slab.id_section,
      slabData: {
        nodeIds: nodeIds,
        depth: depth,
        topZ: topZ,
        bottomZ: bottomZ,
        vertexCount: vertices.length,
        kind_structure: slab.kind_structure,
        kind_slab: slab.kind_slab,
        isFoundation: slab.isFoundation,
        // 傾斜情報を追加
        normal: { x: normal.x, y: normal.y, z: normal.z },
        isInclined: Math.abs(normal.z) < 0.999, // 水平でない場合true
      },
    };

    log.debug(
      `Slab ${slab.id}: center=(${center.x.toFixed(0)}, ${center.y.toFixed(0)}, ${center.z.toFixed(0)}), ` +
        `normal=(${normal.x.toFixed(3)}, ${normal.y.toFixed(3)}, ${normal.z.toFixed(3)}), ` +
        `isInclined=${mesh.userData.slabData.isInclined}`,
    );

    return mesh;
  }

  /**
   * 水平スラブの高速ジオメトリ生成
   * ExtrudeGeometry を避け、直接頂点データから BufferGeometry を構築
   * @param {Array<THREE.Vector3>} vertices - 頂点配列
   * @param {THREE.Vector3} center - 中心座標
   * @param {number} depth - スラブ厚さ
   * @returns {THREE.BufferGeometry} ジオメトリ
   */
  static _createHorizontalSlabGeometry(vertices, center, depth) {
    const n = vertices.length;
    const isCounterClockwise = this._calculateSignedAreaXY(vertices) >= 0;

    // 上面と下面の頂点を構築（center相対座標）
    const positions = [];
    const indices = [];

    // 上面の頂点 (0..n-1)
    for (const v of vertices) {
      positions.push(v.x - center.x, v.y - center.y, v.z - center.z);
    }
    // 下面の頂点 (n..2n-1)
    for (const v of vertices) {
      positions.push(v.x - center.x, v.y - center.y, v.z - center.z - depth);
    }

    // 上面のファン三角形分割
    for (let i = 1; i < n - 1; i++) {
      if (isCounterClockwise) {
        indices.push(0, i, i + 1);
      } else {
        indices.push(0, i + 1, i);
      }
    }
    // 下面のファン三角形分割（逆回り）
    for (let i = 1; i < n - 1; i++) {
      if (isCounterClockwise) {
        indices.push(n, n + i + 1, n + i);
      } else {
        indices.push(n, n + i, n + i + 1);
      }
    }
    // 側面。上面/下面だけでなく側面も外向き法線になるよう winding を揃える。
    // StencilCap は FrontSide / BackSide の差分で断面を求めるため、
    // 側面が内向きだと水平スラブだけ winding が不整合になり、cap が面全体へ漏れる。
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      if (isCounterClockwise) {
        indices.push(i, n + next, next);
        indices.push(i, n + i, n + next);
      } else {
        indices.push(i, next, n + next);
        indices.push(i, n + next, n + i);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    const flatGeometry = geometry.toNonIndexed();
    geometry.dispose();
    flatGeometry.computeVertexNormals();
    return flatGeometry;
  }

  /**
   * XY平面上の符号付き面積を計算する
   * @param {Array<THREE.Vector3>} vertices - 頂点配列
   * @returns {number} 反時計回りなら正、時計回りなら負
   */
  static _calculateSignedAreaXY(vertices) {
    let area = 0;
    const n = vertices.length;
    for (let i = 0; i < n; i++) {
      const current = vertices[i];
      const next = vertices[(i + 1) % n];
      area += current.x * next.y - next.x * current.y;
    }
    return area / 2;
  }

  /**
   * 傾斜スラブのジオメトリ生成（従来のExtrudeGeometry方式）
   * @param {Array<THREE.Vector3>} vertices - 頂点配列
   * @param {THREE.Vector3} center - 中心座標
   * @param {THREE.Vector3} normal - 法線ベクトル
   * @param {number} depth - スラブ厚さ
   * @returns {THREE.BufferGeometry} ジオメトリ
   */
  static _createInclinedSlabGeometry(vertices, center, normal, depth) {
    const localZ = normal.clone().normalize();
    const upVector =
      Math.abs(localZ.z) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    const localX = new THREE.Vector3().crossVectors(upVector, localZ).normalize();
    const localY = new THREE.Vector3().crossVectors(localZ, localX).normalize();

    // 頂点をローカル座標系に投影して2D形状を作成
    const shape = new THREE.Shape();
    const localVertices2D = [];

    for (const vertex of vertices) {
      const relX = vertex.x - center.x;
      const relY = vertex.y - center.y;
      const relZ = vertex.z - center.z;
      const localX2D = relX * localX.x + relY * localX.y + relZ * localX.z;
      const localY2D = relX * localY.x + relY * localY.y + relZ * localY.z;
      localVertices2D.push({ x: localX2D, y: localY2D });
    }

    shape.moveTo(localVertices2D[0].x, localVertices2D[0].y);
    for (let i = 1; i < localVertices2D.length; i++) {
      shape.lineTo(localVertices2D[i].x, localVertices2D[i].y);
    }
    shape.closePath();

    const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    geometry.translate(0, 0, -depth);

    const rotationMatrix = new THREE.Matrix4();
    rotationMatrix.makeBasis(localX, localY, localZ);
    geometry.applyMatrix4(rotationMatrix);
    return geometry;
  }

  /**
   * 頂点群からスラブ平面の法線ベクトルを計算
   * 3点以上の頂点から最適な平面を求める
   * @param {Array<THREE.Vector3>} vertices - 頂点配列
   * @returns {THREE.Vector3} 法線ベクトル（正規化済み）
   */
  static _calculatePlaneNormal(vertices) {
    if (vertices.length < 3) {
      // 頂点が3未満の場合はZ軸上向きを返す
      return new THREE.Vector3(0, 0, 1);
    }

    if (vertices.length === 3 || vertices.length === 4) {
      // 3-4点の場合は最初の3点の外積で計算（clone不要）
      const ax = vertices[1].x - vertices[0].x;
      const ay = vertices[1].y - vertices[0].y;
      const az = vertices[1].z - vertices[0].z;
      const bx = vertices[2].x - vertices[0].x;
      const by = vertices[2].y - vertices[0].y;
      const bz = vertices[2].z - vertices[0].z;
      const normal = new THREE.Vector3(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);

      if (normal.lengthSq() < 1e-10) {
        // 3点が同一直線上の場合
        return new THREE.Vector3(0, 0, 1);
      }

      return normal.normalize();
    }

    // 4点以上の場合：Newell's method で平均法線を計算
    // これにより、完全に平面でない頂点群でも最適な平面を求められる
    const normal = new THREE.Vector3(0, 0, 0);
    const n = vertices.length;

    for (let i = 0; i < n; i++) {
      const current = vertices[i];
      const next = vertices[(i + 1) % n];

      // Newell's method: 各辺の寄与を累積
      normal.x += (current.y - next.y) * (current.z + next.z);
      normal.y += (current.z - next.z) * (current.x + next.x);
      normal.z += (current.x - next.x) * (current.y + next.y);
    }

    if (normal.lengthSq() < 1e-10) {
      // 法線が計算できない場合（全頂点が同一直線上など）
      return new THREE.Vector3(0, 0, 1);
    }

    return normal.normalize();
  }

  /**
   * 頂点群が凸ポリゴンかどうかを判定（XY平面）
   * ファン三角形分割は凸ポリゴンでのみ正しいため、凹ポリゴンは ExtrudeGeometry にフォールバック
   * @param {Array<THREE.Vector3>} vertices - 頂点配列
   * @returns {boolean} 凸ポリゴンならtrue
   */
  static _isConvexPolygon(vertices) {
    const n = vertices.length;
    if (n <= 3) return true;

    let sign = 0;
    for (let i = 0; i < n; i++) {
      const a = vertices[i];
      const b = vertices[(i + 1) % n];
      const c = vertices[(i + 2) % n];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) < 1e-10) continue;
      if (sign === 0) {
        sign = cross > 0 ? 1 : -1;
      } else if ((cross > 0 ? 1 : -1) !== sign) {
        return false;
      }
    }
    return true;
  }
}

// デバッグ・開発支援
if (typeof window !== 'undefined') {
  window.SlabGenerator = SlabGenerator;
}

export default SlabGenerator;
