/**
 * @fileoverview 線要素（柱・梁など）の描画モジュール
 *
 * 比較結果（matched / onlyA / onlyB）を THREE.Line として描画し、
 * ラベルスプライトを生成します。
 *
 * @module viewer/rendering/lineElements
 */

import * as THREE from 'three';
import { getMaterialForElementWithMode } from './materials.js';
import { getViewerState } from '../stateProvider.js';
import {
  log,
  LINE_ELEMENT_LABEL_OFFSET_MM,
  getSectionIdFromElement,
  resolveImportanceWithSectionValidation,
  disposeAndClearGroup,
  createLabelSpriteInternal,
  generateLabelTextInternal,
  attachElementDataToLabelInternal,
  isValidLineCoords,
  applyImportanceVisuals,
} from './elementsShared.js';

/**
 * onlyA / onlyB 要素のライン描画を行う共通関数
 * @param {Array} items - onlyA/onlyB 要素配列
 * @param {string} elementType - 要素タイプ名
 * @param {string} materialCategory - マテリアルカテゴリ ('onlyA' | 'onlyB')
 * @param {string} modelSource - モデルソース ('A' | 'B')
 * @param {string} labelPrefix - ラベルプレフィックス ('A' | 'B')
 * @param {THREE.Group} group - 描画対象グループ
 * @param {boolean} labelToggle - ラベル表示の有無
 * @param {number} labelOffsetAmount - ラベルオフセット量
 * @param {number} labelOffsetSign - ラベルオフセット方向 (1: add, -1: sub)
 * @param {THREE.Box3} modelBounds - バウンディングボックス
 * @param {Array<THREE.Sprite>} createdLabels - ラベル収集配列
 */
function drawOnlyLineElements(
  items,
  elementType,
  materialCategory,
  modelSource,
  labelPrefix,
  group,
  labelToggle,
  labelOffsetAmount,
  labelOffsetSign,
  modelBounds,
  createdLabels,
) {
  let debugCount = 0;
  items.forEach((item) => {
    if (!item) {
      log.warn(`Skipping undefined item in ${materialCategory} for ${elementType}`);
      return;
    }
    const { startCoords, endCoords, id, element, importance } = item;
    if (!isValidLineCoords(startCoords, endCoords)) {
      log.warn(`Skipping ${materialCategory} line due to invalid coords: ID=${id}`);
      return;
    }

    const startVec = new THREE.Vector3(startCoords.x, startCoords.y, startCoords.z);
    const endVec = new THREE.Vector3(endCoords.x, endCoords.y, endCoords.z);

    if (debugCount < 2) {
      log.debug(
        `${elementType} ${materialCategory} element ${debugCount}: Start=(${startCoords.x.toFixed(
          0,
        )}, ${startCoords.y.toFixed(0)}, ${startCoords.z.toFixed(
          0,
        )})mm, End=(${endCoords.x.toFixed(0)}, ${endCoords.y.toFixed(
          0,
        )}, ${endCoords.z.toFixed(0)})mm`,
      );
    }
    debugCount++;

    const geometry = new THREE.BufferGeometry().setFromPoints([startVec, endVec]);
    const line = new THREE.Line(
      geometry,
      getMaterialForElementWithMode(elementType, materialCategory, true, false, id),
    );
    const effectiveImportance = resolveImportanceWithSectionValidation(importance, element);
    line.userData = {
      elementType: elementType,
      elementId: id,
      modelSource: modelSource,
      importance: effectiveImportance,
      isLine: true,
      sectionId: getSectionIdFromElement(element) || undefined,
    };

    applyImportanceVisuals(line, effectiveImportance);

    group.add(line);
    modelBounds.expandByPoint(startVec);
    modelBounds.expandByPoint(endVec);

    if (labelToggle && id) {
      const midPoint = new THREE.Vector3().addVectors(startVec, endVec).multiplyScalar(0.5);
      const direction = endVec.clone().sub(startVec).normalize();
      let offsetDir = new THREE.Vector3(-direction.y, direction.x, 0).normalize();
      if (offsetDir.lengthSq() < 0.1) offsetDir = new THREE.Vector3(1, 0, 0);
      const labelPosition = midPoint
        .clone()
        .add(offsetDir.multiplyScalar(labelOffsetSign * labelOffsetAmount));

      const contentType = getViewerState('ui.labelContentType') || 'id';
      let displayText = id;

      if (contentType === 'name' && element && element.name) {
        displayText = element.name;
      } else if (contentType === 'section') {
        displayText = generateLabelTextInternal(element, elementType);
      }

      const labelText = `${labelPrefix}: ${displayText}`;
      const sprite = createLabelSpriteInternal(labelText, labelPosition, group, elementType);
      if (sprite) {
        sprite.userData.elementId = id;
        sprite.userData.modelSource = modelSource;

        if (element) {
          attachElementDataToLabelInternal(sprite, element);
        }

        createdLabels.push(sprite);
      }
    }
  });
}

/**
 * matched線要素1件を処理する共通ヘルパー
 * @param {Object} item - matched比較結果アイテム
 * @param {number} index - ループインデックス（デバッグログ用）
 * @param {string} elementType - 要素タイプ名
 * @param {THREE.Group} group - 描画対象グループ
 * @param {THREE.Box3} modelBounds - バウンディングボックス
 * @param {boolean} labelToggle - ラベル表示の有無
 * @param {Array<THREE.Sprite>} createdLabels - ラベル収集配列
 * @returns {{ processed: boolean, skipped: boolean }} 処理結果
 */
function processMatchedLineItem(
  item,
  index,
  elementType,
  group,
  modelBounds,
  labelToggle,
  createdLabels,
) {
  if (!item) {
    log.warn(`Skipping undefined item in matched for ${elementType}`);
    return { processed: false, skipped: false };
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

  // dataAまたはdataBがundefinedの場合はスキップ
  if (!dataA || !dataB) {
    log.warn(`Skipping item with undefined dataA or dataB in matched for ${elementType}`);
    return { processed: false, skipped: false };
  }

  if (index < 3) {
    // 最初の3つの要素について詳細ログを出力
    log.debug(`Processing matched item ${index}:`, {
      dataA,
      dataB,
      importance,
      matchType,
    });
    log.trace('dataA.startCoords:', dataA.startCoords);
    log.trace('dataA.endCoords:', dataA.endCoords);
  }

  const startCoords = dataA.startCoords;
  const endCoords = dataA.endCoords;
  const idA = dataA.id;
  const idB = dataB.id;

  if (!isValidLineCoords(startCoords, endCoords)) {
    log.warn(`Skipping matched line due to invalid coords: A=${idA}, B=${idB}`);
    return { processed: true, skipped: true };
  }

  const startVec = new THREE.Vector3(startCoords.x, startCoords.y, startCoords.z);
  const endVec = new THREE.Vector3(endCoords.x, endCoords.y, endCoords.z);

  if (index < 3) {
    log.debug(
      `${elementType} matched element ${index}: Start=(${startCoords.x.toFixed(
        0,
      )}, ${startCoords.y.toFixed(0)}, ${startCoords.z.toFixed(
        0,
      )})mm, End=(${endCoords.x.toFixed(0)}, ${endCoords.y.toFixed(
        0,
      )}, ${endCoords.z.toFixed(0)})mm`,
    );
  }

  const geometry = new THREE.BufferGeometry().setFromPoints([startVec, endVec]);
  const material = getMaterialForElementWithMode(
    elementType,
    'matched',
    true,
    false,
    idA,
    matchType,
    { diffStatus, positionState, attributeState },
  );
  if (index < 3) {
    log.trace(`Material for matched item ${index}:`, material);
  }

  const line = new THREE.Line(geometry, material);

  // 重要度データを取得（重要度管理システムから、比較結果の値を上書き）
  let resolvedImportance = importance;
  const importanceManager = getViewerState('importanceManager');
  const sourceElementA = dataA.rawElement || dataA.element || null;
  const sourceElementB = dataB.rawElement || dataB.element || null;
  if (importanceManager) {
    const stbElementType = `Stb${elementType}`;
    resolvedImportance =
      (sourceElementA
        ? importanceManager.getElementImportance?.(sourceElementA, stbElementType)
        : null) ||
      (sourceElementB
        ? importanceManager.getElementImportance?.(sourceElementB, stbElementType)
        : null) ||
      importance;
  }
  // 参照断面にバリデーションエラーがある場合は違反として扱う
  resolvedImportance = resolveImportanceWithSectionValidation(
    resolvedImportance,
    sourceElementA || sourceElementB,
  );

  line.userData = {
    elementType: elementType,
    elementId: idA,
    elementIdA: idA,
    elementIdB: idB,
    modelSource: 'matched',
    originalId: idA,
    id: idA,
    importance: resolvedImportance,
    toleranceState: matchType,
    category: category || matchType || 'exact',
    positionState: positionState || 'exact',
    attributeState: attributeState || 'matched',
    diffStatus: diffStatus || undefined,
    attributeMismatchKind: attributeMismatchKind || undefined,
    isLine: true,
    sectionId: getSectionIdFromElement(sourceElementA || sourceElementB) || undefined,
  };

  if (index < 3) {
    log.trace(`Created line object ${index}:`, line);
    log.trace(`Line importance:`, resolvedImportance);
    log.trace(`Line geometry points:`, geometry.attributes.position.array);
  }

  applyImportanceVisuals(line, resolvedImportance);

  group.add(line);

  if (index < 3) {
    log.debug(`Added line ${index} to group. Group children count:`, group.children.length);
  }

  modelBounds.expandByPoint(startVec);
  modelBounds.expandByPoint(endVec);

  if (labelToggle && (idA || idB)) {
    const midPoint = new THREE.Vector3().addVectors(startVec, endVec).multiplyScalar(0.5);

    const contentType = getViewerState('ui.labelContentType') || 'id';
    let labelText;

    if (contentType === 'id') {
      labelText = `${idA || '?'} / ${idB || '?'}`;
    } else {
      const nameA = dataA.element && dataA.element.name ? dataA.element.name : idA;
      const nameB = dataB.element && dataB.element.name ? dataB.element.name : idB;
      labelText = `${nameA || '?'} / ${nameB || '?'}`;
    }

    const sprite = createLabelSpriteInternal(labelText, midPoint, group, elementType);
    if (sprite) {
      sprite.userData.elementIdA = idA;
      sprite.userData.elementIdB = idB;
      sprite.userData.modelSource = 'matched';

      if (dataA.element) {
        attachElementDataToLabelInternal(sprite, dataA.element);
      }

      createdLabels.push(sprite);
    }
  }

  return { processed: true, skipped: false };
}

/**
 * 線要素（柱、梁など）の比較結果を描画する
 * @param {object} comparisonResult - compareElementsの比較結果
 * @param {THREE.Group} group - 描画対象の要素グループ
 * @param {string} elementType - 描画する要素タイプ名 (例: 'Column')
 * @param {boolean} labelToggle - ラベル表示の有無
 * @param {THREE.Box3} modelBounds - 更新するモデル全体のバウンディングボックス
 * @returns {Array<THREE.Sprite>} 作成されたラベルスプライトの配列
 */
export function drawLineElements(comparisonResult, group, elementType, labelToggle, modelBounds) {
  disposeAndClearGroup(group);
  const createdLabels = [];
  const labelOffsetAmount = LINE_ELEMENT_LABEL_OFFSET_MM;

  log.info(`Drawing line elements for ${elementType}:`, {
    matched: comparisonResult.matched.length,
    onlyA: comparisonResult.onlyA.length,
    onlyB: comparisonResult.onlyB.length,
  });

  let processedCount = 0;
  let skippedCount = 0;
  let addedToGroupCount = 0;

  comparisonResult.matched.forEach((item, index) => {
    const result = processMatchedLineItem(
      item,
      index,
      elementType,
      group,
      modelBounds,
      labelToggle,
      createdLabels,
    );
    if (result.processed) {
      processedCount++;
      if (result.skipped) {
        skippedCount++;
      } else {
        addedToGroupCount++;
      }
    }
  });

  // onlyA 要素の描画
  drawOnlyLineElements(
    comparisonResult.onlyA,
    elementType,
    'onlyA',
    'A',
    'A',
    group,
    labelToggle,
    labelOffsetAmount,
    1,
    modelBounds,
    createdLabels,
  );

  // onlyB 要素の描画
  drawOnlyLineElements(
    comparisonResult.onlyB,
    elementType,
    'onlyB',
    'B',
    'B',
    group,
    labelToggle,
    labelOffsetAmount,
    -1,
    modelBounds,
    createdLabels,
  );

  log.info(`${elementType} line rendering summary:`, {
    processedCount,
    skippedCount,
    addedToGroupCount,
    groupChildrenCount: group.children.length,
    groupVisible: group.visible,
  });

  return createdLabels;
}
