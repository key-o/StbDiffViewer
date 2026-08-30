/**
 * @fileoverview 要素再描画コア処理
 *
 * メイン再描画オーケストレーターを提供します。
 *
 * サブモジュール:
 * - elementRedrawHelpers.js: 要素フィルタ・断面リゾルバ・キー抽出関数の生成
 * - elementRedrawSolid.js: ソリッドモードの比較・メッシュ・ラベル生成
 * - elementRedrawLineMode.js: 線表示・パネル表示の描画
 * - elementRedrawLabels.js: 立体表示要素のラベル作成
 *
 * @module app/viewModes/elementRedrawCore
 */

import { createLogger } from '../../utils/logger.js';
import { getModelContext } from './modelContext.js';
import {
  elementGroups,
  displayModeManager,
  geometryGeneratorFactory,
  parseStbFile,
  finalizeRenderableBatch,
} from '../../viewer/index.js';
import { eventBus, LabelEvents } from '../../data/events/index.js';
import { UI_TIMING } from '../../config/uiTimingConfig.js';
import { isWallElementType } from './elementRedrawHelpers.js';
import {
  createSolidModeLabels,
  createSolidModeMeshes,
  createSolidModeMeshesForSingleModel,
  runSolidModeComparison,
} from './elementRedrawSolid.js';
import { drawLineModeElements, drawPolyModeElements } from './elementRedrawLineMode.js';

// ロガー
const log = createLogger('elementRedrawer');

export { createLabelsForSolidElementsWithSource } from './elementRedrawLabels.js';

// ============================================================================
// メイン再描画オーケストレーター
// ============================================================================

/**
 * 共通: 要素の再描画処理
 * @param {Object} config - 設定オブジェクト（STBメタデータ）
 * @param {string} config.elementType - 要素タイプ（"Column", "Beam"等）
 * @param {string} config.stbTagName - STBタグ名（"StbColumn", "StbGirder"等）
 * @param {string} config.nodeStartAttr - 始点ノード属性名
 * @param {string} config.nodeEndAttr - 終点ノード属性名
 * @param {string} config.elementsKey - stbDataのキー名（"columnElements"等）
 * @param {string} config.sectionsKey - stbDataのキー名（"columnSections"等）
 * @param {Function} scheduleRender - 再描画要求関数
 * @param {boolean} updateLabelsAfter - 再描画後にラベル更新を実行するか（デフォルト: true）
 * @param {boolean} applyColorMode - ソリッド描画後にカラーモードを適用するか（デフォルト: true）
 * @private
 */
export function redrawElementForViewMode(
  config,
  scheduleRender,
  updateLabelsAfter = true,
  applyColorMode = true,
) {
  const { elementType, sectionsKey, nodeEndAttr } = config;

  // ジェネレータをviewer層から動的解決（クラスの静的メソッドを使用）
  const generatorInfo = geometryGeneratorFactory.getGeneratorInfo(elementType);

  if (!generatorInfo) {
    log.warn(`Cannot create meshes for ${elementType}: generator not found`);
    if (scheduleRender) scheduleRender();
    return;
  }

  // モデルコンテキストを取得
  const modelContext = getModelContext();
  const { modelADocument, modelBDocument } = modelContext;

  // 必要なデータが揃っているかチェック
  if (!modelADocument && !modelBDocument) return;

  const group = elementGroups[elementType];

  // 既存のラベルを削除
  eventBus.emit(LabelEvents.REMOVE_BY_TYPE, elementType);
  // モデルBオーバーレイは専用ジオメトリと clone マテリアル（共有プール外）を
  // 持つため、group.clear() で捨てる前に明示的に dispose してリークを防ぐ。
  // 通常メッシュのマテリアルは共有キャッシュ由来なのでここでは dispose しない。
  group.children.forEach((obj) => {
    if (!obj.userData || !obj.userData.isOverlayModelB) return;
    if (obj.geometry && obj.geometry.dispose) obj.geometry.dispose();
    const mat = obj.material;
    if (Array.isArray(mat)) {
      mat.forEach((m) => m && m.dispose && m.dispose());
    } else if (mat && mat.dispose) {
      mat.dispose();
    }
  });
  group.clear();

  const viewMode = displayModeManager.getDisplayMode(elementType);
  log.debug(`[redraw${elementType}ForViewMode] mode: ${viewMode}`);

  if (viewMode === 'solid') {
    // 立体表示（ProfileBased方式）- 差分表示対応
    // saveToGlobalState: true でパース結果をglobalStateに保存し、IFC変換で再利用
    const stbDataA = modelADocument
      ? parseStbFile(modelADocument, { modelKey: 'A', saveToGlobalState: true })
      : null;
    const stbDataB = modelBDocument
      ? parseStbFile(modelBDocument, { modelKey: 'B', saveToGlobalState: true })
      : null;

    if (stbDataA && stbDataB) {
      // 両方のモデルがある場合: 比較を実行し、カテゴリ別にメッシュ・ラベルを生成
      const comparisonResult = runSolidModeComparison(config, stbDataA, stbDataB, elementType);
      createSolidModeMeshes(
        comparisonResult,
        stbDataA,
        stbDataB,
        group,
        generatorInfo,
        elementType,
        sectionsKey,
      );
      createSolidModeLabels(comparisonResult, stbDataA, stbDataB, group, elementType);
    } else {
      // 片方のモデルのみの場合（従来の処理）
      const stbData = stbDataA || stbDataB;
      const modelSource = stbDataA ? 'A' : 'B';
      if (stbData) {
        createSolidModeMeshesForSingleModel(
          stbData,
          modelSource,
          group,
          generatorInfo,
          config,
          elementType,
          sectionsKey,
        );
      }
    }

    if (applyColorMode) {
      import('../../colorModes/index.js')
        .then(({ updateElementsForColorMode }) => {
          updateElementsForColorMode();
        })
        .catch((err) => {
          log.error('Failed to update colors for solid mode:', err);
        });
    }
  } else {
    // 線表示 / パネル表示
    if (isWallElementType(elementType) || elementType === 'Slab') {
      drawPolyModeElements(config, modelContext, group);
    } else if (nodeEndAttr === null) {
      // 1ノード要素（基礎など）は線表示をサポートしない。
      // group.clear() 済みなので、空グループへの変更もgeometry batch完了として通知する。
      log.debug(
        `[redraw${elementType}ForViewMode] line mode not supported for single-node elements`,
      );
      finalizeRenderableBatch({ elementType, group });
      if (scheduleRender) scheduleRender();
      return;
    } else {
      drawLineModeElements(config, modelContext, group);
    }
  }

  // Mesh追加ごとではなく、要素groupの再生成が完了した時点で1回だけ
  // clipping policy適用 + GeometryChanged通知を行う。
  finalizeRenderableBatch({ elementType, group });

  // ラベルの表示/非表示を更新
  if (updateLabelsAfter) {
    setTimeout(() => {
      eventBus.emit(LabelEvents.UPDATE_VISIBILITY);
      if (scheduleRender) scheduleRender();
    }, UI_TIMING.VIEW_MODE_UPDATE_DELAY_MS);
  }
}
