/**
 * @fileoverview SectionBox lifecycle adapter.
 *
 * Keeps geometry generation independent from clipping. The existing SectionBox
 * interaction implementation is reused while clipping/material/stencil state is
 * delegated to the centralized clipping state and explicit render roots.
 */

import { SectionBox } from './SectionBox.js';
import { StencilCapManager } from './StencilCapManager.js';
import { clippingStateManager } from './ClippingStateManager.js';

function normalizeRootsProvider(provider, fallback = null) {
  if (typeof provider === 'function') return provider;
  if (typeof fallback === 'function') return fallback;
  return () => [];
}

export class LifecycleSectionBox extends SectionBox {
  /**
   * @param {import('three').Scene} scene
   * @param {import('three').Camera|(() => import('three').Camera)} cameraOrGetter
   * @param {import('three').WebGLRenderer} renderer
   * @param {HTMLElement} domElement
   * @param {Object} controls
   * @param {() => import('three').Object3D|Object<string, import('three').Object3D>|import('three').Object3D[]} clippingRootsProvider
   *   SectionBox 6面を適用する全world-space renderableのprovider。Scene全体を渡してよい。
   * @param {() => Object<string, import('three').Object3D>|import('three').Object3D[]} [stencilRootsProvider]
   *   StencilCap生成対象の構造renderable provider。省略時はclippingRootsProviderを使用する。
   */
  constructor(
    scene,
    cameraOrGetter,
    renderer,
    domElement,
    controls,
    clippingRootsProvider,
    stencilRootsProvider = null,
  ) {
    super(scene, cameraOrGetter, renderer, domElement, controls);

    // Clipping対象とStencilCap対象は同義ではない。
    // GridHelperや計測線などworld-space補助要素はSectionBoxで隠す必要がある一方、
    // 断面キャップ生成の入力には含めてはいけないためproviderを分離する。
    this._clippingRootsProvider = normalizeRootsProvider(clippingRootsProvider);
    this._stencilRootsProvider = normalizeRootsProvider(
      stencilRootsProvider,
      this._clippingRootsProvider,
    );

    // Replace the legacy global-elementGroups stencil manager with an injected
    // structural render-root manager. The base instance has not been activated yet.
    this._stencilCapManager = new StencilCapManager(this._stencilRootsProvider);
    clippingStateManager.setRenderer(renderer);
  }

  /**
   * Clipping state is owned by ClippingStateManager; there is no renderer-state
   * snapshot in SectionBox itself.
   */
  _captureClippingState() {
    clippingStateManager.setRenderer(this._renderer);
  }

  _restoreClippingState() {
    // SectionBox中に直接生成された補助Materialも、解除する前に一度active policyへ
    // 通して復帰先を記録する。deactivate後に再正規化すると、SectionBox以前から
    // 存在した独自local clippingまで消し得るため、復元処理はManagerへ一任する。
    clippingStateManager.applyToRoots(this._clippingRootsProvider());
    clippingStateManager.deactivateSectionBox();
  }

  /**
   * Update the six planes while preserving the plane array and each Plane object
   * during drag. No scene traversal or material.needsUpdate is required for a
   * bounds-only change.
   */
  _updateClippingPlanes() {
    const wasActive = clippingStateManager.isSectionBoxActive();
    this._clipPlanes = clippingStateManager.setSectionBoxBounds(this._box);

    if (!wasActive) {
      clippingStateManager.applyToRoots(this._clippingRootsProvider());
    }
  }

  /**
   * Re-apply active clipping to newly created renderables and rebuild stencil
   * caps from the current structural mesh set. Call once after a geometry/material batch.
   * @param {{refreshStencil?: boolean}} [options]
   */
  syncRenderables(options = {}) {
    if (!this._active) return;
    clippingStateManager.applyToRoots(this._clippingRootsProvider());
    if (options.refreshStencil !== false) {
      this._refreshStencilCaps();
    }
  }
}
