/**
 * @fileoverview semantic selection と renderable lifecycle の同期。
 *
 * element-ID 局所再生成では GEOMETRY_CHANGED の直後に RENDERABLES_REPLACED が同期発火し、
 * selectionService が新 Object3D へ選択を rebind する。一方 structural delete では replacement
 * が存在しないため、削除済み Object3D を選択正本として残してはならない。
 *
 * GEOMETRY_CHANGED 直後では replacement 判定がまだ完了していないため microtask まで判定を遅延し、
 * その時点でも scene から detach された選択が残る場合だけ selection 全体を fail-closed で解除する。
 */

import { RenderableLifecycleEvents } from '../../constants/renderableLifecycleEvents.js';
import { eventBus } from '../../data/events/eventBus.js';
import { getSelectedObjects, resetSelection } from './interactionController.js';

const DEFAULT_DEPENDENCIES = {
  eventBus,
  getSelectedObjects,
  resetSelection,
  queueTask: (callback) => globalThis.queueMicrotask(callback),
};

/**
 * @param {Object} [dependencies]
 * @returns {{start: Function, stop: Function, checkDanglingSelection: Function}}
 */
export function createSelectionRenderableLifecycleController(dependencies = {}) {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  let removeListener = null;
  let generation = 0;

  function checkDanglingSelection(expectedGeneration = generation) {
    if (expectedGeneration !== generation) return false;
    const selectedObjects = deps.getSelectedObjects?.() || [];
    if (selectedObjects.length === 0) return false;

    const hasDetachedSelection = selectedObjects.some((object) => !object?.parent);
    if (!hasDetachedSelection) return false;

    // 部分選択だけを object identity で直接削ると semantic identity / material snapshot /
    // Property panel の各状態が分岐する。Phase 5 では全選択解除を atomic な安全側契約とする。
    deps.resetSelection?.();
    return true;
  }

  function scheduleDanglingSelectionCheck() {
    const expectedGeneration = generation;
    deps.queueTask?.(() => checkDanglingSelection(expectedGeneration));
  }

  function start() {
    if (removeListener || typeof deps.eventBus?.on !== 'function') return false;
    generation += 1;
    removeListener = deps.eventBus.on(
      RenderableLifecycleEvents.GEOMETRY_CHANGED,
      scheduleDanglingSelectionCheck,
    );
    return true;
  }

  function stop() {
    generation += 1;
    removeListener?.();
    removeListener = null;
  }

  return { start, stop, checkDanglingSelection };
}

const controller = createSelectionRenderableLifecycleController();

export function initSelectionRenderableLifecycle() {
  return controller.start();
}

export function resetSelectionRenderableLifecycleForTest() {
  controller.stop();
}
