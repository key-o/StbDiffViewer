/**
 * @fileoverview 断面一致基準に基づく対応キー／断面内容シグネチャのリゾルバ
 *
 * 権威ある比較（elementTypeComparator）と描画パス（elementRedrawCore）が
 * 同一ロジックを共有するための断面キー解決を提供する。
 *
 * @module modelLoader/comparison/sectionKeyResolvers
 */

import { getSectionDataFromMap } from '../../data/accessors/sectionMapAccessor.js';
import { buildGeometryShapeSignature } from '../../common-stb/comparison/geometryShapeSignature.js';
import { getLoaderNormalizeSectionData } from '../loaderDependencies.js';
import {
  SECTION_MATCH_CRITERION,
  DEFAULT_SECTION_MATCH_CRITERION,
} from '../../config/comparisonKeyConfig.js';
import { getFirstNodeId, getSectionIdFromElement } from './comparisonElementUtils.js';

const SECTION_MAP_KEY_BY_ELEMENT_TYPE = {
  Column: 'columnSections',
  Post: 'postSections',
  Girder: 'girderSections',
  Beam: 'beamSections',
  Brace: 'braceSections',
  Slab: 'slabSections',
  ShearWall: 'wallSections',
  Wall: 'wallSections',
  Parapet: 'parapetSections',
  Pile: 'pileSections',
  Footing: 'footingSections',
  StripFooting: 'footingSections',
  FoundationColumn: 'foundationcolumnSections',
  IsolatingDevice: 'isolatingDeviceSections',
  DampingDevice: 'dampingDeviceSections',
  FrameDampingDevice: 'dampingDeviceSections',
};

function toStableComparableObject(value) {
  if (Array.isArray(value)) {
    return value.map((item) => toStableComparableObject(item));
  }

  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      const normalizedValue = toStableComparableObject(value[key]);
      if (normalizedValue !== undefined) {
        sorted[key] = normalizedValue;
      }
    }
    return sorted;
  }

  return value;
}

function buildSectionCompositionSignature(sectionData, elementType) {
  if (!sectionData || typeof sectionData !== 'object') return null;

  const normalizeSectionData = getLoaderNormalizeSectionData();
  const normalizedSection = normalizeSectionData(sectionData, elementType);
  const signaturePayload = {
    normalizedSection,
    mode: sectionData.mode ?? null,
    shapeName: sectionData.shapeName ?? null,
    sectionType: sectionData.sectionType ?? null,
    section_type: sectionData.section_type ?? null,
    profile_type: sectionData.profile_type ?? null,
    id_steel: sectionData.id_steel ?? null,
    dimensions: sectionData.dimensions ?? null,
    properties: sectionData.properties ?? null,
    shapes: sectionData.shapes ?? null,
    steelVariants: sectionData.steelVariants ?? null,
    sameNotSamePattern: sectionData.sameNotSamePattern ?? null,
    multiSectionType: sectionData.multiSectionType ?? null,
    concreteProfile: sectionData.concreteProfile ?? null,
    // GSSは均一HaunchをStraightへ縮退しつつ、実際の断面形状変化を保持する。
    geometryShape: buildGeometryShapeSignature(sectionData, elementType),
    isSRC: sectionData.isSRC ?? null,
    isReferenceDirection: sectionData.isReferenceDirection ?? null,
  };

  return JSON.stringify(toStableComparableObject(signaturePayload));
}

/**
 * 断面一致基準に従い、対応キー用/型差分用の断面シグネチャリゾルバを生成する。
 * 権威ある比較（compareElementsByType）と描画パス（elementRedrawCore）で同一ロジックを共有し、
 * 3D着色と差分サマリーの断面対応を一致させる（F2）。
 *
 * @param {Object} params
 * @param {string} params.elementType - 要素タイプ
 * @param {string} [params.sectionMatchCriterion] - SECTION_MATCH_CRITERION の値
 * @param {Map} params.nodeMapA - モデルAのノードマップ（断面マップの帰属判定に使用）
 * @param {Map} params.nodeMapB - モデルBのノードマップ
 * @param {Object} params.sectionMapsA - モデルAの抽出済み断面マップ群
 * @param {Object} params.sectionMapsB - モデルBの抽出済み断面マップ群
 * @param {Document} [params.modelADocument] - モデルAのXMLドキュメント（ownerDocument帰属判定用）
 * @param {Document} [params.modelBDocument] - モデルBのXMLドキュメント
 * @returns {{sectionMapKey: string|null, resolveSectionKeyPart: Function, resolveSectionContentSignature: Function}}
 */
export function createSectionKeyResolvers({
  elementType,
  sectionMatchCriterion = DEFAULT_SECTION_MATCH_CRITERION,
  nodeMapA,
  nodeMapB,
  sectionMapsA,
  sectionMapsB,
  modelADocument = null,
  modelBDocument = null,
  storyAxisLookupA = null,
  storyAxisLookupB = null,
}) {
  const sectionMapKey = SECTION_MAP_KEY_BY_ELEMENT_TYPE[elementType] || null;

  const resolveStoryLookupForNodeMap = (nodeMapRef) => {
    if (nodeMapRef === nodeMapA) return storyAxisLookupA;
    if (nodeMapRef === nodeMapB) return storyAxisLookupB;
    return null;
  };

  // 第一Nodeの所属階名を対応キー成分として生成する（NAME_MEMBER_STORY 用）。
  const buildFirstNodeStoryKeyPart = (element, nodeMapRef) => {
    const nodeId = getFirstNodeId(element, elementType);
    if (!nodeId) return null;
    const lookup = resolveStoryLookupForNodeMap(nodeMapRef);
    const storyName = lookup instanceof Map ? lookup.get(nodeId)?.storyName : null;
    return storyName != null && String(storyName).trim() !== ''
      ? `story:${String(storyName).trim()}`
      : null;
  };
  const sectionDataCacheA = new Map();
  const sectionDataCacheB = new Map();
  const sectionSignatureCacheA = new Map();
  const sectionSignatureCacheB = new Map();

  const resolveSectionMapsForElement = (element, nodeMapRef) => {
    if (nodeMapRef === nodeMapA) {
      return sectionMapsA;
    }
    if (nodeMapRef === nodeMapB) {
      return sectionMapsB;
    }

    const ownerDocument = element?.ownerDocument;
    if (ownerDocument && ownerDocument === modelADocument) {
      return sectionMapsA;
    }
    if (ownerDocument && ownerDocument === modelBDocument) {
      return sectionMapsB;
    }

    return null;
  };

  // 断面データ（name・内容シグネチャ双方の元）を id_section から解決（キャッシュ付き）
  const resolveSectionData = (element, nodeMapRef) => {
    if (!sectionMapKey) {
      return null;
    }

    const sectionId = getSectionIdFromElement(element);
    if (!sectionId) {
      return null;
    }

    const sectionMaps = resolveSectionMapsForElement(element, nodeMapRef);
    const sectionMap = sectionMaps?.[sectionMapKey];
    if (!(sectionMap instanceof Map)) {
      return null;
    }

    const cache = sectionMaps === sectionMapsA ? sectionDataCacheA : sectionDataCacheB;
    const cacheKey = String(sectionId);
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }

    const sectionData = getSectionDataFromMap(sectionMap, sectionId) || null;
    cache.set(cacheKey, sectionData);
    return sectionData;
  };

  // 断面名称キーを生成する。名称が無い場合は配置対応へフォールバックするため null。
  const buildNameKeyPart = (element, nodeMapRef) => {
    const sectionData = resolveSectionData(element, nodeMapRef);
    if (!sectionData) {
      return null;
    }
    const name = sectionData.name;
    if (name != null && String(name).trim() !== '') {
      return `name:${String(name).trim()}`;
    }
    return null;
  };

  // 比較キー用: 断面一致基準(sectionMatchCriterion)に従い、対応キーへ混ぜる断面シグネチャを生成する。
  // 返り値 null のとき断面はキーに含まれず、部材は配置のみで対応付けられる。
  // PLACEMENT_INHERIT は配置対応の結果を断面同定に流用する（断面をキーに入れず、断面差は型差分）。
  const resolveSectionKeyPart = (element, nodeMapRef) => {
    if (!sectionMapKey) {
      return null;
    }

    switch (sectionMatchCriterion) {
      case SECTION_MATCH_CRITERION.PLACEMENT_INHERIT:
        // 断面をキーに入れず配置のみで対応付ける。断面差は配置一致後の type 属性差として表示する。
        return null;

      case SECTION_MATCH_CRITERION.GUID: {
        const guid = resolveSectionData(element, nodeMapRef)?.guid;
        return guid != null && String(guid).trim() !== '' ? `secguid:${String(guid).trim()}` : null;
      }

      case SECTION_MATCH_CRITERION.NAME:
        return buildNameKeyPart(element, nodeMapRef);

      case SECTION_MATCH_CRITERION.NAME_SECTION_FLOOR: {
        const nameKeyPart = buildNameKeyPart(element, nodeMapRef);
        const sectionData = resolveSectionData(element, nodeMapRef);
        const floor = sectionData?.floor;
        if (!nameKeyPart || floor == null || String(floor).trim() === '') return null;
        return `${nameKeyPart}|secfloor:${String(floor).trim()}`;
      }

      case SECTION_MATCH_CRITERION.NAME_MEMBER_STORY: {
        const nameKeyPart = buildNameKeyPart(element, nodeMapRef);
        const storyKeyPart = buildFirstNodeStoryKeyPart(element, nodeMapRef);
        return nameKeyPart && storyKeyPart ? `${nameKeyPart}|${storyKeyPart}` : null;
      }

      default:
        return null;
    }
  };

  // 属性比較用: 断面の内容シグネチャ（配置一致後に断面差を type 差分として検出する。キャッシュ付き）。
  const resolveSectionContentSignature = (element, nodeMapRef) => {
    if (!sectionMapKey) {
      return null;
    }

    const sectionId = getSectionIdFromElement(element);
    if (!sectionId) {
      return null;
    }

    const sectionMaps = resolveSectionMapsForElement(element, nodeMapRef);
    if (!sectionMaps) {
      return null;
    }

    const cache = sectionMaps === sectionMapsA ? sectionSignatureCacheA : sectionSignatureCacheB;
    const cacheKey = String(sectionId);
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }

    // 対応付け基準とは独立して、対応後の型差分は常に断面の全構成署名で判定する。
    const sectionData = resolveSectionData(element, nodeMapRef);
    const signature = sectionData
      ? buildSectionCompositionSignature(sectionData, elementType)
      : null;
    cache.set(cacheKey, signature);
    return signature;
  };

  return { sectionMapKey, resolveSectionKeyPart, resolveSectionContentSignature };
}
