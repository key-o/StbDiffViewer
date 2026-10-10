/**
 * @fileoverview R12-AK 図9-4 production geometry直前のsemantic path plan。
 *
 * C形筋の径・間隔・25d・実曲げ半径と、図9-4-2の先端小梁main-bar identity groupごとの
 * L2/L3/追加長さを一つのplanへ集約する。
 *
 * C形筋はgrade/配置のproject explicit detailが必要だが、図9-4-2の先端小梁主筋定着は
 * 標準図と既存identityだけで解ける。したがって両枝を独立に解決し、C形筋detail未指定を
 * main-bar world geometryのblockerにはしない。
 */

import { resolveHookBendGeometry } from './rebarHookGeometry.js';

const SOURCE = 'R12-AK-small-beam-cantilever-tip-beam-path-plan';

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    preProductionPlanReady: false,
    productionReady: false,
    reason,
    source: SOURCE,
    cBarPlan: null,
    cBarRule: null,
    topPlans: [],
    bottomPlans: [],
    blockers: [reason],
    ...extra,
  };
}

function cBarPlan(fact) {
  const cBar = fact?.cBar;
  const detailing = fact?.tipBeamDetailing;
  if (!cBar?.ok || !detailing?.resolved) {
    return {
      ok: false,
      reason:
        detailing?.reason || cBar?.reason || 'cantilever-tip-beam-c-bar-requirement-unresolved',
    };
  }

  const grade =
    detailing.assignment?.cBarNormalizedGrade || detailing.assignment?.cBarGrade || null;
  const bend = resolveHookBendGeometry({
    grade,
    barDiaMm: cBar.barDiaMm,
    bendAngleDeg: 90,
  });
  if (!bend.ok) {
    return {
      ok: false,
      reason: bend.reason || 'cantilever-tip-beam-c-bar-bend-rule-unresolved',
      bend,
    };
  }

  const legLengthMm = Number(cBar.legLengthMm);
  if (!(legLengthMm > bend.centerlineRadiusMm)) {
    return {
      ok: false,
      reason: 'cantilever-tip-beam-c-bar-leg-too-short-for-bend',
      bend,
      legLengthMm,
    };
  }

  return {
    ok: true,
    plan: {
      role: 'C_BAR',
      sourceFigure: fact.figureCase,
      diaMm: cBar.barDiaMm,
      designation: cBar.designation || null,
      grade: detailing.assignment?.cBarGrade || grade,
      normalizedGrade: grade,
      pitchMm: cBar.pitchMm,
      legLengthMm,
      legLengthDiaFactor: cBar.legLengthDiaFactor,
      bendCount: 2,
      bendAngleDeg: 90,
      insideDiameterMm: bend.insideDiameterMm,
      centerlineRadiusMm: bend.centerlineRadiusMm,
      stationingRule: 'SAME_SPACING_AS_TIP_BEAM_STIRRUP',
      stationingReady: false,
      placementMode: detailing.assignment?.cBarPlacementMode || null,
      placementVerified: detailing.assignment?.cBarPlacementVerified === true,
    },
  };
}

function topPlan(identityGroup) {
  const requirement = identityGroup.requirement || {};
  return {
    role: 'top',
    memberRole: 'TIP_BEAM',
    groupIndex: identityGroup.groupIndex ?? null,
    identityKeys: identityGroup.identityKeys || [],
    layer: requirement.step ?? null,
    count: requirement.count ?? null,
    diaMm: requirement.diaMm ?? null,
    grade: requirement.grade || null,
    l2RequiredMm: requirement.l2RequiredMm ?? null,
    l2Factor: requirement.l2Factor ?? null,
    additionalStraightRequiredMm: requirement.additionalStraight?.requiredMm ?? null,
    additionalStraightKind: requirement.additionalStraight?.lengthKind || null,
    additionalStraightByDiaMm: requirement.additionalStraight?.byDiaMm ?? null,
    additionalStraightByWidthMm: requirement.additionalStraight?.byWidthMm ?? null,
    cantileverBeamWidthMm: requirement.additionalStraight?.cantileverBeamWidthMm ?? null,
    geometryReady: false,
  };
}

function bottomPlan(identityGroup) {
  const requirement = identityGroup.requirement || {};
  return {
    role: 'bottom',
    memberRole: 'TIP_BEAM',
    groupIndex: identityGroup.groupIndex ?? null,
    identityKeys: identityGroup.identityKeys || [],
    layer: requirement.step ?? null,
    count: requirement.count ?? null,
    diaMm: requirement.diaMm ?? null,
    grade: requirement.grade || null,
    l3RequiredMm: requirement.l3RequiredMm ?? null,
    l3Factor: requirement.l3Factor ?? null,
    geometryReady: false,
  };
}

export function resolveSmallBeamCantileverTipBeamPathPlan(fact) {
  if (!fact?.resolved) {
    return unresolved(fact?.reason || 'cantilever-tip-beam-fact-unresolved');
  }

  let topPlans = [];
  let bottomPlans = [];
  if (fact.figureCase === 'FIGURE_9_4_2') {
    const identity = fact.tipBeamMainBarIdentity;
    if (!identity?.resolved || identity.identityReady !== true) {
      return unresolved(identity?.reason || 'cantilever-tip-beam-main-bar-identity-not-ready');
    }

    topPlans = (identity.topGroups || []).map(topPlan);
    bottomPlans = (identity.bottomGroups || []).map(bottomPlan);
    if (
      topPlans.length === 0 ||
      bottomPlans.length === 0 ||
      topPlans.some((plan) => plan.identityKeys.length !== Number(plan.count)) ||
      bottomPlans.some((plan) => plan.identityKeys.length !== Number(plan.count))
    ) {
      return unresolved('cantilever-tip-beam-main-bar-plan-count-mismatch', {
        topPlans,
        bottomPlans,
      });
    }
  } else if (fact.figureCase !== 'FIGURE_9_4_1') {
    return unresolved('cantilever-tip-beam-figure-case-unresolved');
  }

  const cBar = cBarPlan(fact);
  // 図9-4-1はC形筋だけがproduction対象なので、C形筋detail未解決ならplan全体を未解決とする。
  // 図9-4-2は先端小梁主筋定着を独立にproductionへ進めるため、C形筋detailをblockerとして保持する。
  if (fact.figureCase === 'FIGURE_9_4_1' && !cBar.ok) {
    return unresolved(cBar.reason, { cBarRule: cBar });
  }

  const blockers = [];
  if (cBar.ok) blockers.push('cantilever-tip-beam-c-bar-stationing-not-yet-resolved');
  else blockers.push(cBar.reason);

  if (fact.figureCase === 'FIGURE_9_4_2') {
    blockers.push('cantilever-tip-beam-main-bar-geometry-not-yet-resolved');
  }

  return {
    resolved: true,
    preProductionPlanReady: true,
    productionReady: false,
    reason: null,
    source: SOURCE,
    figureCase: fact.figureCase,
    cBarPlan: cBar.ok ? cBar.plan : null,
    cBarRule: cBar.ok ? null : cBar,
    topPlans,
    bottomPlans,
    blockers,
  };
}

export function attachSmallBeamCantileverTipBeamPathPlan(facts) {
  if (!facts?.beam) {
    return {
      ...(facts || {}),
      pathPlanUnresolved: [],
    };
  }

  const pathPlanUnresolved = [];
  for (const [elementId, fact] of facts.beam) {
    if (!fact?.resolved) continue;
    fact.tipBeamPathPlan = resolveSmallBeamCantileverTipBeamPathPlan(fact);
    if (!fact.tipBeamPathPlan.resolved) {
      pathPlanUnresolved.push({
        elementId: String(elementId),
        tipBeamId: fact.tipBeamId || null,
        figureCase: fact.figureCase || null,
        reason: fact.tipBeamPathPlan.reason,
      });
    }
  }

  return {
    ...facts,
    pathPlanUnresolved,
  };
}
