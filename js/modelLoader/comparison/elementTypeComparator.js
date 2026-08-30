/**
 * @fileoverview 単一要素タイプの比較実行モジュール
 *
 * 要素タイプごとのSTBタグ解決・キー抽出関数選択・比較実行を担当する。
 *
 * @module modelLoader/comparison/elementTypeComparator
 */

import { createLogger } from '../../utils/logger.js';
import { normalizeComparisonResult } from '../../data/normalizeComparisonResult.js';
import {
  parseElements,
  computeAxisGeometryKey,
} from '../../common-stb/import/parser/stbXmlParser.js';
import {
  compareElements,
  compareElementsWithImportance,
  compareElementsWithTolerance,
  lineElementKeyExtractor,
  lineElementKeyExtractorV2,
  polyElementKeyExtractor,
  polyElementKeyExtractorV2,
  nodeElementKeyExtractor,
} from '../../common-stb/comparison/comparator.js';
import { createSectionAwareAttributeComparator } from '../../common-stb/comparison/attributeComparator.js';
import { getLoaderImportanceManager } from '../loaderDependencies.js';
import { STB_TAG_NAMES } from '../../constants/elementTypes.js';
import {
  COMPARISON_KEY_TYPE,
  getPlacementModeForKeyType,
  DEFAULT_SECTION_MATCH_CRITERION,
  STORY_AXIS_MATCH_CRITERION,
  DEFAULT_STORY_AXIS_MATCH_CRITERION,
} from '../../config/comparisonKeyConfig.js';
import { getToleranceConfig } from '../../config/toleranceConfig.js';
import { filterWallsByViewerElementType } from '../../common-stb/walls/wallClassification.js';
import { getElementAttribute } from './comparisonElementUtils.js';
import { createSectionKeyResolvers } from './sectionKeyResolvers.js';

const logger = createLogger('modelLoader:comparison');

// Axis の XML タグ名は StbParallelAxis（StbAxis ではない）
const ELEMENT_TAG_OVERRIDES = { Axis: STB_TAG_NAMES.PARALLEL_AXIS, ShearWall: STB_TAG_NAMES.WALL };

// 単一タイプが複数のSTBタグを束ねる場合の追加タグ。
// 通り芯（Axis）は平行に加えて円弧（StbArcAxis）・放射（StbRadialAxis）も比較対象にする。
const ELEMENT_EXTRA_TAGS = {
  Axis: [STB_TAG_NAMES.ARC_AXIS, STB_TAG_NAMES.RADIAL_AXIS],
};

/**
 * 要素タイプに対応する全STBタグをパースして返す。
 * 主タグに加え、ELEMENT_EXTRA_TAGS に定義された追加タグ（円弧/放射通り芯など）も含める。
 * @param {Document} doc - STB XMLドキュメント
 * @param {string} elementType - 要素タイプ
 * @param {string} primaryTag - 主タグ名
 * @returns {Array<Element>} パースした要素配列
 */
function parseElementsForType(doc, elementType, primaryTag) {
  const elements = parseElements(doc, primaryTag);
  const extraTags = ELEMENT_EXTRA_TAGS[elementType];
  if (extraTags) {
    for (const tag of extraTags) {
      elements.push(...parseElements(doc, tag));
    }
  }
  return elements;
}

// 比較では壁を 'Wall' カテゴリに統合する（normalizeComparisonElementType）ため、
// kind_wall によるフィルタは行わない。耐震壁（WALL_SHEAR）もここで比較対象に含める。
// 表示側の種別絞り込みは elementRedrawConfig の wallViewerElementType を元に
// elementRedrawCore の applyElementFilter が担当する。
function filterElementsByViewerType(elementType, elements) {
  if (elementType === 'ShearWall') {
    return filterWallsByViewerElementType(elementType, elements);
  }
  return elements;
}

function getImportanceElementType(elementType) {
  return ELEMENT_TAG_OVERRIDES[elementType] || `Stb${elementType}`;
}

/**
 * 単一要素タイプの比較を実行する内部関数
 * @param {string} elementType - 要素タイプ
 * @param {boolean} isSelected - 選択状態
 * @param {Object} ctx - 比較コンテキスト
 * @returns {Object} 比較結果
 */
export function compareSingleElementTypeInternal(elementType, isSelected, ctx) {
  const {
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
  } = ctx;

  let elementsA = [];
  let elementsB = [];

  // 配置要素として比較できない疑似タイプは空結果で早期リターンする。
  // - Undefined: StbUndefined タグは存在しない（未定義断面を参照する要素の集約用）
  // - Joint: StbJoint タグは存在せず、継手は位置を持たない定義要素のため
  //   StbDefinition 比較（compareStbDefinitions）で StbJointBeam*/StbJointColumn* として扱う
  if (elementType === 'Undefined' || elementType === 'Joint') {
    const emptyResult = normalizeComparisonResult({ matched: [], onlyA: [], onlyB: [] });
    return {
      ...emptyResult,
      elementType,
      isSelected,
      elementsA: [],
      elementsB: [],
    };
  }

  try {
    // Parse elements from both models
    const xmlTagName = ELEMENT_TAG_OVERRIDES[elementType] || 'Stb' + elementType;
    elementsA = filterElementsByViewerType(
      elementType,
      parseElementsForType(modelADocument, elementType, xmlTagName),
    );
    elementsB = filterElementsByViewerType(
      elementType,
      parseElementsForType(modelBDocument, elementType, xmlTagName),
    );

    // Perform comparison with importance options
    const rawComparisonResult = compareElementsByType(
      elementType,
      elementsA,
      elementsB,
      nodeMapA,
      nodeMapB,
      {
        ...options,
        comparisonKeyType,
        sectionMatchCriterion,
        storyAxisMatchCriterion,
        modelADocument,
        modelBDocument,
        sectionMapsA,
        sectionMapsB,
        storyAxisLookupA,
        storyAxisLookupB,
      },
    );

    // Normalize to canonical 5-category format
    const comparisonResult = normalizeComparisonResult(rawComparisonResult);

    return {
      ...comparisonResult,
      elementType,
      isSelected,
      elementsA,
      elementsB,
    };
  } catch (error) {
    logger.error(`Error processing ${elementType}:`, error);
    logger.error(`Error stack:`, error.stack);
    logger.error(`Elements A length: ${elementsA.length}`);
    logger.error(`Elements B length: ${elementsB.length}`);
    logger.error(`Node map A size: ${nodeMapA.size}`);
    logger.error(`Node map B size: ${nodeMapB.size}`);
    const errorResult = normalizeComparisonResult({ matched: [], onlyA: [], onlyB: [] });
    return {
      ...errorResult,
      elementType,
      isSelected,
      elementsA,
      elementsB,
      error: error.message,
    };
  }
}

/**
 * Compare elements by their type using appropriate key extractor
 * @param {string} elementType - Type of element
 * @param {Array} elementsA - Elements from model A
 * @param {Array} elementsB - Elements from model B
 * @param {Map} nodeMapA - Node map for model A
 * @param {Map} nodeMapB - Node map for model B
 * @param {Object} options - Comparison options
 * @param {boolean} [options.useImportanceFiltering=true] - Use importance-based filtering
 * @param {string[]} [options.targetImportanceLevels=null] - Target importance levels for filtering
 * @param {string} [options.comparisonKeyType] - Comparison key type (POSITION_NODE_ONLY, POSITION_WITH_OFFSET, POSITION_WITH_ROTATE, GUID_BASED, etc.)
 * @returns {Object} Comparison result
 */
function compareElementsByType(
  elementType,
  elementsA,
  elementsB,
  nodeMapA,
  nodeMapB,
  options = {},
) {
  const {
    useImportanceFiltering = true,
    targetImportanceLevels = null,
    comparisonKeyType = COMPARISON_KEY_TYPE.POSITION_NODE_ONLY,
    sectionMatchCriterion = DEFAULT_SECTION_MATCH_CRITERION,
    storyAxisMatchCriterion = DEFAULT_STORY_AXIS_MATCH_CRITERION,
    modelADocument = null,
    modelBDocument = null,
    sectionMapsA = null,
    sectionMapsB = null,
    storyAxisLookupA = null,
    storyAxisLookupB = null,
  } = options;

  let comparisonResult = null;

  // Get tolerance configuration
  const toleranceConfig = getToleranceConfig();
  const useToleranceComparison = toleranceConfig.enabled && !toleranceConfig.strictMode;

  const resolveStoryAxisLookup = (nodeMapRef) => {
    if (nodeMapRef === nodeMapA) return storyAxisLookupA;
    if (nodeMapRef === nodeMapB) return storyAxisLookupB;
    return null;
  };

  // 断面一致基準に従う対応キー/型差分リゾルバ（描画パスと共有）
  const { resolveSectionKeyPart, resolveSectionContentSignature } = createSectionKeyResolvers({
    elementType,
    sectionMatchCriterion,
    nodeMapA,
    nodeMapB,
    sectionMapsA,
    sectionMapsB,
    modelADocument,
    modelBDocument,
    storyAxisLookupA,
    storyAxisLookupB,
  });

  // 構造属性＋断面内容の双方を比較する属性コンパレータ。
  // 配置＋断面name が一致した部材ペアについて、断面の内容差を attributeMismatch として検出する。
  const attributeComparator = createSectionAwareAttributeComparator({
    resolveSectionContentSignature,
    nodeMapA,
    nodeMapB,
  });

  const compareOptions = {
    attributeComparator,
    classifyNullKeysAsOnly:
      comparisonKeyType === COMPARISON_KEY_TYPE.GUID_BASED ||
      comparisonKeyType === COMPARISON_KEY_TYPE.STORY_AXIS_BASED,
  };

  // Create comparison function based on tolerance and importance filtering settings
  const getEffectiveKeyType = (supportsGeometryCenterDirection) => {
    if (
      comparisonKeyType === COMPARISON_KEY_TYPE.GEOMETRY_CENTER_DIRECTION_BASED &&
      !supportsGeometryCenterDirection
    ) {
      return COMPARISON_KEY_TYPE.POSITION_NODE_ONLY;
    }
    return comparisonKeyType;
  };

  const performComparison = (keyExtractor, keyTypeOverride = comparisonKeyType) => {
    try {
      // Use tolerance-based comparison if enabled
      if (useToleranceComparison) {
        const toleranceResult = compareElementsWithTolerance(
          elementsA,
          elementsB,
          nodeMapA,
          nodeMapB,
          keyExtractor,
          toleranceConfig,
          keyTypeOverride,
          compareOptions,
        );

        // Return 5-level tolerance result directly
        return toleranceResult;
      }

      // Use importance-based comparison
      if (useImportanceFiltering) {
        const manager = getLoaderImportanceManager();
        // マネージャーの依存性（isInitialized）を隠蔽して関数のみ渡す
        const importanceLookup =
          manager && manager.isInitialized
            ? (element, elementType) => manager.getElementImportance(element, elementType)
            : null;

        return compareElementsWithImportance(
          elementsA,
          elementsB,
          nodeMapA,
          nodeMapB,
          keyExtractor,
          getImportanceElementType(elementType),
          { targetImportanceLevels, importanceLookup, compareOptions },
        );
      } else {
        return compareElements(
          elementsA,
          elementsB,
          nodeMapA,
          nodeMapB,
          keyExtractor,
          compareOptions,
        );
      }
    } catch (error) {
      logger.error(`Error in performComparison for ${elementType}:`, error);
      throw error;
    }
  };

  const getGuidPreferredKey = (element, fallbackKey) => {
    if (comparisonKeyType !== COMPARISON_KEY_TYPE.GUID_BASED) {
      return fallbackKey;
    }
    const guid = getElementAttribute(element, 'guid');
    if (guid && guid.trim() !== '') {
      return `guid:${guid.trim()}`;
    }
    // GUIDモードでGUIDが無い要素は比較対象から除外（nullを返す）
    return null;
  };

  // 配置比較モード: キータイプが+オフセット/+回転系であれば V2 extractor を使用
  const placementMode = getPlacementModeForKeyType(comparisonKeyType);
  const useV2 =
    placementMode !== getPlacementModeForKeyType(COMPARISON_KEY_TYPE.POSITION_NODE_ONLY);

  const createLineExtractor = (startAttr, endAttr) => {
    return (element, nodeMap) => {
      const options = {
        sectionSignatureResolver: (targetElement) => resolveSectionKeyPart(targetElement, nodeMap),
        storyAxisLookup: resolveStoryAxisLookup(nodeMap),
      };
      return useV2
        ? lineElementKeyExtractorV2(
            element,
            nodeMap,
            startAttr,
            endAttr,
            placementMode,
            comparisonKeyType,
            options,
          )
        : lineElementKeyExtractor(element, nodeMap, startAttr, endAttr, comparisonKeyType, options);
    };
  };

  const createPolyExtractor = (nodeOrderTag = 'StbNodeIdOrder') => {
    return (element, nodeMap) => {
      const options = {
        sectionSignatureResolver: (targetElement) => resolveSectionKeyPart(targetElement, nodeMap),
        storyAxisLookup: resolveStoryAxisLookup(nodeMap),
      };
      return useV2
        ? polyElementKeyExtractorV2(
            element,
            nodeMap,
            nodeOrderTag,
            placementMode,
            comparisonKeyType,
            options,
          )
        : polyElementKeyExtractor(element, nodeMap, nodeOrderTag, comparisonKeyType, options);
    };
  };

  try {
    switch (elementType) {
      case 'Node':
        comparisonResult = performComparison(
          (el, nm) =>
            nodeElementKeyExtractor(el, nm, comparisonKeyType, {
              storyAxisLookup: resolveStoryAxisLookup(nm),
            }),
          getEffectiveKeyType(false),
        );
        break;

      case 'Column':
        comparisonResult = performComparison(
          createLineExtractor('id_node_bottom', 'id_node_top'),
          getEffectiveKeyType(true),
        );
        break;

      case 'Post':
        comparisonResult = performComparison(
          createLineExtractor('id_node_bottom', 'id_node_top'),
          getEffectiveKeyType(true),
        );
        break;

      case 'Girder':
      case 'Beam':
        comparisonResult = performComparison(
          createLineExtractor('id_node_start', 'id_node_end'),
          getEffectiveKeyType(true),
        );
        break;

      case 'Brace':
        comparisonResult = performComparison(
          createLineExtractor('id_node_start', 'id_node_end'),
          getEffectiveKeyType(true),
        );
        break;

      case 'Slab':
      case 'ShearWall':
      case 'Wall':
      case 'FrameDampingDevice':
        comparisonResult = performComparison(
          createPolyExtractor('StbNodeIdOrder'),
          getEffectiveKeyType(true),
        );
        break;

      case 'Pile':
        // Pile要素は2ノード形式（id_node_bottom/top）または1ノード形式（id_node + level_top）
        // lineElementKeyExtractorは1ノード形式にもフォールバック対応
        comparisonResult = performComparison(
          createLineExtractor('id_node_bottom', 'id_node_top'),
          getEffectiveKeyType(true),
        );
        break;

      case 'Footing':
        // Footing要素は1ノード形式（id_node + level_bottom）
        // lineElementKeyExtractorの1ノードフォールバックで対応
        comparisonResult = performComparison(
          createLineExtractor('id_node_bottom', 'id_node_top'),
          getEffectiveKeyType(true),
        );
        break;

      case 'FoundationColumn':
        comparisonResult = performComparison(
          createLineExtractor('id_node_bottom', 'id_node_top'),
          getEffectiveKeyType(true),
        );
        break;

      case 'Parapet':
        comparisonResult = performComparison(
          createLineExtractor('id_node_start', 'id_node_end'),
          getEffectiveKeyType(true),
        );
        break;

      case 'StripFooting':
        comparisonResult = performComparison(
          createLineExtractor('id_node_start', 'id_node_end'),
          getEffectiveKeyType(true),
        );
        break;

      case 'IsolatingDevice':
      case 'DampingDevice':
        comparisonResult = performComparison(
          createLineExtractor('id_node_start', 'id_node_end'),
          getEffectiveKeyType(true),
        );
        break;

      // 'Joint' はここに到達しない（compareSingleElementTypeInternal で早期リターン）。
      // 継手は StbDefinition 比較で定義要素として扱う。

      case 'Story':
        // 階の対応キー: 既定は name（"1F","2F"等）、幾何位置基準では標高(height)で対応付ける。
        // GEOMETRY では階名の表記差（"1F" vs "1FL"）を無視し、原点0からの高さ=level で同定する。
        comparisonResult = performComparison((el) => {
          const name = getElementAttribute(el, 'name');
          const id = getElementAttribute(el, 'id');
          let fallbackKey = null;
          if (storyAxisMatchCriterion === STORY_AXIS_MATCH_CRITERION.GEOMETRY) {
            const height = parseFloat(getElementAttribute(el, 'height'));
            // 標高も computeAxisGeometryKey と同じ 10mm グリッドへ量子化する
            fallbackKey = Number.isFinite(height) ? `story:h:${Math.round(height / 10)}` : null;
          } else {
            fallbackKey = name ? `story:${name}` : null;
          }
          return {
            key: getGuidPreferredKey(el, fallbackKey),
            data: { id, name, guid: getElementAttribute(el, 'guid') || undefined },
          };
        }, getEffectiveKeyType(false));
        break;

      case 'Axis':
        // 通り芯の対応キー:
        // - 既定（NAME）: 軸種別（平行/円弧/放射）+ 親グループ名 + name。軸種別をキーに
        //   含めるのは、別種の通り芯で group_name+name が偶然一致した際の誤対応を防ぐため。
        // - 幾何位置（GEOMETRY）: 原点＋距離から算出した実座標で対応付け、符号（name）の
        //   表記差を無視する（computeAxisGeometryKey を使用）。
        comparisonResult = performComparison((el) => {
          const name = getElementAttribute(el, 'name');
          const id = getElementAttribute(el, 'id');
          const axisKind = el?.tagName || el?.nodeName || '';
          let fallbackKey = null;
          if (storyAxisMatchCriterion === STORY_AXIS_MATCH_CRITERION.GEOMETRY) {
            const geometryKey = computeAxisGeometryKey(el);
            fallbackKey = geometryKey ? `axis:${geometryKey}` : null;
          } else {
            const groupName =
              (typeof el?.parentElement?.getAttribute === 'function'
                ? el.parentElement.getAttribute('group_name')
                : null) || '';
            fallbackKey = name ? `axis:${axisKind}:${groupName}:${name}` : null;
          }
          return {
            key: getGuidPreferredKey(el, fallbackKey),
            data: { id, name, guid: getElementAttribute(el, 'guid') || undefined },
          };
        }, getEffectiveKeyType(false));
        break;

      default:
        logger.warn(`Unknown element type for comparison: ${elementType}`);
        comparisonResult = {
          matched: [],
          mismatch: [],
          onlyA: [...elementsA],
          onlyB: [...elementsB],
        };
    }
  } catch (error) {
    logger.error(`Error in switch statement for ${elementType}:`, error);
    throw error;
  }

  return (
    comparisonResult || {
      matched: [],
      mismatch: [],
      onlyA: [],
      onlyB: [],
    }
  );
}
