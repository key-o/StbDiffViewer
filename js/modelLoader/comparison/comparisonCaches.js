/**
 * @fileoverview 比較用キャッシュ（断面抽出・階/通り芯ルックアップ）の唯一の保持モジュール
 *
 * ドキュメント（XML Document）をキーとする WeakMap をここだけで保持する。
 * 他モジュールは必ず本モジュール経由でキャッシュへアクセスすること。
 * キャッシュを複数モジュールへ複製すると、編集後の無効化が行き渡らず
 * 比較結果が壊れる。
 *
 * @module modelLoader/comparison/comparisonCaches
 */

import { buildNodeStoryAxisLookup } from '../../common-stb/import/parser/stbXmlParser.js';
import { extractAllSections } from '../../common-stb/import/extractor/sectionExtractor.js';

const extractedSectionsCache = new WeakMap();
const storyAxisLookupCache = new WeakMap();

/**
 * 指定ドキュメントの比較用キャッシュ（断面抽出・階/通り芯ルックアップ）を無効化する。
 * XMLドキュメントを編集した後、再比較の前に呼び出すこと。
 * @param {Document} document - 編集されたXMLドキュメント
 */
export function invalidateComparisonCachesForDocument(document) {
  if (!document) return;
  extractedSectionsCache.delete(document);
  storyAxisLookupCache.delete(document);
}

/**
 * ドキュメントの断面抽出結果をキャッシュ付きで取得する。
 * @param {Document} document - STB XMLドキュメント
 * @returns {Object|null} 抽出済み断面マップ群
 */
export function getCachedExtractedSections(document) {
  if (!document) return null;
  if (extractedSectionsCache.has(document)) {
    return extractedSectionsCache.get(document);
  }

  const extractedSections = extractAllSections(document);
  extractedSectionsCache.set(document, extractedSections);
  return extractedSections;
}

/**
 * ドキュメントの節点→階/通り芯ルックアップをキャッシュ付きで取得する。
 * @param {Document} document - STB XMLドキュメント
 * @returns {Map} 節点IDをキーとしたルックアップ
 */
export function getCachedStoryAxisLookup(document) {
  if (!document) return new Map();
  if (storyAxisLookupCache.has(document)) {
    return storyAxisLookupCache.get(document);
  }

  const lookup = buildNodeStoryAxisLookup(document);
  storyAxisLookupCache.set(document, lookup);
  return lookup;
}
