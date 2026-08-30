/**
 * @fileoverview 線表示・パネル表示モードの再描画処理
 *
 * 面要素（Wall/Slab）のパネル表示と、2ノード要素の線表示を担当します。
 *
 * @module app/viewModes/elementRedrawLineMode
 */

import { createLogger } from '../../utils/logger.js';
import { parseElements } from '../../common-stb/import/parser/stbXmlParser.js';
import {
  drawLineElements,
  drawPolyElements,
  labelDisplayManager,
  parseStbFile,
} from '../../viewer/index.js';
import { eventBus, LabelEvents } from '../../data/events/index.js';
import {
  compareElements,
  compareElementsWithTolerance,
} from '../../common-stb/comparison/index.js';
import {
  COMPARISON_KEY_TYPE,
  getPlacementModeForKeyType,
} from '../../config/comparisonKeyConfig.js';
import { getToleranceConfig } from '../../config/toleranceConfig.js';
import comparisonKeyManager from '../comparisonKeyManager.js';
import { normalizeComparisonResult } from '../../data/normalizeComparisonResult.js';
import { createWallLookup, drawWallOpeningOutlines } from './elementRedrawWalls.js';
import {
  applyElementFilter,
  buildSectionKeyResolver,
  createLineKeyExtractor,
  createPolyKeyExtractor,
  createRenderAttributeComparator,
  isWallElementType,
} from './elementRedrawHelpers.js';

// ロガー
const log = createLogger('elementRedrawer');

/**
 * ポリゴン要素（Wall, Slab）の線/パネル表示を描画する
 * @param {Object} config - 要素設定
 * @param {Object} modelContext - モデルコンテキスト
 * @param {THREE.Group} group - 追加先のグループ
 * @private
 */
export function drawPolyModeElements(config, modelContext, group) {
  const { elementType, stbTagName } = config;
  const { modelBounds, modelADocument, modelBDocument, nodeMapA, nodeMapB } = modelContext;

  const elementsA = applyElementFilter(config, parseElements(modelADocument, stbTagName));
  const elementsB = applyElementFilter(config, parseElements(modelBDocument, stbTagName));

  const comparisonKeyType = comparisonKeyManager.getKeyType();
  const toleranceConfig = getToleranceConfig();
  const placementMode = getPlacementModeForKeyType(comparisonKeyType);
  const useTolerance = toleranceConfig.enabled && !toleranceConfig.strictMode;
  const comparisonOptions = {
    attributeComparator: createRenderAttributeComparator(
      elementType,
      modelADocument,
      modelBDocument,
      nodeMapA,
      nodeMapB,
    ),
    classifyNullKeysAsOnly: comparisonKeyType === COMPARISON_KEY_TYPE.GUID_BASED,
  };
  const resolveSectionKeyPart = buildSectionKeyResolver(
    elementType,
    modelADocument,
    modelBDocument,
    nodeMapA,
    nodeMapB,
  );
  const keyExtractor = createPolyKeyExtractor({
    placementMode,
    comparisonKeyType,
    resolveSectionKeyPart,
  });

  const rawPolyResult = useTolerance
    ? compareElementsWithTolerance(
        elementsA,
        elementsB,
        nodeMapA,
        nodeMapB,
        keyExtractor,
        toleranceConfig,
        comparisonKeyType,
        comparisonOptions,
      )
    : compareElements(elementsA, elementsB, nodeMapA, nodeMapB, keyExtractor, comparisonOptions);

  const comparisonResult = normalizeComparisonResult(rawPolyResult);

  labelDisplayManager.syncWithCheckbox(elementType);
  const createLabels = labelDisplayManager.isLabelVisible(elementType);
  log.debug(`[redraw${elementType}ForViewMode] poly mode - createLabels: ${createLabels}`);

  const createdLabels = drawPolyElements(comparisonResult, group, createLabels, modelBounds);

  // Wallの非ソリッド表示時にも開口輪郭を描画
  if (isWallElementType(elementType)) {
    const stbDataA = modelADocument
      ? parseStbFile(modelADocument, { modelKey: 'A', saveToGlobalState: true })
      : null;
    const stbDataB = modelBDocument
      ? parseStbFile(modelBDocument, { modelKey: 'B', saveToGlobalState: true })
      : null;
    drawWallOpeningOutlines(
      comparisonResult,
      group,
      modelBounds,
      createWallLookup(applyElementFilter(config, stbDataA?.wallElements || [])),
      createWallLookup(applyElementFilter(config, stbDataB?.wallElements || [])),
      stbDataA?.openingElements || null,
      stbDataB?.openingElements || null,
      elementType,
    );
  }

  if (createdLabels && createdLabels.length > 0) {
    log.debug(
      `[redraw${elementType}ForViewMode] poly mode - created ${createdLabels.length} labels`,
    );
    eventBus.emit(LabelEvents.ADD_LABELS, createdLabels);
  } else {
    log.debug(`[redraw${elementType}ForViewMode] poly mode - no labels created`);
  }
}

/**
 * 2ノード要素の線表示を描画する
 * @param {Object} config - 要素設定
 * @param {Object} modelContext - モデルコンテキスト
 * @param {THREE.Group} group - 追加先のグループ
 * @private
 */
export function drawLineModeElements(config, modelContext, group) {
  const { elementType, stbTagName, nodeStartAttr, nodeEndAttr } = config;
  const { modelBounds, modelADocument, modelBDocument, nodeMapA, nodeMapB } = modelContext;

  const elementsA = applyElementFilter(config, parseElements(modelADocument, stbTagName));
  const elementsB = applyElementFilter(config, parseElements(modelBDocument, stbTagName));
  const comparisonKeyType = comparisonKeyManager.getKeyType();
  const toleranceConfig = getToleranceConfig();
  const placementComparisonMode = getPlacementModeForKeyType(comparisonKeyType);

  const useTolerance = toleranceConfig.enabled && !toleranceConfig.strictMode;
  const comparisonOptions = {
    attributeComparator: createRenderAttributeComparator(
      elementType,
      modelADocument,
      modelBDocument,
      nodeMapA,
      nodeMapB,
    ),
    classifyNullKeysAsOnly: comparisonKeyType === COMPARISON_KEY_TYPE.GUID_BASED,
  };

  const resolveSectionKeyPart = buildSectionKeyResolver(
    elementType,
    modelADocument,
    modelBDocument,
    nodeMapA,
    nodeMapB,
  );
  // V2 キー抽出関数を使用（配置要素比較モード対応）
  const lineKeyExtractor = createLineKeyExtractor({
    nodeStartAttr,
    nodeEndAttr,
    placementMode: placementComparisonMode,
    comparisonKeyType,
    resolveSectionKeyPart,
  });

  const rawLineResult = useTolerance
    ? compareElementsWithTolerance(
        elementsA,
        elementsB,
        nodeMapA,
        nodeMapB,
        lineKeyExtractor,
        toleranceConfig,
        comparisonKeyType,
        comparisonOptions,
      )
    : compareElements(
        elementsA,
        elementsB,
        nodeMapA,
        nodeMapB,
        lineKeyExtractor,
        comparisonOptions,
      );

  const comparisonResult = normalizeComparisonResult(rawLineResult);

  labelDisplayManager.syncWithCheckbox(elementType);
  const createLabels = labelDisplayManager.isLabelVisible(elementType);
  log.debug(`[redraw${elementType}ForViewMode] line mode - createLabels: ${createLabels}`);

  const createdLabels = drawLineElements(
    comparisonResult,
    group,
    elementType,
    createLabels,
    modelBounds,
  );

  if (createdLabels && createdLabels.length > 0) {
    log.debug(
      `[redraw${elementType}ForViewMode] line mode - created ${createdLabels.length} labels`,
    );
    eventBus.emit(LabelEvents.ADD_LABELS, createdLabels);
  } else {
    log.debug(`[redraw${elementType}ForViewMode] line mode - no labels created`);
  }
}
