/**
 * @fileoverview フラスタムカリングモジュール
 *
 * カメラの視錐台（フラスタム）外のオブジェクトを非表示にし、
 * レンダリング負荷を軽減します。
 */

import * as THREE from 'three';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('viewer:FrustumCuller');

/**
 * フラスタムカリングを管理するクラス
 */
export class FrustumCuller {
  /**
   * @param {THREE.Camera} camera - カリングに使用するカメラ
   */
  constructor(camera) {
    /** @type {THREE.Frustum} */
    this.frustum = new THREE.Frustum();

    /** @type {THREE.Matrix4} */
    this.projScreenMatrix = new THREE.Matrix4();

    /** @type {THREE.Camera} */
    this.camera = camera;

    /** @type {boolean} カリングの有効/無効 */
    this.enabled = true;

    /** @type {number} バウンディングスフィアのマージン（%） */
    this.margin = 1.1;

    /** @type {number} 最後のカリングで非表示にした要素数 */
    this.culledCount = 0;

    /** @type {number} 最後のカリングで表示した要素数 */
    this.visibleCount = 0;

    /** @type {THREE.Sphere} 再利用用の一時スフィア */
    this._tempSphere = new THREE.Sphere();

    /** @type {THREE.Box3} 再利用用の一時ボックス */
    this._tempBox = new THREE.Box3();

    /** Meshes hidden by this culler (not by the user display filters). */
    this._autoHidden = new Set();
  }

  /**
   * カメラを設定
   * @param {THREE.Camera} camera
   */
  setCamera(camera) {
    this.camera = camera;
  }

  /**
   * フラスタムを更新（カメラが移動した際に呼び出し）
   */
  update() {
    if (!this.camera) return;

    this.projScreenMatrix.multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);
  }

  /**
   * オブジェクトがフラスタム内にあるかチェック
   * @param {THREE.Object3D} object - チェックするオブジェクト
   * @returns {boolean} フラスタム内ならtrue
   */
  isVisible(object) {
    if (!this.enabled) return true;

    // ジオメトリがない場合は常に表示
    if (!object.geometry) return true;

    // バウンディングスフィアを計算（なければ計算）
    if (!object.geometry.boundingSphere) {
      object.geometry.computeBoundingSphere();
    }

    const boundingSphere = object.geometry.boundingSphere;
    if (!boundingSphere) return true;

    // ワールド座標系でのスフィアを計算
    this._tempSphere.copy(boundingSphere);
    this._tempSphere.applyMatrix4(object.matrixWorld);

    // マージンを適用
    this._tempSphere.radius *= this.margin;

    return this.frustum.intersectsSphere(this._tempSphere);
  }

  /**
   * シーン全体にカリングを適用
   * @param {THREE.Scene} scene - カリングを適用するシーン
   */
  cullScene(scene) {
    if (!this.enabled || !scene) return;

    this.update();
    this.culledCount = 0;
    this.visibleCount = 0;

    scene.traverse((object) => {
      // メッシュのみ処理
      if (!object.isMesh) return;

      // カリング対象外のオブジェクトをスキップ
      if (object.userData && object.userData.skipCulling) return;

      const visible = this.isVisible(object);
      object.visible = visible;

      if (visible) {
        this.visibleCount++;
      } else {
        this.culledCount++;
      }
    });
  }

  /**
   * 要素グループにカリングを適用
   * @param {Object<string, THREE.Group>} elementGroups - 要素グループ
   */
  cullElementGroups(elementGroups) {
    if (!this.enabled || !elementGroups) return;

    this.update();
    this.culledCount = 0;
    this.visibleCount = 0;

    for (const groupName in elementGroups) {
      const group = elementGroups[groupName];
      if (!group || !group.children) continue;

      for (const child of group.children) {
        if (!child.isMesh) continue;
        if (child.userData && child.userData.skipCulling) continue;

        const visible = this.isVisible(child);
        if (!visible && child.visible) {
          this._autoHidden.add(child);
          child.visible = false;
        } else if (visible && this._autoHidden.delete(child)) {
          child.visible = true;
        }

        if (visible) {
          this.visibleCount++;
        } else {
          this.culledCount++;
        }
      }
    }
  }

  /** AR開始時にカリングだけが非表示にしたメッシュを戻す。 */
  restoreCulledVisibility() {
    for (const child of this._autoHidden) {
      child.visible = true;
    }
    this._autoHidden.clear();
    this.culledCount = 0;
  }

  /**
   * すべてのオブジェクトを表示状態に戻す
   * @param {THREE.Scene} scene
   */
  showAll(scene) {
    if (!scene) return;

    scene.traverse((object) => {
      if (object.isMesh) {
        object.visible = true;
      }
    });

    this.culledCount = 0;
    this.visibleCount = 0;
  }

  /**
   * 要素グループのすべてのオブジェクトを表示状態に戻す
   * @param {Object<string, THREE.Group>} elementGroups
   */
  showAllInGroups(elementGroups) {
    if (!elementGroups) return;

    for (const groupName in elementGroups) {
      const group = elementGroups[groupName];
      if (!group || !group.children) continue;

      for (const child of group.children) {
        if (child.isMesh) {
          child.visible = true;
        }
      }
    }

    this.culledCount = 0;
    this.visibleCount = 0;
  }

  /**
   * カリングの有効/無効を切り替え
   * @param {boolean} enabled
   * @param {THREE.Scene} [scene] - 無効時にすべて表示するためのシーン
   */
  setEnabled(enabled, scene = null) {
    this.enabled = enabled;
    log.info(`FrustumCuller ${enabled ? 'enabled' : 'disabled'}`);

    // 無効化時はすべて表示
    if (!enabled && scene) {
      this.showAll(scene);
    }
  }

  /**
   * 統計情報を取得
   * @returns {Object}
   */
  getStats() {
    return {
      enabled: this.enabled,
      culledCount: this.culledCount,
      visibleCount: this.visibleCount,
      totalCount: this.culledCount + this.visibleCount,
      cullRatio:
        this.culledCount + this.visibleCount > 0
          ? (this.culledCount / (this.culledCount + this.visibleCount)) * 100
          : 0,
    };
  }
}

// シングルトンインスタンス
let instance = null;

/**
 * グローバルなFrustumCullerインスタンスを取得
 * @param {THREE.Camera} [camera] - 初回作成時のカメラ
 * @returns {FrustumCuller}
 */
export function getFrustumCuller(camera) {
  if (!instance) {
    instance = new FrustumCuller(camera);
    log.info('FrustumCuller initialized');
  } else if (camera && instance.camera !== camera) {
    instance.setCamera(camera);
  }
  return instance;
}
