/**
 * @fileoverview バッチ処理対応構造要素描画モジュール
 *
 * 複数の要素ジオメトリを結合してドローコールを削減し、
 * 大規模モデルのレンダリング性能を向上させます。
 *
 * 既存のelements.jsと共存し、要素数に応じて自動的に切り替えます。
 */

import * as THREE from 'three';
import { createLogger } from '../../utils/logger.js';
import { getMaterialForElementWithMode } from './materials.js';
import { LineBatcher, getHitElementFromBatch } from './geometryBatcher.js';
import { getViewerState } from '../stateProvider.js';
import {
  attachElementDataToLabelInternal,
  createLabelSpriteInternal,
  disposeAndClearGroup,
  generateLabelTextInternal,
  getSharedNodeSphereGeometry,
  isValidPointCoords,
  setElementsLabelProvider,
} from './elementsShared.js';

const log = createLogger('viewer:batchedElements');

// ============================================
// ラベル処理プロバイダー（elementsSharedと共通）
// ============================================

/**
 * 後方互換API。通常描画・Batch描画で同じProviderを共有する。
 * @param {Object|null} provider
 */
export function setLabelProvider(provider) {
  setElementsLabelProvider(provider);
}

/**
 * バッチ処理を使用する要素数の閾値
 * この数を超える場合にバッチ処理を使用
 */
const BATCH_THRESHOLD = 100;

/**
 * バッチ処理を使用するかどうかを判定
 *
 * @param {Object} comparisonResult - 比較結果
 * @returns {boolean} バッチ処理を使用すべきかどうか
 */
export function shouldUseBatchRendering(comparisonResult) {
  const totalElements =
    (comparisonResult.matched?.length || 0) +
    (comparisonResult.onlyA?.length || 0) +
    (comparisonResult.onlyB?.length || 0);

  return totalElements >= BATCH_THRESHOLD;
}

/**
 * バッチ処理で線要素を描画
 *
 * @param {Object} comparisonResult - 比較結果
 * @param {Object} materials - マテリアル
 * @param {THREE.Group} group - 描画グループ
 * @param {string} elementType - 要素タイプ
 * @param {boolean} labelToggle - ラベル表示の有無
 * @param {THREE.Box3} modelBounds - モデル境界
 * @returns {Array<THREE.Sprite>} 作成されたラベル
 */
export function drawLineElementsBatched(
  comparisonResult,
  materials,
  group,
  elementType,
  labelToggle,
  modelBounds,
) {
  disposeAndClearGroup(group);
  const createdLabels = [];

  log.info(`Drawing batched line elements for ${elementType}:`, {
    matched: comparisonResult.matched.length,
    onlyA: comparisonResult.onlyA.length,
    onlyB: comparisonResult.onlyB.length,
  });

  const matchedBatchers = new Map();
  const onlyABatcher = new LineBatcher();
  const onlyBBatcher = new LineBatcher();

  const getMatchedBatcher = (diffStatus) => {
    const key = diffStatus || 'matched';
    if (!matchedBatchers.has(key)) {
      matchedBatchers.set(key, new LineBatcher());
    }
    return matchedBatchers.get(key);
  };

  comparisonResult.matched.forEach((item) => {
    const {
      dataA,
      dataB,
      importance,
      matchType,
      positionState,
      attributeState,
      diffStatus,
      attributeMismatchKind,
    } = item;
    const startCoords = dataA.startCoords;
    const endCoords = dataA.endCoords;

    if (!isValidPointCoords(startCoords) || !isValidPointCoords(endCoords)) {
      return;
    }

    const startVec = new THREE.Vector3(startCoords.x, startCoords.y, startCoords.z);
    const endVec = new THREE.Vector3(endCoords.x, endCoords.y, endCoords.z);

    getMatchedBatcher(diffStatus).addLine(startVec, endVec, {
      elementType,
      elementIdA: dataA.id,
      elementIdB: dataB.id,
      modelSource: 'matched',
      originalId: dataA.id,
      id: dataA.id,
      importance,
      toleranceState: matchType,
      positionState,
      attributeState,
      diffStatus,
      attributeMismatchKind,
      isLine: true,
    });

    modelBounds.expandByPoint(startVec);
    modelBounds.expandByPoint(endVec);

    if (labelToggle && (dataA.id || dataB.id)) {
      const label = createBatchedLabel(
        startVec,
        endVec,
        dataA,
        dataB,
        'matched',
        elementType,
        group,
      );
      if (label) createdLabels.push(label);
    }
  });

  comparisonResult.onlyA.forEach((item) => {
    const { startCoords, endCoords, id, element, importance } = item;

    if (!isValidPointCoords(startCoords) || !isValidPointCoords(endCoords)) {
      return;
    }

    const startVec = new THREE.Vector3(startCoords.x, startCoords.y, startCoords.z);
    const endVec = new THREE.Vector3(endCoords.x, endCoords.y, endCoords.z);

    onlyABatcher.addLine(startVec, endVec, {
      elementType,
      elementId: id,
      modelSource: 'A',
      importance,
      isLine: true,
    });

    modelBounds.expandByPoint(startVec);
    modelBounds.expandByPoint(endVec);

    if (labelToggle && id) {
      const label = createSingleModelLabel(
        startVec,
        endVec,
        id,
        element,
        'A',
        elementType,
        group,
        150,
      );
      if (label) createdLabels.push(label);
    }
  });

  comparisonResult.onlyB.forEach((item) => {
    const { startCoords, endCoords, id, element, importance } = item;

    if (!isValidPointCoords(startCoords) || !isValidPointCoords(endCoords)) {
      return;
    }

    const startVec = new THREE.Vector3(startCoords.x, startCoords.y, startCoords.z);
    const endVec = new THREE.Vector3(endCoords.x, endCoords.y, endCoords.z);

    onlyBBatcher.addLine(startVec, endVec, {
      elementType,
      elementId: id,
      modelSource: 'B',
      importance,
      isLine: true,
    });

    modelBounds.expandByPoint(startVec);
    modelBounds.expandByPoint(endVec);

    if (labelToggle && id) {
      const label = createSingleModelLabel(
        startVec,
        endVec,
        id,
        element,
        'B',
        elementType,
        group,
        -150,
      );
      if (label) createdLabels.push(label);
    }
  });

  for (const [diffStatus, batcher] of matchedBatchers.entries()) {
    if (batcher.count === 0) continue;
    const material = getMaterialForElementWithMode(
      elementType,
      'matched',
      true,
      false,
      null,
      null,
      {
        diffStatus,
      },
    );
    const batchedLines = batcher.build(material);
    batchedLines.userData.batchType = 'matched';
    batchedLines.userData.diffStatus = diffStatus;
    group.add(batchedLines);
  }

  if (onlyABatcher.count > 0) {
    const material = getMaterialForElementWithMode(elementType, 'onlyA', true, false, null);
    const batchedLines = onlyABatcher.build(material);
    batchedLines.userData.batchType = 'onlyA';
    batchedLines.userData.modelSource = 'A';
    group.add(batchedLines);
  }

  if (onlyBBatcher.count > 0) {
    const material = getMaterialForElementWithMode(elementType, 'onlyB', true, false, null);
    const batchedLines = onlyBBatcher.build(material);
    batchedLines.userData.batchType = 'onlyB';
    batchedLines.userData.modelSource = 'B';
    group.add(batchedLines);
  }

  log.info(`Batched ${elementType} rendering summary:`, {
    matchedSegments: Array.from(matchedBatchers.values()).reduce(
      (sum, batcher) => sum + batcher.count,
      0,
    ),
    onlyASegments: onlyABatcher.count,
    onlyBSegments: onlyBBatcher.count,
    totalDrawCalls: 3,
    labelsCreated: createdLabels.length,
  });

  return createdLabels;
}

function createBatchedLabel(startVec, endVec, dataA, dataB, modelSource, elementType, group) {
  const midPoint = new THREE.Vector3().addVectors(startVec, endVec).multiplyScalar(0.5);

  const contentType = getViewerState('ui.labelContentType') || 'id';
  let labelText;

  if (contentType === 'id') {
    labelText = `${dataA.id || '?'} / ${dataB.id || '?'}`;
  } else {
    const nameA = dataA.element?.name || dataA.id;
    const nameB = dataB.element?.name || dataB.id;
    labelText = `${nameA || '?'} / ${nameB || '?'}`;
  }

  const sprite = createLabelSpriteInternal(labelText, midPoint, group, elementType);
  if (sprite) {
    sprite.userData.elementIdA = dataA.id;
    sprite.userData.elementIdB = dataB.id;
    sprite.userData.modelSource = modelSource;

    if (dataA.element) {
      attachElementDataToLabelInternal(sprite, dataA.element);
    }
  }

  return sprite;
}

function createSingleModelLabel(
  startVec,
  endVec,
  id,
  element,
  modelSource,
  elementType,
  group,
  offsetAmount,
) {
  const midPoint = new THREE.Vector3().addVectors(startVec, endVec).multiplyScalar(0.5);

  const direction = endVec.clone().sub(startVec).normalize();
  let offsetDir = new THREE.Vector3(-direction.y, direction.x, 0).normalize();
  if (offsetDir.lengthSq() < 0.1) offsetDir = new THREE.Vector3(1, 0, 0);

  const labelPosition = midPoint.clone().add(offsetDir.multiplyScalar(offsetAmount));

  const contentType = getViewerState('ui.labelContentType') || 'id';
  let displayText = id;

  if (contentType === 'name' && element?.name) {
    displayText = element.name;
  } else if (contentType === 'section') {
    displayText = generateLabelTextInternal(element, elementType);
  }

  const labelText = `${modelSource}: ${displayText}`;
  const sprite = createLabelSpriteInternal(labelText, labelPosition, group, elementType);

  if (sprite) {
    sprite.userData.elementId = id;
    sprite.userData.modelSource = modelSource;

    if (element) {
      attachElementDataToLabelInternal(sprite, element);
    }
  }

  return sprite;
}

export function getElementFromBatchedIntersection(intersection) {
  return getHitElementFromBatch(intersection);
}

export function drawNodesBatched(comparisonResult, materials, group, labelToggle, modelBounds) {
  disposeAndClearGroup(group);
  const createdLabels = [];

  const onlyANodes = [];
  const onlyBNodes = [];
  const matchedByType = new Map();

  comparisonResult.matched.forEach((item) => {
    const {
      dataA,
      dataB,
      importance,
      matchType,
      positionState,
      attributeState,
      diffStatus,
      attributeMismatchKind,
    } = item;
    const coords = dataA.coords;
    const idA = dataA.id;
    const idB = dataB.id;

    if (!isValidPointCoords(coords)) {
      log.warn(`Skipping matched node due to invalid coords: A=${idA}, B=${idB}`);
      return;
    }

    const pos = new THREE.Vector3(coords.x, coords.y, coords.z);
    modelBounds.expandByPoint(pos);

    const typeKey = diffStatus || matchType || 'exact';
    if (!matchedByType.has(typeKey)) {
      matchedByType.set(typeKey, []);
    }
    matchedByType.get(typeKey).push({
      position: pos,
      idA,
      idB,
      importance,
      matchType,
      positionState,
      attributeState,
      diffStatus,
      attributeMismatchKind,
    });

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
  });

  comparisonResult.onlyA.forEach((item) => {
    const { coords, id, importance } = item;

    if (!isValidPointCoords(coords)) {
      log.warn(`Skipping onlyA node due to invalid coords: ID=${id}`);
      return;
    }

    const pos = new THREE.Vector3(coords.x, coords.y, coords.z);
    modelBounds.expandByPoint(pos);

    onlyANodes.push({
      position: pos,
      id,
      importance,
    });

    if (labelToggle) {
      const labelText = `A: ${id}`;
      const sprite = createLabelSpriteInternal(labelText, pos, group, 'Node');
      if (sprite) {
        sprite.userData.elementId = id;
        sprite.userData.modelSource = 'A';
        createdLabels.push(sprite);
      }
    }
  });

  comparisonResult.onlyB.forEach((item) => {
    const { coords, id, importance } = item;

    if (!isValidPointCoords(coords)) {
      log.warn(`Skipping onlyB node due to invalid coords: ID=${id}`);
      return;
    }

    const pos = new THREE.Vector3(coords.x, coords.y, coords.z);
    modelBounds.expandByPoint(pos);

    onlyBNodes.push({
      position: pos,
      id,
      importance,
    });

    if (labelToggle) {
      const labelText = `B: ${id}`;
      const sprite = createLabelSpriteInternal(labelText, pos, group, 'Node');
      if (sprite) {
        sprite.userData.elementId = id;
        sprite.userData.modelSource = 'B';
        createdLabels.push(sprite);
      }
    }
  });

  const sphereGeometry = getSharedNodeSphereGeometry();

  matchedByType.forEach((nodes, statusKey) => {
    if (nodes.length === 0) return;
    const firstNode = nodes[0];

    const material = getMaterialForElementWithMode(
      'Node',
      'matched',
      false,
      false,
      null,
      firstNode.matchType,
      {
        diffStatus: firstNode.diffStatus,
        positionState: firstNode.positionState,
        attributeState: firstNode.attributeState,
      },
    );

    const instancedMesh = new THREE.InstancedMesh(sphereGeometry, material, nodes.length);

    const matrix = new THREE.Matrix4();
    const instanceUserData = [];

    nodes.forEach((node, i) => {
      matrix.setPosition(node.position);
      instancedMesh.setMatrixAt(i, matrix);
      instanceUserData.push({
        elementType: 'Node',
        elementIdA: node.idA,
        elementIdB: node.idB,
        modelSource: 'matched',
        toleranceState: node.matchType,
        positionState: node.positionState,
        attributeState: node.attributeState,
        diffStatus: node.diffStatus,
        attributeMismatchKind: node.attributeMismatchKind,
      });
    });

    instancedMesh.instanceMatrix.needsUpdate = true;
    instancedMesh.userData = {
      isBatched: true,
      isInstanced: true,
      elementType: 'Node',
      batchType: 'matched',
      diffStatus: firstNode.diffStatus || statusKey,
      attributeMismatchKind: firstNode.attributeMismatchKind,
      instanceCount: nodes.length,
      instances: instanceUserData,
    };

    group.add(instancedMesh);
  });

  if (onlyANodes.length > 0) {
    const material = getMaterialForElementWithMode('Node', 'onlyA', false, false, null);

    const instancedMesh = new THREE.InstancedMesh(sphereGeometry, material, onlyANodes.length);

    const matrix = new THREE.Matrix4();
    const instanceUserData = [];

    onlyANodes.forEach((node, i) => {
      matrix.setPosition(node.position);
      instancedMesh.setMatrixAt(i, matrix);
      instanceUserData.push({
        elementType: 'Node',
        elementId: node.id,
        modelSource: 'A',
      });
    });

    instancedMesh.instanceMatrix.needsUpdate = true;
    instancedMesh.userData = {
      isBatched: true,
      isInstanced: true,
      elementType: 'Node',
      batchType: 'onlyA',
      modelSource: 'A',
      instanceCount: onlyANodes.length,
      instances: instanceUserData,
    };

    group.add(instancedMesh);
  }

  if (onlyBNodes.length > 0) {
    const material = getMaterialForElementWithMode('Node', 'onlyB', false, false, null);

    const instancedMesh = new THREE.InstancedMesh(sphereGeometry, material, onlyBNodes.length);

    const matrix = new THREE.Matrix4();
    const instanceUserData = [];

    onlyBNodes.forEach((node, i) => {
      matrix.setPosition(node.position);
      instancedMesh.setMatrixAt(i, matrix);
      instanceUserData.push({
        elementType: 'Node',
        elementId: node.id,
        modelSource: 'B',
      });
    });

    instancedMesh.instanceMatrix.needsUpdate = true;
    instancedMesh.userData = {
      isBatched: true,
      isInstanced: true,
      elementType: 'Node',
      batchType: 'onlyB',
      modelSource: 'B',
      instanceCount: onlyBNodes.length,
      instances: instanceUserData,
    };

    group.add(instancedMesh);
  }

  const totalNodes =
    comparisonResult.matched.length + comparisonResult.onlyA.length + comparisonResult.onlyB.length;

  log.info(`Batched Node rendering summary:`, {
    totalNodes,
    matchedNodes: comparisonResult.matched.length,
    onlyANodes: onlyANodes.length,
    onlyBNodes: onlyBNodes.length,
    drawCalls:
      matchedByType.size + (onlyANodes.length > 0 ? 1 : 0) + (onlyBNodes.length > 0 ? 1 : 0),
    labelsCreated: createdLabels.length,
  });

  return createdLabels;
}
