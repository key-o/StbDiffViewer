/** @fileoverview PDF重ね合わせから既存ツリー選択へ渡す要素識別子を解決する。 */

import { sceneController } from '../../../app/controllers/sceneController.js';
import { findElementInGroup } from '../../../viewer/index.js';

/**
 * 描画要素の元モデルIDを、現在の比較シーンで使うツリー識別子へ解決する。
 * @param {{elementType:string, elementId:string, modelKey:'A'|'B'}} ref
 * @param {Object} deps unit test用の依存差し替え
 * @returns {{elementType:string, elementId:string, modelSource:string}}
 */
export function resolvePdfOverlayTreeSelection(ref, deps = {}) {
  const modelSource = ref.modelKey === 'B' ? 'onlyB' : 'onlyA';
  const getElementGroups = deps.getElementGroups || (() => sceneController.getElementGroups());
  const findElement = deps.findElement || findElementInGroup;
  const group = getElementGroups()?.[ref.elementType];
  let hit = group ? findElement(group, ref.elementType, ref.elementId, modelSource) : null;
  if (!hit && group) hit = findElement(group, ref.elementType, ref.elementId, 'matched');

  const hitModelSource = hit?.userData?.modelSource;
  const treeModelSource =
    hitModelSource === 'matched'
      ? 'matched'
      : hitModelSource === 'B' ||
          hitModelSource === 'onlyB' ||
          (!hitModelSource && ref.modelKey === 'B')
        ? 'onlyB'
        : 'onlyA';
  const treeElementId =
    treeModelSource === 'matched'
      ? String(hit.userData.elementIdA ?? hit.userData.elementId ?? ref.elementId)
      : String(ref.elementId);

  return {
    elementType: ref.elementType,
    elementId: treeElementId,
    modelSource: treeModelSource,
  };
}
