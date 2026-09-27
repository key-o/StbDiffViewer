/**
 * @fileoverview モデルロード・管理モジュール
 *
 * このファイルは、STBモデルのロードと管理に関する機能を提供します:
 * - STBファイルの選択とロード
 * - モデルAとモデルBの読み込みと管理
 * - ファイルの解析とパース処理
 * - モデル比較の実行と結果の管理
 * - 3Dビューへのモデル適用
 * - ビュー状態の調整
 *
 * このモジュールは、ファイル選択からモデル表示までの一連の流れを
 * 制御し、他のモジュールと連携してモデルデータを適切に扱います。
 */

import * as THREE from 'three';
import { createLogger } from '../../utils/logger.js';
import {
  clearSceneContent,
  createOrUpdateGridHelper,
  elementGroups,
  clearClippingPlanes,
  clearParseCache,
  parseStbFile,
  scene,
} from '../../viewer/index.js';
import { UI_TIMING } from '../../config/uiTimingConfig.js';
import { resetSelection } from './interactionController.js';
import { setState, getState, resetApplicationState } from '../../data/state/globalState.js';
import { eventBus, SettingsEvents } from '../../data/events/index.js';
import { scheduleRender } from '../../utils/renderScheduler.js';
import {
  EventTypes,
  ModelEvents,
  RenderEvents,
  ComparisonEvents,
  AppEvents,
  ToastEvents,
  LoadingIndicatorEvents,
} from '../../constants/eventTypes.js';
import comparisonKeyManager from '../comparisonKeyManager.js';
import {
  calculateLinearMemberQuantities,
  summarizeQuantityStore,
} from '../../quantities/QuantityService.js';
import { buildQuantityFacts } from '../../quantities/analytics/QuantityFactBuilder.js';

const log = createLogger('ModelLoader');

function schedulePostLoadTask(task) {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(task, { timeout: 200 });
  } else {
    setTimeout(task, 0);
  }
}

function buildQuantityFactsSafely(parsedData, store, { modelSide, document }) {
  if (!parsedData || !store) return null;
  try {
    return buildQuantityFacts(parsedData, store, { modelSide, document });
  } catch (error) {
    log.warn(`モデル${modelSide}の数量分析fact構築に失敗しました。個別数量は保持します。`, error);
    return null;
  }
}

// Refactored modules
import {
  validateAndGetFiles,
  getSelectedElementTypes,
  setLoadingState,
  validateComparisonParameters,
} from '../../modelLoader/fileValidation.js';
import {
  processModelDocuments,
  clearModelProcessingState,
} from '../../modelLoader/modelProcessing.js';
import {
  processElementComparison,
  calculateElementBounds,
} from '../../modelLoader/elementComparison.js';
import {
  orchestrateElementRendering,
  calculateRenderingBounds,
  getRenderingStatistics,
} from '../../modelLoader/renderingOrchestrator.js';
import {
  orchestrateProgressiveRendering,
  isProgressiveRenderingEnabled,
  onLoadingStart,
  onLoadingComplete,
  onLoadingError,
} from '../../modelLoader/progressiveRendering.js';
import {
  finalizeVisualization,
  handleFinalizationError,
} from '../../modelLoader/visualizationFinalizer.js';
import { syncDisplayModeFromUI } from '../viewModes/index.js';
import { convertToAdapterFormat } from './modelLoaderAdapterFormat.js';
import { updateObjectMaterialAsync } from './modelLoaderMaterialUpdate.js';

// モデル状態管理
let stories = [];
let nodeMapA = new Map();
let nodeMapB = new Map();
let nodeLabels = [];
let modelBounds = new THREE.Box3();
let axesData = { xAxes: [], yAxes: [] };
let modelADocument = null;
let modelBDocument = null;
let modelsLoaded = false;
let sectionMaps = null; // 断面データ
let modelStateGeneration = 0;
let comparisonInProgress = false;

// 比較キータイプ変更時に自動再比較を実行
comparisonKeyManager.onChange(async (newKeyType, oldKeyType) => {
  if (!modelsLoaded) return;
  log.info(`比較キータイプが変更されました (${oldKeyType} → ${newKeyType})、再比較を実行します`);
  try {
    if (typeof window.handleCompareModelsClick === 'function') {
      await window.handleCompareModelsClick();
    }
  } catch (error) {
    log.error('キータイプ変更後の再比較に失敗:', error);
  }
});

// 断面一致基準変更時に自動再比較を実行
comparisonKeyManager.onSectionCriterionChange(async (newCriterion, oldCriterion) => {
  if (!modelsLoaded) return;
  log.info(`断面一致基準が変更されました (${oldCriterion} → ${newCriterion})、再比較を実行します`);
  try {
    if (typeof window.handleCompareModelsClick === 'function') {
      await window.handleCompareModelsClick();
    }
  } catch (error) {
    log.error('断面一致基準変更後の再比較に失敗:', error);
  }
});

// 通り芯・階の判定基準変更時に自動再比較を実行
comparisonKeyManager.onStoryAxisCriterionChange(async (newCriterion, oldCriterion) => {
  if (!modelsLoaded) return;
  log.info(
    `通り芯・階の判定基準が変更されました (${oldCriterion} → ${newCriterion})、再比較を実行します`,
  );
  try {
    if (typeof window.handleCompareModelsClick === 'function') {
      await window.handleCompareModelsClick();
    }
  } catch (error) {
    log.error('通り芯・階の判定基準変更後の再比較に失敗:', error);
  }
});

// 異ソフト間の階名正準化設定変更時に自動再比較を実行
comparisonKeyManager.onCrossSoftwareModeChange(async (enabled) => {
  if (!modelsLoaded) return;
  log.info(`異ソフト間の階名正準化を${enabled ? '有効化' : '無効化'}、再比較を実行します`);
  try {
    if (typeof window.handleCompareModelsClick === 'function') {
      await window.handleCompareModelsClick();
    }
  } catch (error) {
    log.error('階名正準化設定変更後の再比較に失敗:', error);
  }
});

// 許容差変更時に自動再比較を実行（eventBus経由）。
// 断面の対応付け基準は onSectionCriterionChange で購読する。
const RECOMPARE_SETTING_TYPES = new Set(['tolerance']);
eventBus.on(SettingsEvents.CHANGED, async (payload = {}) => {
  const { type, config: newConfig } = /** @type {{type?: string, config?: any}} */ (payload);
  if (!RECOMPARE_SETTING_TYPES.has(type)) return;
  if (!modelsLoaded) return;
  log.info(`比較設定（${type}）が変更されました、再比較を実行します`, newConfig);
  try {
    if (typeof window.handleCompareModelsClick === 'function') {
      await window.handleCompareModelsClick();
    }
  } catch (error) {
    log.error('許容差設定変更後の再比較に失敗:', error);
  }
});

/**
 * モデルデータへの参照を取得
 * @returns {Object} モデルデータオブジェクト
 */
export function getModelData() {
  return {
    stories,
    nodeMapA,
    nodeMapB,
    nodeLabels,
    modelBounds,
    axesData,
    modelADocument,
    modelBDocument,
    modelsLoaded,
    sectionMaps,
  };
}

/**
 * モデルのロード状態を取得
 * @returns {boolean} モデルがロードされているかのフラグ
 */
export function isModelLoaded() {
  return modelsLoaded;
}

function clearAdapterContent(adapter) {
  if (typeof adapter?.loadComparisonResult !== 'function') return;

  // アダプターで実際に利用している公開APIへ空の比較結果を渡し、
  // 未確認のclear系APIを仮定せず既存オブジェクトを破棄する。
  adapter.loadComparisonResult(convertToAdapterFormat(new Map(), new Map(), new Map(), null));
}

/**
 * モデルに依存するシーン・状態・UI・キャッシュを一括して破棄する。
 * compareModels の再読込前と、最後のモデルを解除した時の両方で使用する。
 * @param {Function} [requestRender] - 再描画要求関数
 * @returns {number} クリア後のモデル状態世代
 */
export function clearLoadedModels(requestRender) {
  log.info('全状態を初期化しています...');
  const generation = ++modelStateGeneration;

  const adapter = getState('viewer.adapter');
  try {
    clearAdapterContent(adapter);
  } catch (error) {
    // adapter固有の破棄失敗で、標準シーンやアプリ状態のクリアを中断しない。
    log.warn('common viewer adapterのモデル解除に失敗しました:', error);
  }

  modelBounds = clearSceneContent(elementGroups, nodeLabels);
  setState('models.modelBounds', modelBounds);

  stories.length = 0;
  nodeMapA.clear();
  nodeMapB.clear();
  axesData = { xAxes: [], yAxes: [] };
  nodeLabels = [];
  modelADocument = null;
  modelBDocument = null;
  sectionMaps = null;
  modelsLoaded = false;

  clearModelProcessingState();
  resetApplicationState();
  setState('elementGroups', elementGroups);

  eventBus.emit(ModelEvents.CLEARED);
  eventBus.emit(AppEvents.CLEAR_UI_STATE);
  resetSelection();
  eventBus.emit(AppEvents.CLEAR_TREE);
  eventBus.emit(AppEvents.CLEAR_SECTION_TREE);
  clearParseCache();
  clearClippingPlanes();
  createOrUpdateGridHelper(modelBounds);

  const render = requestRender || scheduleRender;
  if (typeof render === 'function') render();
  log.info('全状態の初期化が完了しました');
  return generation;
}

/**
 * モデルを読み込み比較する（リファクタリング版）
 * @param {Function} scheduleRender - 再描画要求関数
 * @param {Object} options - カメラとコントロールの参照
 * @returns {Promise<boolean>} 処理結果
 */
export async function compareModels(scheduleRender, { camera, controls } = {}) {
  // Phase 1: Validation and Input Processing
  const fileValidation = validateAndGetFiles();
  if (!fileValidation.isValid) {
    return false;
  }

  const { fileA, fileB } = fileValidation;
  const selectedElementTypes = getSelectedElementTypes();

  // Validate comparison parameters
  const paramValidation = validateComparisonParameters({
    fileA,
    fileB,
    selectedElementTypes,
    scheduleRender,
    cameraControls: { camera, controls },
  });

  if (!paramValidation.isValid) {
    log.error('パラメータ検証に失敗:', paramValidation.errors);
    eventBus.emit(ToastEvents.SHOW_ERROR, {
      message: 'パラメータ検証に失敗しました: ' + paramValidation.errors.join(', '),
    });
    return false;
  }

  // 比較・再読込はシーンとglobalStateを一括更新するため、同時実行させない。
  // 解除中の中央読込や設定変更イベントなど、ボタン以外の入口からの競合もここで防ぐ。
  if (comparisonInProgress) {
    log.warn('モデルの読込/比較処理が進行中のため、重複実行をスキップしました');
    return false;
  }
  // === Phase 0: Comprehensive State Reset ===
  const loadGeneration = clearLoadedModels(scheduleRender);
  comparisonInProgress = true;
  setLoadingState(true);

  try {
    onLoadingStart();

    // 元のSTBファイルをグローバル状態に再保存（リセット後に行う）
    // IFC変換やSTBバージョン変換で使用するため
    if (fileA) {
      setState('files.originalFileA', fileA);
    }
    if (fileB) {
      setState('files.originalFileB', fileB);
    }

    // Phase 2: Model Document Processing (throws on failure)
    const processingResult = await processModelDocuments(fileA, fileB);

    // Update local state with processed data
    ({ modelADocument, modelBDocument, nodeMapA, nodeMapB, stories, axesData, sectionMaps } =
      processingResult);

    const { versionInfo, calDataA, calDataB } = processingResult;

    // Save all model data to global state
    setState('models.documentA', modelADocument);
    setState('models.documentB', modelBDocument);
    setState('models.nodeMapA', nodeMapA);
    setState('models.nodeMapB', nodeMapB);
    setState('models.stories', stories);
    setState('models.axesData', axesData);
    setState('models.sectionMaps', sectionMaps);
    setState('sectionsData', sectionMaps);
    setState('models.versionInfo', versionInfo);
    setState('models.calDataA', calDataA);
    setState('models.calDataB', calDataB);
    setState('models.stbVersionA', versionInfo.versionA);
    setState('models.stbVersionB', versionInfo.versionB);

    // アクティブXSDバージョンを決定（新しいバージョンを優先）
    // 利用可能なスキーマ: 2.0.2, 2.1.0, 2.1.1
    // 2.0.x → 2.0.2, 2.1.0 → 2.1.0, 2.1.1+ → 2.1.1
    const resolveSchemaVersion = (v) => {
      if (!v) return null;
      if (v.startsWith('2.1')) return v === '2.1.0' ? '2.1.0' : '2.1.1';
      if (v.startsWith('2.0')) return '2.0.2';
      return null;
    };
    const candidates = [versionInfo.versionA, versionInfo.versionB]
      .map(resolveSchemaVersion)
      .filter(Boolean);
    const activeXsdVersion = candidates.sort().pop() || '2.0.2';
    setState('models.activeXsdVersion', activeXsdVersion);

    // XSDスキーマをアクティブバージョンに切り替え
    try {
      const [
        { setActiveVersion: setJsonSchemaVersion },
        { setActiveVersion: setXsdSchemaVersion },
        { getImportanceManager },
      ] = await Promise.all([
        import('../../common-stb/import/parser/jsonSchemaLoader.js'),
        import('../../common-stb/import/parser/xsdSchemaParser.js'),
        import('../importanceManager.js'),
      ]);
      setJsonSchemaVersion(activeXsdVersion);
      setXsdSchemaVersion(activeXsdVersion);

      const importanceManager = getImportanceManager();
      await importanceManager.initialize(null, { reset: true });

      log.info(`アクティブスキーマバージョンを ${activeXsdVersion} に設定しました`);
    } catch (error) {
      log.warn('スキーマバージョン切り替えに失敗しました:', error);
    }

    // Emit model loaded events for version comparison panel
    if (fileA) {
      eventBus.emit(ModelEvents.LOADED, {
        model: {
          fileName: fileA.name,
          version: versionInfo.versionA,
          document: modelADocument,
          nodeMap: nodeMapA,
        },
        slot: 'A',
        timestamp: new Date().toISOString(),
      });
    }

    if (fileB) {
      eventBus.emit(ModelEvents.LOADED, {
        model: {
          fileName: fileB.name,
          version: versionInfo.versionB,
          document: modelBDocument,
          nodeMap: nodeMapB,
        },
        slot: 'B',
        timestamp: new Date().toISOString(),
      });
    }

    // Phase 3: Element Comparison
    // comparisonKeyManager が単一の真実源 — UI側で既に同期済み
    const comparisonKeyType = comparisonKeyManager.getKeyType();
    log.info(`[Debug] 比較キータイプ: ${comparisonKeyType}`);

    const comparisonOptions = {
      useImportanceFiltering: true,
      targetImportanceLevels: null, // null = all levels
      comparisonKeyType: comparisonKeyType, // 比較キータイプを追加
      sectionMatchCriterion: comparisonKeyManager.getSectionMatchCriterion(), // 断面一致基準
      storyAxisMatchCriterion: comparisonKeyManager.getStoryAxisMatchCriterion(), // 通り芯・階の判定基準
    };
    const comparisonResult = processElementComparison(
      processingResult,
      selectedElementTypes,
      comparisonOptions,
    );
    const { comparisonResults } = comparisonResult;

    let totalMatched = 0;
    for (const [elementType, result] of comparisonResults.entries()) {
      const matchedCount = result.matched?.length || 0;
      totalMatched += matchedCount;
      if (matchedCount > 0) {
        log.info(`[Debug] matched>0: ${elementType}=${matchedCount}`);
      }
    }
    log.info(`[Debug] 合計matched件数: ${totalMatched}`);

    // 比較結果をグローバル状態に保存
    setState('comparisonResults', comparisonResults);

    // 比較完了イベントをEventBusで発行（バージョン情報を含む）
    eventBus.emit(EventTypes.Comparison.COMPLETED, {
      comparisonResults,
      versionInfo,
      timestamp: new Date().toISOString(),
    });

    // Calculate model bounds
    modelBounds = calculateElementBounds(comparisonResults, nodeMapA, nodeMapB);

    // Phase 4: 3D Rendering（段階的レンダリング対応）
    // globalDataにnodeMapA/nodeMapBを含めてAdapter層で利用可能にする
    const globalRenderData = { stories, axesData, nodeMapA, nodeMapB };

    let renderingResult;

    // common/viewerモードの場合はアダプター経由でレンダリング
    const useCommonViewer = getState('viewer.useCommonViewer');
    const adapter = getState('viewer.adapter');

    if (useCommonViewer && adapter) {
      log.info('common/viewerモードでレンダリングを実行します...');

      // アダプター用の比較結果形式に変換
      const adapterComparisonResult = convertToAdapterFormat(
        comparisonResults,
        nodeMapA,
        nodeMapB,
        sectionMaps,
      );

      // アダプター経由でレンダリング
      adapter.loadComparisonResult(adapterComparisonResult);

      // モデルバウンドを計算（通り芯・階描画用）
      const adapterModelBounds = new THREE.Box3();
      for (const node of nodeMapA.values()) {
        adapterModelBounds.expandByPoint(new THREE.Vector3(node.x, node.y, node.z));
      }
      for (const node of nodeMapB.values()) {
        adapterModelBounds.expandByPoint(new THREE.Vector3(node.x, node.y, node.z));
      }

      // 通り芯を描画
      if (axesData && (axesData.xAxes.length > 0 || axesData.yAxes.length > 0)) {
        try {
          adapter.drawAxes(axesData, adapterModelBounds, { stories });
          log.info(
            `common/viewerモード: 通り芯を描画 X=${axesData.xAxes.length}, Y=${axesData.yAxes.length}`,
          );
        } catch (error) {
          log.error('通り芯描画エラー:', error);
        }
      }

      // 階を描画
      if (stories && stories.length > 0) {
        try {
          adapter.drawStories(stories, adapterModelBounds);
          log.info(`common/viewerモード: ${stories.length}階を描画`);
        } catch (error) {
          log.error('階描画エラー:', error);
        }
      }

      // レンダリング結果を構築（後続処理との互換性のため）
      renderingResult = {
        nodeLabels: [],
        renderedElements: {
          matched: [],
          onlyA: [],
          onlyB: [],
        },
        stats: {
          totalRendered: adapter.sceneManager?.getObjectCount() || 0,
        },
      };

      log.info(
        `common/viewerモード: ${renderingResult.stats.totalRendered}オブジェクトをレンダリング`,
      );
    } else {
      // オーケストレーション前にUIチェックボックスの状態をdisplayModeManagerに同期
      // これにより、オーケストレーターがsolidモード要素の線分描画をスキップできる
      syncDisplayModeFromUI();

      if (isProgressiveRenderingEnabled()) {
        renderingResult = await orchestrateProgressiveRendering(
          comparisonResults,
          modelBounds,
          globalRenderData,
          scheduleRender,
        );
      } else {
        renderingResult = orchestrateElementRendering(
          comparisonResults,
          modelBounds,
          globalRenderData,
        );
      }
    }

    // Update node labels
    nodeLabels = renderingResult.nodeLabels;

    // Recalculate bounds after rendering
    modelBounds = calculateRenderingBounds(renderingResult.renderedElements, nodeMapA, nodeMapB);
    setState('models.modelBounds', modelBounds);

    // 初回表示モード適用で必要になる解析結果を先に温めて、99%フェーズのブロッキングを減らす。
    const prewarmStart = performance.now();
    const stbDataA = modelADocument
      ? parseStbFile(modelADocument, { modelKey: 'A', saveToGlobalState: true })
      : null;
    const stbDataB = modelBDocument
      ? parseStbFile(modelBDocument, { modelKey: 'B', saveToGlobalState: true })
      : null;
    log.info(
      `[compareModels] parseStbFile pre-warm: ${(performance.now() - prewarmStart).toFixed(0)}ms`,
    );

    // STB属性/DOMとは分離した派生数量をA/Bそれぞれ独立storeへ構築する。
    // 数量計算の失敗でモデル読込自体を中断しない（結果statusでfail-closedに保持）。
    try {
      const quantityStart = performance.now();
      const derivedQuantitiesA = stbDataA
        ? calculateLinearMemberQuantities(stbDataA, { modelSide: 'A', document: modelADocument })
        : null;
      const derivedQuantitiesB = stbDataB
        ? calculateLinearMemberQuantities(stbDataB, { modelSide: 'B', document: modelBDocument })
        : null;
      setState('models.derivedQuantitiesA', derivedQuantitiesA);
      setState('models.derivedQuantitiesB', derivedQuantitiesB);

      // Analytics用QuantityFactはDerivedQuantityStoreから派生する二次キャッシュ。
      // Fact構築失敗でElementInfoの個別数量まで失わないよう、A/Bごとに独立してfail-closedとする。
      const quantityFactsA = buildQuantityFactsSafely(stbDataA, derivedQuantitiesA, {
        modelSide: 'A',
        document: modelADocument,
      });
      const quantityFactsB = buildQuantityFactsSafely(stbDataB, derivedQuantitiesB, {
        modelSide: 'B',
        document: modelBDocument,
      });
      setState('models.quantityFactsA', quantityFactsA);
      setState('models.quantityFactsB', quantityFactsB);
      log.info(
        `[compareModels] derived quantities: ${(performance.now() - quantityStart).toFixed(0)}ms`,
        {
          A: derivedQuantitiesA ? summarizeQuantityStore(derivedQuantitiesA) : null,
          B: derivedQuantitiesB ? summarizeQuantityStore(derivedQuantitiesB) : null,
          factsA: quantityFactsA?.length ?? 0,
          factsB: quantityFactsB?.length ?? 0,
        },
      );
    } catch (error) {
      setState('models.derivedQuantitiesA', null);
      setState('models.derivedQuantitiesB', null);
      setState('models.quantityFactsA', null);
      setState('models.quantityFactsB', null);
      log.warn('派生数量の構築に失敗しました。モデル表示は継続します。', error);
    }

    // Phase 5: Visualization Finalization
    eventBus.emit(LoadingIndicatorEvents.UPDATE, {
      progress: 99,
      message: '表示モードを適用中...',
      detail: '最終描画を準備しています',
    });

    const finalizationData = {
      nodeLabels,
      stories,
      axesData,
      modelBounds,
      renderingStats: getRenderingStatistics(renderingResult),
      modelADocument,
      modelBDocument,
      nodeMapA,
      nodeMapB,
    };

    await finalizeVisualization(finalizationData, scheduleRender, {
      camera,
      controls,
    });

    // Clear clipping planes
    clearClippingPlanes();

    // Mark models as loaded
    modelsLoaded = true;
    // モデル読み込み完了を通知（ARボタン等の活性状態が追従する）
    eventBus.emit(RenderEvents.MODEL_LOADED, {
      hasModelA: !!modelADocument,
      hasModelB: !!modelBDocument,
    });
    onLoadingComplete();

    schedulePostLoadTask(() => {
      if (loadGeneration !== modelStateGeneration) return;
      // 要素情報用違反は即時実行せず、メイン描画完了後のアイドル時に実行
      // UI層に直接依存せずEventBus経由で通知（R1ルール遵守）
      eventBus.emit(AppEvents.POST_LOAD_VALIDATION, {
        documentA: modelADocument,
        documentB: modelBDocument,
      });
    });

    // Apply appropriate color mode based on loaded models
    setTimeout(() => {
      if (loadGeneration !== modelStateGeneration) return;
      import('../../colorModes/index.js').then(({ applyDefaultColorModeAfterLoad }) => {
        if (loadGeneration !== modelStateGeneration) return;
        const hasBothModels = !!modelADocument && !!modelBDocument;
        const hasSingleModel = (!!modelADocument || !!modelBDocument) && !hasBothModels;
        applyDefaultColorModeAfterLoad(hasBothModels, hasSingleModel, reapplyColorMode);
      });
    }, UI_TIMING.COLOR_MODE_APPLY_DELAY_MS);

    schedulePostLoadTask(() => {
      if (loadGeneration !== modelStateGeneration) return;
      // 差分フィルタパネル等の統計更新イベントをアイドル時に発行
      eventBus.emit(ComparisonEvents.UPDATE_STATISTICS, {
        comparisonResults: comparisonResults,
        reason: 'modelComparison',
        // 両モデルが揃っているときだけ差分サマリーを自動表示する（単一モデルは比較情報を持たない）
        hasBothModels: !!modelADocument && !!modelBDocument,
        timestamp: new Date().toISOString(),
      });
    });

    return true;
  } catch (error) {
    log.error('モデル比較に失敗:', error);
    onLoadingError(error.message || '不明なエラー');
    eventBus.emit(ToastEvents.SHOW_ERROR, {
      message: `エラーが発生しました: ${error.message || '不明なエラー'}`,
    });

    // Error cleanup
    handleFinalizationError(error);

    // Reset state safely
    try {
      modelBounds = clearSceneContent(elementGroups, nodeLabels || []);
      setState('models.modelBounds', modelBounds);
      stories.length = 0;
      nodeMapA.clear();
      nodeMapB.clear();
      axesData = { xAxes: [], yAxes: [] };
      nodeLabels = [];
      createOrUpdateGridHelper(modelBounds);
      clearModelProcessingState();
      modelsLoaded = false;
      // シーンをクリアしたため、モデルクリアを通知（ARボタン等の活性状態が追従する）
      eventBus.emit(ModelEvents.CLEARED);
    } catch (cleanupError) {
      log.error('状態クリーンアップ中のエラー:', cleanupError);
    }

    return false;
  } finally {
    comparisonInProgress = false;
    setLoadingState(false);
  }
}

/**
 * 色付けモード変更時に全要素に新しい色付けを適用する
 */
export function reapplyColorMode() {
  if (!modelsLoaded) {
    log.warn('[ModelLoader] No models loaded, color mode will be applied when models are loaded');
    return;
  }

  try {
    import('../../colorModes/index.js').then(() => {
      // 現在のシーンの全オブジェクトに新しいマテリアルを適用
      // グローバル状態のシーンを優先し、なければ直接インポートしたシーンを使用
      const currentScene = getState('rendering.scene') || scene;
      if (!currentScene) {
        log.warn('シーンが利用できません');
        return;
      }

      // 全ての要素を収集（Mesh/Line要素のみ、Spriteは除外）
      const objectsToUpdate = [];
      currentScene.traverse((object) => {
        if ((object.isMesh || object.isLine) && object.userData && object.userData.elementType) {
          objectsToUpdate.push(object);
        }
      });

      // マテリアルを非同期で更新
      Promise.all(objectsToUpdate.map((object) => updateObjectMaterialAsync(object))).then(() => {
        // 全ての更新が完了したら再描画をリクエスト
        scheduleRender();
      });
    });
  } catch (error) {
    log.error('カラーモード再適用中のエラー:', error);
  }
}
