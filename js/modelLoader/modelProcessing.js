/**
 * @fileoverview モデル文書処理モジュール
 *
 * STBモデル文書の読み込み・解析・断面抽出を行う純粋な変換層。
 * globalState への書き込みは行わない（呼び出し元が担当）。
 */

import { loadStbXmlAutoEncoding } from '../common-stb/import/loader/stbXmlLoader.js';
import { buildNodeMap, parseStories, parseAxes } from '../common-stb/import/parser/stbXmlParser.js';
import { extractAllSections } from '../common-stb/import/extractor/sectionExtractor.js';
import {
  detectStbVersion,
  getVersionInfo,
} from '../common-stb/import/parser/utils/versionDetector.js';
import {
  loadJsonSchemaForVersion,
  setActiveVersion,
  isVersionLoaded,
} from '../common-stb/import/parser/jsonSchemaLoader.js';
import { parseStbCalData } from '../common-stb/import/extractor/StbCalDataExtractor.js';
import { getLoaderSetState } from './loaderDependencies.js';
import { createEmptyElementData, createEmptySectionMaps } from '../data/state/modelStateFactory.js';

/**
 * Process model documents and extract structural data.
 * When both files are provided, they are parsed in parallel using Promise.all.
 * Throws on failure (caller should catch).
 * @param {File|null} fileA - Model A file
 * @param {File|null} fileB - Model B file
 * @returns {Promise<Object>} Processing result with model data
 * @throws {TypeError} If fileA or fileB is provided but not a File object
 * @throws {Error} If both fileA and fileB are null or processing fails
 */
export async function processModelDocuments(fileA, fileB) {
  if (fileA !== null && !(fileA instanceof File)) {
    throw new TypeError('fileA must be a File object if provided');
  }
  if (fileB !== null && !(fileB instanceof File)) {
    throw new TypeError('fileB must be a File object if provided');
  }
  if (fileA === null && fileB === null) {
    throw new Error('At least one model file (fileA or fileB) must be provided');
  }

  // Process Model A and B in parallel when both are provided
  const [resultA, resultB] = await Promise.all([
    fileA ? processModelFile(fileA) : Promise.resolve(null),
    fileB ? processModelFile(fileB) : Promise.resolve(null),
  ]);

  // Use Model A's stories/axes, or fall back to Model B's
  const primaryResult = resultA || resultB;
  let stories = [...primaryResult.stories];
  const axesData = primaryResult.axesData;

  // Merge stories from both models and deduplicate by height
  if (resultA && resultB) {
    const uniqueStoriesMap = new Map();
    for (const s of resultA.stories) uniqueStoriesMap.set(s.height, s);
    for (const s of resultB.stories) uniqueStoriesMap.set(s.height, s);
    stories = Array.from(uniqueStoriesMap.values()).sort((a, b) => a.height - b.height);
  }

  // Merge section maps.
  // NOTE: resultA.sectionMaps / resultB.sectionMaps are the exact Map instances
  // held by extractAllSections' per-document WeakMap cache, and those same
  // instances are returned again later by parseStbFile() for solid mesh
  // generation. Merging MUST NOT mutate them in place, or Model B's section
  // definitions would overwrite Model A's at any colliding id_section and
  // corrupt Model A's rendered geometry (notably RC/rectangular sections, which
  // have no steel-dimension repair path). Build a fresh merged object instead.
  const sectionMaps = mergeSectionMaps(resultA?.sectionMaps, resultB?.sectionMaps);

  // Build version info
  const versionA = resultA?.version || null;
  const versionB = resultB?.version || null;
  const supportedSchemaVersions = new Set(['2.0.2', '2.1.0', '2.1.1']);
  const schemaVersions = [
    ...new Set([versionA, versionB].filter((version) => supportedSchemaVersions.has(version))),
  ];
  if (schemaVersions.length > 0) {
    await Promise.all(schemaVersions.map((version) => loadJsonSchemaForVersion(version)));
    const activeVersion = schemaVersions.find((version) => isVersionLoaded(version));
    if (activeVersion) setActiveVersion(activeVersion);
  }
  const versionInfo = {
    versionA: versionA || 'unknown',
    versionB: versionB || 'unknown',
    hasModelA: Boolean(resultA),
    hasModelB: Boolean(resultB),
    isCrossVersion: versionA && versionB && versionA !== versionB,
    sourceTypeA: resultA?.sourceType || 'stb',
    sourceTypeB: resultB?.sourceType || 'stb',
    ifcSchemaA: resultA?.ifcSchema || null,
    ifcSchemaB: resultB?.ifcSchema || null,
  };

  return {
    modelADocument: resultA?.document || null,
    modelBDocument: resultB?.document || null,
    nodeMapA: resultA?.nodeMap || new Map(),
    nodeMapB: resultB?.nodeMap || new Map(),
    stories,
    axesData,
    sectionMaps,
    versionInfo,
    calDataA: resultA?.calData || null,
    calDataB: resultB?.calData || null,
  };
}

/**
 * ファイルがIFC形式かどうかを判定
 * @param {File} file - チェック対象ファイル
 * @returns {boolean}
 */
function isIfcFile(file) {
  return file.name.toLowerCase().endsWith('.ifc');
}

/**
 * Process a single model file (pure transformation, no side effects)
 * Supports STB (XML) and IFC files.
 * All importers return a unified ImportResult: { document, metadata }.
 * @param {File} file - Model file to process
 * @returns {Promise<Object>} Processing result for single model
 */
async function processModelFile(file) {
  /** @type {import('../common-stb/import/constants/importTypes.js').ImportResult} */
  let importResult;

  if (isIfcFile(file)) {
    const { convertIfcToStbDocument } = await import('../common-ifc/IfcToStbBridge.js');
    importResult = await convertIfcToStbDocument(file);
  } else {
    importResult = await loadStbXmlAutoEncoding(file);
  }

  const { document, metadata } = importResult;

  if (!document) {
    throw new Error('モデルファイルの解析に失敗しました。');
  }

  return {
    document,
    nodeMap: buildNodeMap(document),
    stories: parseStories(document),
    axesData: parseAxes(document),
    sectionMaps: extractAllSections(document),
    calData: metadata.calData || parseStbCalData(document),
    version: detectStbVersion(document),
    versionInfo: getVersionInfo(document),
    sourceType: metadata.sourceType,
    ifcSchema: metadata.ifcSchema || null,
  };
}

/**
 * Clear model processing state
 */
export function clearModelProcessingState() {
  const setState = getLoaderSetState();
  setState('models.documentA', null);
  setState('models.documentB', null);
  setState('models.nodeMapA', new Map());
  setState('models.nodeMapB', new Map());
  setState('models.nodeMapRawA', new Map());
  setState('models.nodeMapRawB', new Map());
  setState('models.stories', []);
  setState('models.axesData', { xAxes: [], yAxes: [] });
  setState('models.sectionMaps', createEmptySectionMaps());
  setState('models.steelSections', new Map());
  setState('models.elementData', createEmptyElementData());
  setState('models.derivedQuantitiesA', null);
  setState('models.derivedQuantitiesB', null);
  setState('models.quantityFactsA', null);
  setState('models.quantityFactsB', null);
  setState('models.modelsLoaded', false);
  setState('models.modelBounds', null);
  setState('sectionsData', null);
  setState('models.versionInfo', null);
  setState('models.stbVersionA', null);
  setState('models.stbVersionB', null);
  setState('models.activeXsdVersion', null);
  setState('models.calDataA', null);
  setState('models.calDataB', null);
}

/**
 * Merge section maps from two models into a brand-new object with fresh Maps.
 * Non-destructive: the input maps (which are shared by reference with the
 * per-document extract cache and, through it, with mesh generation) are never
 * mutated. On id_section collision, Model B wins, preserving the previous
 * merge semantics for the label / section-tree consumers of the returned map.
 * @param {Object} [mapsA] - Model A section maps
 * @param {Object} [mapsB] - Model B section maps
 * @returns {Object} Newly allocated merged section maps
 */
function mergeSectionMaps(mapsA, mapsB) {
  const merged = {};
  for (const source of [mapsA, mapsB]) {
    if (!source) continue;
    for (const [sectionType, sourceMap] of Object.entries(source)) {
      if (!sourceMap || typeof sourceMap.forEach !== 'function') continue;
      if (!merged[sectionType]) {
        merged[sectionType] = new Map();
      }
      sourceMap.forEach((value, key) => {
        merged[sectionType].set(key, value);
      });
    }
  }
  return merged;
}
