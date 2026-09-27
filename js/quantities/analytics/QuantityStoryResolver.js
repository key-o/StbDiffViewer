/**
 * @fileoverview 数量集計用の所属階 resolver。
 *
 * section.floor は部材リスト用補助属性のため正本とせず、
 * StbStory.StbNodeIdList と部材配置節点から所属階を解決する。
 */

import { parseStories } from '../../common-stb/import/parser/stbParserCore.js';
import { buildStoryHeightMatchKey } from '../../config/comparisonKeyConfig.js';
import { QUANTITY_UNCLASSIFIED } from './QuantityAnalyticsTypes.js';

const PRIMARY_NODE_RULES = Object.freeze({
  StbColumn: (element) => [element?.id_node_bottom],
  StbPost: (element) => [element?.id_node_bottom],
  StbGirder: (element) => [element?.id_node_start],
  StbBeam: (element) => [element?.id_node_start],
  StbBrace: (element) => [element?.id_node_start],
  StbFoundationColumn: (element) => [element?.id_node],
  StbSlab: (element) => [element?.node_ids?.[0]],
  // StbWall の階解決は ST-Bridge の concrete-strength fallback と同様、
  // NodeIdOrder の最終節点を代表節点とする。
  StbWall: (element) => {
    const ids = element?.node_ids || [];
    return [ids.length > 0 ? ids[ids.length - 1] : null];
  },
  StbParapet: (element) => [element?.id_node_start],
  StbFooting: (element) => [element?.id_node],
  StbStripFooting: (element) => [element?.id_node_start],
  StbPile: (element) => [element?.id_node, element?.id_node_top],
});

function normalizeNodeId(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  return String(value);
}

function storiesWithNodeIds(parsedData, document) {
  const parsedStories = Array.isArray(parsedData?.stories) ? parsedData.stories : [];
  if (parsedStories.length > 0 && parsedStories.every((story) => Array.isArray(story?.node_ids))) {
    return parsedStories;
  }
  if (document) {
    const parsedFromDocument = parseStories(document, { includeNodeIds: true });
    if (parsedFromDocument.length > 0) return parsedFromDocument;

    // parseStories の namespace 前提に合わないテスト/変換ドキュメントでも
    // Quantity analytics 自体は fail-open に推測せず、DOM から明示的な
    // StbStory / StbNodeIdList だけを読み直す。
    const storyNodes = Array.from(document.getElementsByTagName?.('StbStory') || []);
    return storyNodes.map((story) => ({
      id: story.getAttribute?.('id') || null,
      name: story.getAttribute?.('name') || null,
      height: Number(story.getAttribute?.('height')),
      kind: story.getAttribute?.('kind') || 'GENERAL',
      node_ids: Array.from(story.getElementsByTagName?.('StbNodeId') || [])
        .map((node) => node.getAttribute?.('id'))
        .filter(Boolean),
    }));
  }
  return parsedStories;
}

/**
 * @returns {{stories: Array<Object>, byNodeId: Map<string, Array<Object>>}}
 */
export function buildQuantityStoryLookup(parsedData, { document = null } = {}) {
  const stories = storiesWithNodeIds(parsedData, document);
  const byNodeId = new Map();

  for (const story of stories) {
    for (const rawNodeId of story?.node_ids || []) {
      const nodeId = normalizeNodeId(rawNodeId);
      if (!nodeId) continue;
      if (!byNodeId.has(nodeId)) byNodeId.set(nodeId, []);
      const candidates = byNodeId.get(nodeId);
      const storyKey = String(story?.id ?? story?.name ?? '');
      if (
        !candidates.some((candidate) => String(candidate?.id ?? candidate?.name ?? '') === storyKey)
      ) {
        candidates.push(story);
      }
    }
  }

  return { stories, byNodeId };
}

function uniqueStoryForNode(lookup, rawNodeId) {
  const nodeId = normalizeNodeId(rawNodeId);
  if (!nodeId) return null;
  const candidates = lookup?.byNodeId?.get(nodeId) || [];
  if (candidates.length !== 1) return null;
  return candidates[0];
}

function normalizeStoryHeight(story) {
  const raw = story?.height;
  if (raw === null || raw === undefined || raw === '') return null;
  const height = Number(raw);
  return Number.isFinite(height) ? height : null;
}

/**
 * @returns {{storyId: string|null, storyName: string, storyHeightMm: number|null, storyHeightMatchKey: string|null, resolution: string}}
 */
export function resolveQuantityStory(elementType, element, lookup) {
  const resolver = PRIMARY_NODE_RULES[elementType];
  const candidateNodeIds = resolver ? resolver(element) : [];

  for (const nodeId of candidateNodeIds) {
    const story = uniqueStoryForNode(lookup, nodeId);
    if (!story) continue;
    const storyHeightMm = normalizeStoryHeight(story);
    return {
      storyId:
        story.id === null || story.id === undefined || String(story.id).trim() === ''
          ? null
          : String(story.id),
      storyName: story.name || QUANTITY_UNCLASSIFIED,
      storyHeightMm,
      storyHeightMatchKey: buildStoryHeightMatchKey(storyHeightMm),
      resolution: 'PLACEMENT_NODE',
    };
  }

  return {
    storyId: null,
    storyName: QUANTITY_UNCLASSIFIED,
    storyHeightMm: null,
    storyHeightMatchKey: null,
    resolution: 'UNRESOLVED',
  };
}

export default {
  buildQuantityStoryLookup,
  resolveQuantityStory,
};
