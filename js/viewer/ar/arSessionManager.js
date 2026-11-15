/**
 * @fileoverview WebXR ARセッション管理モジュール
 *
 * ARモードの開始・終了、ヒットテスト、DOM Overlay設定を管理します。
 * 既存のレンダリングパイプラインへの影響を最小限に抑える設計です。
 */

import * as THREE from 'three';
import { createLogger } from '../../utils/logger.js';
import {
  renderer,
  controls,
  scene,
  elementGroups,
  axesHelper,
  camera,
  orthographicCamera,
  activeCamera,
  setXRSessionActive,
  setXRFrameHandler,
  updateViewportSize,
} from '../core/core.js';
import { isGridHelperVisible, setGridHelperVisibility } from '../grid/gridHelper.js';
import { ArPlacement } from './arPlacement.js';
import {
  cloneClippingPlanes,
  transformClippingPlanes,
  setElementGroupsClippingPlanes,
  captureElementGroupsMaterialClipping,
  restoreElementGroupsMaterialClipping,
} from './arClipping.js';
import { configureCamerasForAr } from './arCameraState.js';
import { pickElementAtScreenPoint } from './arElementPicker.js';

const log = createLogger('viewer/ar/arSessionManager');

/**
 * AR配置の状態
 * @typedef {'detecting'|'ready'|'placed'} ArPlacementState
 */

/**
 * ARセッションマネージャ
 * WebXR immersive-ar セッションのライフサイクルを管理
 */
export class ArSessionManager {
  constructor() {
    /** @type {XRSession|null} */
    this._session = null;
    /** @type {XRReferenceSpace|null} */
    this._refSpace = null;
    /** @type {XRHitTestSource|null} */
    this._hitTestSource = null;
    /** @type {ArPlacement} */
    this._placement = new ArPlacement(scene);
    /** @type {boolean} */
    this._isSupported = false;
    /** @type {THREE.Group} AR空間用のルートグループ */
    this._arRoot = null;
    /** @type {Map<THREE.Object3D, THREE.Object3D>} 元の親を記憶 */
    this._originalParents = new Map();
    /** @type {Function|null} セッション終了コールバック */
    this._onSessionEnd = null;
    /** @type {((state: ArPlacementState) => void)|null} 配置状態変化コールバック */
    this._onStateChange = null;
    /** @type {ArPlacementState|null} 最後に通知した配置状態 */
    this._lastNotifiedState = null;
    /** @type {boolean|undefined} */
    this._gridWasVisible = undefined;
    /** @type {boolean|undefined} */
    this._axesWasVisible = undefined;
    /** @type {THREE.Color|THREE.Texture|null|undefined} AR開始前の背景 */
    this._originalBackground = undefined;
    /** @type {boolean|undefined} AR開始前のコントロール有効状態 */
    this._controlsWasEnabled = undefined;
    /** @type {THREE.Plane[]|undefined} AR開始前の renderer.clippingPlanes */
    this._savedClippingPlanes = undefined;
    /** @type {boolean|undefined} AR開始前の renderer.localClippingEnabled */
    this._savedLocalClippingEnabled = undefined;
    /** @type {THREE.Plane[]|null} モデル座標系のクリッピング平面（変換元） */
    this._arClipSourcePlanes = null;
    /** @type {THREE.Plane[]|null} AR空間へ変換済みの平面（マテリアルに適用中） */
    this._arClipWorkingPlanes = null;
    /** @type {XRHitTestResult|null} 最後の有効なヒットテスト結果（アンカー作成用） */
    this._lastHitResult = null;
    /** @type {XRAnchor|null} 配置点を安定化するアンカー（FR-6.5、対応端末のみ） */
    this._anchor = null;
    this._anchorGeneration = 0;
    this._restoreArCameras = null;
    this._savedMaterialClipping = null;
  }

  /**
   * WebXR AR対応を確認
   * @returns {Promise<boolean>}
   */
  async checkSupport() {
    // ARボタンを非表示にした理由を、AndroidリモートDevToolsから調査できるようにする。
    // URL全体（認証情報やクエリ文字列）は記録しない。
    const context = {
      secureContext: globalThis.isSecureContext ?? null,
      origin: globalThis.location?.origin ?? 'unknown',
    };
    if (!navigator.xr) {
      log.warn(
        '[Config] WebXR APIが利用できません。HTTPSまたはlocalhostを確認してください',
        context,
      );
      this._isSupported = false;
      return false;
    }
    try {
      this._isSupported = await navigator.xr.isSessionSupported('immersive-ar');
      if (!this._isSupported) {
        log.warn(
          '[Config] immersive-arセッションが非対応です。ARCore・Chrome・エミュレータ設定を確認してください',
          context,
        );
      } else {
        log.info('WebXR AR対応: true', context);
      }
      return this._isSupported;
    } catch (e) {
      log.warn('[Config] WebXR ARサポートチェックに失敗:', context, e);
      this._isSupported = false;
      return false;
    }
  }

  /**
   * AR対応かどうか
   * @returns {boolean}
   */
  get isSupported() {
    return this._isSupported;
  }

  /**
   * ARセッションがアクティブかどうか
   * @returns {boolean}
   */
  get isActive() {
    return this._session !== null;
  }

  /**
   * モデルが配置済みかどうか
   * @returns {boolean}
   */
  get isPlaced() {
    return this._placement.isPlaced;
  }

  /**
   * ARセッションを開始
   * @param {Object} options
   * @param {HTMLElement} [options.domOverlayRoot] - DOM Overlay用のルート要素
   * @param {Function} [options.onSessionEnd] - セッション終了時のコールバック
   * @param {(state: ArPlacementState) => void} [options.onStateChange]
   *   配置状態（detecting/ready/placed）変化時のコールバック
   * @returns {Promise<boolean>} 開始成功
   */
  async startSession({ domOverlayRoot, onSessionEnd, onStateChange } = {}) {
    if (this._session) {
      log.warn('ARセッションは既にアクティブです');
      return false;
    }
    if (!renderer) {
      log.error('レンダラーが初期化されていません');
      return false;
    }

    try {
      // セッションオプション構築
      // local-floor は対応していない端末があるため optional とし、
      // 非対応時は local 参照空間へフォールバックする
      // anchors は配置点の安定化（FR-6.5）用。非対応端末では固定座標配置のまま
      const sessionInit = {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['local-floor', 'dom-overlay', 'anchors'],
      };
      if (domOverlayRoot) {
        sessionInit.domOverlay = { root: domOverlayRoot };
      }

      const session = await navigator.xr.requestSession('immersive-ar', sessionInit);
      this._session = session;
      this._onSessionEnd = onSessionEnd || null;
      this._onStateChange = typeof onStateChange === 'function' ? onStateChange : null;
      this._lastNotifiedState = null;

      // 先に参照空間を決定してWebXRManagerと同じ種類にする。
      // setSession()は内部で参照空間を要求するため、後から指定すると失敗し得る。
      const { type } = await this._requestReferenceSpaceWithFallback(session);
      renderer.xr.setReferenceSpaceType(type);
      this._restoreArCameras = configureCamerasForAr(
        [camera, orthographicCamera, activeCamera],
        controls,
      );
      await renderer.xr.setSession(session);
      this._refSpace = renderer.xr.getReferenceSpace();
      if (!this._refSpace) throw new Error('XR参照空間が初期化されませんでした');

      // ヒットテストソースの初期化
      const viewerSpace = await session.requestReferenceSpace('viewer');
      this._hitTestSource = await session.requestHitTestSource({ space: viewerSpace });

      // ARルートグループ作成（変換は ArPlacement が配置時に適用する）
      this._arRoot = new THREE.Group();
      this._arRoot.visible = false; // 配置前は非表示
      scene.add(this._arRoot);
      this._reparentModelGroupsToArRoot();
      this._hideSceneHelpersForAr();
      this._captureClippingForAr();

      // シーン背景を透明に（カメラパススルー用）
      this._originalBackground = scene.background;
      scene.background = null;

      // コントロールを無効化（AR中はデバイス姿勢で制御）
      if (controls) {
        this._controlsWasEnabled = controls.enabled;
        controls.enabled = false;
      }

      // XRセッション状態を通知
      setXRSessionActive(true);
      setXRFrameHandler((frame) => this.processFrame(frame));

      // 配置マネージャを初期化
      this._placement.init(this._arRoot);

      // タップ（XR select）でモデル配置を確定
      // DOM Overlay上のUI操作は beforexrselect 側で抑制される
      session.addEventListener('select', () => {
        if (!this._placement.isPlaced) {
          this.placeModel();
        }
      });

      // セッション終了イベント
      session.addEventListener('end', () => this._handleSessionEnd());

      this._notifyStateIfChanged();
      log.info('ARセッションを開始しました');
      return true;
    } catch (e) {
      log.error('ARセッションの開始に失敗:', e);
      if (this._session) {
        try {
          await this._session.end();
        } catch (endError) {
          log.warn('失敗したARセッションの終了処理でエラーが発生しました:', endError);
        }
      }
      this._restoreModelGroupsFromArRoot();
      if (this._arRoot) {
        this._placement.dispose();
        scene.remove(this._arRoot);
        this._arRoot = null;
      }
      this._restoreSceneHelpersAfterAr();
      this._restoreClippingAfterAr();
      if (this._originalBackground !== undefined) {
        scene.background = this._originalBackground;
      }
      if (controls && this._controlsWasEnabled !== undefined) {
        controls.enabled = this._controlsWasEnabled;
      }
      setXRSessionActive(false);
      setXRFrameHandler(null);
      this._restoreDesktopCameraState();
      if (this._hitTestSource) {
        this._hitTestSource.cancel();
        this._hitTestSource = null;
      }
      this._releaseAnchor();
      this._lastHitResult = null;
      this._session = null;
      this._refSpace = null;
      this._onSessionEnd = null;
      this._onStateChange = null;
      this._originalBackground = undefined;
      this._controlsWasEnabled = undefined;
      updateViewportSize();
      return false;
    }
  }

  /**
   * 参照空間を local-floor → local の順で取得
   * @private
   * @param {XRSession} session
   * @returns {Promise<{type: 'local-floor'|'local', space: XRReferenceSpace}>}
   */
  async _requestReferenceSpaceWithFallback(session) {
    try {
      return { type: 'local-floor', space: await session.requestReferenceSpace('local-floor') };
    } catch (e) {
      log.warn('local-floor 参照空間が利用できないため local にフォールバックします:', e);
      return { type: 'local', space: await session.requestReferenceSpace('local') };
    }
  }

  /** 終了時または開始失敗時の通常カメラ状態復元。二重呼び出し可能。 */
  _restoreDesktopCameraState() {
    this._restoreArCameras?.();
    this._restoreArCameras = null;
    renderer?.xr?.setReferenceSpaceType?.('local-floor');
  }

  /**
   * ARセッションを終了
   */
  async endSession() {
    if (this._session) {
      await this._session.end();
      // _handleSessionEnd がイベントで呼ばれる
    }
  }

  /**
   * フレームごとのヒットテスト処理
   * setAnimationLoop のコールバック内から呼ばれる想定
   * @param {XRFrame} frame
   */
  processFrame(frame) {
    if (!this._session || !this._hitTestSource || !this._refSpace) return;

    const hitTestResults = frame.getHitTestResults(this._hitTestSource);
    let validHit = false;
    if (!this._placement.isPlaced) {
      for (const hit of hitTestResults) {
        const pose = hit.getPose(this._refSpace);
        if (pose && this._placement.updateReticle(pose.transform)) {
          this._lastHitResult = hit;
          validHit = true;
          break;
        }
      }
      if (!validHit) {
        this._placement.clearReticle();
        this._lastHitResult = null;
      }
    }
    // アンカーの最新ポーズへ配置点を追従（トラッキングドリフト補正、FR-6.5）
    this._updateAnchoredPlacement(frame);
    // クリッピング平面をARルートの現在の変換に追従させる（描画前に呼ばれる）
    this._updateArClippingPlanes();
    this._notifyStateIfChanged();
  }

  /**
   * 配置アンカーの最新ポーズで配置点を更新する
   * @private
   * @param {XRFrame} frame
   */
  _updateAnchoredPlacement(frame) {
    if (!this._anchor || !this._placement.isPlaced || !this._refSpace) return;
    try {
      const pose = frame.getPose(this._anchor.anchorSpace, this._refSpace);
      if (!pose) return;
      const { x, y, z } = pose.transform.position;
      this._placement.updatePlacementPoint(x, y, z);
    } catch (e) {
      // アンカーが削除済み等で取得に失敗した場合は追従を打ち切る（配置は維持）
      log.warn('アンカーポーズの取得に失敗したため追従を停止します:', e);
      this._releaseAnchor();
    }
  }

  /**
   * AR空間にモデルを配置（XR selectイベントから呼ばれる）
   * @returns {boolean} 配置に成功したか
   */
  placeModel() {
    if (!this._placement) return false;
    const placed = this._placement.confirmPlacement();
    if (placed) {
      this._createPlacementAnchor();
    }
    this._notifyStateIfChanged();
    return placed;
  }

  /**
   * 配置確定時のヒット結果からアンカーを作成する（FR-6.5）
   * 非対応端末（createAnchor が無い）では何もしない
   * @private
   */
  _createPlacementAnchor() {
    this._releaseAnchor();
    const hit = this._lastHitResult;
    if (!hit || typeof hit.createAnchor !== 'function') return;
    const generation = this._anchorGeneration;
    const session = this._session;
    hit
      .createAnchor()
      .then((anchor) => {
        // 作成完了前に再配置・終了された場合は破棄する
        if (
          this._session !== session ||
          this._anchorGeneration !== generation ||
          !this._placement.isPlaced ||
          this._anchor
        ) {
          anchor?.delete?.();
          return;
        }
        this._anchor = anchor;
        log.info('配置アンカーを作成しました（トラッキング追従有効）');
      })
      .catch((e) => {
        log.info('アンカー作成に失敗したため固定座標配置で継続します:', e);
      });
  }

  /**
   * 配置アンカーを解放する
   * @private
   */
  _releaseAnchor() {
    // 未解決のcreateAnchor()も無効化する（旧配置アンカーの遅着防止）。
    this._anchorGeneration++;
    if (this._anchor) {
      try {
        this._anchor.delete?.();
      } catch (e) {
        log.warn('アンカーの解放に失敗しました:', e);
      }
      this._anchor = null;
    }
  }

  /**
   * 配置をリセットして再配置可能にする
   */
  resetPlacement() {
    this._releaseAnchor();
    this._lastHitResult = null;
    this._placement.resetPlacement();
    this._notifyStateIfChanged();
  }

  /**
   * ARモデルの縮尺を設定
   * @param {number} scaleFactor - 縮尺係数（1.0 = 実寸）
   * @returns {number} クランプ後に適用された縮尺係数
   */
  setModelScale(scaleFactor) {
    return this._placement.setScaleFactor(scaleFactor);
  }

  /**
   * 現在の縮尺係数
   * @returns {number}
   */
  get modelScale() {
    return this._placement.scaleFactor;
  }

  /**
   * モデルを鉛直軸まわりに回転
   * @param {number} deltaRadians - 回転角の増分（rad）
   */
  rotateModelBy(deltaRadians) {
    this._placement.rotateBy(deltaRadians);
  }

  /**
   * スクリーン座標から配置済みモデルの要素をピックする（FR-6.1）
   *
   * DOM Overlay上のタップ座標（CSS px）を受け取り、XRカメラから
   * レイキャストして最前面の構造要素を返す。
   * @param {number} clientX - タップX座標（px）
   * @param {number} clientY - タップY座標（px）
   * @returns {import('./arElementPicker.js').ArPickedElement|null}
   */
  pickElementAt(clientX, clientY) {
    if (!this._session || !this._arRoot || !this._placement.isPlaced) return null;

    const xrCamera = renderer.xr.getCamera();
    // 手持ちARは単眼ビュー。ArrayCameraの場合はサブカメラを使う
    const camera = xrCamera?.cameras?.length ? xrCamera.cameras[0] : xrCamera;
    if (!camera) return null;

    return pickElementAtScreenPoint({
      x: clientX,
      y: clientY,
      width: window.innerWidth,
      height: window.innerHeight,
      camera,
      root: this._arRoot,
      elementGroups,
    });
  }

  /**
   * 現在の配置状態を取得
   * @returns {ArPlacementState}
   */
  getPlacementState() {
    if (this._placement.isPlaced) return 'placed';
    if (this._placement.hasValidHit) return 'ready';
    return 'detecting';
  }

  /**
   * 配置状態が変化していればコールバックへ通知
   * @private
   */
  _notifyStateIfChanged() {
    if (!this._onStateChange) return;
    const state = this.getPlacementState();
    if (state === this._lastNotifiedState) return;
    this._lastNotifiedState = state;
    try {
      this._onStateChange(state);
    } catch (e) {
      log.warn('AR状態変化コールバックでエラーが発生しました:', e);
    }
  }

  /**
   * セッション終了時の内部処理
   * @private
   */
  _handleSessionEnd() {
    log.info('ARセッションが終了しました');

    this._releaseAnchor();
    this._lastHitResult = null;

    // シーン背景を復元
    if (this._originalBackground !== undefined) {
      scene.background = this._originalBackground;
    }

    // コントロールを復元
    if (controls && this._controlsWasEnabled !== undefined) {
      controls.enabled = this._controlsWasEnabled;
    }

    this._restoreModelGroupsFromArRoot();
    this._restoreSceneHelpersAfterAr();
    this._restoreClippingAfterAr();

    // ARルートをクリーンアップ
    if (this._arRoot) {
      this._placement.dispose();
      scene.remove(this._arRoot);
      this._arRoot = null;
    }

    // XRセッション状態を通知
    setXRSessionActive(false);
    setXRFrameHandler(null);
    this._restoreDesktopCameraState();

    // AR中に発生したリサイズはスキップされているため、ここで再同期する
    updateViewportSize();

    // ヒットテストソースを解放
    if (this._hitTestSource) {
      this._hitTestSource.cancel();
      this._hitTestSource = null;
    }

    const onSessionEnd = this._onSessionEnd;

    this._session = null;
    this._refSpace = null;
    this._onSessionEnd = null;
    this._onStateChange = null;
    this._lastNotifiedState = null;
    this._originalBackground = undefined;
    this._controlsWasEnabled = undefined;

    // コールバック呼び出し
    if (onSessionEnd) {
      onSessionEnd();
    }
  }

  /**
   * モデルグループをARルートへ移動（AR用の変換を一括適用するため）
   * @private
   */
  _reparentModelGroupsToArRoot() {
    if (!this._arRoot) return;
    this._originalParents.clear();
    Object.values(elementGroups).forEach((group) => {
      if (!group || group === this._arRoot) return;
      if (group.parent) {
        this._originalParents.set(group, group.parent);
      }
      this._arRoot.add(group);
    });
  }

  /**
   * ARルートへ移動したモデルグループを元の親へ復元
   * @private
   */
  _restoreModelGroupsFromArRoot() {
    if (!this._originalParents || this._originalParents.size === 0) return;
    this._originalParents.forEach((parent, obj) => {
      if (!parent || !obj) return;
      parent.add(obj);
    });
    this._originalParents.clear();
  }

  /**
   * AR開始時にクリッピング状態を退避し、モデルへ引き継ぐ（FR-5.4）
   *
   * 通常ビューのクリッピング平面はワールド座標（mm・Z-up）で
   * renderer.clippingPlanes に設定されている。ARではモデルが _arRoot 配下で
   * 回転・縮尺・移動されるため、グローバル平面のままでは位置が合わず、
   * レティクル等までクリップされてしまう。平面をモデルのマテリアル限定に
   * 付け替え、毎フレーム _arRoot.matrixWorld で変換して追従させる。
   * @private
   */
  _captureClippingForAr() {
    this._savedClippingPlanes = renderer.clippingPlanes;
    this._savedLocalClippingEnabled = renderer.localClippingEnabled;
    if (!Array.isArray(this._savedClippingPlanes) || this._savedClippingPlanes.length === 0) {
      return;
    }
    this._arClipSourcePlanes = cloneClippingPlanes(this._savedClippingPlanes);
    this._arClipWorkingPlanes = cloneClippingPlanes(this._savedClippingPlanes);
    this._savedMaterialClipping = captureElementGroupsMaterialClipping(elementGroups);
    renderer.clippingPlanes = [];
    renderer.localClippingEnabled = true;
    setElementGroupsClippingPlanes(elementGroups, this._arClipWorkingPlanes);
    log.info(`クリッピング平面 ${this._arClipSourcePlanes.length} 枚をARへ引き継ぎました`);
  }

  /**
   * クリッピング平面をARルートの現在の変換に追従させる
   * @private
   */
  _updateArClippingPlanes() {
    if (!this._arClipSourcePlanes || !this._arClipWorkingPlanes || !this._arRoot) return;
    transformClippingPlanes(
      this._arClipSourcePlanes,
      this._arRoot.matrixWorld,
      this._arClipWorkingPlanes,
    );
  }

  /**
   * AR終了時にクリッピング状態を通常ビューへ復元する
   * @private
   */
  _restoreClippingAfterAr() {
    if (this._savedMaterialClipping) {
      restoreElementGroupsMaterialClipping(this._savedMaterialClipping);
      this._savedMaterialClipping = null;
    }
    if (this._savedClippingPlanes !== undefined) {
      renderer.clippingPlanes = this._savedClippingPlanes;
    }
    if (this._savedLocalClippingEnabled !== undefined) {
      renderer.localClippingEnabled = this._savedLocalClippingEnabled;
    }
    this._savedClippingPlanes = undefined;
    this._savedLocalClippingEnabled = undefined;
    this._arClipSourcePlanes = null;
    this._arClipWorkingPlanes = null;
  }

  /**
   * AR中は補助表示を非表示化
   * @private
   */
  _hideSceneHelpersForAr() {
    this._gridWasVisible = isGridHelperVisible();
    this._axesWasVisible = axesHelper?.visible;
    setGridHelperVisibility(false);
    if (axesHelper) axesHelper.visible = false;
  }

  /**
   * AR終了時に補助表示を復元
   * @private
   */
  _restoreSceneHelpersAfterAr() {
    if (this._gridWasVisible !== undefined) {
      setGridHelperVisibility(this._gridWasVisible);
    }
    if (axesHelper && this._axesWasVisible !== undefined) {
      axesHelper.visible = this._axesWasVisible;
    }
    this._gridWasVisible = undefined;
    this._axesWasVisible = undefined;
  }
}

/** シングルトンインスタンス */
export const arSessionManager = new ArSessionManager();
