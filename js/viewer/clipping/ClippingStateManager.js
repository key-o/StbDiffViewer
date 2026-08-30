/**
 * @fileoverview Viewer clipping state single source of truth.
 *
 * Normal clipping uses renderer-global planes. SectionBox uses material-local
 * planes because stencil meshes must be able to use a different clipping set.
 * This manager owns that distinction so material creation/render lifecycle code
 * does not have to infer active state from renderer.clippingPlanes.
 */

import * as THREE from 'three';
import { updateBoxClippingPlanes } from './clippingPlaneFactory.js';

const NO_LOCAL_CLIPPING_PLANES = Object.freeze([]);

function normalizePlanes(planes) {
  return Array.isArray(planes) ? planes.filter((plane) => plane instanceof THREE.Plane) : [];
}

function normalizeRoots(roots) {
  if (!roots) return [];
  if (roots instanceof THREE.Object3D) return [{ type: null, root: roots }];
  if (Array.isArray(roots)) {
    return roots
      .filter((root) => root instanceof THREE.Object3D)
      .map((root) => ({ type: null, root }));
  }
  if (typeof roots === 'object') {
    return Object.entries(roots)
      .filter(([, root]) => root instanceof THREE.Object3D)
      .map(([type, root]) => ({ type, root }));
  }
  return [];
}

function resolveObjectClippingPolicy(object, rootType) {
  // SectionBox UIとStencilCapはそれぞれ自身のMaterial/Plane契約を持つ。
  // Scene全体をclipping rootにした場合でも、ここではmaterial.clippingPlanesを
  // 書き換えず、外部管理状態をそのまま保持する。
  if (
    object?.userData?.isSectionBox === true ||
    object?.userData?.isSectionBoxHandle === true ||
    object?.userData?.isStencilCap === true
  ) {
    return { skip: true };
  }

  if (object?.userData?.clippingExempt === true) {
    return { clippingExempt: true, sectionBoxExempt: true };
  }

  // ラベルは実際の表示位置をモデル外へ逃がすものがあるため、Material clipping
  // ではなくLabelVisibilityCuller側で意味上のアンカー位置を用いて判定する。
  if (object?.userData?.isLabel === true) {
    return { clippingExempt: false, sectionBoxExempt: true };
  }

  // Node / Axis / Story も「参照要素」であることとSectionBox外表示は別概念。
  // GridHelper等を含むworld-space renderableも、明示exemptでなければ同じ6面で制限する。
  void rootType;
  return {
    clippingExempt: false,
    sectionBoxExempt: false,
  };
}

export class ClippingStateManager {
  constructor() {
    /** @type {THREE.WebGLRenderer|null} */
    this._renderer = null;
    /** @type {THREE.Plane[]} */
    this._normalPlanes = [];
    /** @type {THREE.Plane[]} */
    this._sectionBoxPlanes = [];
    this._sectionBoxActive = false;
    /** @type {THREE.Box3|null} */
    this._sectionBoxBounds = null;
    /** @type {Map<THREE.Material, THREE.Plane[]|null|undefined>} */
    this._sectionBoxPreviousMaterialPlanes = new Map();
  }

  /** @param {THREE.WebGLRenderer|null} renderer */
  setRenderer(renderer) {
    this._renderer = renderer || null;
    this._syncRendererState();
  }

  /** @returns {boolean} */
  isSectionBoxActive() {
    return this._sectionBoxActive;
  }

  /** @returns {THREE.Plane[]} */
  getNormalPlanes() {
    return this._normalPlanes;
  }

  /** @returns {THREE.Plane[]} */
  getSectionBoxPlanes() {
    return this._sectionBoxPlanes;
  }

  /**
   * UI/annotation側がSectionBoxの意味上の表示範囲を判定するためのBox3を返す。
   * `setSectionBoxPlanes()` は任意Plane配列も受け付けるため、その経路ではnull。
   * @returns {THREE.Box3|null}
   */
  getSectionBoxBounds() {
    return this._sectionBoxBounds ? this._sectionBoxBounds.clone() : null;
  }

  /**
   * Material-local clipping policy.
   *
   * 通常クリッピングは renderer-global のみで適用するため、SectionBoxが
   * 非アクティブなら常に空配列を返す。SectionBox中だけRenderableへ6面を返し、
   * 明示exemptまたは意味位置で別判定するラベルだけローカルclip対象外とする。
   * @param {{sectionBoxExempt?: boolean, clippingExempt?: boolean}} [options]
   * @returns {THREE.Plane[]}
   */
  getMaterialPlanes(options = {}) {
    if (options.clippingExempt === true) return NO_LOCAL_CLIPPING_PLANES;
    if (this._sectionBoxActive && options.sectionBoxExempt !== true) {
      return this._sectionBoxPlanes;
    }
    return NO_LOCAL_CLIPPING_PLANES;
  }

  /**
   * Apply the active local clipping policy to one material. This is also used by
   * ColorManager cache hits, so a material created before SectionBox activation
   * cannot re-enter the scene with stale clipping state.
   * @param {THREE.Material} material
   * @param {{sectionBoxExempt?: boolean, clippingExempt?: boolean}} [options]
   * @returns {boolean} true when clippingPlanes reference changed
   */
  applyToMaterial(material, options = {}) {
    if (!(material instanceof THREE.Material)) return false;

    const sectionBoxExempt = options.sectionBoxExempt === true;
    const clippingExempt = options.clippingExempt === true;
    const targetPlanes = this.getMaterialPlanes({ sectionBoxExempt, clippingExempt });

    if (
      this._sectionBoxActive &&
      !sectionBoxExempt &&
      !clippingExempt &&
      !this._sectionBoxPreviousMaterialPlanes.has(material)
    ) {
      // SectionBox中に新規生成されたMaterialは、生成時点ですでにSectionBox 6面や
      // legacyな通常clip配列を持つ場合がある。通常clipはrenderer-global契約なので、
      // それらを解除後のlocal復帰先として保持せず「local clipなし」に正規化する。
      const currentPlanes = material.clippingPlanes;
      const previousPlanes =
        currentPlanes === this._sectionBoxPlanes || currentPlanes === this._normalPlanes
          ? NO_LOCAL_CLIPPING_PLANES
          : currentPlanes;
      this._sectionBoxPreviousMaterialPlanes.set(material, previousPlanes);
    }

    if (material.clippingPlanes === targetPlanes) return false;
    material.clippingPlanes = targetPlanes;
    material.needsUpdate = true;
    return true;
  }

  /**
   * Set normal (non-SectionBox) clipping planes.
   * While SectionBox is active the planes are retained as the restore target,
   * but renderer-global clipping stays disabled until SectionBox is deactivated.
   * @param {THREE.Plane[]} planes
   */
  setNormalPlanes(planes) {
    this._normalPlanes = normalizePlanes(planes);
    this._syncRendererState();
  }

  clearNormalPlanes() {
    this._normalPlanes = [];
    this._syncRendererState();
  }

  /**
   * Activate/update SectionBox planes from an arbitrary plane array.
   * Primarily useful for tests and non-box callers.
   * @param {THREE.Plane[]} planes
   * @returns {THREE.Plane[]} stable plane array
   */
  setSectionBoxPlanes(planes) {
    const next = normalizePlanes(planes);
    const wasActive = this._sectionBoxActive;
    this._sectionBoxActive = true;
    this._sectionBoxBounds = null;

    if (!wasActive || this._sectionBoxPlanes.length !== next.length) {
      this._sectionBoxPlanes = next.map((plane) => plane.clone());
    } else {
      for (let i = 0; i < next.length; i++) {
        this._sectionBoxPlanes[i].normal.copy(next[i].normal);
        this._sectionBoxPlanes[i].constant = next[i].constant;
      }
    }

    this._syncRendererState();
    return this._sectionBoxPlanes;
  }

  /**
   * Activate/update a SectionBox directly from Box3.
   * Once active, the same six Plane objects and the same array are mutated in
   * place, so pointer movement creates no replacement Plane objects.
   * @param {THREE.Box3} box
   * @returns {THREE.Plane[]} stable six-plane array
   */
  setSectionBoxBounds(box) {
    this._sectionBoxActive = true;
    this._sectionBoxBounds = box instanceof THREE.Box3 ? box.clone() : null;
    this._sectionBoxPlanes = updateBoxClippingPlanes(this._sectionBoxPlanes, box);
    this._syncRendererState();
    return this._sectionBoxPlanes;
  }

  /**
   * Restore the renderer/material state that existed outside SectionBox.
   */
  deactivateSectionBox() {
    if (!this._sectionBoxActive) {
      this._sectionBoxBounds = null;
      this._syncRendererState();
      return;
    }

    for (const [material, previousPlanes] of this._sectionBoxPreviousMaterialPlanes.entries()) {
      if (!material) continue;
      if (material.clippingPlanes !== previousPlanes) {
        material.clippingPlanes = previousPlanes;
        material.needsUpdate = true;
      }
    }

    this._sectionBoxPreviousMaterialPlanes.clear();
    this._sectionBoxActive = false;
    this._sectionBoxPlanes = [];
    this._sectionBoxBounds = null;
    this._syncRendererState();
  }

  /**
   * Apply the current material-local policy to an Object3D tree.
   * Normal clipping is not duplicated onto materials; it stays renderer-global.
   * Node/Axis/Story/GridHelperなどworld-space renderableは同じSectionBox policyに従う。
   * SectionBox UI / StencilCapは自身のclipping契約を保持するため書き換えず、
   * labelsはLabelVisibilityCullerでsemantic anchor判定する。
   * @param {THREE.Object3D} root
   * @param {string|null} [rootType]
   * @returns {number} updated material count
   */
  applyToObject(root, rootType = null) {
    if (!(root instanceof THREE.Object3D)) return 0;
    let updated = 0;

    root.traverse((object) => {
      if (!object.material) return;
      const policy = resolveObjectClippingPolicy(object, rootType);
      if (policy.skip === true) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (this.applyToMaterial(material, policy)) updated++;
      }
    });

    return updated;
  }

  /**
   * Apply current local clipping policy to element root(s) or a whole Scene.
   * Accepts one Object3D, an array, or the elementGroups object.
   * @param {THREE.Object3D|THREE.Object3D[]|Object<string, THREE.Object3D>} roots
   * @returns {number}
   */
  applyToRoots(roots) {
    let updated = 0;
    for (const { type, root } of normalizeRoots(roots)) {
      updated += this.applyToObject(root, type);
    }
    return updated;
  }

  _syncRendererState() {
    if (!this._renderer) return;

    if (this._sectionBoxActive) {
      // Global clipping would also clip stencil meshes. SectionBox therefore
      // keeps renderer planes empty and applies its six planes locally.
      this._renderer.clippingPlanes = [];
      this._renderer.localClippingEnabled = true;
      return;
    }

    // Normal clipping is renderer-global only. localClippingEnabled does not
    // need to be enabled merely because global planes exist.
    this._renderer.clippingPlanes = this._normalPlanes;
    this._renderer.localClippingEnabled = false;
  }
}

export const clippingStateManager = new ClippingStateManager();
