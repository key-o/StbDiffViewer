/**
 * @fileoverview 節点要素の描画モジュール
 *
 * 比較結果（matched / onlyA / onlyB）を共有SphereGeometryのメッシュとして描画し、
 * ラベルスプライトを生成します。
 *
 * @module viewer/rendering/nodeElements
 */

import * as THREE from 'three';
import { getMaterialForElementWithMode } from './materials.js';
import {
  log,
  getSharedNodeSphereGeometry,
  disposeAndClearGroup,
  createLabelSpriteInternal,
  applyImportanceVisuals,
} from './elementsShared.js';

/**
 * 節点要素の比較結果を描画する
 * @param {object} comparisonResult - compareElementsの比較結果
 * @param {THREE.Group} group - 描画対象の要素グループ（節点メッシュ用）
 * @param {boolean} labelToggle - ラベル表示の有無
 * @param {THREE.Box3} modelBounds - 更新するモデル全体のバウンディングボックス
 * @returns {Array<THREE.Sprite>} 作成されたラベルスプライトの配列
 */
export function drawNodes(comparisonResult, group, labelToggle, modelBounds) {
  disposeAndClearGroup(group);
  const createdLabels = [];

  comparisonResult.matched.forEach((item) => {
    if (!item) {
      log.warn('Skipping undefined item in matched for Node');
      return;
    }
    const {
      dataA,
      dataB,
      importance,
      matchType,
      category,
      positionState,
      attributeState,
      diffStatus,
      attributeMismatchKind,
    } = item;
    const coords = dataA.coords;
    const idA = dataA.id;
    const idB = dataB.id;
    if (
      coords &&
      Number.isFinite(coords.x) &&
      Number.isFinite(coords.y) &&
      Number.isFinite(coords.z)
    ) {
      const pos = new THREE.Vector3(coords.x, coords.y, coords.z);
      const sphere = new THREE.Mesh(
        getSharedNodeSphereGeometry(),
        getMaterialForElementWithMode('Node', 'matched', false, false, idA, matchType, {
          diffStatus,
          positionState,
          attributeState,
        }),
      );
      sphere.position.copy(pos);
      sphere.userData = {
        elementType: 'Node',
        elementId: idA, // 統一されたID参照用
        elementIdA: idA,
        elementIdB: idB,
        modelSource: 'matched',
        toleranceState: matchType,
        category: category || matchType || 'exact',
        positionState: positionState || 'exact',
        attributeState: attributeState || 'matched',
        diffStatus: diffStatus || undefined,
        attributeMismatchKind: attributeMismatchKind || undefined,
      };

      // 重要度による視覚調整を適用
      applyImportanceVisuals(sphere, importance);

      group.add(sphere);
      modelBounds.expandByPoint(pos);
      if (labelToggle) {
        const labelText = `${idA} / ${idB}`;
        const sprite = createLabelSpriteInternal(labelText, pos, group, 'Node');
        if (sprite) {
          sprite.userData.elementIdA = idA;
          sprite.userData.elementIdB = idB;
          sprite.userData.modelSource = 'matched';
          createdLabels.push(sprite);
        }
      }
    } else {
      log.warn(`Skipping matched node due to invalid coords: A=${idA}, B=${idB}`);
    }
  });

  comparisonResult.onlyA.forEach((item) => {
    if (!item) {
      log.warn('Skipping undefined item in onlyA for Node');
      return;
    }
    const { coords, id, importance } = item;
    if (
      coords &&
      Number.isFinite(coords.x) &&
      Number.isFinite(coords.y) &&
      Number.isFinite(coords.z)
    ) {
      const pos = new THREE.Vector3(coords.x, coords.y, coords.z);
      const sphere = new THREE.Mesh(
        getSharedNodeSphereGeometry(),
        getMaterialForElementWithMode('Node', 'onlyA', false, false, id),
      );
      sphere.position.copy(pos);
      sphere.userData = {
        elementType: 'Node',
        elementId: id,
        modelSource: 'A',
      };

      // 重要度による視覚調整を適用
      applyImportanceVisuals(sphere, importance);

      group.add(sphere);
      modelBounds.expandByPoint(pos);
      if (labelToggle) {
        const labelText = `A: ${id}`;
        const sprite = createLabelSpriteInternal(labelText, pos, group, 'Node');
        if (sprite) {
          sprite.userData.elementId = id;
          sprite.userData.modelSource = 'A';
          createdLabels.push(sprite);
        }
      }
    } else {
      log.warn(`Skipping onlyA node due to invalid coords: ID=${id}`);
    }
  });

  comparisonResult.onlyB.forEach((item) => {
    if (!item) {
      log.warn('Skipping undefined item in onlyB for Node');
      return;
    }
    const { coords, id, importance } = item;
    if (
      coords &&
      Number.isFinite(coords.x) &&
      Number.isFinite(coords.y) &&
      Number.isFinite(coords.z)
    ) {
      const pos = new THREE.Vector3(coords.x, coords.y, coords.z);
      const sphere = new THREE.Mesh(
        getSharedNodeSphereGeometry(),
        getMaterialForElementWithMode('Node', 'onlyB', false, false, id),
      );
      sphere.position.copy(pos);
      sphere.userData = {
        elementType: 'Node',
        elementId: id,
        modelSource: 'B',
      };

      // 重要度による視覚調整を適用
      applyImportanceVisuals(sphere, importance);

      group.add(sphere);
      modelBounds.expandByPoint(pos);
      if (labelToggle) {
        const labelText = `B: ${id}`;
        const sprite = createLabelSpriteInternal(labelText, pos, group, 'Node');
        if (sprite) {
          sprite.userData.elementId = id;
          sprite.userData.modelSource = 'B';
          createdLabels.push(sprite);
        }
      }
    } else {
      log.warn(`Skipping onlyB node due to invalid coords: ID=${id}`);
    }
  });
  return createdLabels;
}
