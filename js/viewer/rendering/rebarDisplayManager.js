/**
 * @fileoverview 3D配筋表示マネージャー
 *
 * 鉄筋メッシュ専用のシーングループを持ち、表示/非表示と再生成を管理する。
 * 鉄筋は比較対象の要素ではなく独立した可視化オーバーレイのため、
 * elementGroups とは独立したグループへ追加する。
 *
 * 表示単位は「部材カテゴリ.鉄筋種別」（例: column.main / girder.hoop）とし、
 * 柱・大梁・小梁を独立して切り替えられるよう動的にグループを生成する。
 *
 * @module viewer/rendering/rebarDisplayManager
 */

import * as THREE from 'three';
import { disposeRebarMeshes } from '../geometry/generators/RebarGenerator.js';
import { applyRebarDiameterColors } from './rebarDiameterColoring.js';
import { raycastRebarMesh } from './rebarRaycast.js';
import { createLogger } from '../../utils/logger.js';
import { eventBus } from '../../data/events/index.js';
import { RenderableLifecycleEvents } from '../../constants/renderableLifecycleEvents.js';
import {
  incrementRebarPerformanceCounter,
  measureRebarPerformance,
} from '../../utils/rebarPerformanceMetrics.js';

const log = createLogger('viewer:rebarDisplay');

function groupName(key) {
  const safeKey = String(key || 'rebar').replace(/[^a-zA-Z0-9_-]/g, '-');
  return `RebarDisplayGroup-${safeKey}`;
}

/**
 * 3D配筋表示マネージャー
 */
export class RebarDisplayManager {
  /**
   * @param {THREE.Scene} scene - Three.jsシーン
   */
  constructor(scene) {
    this._scene = scene;
    this._groups = new Map();
    this._visible = new Map();
    this._generationKeys = new Map();
    this._selectionOverlayGroup = new THREE.Group();
    this._selectionOverlayGroup.name = 'RebarSelectionOverlay';
    this._scene?.add(this._selectionOverlayGroup);
  }

  /**
   * 指定キーのグループを取得する。必要なら生成する。
   * @param {string} key - 表示グループキー
   * @param {boolean} create - 無ければ生成するか
   * @returns {THREE.Group|null} グループ
   * @private
   */
  _group(key, create = false) {
    const normalizedKey = String(key || 'main');
    const existing = this._groups.get(normalizedKey);
    if (existing || !create) return existing || null;

    const group = new THREE.Group();
    group.name = groupName(normalizedKey);
    group.visible = false;
    this._scene?.add(group);
    this._groups.set(normalizedKey, group);
    this._visible.set(normalizedKey, false);
    return group;
  }

  /**
   * 表示中かどうか
   * @param {string} [key] - 表示グループキー
   * @returns {boolean} 表示状態
   */
  isVisible(key = 'main') {
    return Boolean(this._visible.get(String(key || 'main')));
  }

  /**
   * いずれかの鉄筋グループが表示中か
   * @returns {boolean}
   */
  isAnyVisible() {
    return [...this._visible.values()].some(Boolean);
  }

  /**
   * 指定グループに生成済みmeshがあるか。
   * @param {string} [key] - 表示グループキー
   * @returns {boolean}
   */
  hasMeshes(key = 'main') {
    return this.getMeshCount(key) > 0;
  }

  /**
   * 指定グループのmesh数を返す。
   * @param {string} [key] - 表示グループキー
   * @returns {number}
   */
  getMeshCount(key = 'main') {
    return this._group(key)?.children?.length || 0;
  }

  /** generation単位の再利用判定キーを取得する。 */
  getGenerationKey(key = 'main') {
    return this._generationKeys.get(String(key || 'main')) ?? null;
  }

  /** generation単位の再利用判定キーを設定する。 */
  setGenerationKey(key = 'main', generationKey = null) {
    const normalizedKey = String(key || 'main');
    if (generationKey === null || generationKey === undefined) {
      this._generationKeys.delete(normalizedKey);
      return;
    }
    this._generationKeys.set(normalizedKey, String(generationKey));
  }

  /**
   * 表示状態を設定する
   * @param {boolean} visible - 表示するか
   * @param {string} [key] - 表示グループキー
   */
  setVisible(visible, key = 'main') {
    const group = this._group(key, Boolean(visible));
    if (!group) return;
    const next = Boolean(visible);
    this._visible.set(String(key || 'main'), next);
    group.visible = next;
    this._syncSelectionOverlayVisibility();
  }

  /** 選択モード用の表示中配筋グループを取得する。 */
  getVisibleGroups() {
    return [...this._groups.values()].filter(
      (group) => group.visible !== false && group.children.length > 0,
    );
  }

  /** 個別鉄筋のハイライト用オーバーレイを取得する。 */
  getSelectionOverlayGroup() {
    return this._selectionOverlayGroup;
  }

  addSelectionOverlay(object, sourceMesh) {
    if (!object || !sourceMesh?.parent || !this._selectionOverlayGroup) return false;
    object.userData.sourceMesh = sourceMesh;
    object.userData.sourceGroup = sourceMesh.parent;
    this._selectionOverlayGroup.add(object);
    object.visible = sourceMesh.visible !== false && sourceMesh.parent.visible !== false;
    return true;
  }

  removeSelectionOverlay(object) {
    if (!object?.parent) return false;
    object.parent.remove(object);
    return true;
  }

  _syncSelectionOverlayVisibility() {
    for (const object of this._selectionOverlayGroup.children) {
      const sourceMesh = object.userData?.sourceMesh;
      const sourceGroup = object.userData?.sourceGroup;
      object.visible = Boolean(
        sourceMesh?.parent === sourceGroup &&
        sourceMesh.visible !== false &&
        sourceGroup?.visible !== false,
      );
    }
  }

  _removeSelectionOverlaysForMeshes(meshes) {
    const sourceMeshes = new Set(meshes);
    for (const object of [...this._selectionOverlayGroup.children]) {
      if (sourceMeshes.has(object.userData?.sourceMesh)) {
        this._selectionOverlayGroup.remove(object);
      }
    }
  }

  /**
   * 生成済みの鉄筋メッシュを差し替える
   * @param {Array<THREE.Object3D>} meshes - 追加するメッシュ配列
   * @param {string} [key] - 表示グループキー
   */
  setMeshes(meshes, key = 'main', generationKey = null) {
    incrementRebarPerformanceCounter('mesh.rebuild.count');
    measureRebarPerformance('rebar.manager.setMeshes', () => {
      const group = this._group(key, true);
      if (!group) return;

      this._removeSelectionOverlaysForMeshes(group.children);
      this.clear(key);
      applyRebarDiameterColors(meshes);
      for (const mesh of meshes || []) {
        if (mesh?.userData?.isRebar) mesh.raycast = raycastRebarMesh;
        group.add(mesh);
      }
      this.setGenerationKey(key, generationKey);
      log.info(`[Render] 3D配筋メッシュを設定しました（${key}）: ${group.children.length}件`);
    });
  }

  /**
   * 鉄筋メッシュを削除する
   * @param {string|null} [key] - 表示グループキー。省略時は全種別
   */
  clear(key = null) {
    const targets = key == null ? [...this._groups.keys()] : [String(key)];
    for (const target of targets) {
      const group = this._group(target);
      if (!group) continue;
      const meshes = [...group.children];
      if (meshes.length > 0) {
        eventBus.emit(RenderableLifecycleEvents.REBAR_MESHES_REMOVED, { meshes });
      }
      this._removeSelectionOverlaysForMeshes(meshes);
      group.clear();
      group.visible = false;
      this._visible.set(target, false);
      disposeRebarMeshes(meshes);
      this._generationKeys.delete(target);
    }
  }

  /** generation情報とmeshを同時に破棄する。 */
  disposeMeshes(key = null) {
    this.clear(key);
  }

  /**
   * シーンからグループごと破棄する
   */
  dispose() {
    this.clear();
    for (const group of this._groups.values()) {
      if (this._scene) this._scene.remove(group);
    }
    this._groups.clear();
    this._visible.clear();
    this._generationKeys.clear();
    if (this._selectionOverlayGroup.parent) {
      this._selectionOverlayGroup.parent.remove(this._selectionOverlayGroup);
    }
    this._selectionOverlayGroup.clear();
  }
}

/** シングルトンインスタンス */
let instance = null;

/**
 * 3D配筋表示マネージャーを取得する（初回はscene必須）
 * @param {THREE.Scene} [scene] - シーン
 * @returns {RebarDisplayManager|null} インスタンス
 */
export function getRebarDisplayManager(scene = null) {
  if (!instance && scene) {
    instance = new RebarDisplayManager(scene);
  }
  return instance;
}
