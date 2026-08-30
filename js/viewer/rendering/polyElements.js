/**
 * @fileoverview ポリゴン要素（スラブ・壁など）の描画モジュール
 *
 * 比較結果（matched / onlyA / onlyB）を THREE.Mesh として描画し、
 * ラベルスプライトを生成します。
 *
 * @module viewer/rendering/polyElements
 */

import * as THREE from 'three';
import { getMaterialForElementWithMode } from './materials.js';
import { getViewerState } from '../stateProvider.js';
import {
  log,
  getSectionIdFromElement,
  resolveImportanceWithSectionValidation,
  disposeAndClearGroup,
  createLabelSpriteInternal,
  applyImportanceVisuals,
} from './elementsShared.js';

/**
 * ポリゴン要素1件をメッシュとして処理する共通ヘルパー
 * @param {Object} item - ポリゴンデータアイテム
 * @param {string} elementType - 要素タイプ名
 * @param {THREE.Material} material - デフォルトマテリアル
 * @param {string} modelSource - モデルソース ('matched' | 'A' | 'B')
 * @param {THREE.Group} group - 描画対象グループ
 * @param {THREE.Box3} modelBounds - バウンディングボックス
 * @param {boolean} labelToggle - ラベル表示の有無
 * @param {Array<THREE.Sprite>} createdLabels - ラベル収集配列
 */
function processPolyItem(
  item,
  elementType,
  material,
  modelSource,
  group,
  modelBounds,
  labelToggle,
  createdLabels,
) {
  const {
    vertexCoordsList,
    id,
    importance,
    idB,
    matchType,
    category,
    positionState,
    attributeState,
    diffStatus,
    attributeMismatchKind,
  } = item;
  const points = [];
  let validPoints = true;
  for (const p of vertexCoordsList) {
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
      points.push(new THREE.Vector3(p.x, p.y, p.z));
    } else {
      log.warn('Skipping polygon due to invalid vertex coord:', p);
      validPoints = false;
      break;
    }
  }
  if (!validPoints || points.length < 3) return;
  points.forEach((p) => modelBounds.expandByPoint(p));
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const indices = [];
  for (let i = 1; i < points.length - 1; i++) {
    indices.push(0, i, i + 1);
  }
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  // 重要度データを取得
  let actualImportance = importance; // パラメータから取得
  const importanceManager = getViewerState('importanceManager');
  const sourceElement = item.rawElement || item.element || null;
  if (importanceManager) {
    const stbElementType = `Stb${elementType}`;
    const calculatedImportance = sourceElement
      ? importanceManager.getElementImportance?.(sourceElement, stbElementType)
      : null;
    if (calculatedImportance) {
      actualImportance = calculatedImportance;
    }
  }
  // 参照断面にバリデーションエラーがある場合は違反として扱う
  actualImportance = resolveImportanceWithSectionValidation(actualImportance, sourceElement);

  let meshMaterial = material;
  if (modelSource === 'matched' && matchType) {
    meshMaterial = getMaterialForElementWithMode(
      elementType,
      'matched',
      false,
      true,
      id,
      matchType,
      { diffStatus, positionState, attributeState },
    );
  }

  const mesh = new THREE.Mesh(geometry, meshMaterial);
  mesh.userData = {
    elementType: elementType,
    elementId: id,
    modelSource: modelSource,
    originalId: id, // applyImportanceColorMode で使用
    id: id,
    importance: actualImportance, // 重要度データを設定
    toleranceState: matchType,
    category: category || matchType || undefined,
    positionState: positionState || undefined,
    attributeState: attributeState || undefined,
    diffStatus: diffStatus || undefined,
    attributeMismatchKind: attributeMismatchKind || undefined,
    isPoly: true,
    sectionId: getSectionIdFromElement(sourceElement) || undefined,
  };

  // matched要素の場合、A/B両方のIDを設定
  if (modelSource === 'matched' && idB) {
    mesh.userData.elementIdA = id;
    mesh.userData.elementIdB = idB;
  }

  // 重要度による視覚調整を適用
  applyImportanceVisuals(mesh, actualImportance);

  group.add(mesh);

  // ラベル作成ロジック
  if (labelToggle && id) {
    // ポリゴンの中心点を計算
    const centerPoint = new THREE.Vector3();
    points.forEach((p) => centerPoint.add(p));
    centerPoint.divideScalar(points.length);

    let labelText = '';
    if (modelSource === 'A') {
      labelText = `A: ${id}`;
    } else if (modelSource === 'B') {
      labelText = `B: ${id}`;
    } else if (modelSource === 'matched') {
      // matched の場合、A/B両方のIDを表示
      labelText = idB ? `${id} / ${idB}` : `${id}`;
    }

    if (labelText) {
      const sprite = createLabelSpriteInternal(
        labelText,
        centerPoint,
        group, // ラベルも同じグループに追加
        elementType,
      );
      if (sprite) {
        sprite.userData.elementId = id; // スプライトにIDを設定
        sprite.userData.modelSource = modelSource; // スプライトにもソースを設定
        // matched の場合、A/B両方のIDを設定
        if (modelSource === 'matched' && idB) {
          sprite.userData.elementIdA = id;
          sprite.userData.elementIdB = idB;
        }
        createdLabels.push(sprite);
      }
    }
  }
}

/**
 * ポリゴンデータリストを一括処理する
 * @param {Array} dataList - ポリゴンデータ配列
 * @param {string} elementType - 要素タイプ名
 * @param {THREE.Material} material - デフォルトマテリアル
 * @param {string} modelSource - モデルソース ('matched' | 'A' | 'B')
 * @param {THREE.Group} group - 描画対象グループ
 * @param {THREE.Box3} modelBounds - バウンディングボックス
 * @param {boolean} labelToggle - ラベル表示の有無
 * @param {Array<THREE.Sprite>} createdLabels - ラベル収集配列
 */
function processPolyItems(
  dataList,
  elementType,
  material,
  modelSource,
  group,
  modelBounds,
  labelToggle,
  createdLabels,
) {
  dataList.forEach((item) => {
    processPolyItem(
      item,
      elementType,
      material,
      modelSource,
      group,
      modelBounds,
      labelToggle,
      createdLabels,
    );
  });
}

/**
 * ポリゴン要素（スラブ、壁など）の比較結果を描画する
 * @param {object} comparisonResult - compareElementsの比較結果
 * @param {THREE.Group} group - 描画対象の要素グループ
 * @param {boolean} labelToggle - ラベル表示の有無
 * @param {THREE.Box3} modelBounds - 更新するモデル全体のバウンディングボックス
 * @returns {Array<THREE.Sprite>} 作成されたラベルスプライトの配列
 */
export function drawPolyElements(comparisonResult, group, labelToggle, modelBounds) {
  disposeAndClearGroup(group);
  const createdLabels = [];

  const elementType = group.userData.elementType;
  if (!elementType) {
    log.error('elementType is missing in group userData or name for drawPolyElements:', group);
  }

  processPolyItems(
    comparisonResult.matched.map((item) => ({
      vertexCoordsList: item.dataA.vertexCoordsList,
      id: item.dataA.id,
      idB: item.dataB.id, // B側のIDを追加
      importance: item.importance,
      matchType: item.matchType,
      category: item.category,
      positionState: item.positionState,
      attributeState: item.attributeState,
      diffStatus: item.diffStatus,
      attributeMismatchKind: item.attributeMismatchKind,
    })),
    elementType,
    getMaterialForElementWithMode(
      elementType,
      'matched',
      false,
      true,
      comparisonResult.matched[0]?.dataA?.id,
    ),
    'matched',
    group,
    modelBounds,
    labelToggle,
    createdLabels,
  );
  processPolyItems(
    comparisonResult.onlyA,
    elementType,
    getMaterialForElementWithMode(elementType, 'onlyA', false, true, comparisonResult.onlyA[0]?.id),
    'A',
    group,
    modelBounds,
    labelToggle,
    createdLabels,
  );
  processPolyItems(
    comparisonResult.onlyB,
    elementType,
    getMaterialForElementWithMode(elementType, 'onlyB', false, true, comparisonResult.onlyB[0]?.id),
    'B',
    group,
    modelBounds,
    labelToggle,
    createdLabels,
  );

  return createdLabels;
}
