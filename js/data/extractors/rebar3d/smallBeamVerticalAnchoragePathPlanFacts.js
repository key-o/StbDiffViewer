/**
 * @fileoverview R12-R bar-level VERTICAL_90 path planを小梁requirement factsへ後段接続する。
 */

import { resolveSmallBeamVertical90BarPathPlan } from './smallBeamVerticalAnchoragePathPlan.js';

function unresolvedGroup(reason, extra = {}) {
  return {
    resolved: false,
    pathPlanReady: false,
    reason,
    barPlans: [],
    source: 'R12-small-beam-group-vertical-90-path-plan',
    ...extra,
  };
}

export function resolveSmallBeamGroupVertical90PathPlan(group) {
  if (group?.role !== 'top') return null;
  const mode = group.anchorageMode;
  if (!mode?.resolved) {
    return unresolvedGroup(mode?.reason || 'small-beam-anchorage-mode-unresolved');
  }
  if (mode.mode !== 'VERTICAL_90') {
    return {
      resolved: true,
      pathPlanReady: false,
      applicable: false,
      reason: 'vertical-90-mode-not-selected',
      alternativeRequired: mode.alternativeRequired === true,
      barPlans: [],
      source: 'R12-small-beam-group-vertical-90-path-plan',
    };
  }

  const bars = Array.isArray(group.bars) ? group.bars : [];
  const projectionFacts = group.projectionAvailability?.barFacts;
  const tailFacts = group.tailAvailability?.barFacts;
  const totalLengthFacts = group.totalLengthAvailability?.barFacts;
  const candidateFacts = group.vertical90Candidate?.barFacts;
  if (
    bars.length === 0 ||
    !Array.isArray(projectionFacts) ||
    !Array.isArray(tailFacts) ||
    !Array.isArray(totalLengthFacts) ||
    !Array.isArray(candidateFacts)
  ) {
    return unresolvedGroup('small-beam-vertical-90-path-source-facts-missing');
  }

  const counts = [
    projectionFacts.length,
    tailFacts.length,
    totalLengthFacts.length,
    candidateFacts.length,
  ];
  if (counts.some((count) => count !== bars.length)) {
    return unresolvedGroup('small-beam-vertical-90-path-source-count-mismatch', {
      barCount: bars.length,
      projectionCount: projectionFacts.length,
      tailCount: tailFacts.length,
      totalLengthCount: totalLengthFacts.length,
      candidateCount: candidateFacts.length,
    });
  }

  const barPlans = bars.map((bar, index) =>
    resolveSmallBeamVertical90BarPathPlan({
      bar,
      projectionFact: projectionFacts[index],
      tailFact: tailFacts[index],
      totalLengthFact: totalLengthFacts[index],
      candidateFact: candidateFacts[index],
      requirement: group.requirement,
      anchorageMode: mode,
      barIndex: index,
    }),
  );
  const failed = barPlans.filter((plan) => !plan.resolved || !plan.pathPlanReady);
  if (failed.length > 0) {
    return unresolvedGroup(failed[0].reason || 'small-beam-vertical-90-path-plan-unresolved', {
      barPlans,
      failedBarPlans: failed,
    });
  }

  return {
    resolved: true,
    pathPlanReady: true,
    applicable: true,
    reason: null,
    productionReady: false,
    barPlans,
    failedBarPlans: [],
    source: 'R12-small-beam-group-vertical-90-path-plan',
  };
}

export function attachSmallBeamVertical90PathPlanFacts(requirementFacts) {
  if (!requirementFacts?.beam) {
    return { ...(requirementFacts || {}), vertical90PathPlanUnresolved: [] };
  }

  const vertical90PathPlanUnresolved = [];
  for (const [elementId, beamFacts] of requirementFacts.beam) {
    for (const end of beamFacts?.ends || []) {
      if (end.status === 'FREE_END') continue;
      for (const group of end.requirements || []) {
        if (group.role !== 'top') continue;
        group.vertical90PathPlan = resolveSmallBeamGroupVertical90PathPlan(group);
        if (
          group.anchorageMode?.mode === 'VERTICAL_90' &&
          group.vertical90PathPlan?.resolved === false
        ) {
          vertical90PathPlanUnresolved.push({
            elementId,
            elementName: beamFacts.elementName,
            side: end.side,
            role: group.role,
            diaMm: group.diaMm,
            grade: group.grade,
            reason: group.vertical90PathPlan.reason,
          });
        }
      }
    }
  }

  return {
    ...requirementFacts,
    vertical90PathPlanUnresolved,
  };
}
