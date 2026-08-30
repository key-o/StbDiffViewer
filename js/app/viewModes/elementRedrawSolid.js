/**
 * @fileoverview ソリッドモード（立体表示）の再描画処理
 *
 * 比較実行・メッシュ生成・ラベル生成を担当します。
 *
 * @module app/viewModes/elementRedrawSolid
 */

import { createLogger } from '../../utils/logger.js';
import { getModelContext } from './modelContext.js';
import { labelDisplayManager } from '../../viewer/index.js';
import { eventBus, LabelEvents } from '../../data/events/index.js';
import {
  compareElements,
  compareElementsWithTolerance,
} from '../../common-stb/comparison/index.js';
import {
  getPlacementModeForKeyType,
  COMPARISON_KEY_TYPE,
} from '../../config/comparisonKeyConfig.js';
import { getToleranceConfig } from '../../config/toleranceConfig.js';
import comparisonKeyManager from '../comparisonKeyManager.js';
import {
  normalizeComparisonResult,
  getCategoryCounts,
} from '../../data/normalizeComparisonResult.js';
import { COMPARISON_CATEGORY } from '../../constants/comparisonCategories.js';
import { styleClonedAsModelBOverlay } from '../../constants/overlayStyle.js';
import { getState } from '../../data/state/globalState.js';
import {
  buildSectionKeyResolver,
  createLineKeyExtractor,
  createPolyKeyExtractor,
  createRenderAttributeComparator,
  getFilteredStbElements,
  getOpeningElementsForType,
  isWallElementType,
} from './elementRedrawHelpers.js';
import { createLabelsForSolidElementsWithSource } from './elementRedrawLabels.js';

// ロガー
const log = createLogger('elementRedrawer');

/*
 * ソリッドモードの比較結果を元にメッシュを生成しグループに追加する
 * @param {Object} comparisonResult - 正規化済み比較結果
 * @param {Object} stbDataA - モデルAのパース済みデータ
 * @param {Object} stbDataB - モデルBのパース済みデータ
 * @param {THREE.Group} group - 追加先のグループ
 * @param {Object} generatorInfo - ジェネレータ情報 { class, method }
 * @param {string} elementType - 要素タイプ
 * @param {string} elementsKey - stbDataのキー名
 * @param {string} sectionsKey - stbDataのキー名
 * @private
 */
export function createSolidModeMeshes(
  comparisonResult,
  stbDataA,
  stbDataB,
  group,
  generatorInfo,
  elementType,
  sectionsKey,
) {
  const generator = generatorInfo.class;
  const generatorMethod = generatorInfo.method;
  const openingElementsA = getOpeningElementsForType(elementType, stbDataA);
  const openingElementsB = getOpeningElementsForType(elementType, stbDataB);
  // 断面が異なる一致要素でモデルB形状を半透明オーバーレイ表示するか
  const overlayModelB = getState('viewModes.showMatchedModelBOverlay') === true;

  /**
   * 指定カテゴリのマッチ済みアイテムからメッシュを生成してグループに追加する
   * @param {string} category - COMPARISON_CATEGORY の値
   * @param {string} attributeState - 'matched' または 'mismatch'
   */
  function addMatchedMeshes(category, attributeState) {
    const items = comparisonResult[category] || [];
    if (items.length === 0) return;
    const elements = items.map((m) => m.dataA.element);
    const meshes = generator[generatorMethod](
      elements,
      stbDataA.nodes,
      stbDataA[sectionsKey],
      stbDataA.steelSections,
      elementType,
      false,
      openingElementsA,
    );
    const pairMeta = new Map(items.map((pair) => [pair.dataA.element.id, pair]));
    meshes.forEach((mesh) => {
      const elementIdA = mesh.userData.elementId;
      const pair = pairMeta.get(elementIdA);
      mesh.userData.modelSource = 'matched';
      mesh.userData.category = category;
      mesh.userData.positionState = pair?.positionState || 'exact';
      mesh.userData.attributeState = pair?.attributeState || attributeState;
      mesh.userData.diffStatus = pair?.diffStatus || undefined;
      mesh.userData.attributeMismatchKind = pair?.attributeMismatchKind || undefined;
      const elementIdB = pair?.dataB?.element?.id;
      if (elementIdB) {
        mesh.userData.elementIdA = elementIdA;
        mesh.userData.elementIdB = elementIdB;
      }
      group.add(mesh);
    });

    // 形状が異なる一致要素については、モデルB側の形状を半透明で重ねて表示する。
    // B側は必ず stbDataB 系（nodes/sections/steelSections）を使うこと。
    // stbDataA を使うと断面取り違えで誤形状になる。
    if (overlayModelB && category === COMPARISON_CATEGORY.ATTRIBUTE_MISMATCH) {
      addModelBOverlayMeshes(
        items.filter((item) => isTypeAttributeMismatch(item)),
        category,
      );
    }
  }

  function isTypeAttributeMismatch(item) {
    return (
      item?.attributeMismatchKind === 'type' ||
      item?.attributeMismatchKind === 'both' ||
      item?.diffStatus === 'attributeMismatchType' ||
      item?.diffStatus === 'attributeMismatchBoth'
    );
  }

  /**
   * 一致ペアのモデルB側形状を半透明メッシュとして生成し追加する
   * @param {Array} items - matchedペア配列（各要素は {dataA, dataB, ...}）
   * @param {string} category - COMPARISON_CATEGORY の値
   */
  function addModelBOverlayMeshes(items, category) {
    const elementsB = items.map((m) => m.dataB?.element).filter(Boolean);
    if (elementsB.length === 0) return;
    const meshesB = generator[generatorMethod](
      elementsB,
      stbDataB.nodes,
      stbDataB[sectionsKey],
      stbDataB.steelSections,
      elementType,
      false,
      openingElementsB,
    );
    const pairMetaByB = new Map(
      items.filter((p) => p.dataB?.element).map((pair) => [pair.dataB.element.id, pair]),
    );
    meshesB.forEach((mesh) => {
      const elementIdB = mesh.userData.elementId;
      const pair = pairMetaByB.get(elementIdB);
      mesh.userData.modelSource = 'matched';
      mesh.userData.category = category;
      mesh.userData.positionState = pair?.positionState || 'exact';
      mesh.userData.attributeState = pair?.attributeState || 'mismatch';
      mesh.userData.diffStatus = pair?.diffStatus || undefined;
      mesh.userData.attributeMismatchKind = pair?.attributeMismatchKind || undefined;
      mesh.userData.isOverlayModelB = true;
      mesh.userData.elementIdA = pair?.dataA?.element?.id;
      mesh.userData.elementIdB = elementIdB;
      // 装飾用オーバーレイはピック対象外にする。これによりクリックは背後の
      // 実要素メッシュに透過し、選択・情報パネルは実要素に対して行われる。
      mesh.raycast = () => {};
      // 共有マテリアルを壊さないよう clone してから半透明化
      if (mesh.material) {
        mesh.material = styleClonedAsModelBOverlay(
          Array.isArray(mesh.material)
            ? mesh.material.map((m) => m.clone())
            : mesh.material.clone(),
        );
      }
      group.add(mesh);
    });
  }

  /**
   * 片方モデルのみの要素からメッシュを生成してグループに追加する
   * @param {'A'|'B'} modelSource - モデルの識別子
   * @param {Object} stbData - 対応するモデルのパース済みデータ
   * @param {Array|null} openingElements - 開口要素（Wall用）
   */
  function addOnlyModelMeshes(modelSource, stbData, openingElements) {
    const onlyItems = comparisonResult[`only${modelSource}`];
    if (!onlyItems || onlyItems.length === 0) return;
    const elements = onlyItems.map((d) => d.element);
    const meshes = generator[generatorMethod](
      elements,
      stbData.nodes,
      stbData[sectionsKey],
      stbData.steelSections,
      elementType,
      false,
      openingElements,
    );
    meshes.forEach((mesh) => {
      mesh.userData.modelSource = modelSource;
      group.add(mesh);
    });
  }

  // EXACT要素（位置完全一致 + 属性一致）のメッシュを生成
  addMatchedMeshes(COMPARISON_CATEGORY.EXACT, 'matched');

  // WITHIN_TOLERANCE要素（位置許容差内 + 属性一致）のメッシュを生成
  addMatchedMeshes(COMPARISON_CATEGORY.WITHIN_TOLERANCE, 'matched');

  // ATTRIBUTE_MISMATCH要素（位置一致、属性が異なる）のメッシュを生成
  addMatchedMeshes(COMPARISON_CATEGORY.ATTRIBUTE_MISMATCH, 'mismatch');

  // モデルAのみ / モデルBのみの要素のメッシュを生成
  addOnlyModelMeshes('A', stbDataA, openingElementsA);
  addOnlyModelMeshes('B', stbDataB, openingElementsB);
}

/**
 * ソリッドモードの比較結果を元にラベルを作成しグループに追加する
 * @param {Object} comparisonResult - 正規化済み比較結果
 * @param {Object} stbDataA - モデルAのパース済みデータ
 * @param {Object} stbDataB - モデルBのパース済みデータ
 * @param {THREE.Group} group - 追加先のグループ
 * @param {string} elementType - 要素タイプ
 * @private
 */
export function createSolidModeLabels(comparisonResult, stbDataA, stbDataB, group, elementType) {
  labelDisplayManager.syncWithCheckbox(elementType);
  const createLabelsFlag = labelDisplayManager.isLabelVisible(elementType);
  log.debug(`[redraw${elementType}ForViewMode] solid mode - createLabels: ${createLabelsFlag}`);

  if (!createLabelsFlag) return;

  const exactItems = comparisonResult[COMPARISON_CATEGORY.EXACT] || [];
  const withinToleranceItems = comparisonResult[COMPARISON_CATEGORY.WITHIN_TOLERANCE] || [];
  const mismatchItems = comparisonResult[COMPARISON_CATEGORY.ATTRIBUTE_MISMATCH] || [];

  // EXACT要素のラベル
  const exactLabels = createLabelsForSolidElementsWithSource(
    exactItems.map((m) => m.dataA.element),
    stbDataA.nodes,
    elementType,
    'matched',
  );
  // WITHIN_TOLERANCE要素のラベル
  const withinToleranceLabels = createLabelsForSolidElementsWithSource(
    withinToleranceItems.map((m) => m.dataA.element),
    stbDataA.nodes,
    elementType,
    'matched',
  );
  // ATTRIBUTE_MISMATCH要素のラベル
  const mismatchLabels = createLabelsForSolidElementsWithSource(
    mismatchItems.map((m) => m.dataA.element),
    stbDataA.nodes,
    elementType,
    'matched',
  );
  // モデルAのみの要素のラベル
  const onlyALabels = createLabelsForSolidElementsWithSource(
    comparisonResult.onlyA.map((d) => d.element),
    stbDataA.nodes,
    elementType,
    'A',
  );
  // モデルBのみの要素のラベル
  const onlyBLabels = createLabelsForSolidElementsWithSource(
    comparisonResult.onlyB.map((d) => d.element),
    stbDataB.nodes,
    elementType,
    'B',
  );

  const allLabels = [
    ...exactLabels,
    ...withinToleranceLabels,
    ...mismatchLabels,
    ...onlyALabels,
    ...onlyBLabels,
  ];
  log.debug(`[redraw${elementType}ForViewMode] solid mode - created ${allLabels.length} labels`);
  allLabels.forEach((label) => group.add(label));
  eventBus.emit(LabelEvents.ADD_LABELS, allLabels);
}

/*
 * 片方のモデルのみの場合のソリッドモード描画
 * @param {Object} stbData - パース済みデータ
 * @param {string} modelSource - モデルソース ('A' or 'B')
 * @param {THREE.Group} group - 追加先のグループ
 * @param {Object} generatorInfo - ジェネレータ情報 { class, method }
 * @param {string} elementType - 要素タイプ
 * @param {string} elementsKey - stbDataのキー名
 * @param {string} sectionsKey - stbDataのキー名
 * @private
 */
export function createSolidModeMeshesForSingleModel(
  stbData,
  modelSource,
  group,
  generatorInfo,
  config,
  elementType,
  sectionsKey,
) {
  const generator = generatorInfo.class;
  const generatorMethod = generatorInfo.method;
  const filteredElements = getFilteredStbElements(stbData, config);

  const meshes = generator[generatorMethod](
    filteredElements,
    stbData.nodes,
    stbData[sectionsKey],
    stbData.steelSections,
    elementType,
    false,
    getOpeningElementsForType(elementType, stbData),
  );
  meshes.forEach((mesh) => {
    mesh.userData.modelSource = modelSource;
    group.add(mesh);
  });

  // ラベル作成
  labelDisplayManager.syncWithCheckbox(elementType);
  const createLabelsFlag = labelDisplayManager.isLabelVisible(elementType);
  log.debug(`[redraw${elementType}ForViewMode] solid mode - createLabels: ${createLabelsFlag}`);

  if (createLabelsFlag) {
    const labels = createLabelsForSolidElementsWithSource(
      filteredElements,
      stbData.nodes,
      elementType,
      modelSource,
    );
    log.debug(`[redraw${elementType}ForViewMode] solid mode - created ${labels.length} labels`);
    labels.forEach((label) => group.add(label));
    eventBus.emit(LabelEvents.ADD_LABELS, labels);
  }
}

/*
 * ソリッドモードでの比較を実行し、正規化された比較結果を返す
 * @param {Object} config - 要素設定
 * @param {Object} stbDataA - モデルAのパース済みデータ
 * @param {Object} stbDataB - モデルBのパース済みデータ
 * @param {string} elementType - 要素タイプ
 * @param {string} elementsKey - stbDataのキー名
 * @returns {Object} 正規化済み比較結果
 * @private
 */
export function runSolidModeComparison(config, stbDataA, stbDataB, elementType) {
  const { nodeStartAttr, nodeEndAttr } = config;
  const comparisonKeyType = comparisonKeyManager.getKeyType();
  const toleranceConfig = getToleranceConfig();
  const placementComparisonMode = getPlacementModeForKeyType(comparisonKeyType);
  const useTolerance = toleranceConfig.enabled && !toleranceConfig.strictMode;
  const elementsA = getFilteredStbElements(stbDataA, config);
  const elementsB = getFilteredStbElements(stbDataB, config);

  // 断面一致基準に従う対応キー用リゾルバ（描画パスを権威ある比較と一致させる: F2）。
  // JSオブジェクト要素は id_section が解決できない場合 null を返し、配置のみへ安全にフォールバックする。
  const { modelADocument, modelBDocument } = getModelContext();
  const resolveSectionKeyPart = buildSectionKeyResolver(
    elementType,
    modelADocument,
    modelBDocument,
    stbDataA.nodes,
    stbDataB.nodes,
  );

  // 要素タイプに応じたキー抽出関数を選択し、元のJSオブジェクトを保持するラッパーで包む
  let baseExtractor;
  if (
    elementType === 'Slab' ||
    isWallElementType(elementType) ||
    elementType === 'FrameDampingDevice'
  ) {
    baseExtractor = createPolyKeyExtractor({
      placementMode: placementComparisonMode,
      comparisonKeyType,
      resolveSectionKeyPart,
    });
  } else {
    baseExtractor = createLineKeyExtractor({
      nodeStartAttr,
      nodeEndAttr,
      placementMode: placementComparisonMode,
      comparisonKeyType,
      resolveSectionKeyPart,
    });
  }

  // 元のJSオブジェクトをdata.elementに保持するラッパー
  const keyExtractor = (element, nodeMap) => {
    const result = baseExtractor(element, nodeMap);
    if (result.key !== null && result.data !== null) {
      result.data.element = element;
    }
    return result;
  };

  // 属性比較コールバックを作成（9カテゴリ差分フィルタと同じ細分類を返す）
  const attributeComparator = createRenderAttributeComparator(
    elementType,
    modelADocument,
    modelBDocument,
    stbDataA.nodes,
    stbDataB.nodes,
  );
  const comparisonOptions = {
    attributeComparator,
    classifyNullKeysAsOnly: comparisonKeyType === COMPARISON_KEY_TYPE.GUID_BASED,
  };

  const rawComparisonResult = useTolerance
    ? compareElementsWithTolerance(
        elementsA,
        elementsB,
        stbDataA.nodes,
        stbDataB.nodes,
        keyExtractor,
        toleranceConfig,
        comparisonKeyType,
        comparisonOptions,
      )
    : compareElements(
        elementsA,
        elementsB,
        stbDataA.nodes,
        stbDataB.nodes,
        keyExtractor,
        comparisonOptions,
      );

  // Normalize to canonical 5-category format
  const comparisonResult = normalizeComparisonResult(rawComparisonResult);

  const counts = getCategoryCounts(comparisonResult);
  log.debug(
    `[redraw${elementType}ForViewMode] solid mode comparison: ` +
      `matched=${counts.matched}, ` +
      `attributeMismatch=${counts.attributeMismatch}, ` +
      `onlyA=${counts.onlyA}, ` +
      `onlyB=${counts.onlyB}`,
  );

  return comparisonResult;
}
