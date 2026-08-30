/**
 * @fileoverview モデル間比較のオーケストレーション
 *
 * 全要素タイプの一括比較（processElementComparison）と、
 * 編集後の単一要素タイプ再比較（recompareSingleElementType）を提供する。
 *
 * @module modelLoader/comparison/comparisonOrchestrator
 */

import * as THREE from 'three';
import { buildNodeStoryAxisLookup } from '../../common-stb/import/parser/stbXmlParser.js';
import {
  compareStbDefinitions,
  STB_DEFINITION_ELEMENT_TYPE,
} from '../../common-stb/comparison/stbDefinitionComparator.js';
import { isCrossSoftwareModeEnabled } from '../../config/crossSoftwareConfig.js';
import { SUPPORTED_ELEMENTS } from '../../constants/elementTypes.js';
import {
  COMPARISON_KEY_TYPE,
  DEFAULT_SECTION_MATCH_CRITERION,
  DEFAULT_STORY_AXIS_MATCH_CRITERION,
  sectionCriterionNeedsStoryLookup,
} from '../../config/comparisonKeyConfig.js';
import { getCachedExtractedSections, getCachedStoryAxisLookup } from './comparisonCaches.js';
import { normalizeComparisonElementType } from './comparisonElementUtils.js';
import { compareSingleElementTypeInternal } from './elementTypeComparator.js';

/**
 * Process element comparison for all supported element types
 * @param {Object} modelData - Model data from processing
 * @param {Array<string>} selectedElementTypes - Selected element types
 * @param {Object} options - Comparison options
 * @param {boolean} [options.useImportanceFiltering=true] - Use importance-based filtering
 * @param {string[]} [options.targetImportanceLevels=null] - Target importance levels for filtering
 * @param {string} [options.comparisonKeyType] - Comparison key type (POSITION_NODE_ONLY, POSITION_WITH_OFFSET, POSITION_WITH_ROTATE, GUID_BASED, etc.)
 * @param {boolean} [options.crossSoftwareMode] - 異ソフト間比較モード（未指定時は crossSoftwareConfig の値）。
 *   有効時、断面定義の対応キーの floor を StbStory の標高/順序で正準化する。
 * @returns {Object} Comparison results
 */
export function processElementComparison(modelData, selectedElementTypes, options = {}) {
  const { modelADocument, modelBDocument, nodeMapA, nodeMapB } = modelData;

  const comparisonResults = new Map();
  const modelBounds = new THREE.Box3();
  // キャッシュ付き断面抽出を使用（同一ドキュメントへの重複抽出を回避）
  const sectionMapsA = modelADocument ? getCachedExtractedSections(modelADocument) : null;
  const sectionMapsB = modelBDocument ? getCachedExtractedSections(modelBDocument) : null;

  const {
    comparisonKeyType = COMPARISON_KEY_TYPE.POSITION_NODE_ONLY,
    sectionMatchCriterion = DEFAULT_SECTION_MATCH_CRITERION,
    storyAxisMatchCriterion = DEFAULT_STORY_AXIS_MATCH_CRITERION,
  } = options;

  // STORY_AXIS_BASED モード / 第一Node所属階の断面基準用: ノード所属情報ルックアップを構築
  let storyAxisLookupA = null;
  let storyAxisLookupB = null;
  if (
    comparisonKeyType === COMPARISON_KEY_TYPE.STORY_AXIS_BASED ||
    sectionCriterionNeedsStoryLookup(sectionMatchCriterion)
  ) {
    storyAxisLookupA = modelADocument ? buildNodeStoryAxisLookup(modelADocument) : new Map();
    storyAxisLookupB = modelBDocument ? buildNodeStoryAxisLookup(modelBDocument) : new Map();
  }

  const comparisonContext = {
    modelADocument,
    modelBDocument,
    nodeMapA,
    nodeMapB,
    sectionMapsA,
    sectionMapsB,
    storyAxisLookupA,
    storyAxisLookupB,
    comparisonKeyType,
    sectionMatchCriterion,
    storyAxisMatchCriterion,
    options,
  };

  const normalizedSelectedElementTypes = new Set(
    Array.isArray(selectedElementTypes)
      ? selectedElementTypes.map((elementType) => normalizeComparisonElementType(elementType))
      : [],
  );

  for (const elementType of SUPPORTED_ELEMENTS) {
    if (normalizeComparisonElementType(elementType) !== elementType) {
      continue;
    }

    const isSelected = normalizedSelectedElementTypes.has(elementType);
    const result = compareSingleElementTypeInternal(elementType, isSelected, comparisonContext);
    comparisonResults.set(elementType, result);
  }

  if (options.includeDefinitionComparison !== false) {
    const crossSoftwareMode = options.crossSoftwareMode ?? isCrossSoftwareModeEnabled();
    comparisonResults.set(
      STB_DEFINITION_ELEMENT_TYPE,
      compareStbDefinitions(modelADocument, modelBDocument, {
        canonicalizeFloors: crossSoftwareMode,
      }),
    );
  }

  return {
    comparisonResults,
    modelBounds,
  };
}

/**
 * 単一要素タイプの再比較を実行する（編集後の差分同期用）
 * @param {string} elementType - 要素タイプ
 * @param {Object} modelData - モデルデータ
 * @param {Object} [options={}] - 比較オプション
 * @returns {Object} normalizeComparisonResult 済みの結果オブジェクト
 */
export function recompareSingleElementType(elementType, modelData, options = {}) {
  const { modelADocument, modelBDocument, nodeMapA, nodeMapB } = modelData;
  const sectionMapsA = getCachedExtractedSections(modelADocument);
  const sectionMapsB = getCachedExtractedSections(modelBDocument);

  const {
    comparisonKeyType = COMPARISON_KEY_TYPE.POSITION_NODE_ONLY,
    sectionMatchCriterion = DEFAULT_SECTION_MATCH_CRITERION,
    storyAxisMatchCriterion = DEFAULT_STORY_AXIS_MATCH_CRITERION,
  } = options;

  let storyAxisLookupA = null;
  let storyAxisLookupB = null;
  if (
    comparisonKeyType === COMPARISON_KEY_TYPE.STORY_AXIS_BASED ||
    sectionCriterionNeedsStoryLookup(sectionMatchCriterion)
  ) {
    storyAxisLookupA = getCachedStoryAxisLookup(modelADocument);
    storyAxisLookupB = getCachedStoryAxisLookup(modelBDocument);
  }

  const comparisonContext = {
    modelADocument,
    modelBDocument,
    nodeMapA,
    nodeMapB,
    sectionMapsA,
    sectionMapsB,
    storyAxisLookupA,
    storyAxisLookupB,
    comparisonKeyType,
    sectionMatchCriterion,
    storyAxisMatchCriterion,
    options,
  };

  return compareSingleElementTypeInternal(
    normalizeComparisonElementType(elementType),
    true,
    comparisonContext,
  );
}
