/**
 * @fileoverview メインアプリケーションのイベントハンドラ
 */

import { createLogger } from '../../utils/logger.js';
import { compareModels } from '../controllers/modelLoaderController.js';
import { getState } from '../../data/state/globalState.js';
import { buildTree } from '../../ui/panels/elementTreeView.js';
import { buildSectionTree } from '../../ui/panels/sectionTreeView.js';
import { updateLabelVisibility } from '../../ui/viewer3d/unifiedLabelManager.js';
import { displayElementInfo } from '../../ui/panels/element-info/index.js';
import { selectElement3D, selectMultipleElements3D } from '../controllers/interactionController.js';
import { showError } from '../../ui/common/toast.js';
import { UI_TIMING } from '../../config/uiTimingConfig.js';
import { convertComparisonResultsForTree } from '../../data/converters/comparison-to-tree.js';
import { find3DObjectByElement } from './initializationUtils.js';
import { scene, axesHelper, setGridHelperVisibility } from '../../viewer/index.js';

const log = createLogger('eventHandlers');

/**
 * モデル比較ボタンのクリックハンドラ
 * @param {Function} scheduleRender - 再描画関数
 * @param {Object} dependencies - 依存オブジェクト
 * @param {boolean} dependencies.rendererInitialized - レンダラー初期化フラグ
 * @param {Object} dependencies.camera - カメラオブジェクト
 * @param {Object} dependencies.controls - コントロールオブジェクト
 * @param {boolean} [dependencies.requireCompleteRendering=false] - 部分描画を成功扱いしない
 * @returns {Promise<boolean>}
 */
export async function handleCompareModelsClick(scheduleRender, dependencies) {
  const {
    rendererInitialized,
    camera,
    controls,
    requireCompleteRendering = false,
    drawingProjectLoadHandoff = null,
  } = dependencies;

  // レンダラーが初期化されていない場合は処理中断
  if (!rendererInitialized) {
    showError('ビューアが初期化されていません。');
    return false;
  }

  // モデルの読み込みと比較処理
  const compareSucceeded = await compareModels(scheduleRender, {
    camera,
    controls,
    requireCompleteRendering,
    drawingProjectLoadHandoff,
  });
  if (!compareSucceeded) {
    return false;
  }

  const scheduleDeferredTask = (task) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(task, { timeout: 100 });
    } else {
      setTimeout(task, 0);
    }
  };

  // 比較結果を取得してツリーを非同期で構築
  scheduleDeferredTask(() => {
    const comparisonResults = getState('comparisonResults');
    if (!comparisonResults) {
      return;
    }

    log.info('要素ツリーを構築しています...');
    const treeData = convertComparisonResultsForTree(comparisonResults);
    buildTree(treeData);

    const sectionsData = getState('sectionsData');
    if (sectionsData) {
      scheduleDeferredTask(() => {
        log.info('断面ツリーを構築しています...');
        buildSectionTree(treeData, sectionsData);
      });
    }
  });

  // 少し待ってからラベル表示状態をチェックボックスに基づいて更新
  // （ラベル作成処理の完了を待つ）
  log.info('チェックボックスの状態に基づいてラベル表示を初期化しています...');
  setTimeout(() => {
    updateLabelVisibility();
    // 再描画
    if (typeof window.requestRender === 'function') window.requestRender();
  }, UI_TIMING.LABEL_UPDATE_DELAY_MS);
  return true;
}

/**
 * ツリービューで選択された要素を3Dビューで検索・選択する共通ハンドラ
 * @param {Object} selectedElement - 選択された要素情報
 * @param {string} selectedElement.elementType - 要素タイプ
 * @param {string|number} selectedElement.elementId - 要素ID
 * @param {string} selectedElement.modelSource - モデルソース ('matched', 'onlyA', 'onlyB')
 * @param {string} sourceName - ソース名（ログ出力用）
 * @param {boolean} [enableDebugInfo=false] - デバッグ情報を収集するか
 * @param {Function} scheduleRender - 再描画関数
 * @param {Object} elementGroups - 要素グループ
 */
export function handleTreeElementSelection(
  selectedElement,
  sourceName,
  enableDebugInfo,
  scheduleRender,
  elementGroups,
) {
  if (!selectedElement) {
    log.error(`${sourceName}: 選択された要素情報がnullまたはundefinedです`);
    return;
  }

  // 複数選択の場合
  if (selectedElement.multiSelect && selectedElement.selectedElements) {
    log.info(`${sourceName}: 複数選択 (${selectedElement.selectedElements.length}要素)`);

    const objectsToSelect = [];
    let skippedBatched = 0;
    for (const elem of selectedElement.selectedElements) {
      const hit = find3DObjectByElement(
        elem.elementType,
        elem.elementId,
        elem.modelSource,
        elementGroups,
      );
      if (!hit) continue;
      if (hit.kind !== 'object') {
        // バッチ描画（InstancedMesh/LineSegmentsバッチ）の個別要素は共有マテリアルのため
        // 複数ハイライトができない。複数選択では対象外とする。
        skippedBatched++;
        continue;
      }
      objectsToSelect.push(hit.object);
    }

    if (objectsToSelect.length > 0) {
      selectMultipleElements3D(objectsToSelect, scheduleRender);
      log.info(`${sourceName}: ${objectsToSelect.length}個の3D要素を選択しました`);
    } else {
      log.warn(`${sourceName}: 3Dビューアーで要素が見つかりませんでした`);
    }
    if (skippedBatched > 0) {
      log.info(`${sourceName}: バッチ描画のため複数ハイライト対象外: ${skippedBatched}件`);
    }
    return;
  }

  // 単一選択の場合（従来の処理）
  const { elementType, elementId, modelSource } = selectedElement;

  if (!elementType || !elementId) {
    log.error(`${sourceName}: 要素タイプまたはIDが指定されていません`);
    return;
  }

  // Axis/Story は3D探索のuserDataとID形式が一致しない場合があるため、
  // ツリー選択時は常にXMLベースで情報表示する。
  if (elementType === 'Axis' || elementType === 'Story') {
    const { idA, idB } = resolveElementInfoIds(selectedElement);
    displayElementInfo(idA, idB, elementType, modelSource).catch((err) =>
      log.error(`${sourceName}: displayElementInfo エラー:`, err),
    );
    return;
  }

  const elementGroup = elementGroups[elementType];
  const hasNo3DChildren = !elementGroup || elementGroup.children.length === 0;
  if (hasNo3DChildren) {
    // Story/Axis等の3D表現を持たない要素: パラメータ情報のみ表示
    const { idA, idB } = resolveElementInfoIds(selectedElement);
    displayElementInfo(idA, idB, elementType, modelSource).catch((err) =>
      log.error(`${sourceName}: displayElementInfo エラー:`, err),
    );
    return;
  }

  log.info(
    `${sourceName}: 要素を検索中: タイプ=${elementType}, ID=${elementId}, ソース=${modelSource}`,
  );

  // バッチ描画（InstancedMesh）にも対応した検索。個別要素は userData.instances[] に格納される。
  const hit = find3DObjectByElement(elementType, elementId, modelSource, elementGroups);

  if (hit) {
    log.info(`${sourceName}: 要素が見つかりました: ${elementType} ${elementId}`);
    const ud = hit.userData || {};

    // 要素情報を表示用のIDを決定
    let idA = null;
    let idB = null;
    if (modelSource === 'matched') {
      idA = ud.elementIdA || ud.elementId;
      idB = ud.elementIdB;
    } else if (modelSource === 'onlyA' || modelSource === 'A') {
      idA = ud.elementId || ud.elementIdA;
    } else if (modelSource === 'onlyB' || modelSource === 'B') {
      idB = ud.elementId || ud.elementIdB;
    }

    // 要素情報を表示
    displayElementInfo(idA, idB, elementType, modelSource).catch((err) =>
      log.error(`${sourceName}: displayElementInfo エラー:`, err),
    );

    // 3D選択（バッチ要素は batchHit を渡してフォーカス表示する）
    try {
      selectElement3D(hit.object, scheduleRender, { batchHit: hit });
      log.info(`${sourceName}: 3D要素の選択が完了しました`);
    } catch (err) {
      log.error(`${sourceName}: selectElement3D エラー:`, err);
    }
  } else {
    log.warn(
      `${sourceName}: 3Dビューアーで要素が見つかりませんでした: ${elementType} ${elementId} (${modelSource})`,
    );

    // 3D上で見つからなくても、XMLから情報表示は可能なのでフォールバックする
    const { idA, idB } = resolveElementInfoIds(selectedElement);
    displayElementInfo(idA, idB, elementType, modelSource).catch((err) =>
      log.error(`${sourceName}: displayElementInfo エラー(フォールバック):`, err),
    );
  }
}

/**
 * ツリー選択情報から要素情報パネル表示用の A/B ID を解決
 * @param {Object} selectedElement - ツリー選択要素
 * @returns {{idA: string|null, idB: string|null}}
 */
function resolveElementInfoIds(selectedElement) {
  const { elementId, modelSource } = selectedElement || {};
  const elem = selectedElement?.element || {};
  let idA = null;
  let idB = null;

  if (modelSource === 'matched') {
    idA = String(elem.elementA?.id || elementId || '');
    idB = elem.elementB?.id ? String(elem.elementB.id) : null;
    if (!idA) idA = null;
  } else if (modelSource === 'onlyA' || modelSource === 'A') {
    idA = elementId != null ? String(elementId) : null;
  } else if (modelSource === 'onlyB' || modelSource === 'B') {
    idB = elementId != null ? String(elementId) : null;
  }

  return { idA, idB };
}

/**
 * 原点軸（AxesHelper）の表示切り替え
 * @param {boolean} isVisible - 表示するかどうか
 */
export function toggleOriginAxesVisibility(isVisible) {
  try {
    if (!axesHelper) {
      log.warn('原点軸切り替えのためのAxesHelperが利用できません');
      return;
    }
    axesHelper.visible = isVisible;
    log.info(`原点軸の表示状態を切り替えました: ${isVisible}`);
  } catch (error) {
    log.error('原点軸の表示切り替えでエラーが発生しました:', error);
  }
}

/**
 * 配置基準線の表示切り替え
 * @param {boolean} isVisible - 表示するかどうか
 */
export function togglePlacementLinesVisibility(isVisible) {
  try {
    if (!scene) {
      log.warn('配置基準線切り替えのためのシーンが利用できません');
      return;
    }

    // すべてのメッシュオブジェクトを探索して配置基準線を切り替え
    scene.traverse((object) => {
      if (object.userData && object.userData.isPlacementLine) {
        object.visible = isVisible;
      }
    });

    log.info(`配置基準線の表示状態を切り替えました: ${isVisible}`);
  } catch (error) {
    log.error('配置基準線の表示切り替えでエラーが発生しました:', error);
  }
}

/**
 * Three.jsグリッドの表示切替
 * @param {boolean} isVisible - 表示するかどうか
 */
export function toggleGridVisibility(isVisible) {
  try {
    setGridHelperVisibility(isVisible);
    log.info(`グリッドの表示状態を変更しました: ${isVisible}`);
  } catch (error) {
    log.error('グリッドの表示切替でエラーが発生しました:', error);
  }
}
