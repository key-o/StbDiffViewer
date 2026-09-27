/**
 * @fileoverview RC 3D配筋factsのDocument/generation単位キャッシュ。
 *
 * PERF-3では配筋意味を変えず、同じDocument・同じ配筋条件で繰り返される
 * layout/定着/カットオフfacts算定だけを再利用する。DOM編集時はDocument単位で
 * 明示invalidateし、generation keyには配筋結果へ影響する既知の入力だけを含める。
 */

import {
  getRebarCommonConfig,
  getRebarCommonConfigRevision,
} from '../../../config/rebarCommonConfig.js';
import { getRebarProjectDetailingRevision } from '../../../config/rebarProjectDetailing.js';
import { detectStbVersion } from '../../../common-stb/import/parser/utils/versionDetector.js';
import { incrementRebarPerformanceCounter } from '../../../utils/rebarPerformanceMetrics.js';

const MAX_GENERATIONS_PER_DOCUMENT = 8;
let documentCaches = new WeakMap();

function valueToken(value) {
  if (value === null || value === undefined || value === '') return '-';
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : String(value);
}

function booleanToken(value) {
  if (value === true) return '1';
  if (value === false) return '0';
  return '-';
}

/**
 * 配筋factsへ影響する既知の入力だけからstable generation keyを生成する。
 * options全体のJSON.stringifyは行わない。
 */
export function createRebarFactsGenerationKey(xmlDoc, options = {}, context = {}) {
  const commonConfig = getRebarCommonConfig();
  return [
    `doc:${context.documentRevision ?? 'source:0'}`,
    `cover:${valueToken(options.coverMm)}`,
    `columnCover:${valueToken(options.columnCoverMm)}`,
    `supportFacts:${booleanToken(options.includeSupportFacts)}`,
    `common:${getRebarCommonConfigRevision()}`,
    `projectDetailing:${getRebarProjectDetailingRevision()}`,
    `standard:${commonConfig.standardBase || '-'}`,
    `stb:${detectStbVersion(xmlDoc)}`,
  ].join('|');
}

/**
 * モデルsourceごとに別factを保持するためのcache nameを生成する。
 */
export function createModelScopedRebarFactName(factName, modelSource) {
  return `${factName}.${modelSource}`;
}

function getDocumentCache(xmlDoc) {
  let cache = documentCaches.get(xmlDoc);
  if (!cache) {
    cache = { generations: new Map() };
    documentCaches.set(xmlDoc, cache);
  }
  return cache;
}

function pruneGenerations(cache) {
  while (cache.generations.size > MAX_GENERATIONS_PER_DOCUMENT) {
    const oldestKey = cache.generations.keys().next().value;
    cache.generations.delete(oldestKey);
  }
}

function getGenerationCache(xmlDoc, generationKey) {
  const documentCache = getDocumentCache(xmlDoc);
  let generation = documentCache.generations.get(generationKey);
  if (!generation) {
    generation = new Map();
    documentCache.generations.set(generationKey, generation);
    pruneGenerations(documentCache);
  }
  return generation;
}

/**
 * 指定factを取得し、未構築の場合だけbuilderを実行する。
 */
export function getOrBuildRebarFact(xmlDoc, generationKey, factName, builder) {
  if (!xmlDoc || !generationKey || typeof builder !== 'function') {
    return builder?.();
  }

  const generation = getGenerationCache(xmlDoc, generationKey);
  if (generation.has(factName)) {
    incrementRebarPerformanceCounter('cache.rebarFacts.hit.count');
    incrementRebarPerformanceCounter(`cache.rebarFacts.${factName}.hit.count`);
    return generation.get(factName);
  }

  incrementRebarPerformanceCounter('cache.rebarFacts.miss.count');
  incrementRebarPerformanceCounter(`cache.rebarFacts.${factName}.build.count`);
  const value = builder();
  generation.set(factName, value);
  return value;
}

/** Document内の全generationを破棄する。 */
export function invalidateRebarFactsCache(xmlDoc) {
  if (!xmlDoc) return false;
  const existed = documentCaches.delete(xmlDoc);
  if (existed) incrementRebarPerformanceCounter('cache.rebarFacts.invalidate.count');
  return existed;
}

/** 全Documentのcacheを破棄する。モデル再読込/reset向け。 */
export function invalidateAllRebarFactsCaches() {
  documentCaches = new WeakMap();
  incrementRebarPerformanceCounter('cache.rebarFacts.invalidateAll.count');
}

/** unit test/診断用。fact値そのものは公開しない。 */
export function getRebarFactsCacheStats(xmlDoc) {
  const cache = xmlDoc ? documentCaches.get(xmlDoc) : null;
  if (!cache) return { generationCount: 0, factCounts: [] };
  return {
    generationCount: cache.generations.size,
    factCounts: Array.from(cache.generations.entries()).map(([generationKey, facts]) => ({
      generationKey,
      factCount: facts.size,
    })),
  };
}
