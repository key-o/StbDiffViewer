/**
 * @fileoverview 要素ID単位の大梁あばら筋レイアウトを既存viewerへ接続するアダプター。
 *
 * R13では、日建連2023 §6-4 case1を明示採用した基礎大梁について、既存R11の
 * member-specificあばら筋形状・phaseをそのまま柱内へ継続したworld pathも追加する。
 */

import { getRebarProjectDetailing } from '../../config/rebarProjectDetailing.js';
import {
  createActualBendShearMeshes,
  createAuxiliaryTieMeshes,
  createBeamStirrupMeshes,
  createColumnJointRebarMeshes,
  buildFoundationBeamLowestColumnPassThroughRenderPlan2023,
  createLegacyShearFallbackLayoutMap,
} from '../../viewer/index.js';
import { createTagScanner } from '../../data/extractors/columnSupportUtils.js';
import { buildFoundationBeamTopologyFacts } from '../../data/extractors/rebar3d/foundationBeamTopologyFacts.js';
import { buildFoundationBeamEndpointFacts } from '../../data/extractors/rebar3d/foundationBeamEndpointFacts.js';
import { decorateShearRebarLayoutMap } from '../../data/extractors/rebar3d/shearRebarActualBendDecorator.js';

function extractLowestColumnInteractionFacts(endpointFacts) {
  const beam = new Map();
  for (const [elementId, endpointFact] of endpointFacts?.beam || []) {
    const ends = (endpointFact.ends || [])
      .map((end) => end?.lowestColumnInteraction)
      .filter(Boolean);
    if (!ends.length) continue;
    beam.set(String(elementId), {
      elementId: String(elementId),
      elementName: endpointFact.elementName || null,
      memberTag: endpointFact.memberTag || null,
      sectionId: endpointFact.sectionId || null,
      source: 'R13-foundation-beam-lowest-column-interaction-facts-2023',
      ends,
      resolved: ends.every((end) => end.resolved),
      productionReady: ends.every((end) => end.productionReady),
    });
  }
  return { beam, unresolved: endpointFacts?.unresolved || [] };
}

function resolveLowestColumnInteractionFacts(xmlDoc, options = {}) {
  if (options.foundationBeamLowestColumnInteractionFacts?.beam instanceof Map) {
    return options.foundationBeamLowestColumnInteractionFacts;
  }
  if (!xmlDoc) return null;

  const projectDetailing =
    options.projectDetailing === undefined ? getRebarProjectDetailing() : options.projectDetailing;
  const hasDirectSource = options.lowestColumnInteractionDetailSource === 'STANDARD_2023';
  const hasProjectDetailing =
    projectDetailing &&
    typeof projectDetailing === 'object' &&
    Object.keys(projectDetailing).length > 0;
  if (!hasDirectSource && !hasProjectDetailing) return null;

  const scanTag = createTagScanner(xmlDoc);
  const topologyFacts = buildFoundationBeamTopologyFacts(xmlDoc, scanTag);
  return extractLowestColumnInteractionFacts(
    buildFoundationBeamEndpointFacts(xmlDoc, topologyFacts, {
      ...options,
      scanTag,
      projectDetailing,
      lowestColumnInteractionDetailSource: options.lowestColumnInteractionDetailSource,
    }),
  );
}

function buildLowestColumnPassThroughMeshes(beamElements, nodes, actualLayouts, options = {}) {
  if (actualLayouts?.lookupKey !== 'elementId') return [];
  const interactionFacts = resolveLowestColumnInteractionFacts(options.xmlDoc, options);
  if (!interactionFacts?.beam?.size) return [];

  const renderPlan = buildFoundationBeamLowestColumnPassThroughRenderPlan2023({
    beamElements,
    nodes,
    actualLayouts,
    interactionFacts,
    tessellation: options.tessellation,
  });
  if (!renderPlan.paths.length) return [];
  return createColumnJointRebarMeshes(renderPlan.paths, {
    ...options,
    rebarKind: 'foundationBeamLowestColumnPassThrough',
  });
}

function createMeshes(beamElements, nodes, layoutMap, options) {
  const actualLayouts = decorateShearRebarLayoutMap(layoutMap, { memberType: 'beam' });
  const legacyLayouts = createLegacyShearFallbackLayoutMap(actualLayouts);
  return [
    ...createBeamStirrupMeshes(beamElements, nodes, legacyLayouts, options),
    ...createAuxiliaryTieMeshes(beamElements, nodes, legacyLayouts, {
      ...options,
      memberType: 'beam',
      rebarKind: 'beamStirrupAuxiliary',
    }),
    ...createActualBendShearMeshes(beamElements, nodes, actualLayouts, {
      ...options,
      memberType: 'beam',
      rebarKind: 'beamStirrupActualBend',
    }),
    ...buildLowestColumnPassThroughMeshes(beamElements, nodes, actualLayouts, options),
  ];
}

/**
 * 大梁の要素ID単位レイアウトを、既存の断面ID lookup APIへ載せ替えて描画する。
 * 小梁など従来の断面ID単位マップはそのまま委譲する。
 * @param {Array<Object>} beamElements - 梁要素配列
 * @param {Map<string, Object>} nodes - ノードマップ
 * @param {Map<string, Object>} layoutMap - レイアウトマップ
 * @param {Object} [options] - 描画設定
 * @returns {Array<Object>} 生成メッシュ
 */
export function createBeamStirrupMemberMeshes(beamElements, nodes, layoutMap, options = {}) {
  if (layoutMap?.lookupKey !== 'elementId') {
    return createMeshes(beamElements, nodes, layoutMap, options);
  }

  const memberKeyedElements = (beamElements || []).map((element) => ({
    ...element,
    id_section: element.id,
  }));
  return createMeshes(memberKeyedElements, nodes, layoutMap, options);
}

export const _beamStirrupDisplayAdapterInternals = Object.freeze({
  extractLowestColumnInteractionFacts,
  resolveLowestColumnInteractionFacts,
  buildLowestColumnPassThroughMeshes,
  createMeshes,
});
