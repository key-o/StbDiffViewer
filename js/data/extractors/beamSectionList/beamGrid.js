/**
 * @fileoverview RC梁断面リストのグリッド構築と公開エントリ
 *
 * 梁(StbGirder)と階の対応から「階×符号」グリッドを構築する。バージョン検出・断面詳細抽出は
 * それぞれ stbVersionDetection / sectionDetail に委譲する。
 */

import {
  isVersion21x,
  isVersion202,
} from '../../../common-stb/import/parser/utils/stbVersionDetection.js';
import { STB_TAG_NAMES } from '../../../constants/elementTypes.js';
import {
  querySelectorAll,
  extractStories,
  compareStoriesDescending,
  extractBaseSymbol,
  compareSymbols,
} from '../sectionListUtils.js';
import { extractRcBeamSectionDetail } from './sectionDetail.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('data:extractors:beamSectionListExtractor');

/**
 * StbGirder一覧を抽出（梁要素）
 * @param {Document} xmlDoc - XMLドキュメント
 * @returns {Array<Object>} 梁要素情報配列
 */
function extractGirders(xmlDoc) {
  const girders = [];
  const girderElements = querySelectorAll(xmlDoc, STB_TAG_NAMES.GIRDER);

  girderElements.forEach((el) => {
    const id = el.getAttribute('id');
    const idSection = el.getAttribute('id_section');
    const name = el.getAttribute('name');
    const idNodeStart = el.getAttribute('id_node_start');
    const idNodeEnd = el.getAttribute('id_node_end');

    if (id && idSection) {
      girders.push({
        id,
        idSection,
        name,
        idNodeStart,
        idNodeEnd,
      });
    }
  });

  return girders;
}

/**
 * 梁が属する階を取得
 * @param {Object} girder - 梁情報
 * @param {Map<string, Object>} stories - Story情報マップ
 * @returns {Array<string>} 階IDの配列
 */
function getStoryIdsForGirder(girder, stories) {
  const startStoryIds = [];
  const endStoryIds = [];

  // 梁は通常同一階内の部材として扱うため、開始ノード側を優先して1階に割り当てる。
  stories.forEach((story, storyId) => {
    if (story.nodeIds.has(girder.idNodeStart)) {
      startStoryIds.push(storyId);
    }
    if (story.nodeIds.has(girder.idNodeEnd)) {
      endStoryIds.push(storyId);
    }
  });

  if (startStoryIds.length > 0) {
    return [startStoryIds[0]];
  }
  if (endStoryIds.length > 0) {
    return [endStoryIds[0]];
  }

  return [];
}

/**
 * STBファイルからRC梁断面リストをグリッド形式で抽出
 *
 * @param {Document} xmlDoc - STB XMLドキュメント
 * @returns {Object} { stories: Array, symbols: Array, grid: Map }
 *   - stories: { id, name, level } の配列（level降順）
 *   - symbols: 符号の配列（自然順ソート）
 *   - grid: Map<"階ID:符号", BeamSectionData>
 */
export function extractBeamSectionGrid(xmlDoc) {
  if (!xmlDoc) {
    log.warn('[extractBeamSectionGrid] xmlDoc is null or undefined');
    return {
      stories: [],
      symbols: [],
      grid: new Map(),
    };
  }

  log.info('[extractBeamSectionGrid] Starting extraction...');

  // バージョンを検出
  const isV210 = isVersion21x(xmlDoc);
  const isV202 = isVersion202(xmlDoc);

  log.info('[extractBeamSectionGrid] STB Version detected:', { isV210, isV202 });

  // バージョンラベルと断面セレクタを決定
  let parserVersion;
  let sectionSelectors;
  if (isV210) {
    parserVersion = 'v2.1.0';
    sectionSelectors = ['StbSecBeam_RC'];
  } else if (isV202) {
    parserVersion = 'v2.0.2';
    sectionSelectors = ['StbSecBeam_RC', 'StbSecGirder_RC'];
  } else {
    log.warn('[extractBeamSectionGrid] Unknown STB version, using fallback parser');
    parserVersion = 'fallback';
    sectionSelectors = ['StbSecBeam_RC', 'StbSecGirder_RC'];
  }

  log.info(`[extractBeamSectionGrid] Extracting with ${parserVersion} parser`);

  // 1. 階データを抽出
  const storiesMap = extractStories(xmlDoc);
  const storiesList = Array.from(storiesMap.values()).sort(compareStoriesDescending);
  log.info(`[extractBeamSectionGrid] (${parserVersion}) Stories extracted:`, storiesList.length);

  // 2. 梁要素を抽出
  const girders = extractGirders(xmlDoc);
  log.info(`[extractBeamSectionGrid] (${parserVersion}) Girders extracted:`, girders.length);

  // 3. 梁断面を抽出
  const beamSectionElements = sectionSelectors.flatMap((sel) => querySelectorAll(xmlDoc, sel));
  log.info(
    `[extractBeamSectionGrid] (${parserVersion}) Beam section elements found:`,
    beamSectionElements.length,
  );

  const sectionsMap = new Map();
  beamSectionElements.forEach((el) => {
    const id = el.getAttribute('id');
    if (id) {
      const detail = extractRcBeamSectionDetail(el);
      sectionsMap.set(id, detail);
      log.debug(`[extractBeamSectionGrid] (${parserVersion}) Section extracted:`, id, detail.name);
    }
  });

  // 4. グリッド構築
  return buildBeamSectionGrid(xmlDoc, storiesMap, storiesList, girders, sectionsMap, parserVersion);
}

/**
 * ビーム断面グリッドを構築
 * @param {Document} xmlDoc - XMLドキュメント
 * @param {Map} storiesMap - 階マップ
 * @param {Array} storiesList - 階リスト
 * @param {Array} girders - 梁要素リスト
 * @param {Map} sectionsMap - 断面マップ
 * @param {string} parserVersion - パーサーバージョン
 */
function buildBeamSectionGrid(
  xmlDoc,
  storiesMap,
  storiesList,
  girders,
  sectionsMap,
  parserVersion,
) {
  // 梁-階マッピング
  const sectionUsageMap = new Map(); // sectionId → [{ storyId, symbol, ... }]

  girders.forEach((girder) => {
    const storyIds = getStoryIdsForGirder(girder, storiesMap);
    const sectionDetail = sectionsMap.get(girder.idSection);
    const symbolSource = sectionDetail?.name || girder.name;
    const symbol = extractBaseSymbol(symbolSource, { mode: 'beam' });

    storyIds.forEach((storyId) => {
      if (!sectionUsageMap.has(girder.idSection)) {
        sectionUsageMap.set(girder.idSection, []);
      }
      sectionUsageMap.get(girder.idSection).push({
        storyId,
        symbol,
      });
    });
  });

  // グリッドデータを構築
  const grid = new Map();
  const symbolSet = new Set();

  log.info(
    `[buildBeamSectionGrid] (${parserVersion}) Section usage entries:`,
    sectionUsageMap.size,
  );

  sectionUsageMap.forEach((usages, sectionId) => {
    const sectionData = sectionsMap.get(sectionId);
    if (!sectionData) {
      log.warn(`[buildBeamSectionGrid] (${parserVersion}) Section data not found for:`, sectionId);
      return;
    }

    usages.forEach(({ storyId, symbol }) => {
      const story = storiesMap.get(storyId);
      if (!story) {
        log.warn(`[buildBeamSectionGrid] (${parserVersion}) Story not found for:`, storyId);
        return;
      }

      const key = `${storyId}:${symbol}`;
      const cellData = {
        sectionId,
        storyId,
        storyName: story.name,
        storyLevel: story.level,
        symbol,
        symbolNames: `${story.name}${symbol}`, // 例："3F G1"
        beamType: sectionData.beamType,
        positionPattern: sectionData.positionPattern,
        positions: sectionData.positions,
        concrete: sectionData.concrete,
        cover: sectionData.cover,
      };

      const existingCell = grid.get(key);
      if (!existingCell) {
        grid.set(key, cellData);
      } else {
        const variants = Array.isArray(existingCell) ? existingCell : [existingCell];
        const alreadyRegistered = variants.some((variant) => variant.sectionId === sectionId);

        if (!alreadyRegistered) {
          variants.push(cellData);
          grid.set(key, variants);
          log.warn(
            `[buildBeamSectionGrid] (${parserVersion}) Multiple sections detected in same cell:`,
            key,
            variants.map((variant) => variant.sectionId),
          );
        }
      }

      symbolSet.add(symbol);
      log.debug(`[buildBeamSectionGrid] (${parserVersion}) Grid cell added:`, key);
    });
  });

  // 符号を自然順でソート
  const symbols = Array.from(symbolSet).sort(compareSymbols);

  log.info(`[buildBeamSectionGrid] (${parserVersion}) Final result:`, {
    storiesCount: storiesList.length,
    symbolsCount: symbols.length,
    gridSize: grid.size,
  });

  return {
    stories: storiesList,
    symbols,
    grid,
  };
}

/**
 * リスト形式でRC梁断面を抽出（階別・符号別）
 *
 * @param {Document} xmlDoc - STB XMLドキュメント
 * @returns {Object} { sections: Array<BeamSectionRow> }
 */
export function extractBeamSectionList(xmlDoc) {
  const gridData = extractBeamSectionGrid(xmlDoc);
  const sections = [];

  // グリッドデータをリスト形式に変換
  // 階を降順、符号を昇順でソート
  const rows = Array.from(gridData.grid.values())
    .flatMap((cell) => (Array.isArray(cell) ? cell : [cell]))
    .sort((a, b) => {
      const storyComp = compareStoriesDescending(
        { level: a.storyLevel, name: a.storyName },
        { level: b.storyLevel, name: b.storyName },
      );
      if (storyComp !== 0) return storyComp;
      return compareSymbols(a.symbol, b.symbol);
    });

  sections.push(...rows);

  return {
    sections,
  };
}
