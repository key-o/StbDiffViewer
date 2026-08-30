/**
 * @fileoverview 節点荷重（付加重量・方向力）の矢印/ラベル描画メソッド群
 *
 * LoadDisplayManager のプロトタイプへ合成されるメソッド集合です。
 * `this` は LoadDisplayManager インスタンスを指します。
 *
 * @module viewer/rendering/loadDisplayNodeLoads
 */

import * as THREE from 'three';
import { LOAD_DISPLAY_MODE } from './loadDisplayModes.js';

/**
 * 節点荷重の処理・矢印生成メソッド群
 * @type {Object}
 */
export const nodeLoadMethods = {
  /**
   * 節点荷重を処理（重量系 StbCalNodeAddedWeight / 方向力系 StbCalPointLoad）
   */
  _processNodeLoads() {
    this._processNodeWeightLoads();
    this._processNodePointLoads();
  },

  /**
   * 節点付加重量（StbCalNodeWeightArr）を処理
   * 重量は等価鉛直荷重として下向き矢印で表示する
   */
  _processNodeWeightLoads() {
    const arrangements = this._calData.loadArrangements?.nodeWeights;
    if (!arrangements || arrangements.size === 0) return;
    const defs = this._calData.addedWeights;
    if (!defs || defs.length === 0) return;

    const downDir = new THREE.Vector3(0, 0, -1);

    for (const [nodeId, loadIds] of arrangements) {
      const coord = this._nodeMap.get(nodeId);
      if (!coord) continue;
      const position = new THREE.Vector3(coord.x, coord.y, coord.z);

      for (const loadId of loadIds) {
        const def = defs.find((d) => String(d.id) === String(loadId));
        if (!def || Math.abs(def.weight) < 1e-6) continue;
        if (this._selectedLoadCase && def.loadCaseId !== this._selectedLoadCase) continue;

        // 内部 N → 表示 kN
        this._createNodeLoadDisplay({
          mapKey: `NW_${loadId}_${nodeId}`,
          position,
          direction: downDir,
          magnitude: Math.abs(def.weight),
          labelText: `${(Math.abs(def.weight) / 1000).toFixed(this._labelPrecision)} ${this._labelUnit}`,
          color: this._getLoadCaseColorById(def.loadCaseId),
        });
      }
    }
  },

  /**
   * 節点方向力（StbCalNodePointLoadArr）を処理
   * P1..P3=Px,Py,Pz(N) は合成方向の矢印、P4..P6=Mx,My,Mz(Nmm) はラベルのみ
   */
  _processNodePointLoads() {
    const arrangements = this._calData.loadArrangements?.nodePointLoads;
    if (!arrangements || arrangements.size === 0) return;
    const defs = this._calData.pointLoads;
    if (!defs || defs.length === 0) return;

    for (const [nodeId, loadIds] of arrangements) {
      const coord = this._nodeMap.get(nodeId);
      if (!coord) continue;
      const position = new THREE.Vector3(coord.x, coord.y, coord.z);

      for (const loadId of loadIds) {
        const def = defs.find((d) => String(d.id) === String(loadId));
        if (!def) continue;
        if (this._selectedLoadCase && def.loadCaseId !== this._selectedLoadCase) continue;

        const force = new THREE.Vector3(def.P1 || 0, def.P2 || 0, def.P3 || 0);
        const forceMag = force.length();
        const momentMag = Math.hypot(def.P4 || 0, def.P5 || 0, def.P6 || 0);
        if (forceMag < 1e-6 && momentMag < 1e-6) continue;

        // 内部 N/Nmm → 表示 kN/kNm（単位表記は setLabelOptions に追従）
        const parts = [];
        if (forceMag >= 1e-6) {
          parts.push(`${(forceMag / 1000).toFixed(this._labelPrecision)} ${this._labelUnit}`);
        }
        if (momentMag >= 1e-6) {
          parts.push(`${(momentMag / 1e6).toFixed(this._labelPrecision)} ${this._labelUnit}m`);
        }

        this._createNodeLoadDisplay({
          mapKey: `NP_${loadId}_${nodeId}`,
          position,
          direction: forceMag >= 1e-6 ? force.normalize() : null,
          magnitude: forceMag,
          labelText: parts.join(' / '),
          color: this._getLoadCaseColorById(def.loadCaseId),
        });
      }
    }
  },

  /**
   * 節点荷重の矢印+ラベルを生成（矢印先端が節点に接する）
   * @param {Object} params
   * @param {string} params.mapKey - arrowMap/labelMapのキー
   * @param {THREE.Vector3} params.position - 節点座標
   * @param {THREE.Vector3|null} params.direction - 荷重方向（null=矢印なし、ラベルのみ）
   * @param {number} params.magnitude - 荷重の大きさ（スケール計算用）
   * @param {string} params.labelText - ラベル文字列
   * @param {number} params.color - 矢印色
   */
  _createNodeLoadDisplay({ mapKey, position, direction, magnitude, labelText, color }) {
    const showArrows =
      this._displayMode === LOAD_DISPLAY_MODE.ARROW || this._displayMode === LOAD_DISPLAY_MODE.BOTH;
    const showLabels =
      this._displayMode === LOAD_DISPLAY_MODE.LABEL || this._displayMode === LOAD_DISPLAY_MODE.BOTH;

    let labelPosition = position;

    if (showArrows && direction) {
      const arrowLength = Math.max(
        Math.min(magnitude * this._scale, this._maxArrowLength),
        this._minArrowLength,
      );
      const hl = Math.min(this._headLength, arrowLength * 0.3);
      const hw = Math.min(this._headWidth, hl);
      const origin = position.clone().addScaledVector(direction, -arrowLength);

      const arrow = new THREE.ArrowHelper(direction, origin, arrowLength, color, hl, hw);
      arrow.userData = { loadId: mapKey, type: 'node' };
      arrow.renderOrder = 999;
      for (const child of arrow.children) {
        child.renderOrder = 999;
        if (child.material) child.material.depthTest = false;
      }
      this._loadGroup.add(arrow);
      this._arrowMap.set(mapKey, [arrow]);
      labelPosition = origin;
    }

    if (showLabels && labelText) {
      const label = this._createTextLabel(labelPosition, labelText, { loadId: mapKey });
      this._labelMap.set(mapKey, [label]);
      this._scene.add(label);
    }
  },
};
