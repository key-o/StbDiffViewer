/**
 * @fileoverview DXF図面用の部材符号収集
 */

import * as THREE from 'three';
import { getElementGroupsInternal, getSectionMapsInternal } from './DxfProviders.js';
import { isPointWithinClippingBounds } from './DxfGeometryCollector.js';
import { resolveDxfElementMark } from './DxfMarkResolver.js';
import { resolveStoryPlanCutZ } from './DxfPlanCut.js';

/**
 * ViewerのラベルSpriteに依存せず、表示中の要素メッシュからDXF符号を収集する。
 * 同一 elementType / elementId は1回だけ出力する。
 *
 * 階平面図ではMesh中心が階クリップ帯内にあるかではなく、そのMeshが
 * 要素別の平面図切断高さを実際に横切るかで採否を決める。
 *
 * @param {Array<string>} elementTypes - 対象要素タイプ
 * @param {Object|null} clippingState - 現在のクリッピング状態
 * @param {Object} [options]
 * @param {number} [options.planCutOffset=1500]
 * @returns {Array<{position:THREE.Vector3,text:string,elementType:string,elementId:string}>}
 */
export function collectDxfElementMarks(elementTypes, clippingState = null, options = {}) {
  const elementGroups = getElementGroupsInternal();
  const sectionMaps = getSectionMapsInternal();
  const planCutOffset = options.planCutOffset ?? 1500;
  const marks = [];
  const seen = new Set();

  for (const elementType of elementTypes) {
    if (elementType === 'Open' || elementType === 'Node') continue;

    const group = elementGroups[elementType];
    if (!group) continue;

    group.traverse((child) => {
      if (!child.visible || !child.isMesh) return;

      const userData = child.userData || {};
      const rawElementId = userData.elementId ?? userData.stbElementId ?? userData.id;
      if (rawElementId == null) return;

      const elementId = String(rawElementId);
      const key = `${elementType}:${elementId}`;
      if (seen.has(key)) return;

      child.updateWorldMatrix(true, false);
      const box = new THREE.Box3().setFromObject(child);
      if (box.isEmpty()) return;

      let position = box.getCenter(new THREE.Vector3());
      if (clippingState?.type === 'story') {
        const cutZ = resolveStoryPlanCutZ(
          elementType,
          box,
          clippingState,
          planCutOffset,
        );
        if (cutZ == null) return;
        position.z = cutZ;
      } else if (clippingState?.type && !isPointWithinClippingBounds(position, clippingState)) {
        return;
      }

      const text = resolveDxfElementMark(elementType, userData, sectionMaps);
      if (!text) return;

      seen.add(key);
      marks.push({ position, text, elementType, elementId });
    });
  }

  return marks;
}
