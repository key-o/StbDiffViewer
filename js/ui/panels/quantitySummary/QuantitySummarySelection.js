/**
 * @fileoverview Quantity drilldown から既存 3D selection / ElementInfo へ接続する薄い bridge。
 */

import { sceneController } from '../../../app/controllers/sceneController.js';
import { selectElement3D } from '../../../app/controllers/interactionController.js';
import { eventBus, InteractionEvents } from '../../../data/events/index.js';
import { scheduleRender } from '../../../utils/renderScheduler.js';
import { findElementInGroup } from '../../../viewer/index.js';

export function getQuantityFactViewerElementType(fact) {
  const memberCategory = String(fact?.memberCategory || '').trim();
  if (memberCategory) return memberCategory;

  const elementType = String(fact?.elementType || '').trim();
  return elementType.replace(/^Stb/, '') || null;
}

/**
 * @param {Object} fact QuantityFact
 * @param {Object} deps unit test 用の依存差し替え
 * @returns {{found:boolean, elementType:string|null, elementId:string|null, modelSource:string|null, treeElementId?:string|null, treeModelSource?:string|null}}
 */
export function focusQuantityFact(fact, deps = {}) {
  const elementType = getQuantityFactViewerElementType(fact);
  const elementId =
    fact?.elementId === null || fact?.elementId === undefined ? null : String(fact.elementId);
  const modelSource = fact?.modelSide === 'B' ? 'B' : fact?.modelSide === 'A' ? 'A' : null;

  if (!elementType || !elementId || !modelSource) {
    return { found: false, elementType, elementId, modelSource };
  }

  const getElementGroups = deps.getElementGroups || (() => sceneController.getElementGroups());
  const findElement = deps.findElement || findElementInGroup;
  const selectElement = deps.selectElement || selectElement3D;
  const render = deps.scheduleRender || scheduleRender;
  const emit = deps.emit || ((eventName, payload) => eventBus.emit(eventName, payload));

  const group = getElementGroups()?.[elementType];
  let hit = group ? findElement(group, elementType, elementId, modelSource) : null;
  // 比較表示では A/B 両方の要素が modelSource='matched' の1描画へ統合される。
  // QuantityFact は A/B 個別IDを保持するため、side-specific検索で見つからない場合は
  // matched object を同じIDで再検索して3Dフォーカスを成立させる。
  if (!hit && group) {
    hit = findElement(group, elementType, elementId, 'matched');
  }
  if (hit?.object) {
    selectElement(hit.object, render, { batchHit: hit });
  }

  const idA = modelSource === 'A' ? elementId : null;
  const idB = modelSource === 'B' ? elementId : null;
  emit(InteractionEvents.DISPLAY_ELEMENT_INFO, {
    idA,
    idB,
    elementType,
    modelSource,
  });
  const hitModelSource = hit?.userData?.modelSource;
  const treeModelSource =
    hitModelSource === 'matched'
      ? 'matched'
      : hitModelSource === 'B' ||
          hitModelSource === 'onlyB' ||
          (!hitModelSource && modelSource === 'B')
        ? 'onlyB'
        : 'onlyA';
  const treeElementId =
    treeModelSource === 'matched'
      ? String(hit?.userData?.elementIdA ?? hit?.userData?.elementId ?? elementId)
      : elementId;
  emit(InteractionEvents.SELECT_ELEMENT_IN_TREE, {
    elementType,
    elementId: treeElementId,
    modelSource: treeModelSource,
  });

  return {
    found: Boolean(hit?.object),
    elementType,
    elementId,
    modelSource,
    treeElementId,
    treeModelSource,
  };
}

export default focusQuantityFact;
