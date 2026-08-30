/**
 * @fileoverview Camera-frustum based visibility culling for label sprites.
 *
 * UI visibility is stored separately as `labelBaseVisible`. This culler applies
 * SectionBox semantic visibility first, then camera visibility and maximum
 * visible label limits.
 */

import * as THREE from 'three';
import { clippingStateManager } from '../clipping/ClippingStateManager.js';

const ALWAYS_VISIBLE_LABEL_TYPES = new Set(['Axis', 'Story']);
const SECTION_BOX_EPSILON = 1e-6;

export const DEFAULT_LABEL_CULLING_OPTIONS = {
  enabled: true,
  margin: 1.1,
  maxVisibleLabels: 800,
};

/**
 * @typedef {Object} LabelCullingStats
 * @property {number} total
 * @property {number} baseHidden
 * @property {number} sectionBoxHidden
 * @property {number} alwaysVisible
 * @property {number} candidates
 * @property {number} visible
 * @property {number} outside
 * @property {number} limitHidden
 */

export class LabelVisibilityCuller {
  constructor(options = {}) {
    this.options = {
      ...DEFAULT_LABEL_CULLING_OPTIONS,
      ...options,
    };
    this._projScreenMatrix = new THREE.Matrix4();
    this._projectedPosition = new THREE.Vector3();
    this._worldPosition = new THREE.Vector3();
    this._sectionBoxAnchor = new THREE.Vector3();
    this._lastStats = this._createEmptyStats();
  }

  setOptions(options = {}) {
    this.options = {
      ...this.options,
      ...options,
    };
  }

  setEnabled(enabled) {
    this.options.enabled = !!enabled;
  }

  getStats() {
    return { ...this._lastStats };
  }

  /**
   * Apply label visibility culling for the current camera.
   * @param {Array<THREE.Object3D>} labels
   * @param {THREE.Camera} camera
   * @returns {LabelCullingStats}
   */
  cullLabels(labels, camera) {
    if (!Array.isArray(labels) || labels.length === 0 || !camera) {
      this._lastStats = this._createEmptyStats();
      return this.getStats();
    }

    camera.updateMatrixWorld();
    camera.updateProjectionMatrix?.();
    this._projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    const stats = this._createEmptyStats();
    stats.total = labels.length;

    const candidates = [];
    const margin = Math.max(1, this.options.margin);
    const maxVisibleLabels = Math.max(0, this.options.maxVisibleLabels);
    const sectionBoxBounds = clippingStateManager.isSectionBoxActive()
      ? clippingStateManager.getSectionBoxBounds()
      : null;

    for (const label of labels) {
      if (!label?.userData) continue;

      const baseVisible = label.userData.labelBaseVisible ?? label.visible === true;
      label.userData.labelBaseVisible = baseVisible;

      if (!baseVisible) {
        label.visible = false;
        stats.baseHidden++;
        continue;
      }

      if (sectionBoxBounds && !this._isInsideSectionBox(label, sectionBoxBounds)) {
        label.visible = false;
        stats.sectionBoxHidden++;
        continue;
      }

      if (!this.options.enabled || ALWAYS_VISIBLE_LABEL_TYPES.has(label.userData.elementType)) {
        label.visible = true;
        stats.alwaysVisible++;
        stats.visible++;
        continue;
      }

      this._getLabelWorldPosition(label);
      this._projectedPosition.copy(this._worldPosition).applyMatrix4(this._projScreenMatrix);

      if (!this._isProjectedPositionVisible(this._projectedPosition, margin)) {
        label.visible = false;
        stats.outside++;
        continue;
      }

      label.visible = false;
      stats.candidates++;
      candidates.push({
        label,
        distanceSq: this._worldPosition.distanceToSquared(camera.position),
      });
    }

    candidates.sort((a, b) => a.distanceSq - b.distanceSq);

    const visibleCandidateCount = Math.min(candidates.length, maxVisibleLabels);
    for (let i = 0; i < visibleCandidateCount; i++) {
      candidates[i].label.visible = true;
    }

    stats.visible += visibleCandidateCount;
    stats.limitHidden = Math.max(0, candidates.length - visibleCandidateCount);
    this._lastStats = stats;
    return this.getStats();
  }

  /**
   * SectionBox内判定はラベルの描画位置ではなく、要素を表す意味上の位置で行う。
   * Story/Axisラベルはモデル外周へ配置されるため、実Sprite座標で判定すると
   * SectionBox内の参照ラベルまで全て消えてしまう。
   * @param {THREE.Object3D} label
   * @param {THREE.Box3} bounds
   * @returns {boolean}
   */
  _isInsideSectionBox(label, bounds) {
    const data = label.userData || {};
    const elementType = data.elementType;
    const meta = data.meta || {};
    const originalPosition = data.originalPosition || label.position;

    if (!originalPosition) return true;

    if (elementType === 'Story') {
      const storyHeight = Number.isFinite(meta.storyHeight) ? meta.storyHeight : originalPosition.z;
      return this._isWithin(storyHeight, bounds.min.z, bounds.max.z);
    }

    if (elementType === 'Axis') {
      const storyHeight = Number.isFinite(meta.storyHeight) ? meta.storyHeight : originalPosition.z;
      if (!this._isWithin(storyHeight, bounds.min.z, bounds.max.z)) return false;

      // 円弧/放射軸はラベル端点がSectionBox外でも軸自体が交差し得るため、
      // Z範囲だけで落とし、XYは実ジオメトリのMaterial clippingへ任せる。
      if (meta.axisKind === 'arc' || meta.axisKind === 'radial') return true;

      if (meta.axisType === 'X') {
        const x = Number.isFinite(meta.distance) ? meta.distance : originalPosition.x;
        return this._isWithin(x, bounds.min.x, bounds.max.x);
      }
      if (meta.axisType === 'Y') {
        const y = Number.isFinite(meta.distance) ? meta.distance : originalPosition.y;
        return this._isWithin(y, bounds.min.y, bounds.max.y);
      }

      return this._isPointWithin(originalPosition, bounds);
    }

    return this._isPointWithin(originalPosition, bounds);
  }

  _isPointWithin(point, bounds) {
    this._sectionBoxAnchor.copy(point);
    return (
      this._isWithin(this._sectionBoxAnchor.x, bounds.min.x, bounds.max.x) &&
      this._isWithin(this._sectionBoxAnchor.y, bounds.min.y, bounds.max.y) &&
      this._isWithin(this._sectionBoxAnchor.z, bounds.min.z, bounds.max.z)
    );
  }

  _isWithin(value, min, max) {
    return (
      Number.isFinite(value) &&
      value >= min - SECTION_BOX_EPSILON &&
      value <= max + SECTION_BOX_EPSILON
    );
  }

  _getLabelWorldPosition(label) {
    label.updateWorldMatrix?.(true, false);
    if (typeof label.getWorldPosition === 'function') {
      label.getWorldPosition(this._worldPosition);
    } else if (label.position) {
      this._worldPosition.copy(label.position);
    } else if (label.userData.originalPosition) {
      this._worldPosition.copy(label.userData.originalPosition);
    } else {
      this._worldPosition.set(0, 0, 0);
    }
  }

  _isProjectedPositionVisible(projectedPosition, margin) {
    return (
      Number.isFinite(projectedPosition.x) &&
      Number.isFinite(projectedPosition.y) &&
      Number.isFinite(projectedPosition.z) &&
      projectedPosition.x >= -margin &&
      projectedPosition.x <= margin &&
      projectedPosition.y >= -margin &&
      projectedPosition.y <= margin &&
      projectedPosition.z >= -1 &&
      projectedPosition.z <= 1
    );
  }

  _createEmptyStats() {
    return {
      total: 0,
      baseHidden: 0,
      sectionBoxHidden: 0,
      alwaysVisible: 0,
      candidates: 0,
      visible: 0,
      outside: 0,
      limitHidden: 0,
    };
  }
}

const labelVisibilityCuller = new LabelVisibilityCuller();

export function getLabelVisibilityCuller() {
  return labelVisibilityCuller;
}
