/**
 * @fileoverview 荷重ラベル（CSS2DObject）生成メソッド群
 *
 * LoadDisplayManager のプロトタイプへ合成されるメソッド集合です。
 * `this` は LoadDisplayManager インスタンスを指します。
 *
 * @module viewer/rendering/loadDisplayLabels
 */

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { LOAD_TYPES } from '../../common-stb/import/extractor/StbCalDataExtractor.js';

/**
 * 荷重ラベル生成メソッド群
 * @type {Object}
 */
export const loadLabelMethods = {
  /**
   * 荷重タイプに応じてラベルを生成
   * @param {Object} load - 荷重データ
   * @param {THREE.Vector3} start - 始点
   * @param {THREE.Vector3} end - 終点
   * @param {number} memberLength - 部材長
   * @param {string} memberType - 部材タイプ
   * @returns {Array<CSS2DObject>}
   */
  _createLabelsByType(load, start, end, memberLength, _memberType) {
    const labels = [];

    switch (load.type) {
      case LOAD_TYPES.UNIFORM_LOAD: {
        // 等分布荷重: 中央にラベル1つ
        const midPoint = new THREE.Vector3().lerpVectors(start, end, 0.5);
        const label = this._createLoadLabel(load.P1, midPoint, load.id);
        if (label) labels.push(label);
        break;
      }

      case LOAD_TYPES.POINT_LOADS: {
        // 集中荷重: 各荷重位置にラベル
        if (load.P2 !== null) {
          const t1 = (load.P2 || 0) / memberLength;
          const pos1 = new THREE.Vector3().lerpVectors(start, end, Math.min(t1, 1));
          const label1 = this._createLoadLabel(load.P1, pos1, `${load.id}_1`);
          if (label1) labels.push(label1);
        }
        if (load.P4 !== null && load.P3 !== null) {
          const t2 = (load.P4 || 0) / memberLength;
          const pos2 = new THREE.Vector3().lerpVectors(start, end, Math.min(t2, 1));
          const label2 = this._createLoadLabel(load.P3, pos2, `${load.id}_2`);
          if (label2) labels.push(label2);
        }
        break;
      }

      case LOAD_TYPES.EQUAL_POINT_LOADS: {
        // 等間隔集中荷重: 中央にまとめて1つのラベル
        const midPoint = new THREE.Vector3().lerpVectors(start, end, 0.5);
        const label = this._createLoadLabel(load.P1, midPoint, load.id);
        if (label) labels.push(label);
        break;
      }

      case LOAD_TYPES.TRAPEZOIDAL_1:
      case LOAD_TYPES.TRAPEZOIDAL_2: {
        // 台形分布荷重: 範囲の中央に範囲情報付きラベル
        const w1 = Math.abs(load.P1 || 0);
        const w2 = Math.abs(load.P2 || load.P1 || 0);
        const L1 = load.P3 || 0;
        const L2 = load.P4 || memberLength;

        const t1 = L1 / memberLength;
        const t2 = Math.min(L2 / memberLength, 1.0);
        const tMid = (t1 + t2) / 2; // 台形範囲の中央

        const midPoint = new THREE.Vector3().lerpVectors(start, end, tMid);

        // 台形分布荷重用の特別なラベルを作成
        const label = this._createTrapezoidalLoadLabel(w1, w2, midPoint, load.id);
        if (label) labels.push(label);
        break;
      }

      default: {
        // その他: 中央にラベル
        const midPoint = new THREE.Vector3().lerpVectors(start, end, 0.5);
        const label = this._createLoadLabel(load.P1, midPoint, load.id);
        if (label) labels.push(label);
      }
    }

    return labels;
  },

  /**
   * 荷重ラベルを作成
   * @param {number} loadValue - 荷重値
   * @param {THREE.Vector3} position - 位置
   * @param {string} id - ラベルID
   * @returns {CSS2DObject|null}
   */
  _createLoadLabel(loadValue, position, id) {
    if (Math.abs(loadValue) < 1e-6) return null;

    const formattedValue = Math.abs(loadValue).toFixed(this._labelPrecision);
    const text = `${formattedValue} ${this._labelUnit}`;

    return this._createTextLabel(position, text, { loadId: id, loadValue });
  },

  /**
   * テキストラベル（CSS2DObject）を作成
   * @param {THREE.Vector3} position - 位置
   * @param {string} text - 表示文字列
   * @param {Object} userData - ラベルに付与するuserData
   * @param {string} [className] - 追加CSSクラス
   * @returns {CSS2DObject}
   */
  _createTextLabel(position, text, userData, className = '') {
    const div = document.createElement('div');
    div.className = className ? `load-label ${className}` : 'load-label';
    div.textContent = text;
    div.style.fontSize = this._labelFontSize;
    div.style.color = this._labelColor;
    div.style.backgroundColor = this._labelBackgroundColor;
    div.style.padding = '2px 6px';
    div.style.borderRadius = '3px';
    div.style.userSelect = 'none';
    div.style.pointerEvents = 'none';
    div.style.whiteSpace = 'nowrap';

    const label = new CSS2DObject(div);
    label.position.copy(position);
    label.userData = userData;

    return label;
  },

  /**
   * 台形分布荷重ラベルを作成
   * @param {number} w1 - 始点荷重密度
   * @param {number} w2 - 終点荷重密度
   * @param {THREE.Vector3} position - 位置
   * @param {string} id - ラベルID
   * @returns {CSS2DObject|null}
   */
  _createTrapezoidalLoadLabel(w1, w2, position, id) {
    if (Math.abs(w1) < 1e-6 && Math.abs(w2) < 1e-6) return null;

    const formattedW1 = w1.toFixed(this._labelPrecision);
    const formattedW2 = w2.toFixed(this._labelPrecision);

    // w1とw2が同じ場合は単一値表示
    const text =
      Math.abs(w1 - w2) < 1e-6
        ? `${formattedW1} ${this._labelUnit}`
        : `${formattedW1}~${formattedW2} ${this._labelUnit}`;

    return this._createTextLabel(
      position,
      text,
      { loadId: id, w1, w2, type: 'trapezoidal' },
      'trapezoidal-load',
    );
  },
};
