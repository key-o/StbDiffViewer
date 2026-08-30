/**
 * @fileoverview 3D配筋表示マネージャー
 *
 * 鉄筋メッシュ専用のシーングループを持ち、表示/非表示と再生成を管理する。
 * 鉄筋は比較対象の要素ではなく表示専用のオーバーレイのため、
 * elementGroups とは独立したグループへ追加する。
 *
 * 主筋（main）と帯筋・あばら筋（hoop）は別トグルで切り替えるため、
 * 種別ごとにグループを分けて保持する。
 *
 * @module viewer/rendering/rebarDisplayManager
 */

import * as THREE from 'three';
import { disposeRebarMeshes } from '../geometry/generators/RebarGenerator.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('viewer:rebarDisplay');

/** 鉄筋グループの種別 */
const REBAR_GROUP_KINDS = ['main', 'hoop'];

/** 種別ごとのシーングループ名 */
const GROUP_NAMES = {
  main: 'RebarDisplayGroup',
  hoop: 'HoopDisplayGroup',
};

/**
 * 3D配筋表示マネージャー
 */
class RebarDisplayManager {
  /**
   * @param {THREE.Scene} scene - Three.jsシーン
   */
  constructor(scene) {
    this._scene = scene;
    this._groups = new Map();
    this._visible = new Map();

    for (const kind of REBAR_GROUP_KINDS) {
      const group = new THREE.Group();
      group.name = GROUP_NAMES[kind];
      group.visible = false;
      this._scene.add(group);
      this._groups.set(kind, group);
      this._visible.set(kind, false);
    }
  }

  /**
   * 種別のグループを取得する
   * @param {string} kind - 'main' | 'hoop'
   * @returns {THREE.Group|null} グループ
   * @private
   */
  _group(kind) {
    return this._groups.get(kind) || null;
  }

  /**
   * 表示中かどうか
   * @param {string} [kind] - 種別。省略時は主筋
   * @returns {boolean} 表示状態
   */
  isVisible(kind = 'main') {
    return Boolean(this._visible.get(kind));
  }

  /**
   * 表示状態を設定する
   * @param {boolean} visible - 表示するか
   * @param {string} [kind] - 種別。省略時は主筋
   */
  setVisible(visible, kind = 'main') {
    const group = this._group(kind);
    if (!group) return;
    const next = Boolean(visible);
    this._visible.set(kind, next);
    group.visible = next;
  }

  /**
   * 生成済みの鉄筋メッシュを差し替える
   * @param {Array<THREE.Object3D>} meshes - 追加するメッシュ配列
   * @param {string} [kind] - 種別。省略時は主筋
   */
  setMeshes(meshes, kind = 'main') {
    const group = this._group(kind);
    if (!group) return;

    this.clear(kind);
    for (const mesh of meshes || []) {
      group.add(mesh);
    }
    log.info(`[Render] 3D配筋メッシュを設定しました（${kind}）: ${group.children.length}件`);
  }

  /**
   * 鉄筋メッシュを削除する
   * @param {string} [kind] - 種別。省略時は全種別
   */
  clear(kind = null) {
    const targets = kind ? [kind] : REBAR_GROUP_KINDS;
    for (const target of targets) {
      const group = this._group(target);
      if (!group) continue;
      const meshes = [...group.children];
      group.clear();
      disposeRebarMeshes(meshes);
    }
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
