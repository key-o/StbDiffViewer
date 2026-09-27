/**
 * @fileoverview R13 基礎梁端の topology / 主筋 / あばら筋 / 基礎取合い facts を共通endpoint factへ統合する。
 *
 * source facts間で side / node が一致しない場合は fail-closed とする。
 * mainBarFactsをこの関数内で生成する通常経路では、日建連2023標準図のうち一意化済みの
 * 基礎大梁定着 requirement をbar factsへ付加してからendpointへ統合する。
 *
 * §6-3 基礎梁-基礎取合いと §6-4 基礎大梁-最下階柱取合いは read-only facts として接続する。
 * requirement / material / symbolic planが解決しても world RebarPath 未生成の間は既存
 * stirrup production gate をREADYへ進めない。
 *
 * @module data/extractors/rebar3d/foundationBeamEndpointFacts
 */

import { createTagScanner, findElementById } from '../columnSupportUtils.js';
import { applyFoundationBeamAnchorageRequirements2023 } from './foundationBeamAnchorageRequirementFacts2023.js';
import { buildFoundationBeamEndBarFacts } from './foundationBeamEndBarFacts.js';
import { resolveFoundationBeamEndpointProductionGate } from './foundationBeamEndpointProductionGate.js';
import { resolveFoundationBeamFoundationInteractionFacts2023 } from './foundationBeamFoundationInteractionFacts2023.js';
import { buildFoundationBeamLowestColumnInteractionFacts2023 } from './foundationBeamLowestColumnInteractionFacts2023.js';
import { buildFoundationBeamStirrupFacts } from './foundationBeamStirrupFacts.js';

function bySide(ends) {
  const result = new Map();
  for (const end of ends || []) {
    if (!['start', 'end'].includes(end?.side)) continue;
    if (!result.has(end.side)) result.set(end.side, end);
  }
  return result;
}

function sameNodeId(expected, actual) {
  if (expected === null || expected === undefined || expected === '') return false;
  if (actual === null || actual === undefined || actual === '') return false;
  return String(expected) === String(actual);
}

function endpointReasons(topologyEnd, mainBarEnd, stirrupEnd) {
  const reasons = [];
  if (!topologyEnd?.resolved) {
    reasons.push('foundation-beam-end-topology-unresolved');
    reasons.push(...(topologyEnd?.reasons || []));
  }
  if (!mainBarEnd) reasons.push('foundation-beam-main-bar-end-missing');
  else if (!mainBarEnd.resolved)
    reasons.push(mainBarEnd.reason || 'foundation-beam-main-bar-unresolved');
  if (!stirrupEnd) reasons.push('foundation-beam-stirrup-end-missing');
  else if (!stirrupEnd.resolved)
    reasons.push(stirrupEnd.reason || 'foundation-beam-stirrup-unresolved');

  if (mainBarEnd && topologyEnd?.nodeId && !sameNodeId(topologyEnd.nodeId, mainBarEnd.nodeId)) {
    reasons.push('foundation-beam-main-bar-node-mismatch');
  }
  if (stirrupEnd && topologyEnd?.nodeId && !sameNodeId(topologyEnd.nodeId, stirrupEnd.nodeId)) {
    reasons.push('foundation-beam-stirrup-node-mismatch');
  }

  return [...new Set(reasons)];
}

function unresolvedInteractionBlocker(interaction, fallback) {
  if (!interaction) return null;
  if (interaction.interactionRequirementResolved !== true) {
    return interaction.reason || fallback;
  }
  if (interaction.productionReady !== true) {
    return interaction.productionBlockers?.[0] || fallback;
  }
  return null;
}

function interactionBlocker(foundationInteraction, lowestColumnInteraction, stirrupEnd) {
  const foundationBlocker = unresolvedInteractionBlocker(
    foundationInteraction,
    'foundation-interaction-figure-6-3-world-path-not-encoded',
  );
  if (foundationBlocker) return foundationBlocker;
  const lowestColumnBlocker = unresolvedInteractionBlocker(
    lowestColumnInteraction,
    'foundation-lowest-column-pass-through-world-loop-unresolved',
  );
  if (lowestColumnBlocker) return lowestColumnBlocker;
  return stirrupEnd?.interactionRequirementReason || null;
}

function combineEndpoint(
  topologyEnd,
  mainBarEnd,
  stirrupEnd,
  foundationInteraction = null,
  lowestColumnInteraction = null,
) {
  const reasons = endpointReasons(topologyEnd, mainBarEnd, stirrupEnd);
  const factsResolved = reasons.length === 0;
  const anchorageRequirementResolved = mainBarEnd?.anchorageRequirementResolved === true;
  const stirrupInteractionRequirementResolved = stirrupEnd?.interactionRequirementResolved === true;
  const foundationInteractionRequirementResolved =
    foundationInteraction?.interactionRequirementResolved === true;
  const lowestColumnInteractionRequirementResolved =
    lowestColumnInteraction?.interactionRequirementResolved === true;

  const endpoint = {
    side: topologyEnd?.side || mainBarEnd?.side || stirrupEnd?.side || null,
    nodeId: topologyEnd?.nodeId || mainBarEnd?.nodeId || stirrupEnd?.nodeId || null,
    primaryContext:
      topologyEnd?.primaryContext ||
      mainBarEnd?.primaryContext ||
      stirrupEnd?.primaryContext ||
      'UNRESOLVED',
    resolved: factsResolved,
    reasons,
    source: 'R13-foundation-beam-endpoint-facts',
    topologyResolved: topologyEnd?.resolved === true,
    mainBarFactsResolved: mainBarEnd?.resolved === true,
    stirrupFactsResolved: stirrupEnd?.resolved === true,
    mainBars: [...(mainBarEnd?.bars || [])],
    availableProjectionMm: Number.isFinite(mainBarEnd?.availableProjectionMm)
      ? mainBarEnd.availableProjectionMm
      : null,
    supportGeometry: mainBarEnd?.geometry || null,
    anchorageType: mainBarEnd?.anchorageType || null,
    anchorageTypeResolved: mainBarEnd?.anchorageTypeResolved === true,
    anchorageTypeResolution: mainBarEnd?.anchorageTypeResolution || null,
    upliftResolution: mainBarEnd?.upliftResolution || null,
    foundationSystemResolution: mainBarEnd?.foundationSystemResolution || null,
    anchorageRequirementResolutions: [...(mainBarEnd?.anchorageRequirementResolutions || [])],
    anchorageRequirementResolved,
    anchorageRequirementReason: mainBarEnd?.anchorageRequirementReason || null,
    stirrup: stirrupEnd?.stirrup || null,
    foundationInteraction,
    foundationInteractionResolved: foundationInteraction?.resolved === true,
    foundationInteractionRequirementResolved,
    foundationInteractionMaterialFactsResolved:
      foundationInteraction?.materialFactsResolved === true,
    foundationInteractionLengthPlanResolved: foundationInteraction?.lengthPlanResolved === true,
    foundationInteractionBarPlanResolved: foundationInteraction?.barPlanResolved === true,
    foundationInteractionProductionReady: foundationInteraction?.productionReady === true,
    lowestColumnInteraction,
    lowestColumnInteractionResolved: lowestColumnInteraction?.resolved === true,
    lowestColumnInteractionRequirementResolved,
    lowestColumnPassThroughRequired: lowestColumnInteraction?.passThroughRequired ?? null,
    lowestColumnStirrupScheduleResolved: lowestColumnInteraction?.stirrupScheduleResolved === true,
    lowestColumnPassThroughPhaseResolved:
      lowestColumnInteraction?.passThroughPhaseResolved === true,
    lowestColumnInteractionProductionReady: lowestColumnInteraction?.productionReady === true,
    stirrupInteractionRequirementResolved,
    stirrupInteractionRequirementReason: interactionBlocker(
      foundationInteraction,
      lowestColumnInteraction,
      stirrupEnd,
    ),
    requirementResolved: anchorageRequirementResolved && stirrupInteractionRequirementResolved,
    productionReady: false,
  };
  const productionGate = resolveFoundationBeamEndpointProductionGate(endpoint);
  return {
    ...endpoint,
    anchorageAvailability: productionGate.anchorage,
    productionGate,
    productionReady: productionGate.ready,
  };
}

function buildFoundationInteractionFacts(xmlDoc, topologyFacts, stirrupFacts, options = {}) {
  if (options.foundationInteractionFacts?.beam instanceof Map) {
    return options.foundationInteractionFacts;
  }
  const beam = new Map();
  if (!xmlDoc || !(topologyFacts?.beam instanceof Map)) return { beam };

  const scanTag = options.scanTag || createTagScanner(xmlDoc);
  for (const [elementId, topology] of topologyFacts.beam) {
    const member = findElementById(scanTag, topology.memberTag, elementId, options.index || null);
    const stirrupBySide = bySide(stirrupFacts?.beam?.get?.(String(elementId))?.ends);
    const ends = (topology.ends || []).map((endFact) => {
      if (!endFact?.footing?.id) return null;
      if (!member) {
        return {
          side: endFact.side,
          nodeId: endFact.nodeId,
          status: 'UNRESOLVED',
          resolved: false,
          interactionRequirementResolved: false,
          productionReady: false,
          reason: 'foundation-interaction-beam-element-missing',
          blockers: ['foundation-interaction-beam-element-missing'],
          source: 'R13-foundation-beam-foundation-interaction-facts-2023',
        };
      }
      return resolveFoundationBeamFoundationInteractionFacts2023({
        scanTag,
        beamEl: member,
        endFact,
        detailSource: options.foundationInteractionDetailSource,
        beamStirrup: stirrupBySide.get(endFact.side)?.stirrup || null,
        concreteKind: options.foundationInteractionConcreteKind || null,
        projectDetailing: options.projectDetailing,
        index: options.index || null,
      });
    });
    beam.set(String(elementId), { elementId: String(elementId), ends });
  }
  return { beam };
}

function buildLowestColumnInteractionFacts(xmlDoc, topologyFacts, stirrupFacts, options = {}) {
  if (options.lowestColumnInteractionFacts?.beam instanceof Map) {
    return options.lowestColumnInteractionFacts;
  }
  return buildFoundationBeamLowestColumnInteractionFacts2023(xmlDoc, topologyFacts, stirrupFacts, {
    scanTag: options.scanTag,
    index: options.index || null,
    lowestColumnInteractionDetailSource: options.lowestColumnInteractionDetailSource,
  });
}

/**
 * @param {Document} xmlDoc STB XML document
 * @param {{beam:Map<string,Object>}} topologyFacts foundationBeamTopologyFacts
 * @param {Object} [options]
 * @param {{beam:Map<string,Object>}} [options.mainBarFacts] 既計算facts。指定時はそのまま使用する。
 * @param {{beam:Map<string,Object>}} [options.stirrupFacts] 既計算facts
 * @param {{beam:Map<string,Object>}} [options.foundationInteractionFacts] §6-3既計算facts
 * @param {{beam:Map<string,Object>}} [options.lowestColumnInteractionFacts] §6-4既計算facts
 * @param {string} [options.foundationInteractionDetailSource] §6-3 `STANDARD_2023`等。
 * @param {string} [options.lowestColumnInteractionDetailSource] §6-4 `STANDARD_2023`等。
 * @returns {{beam:Map<string,Object>,unresolved:Array<Object>}}
 */
export function buildFoundationBeamEndpointFacts(xmlDoc, topologyFacts, options = {}) {
  const beam = new Map();
  const unresolved = [];
  if (!xmlDoc || !(topologyFacts?.beam instanceof Map)) return { beam, unresolved };

  const rawMainBarFacts =
    options.mainBarFacts || buildFoundationBeamEndBarFacts(xmlDoc, topologyFacts, options);
  const mainBarFacts = options.mainBarFacts
    ? rawMainBarFacts
    : applyFoundationBeamAnchorageRequirements2023(rawMainBarFacts, topologyFacts, {
        projectDetailing: options.projectDetailing,
      });
  const stirrupFacts =
    options.stirrupFacts || buildFoundationBeamStirrupFacts(xmlDoc, topologyFacts, options);
  const interactionFacts = buildFoundationInteractionFacts(
    xmlDoc,
    topologyFacts,
    stirrupFacts,
    options,
  );
  const lowestColumnFacts = buildLowestColumnInteractionFacts(
    xmlDoc,
    topologyFacts,
    stirrupFacts,
    options,
  );

  for (const [elementId, topology] of topologyFacts.beam) {
    const mainBarBeam = mainBarFacts?.beam?.get?.(String(elementId)) || null;
    const stirrupBeam = stirrupFacts?.beam?.get?.(String(elementId)) || null;
    const interactionBeam = interactionFacts?.beam?.get?.(String(elementId)) || null;
    const lowestColumnBeam = lowestColumnFacts?.beam?.get?.(String(elementId)) || null;
    const mainBySide = bySide(mainBarBeam?.ends);
    const stirrupBySide = bySide(stirrupBeam?.ends);
    const interactionBySide = bySide(interactionBeam?.ends);
    const lowestColumnBySide = bySide(lowestColumnBeam?.ends);
    const ends = (topology.ends || []).map((topologyEnd) =>
      combineEndpoint(
        topologyEnd,
        mainBySide.get(topologyEnd.side) || null,
        stirrupBySide.get(topologyEnd.side) || null,
        interactionBySide.get(topologyEnd.side) || null,
        lowestColumnBySide.get(topologyEnd.side) || null,
      ),
    );

    const fact = {
      elementId: String(elementId),
      elementName: topology.elementName || null,
      memberTag: topology.memberTag || null,
      sectionId: topology.sectionId || null,
      source: 'R13-foundation-beam-endpoint-facts',
      ends,
      resolved: ends.every((end) => end.resolved),
      requirementResolved: ends.every((end) => end.requirementResolved),
      productionReady: ends.every((end) => end.productionReady),
    };
    beam.set(String(elementId), fact);

    for (const end of ends) {
      if (end.resolved) continue;
      unresolved.push({
        elementId: String(elementId),
        elementName: fact.elementName,
        side: end.side,
        nodeId: end.nodeId,
        reasons: [...end.reasons],
        source: fact.source,
      });
    }
  }

  return { beam, unresolved };
}

export const _foundationBeamEndpointFactsInternals = Object.freeze({
  bySide,
  sameNodeId,
  endpointReasons,
  unresolvedInteractionBlocker,
  interactionBlocker,
  combineEndpoint,
  buildFoundationInteractionFacts,
  buildLowestColumnInteractionFacts,
});
