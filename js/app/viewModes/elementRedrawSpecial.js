/**
 * @fileoverview 特殊要素（継手・未定義要素）の再描画処理
 */

import { createLogger } from '../../utils/logger.js';
import { getModelContext } from './modelContext.js';
import {
  drawLineElements,
  drawLineElementsBatched,
  elementGroups,
  shouldUseBatchRendering,
  displayModeManager,
  labelDisplayManager,
  geometryGeneratorFactory,
  parseStbFile,
  finalizeRenderableBatch,
} from '../../viewer/index.js';
import { eventBus, LabelEvents } from '../../data/events/index.js';
import { compareElements } from '../../common-stb/comparison/index.js';

const log = createLogger('elementRedrawer');

export function redrawJointsForViewMode(scheduleRender) {
  // 継手は特殊な要素で、梁・柱に関連付けられている
  // solid表示モードの場合のみ継手プレートを描画

  // モデルコンテキストを取得
  const { modelADocument, modelBDocument } = getModelContext();

  if (!modelADocument && !modelBDocument) {
    return;
  }

  const group = elementGroups['Joint'];
  if (!group) {
    return;
  }

  // 既存のラベルを削除
  eventBus.emit(LabelEvents.REMOVE_BY_TYPE, 'Joint');
  group.clear();

  // グループを可視状態に設定（初期レンダリング時にfalseになっている可能性があるため）
  group.visible = true;

  const viewMode = displayModeManager.getDisplayMode('Joint');
  log.debug(`[redrawJointsForViewMode] mode: ${viewMode}`);

  if (viewMode !== 'solid') {
    // 線表示モードでは継手は非表示。clear済みの空groupもbatch変更として通知する。
    group.visible = false;
    finalizeRenderableBatch({ elementType: 'Joint', group });
    if (scheduleRender) scheduleRender();
    return;
  }

  // compareModels でキャッシュを温めているため、まずは再利用を試し、継手情報がない場合だけ再パースする。
  let stbDataA = modelADocument
    ? parseStbFile(modelADocument, { modelKey: 'A', saveToGlobalState: true })
    : null;
  let stbDataB = modelBDocument
    ? parseStbFile(modelBDocument, { modelKey: 'B', saveToGlobalState: true })
    : null;

  if (modelADocument && stbDataA && !stbDataA.jointElements) {
    stbDataA = parseStbFile(modelADocument, {
      modelKey: 'A',
      saveToGlobalState: true,
      forceReparse: true,
    });
  }
  if (modelBDocument && stbDataB && !stbDataB.jointElements) {
    stbDataB = parseStbFile(modelBDocument, {
      modelKey: 'B',
      saveToGlobalState: true,
      forceReparse: true,
    });
  }

  // 継手を持つ梁要素を収集（GirderとBeam）
  const jointedElementsA = [];
  const jointedElementsB = [];

  if (stbDataA) {
    log.debug(
      `[redrawJointsForViewMode] stbDataA: girders=${stbDataA.girderElements?.length || 0}, beams=${stbDataA.beamElements?.length || 0}, jointElements=${stbDataA.jointElements?.size || 0}`,
    );

    // Girder要素から継手情報を持つものを抽出
    for (const girder of stbDataA.girderElements || []) {
      if (girder.joint_id_start || girder.joint_id_end) {
        log.debug(
          `[redrawJointsForViewMode] Found jointed girder: id=${girder.id}, joint_id_start=${girder.joint_id_start}, joint_id_end=${girder.joint_id_end}`,
        );
        jointedElementsA.push({ ...girder, elementType: 'Girder' });
      }
    }
    // Beam要素から継手情報を持つものを抽出
    for (const beam of stbDataA.beamElements || []) {
      if (beam.joint_id_start || beam.joint_id_end) {
        log.debug(
          `[redrawJointsForViewMode] Found jointed beam: id=${beam.id}, joint_id_start=${beam.joint_id_start}, joint_id_end=${beam.joint_id_end}`,
        );
        jointedElementsA.push({ ...beam, elementType: 'Beam' });
      }
    }
    log.debug(`[redrawJointsForViewMode] Total jointed elements A: ${jointedElementsA.length}`);
  }

  if (stbDataB) {
    for (const girder of stbDataB.girderElements || []) {
      if (girder.joint_id_start || girder.joint_id_end) {
        jointedElementsB.push({ ...girder, elementType: 'Girder' });
      }
    }
    for (const beam of stbDataB.beamElements || []) {
      if (beam.joint_id_start || beam.joint_id_end) {
        jointedElementsB.push({ ...beam, elementType: 'Beam' });
      }
    }
  }

  // Jointジェネレータを動的解決（クラスの静的メソッドを使用）
  const jointInfo = geometryGeneratorFactory.getGeneratorInfo('Joint');

  if (!jointInfo) {
    log.warn('Joint generator not found');
    finalizeRenderableBatch({ elementType: 'Joint', group });
    if (scheduleRender) scheduleRender();
    return;
  }

  const jointGenerator = jointInfo.class;
  const jointMethod = jointInfo.method;

  // 継手メッシュを生成
  if (stbDataA && jointedElementsA.length > 0) {
    const meshes = jointGenerator[jointMethod](
      jointedElementsA,
      stbDataA.nodes,
      stbDataA.jointElements,
      stbDataA.steelSections,
      'Joint',
      false,
      {
        girderSections: stbDataA.girderSections,
        beamSections: stbDataA.beamSections,
      },
    );
    meshes.forEach((mesh) => {
      mesh.userData.modelSource = 'A';
      group.add(mesh);
    });
    log.debug(`[redrawJointsForViewMode] Created ${meshes.length} joint meshes from model A`);
  }

  if (stbDataB && jointedElementsB.length > 0) {
    const meshes = jointGenerator[jointMethod](
      jointedElementsB,
      stbDataB.nodes,
      stbDataB.jointElements,
      stbDataB.steelSections,
      'Joint',
      false,
      {
        girderSections: stbDataB.girderSections,
        beamSections: stbDataB.beamSections,
      },
    );
    meshes.forEach((mesh) => {
      mesh.userData.modelSource = 'B';
      group.add(mesh);
    });
    log.debug(`[redrawJointsForViewMode] Created ${meshes.length} joint meshes from model B`);
  }

  finalizeRenderableBatch({ elementType: 'Joint', group });

  // カラーモード適用（動的インポート）
  import('../../colorModes/index.js')
    .then(({ updateElementsForColorMode }) => {
      updateElementsForColorMode();
    })
    .catch((err) => {
      log.error('Failed to update colors for joint mode:', err);
    });

  if (scheduleRender) scheduleRender();
}

/**
 * Undefined断面を参照する要素の再描画
 * StbSecUndefinedを参照する要素は断面寸法が不明なため、常にラインのみで表示
 * @param {Function} scheduleRender - 再描画要求関数
 */
export function redrawUndefinedElementsForViewMode(scheduleRender) {
  // モデルコンテキストを取得
  const { modelBounds, modelADocument, modelBDocument } = getModelContext();

  if (!modelADocument && !modelBDocument) return;

  const group = elementGroups['Undefined'];
  if (!group) {
    log.warn('[redrawUndefinedElementsForViewMode] Undefined group not found');
    return;
  }

  // 既存のラベルを削除してグループをクリア
  eventBus.emit(LabelEvents.REMOVE_BY_TYPE, 'Undefined');
  group.clear();

  // Undefined要素は表示モードに関係なく常にラインで表示
  log.debug('[redrawUndefinedElementsForViewMode] Drawing undefined elements as lines');

  // モデルデータを取得
  const stbDataA = modelADocument
    ? parseStbFile(modelADocument, { modelKey: 'A', saveToGlobalState: true })
    : null;
  const stbDataB = modelBDocument
    ? parseStbFile(modelBDocument, { modelKey: 'B', saveToGlobalState: true })
    : null;

  const undefinedElementsA = stbDataA?.undefinedElements || [];
  const undefinedElementsB = stbDataB?.undefinedElements || [];

  log.debug(
    `[redrawUndefinedElementsForViewMode] Found ${undefinedElementsA.length} elements in A, ${undefinedElementsB.length} in B`,
  );

  // ノードマップを取得
  const nodeMapA = stbDataA?.nodes || new Map();
  const nodeMapB = stbDataB?.nodes || new Map();

  log.debug(
    `[redrawUndefinedElementsForViewMode] NodeMap sizes: A=${nodeMapA.size}, B=${nodeMapB.size}`,
  );

  // デバッグ: 最初のundefined要素の属性を確認
  if (undefinedElementsA.length > 0) {
    const firstEl = undefinedElementsA[0];
    log.debug(
      `[redrawUndefinedElementsForViewMode] First element A: id=${firstEl.id}, ` +
        `originalType=${firstEl.originalType}, ` +
        `nodeStartAttr=${firstEl.nodeStartAttr}, nodeEndAttr=${firstEl.nodeEndAttr}, ` +
        `startValue=${firstEl[firstEl.nodeStartAttr]}, endValue=${firstEl[firstEl.nodeEndAttr]}`,
    );
  }

  // 比較用にデータを変換
  const convertToComparisonFormat = (elements, nodeMap) => {
    return elements
      .map((el) => {
        // nodeStartAttr/nodeEndAttrは属性名（例: 'id_node_start'）
        const startAttr = el.nodeStartAttr;
        const endAttr = el.nodeEndAttr;
        const startNodeId = el[startAttr];
        const endNodeId = el[endAttr];

        if (!startNodeId || !endNodeId) {
          log.warn(
            `[redrawUndefinedElementsForViewMode] Missing node attr for element ${el.id}: ` +
              `startAttr=${startAttr}, endAttr=${endAttr}, ` +
              `startId=${startNodeId}, endId=${endNodeId}`,
          );
          return null;
        }

        // ノードマップからノードを取得（キーは文字列）
        const startNode = nodeMap.get(String(startNodeId));
        const endNode = nodeMap.get(String(endNodeId));

        if (!startNode || !endNode) {
          log.debug(
            `[redrawUndefinedElementsForViewMode] Node not found for element ${el.id}: ` +
              `startId=${startNodeId} (found=${!!startNode}), endId=${endNodeId} (found=${!!endNode})`,
          );
          return null;
        }

        return {
          id: el.id,
          startCoords: { x: startNode.x, y: startNode.y, z: startNode.z },
          endCoords: { x: endNode.x, y: endNode.y, z: endNode.z },
          originalType: el.originalType,
          name: el.name,
        };
      })
      .filter((el) => el !== null);
  };

  const dataA = convertToComparisonFormat(undefinedElementsA, nodeMapA);
  const dataB = convertToComparisonFormat(undefinedElementsB, nodeMapB);

  // 要素の比較を実行
  const comparisonResult = compareElements(dataA, dataB, nodeMapA, nodeMapB, (el) => {
    // 位置ベースのキー生成（start-end座標で比較）
    const start = el.startCoords;
    const end = el.endCoords;
    return `${start.x.toFixed(0)},${start.y.toFixed(0)},${start.z.toFixed(0)}-${end.x.toFixed(0)},${end.y.toFixed(0)},${end.z.toFixed(0)}`;
  });

  // ラベル表示設定を取得
  labelDisplayManager.syncWithCheckbox('Undefined');
  const createLabels = labelDisplayManager.isLabelVisible('Undefined');
  log.debug(`[redrawUndefinedElementsForViewMode] createLabels: ${createLabels}`);

  // 線要素を描画
  const createdLabels = shouldUseBatchRendering(comparisonResult)
    ? drawLineElementsBatched(comparisonResult, null, group, 'Undefined', createLabels, modelBounds)
    : drawLineElements(comparisonResult, group, 'Undefined', createLabels, modelBounds);

  if (createdLabels && createdLabels.length > 0) {
    log.debug(`[redrawUndefinedElementsForViewMode] Created ${createdLabels.length} labels`);
    eventBus.emit(LabelEvents.ADD_LABELS, createdLabels);
  }

  finalizeRenderableBatch({ elementType: 'Undefined', group });

  // カラーモード適用（動的インポート）
  import('../../colorModes/index.js')
    .then(({ updateElementsForColorMode }) => {
      updateElementsForColorMode();
    })
    .catch((err) => {
      log.error('Failed to update colors for undefined elements:', err);
    });

  if (scheduleRender) scheduleRender();
}
