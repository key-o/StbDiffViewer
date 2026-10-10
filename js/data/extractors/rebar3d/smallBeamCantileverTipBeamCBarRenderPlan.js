/**
 * @fileoverview R12-AN 図9-4 C形筋のmember-local render plan orchestration。
 *
 * AG facts → AI explicit detail → AJ tip-beam main identity → AK semantic plan →
 * AL stirrup stationing → AM actual-arc C-bar path を同一fact chainで構築する。
 * explicit cross-section detailが無い場合はdeferred no-opとし、既存梁主筋表示を壊さない。
 */

import { createTagScanner } from '../columnSupportUtils.js';
import { buildBeamStirrupLayoutMaps } from './hoopPlacement.js';
import { buildRebarModelIndex } from './rebarModelIndex.js';
import { buildSmallBeamCantileverTipBeamFacts } from './smallBeamCantileverTipBeamFacts.js';
import { attachSmallBeamCantileverTipBeamDetailing } from './smallBeamCantileverTipBeamProjectDetailing.js';
import { attachSmallBeamCantileverTipBeamMainBarIdentity } from './smallBeamCantileverTipBeamMainBarIdentity.js';
import { attachSmallBeamCantileverTipBeamPathPlan } from './smallBeamCantileverTipBeamPathPlan.js';
import { attachSmallBeamCantileverTipBeamCBarStationing } from './smallBeamCantileverTipBeamCBarStationing.js';
import { attachSmallBeamCantileverTipBeamCBarPaths } from './smallBeamCantileverTipBeamCBarPath.js';

const SOURCE = 'R12-AN-small-beam-cantilever-tip-beam-c-bar-render-plan';

function isDeferredReason(reason) {
  return [
    'cantilever-tip-beam-explicit-detail-required',
    'cantilever-tip-beam-production-not-enabled',
    'cantilever-tip-beam-assignment-missing',
    'cantilever-tip-beam-c-bar-cross-section-explicit-detail-required',
  ].includes(reason);
}

function unresolvedRow(fact, reason, extra = {}) {
  return {
    elementId: fact?.elementId == null ? null : String(fact.elementId),
    tipBeamId: fact?.tipBeamId == null ? null : String(fact.tipBeamId),
    figureCase: fact?.figureCase || null,
    reason,
    source: SOURCE,
    ...extra,
  };
}

export function buildSmallBeamCantileverTipBeamCBarRenderPlan(
  xmlDoc,
  beamLayoutMap,
  options = {},
  sharedScanTag = null,
) {
  const members = new Map();
  const unresolved = [];
  const deferred = [];
  if (!xmlDoc || !beamLayoutMap?.size) {
    return {
      resolved: true,
      source: SOURCE,
      members,
      unresolved,
      deferred,
    };
  }

  const scanTag = sharedScanTag || createTagScanner(xmlDoc);
  const modelIndex =
    options.modelIndex || options.index || buildRebarModelIndex(xmlDoc, { scanTag });
  const stirrupLayouts =
    options.beamStirrupLayoutMaps || buildBeamStirrupLayoutMaps(xmlDoc, options);

  let facts = buildSmallBeamCantileverTipBeamFacts(xmlDoc, { ...options, modelIndex }, scanTag);
  facts = attachSmallBeamCantileverTipBeamDetailing(facts, options);
  facts = attachSmallBeamCantileverTipBeamMainBarIdentity(facts, beamLayoutMap);
  facts = attachSmallBeamCantileverTipBeamPathPlan(facts);
  facts = attachSmallBeamCantileverTipBeamCBarStationing(facts, stirrupLayouts.beam);
  facts = attachSmallBeamCantileverTipBeamCBarPaths(facts);

  for (const fact of facts.beam?.values?.() || []) {
    if (!fact?.resolved) {
      unresolved.push(
        unresolvedRow(fact, fact?.reason || 'cantilever-tip-beam-c-bar-render-fact-unresolved'),
      );
      continue;
    }

    const pathFacts = fact.tipBeamCBarPaths;
    if (!pathFacts?.resolved || pathFacts.pathReady !== true) {
      const reason =
        pathFacts?.reason ||
        fact.tipBeamCBarStationing?.reason ||
        fact.tipBeamPathPlan?.reason ||
        fact.tipBeamDetailing?.reason ||
        'cantilever-tip-beam-c-bar-render-path-unresolved';
      const row = unresolvedRow(fact, reason);
      (isDeferredReason(reason) ? deferred : unresolved).push(row);
      continue;
    }

    const tipBeamId = String(fact.tipBeamId);
    if (members.has(tipBeamId)) {
      unresolved.push(
        unresolvedRow(fact, 'cantilever-tip-beam-c-bar-render-member-ambiguous', {
          existingSourceCantileverId: members.get(tipBeamId)?.sourceCantileverId || null,
        }),
      );
      members.delete(tipBeamId);
      continue;
    }

    members.set(tipBeamId, {
      elementId: tipBeamId,
      sectionId:
        fact.tipBeamSection?.sectionId == null ? null : String(fact.tipBeamSection.sectionId),
      sourceCantileverId: String(fact.elementId),
      figureCase: fact.figureCase,
      generationStatus: 'CENTERLINE_READY',
      productionPathCandidate: true,
      productionConsumer: 'tip-beam-member-local-c-bar-path',
      paths: pathFacts.paths,
      pathCount: pathFacts.paths.length,
      stations: fact.tipBeamCBarStationing?.stations || [],
      source: SOURCE,
    });
  }

  return {
    resolved: unresolved.length === 0,
    source: SOURCE,
    members,
    unresolved,
    deferred,
    facts,
  };
}
