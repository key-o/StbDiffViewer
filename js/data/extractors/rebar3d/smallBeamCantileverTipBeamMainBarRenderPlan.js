/**
 * @fileoverview R12-AO 図9-4-2 先端小梁主筋のcross-member world geometry plan。
 *
 * AG facts -> AJ endpoint identity -> AK semantic pre-production plan を正本とし、
 * 先端小梁top/bottom identityごとに、片持ち梁へ90°折曲げ定着するために必要な
 * member/endpoint/length contractだけをviewerへ渡す。world RebarPath生成とmain-path trimは
 * SmallBeamCantileverTipBeamMainBarWorldResolverでmember単位に原子的に行う。
 *
 * C形筋はproject explicit detailを必要とするが、図9-4-2の主筋定着は標準図で一意化できるため、
 * C形筋detail未指定をmain-bar productionのblockerにはしない。
 */

import { createTagScanner } from '../columnSupportUtils.js';
import { buildRebarModelIndex } from './rebarModelIndex.js';
import { buildSmallBeamCantileverTipBeamFacts } from './smallBeamCantileverTipBeamFacts.js';
import { attachSmallBeamCantileverTipBeamDetailing } from './smallBeamCantileverTipBeamProjectDetailing.js';
import { attachSmallBeamCantileverTipBeamMainBarIdentity } from './smallBeamCantileverTipBeamMainBarIdentity.js';
import { attachSmallBeamCantileverTipBeamPathPlan } from './smallBeamCantileverTipBeamPathPlan.js';

const SOURCE = 'R12-AO-small-beam-cantilever-tip-beam-main-bar-render-plan';

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

function groupEntries(identityGroups, semanticPlans, role) {
  const entries = [];
  for (const identityGroup of identityGroups || []) {
    const semantic = (semanticPlans || []).find(
      (plan) => Number(plan?.groupIndex) === Number(identityGroup?.groupIndex),
    );
    if (!semantic) {
      return {
        ok: false,
        reason: 'cantilever-tip-beam-' + role + '-semantic-group-unresolved',
        entries: [],
      };
    }

    const barsByKey = new Map(
      (identityGroup.bars || [])
        .filter((bar) => bar?.identityKey)
        .map((bar) => [String(bar.identityKey), bar]),
    );
    for (const rawKey of semantic.identityKeys || []) {
      const identityKey = String(rawKey);
      const bar = barsByKey.get(identityKey);
      if (!bar) {
        return {
          ok: false,
          reason: 'cantilever-tip-beam-' + role + '-identity-position-unresolved',
          entries: [],
        };
      }
      const base = {
        role,
        identityKey,
        layer: semantic.layer ?? bar.layer ?? null,
        diaMm: Number(semantic.diaMm),
        grade: semantic.grade || bar.grade || null,
        u: Number(bar.u),
        v: Number(bar.v),
      };
      if (
        !base.identityKey ||
        !(base.diaMm > 0) ||
        !base.grade ||
        !Number.isFinite(base.u) ||
        !Number.isFinite(base.v)
      ) {
        return {
          ok: false,
          reason: 'cantilever-tip-beam-' + role + '-entry-input-unresolved',
          entries: [],
        };
      }

      entries.push(
        role === 'top'
          ? {
              ...base,
              l2RequiredMm: Number(semantic.l2RequiredMm),
              additionalStraightRequiredMm: Number(semantic.additionalStraightRequiredMm),
              additionalStraightKind: semantic.additionalStraightKind || null,
            }
          : {
              ...base,
              l3RequiredMm: Number(semantic.l3RequiredMm),
            },
      );
    }
  }
  return { ok: true, reason: null, entries };
}

function memberPlan(fact) {
  const pathPlan = fact?.tipBeamPathPlan;
  const identity = fact?.tipBeamMainBarIdentity;
  if (
    fact?.figureCase !== 'FIGURE_9_4_2' ||
    !pathPlan?.resolved ||
    pathPlan.preProductionPlanReady !== true ||
    !identity?.resolved ||
    identity.identityReady !== true
  ) {
    return {
      ok: false,
      reason:
        pathPlan?.reason ||
        identity?.reason ||
        'cantilever-tip-beam-main-bar-pre-production-plan-not-ready',
    };
  }

  const top = groupEntries(identity.topGroups, pathPlan.topPlans, 'top');
  if (!top.ok) return top;
  const bottom = groupEntries(identity.bottomGroups, pathPlan.bottomPlans, 'bottom');
  if (!bottom.ok) return bottom;
  const entries = [...top.entries, ...bottom.entries];
  if (
    entries.length === 0 ||
    new Set(entries.map((entry) => entry.identityKey)).size !== entries.length
  ) {
    return {
      ok: false,
      reason: 'cantilever-tip-beam-main-bar-render-identity-not-unique',
    };
  }
  if (
    entries.some((entry) =>
      entry.role === 'top'
        ? !(entry.l2RequiredMm > 0) || !(entry.additionalStraightRequiredMm > 0)
        : !(entry.l3RequiredMm > 0),
    )
  ) {
    return {
      ok: false,
      reason: 'cantilever-tip-beam-main-bar-render-length-unresolved',
    };
  }

  const tipBeamWidthMm = Number(fact.tipBeamSection?.widthMm);
  const tipBeamDepthMm = Number(fact.tipBeamSection?.depthMm);
  const cantileverBeamWidthMm = Number(fact.cantileverTipSection?.widthMm);
  const cantileverBeamDepthMm = Number(fact.cantileverTipSection?.depthMm);
  if (
    !(tipBeamWidthMm > 0) ||
    !(tipBeamDepthMm > 0) ||
    !(cantileverBeamWidthMm > 0) ||
    !(cantileverBeamDepthMm > 0)
  ) {
    return {
      ok: false,
      reason: 'cantilever-tip-beam-main-bar-render-section-geometry-unresolved',
    };
  }

  return {
    ok: true,
    plan: {
      elementId: String(fact.tipBeamId),
      sectionId:
        fact.tipBeamSection?.sectionId == null ? null : String(fact.tipBeamSection.sectionId),
      sourceCantileverId: String(fact.elementId),
      sourceCantileverSectionId:
        fact.cantileverSectionId == null ? null : String(fact.cantileverSectionId),
      figureCase: fact.figureCase,
      tipBeamEndpoint: fact.tipBeamConnection,
      cantileverEndpoint: fact.tipSide,
      tipBeamWidthMm,
      tipBeamDepthMm,
      cantileverBeamWidthMm,
      cantileverBeamDepthMm,
      generationStatus: 'WORLD_PATH_PLAN_READY',
      productionPathCandidate: true,
      productionConsumer: 'tip-beam-cross-member-world-bend',
      entries,
      source: SOURCE,
    },
  };
}

export function buildSmallBeamCantileverTipBeamMainBarRenderPlan(
  xmlDoc,
  beamLayoutMap,
  options = {},
  sharedScanTag = null,
) {
  const members = new Map();
  const unresolved = [];
  if (!xmlDoc || !beamLayoutMap?.size) {
    return {
      resolved: true,
      source: SOURCE,
      members,
      unresolved,
    };
  }

  const scanTag = sharedScanTag || createTagScanner(xmlDoc);
  const modelIndex =
    options.modelIndex || options.index || buildRebarModelIndex(xmlDoc, { scanTag });

  let facts = buildSmallBeamCantileverTipBeamFacts(xmlDoc, { ...options, modelIndex }, scanTag);
  // AKのC形筋枝へdetail statusを伝える。図9-4-2 main-bar枝はdetail未指定でも独立解決する。
  facts = attachSmallBeamCantileverTipBeamDetailing(facts, options);
  facts = attachSmallBeamCantileverTipBeamMainBarIdentity(facts, beamLayoutMap);
  facts = attachSmallBeamCantileverTipBeamPathPlan(facts);

  for (const fact of facts.beam?.values?.() || []) {
    if (!fact?.resolved || fact.figureCase !== 'FIGURE_9_4_2') continue;

    const built = memberPlan(fact);
    if (!built.ok) {
      unresolved.push(unresolvedRow(fact, built.reason));
      continue;
    }

    const tipBeamId = String(fact.tipBeamId);
    if (members.has(tipBeamId)) {
      unresolved.push(
        unresolvedRow(fact, 'cantilever-tip-beam-main-bar-render-member-ambiguous', {
          existingSourceCantileverId: members.get(tipBeamId)?.sourceCantileverId || null,
        }),
      );
      members.delete(tipBeamId);
      continue;
    }
    members.set(tipBeamId, built.plan);
  }

  return {
    resolved: unresolved.length === 0,
    source: SOURCE,
    members,
    unresolved,
    facts,
  };
}
