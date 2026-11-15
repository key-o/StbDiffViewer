/**
 * @fileoverview AR空間へのモデル配置モジュール
 *
 * ヒットテスト結果に基づくレティクル表示とモデル配置を管理します。
 * ARルートグループの変換（Z-up→Y-up回転、mm→mスケール、底面中心アンカー、
 * 鉛直軸回転）はすべてこのクラスが一元管理します。
 */

import * as THREE from 'three';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('viewer/ar/arPlacement');

/** mm→m スケール変換係数（ビューアはmm単位、WebXRはm単位） */
export const MM_TO_M = 0.001;
/** 既定の縮尺（卓上模型モード 1/100） */
export const DEFAULT_SCALE_FACTOR = 1 / 100;
/** 縮尺の下限（1/500） */
export const MIN_SCALE_FACTOR = 1 / 500;
/** 縮尺の上限（実寸） */
export const MAX_SCALE_FACTOR = 1;

/** アンカー追従で配置点を更新する際の最小移動量（m）。微小なポーズ揺れは無視する */
export const ANCHOR_UPDATE_EPSILON_M = 0.0005;

/** 水平面からの最大傾き（法線と鉛直軸の内積の絶対値）。約30°まで許容 */
export const MIN_HORIZONTAL_NORMAL_Y = Math.cos(Math.PI / 6);

/** XRヒットの姿勢行列が水平面（床・机）を示すか判定する */
export function isHorizontalHitTransform(transform) {
  if (!transform?.matrix || transform.matrix.length !== 16) return false;
  const m = transform.matrix;
  // 姿勢行列の第2列は、ヒット面のローカルY（面法線）のワールド方向。
  const length = Math.hypot(m[4], m[5], m[6]);
  return length > 0 && Math.abs(m[5] / length) >= MIN_HORIZONTAL_NORMAL_Y;
}

/** ビューアのZ-up座標をWebXRのY-up座標へ変換する回転 */
const Z_UP_TO_Y_UP = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  -Math.PI / 2,
);

/**
 * AR空間でのモデル配置を管理
 */
export class ArPlacement {
  /**
   * @param {THREE.Scene} scene - Three.jsシーン
   */
  constructor(scene) {
    this._scene = scene;
    /** @type {THREE.Group|null} ARルートグループ */
    this._arRoot = null;
    /** @type {THREE.Mesh|null} 配置位置を示すレティクル */
    this._reticle = null;
    /** @type {boolean} モデルが配置済みかどうか */
    this._placed = false;
    /** @type {boolean} 有効なヒットテスト結果を保持しているか */
    this._hasValidHit = false;
    /** @type {THREE.Matrix4} 最後のヒットテスト変換行列 */
    this._lastHitMatrix = new THREE.Matrix4();
    /** @type {THREE.Vector3} 配置確定点（ワールド座標、m） */
    this._placementPoint = new THREE.Vector3();
    /** @type {THREE.Vector3} モデル底面中心（モデル座標、mm、Z-up） */
    this._bottomCenter = new THREE.Vector3();
    /** @type {number} 縮尺係数（1.0 = 実寸） */
    this._scaleFactor = DEFAULT_SCALE_FACTOR;
    /** @type {number} 鉛直軸まわりの回転角（rad） */
    this._rotationY = 0;
  }

  /**
   * 初期化（ARセッション開始時に呼ばれる）
   * @param {THREE.Group} arRoot - ARルートグループ
   */
  init(arRoot) {
    this._arRoot = arRoot;
    this._placed = false;
    this._hasValidHit = false;
    this._lastHitMatrix.identity();
    this._rotationY = 0;
    this._scaleFactor = DEFAULT_SCALE_FACTOR;

    // レティクル（配置位置インジケータ）を作成
    this._reticle = this._createReticle();
    this._scene.add(this._reticle);
    this._reticle.visible = false;

    log.info('AR配置マネージャを初期化しました');
  }

  /**
   * レティクルを作成
   * @private
   * @returns {THREE.Mesh}
   */
  _createReticle() {
    const geometry = new THREE.RingGeometry(0.08, 0.1, 32);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      color: 0x00ff88,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  /**
   * ヒットテスト結果でレティクル位置を更新
   * @param {XRRigidTransform} transform - ヒットテスト結果の変換
   */
  updateReticle(transform) {
    if (!this._reticle || this._placed) return false;
    if (!isHorizontalHitTransform(transform)) {
      this.clearReticle();
      return false;
    }

    this._reticle.visible = true;
    this._lastHitMatrix.fromArray(transform.matrix);
    this._reticle.matrix.copy(this._lastHitMatrix);
    this._hasValidHit = true;
    return true;
  }

  /**
   * ヒットテスト結果がない場合にレティクルをクリア
   */
  clearReticle() {
    if (!this._reticle || this._placed) return;
    this._reticle.visible = false;
    this._hasValidHit = false;
  }

  /**
   * 現在のレティクル位置にモデルを配置確定
   *
   * モデルのバウンディングボックス底面中心がヒット位置に一致するように
   * 配置します。ヒットポーズの姿勢は無視し、モデルは常に直立させます。
   * @returns {boolean} 配置に成功したか
   */
  confirmPlacement() {
    if (!this._arRoot || this._placed) return false;
    if (!this._hasValidHit) {
      log.warn('ヒットテスト結果がないため、AR配置をスキップしました');
      return false;
    }

    // ヒット位置のみ採用（姿勢は無視してモデルを直立させる）
    this._placementPoint.setFromMatrixPosition(this._lastHitMatrix);
    this._bottomCenter.copy(this._computeBottomCenter());

    this._applyArRootTransform();
    this._arRoot.visible = true;
    this._placed = true;

    // レティクルを非表示
    if (this._reticle) {
      this._reticle.visible = false;
    }

    log.info('モデルをAR空間に配置しました', {
      x: this._placementPoint.x.toFixed(3),
      y: this._placementPoint.y.toFixed(3),
      z: this._placementPoint.z.toFixed(3),
      scale: this._scaleFactor,
    });
    return true;
  }

  /**
   * 縮尺係数を設定（配置済みの場合は底面中心を固定したまま拡縮）
   * @param {number} factor - 縮尺係数（1.0 = 実寸）
   * @returns {number} クランプ後に適用された縮尺係数
   */
  setScaleFactor(factor) {
    const clamped = Math.min(
      MAX_SCALE_FACTOR,
      Math.max(MIN_SCALE_FACTOR, Number(factor) || DEFAULT_SCALE_FACTOR),
    );
    this._scaleFactor = clamped;
    if (this._placed) {
      this._applyArRootTransform();
    }
    return clamped;
  }

  /**
   * 現在の縮尺係数
   * @returns {number}
   */
  get scaleFactor() {
    return this._scaleFactor;
  }

  /**
   * 配置点をアンカーの最新ポーズへ更新する（FR-6.5: トラッキングドリフト補正）
   *
   * 未配置時は何もしない。移動量が ANCHOR_UPDATE_EPSILON_M 未満の場合は
   * 揺れとみなして変換の再計算を省略する。
   * @param {number} x - アンカー位置X（ワールド座標、m）
   * @param {number} y - アンカー位置Y（ワールド座標、m）
   * @param {number} z - アンカー位置Z（ワールド座標、m）
   * @returns {boolean} 配置点を更新したか
   */
  updatePlacementPoint(x, y, z) {
    if (!this._placed) return false;
    if (![x, y, z].every(Number.isFinite)) return false;
    const dx = x - this._placementPoint.x;
    const dy = y - this._placementPoint.y;
    const dz = z - this._placementPoint.z;
    if (dx * dx + dy * dy + dz * dz < ANCHOR_UPDATE_EPSILON_M * ANCHOR_UPDATE_EPSILON_M) {
      return false;
    }
    this._placementPoint.set(x, y, z);
    this._applyArRootTransform();
    return true;
  }

  /**
   * 鉛直軸まわりにモデルを回転（底面中心を固定）
   * @param {number} deltaRadians - 回転角の増分（rad）
   */
  rotateBy(deltaRadians) {
    if (!Number.isFinite(deltaRadians)) return;
    this._rotationY += deltaRadians;
    if (this._placed) {
      this._applyArRootTransform();
    }
  }

  /**
   * 現在の鉛直軸回転角（rad）
   * @returns {number}
   */
  get rotationY() {
    return this._rotationY;
  }

  /**
   * ARルートの変換を更新
   * 底面中心（モデル座標）が配置点（ワールド座標）に一致するよう、
   * pos = hit - s * (Q * bottomCenter) を適用する。Q = Ry(θ) * Rx(-90°)
   * @private
   */
  _applyArRootTransform() {
    if (!this._arRoot) return;

    const q = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), this._rotationY)
      .multiply(Z_UP_TO_Y_UP);
    const s = MM_TO_M * this._scaleFactor;

    const anchorOffset = this._bottomCenter.clone().applyQuaternion(q).multiplyScalar(s);

    this._arRoot.quaternion.copy(q);
    this._arRoot.scale.setScalar(s);
    this._arRoot.position.copy(this._placementPoint).sub(anchorOffset);
    this._arRoot.updateMatrixWorld(true);
  }

  /**
   * モデル全体のバウンディングボックス底面中心を計算（モデル座標、mm、Z-up）
   * @private
   * @returns {THREE.Vector3}
   */
  _computeBottomCenter() {
    const root = this._arRoot;
    if (!root) return new THREE.Vector3();

    // 一時的に変換をリセットしてモデル座標系でバウンディングボックスを取得
    const prevPosition = root.position.clone();
    const prevQuaternion = root.quaternion.clone();
    const prevScale = root.scale.clone();
    root.position.set(0, 0, 0);
    root.quaternion.identity();
    root.scale.set(1, 1, 1);
    root.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(root);

    root.position.copy(prevPosition);
    root.quaternion.copy(prevQuaternion);
    root.scale.copy(prevScale);
    root.updateMatrixWorld(true);

    if (box.isEmpty()) {
      log.warn('モデルのバウンディングボックスが空のため、原点を配置基準にします');
      return new THREE.Vector3();
    }
    return new THREE.Vector3((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.min.z);
  }

  /**
   * 配置をリセット（再配置可能にする）
   */
  resetPlacement() {
    this._placed = false;
    this._hasValidHit = false;
    if (this._arRoot) {
      this._arRoot.visible = false;
    }
    if (this._reticle) {
      this._reticle.visible = false;
    }
    log.info('AR配置をリセットしました');
  }

  /**
   * モデルが配置済みかどうか
   * @returns {boolean}
   */
  get isPlaced() {
    return this._placed;
  }

  /**
   * 有効なヒットテスト結果を保持しているか
   * @returns {boolean}
   */
  get hasValidHit() {
    return this._hasValidHit;
  }

  /**
   * リソースを解放
   */
  dispose() {
    if (this._reticle) {
      this._reticle.geometry.dispose();
      this._reticle.material.dispose();
      this._scene.remove(this._reticle);
      this._reticle = null;
    }
    this._arRoot = null;
    this._placed = false;
    this._hasValidHit = false;
    log.info('AR配置マネージャをクリーンアップしました');
  }
}
