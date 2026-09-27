/**
 * @fileoverview parsed STB model から派生数量 store を構築するサービス。
 * globalState / DOM mutation / Three.js に依存しない。
 */

import { DerivedQuantityStore } from './DerivedQuantityStore.js';
import { calculateQuantity } from './QuantityCalculatorRegistry.js';
import {
  buildLinearMemberContexts,
  LINEAR_MEMBER_CONFIG,
} from './resolvers/LinearMemberQuantityContext.js';
import {
  buildPanelQuantityContexts,
  PANEL_QUANTITY_CONFIG,
} from './resolvers/PanelQuantityContext.js';
import {
  buildFootingQuantityContexts,
  FOOTING_QUANTITY_CONFIG,
} from './resolvers/FootingQuantityContext.js';
import {
  buildPileQuantityContexts,
  PILE_QUANTITY_CONFIG,
} from './resolvers/PileQuantityContext.js';
import { createUnavailableQuantityResult } from './core/QuantityResult.js';
import { QuantityStatus } from './core/QuantityStatus.js';

function storeContextBuildFailures(store, parsedData, config, error, revision) {
  const elements = parsedData?.[config.elementsKey];
  if (!Array.isArray(elements)) return;

  for (const element of elements) {
    if (element?.id === null || element?.id === undefined || element?.id === '') continue;
    store.set(
      config.stbElementType,
      element.id,
      createUnavailableQuantityResult({
        identity: {
          elementType: config.stbElementType,
          elementId: element.id,
          guid: element.guid || null,
        },
        status: QuantityStatus.INVALID_GEOMETRY,
        warnings: [`数量計算contextの構築に失敗しました: ${error?.message || error}`],
        revision,
      }),
    );
  }
}

function calculateContextsIntoStore(store, contexts, revision) {
  for (const context of contexts) {
    let result;
    try {
      result = calculateQuantity(context);
    } catch (error) {
      result = createUnavailableQuantityResult({
        identity: {
          elementType: context.elementType,
          elementId: context.element?.id,
          guid: context.element?.guid || null,
        },
        status: QuantityStatus.INVALID_GEOMETRY,
        warnings: [`数量計算で例外が発生しました: ${error?.message || error}`],
        revision,
      });
    }
    if (result) store.set(context.elementType, context.element.id, result);
  }
}

function calculateConfigGroup({
  configs,
  contextBuilder,
  parsedData,
  store,
  modelSide,
  revision,
  document,
}) {
  for (const config of Object.values(configs)) {
    let contexts;
    try {
      contexts = contextBuilder(parsedData, config.stbElementType, {
        modelSide,
        revision,
        document,
      });
    } catch (error) {
      storeContextBuildFailures(store, parsedData, config, error, revision);
      continue;
    }
    calculateContextsIntoStore(store, contexts, revision);
  }
}

export function calculateLinearMemberQuantities(
  parsedData,
  { modelSide = null, revision = null, document = null, store = new DerivedQuantityStore() } = {},
) {
  if (!parsedData) throw new TypeError('parsedData is required');
  if (!(store instanceof DerivedQuantityStore)) {
    throw new TypeError('store must be a DerivedQuantityStore');
  }

  for (const [configs, contextBuilder] of [
    [LINEAR_MEMBER_CONFIG, buildLinearMemberContexts],
    [PANEL_QUANTITY_CONFIG, buildPanelQuantityContexts],
    [FOOTING_QUANTITY_CONFIG, buildFootingQuantityContexts],
    [PILE_QUANTITY_CONFIG, buildPileQuantityContexts],
  ]) {
    calculateConfigGroup({
      configs,
      contextBuilder,
      parsedData,
      store,
      modelSide,
      revision,
      document,
    });
  }

  return store;
}

// 既存のproduction呼出し名を維持しつつ、モデル全体の数量API名も公開する。
export const calculateModelQuantities = calculateLinearMemberQuantities;

export function summarizeQuantityStore(store) {
  const summary = {
    total: 0,
    byStatus: {},
    grossVolumeMm3: 0,
    concreteVolumeMm3: 0,
    structuralSteelVolumeMm3: 0,
  };
  if (!store || typeof store.values !== 'function') return summary;

  for (const result of store.values()) {
    summary.total++;
    summary.byStatus[result.status] = (summary.byStatus[result.status] || 0) + 1;
    for (const key of ['grossVolumeMm3', 'concreteVolumeMm3', 'structuralSteelVolumeMm3']) {
      const value = Number(result.values?.[key]);
      if (Number.isFinite(value)) summary[key] += value;
    }
  }
  return summary;
}
