/**
 * @fileoverview 床面荷重（仕上げ荷重・積載荷重）の矢印描画メソッド群
 *
 * LoadDisplayManager のプロトタイプへ合成されるメソッド集合です。
 * `this` は LoadDisplayManager インスタンスを指します。
 *
 * @module viewer/rendering/loadDisplaySlabLoads
 */

import * as THREE from 'three';
import { LOAD_DISPLAY_MODE } from './loadDisplayModes.js';

/**
 * 床面荷重の処理・矢印生成メソッド群
 * @type {Object}
 */
export const slabLoadMethods = {
  /**
   * 床面荷重を処理（仕上げ荷重・積載荷重）
   */
  _processSlabLoads() {
    // 荷重ケースが絞り込まれている場合は床面荷重を非表示（荷重ケースなし）
    if (this._selectedLoadCase) return;

    const { slabFinishes, slabLiveloads } = this._calData.loadArrangements;
    const hasFinish = slabFinishes?.size > 0;
    const hasLive = slabLiveloads?.size > 0;
    if (!hasFinish && !hasLive) return;
    if (!this._memberData?.slabs) return;

    const downDir = new THREE.Vector3(0, 0, -1);

    if (hasFinish) {
      for (const [finishId, slabIds] of slabFinishes) {
        const finishDef = this._calData.slabFinishDefs?.find(
          (d) => String(d.id) === String(finishId),
        );
        if (!finishDef || finishDef.weight <= 0) continue;
        for (const slabId of slabIds) {
          this._createSlabLoadArrows(
            slabId,
            finishDef.weight,
            downDir,
            `FIN_${finishId}`,
            0x4488ff,
            'finish',
          );
        }
      }
    }

    if (hasLive) {
      for (const [liveloadId, slabIds] of slabLiveloads) {
        const liveDef = this._calData.loadCondition?.liveloads?.find(
          (l) => String(l.id) === String(liveloadId),
        );
        if (!liveDef || !(liveDef.slabLoad > 0)) continue;
        for (const slabId of slabIds) {
          this._createSlabLoadArrows(
            slabId,
            liveDef.slabLoad,
            downDir,
            `LL_${liveloadId}`,
            0xff8800,
            'liveload',
          );
        }
      }
    }
  },

  /**
   * 床スラブ上に面荷重矢印を配置
   * @param {string} slabId - スラブID
   * @param {number} weight - 荷重強度 (N/mm²)
   * @param {THREE.Vector3} direction - 荷重方向（単位ベクトル）
   * @param {string} loadKey - 荷重識別キー（arrowMap/labelMapのキーに使用）
   * @param {number} color - 矢印色（16進数）
   * @param {string} type - 荷重タイプ文字列
   */
  _createSlabLoadArrows(slabId, weight, direction, loadKey, color, type) {
    const slabEl = this._findMemberById(this._memberData.slabs, slabId);
    if (!slabEl) return;

    const nodeIdOrderEl = slabEl.getElementsByTagName?.('StbNodeIdOrder')?.[0];
    if (!nodeIdOrderEl) return;

    const nodeIds = (nodeIdOrderEl.textContent || '').trim().split(/\s+/).filter(Boolean);
    if (nodeIds.length < 3) return;

    const vertices = [];
    for (const nodeId of nodeIds) {
      const coord = this._nodeMap.get(nodeId);
      if (coord) vertices.push(new THREE.Vector3(coord.x, coord.y, coord.z));
    }
    if (vertices.length < 3) return;

    const gridPoints = this._computeSlabGridPoints(vertices);
    const arrowLen = Math.max(this._minArrowLength, this._maxArrowLength * 0.15);
    const hl = Math.min(this._headLength * 0.5, arrowLen * 0.3);
    const hw = Math.min(this._headWidth * 0.5, hl);

    const showArrows =
      this._displayMode === LOAD_DISPLAY_MODE.ARROW || this._displayMode === LOAD_DISPLAY_MODE.BOTH;
    const showLabels =
      this._displayMode === LOAD_DISPLAY_MODE.LABEL || this._displayMode === LOAD_DISPLAY_MODE.BOTH;

    const mapKey = `${loadKey}_${slabId}`;

    if (showArrows && gridPoints.length > 0) {
      const arrows = [];
      for (const pt of gridPoints) {
        const origin = pt.clone().addScaledVector(direction, -arrowLen);
        const arrow = new THREE.ArrowHelper(direction, origin, arrowLen, color, hl, hw);
        arrow.userData = { loadId: mapKey, type };
        arrow.renderOrder = 999;
        for (const child of arrow.children) {
          child.renderOrder = 999;
          if (child.material) child.material.depthTest = false;
        }
        arrows.push(arrow);
        this._loadGroup.add(arrow);
      }
      this._arrowMap.set(mapKey, arrows);
    }

    if (showLabels) {
      const centroid = new THREE.Vector3();
      for (const v of vertices) centroid.add(v);
      centroid.divideScalar(vertices.length);
      // N/mm² → kN/m² (×1000) for display
      const label = this._createLoadLabel(weight * 1000, centroid, mapKey);
      if (label) {
        this._labelMap.set(mapKey, [label]);
        this._scene.add(label);
      }
    }
  },

  /**
   * スラブ多角形内にグリッド点を生成（X-Y平面投影、平均Z使用）
   * @param {THREE.Vector3[]} vertices
   * @returns {THREE.Vector3[]}
   */
  _computeSlabGridPoints(vertices) {
    let minX = Infinity,
      maxX = -Infinity;
    let minY = Infinity,
      maxY = -Infinity;
    let avgZ = 0;

    for (const v of vertices) {
      if (v.x < minX) minX = v.x;
      if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.y > maxY) maxY = v.y;
      avgZ += v.z;
    }
    avgZ /= vertices.length;

    const gridN = 3;
    const points = [];
    for (let i = 0; i <= gridN; i++) {
      for (let j = 0; j <= gridN; j++) {
        const px = minX + (i / gridN) * (maxX - minX);
        const py = minY + (j / gridN) * (maxY - minY);
        if (this._isPointInPolygonXY(px, py, vertices)) {
          points.push(new THREE.Vector3(px, py, avgZ));
        }
      }
    }

    if (points.length === 0) {
      points.push(new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, avgZ));
    }

    return points;
  },

  /**
   * Ray casting による点の多角形内判定（X-Y投影）
   * @param {number} px
   * @param {number} py
   * @param {THREE.Vector3[]} vertices
   * @returns {boolean}
   */
  _isPointInPolygonXY(px, py, vertices) {
    let inside = false;
    const n = vertices.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = vertices[i].x,
        yi = vertices[i].y;
      const xj = vertices[j].x,
        yj = vertices[j].y;
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  },
};
