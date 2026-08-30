/**
 * @fileoverview 色付けモード再適用時のマテリアル更新
 *
 * モデルロード後の再着色で、シーン上のオブジェクト1件ずつに
 * 現在の色付けモードに応じたマテリアルを割り当てる。
 *
 * @module app/controllers/modelLoaderMaterialUpdate
 */

import {
  buildMaterialOptionsFromUserData,
  normalizeModelSourceToComparisonState,
} from '../../colorModes/modelSourceMapping.js';

/**
 * オブジェクトのマテリアルを色付けモードに応じて非同期で更新
 * @param {THREE.Object3D} object - 更新対象のオブジェクト
 * @returns {Promise} 更新完了のPromise
 */
export function updateObjectMaterialAsync(object) {
  return import('../../viewer/index.js').then(({ getMaterialForElementWithMode }) => {
    if (getMaterialForElementWithMode && object.userData) {
      const elementType = object.userData.elementType;

      // AxisとStoryは色付けモードの対象外（独自のマテリアルを使用）
      if (elementType === 'Axis' || elementType === 'Story') {
        return;
      }

      const comparisonState = normalizeModelSourceToComparisonState(object.userData.modelSource);
      const isLine = object.userData.isLine || false;
      const isPoly = object.userData.isPoly || false;
      const elementId = object.userData.elementId || null;
      const materialOptions = buildMaterialOptionsFromUserData(object.userData);

      const newMaterial = getMaterialForElementWithMode(
        elementType,
        comparisonState,
        isLine,
        isPoly,
        elementId,
        object.userData.toleranceState || null,
        materialOptions,
      );

      if (newMaterial && object.material !== newMaterial) {
        object.material = newMaterial;
      }
    }
  });
}
