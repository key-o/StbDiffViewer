/**
 * @fileoverview 数量分析コアで共有する dimension / measure / member contract。
 */

export const QUANTITY_UNCLASSIFIED = '未分類';

export const QUANTITY_DIMENSIONS = Object.freeze([
  'modelSide',
  'elementType',
  'elementId',
  'guid',
  'storyId',
  'storyName',
  'storyHeightMm',
  'storyHeightMatchKey',
  'memberCategory',
  'kindStructure',
  'sectionId',
  'sectionName',
  'status',
]);

export const QUANTITY_MEASURES = Object.freeze([
  'count',
  'lengthMm',
  'surfaceAreaMm2',
  'grossVolumeMm3',
  'netVolumeMm3',
  'concreteVolumeMm3',
  'structuralSteelVolumeMm3',
]);

export const QUANTITY_VALUE_MEASURES = Object.freeze(
  QUANTITY_MEASURES.filter((measure) => measure !== 'count'),
);

/**
 * DerivedQuantityStore の elementType と parseStbFile の配列 / 断面 map を結ぶ。
 * UI や Three.js に依存させない。
 */
export const QUANTITY_FACT_SOURCE_CONFIG = Object.freeze({
  StbColumn: Object.freeze({
    elementsKey: 'columnElements',
    sectionsKey: 'columnSections',
    memberCategory: 'Column',
  }),
  StbPost: Object.freeze({
    elementsKey: 'postElements',
    sectionsKey: 'postSections',
    memberCategory: 'Post',
  }),
  StbGirder: Object.freeze({
    elementsKey: 'girderElements',
    sectionsKey: 'girderSections',
    memberCategory: 'Girder',
  }),
  StbBeam: Object.freeze({
    elementsKey: 'beamElements',
    sectionsKey: 'beamSections',
    memberCategory: 'Beam',
  }),
  StbBrace: Object.freeze({
    elementsKey: 'braceElements',
    sectionsKey: 'braceSections',
    memberCategory: 'Brace',
  }),
  StbFoundationColumn: Object.freeze({
    elementsKey: 'foundationColumnElements',
    memberCategory: 'FoundationColumn',
    compositeFoundationSection: true,
  }),
  StbSlab: Object.freeze({
    elementsKey: 'slabElements',
    sectionsKey: 'slabSections',
    memberCategory: 'Slab',
  }),
  StbWall: Object.freeze({
    elementsKey: 'wallElements',
    sectionsKey: 'wallSections',
    memberCategory: 'Wall',
  }),
  StbParapet: Object.freeze({
    elementsKey: 'parapetElements',
    sectionsKey: 'parapetSections',
    memberCategory: 'Parapet',
  }),
  StbFooting: Object.freeze({
    elementsKey: 'footingElements',
    sectionsKey: 'footingSections',
    memberCategory: 'Footing',
  }),
  StbStripFooting: Object.freeze({
    elementsKey: 'stripFootingElements',
    sectionsKey: 'footingSections',
    memberCategory: 'StripFooting',
  }),
  StbPile: Object.freeze({
    elementsKey: 'pileElements',
    sectionsKey: 'pileSections',
    memberCategory: 'Pile',
  }),
});

export default {
  QUANTITY_UNCLASSIFIED,
  QUANTITY_DIMENSIONS,
  QUANTITY_MEASURES,
  QUANTITY_VALUE_MEASURES,
  QUANTITY_FACT_SOURCE_CONFIG,
};
