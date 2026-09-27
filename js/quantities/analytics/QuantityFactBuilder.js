/**
 * @fileoverview DerivedQuantityStore を集計可能な QuantityFact[] へ正規化する。
 */

import { getSectionFromMap } from '../resolvers/LinearMemberQuantityContext.js';
import {
  QUANTITY_FACT_SOURCE_CONFIG,
  QUANTITY_UNCLASSIFIED,
  QUANTITY_VALUE_MEASURES,
} from './QuantityAnalyticsTypes.js';
import { buildQuantityStoryLookup, resolveQuantityStory } from './QuantityStoryResolver.js';

function normalizeId(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  return String(value);
}

function indexElements(elements) {
  const result = new Map();
  for (const element of elements || []) {
    const id = normalizeId(element?.id);
    if (id && !result.has(id)) result.set(id, element);
  }
  return result;
}

function normalizeMeasureValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sectionName(section) {
  return section?.name || section?.section_name || section?.sectionName || null;
}

function inferKindStructure(element, section) {
  const explicit = String(element?.kind_structure || '')
    .trim()
    .toUpperCase();
  if (explicit) return explicit;

  const sectionType = String(section?.sectionType || '');
  if (/_SRC$/.test(sectionType)) return 'SRC';
  if (/_CFT$/.test(sectionType)) return 'CFT';
  if (/_RC$/.test(sectionType)) return 'RC';
  if (/_S$/.test(sectionType)) return 'S';
  if (/PilePrecast/.test(sectionType)) return 'PC';
  return QUANTITY_UNCLASSIFIED;
}

function resolveOrdinarySection(parsedData, config, element) {
  const section = getSectionFromMap(parsedData?.[config.sectionsKey], element?.id_section);
  return {
    section,
    sectionId: normalizeId(element?.id_section ?? section?.id),
    sectionName: sectionName(section) || QUANTITY_UNCLASSIFIED,
  };
}

function resolveFoundationColumnSection(parsedData, element) {
  const fd = getSectionFromMap(
    parsedData?.foundationColumnSections || parsedData?.columnSections,
    element?.id_section_FD,
  );
  const wr = getSectionFromMap(
    parsedData?.foundationColumnSections || parsedData?.columnSections,
    element?.id_section_WR,
  );
  const fdId = normalizeId(element?.id_section_FD ?? fd?.id);
  const wrId = normalizeId(element?.id_section_WR ?? wr?.id);

  return {
    section: fd || wr || null,
    sectionId: fdId || wrId ? `FD:${fdId || '-'}|WR:${wrId || '-'}` : null,
    sectionName:
      fd || wr
        ? `FD:${sectionName(fd) || '-'}|WR:${sectionName(wr) || '-'}`
        : QUANTITY_UNCLASSIFIED,
    sectionIdFD: fdId,
    sectionIdWR: wrId,
    sectionNameFD: sectionName(fd),
    sectionNameWR: sectionName(wr),
  };
}

function resolveSection(parsedData, config, element) {
  if (config?.compositeFoundationSection) {
    return resolveFoundationColumnSection(parsedData, element);
  }
  if (!config?.sectionsKey) {
    return {
      section: null,
      sectionId: null,
      sectionName: QUANTITY_UNCLASSIFIED,
    };
  }
  return resolveOrdinarySection(parsedData, config, element);
}

function quantityValues(result) {
  const quantity = { count: 1 };
  for (const key of QUANTITY_VALUE_MEASURES) {
    quantity[key] = normalizeMeasureValue(result?.values?.[key]);
  }
  return quantity;
}

/**
 * @param {Object} parsedData parseStbFile の戻り値
 * @param {DerivedQuantityStore} store
 * @param {{modelSide?: string|null, document?: Document|null}} options
 * @returns {Array<Object>}
 */
export function buildQuantityFacts(parsedData, store, { modelSide = null, document = null } = {}) {
  if (!parsedData) throw new TypeError('parsedData is required');
  if (!store || typeof store.values !== 'function') {
    throw new TypeError('store with values() is required');
  }

  const storyLookup = buildQuantityStoryLookup(parsedData, { document });
  const elementIndexes = new Map();
  const indexFor = (elementType, config) => {
    if (!elementIndexes.has(elementType)) {
      elementIndexes.set(elementType, indexElements(parsedData?.[config?.elementsKey] || []));
    }
    return elementIndexes.get(elementType);
  };

  const facts = [];
  for (const result of store.values()) {
    const elementType = result?.identity?.elementType;
    const elementId = normalizeId(result?.identity?.elementId);
    if (!elementType || !elementId) continue;

    const config = QUANTITY_FACT_SOURCE_CONFIG[elementType] || {
      memberCategory: elementType.replace(/^Stb/, '') || QUANTITY_UNCLASSIFIED,
    };
    const element = indexFor(elementType, config).get(elementId) || null;
    const story = resolveQuantityStory(elementType, element, storyLookup);
    const resolvedSection = resolveSection(parsedData, config, element);

    facts.push({
      modelSide,
      elementType,
      elementId,
      guid: result.identity.guid || element?.guid || null,
      storyId: story.storyId,
      storyName: story.storyName,
      storyHeightMm: story.storyHeightMm,
      storyHeightMatchKey: story.storyHeightMatchKey,
      storyResolution: story.resolution,
      memberCategory: config.memberCategory || QUANTITY_UNCLASSIFIED,
      kindStructure: inferKindStructure(element, resolvedSection.section),
      sectionId: resolvedSection.sectionId,
      sectionName: resolvedSection.sectionName,
      ...(resolvedSection.sectionIdFD !== undefined
        ? {
            sectionIdFD: resolvedSection.sectionIdFD,
            sectionIdWR: resolvedSection.sectionIdWR,
            sectionNameFD: resolvedSection.sectionNameFD,
            sectionNameWR: resolvedSection.sectionNameWR,
          }
        : {}),
      status: result.status,
      quantity: quantityValues(result),
      warnings: [...(result.warnings || [])],
    });
  }

  return facts;
}

export default buildQuantityFacts;
