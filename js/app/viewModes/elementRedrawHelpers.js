/**
 * @fileoverview 要素再描画の共通ヘルパー
 *
 * 描画経路（ソリッド／ライン／パネル）が共有する要素フィルタ・
 * 断面リゾルバ生成・キー抽出関数生成を提供します。
 *
 * @module app/viewModes/elementRedrawHelpers
 */

import {
  lineElementKeyExtractorV2,
  polyElementKeyExtractor,
  polyElementKeyExtractorV2,
  createSectionAwareAttributeComparator,
} from '../../common-stb/comparison/index.js';
import {
  COMPARISON_KEY_TYPE,
  getPlacementModeForKeyType,
} from '../../config/comparisonKeyConfig.js';
import comparisonKeyManager from '../comparisonKeyManager.js';
import {
  createSectionKeyResolvers,
  getCachedExtractedSections,
} from '../../modelLoader/elementComparison.js';
import { filterWallsByViewerElementType } from '../../common-stb/walls/wallClassification.js';

export function isWallElementType(elementType) {
  return elementType === 'Wall' || elementType === 'ShearWall';
}

/**
 * 断面一致基準に従う対応キー用リゾルバを構築する（描画パスを権威ある比較と一致させる: F2）。
 * 返り値は (element, nodeMap) => keyPart。対象外要素・断面解決不可時は null を返すため、
 * その場合キーは配置のみとなり現行挙動へ安全にフォールバックする。
 * @param {string} elementType
 * @param {Document|null} modelADocument
 * @param {Document|null} modelBDocument
 * @param {Map} nodeMapA - extractor 呼び出し時に渡すモデルAのノードマップ（A/B帰属判定に使用）
 * @param {Map} nodeMapB - モデルBのノードマップ
 * @returns {Function} (element, nodeMap) => (string|null)
 */
function buildSectionResolvers(elementType, modelADocument, modelBDocument, nodeMapA, nodeMapB) {
  return createSectionKeyResolvers({
    elementType,
    sectionMatchCriterion: comparisonKeyManager.getSectionMatchCriterion(),
    nodeMapA,
    nodeMapB,
    sectionMapsA: modelADocument ? getCachedExtractedSections(modelADocument) : null,
    sectionMapsB: modelBDocument ? getCachedExtractedSections(modelBDocument) : null,
    modelADocument,
    modelBDocument,
  });
}

export function buildSectionKeyResolver(
  elementType,
  modelADocument,
  modelBDocument,
  nodeMapA,
  nodeMapB,
) {
  const { resolveSectionKeyPart } = buildSectionResolvers(
    elementType,
    modelADocument,
    modelBDocument,
    nodeMapA,
    nodeMapB,
  );
  return resolveSectionKeyPart;
}

export function createRenderAttributeComparator(
  elementType,
  modelADocument,
  modelBDocument,
  nodeMapA,
  nodeMapB,
) {
  const { resolveSectionContentSignature } = buildSectionResolvers(
    elementType,
    modelADocument,
    modelBDocument,
    nodeMapA,
    nodeMapB,
  );

  return createSectionAwareAttributeComparator({
    resolveSectionContentSignature,
    nodeMapA,
    nodeMapB,
  });
}

/**
 * 面要素（Slab/Wall/FrameDampingDevice）用のキー抽出関数を生成する。
 * パネル表示経路とソリッド表示経路で同一のキー生成ロジックを共有する。
 * @param {Object} params
 * @param {string} params.placementMode - 配置比較モード
 * @param {string} params.comparisonKeyType - 比較キータイプ
 * @param {Function} params.resolveSectionKeyPart - (element, nodeMap) => string|null
 * @param {string} [params.nodeOrderTag='StbNodeIdOrder'] - 頂点列タグ名
 * @returns {Function} (element, nodeMap) => キー抽出結果
 */
export function createPolyKeyExtractor({
  placementMode,
  comparisonKeyType,
  resolveSectionKeyPart,
  nodeOrderTag = 'StbNodeIdOrder',
}) {
  const useV2 =
    placementMode !== getPlacementModeForKeyType(COMPARISON_KEY_TYPE.POSITION_NODE_ONLY);

  return (el, nm) => {
    const extractorOptions = {
      sectionSignatureResolver: (target) => resolveSectionKeyPart(target, nm),
    };
    return useV2
      ? polyElementKeyExtractorV2(
          el,
          nm,
          nodeOrderTag,
          placementMode,
          comparisonKeyType,
          extractorOptions,
        )
      : polyElementKeyExtractor(el, nm, nodeOrderTag, comparisonKeyType, extractorOptions);
  };
}

/**
 * 2ノード要素用のキー抽出関数を生成する（V2固定：配置要素比較モード対応）。
 * 線表示経路とソリッド表示経路で同一のキー生成ロジックを共有する。
 * @param {Object} params
 * @param {string} params.nodeStartAttr - 始点ノード属性名
 * @param {string} params.nodeEndAttr - 終点ノード属性名
 * @param {string} params.placementMode - 配置比較モード
 * @param {string} params.comparisonKeyType - 比較キータイプ
 * @param {Function} params.resolveSectionKeyPart - (element, nodeMap) => string|null
 * @returns {Function} (element, nodeMap) => キー抽出結果
 */
export function createLineKeyExtractor({
  nodeStartAttr,
  nodeEndAttr,
  placementMode,
  comparisonKeyType,
  resolveSectionKeyPart,
}) {
  return (el, nm) =>
    lineElementKeyExtractorV2(
      el,
      nm,
      nodeStartAttr,
      nodeEndAttr,
      placementMode,
      comparisonKeyType,
      { sectionSignatureResolver: (target) => resolveSectionKeyPart(target, nm) },
    );
}

export function applyElementFilter(config, elements) {
  if (!Array.isArray(elements)) {
    return [];
  }
  if (config?.wallViewerElementType) {
    return filterWallsByViewerElementType(config.wallViewerElementType, elements);
  }
  return elements;
}

export function getOpeningElementsForType(elementType, stbData) {
  return isWallElementType(elementType) ? stbData?.openingElements || null : null;
}

export function getFilteredStbElements(stbData, config) {
  return applyElementFilter(config, stbData?.[config.elementsKey] || []);
}
