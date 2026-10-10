/**
 * @fileoverview Working Document変更後の派生数量をrevision単位で更新する。
 * Source Document Aの数量storeは保持し、Working専用storeを独立して構築する。
 */

import { EditEvents, eventBus } from '../../data/events/index.js';
import { getState, setState } from '../../data/state/globalState.js';
import { buildQuantityFacts } from '../../quantities/analytics/QuantityFactBuilder.js';
import { calculateModelQuantities } from '../../quantities/QuantityService.js';
import { parseStbFile } from '../../viewer/index.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('workingQuantityLifecycleController');
const DEBOUNCE_DELAY_MS = 100;

const DEFAULT_DEPENDENCIES = {
  eventBus,
  getState,
  setState,
  parseStbFile,
  calculateModelQuantities,
  buildQuantityFacts,
  setTimeout: (...args) => globalThis.setTimeout(...args),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
};

function clearWorkingQuantities(deps) {
  deps.setState('models.derivedQuantitiesWorkingA', null);
  deps.setState('models.quantityFactsWorkingA', null);
  deps.setState('models.workingQuantitySessionId', null);
  deps.setState('models.workingQuantityRevision', null);
  deps.setState('models.workingQuantityError', null);
}

/**
 * @param {Object} [dependencies]
 * @returns {{start:Function,stop:Function,handlePayload:Function,recalculate:Function}}
 */
export function createWorkingQuantityLifecycleController(dependencies = {}) {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  let removeListener = null;
  let timer = null;
  let generation = 0;

  function notify(payload = {}) {
    deps.eventBus.emit(EditEvents.WORKING_QUANTITIES_UPDATED, payload);
  }

  function invalidatePendingWork() {
    generation += 1;
    if (timer !== null) {
      deps.clearTimeout(timer);
      timer = null;
    }
  }

  function recalculate(payload, expectedGeneration = generation) {
    if (expectedGeneration !== generation) return false;
    const editing = deps.getState('models.editing') || {};
    const sessionId = payload.sessionId || editing.sessionId || null;
    const revision = Number(payload.workingRevision);
    const targetDocument =
      payload.targetDocument || payload.workingDocument || editing.workingDocument;

    if (
      !editing.active ||
      !sessionId ||
      editing.sessionId !== sessionId ||
      !Number.isInteger(revision) ||
      Number(editing.workingRevision) !== revision ||
      editing.workingDocument !== targetDocument ||
      !targetDocument?.documentElement
    ) {
      return false;
    }

    try {
      // Parse without the A/B global cache: this document is a separate Working snapshot.
      const parsedData = deps.parseStbFile(targetDocument, {
        forceReparse: true,
        exposeDebugState: false,
      });
      const store = deps.calculateModelQuantities(parsedData, {
        modelSide: 'A',
        revision,
        document: targetDocument,
      });
      const facts = deps.buildQuantityFacts(parsedData, store, {
        modelSide: 'A',
        document: targetDocument,
      });

      const latestEditing = deps.getState('models.editing') || {};
      if (
        expectedGeneration !== generation ||
        !latestEditing.active ||
        latestEditing.sessionId !== sessionId ||
        Number(latestEditing.workingRevision) !== revision ||
        latestEditing.workingDocument !== targetDocument
      ) {
        return false;
      }

      deps.setState('models.derivedQuantitiesWorkingA', store);
      deps.setState('models.quantityFactsWorkingA', facts);
      deps.setState('models.workingQuantitySessionId', sessionId);
      deps.setState('models.workingQuantityRevision', revision);
      deps.setState('models.workingQuantityError', null);
      notify({ sessionId, workingRevision: revision, status: 'ready' });
      return true;
    } catch (error) {
      const latestEditing = deps.getState('models.editing') || {};
      if (
        expectedGeneration !== generation ||
        !latestEditing.active ||
        latestEditing.sessionId !== sessionId ||
        Number(latestEditing.workingRevision) !== revision ||
        latestEditing.workingDocument !== targetDocument
      ) {
        return false;
      }

      log.warn(`Working Document数量の再計算に失敗しました (revision=${revision})`, error);
      deps.setState('models.derivedQuantitiesWorkingA', null);
      deps.setState('models.quantityFactsWorkingA', null);
      deps.setState('models.workingQuantitySessionId', sessionId);
      deps.setState('models.workingQuantityRevision', revision);
      deps.setState('models.workingQuantityError', error?.message || String(error));
      notify({ sessionId, workingRevision: revision, status: 'failed' });
      return false;
    }
  }

  function handlePayload(payload = {}) {
    const editing = deps.getState('models.editing') || {};
    if (payload.reset === true || !editing.active) {
      invalidatePendingWork();
      clearWorkingQuantities(deps);
      notify({ sessionId: payload.sessionId || null, status: 'reset' });
      return true;
    }

    const revision = Number(payload.workingRevision ?? editing.workingRevision);
    const sessionId = payload.sessionId || editing.sessionId || null;
    const targetDocument =
      payload.targetDocument || payload.workingDocument || editing.workingDocument;
    if (!sessionId || !Number.isInteger(revision) || !targetDocument?.documentElement) {
      invalidatePendingWork();
      clearWorkingQuantities(deps);
      notify({ sessionId, workingRevision: revision, status: 'unavailable' });
      return false;
    }

    // 遅れて届いた旧revisionのイベントは、現在有効な数量storeをpendingで消さない。
    if (
      !editing.active ||
      editing.sessionId !== sessionId ||
      Number(editing.workingRevision) !== revision ||
      editing.workingDocument !== targetDocument
    ) {
      return false;
    }

    invalidatePendingWork();
    const currentGeneration = generation;
    deps.setState('models.workingQuantitySessionId', sessionId);
    deps.setState('models.workingQuantityRevision', null);
    deps.setState('models.workingQuantityError', null);
    notify({ sessionId, workingRevision: revision, status: 'pending' });
    timer = deps.setTimeout(() => {
      timer = null;
      recalculate({ sessionId, workingRevision: revision, targetDocument }, currentGeneration);
    }, DEBOUNCE_DELAY_MS);
    return true;
  }

  function start() {
    if (removeListener || typeof deps.eventBus?.on !== 'function') return false;
    generation += 1;
    removeListener = deps.eventBus.on(EditEvents.WORKING_DOCUMENT_CHANGED, handlePayload);
    return true;
  }

  function stop() {
    generation += 1;
    if (timer !== null) {
      deps.clearTimeout(timer);
      timer = null;
    }
    removeListener?.();
    removeListener = null;
  }

  return { start, stop, handlePayload, recalculate };
}

const controller = createWorkingQuantityLifecycleController();

export function initWorkingQuantityLifecycle() {
  return controller.start();
}

export function resetWorkingQuantityLifecycle() {
  controller.stop();
}
