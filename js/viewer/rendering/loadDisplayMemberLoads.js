/**
 * @fileoverview 線材（柱・大梁・小梁）荷重の矢印描画メソッド群
 *
 * LoadDisplayManager のプロトタイプへ合成されるメソッド集合です。
 * `this` は LoadDisplayManager インスタンスを指します。
 *
 * @module viewer/rendering/loadDisplayMemberLoads
 */

import * as THREE from 'three';
import { LOAD_TYPES } from '../../common-stb/import/extractor/StbCalDataExtractor.js';
import { LOAD_DISPLAY_MODE } from './loadDisplayModes.js';

/**
 * 線材荷重の処理・矢印生成メソッド群
 * @type {Object}
 */
export const memberLoadMethods = {
  /**
   * 柱荷重を処理
   */
  _processColumnLoads() {
    this._processMemberLoads(
      this._memberData.columns,
      this._calData.loadArrangements.columns,
      'column',
    );
  },

  /**
   * 大梁荷重を処理
   */
  _processGirderLoads() {
    this._processMemberLoads(
      this._memberData.girders,
      this._calData.loadArrangements.girders,
      'girder',
    );
  },

  /**
   * 小梁荷重を処理
   */
  _processBeamLoads() {
    this._processMemberLoads(this._memberData.beams, this._calData.loadArrangements.beams, 'beam');
  },

  /**
   * 線材の荷重を共通処理する
   * @param {Array} members - 部材配列
   * @param {Map<string, Array<string>>} arrangements - 部材IDごとの荷重ID
   * @param {'column'|'girder'|'beam'} memberType - 部材タイプ
   */
  _processMemberLoads(members, arrangements, memberType) {
    if (!members || !arrangements || arrangements.size === 0) return;

    for (const [memberId, loadIds] of arrangements) {
      const member = this._findMemberById(members, memberId);
      if (!member) continue;

      for (const loadId of loadIds) {
        const load = this._findLoadById(loadId);
        if (!load) continue;
        if (this._selectedLoadCase && load.loadCaseId !== this._selectedLoadCase) continue;

        this._createLoadArrows(member, load, memberType);
      }
    }
  },

  /**
   * 部材IDで部材を検索
   * @param {Array} members - 部材配列
   * @param {string} id - 部材ID
   * @returns {Object|null}
   */
  _findMemberById(members, id) {
    if (!members) return null;
    for (const member of members) {
      if (member.id === id || member.getAttribute?.('id') === id) {
        return member;
      }
    }
    return null;
  },

  /**
   * 荷重IDで荷重を検索
   * @param {string} id - 荷重ID
   * @returns {Object|null}
   */
  _findLoadById(id) {
    if (!this._calData?.memberLoads) return null;
    return this._calData.memberLoads.find((ml) => ml.id === id) || null;
  },

  /**
   * 荷重矢印とラベルを作成
   * @param {Object} member - 部材データ
   * @param {Object} load - 荷重データ
   * @param {string} memberType - 部材タイプ
   */
  _createLoadArrows(member, load, memberType) {
    const isColumn = memberType === 'column';
    const startNodeId = isColumn
      ? member.getAttribute?.('id_node_bottom') || member.id_node_bottom
      : member.getAttribute?.('id_node_start') || member.id_node_start;
    const endNodeId = isColumn
      ? member.getAttribute?.('id_node_top') || member.id_node_top
      : member.getAttribute?.('id_node_end') || member.id_node_end;

    if (!startNodeId || !endNodeId) return;

    const startCoord = this._nodeMap.get(startNodeId);
    const endCoord = this._nodeMap.get(endNodeId);

    if (!startCoord || !endCoord) return;

    const start = new THREE.Vector3(startCoord.x, startCoord.y, startCoord.z);
    const end = new THREE.Vector3(endCoord.x, endCoord.y, endCoord.z);
    const memberLength = start.distanceTo(end);

    // 荷重ケースの色を取得
    const color = this._getLoadCaseColorById(load.loadCaseId);

    const showArrows =
      this._displayMode === LOAD_DISPLAY_MODE.ARROW || this._displayMode === LOAD_DISPLAY_MODE.BOTH;
    const showLabels =
      this._displayMode === LOAD_DISPLAY_MODE.LABEL || this._displayMode === LOAD_DISPLAY_MODE.BOTH;

    // 矢印を生成
    if (showArrows) {
      const arrows = this._createArrowsByType(load, start, end, memberLength, color, memberType);

      if (arrows.length > 0) {
        this._arrowMap.set(load.id, arrows);
        for (const arrow of arrows) {
          // 矢印を建物ジオメトリの上に描画（Z-fighting防止）
          arrow.renderOrder = 999;
          for (const child of arrow.children) {
            child.renderOrder = 999;
            if (child.material) {
              child.material.depthTest = false;
            }
          }
          this._loadGroup.add(arrow);
        }
      }
    }

    // ラベルを生成
    if (showLabels) {
      const labels = this._createLabelsByType(load, start, end, memberLength, memberType);

      if (labels.length > 0) {
        this._labelMap.set(load.id, labels);
        for (const label of labels) {
          this._scene.add(label);
        }
      }
    }
  },

  /**
   * 荷重タイプに応じて矢印を生成
   * @param {Object} load - 荷重データ
   * @param {THREE.Vector3} start - 始点
   * @param {THREE.Vector3} end - 終点
   * @param {number} memberLength - 部材長
   * @param {number} color - 色
   * @param {string} memberType - 部材タイプ
   * @returns {Array<THREE.ArrowHelper>}
   */
  _createArrowsByType(load, start, end, memberLength, color, memberType) {
    const arrows = [];

    switch (load.type) {
      case LOAD_TYPES.UNIFORM_LOAD: {
        // 等分布荷重: 矢印先端が部材に接し、根元を横線でつなぐ
        const numArrows = Math.max(5, Math.floor(memberLength / 1000));
        const loadDir = this._getLoadDirection(load, start, end, memberType);
        // 矢印は荷重方向（loadDir）に向かって部材へ刺さる
        const arrowDir = loadDir.clone();
        const arrowLength = Math.abs(load.P1) * this._scale;
        const clampedLength = Math.max(
          Math.min(arrowLength, this._maxArrowLength),
          this._minArrowLength,
        );
        const hl = Math.min(this._headLength * 0.5, clampedLength * 0.3);
        const hw = Math.min(this._headWidth * 0.5, hl);

        // 根元（荷重線）の位置を収集して横線を引く
        const basePoints = [];

        for (let i = 0; i <= numArrows; i++) {
          const t = i / numArrows;
          // 部材上の点（矢印の先端位置）
          const tipPosition = new THREE.Vector3().lerpVectors(start, end, t);
          // 矢印の根元 = 先端から loadDir の逆方向に clampedLength だけ離れた位置
          const origin = tipPosition.clone().addScaledVector(loadDir, -clampedLength);

          const arrow = new THREE.ArrowHelper(arrowDir, origin, clampedLength, color, hl, hw);
          arrow.userData = { loadId: load.id, type: 'uniform' };
          arrows.push(arrow);
          basePoints.push(origin);
        }

        // 根元を横線でつなぐ
        if (basePoints.length >= 2) {
          const lineGeometry = new THREE.BufferGeometry().setFromPoints(basePoints);
          const lineMaterial = new THREE.LineBasicMaterial({ color });
          const baseLine = new THREE.Line(lineGeometry, lineMaterial);
          baseLine.userData = { loadId: load.id, type: 'uniform_baseline' };
          baseLine.renderOrder = 999;
          baseLine.material.depthTest = false;
          arrows.push(baseLine);
        }
        break;
      }

      case LOAD_TYPES.POINT_LOADS: {
        // 集中荷重: 指定位置に矢印（先端が部材に接し、荷重方向に向かう）
        const direction = this._getLoadDirection(load, start, end, memberType);
        const positions = [];

        if (load.P2 !== null) {
          // L1の位置に荷重P1
          const t1 = (load.P2 || 0) / memberLength;
          positions.push({ t: Math.min(t1, 1), value: load.P1 });
        }
        if (load.P4 !== null && load.P3 !== null) {
          // L2の位置に荷重P3
          const t2 = (load.P4 || 0) / memberLength;
          positions.push({ t: Math.min(t2, 1), value: load.P3 });
        }

        for (const pos of positions) {
          const tipPosition = new THREE.Vector3().lerpVectors(start, end, pos.t);
          const arrowLength = Math.abs(pos.value) * this._scale;
          const clampedLen = Math.max(
            Math.min(arrowLength, this._maxArrowLength),
            this._minArrowLength,
          );
          const hl = Math.min(this._headLength, clampedLen * 0.3);
          const hw = Math.min(this._headWidth, hl);
          // 根元 = 先端から荷重方向の逆に離れた位置
          const origin = tipPosition.clone().addScaledVector(direction, -clampedLen);

          const arrow = new THREE.ArrowHelper(direction, origin, clampedLen, color, hl, hw);
          arrow.userData = { loadId: load.id, type: 'point' };
          arrows.push(arrow);
        }
        break;
      }

      case LOAD_TYPES.EQUAL_POINT_LOADS: {
        // 等間隔集中荷重（先端が部材に接し、荷重方向に向かう）
        const numLoads = Math.max(1, Math.floor(load.P2 || 1));
        const direction = this._getLoadDirection(load, start, end, memberType);
        const arrowLength = Math.abs(load.P1) * this._scale;
        const clampedLen = Math.max(
          Math.min(arrowLength, this._maxArrowLength),
          this._minArrowLength,
        );
        const hl = Math.min(this._headLength, clampedLen * 0.3);
        const hw = Math.min(this._headWidth, hl);

        for (let i = 0; i < numLoads; i++) {
          const t = (i + 1) / (numLoads + 1);
          const tipPosition = new THREE.Vector3().lerpVectors(start, end, t);
          // 根元 = 先端から荷重方向の逆に離れた位置
          const origin = tipPosition.clone().addScaledVector(direction, -clampedLen);

          const arrow = new THREE.ArrowHelper(direction, origin, clampedLen, color, hl, hw);
          arrow.userData = { loadId: load.id, type: 'equal_point' };
          arrows.push(arrow);
        }
        break;
      }

      case LOAD_TYPES.TRAPEZOIDAL_1:
      case LOAD_TYPES.TRAPEZOIDAL_2: {
        // 台形分布荷重: 矢印先端が部材に接し、根元を折れ線でつなぐ
        // P1 = w1 (始点荷重密度), P2 = w2 (終点荷重密度)
        // P3 = L1 (開始位置), P4 = L2 (終了位置)
        const numArrows = Math.max(5, Math.floor(memberLength / 1000));
        const loadDir = this._getLoadDirection(load, start, end, memberType);
        const arrowDir = loadDir.clone();

        const w1 = Math.abs(load.P1 || 0);
        const w2 = Math.abs(load.P2 || load.P1 || 0);
        const L1 = load.P3 || 0;
        const L2 = load.P4 || memberLength;

        const t1 = L1 / memberLength;
        const t2 = Math.min(L2 / memberLength, 1.0);

        const basePoints = [];

        for (let i = 0; i <= numArrows; i++) {
          const localT = i / numArrows;
          const globalT = t1 + localT * (t2 - t1);

          if (globalT < 0 || globalT > 1) continue;

          const tipPosition = new THREE.Vector3().lerpVectors(start, end, globalT);

          const w = w1 + (w2 - w1) * localT;
          const arrowLength = w * this._scale;

          if (arrowLength < 1e-6) continue;

          const clampedLen = Math.max(
            Math.min(arrowLength, this._maxArrowLength),
            this._minArrowLength,
          );
          const hl = Math.min(this._headLength * 0.5, clampedLen * 0.3);
          const hw = Math.min(this._headWidth * 0.5, hl);

          // 根元 = 先端から荷重方向の逆に離れた位置
          const origin = tipPosition.clone().addScaledVector(loadDir, -clampedLen);

          const arrow = new THREE.ArrowHelper(arrowDir, origin, clampedLen, color, hl, hw);
          arrow.userData = { loadId: load.id, type: 'trapezoidal', loadValue: w };
          arrows.push(arrow);
          basePoints.push(origin);
        }

        // 根元を折れ線でつなぐ（台形の上辺）
        if (basePoints.length >= 2) {
          const lineGeometry = new THREE.BufferGeometry().setFromPoints(basePoints);
          const lineMaterial = new THREE.LineBasicMaterial({ color });
          const baseLine = new THREE.Line(lineGeometry, lineMaterial);
          baseLine.userData = { loadId: load.id, type: 'trapezoidal_baseline' };
          baseLine.renderOrder = 999;
          baseLine.material.depthTest = false;
          arrows.push(baseLine);
        }
        break;
      }

      default: {
        // その他のタイプ: 部材中央に代表矢印を表示（先端が部材に接し、荷重方向に向かう）
        const tipPoint = new THREE.Vector3().lerpVectors(start, end, 0.5);
        const direction = this._getLoadDirection(load, start, end, memberType);
        const arrowLength = Math.abs(load.P1) * this._scale;
        const clampedLen = Math.max(
          Math.min(arrowLength, this._maxArrowLength),
          this._minArrowLength,
        );
        const hl = Math.min(this._headLength, clampedLen * 0.3);
        const hw = Math.min(this._headWidth, hl);
        const origin = tipPoint.clone().addScaledVector(direction, -clampedLen);

        const arrow = new THREE.ArrowHelper(direction, origin, clampedLen, color, hl, hw);
        arrow.userData = { loadId: load.id, type: 'other' };
        arrows.push(arrow);
      }
    }

    return arrows;
  },

  /**
   * 荷重の作用方向を取得
   * @param {Object} load - 荷重データ
   * @param {THREE.Vector3} start - 始点
   * @param {THREE.Vector3} end - 終点
   * @param {string} memberType - 部材タイプ
   * @returns {THREE.Vector3}
   */
  _getLoadDirection(load, start, end, memberType) {
    const directionToken = (load.directionLoad || '').toUpperCase();
    const coordinateToken = (load.coordinateSystem || '').toUpperCase();

    const axis =
      this._parseLoadDirectionAxis(directionToken) || this._parseLoadDirectionAxis(coordinateToken);
    if (axis) {
      return axis;
    }

    if (
      coordinateToken === 'LOCAL' ||
      coordinateToken === 'GLOBAL' ||
      coordinateToken === 'PROJECTION'
    ) {
      if (memberType === 'column') {
        return new THREE.Vector3(0, -1, 0);
      }
      return new THREE.Vector3(0, 0, -1);
    }

    if (memberType === 'column') {
      return new THREE.Vector3(-1, 0, 0);
    }
    return new THREE.Vector3(0, 0, -1);
  },

  _parseLoadDirectionAxis(token) {
    if (!token) return null;
    switch (token) {
      case 'X':
      case '+X':
      case '-X':
      case 'UX':
      case 'DX':
        return new THREE.Vector3(-1, 0, 0);
      case 'Y':
      case '+Y':
      case '-Y':
      case 'UY':
      case 'DY':
        return new THREE.Vector3(0, -1, 0);
      case 'Z':
      case '+Z':
      case '-Z':
      case 'UZ':
      case 'DZ':
        return new THREE.Vector3(0, 0, -1);
      default:
        return null;
    }
  },
};
