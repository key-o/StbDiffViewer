/**
 * @fileoverview 荷重表示マネージャー
 *
 * STB計算データの荷重を3Dビューに矢印とラベルで可視化するモジュールです。
 *
 * 機能:
 * - 部材荷重の矢印表示
 * - 荷重値のラベル表示（CSS2DObject）
 * - 等分布荷重の複数矢印表示
 * - 集中荷重の単一矢印表示
 * - 荷重値に応じた自動スケーリング
 * - 荷重ケース別の色分け
 * - 表示モード切替（arrow/label/both/none）
 *
 * 荷重種別ごとの描画メソッドは責務別モジュールに分割し、
 * プロトタイプへ合成しています（`this` はインスタンスを指す）:
 * - 線材荷重  → ./loadDisplayMemberLoads.js
 * - 床面荷重  → ./loadDisplaySlabLoads.js
 * - 節点荷重  → ./loadDisplayNodeLoads.js
 * - ラベル生成 → ./loadDisplayLabels.js
 *
 * @module viewer/rendering/loadDisplayManager
 */

import * as THREE from 'three';
import { getLoadCaseColor } from '../../common-stb/import/extractor/StbCalDataExtractor.js';
import { LOAD_DISPLAY_MODE } from './loadDisplayModes.js';
import { memberLoadMethods } from './loadDisplayMemberLoads.js';
import { slabLoadMethods } from './loadDisplaySlabLoads.js';
import { nodeLoadMethods } from './loadDisplayNodeLoads.js';
import { loadLabelMethods } from './loadDisplayLabels.js';

export { LOAD_DISPLAY_MODE } from './loadDisplayModes.js';

/**
 * 荷重表示マネージャークラス
 */
export class LoadDisplayManager {
  /**
   * @param {THREE.Scene} scene - Three.jsシーン
   * @param {Object} options - オプション
   */
  constructor(scene, options = {}) {
    this._scene = scene;
    this._loadGroup = new THREE.Group();
    this._loadGroup.name = 'LoadDisplayGroup';
    this._scene.add(this._loadGroup);

    this._arrowMap = new Map(); // loadId -> ArrowHelper[]
    this._labelMap = new Map(); // loadId -> CSS2DObject[]
    this._displayMode = LOAD_DISPLAY_MODE.NONE;
    this._scale = options.scale || 1.0;
    this._arrowColor = options.arrowColor || 0xff4444;
    this._headLength = options.headLength || 100;
    this._headWidth = options.headWidth || 50;

    // ラベル設定
    this._labelPrecision = options.labelPrecision || 2; // 小数点桁数
    this._labelUnit = options.labelUnit || 'kN'; // 単位
    this._labelFontSize = options.labelFontSize || '12px';
    this._labelColor = options.labelColor || '#ffffff';
    this._labelBackgroundColor = options.labelBackgroundColor || 'rgba(0, 0, 0, 0.7)';

    this._calData = null;
    this._nodeMap = null;
    this._memberData = null;

    this._maxArrowLength = options.maxArrowLength || 500;
    this._minArrowLength = options.minArrowLength || 0;
    this._isVisible = false;
    this._selectedLoadCase = null;
  }

  /**
   * 計算データと部材データを設定
   * @param {Object} calData - StbCalData解析結果
   * @param {Map} nodeMap - 節点マップ
   * @param {Object} memberData - 部材データ
   */
  setData(calData, nodeMap, memberData) {
    this._calData = calData;
    this._nodeMap = nodeMap;
    this._memberData = memberData;

    if (calData && this._isVisible) {
      this.updateDisplay();
    }
  }

  /**
   * 表示モードを設定
   * @param {string} mode - LOAD_DISPLAY_MODE
   */
  setDisplayMode(mode) {
    this._displayMode = mode;
    this._isVisible = mode !== LOAD_DISPLAY_MODE.NONE;

    if (this._calData) {
      this.updateDisplay();
    }
  }

  /**
   * 表示/非表示を切り替え
   */
  toggle() {
    if (this._displayMode === LOAD_DISPLAY_MODE.NONE) {
      this.setDisplayMode(LOAD_DISPLAY_MODE.ARROW);
    } else {
      this.setDisplayMode(LOAD_DISPLAY_MODE.NONE);
    }
  }

  /**
   * 矢印スケールを設定
   * @param {number} scale - スケール値
   */
  setScale(scale) {
    this._scale = scale;
    if (this._isVisible) {
      this.updateDisplay();
    }
  }

  /**
   * 荷重ケースを選択
   * @param {string|null} loadCaseId - 荷重ケースID（null=全て表示）
   */
  selectLoadCase(loadCaseId) {
    this._selectedLoadCase = loadCaseId;
    if (this._isVisible) {
      this.updateDisplay();
    }
  }

  /**
   * ラベル設定を更新
   * @param {Object} options - ラベル設定
   */
  setLabelOptions(options = {}) {
    if (options.precision !== undefined) {
      this._labelPrecision = options.precision;
    }
    if (options.unit !== undefined) {
      this._labelUnit = options.unit;
    }
    if (options.fontSize !== undefined) {
      this._labelFontSize = options.fontSize;
    }
    if (options.color !== undefined) {
      this._labelColor = options.color;
    }
    if (options.backgroundColor !== undefined) {
      this._labelBackgroundColor = options.backgroundColor;
    }

    // ラベル表示中なら更新
    if (
      this._displayMode === LOAD_DISPLAY_MODE.LABEL ||
      this._displayMode === LOAD_DISPLAY_MODE.BOTH
    ) {
      this.updateDisplay();
    }
  }

  /**
   * バウンディングボックスから自動スケールを計算
   * @param {THREE.Box3} boundingBox - モデルのバウンディングボックス
   */
  computeAutoScale(boundingBox) {
    if (!boundingBox || !this._calData) return;

    const size = new THREE.Vector3();
    boundingBox.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);

    // 矢印の最大長をモデルサイズの10%に設定
    const targetArrowLength = maxDim * 0.1;

    // 最大荷重値を取得
    let maxLoad = 0;
    for (const load of this._calData.memberLoads) {
      const loadValue = Math.abs(load.P1);
      if (loadValue > maxLoad) {
        maxLoad = loadValue;
      }
    }

    // 部材荷重が無い場合は節点荷重（重量/方向力）からスケールを算出
    if (maxLoad <= 1e-6) {
      for (const w of this._calData.addedWeights || []) {
        maxLoad = Math.max(maxLoad, Math.abs(w.weight));
      }
      for (const p of this._calData.pointLoads || []) {
        maxLoad = Math.max(maxLoad, Math.hypot(p.P1 || 0, p.P2 || 0, p.P3 || 0));
      }
    }

    if (maxLoad > 1e-6) {
      this._scale = targetArrowLength / maxLoad;
    }

    // ヘッドサイズ・上限値・最小値をモデルサイズに連動
    this._headLength = maxDim * 0.008;
    this._headWidth = maxDim * 0.004;
    this._maxArrowLength = maxDim * 0.15;
    this._minArrowLength = maxDim * 0.02;
  }

  /**
   * 全ての荷重表示を更新（矢印とラベル）
   */
  updateDisplay() {
    this.clearArrows();
    this.clearLabels();

    if (!this._calData || !this._nodeMap || !this._memberData) {
      return;
    }

    if (this._displayMode === LOAD_DISPLAY_MODE.NONE) {
      return;
    }

    // スケールが未計算（デフォルト値）の場合、シーンから自動計算を試みる
    if (this._scale <= 1.0 && this._scene) {
      const box = new THREE.Box3().setFromObject(this._scene);
      if (!box.isEmpty()) {
        this.computeAutoScale(box);
      }
    }

    // 柱の荷重を処理
    this._processColumnLoads();

    // 大梁の荷重を処理
    this._processGirderLoads();

    // 小梁の荷重を処理
    this._processBeamLoads();

    // 床面荷重を処理
    this._processSlabLoads();

    // 節点荷重を処理
    this._processNodeLoads();
  }

  /**
   * 旧メソッド名との互換性のため残す
   */
  updateAllArrows() {
    this.updateDisplay();
  }

  /**
   * 荷重ケースIDから表示色を取得
   * @param {string} loadCaseId - 荷重ケースID
   * @returns {number} 16進数色値
   */
  _getLoadCaseColorById(loadCaseId) {
    const loadCase = this._calData.loadCases?.find((lc) => lc.id === loadCaseId);
    return loadCase ? getLoadCaseColor(loadCase.kind) : this._arrowColor;
  }

  /**
   * 全ての矢印をクリア
   */
  clearArrows() {
    for (const arrows of this._arrowMap.values()) {
      for (const obj of arrows) {
        this._loadGroup.remove(obj);
        if (obj.isLine) {
          obj.geometry?.dispose();
          obj.material?.dispose();
        } else {
          obj.dispose?.();
        }
      }
    }
    this._arrowMap.clear();
  }

  /**
   * 全てのラベルをクリア
   */
  clearLabels() {
    for (const labels of this._labelMap.values()) {
      for (const label of labels) {
        this._scene.remove(label);
        // CSS2DObjectのDOMエレメントを削除
        if (label.element) {
          label.element.remove();
        }
      }
    }
    this._labelMap.clear();
  }

  /**
   * リソースを解放
   */
  dispose() {
    this.clearArrows();
    this.clearLabels();
    if (this._scene && this._loadGroup) {
      this._scene.remove(this._loadGroup);
    }
    this._loadGroup = null;
    this._calData = null;
    this._nodeMap = null;
    this._memberData = null;
  }

  /**
   * 表示状態を取得
   * @returns {boolean}
   */
  get isVisible() {
    return this._isVisible;
  }

  /**
   * 荷重ケース一覧を取得
   * @returns {Array}
   */
  getLoadCases() {
    return this._calData?.loadCases || [];
  }

  /**
   * 部材荷重一覧を取得
   * @returns {Array}
   */
  getMemberLoads() {
    return this._calData?.memberLoads || [];
  }
}

// 荷重種別ごとの描画メソッドをプロトタイプへ合成する
Object.assign(
  LoadDisplayManager.prototype,
  memberLoadMethods,
  slabLoadMethods,
  nodeLoadMethods,
  loadLabelMethods,
);

// シングルトンインスタンス
let instance = null;

/**
 * LoadDisplayManagerのシングルトンインスタンスを取得
 * @param {THREE.Scene} scene - シーン（初回のみ必須）
 * @returns {LoadDisplayManager|null}
 */
export function getLoadDisplayManager(scene = null) {
  if (!instance && scene) {
    instance = new LoadDisplayManager(scene);
  }
  return instance;
}

/**
 * LoadDisplayManagerを初期化
 * @param {THREE.Scene} scene - シーン
 * @param {Object} options - オプション
 * @returns {LoadDisplayManager}
 */
export function initLoadDisplayManager(scene, options = {}) {
  if (instance) {
    instance.dispose();
  }
  instance = new LoadDisplayManager(scene, options);
  return instance;
}
