/**
 * @fileoverview インタラクティブ・セクションボックス
 *
 * Revit風の切断ボックス。各面にドラッグ可能なハンドルを配置し、
 * マウス操作でクリッピング範囲をリアルタイムに調整する。
 */

import * as THREE from 'three';
import {
  createAllHandles,
  positionHandles,
  setHandleState,
  updateHandleScale,
  exemptFromClipping,
} from './SectionBoxHandles.js';
import { StencilCapManager } from './StencilCapManager.js';
import { createBoxClippingPlanes } from './clippingPlaneFactory.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('viewer:sectionBox');

/** ボックスの最小サイズ (mm) */
const MIN_BOX_SIZE = 100;

/** ワイヤーフレームの色 */
const WIREFRAME_COLOR = 0x00aaff;

export class SectionBox {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Camera|(() => THREE.Camera)} cameraOrGetter
   * @param {THREE.WebGLRenderer} renderer
   * @param {HTMLElement} domElement - レンダラーのDOM要素
   * @param {Object} controls - OrbitControls互換コントロール
   */
  constructor(scene, cameraOrGetter, renderer, domElement, controls) {
    this._scene = scene;
    this._getCamera = typeof cameraOrGetter === 'function' ? cameraOrGetter : () => cameraOrGetter;
    this._renderer = renderer;
    this._domElement = domElement;
    this._controls = controls;

    this._active = false;
    this._box = new THREE.Box3();
    this._initialBox = new THREE.Box3();

    // ビジュアル要素
    this._group = new THREE.Group();
    this._group.name = 'SectionBoxGroup';
    this._group.userData.isSectionBox = true;
    this._wireframe = null;
    this._handles = [];

    // クリッピング平面（6面）
    this._clipPlanes = [];

    // セクションボックス起動前のクリッピング状態を保持する。
    // スタンシル断面生成時は renderer のグローバルクリッピングを使わず、
    // 通常要素の material.clippingPlanes に6面を設定する必要がある。
    this._previousRendererClippingPlanes = [];
    this._previousLocalClippingEnabled = false;
    this._materialClippingState = new Map();

    // スタンシルキャップ
    this._stencilCapManager = new StencilCapManager();

    // ドラッグ状態
    this._dragging = false;
    this._activeHandle = null;
    this._dragStartPoint = new THREE.Vector3();
    this._dragAxis = new THREE.Vector3();

    // Raycaster
    this._raycaster = new THREE.Raycaster();
    this._mouse = new THREE.Vector2();

    // ホバー状態
    this._hoveredHandle = null;
    this._activePointerId = null;

    // バウンドイベントハンドラー
    this._onPointerDownBound = this._onPointerDown.bind(this);
    this._onPointerMoveBound = this._onPointerMove.bind(this);
    this._onPointerUpBound = this._onPointerUp.bind(this);
  }

  /**
   * セクションボックスを起動する
   * @param {THREE.Box3} modelBounds - モデルのバウンディングボックス
   */
  activate(modelBounds) {
    if (this._active) {
      this.deactivate();
    }

    this._captureClippingState();
    this._box.copy(modelBounds);
    this._initialBox.copy(modelBounds);
    this._active = true;

    this._createWireframe();
    this._createHandles();
    this._updateClippingPlanes();
    this._refreshStencilCaps();

    this._scene.add(this._group);

    this._domElement.addEventListener('pointerdown', this._onPointerDownBound, true);
    this._domElement.addEventListener('pointermove', this._onPointerMoveBound);
    this._domElement.addEventListener('pointerup', this._onPointerUpBound);

    log.info('Section box activated');
  }

  /**
   * セクションボックスを非アクティブにする
   */
  deactivate() {
    if (!this._active) return;

    this._active = false;
    this._dragging = false;
    this._activeHandle = null;
    this._hoveredHandle = null;

    // イベントリスナー解除
    this._domElement.removeEventListener('pointerdown', this._onPointerDownBound, true);
    this._domElement.removeEventListener('pointermove', this._onPointerMoveBound);
    this._domElement.removeEventListener('pointerup', this._onPointerUpBound);

    // ビジュアル要素の除去
    this._scene.remove(this._group);
    this._disposeGroupContents();

    // スタンシルキャップ解除
    this._stencilCapManager.deactivate();

    // セクションボックス起動前のグローバル/ローカルクリッピング状態へ戻す
    this._restoreClippingState();
    this._clipPlanes = [];

    log.info('Section box deactivated');
  }

  /**
   * リソースの完全解放
   */
  dispose() {
    this.deactivate();
    this._scene = null;
    this._getCamera = null;
    this._renderer = null;
    this._domElement = null;
    this._controls = null;
  }

  /** @returns {boolean} */
  isActive() {
    return this._active;
  }

  /** @returns {THREE.Box3} 現在のボックス（コピー） */
  getCurrentBox() {
    return this._box.clone();
  }

  /**
   * 初期範囲にリセットする
   */
  resetToModelBounds() {
    if (!this._active) return;
    this._box.copy(this._initialBox);
    this._rebuildVisuals();
    this._updateClippingPlanes();
    this._refreshStencilCaps();
  }

  /**
   * セクションボックスの範囲を更新する（再生成なし）
   * @param {THREE.Box3} box3 - 新しいボックス範囲
   */
  updateBox(box3) {
    if (!this._active) return;
    this._box.copy(box3);
    this._rebuildVisuals();
    this._updateClippingPlanes();
    this._refreshStencilCaps();
  }

  /**
   * クリッピング平面を取得する
   * @returns {THREE.Plane[]}
   */
  getClipPlanes() {
    return this._clipPlanes;
  }

  /**
   * 指定した軸のハンドルの可視性を設定する
   * @param {string} axis - 軸名 ('x', 'y', 'z')
   * @param {boolean} visible - 表示する場合 true
   */
  setHandleVisibilityByAxis(axis, visible) {
    for (const handle of this._handles) {
      if (handle.userData.axis === axis) {
        handle.visible = visible;
      }
    }
  }

  // ============================================
  // ビジュアル構築
  // ============================================

  _createWireframe() {
    this._wireframe = this._buildWireframe();
    this._group.add(this._wireframe);
  }

  _createHandles() {
    this._handles = createAllHandles();
    positionHandles(this._handles, this._box);
    updateHandleScale(this._handles, this._getCurrentCamera());

    for (const handle of this._handles) {
      this._group.add(handle);
    }
  }

  _rebuildVisuals() {
    this._disposeGroupContents();

    this._createWireframe();
    this._createHandles();
  }

  _updateWireframe() {
    if (this._wireframe) {
      this._group.remove(this._wireframe);
      if (this._wireframe.geometry) this._wireframe.geometry.dispose();
      if (this._wireframe.material) this._wireframe.material.dispose();
    }

    this._wireframe = this._buildWireframe();
    this._group.add(this._wireframe);
  }

  _buildWireframe() {
    const size = new THREE.Vector3();
    this._box.getSize(size);
    const center = new THREE.Vector3();
    this._box.getCenter(center);

    const boxGeom = new THREE.BoxGeometry(size.x, size.y, size.z);
    const edges = new THREE.EdgesGeometry(boxGeom);
    const material = new THREE.LineBasicMaterial({
      color: WIREFRAME_COLOR,
      depthTest: false,
      transparent: false,
      opacity: 1,
    });

    const wireframe = new THREE.LineSegments(edges, material);
    wireframe.position.copy(center);
    wireframe.renderOrder = 998;
    wireframe.userData.isSectionBox = true;
    exemptFromClipping(wireframe);

    boxGeom.dispose();
    return wireframe;
  }

  /**
   * セクションボックス起動前の renderer クリッピング状態を保存する。
   * material の状態は実際に上書きする際に遅延保存する。
   */
  _captureClippingState() {
    this._previousRendererClippingPlanes = Array.isArray(this._renderer.clippingPlanes)
      ? [...this._renderer.clippingPlanes]
      : [];
    this._previousLocalClippingEnabled = this._renderer.localClippingEnabled === true;
    this._materialClippingState.clear();
  }

  /**
   * 通常描画マテリアルへセクションボックス6面をローカルクリッピングとして適用する。
   *
   * renderer.clippingPlanes を使うと、スタンシル書き込み用メッシュにも対象切断面が
   * 強制適用される。すると「対象面以外の5面だけでクリップして内外を数える」という
   * スタンシル法の前提が崩れ、柱などの切断面が中空に見える。
   */
  _applyLocalClippingPlanes() {
    if (!this._scene) return;

    this._scene.traverse((object) => {
      if (!object.material) return;
      if (
        object.userData?.isSectionBox ||
        object.userData?.isSectionBoxHandle ||
        object.userData?.isStencilCap
      ) {
        return;
      }

      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!(material instanceof THREE.Material)) continue;

        if (!this._materialClippingState.has(material)) {
          this._materialClippingState.set(material, {
            clippingPlanes: material.clippingPlanes,
          });
        }

        material.clippingPlanes = this._clipPlanes;
        material.needsUpdate = true;
      }
    });
  }

  /**
   * セクションボックス起動前のクリッピング状態へ戻す。
   */
  _restoreClippingState() {
    for (const [material, state] of this._materialClippingState.entries()) {
      material.clippingPlanes = state.clippingPlanes;
      material.needsUpdate = true;
    }
    this._materialClippingState.clear();

    this._renderer.clippingPlanes = [...this._previousRendererClippingPlanes];
    this._renderer.localClippingEnabled = this._previousLocalClippingEnabled;
    this._previousRendererClippingPlanes = [];
  }

  _updateClippingPlanes() {
    this._clipPlanes = createBoxClippingPlanes(this._box);

    // グローバル平面はスタンシルキャップにも強制適用されるため使用しない。
    // 通常要素にはローカル平面として6面を設定し、スタンシル側では対象面を除く5面だけを使う。
    this._renderer.clippingPlanes = [];
    this._renderer.localClippingEnabled = true;
    this._applyLocalClippingPlanes();
  }

  _disposeGroupContents() {
    while (this._group.children.length > 0) {
      const child = this._group.children[0];
      this._group.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    }
    this._wireframe = null;
    this._handles = [];
  }

  // ============================================
  // ドラッグ操作
  // ============================================

  /**
   * マウス座標をNDCに変換する
   * @param {PointerEvent} event
   */
  _updateMouseNDC(event) {
    const rect = this._domElement.getBoundingClientRect();
    this._mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this._mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  /**
   * 現在アクティブなカメラを取得する
   * @returns {THREE.Camera|null}
   */
  _getCurrentCamera() {
    if (!this._getCamera) return null;
    return this._getCamera();
  }

  /**
   * @param {PointerEvent} event
   */
  _onPointerDown(event) {
    if (!this._active || event.button !== 0) return;
    const camera = this._getCurrentCamera();
    if (!camera) return;

    this._updateMouseNDC(event);
    this._raycaster.setFromCamera(this._mouse, camera);

    const intersects = this._raycaster.intersectObjects(this._handles);
    if (intersects.length === 0) return;

    // ハンドルがヒットした場合、イベントの伝播を止める
    event.preventDefault();
    event.stopImmediatePropagation();

    const hit = intersects[0];
    this._activeHandle = hit.object;
    this._dragging = true;
    this._activePointerId = event.pointerId;
    if (typeof this._domElement.setPointerCapture === 'function') {
      this._domElement.setPointerCapture(event.pointerId);
    }

    // ドラッグ軸（常に正の座標方向を使用。法線方向だと負方向面で変位が逆転する）
    const { axis } = this._activeHandle.userData;
    this._dragAxis.set(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);

    // ドラッグ開始点をハンドル位置に設定
    this._dragStartPoint.copy(this._activeHandle.position);

    // ドラッグ開始時のbox値を記録
    this._dragStartMin = this._box.min.clone();
    this._dragStartMax = this._box.max.clone();

    // OrbitControls無効化
    if (this._controls) {
      this._controls.enabled = false;
    }

    setHandleState(this._activeHandle, 'active');
    this._domElement.style.cursor = 'grabbing';
  }

  /**
   * @param {PointerEvent} event
   */
  _onPointerMove(event) {
    const camera = this._getCurrentCamera();
    if (!camera) return;

    this._updateMouseNDC(event);

    if (this._dragging && this._activeHandle) {
      if (this._activePointerId !== null && event.pointerId !== this._activePointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this._processDrag(event);
      return;
    }

    if (!this._active) return;
    this._updateHoveredHandle(camera);

    // ハンドルスケール更新
    updateHandleScale(this._handles, camera);
  }

  /**
   * 現在のポインタ位置に応じてホバー表示を更新する
   * @param {THREE.Camera} camera
   */
  _updateHoveredHandle(camera) {
    this._raycaster.setFromCamera(this._mouse, camera);
    const intersects = this._raycaster.intersectObjects(this._handles);

    if (intersects.length > 0) {
      const hovered = intersects[0].object;
      if (this._hoveredHandle !== hovered) {
        if (this._hoveredHandle) {
          setHandleState(this._hoveredHandle, 'default');
        }
        this._hoveredHandle = hovered;
      }
      setHandleState(this._hoveredHandle, 'hover');
      this._domElement.style.cursor = 'grab';
    } else {
      if (this._hoveredHandle) {
        setHandleState(this._hoveredHandle, 'default');
        this._hoveredHandle = null;
      }
      this._domElement.style.cursor = '';
    }
  }

  /**
   * ドラッグ処理：カメラレイをハンドル軸に投影する
   * @param {PointerEvent} _event
   */
  _processDrag(_event) {
    const camera = this._getCurrentCamera();
    if (!camera) return;

    this._raycaster.setFromCamera(this._mouse, camera);

    const rayOrigin = this._raycaster.ray.origin;
    const rayDir = this._raycaster.ray.direction;

    // ドラッグ開始点から軸方向への直線上で、カメラレイとの最近点を計算
    const axisDir = this._dragAxis.clone();
    const lineStart = this._dragStartPoint;

    // 2直線の最近点を求める
    const displacement = this._closestPointOnAxis(rayOrigin, rayDir, lineStart, axisDir);

    if (displacement === null) return;

    const { axis, sign } = this._activeHandle.userData;

    if (sign > 0) {
      // +方向のハンドル: maxを移動
      const newVal = this._dragStartMax[axis] + displacement;
      const minBound = this._box.min[axis] + MIN_BOX_SIZE;
      this._box.max[axis] = Math.max(newVal, minBound);
    } else {
      // -方向のハンドル: minを移動
      const newVal = this._dragStartMin[axis] + displacement;
      const maxBound = this._box.max[axis] - MIN_BOX_SIZE;
      this._box.min[axis] = Math.min(newVal, maxBound);
    }

    this._updateWireframe();
    positionHandles(this._handles, this._box);
    updateHandleScale(this._handles, camera);
    this._updateClippingPlanes();
  }

  /**
   * 2直線の最近点を求め、軸上の変位を返す
   * @param {THREE.Vector3} rayOrigin - カメラレイの原点
   * @param {THREE.Vector3} rayDir - カメラレイの方向
   * @param {THREE.Vector3} lineStart - 軸直線の始点
   * @param {THREE.Vector3} axisDir - 軸の方向ベクトル
   * @returns {number|null} 軸上の変位、計算不可の場合null
   */
  _closestPointOnAxis(rayOrigin, rayDir, lineStart, axisDir) {
    // w0 = rayOrigin - lineStart
    const w0 = new THREE.Vector3().subVectors(rayOrigin, lineStart);

    const a = rayDir.dot(rayDir);
    const b = rayDir.dot(axisDir);
    const c = axisDir.dot(axisDir);
    const d = rayDir.dot(w0);
    const e = axisDir.dot(w0);

    const denom = a * c - b * b;

    // レイと軸がほぼ平行な場合は無視
    if (Math.abs(denom) < 1e-6) return null;

    // 2直線の最近点における軸側パラメータ
    // pRay = rayOrigin + s * rayDir
    // pAxis = lineStart + t * axisDir
    // (pRay - pAxis) が両方向ベクトルに直交する条件から導出
    const t = (a * e - b * d) / denom;

    return t;
  }

  /**
   * @param {PointerEvent} _event
   */
  _onPointerUp(_event) {
    if (!this._dragging) return;
    if (this._activePointerId !== null && _event.pointerId !== this._activePointerId) return;

    this._dragging = false;
    _event.preventDefault();
    _event.stopImmediatePropagation();
    if (typeof this._domElement.releasePointerCapture === 'function') {
      this._domElement.releasePointerCapture(_event.pointerId);
    }
    this._activePointerId = null;

    if (this._activeHandle) {
      setHandleState(this._activeHandle, 'default');
      this._activeHandle = null;
    }

    // OrbitControls再有効化
    if (this._controls) {
      this._controls.enabled = true;
    }

    const camera = this._getCurrentCamera();
    if (camera) {
      this._updateMouseNDC(_event);
      this._updateHoveredHandle(camera);
    } else {
      this._domElement.style.cursor = '';
    }

    // ドラッグ完了後にスタンシルキャップを更新（ドラッグ中は省略）
    this._refreshStencilCaps();

    log.debug('Section box drag completed', {
      min: this._box.min.toArray(),
      max: this._box.max.toArray(),
    });
  }

  /**
   * スタンシルキャップを再構築する
   * ドラッグ中は呼ばず、完了後・初期化・リセット時のみ呼ぶ
   */
  _refreshStencilCaps() {
    this._stencilCapManager.deactivate();
    this._stencilCapManager.activate(this._scene, this._clipPlanes);
  }
}
