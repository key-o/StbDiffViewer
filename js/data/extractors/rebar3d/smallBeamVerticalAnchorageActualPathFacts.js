/**
 * @fileoverview R12-S actual-arc RebarPathを小梁requirement factsへ後段接続する。
 */

import { resolveSmallBeamVertical90ActualPath } from './smallBeamVerticalAnchorageActualPath.js';

const SOURCE = 'R12-small-beam-group-vertical-90-actual-path';

function unresolvedGroup(reason, extra = {}) {
  return {
    resolved: false,
    actualPathReady: false,
    productionReady: false,
    reason,
    source: SOURCE,
    barPaths: [],
    ...extra,
  };
}

export function resolveSmallBeamGroupVertical90ActualPath(group, context = {}) {
  if (group?.role !== 'top') return null;
  const mode = group.anchorageMode;
  if (!mode?.resolved) {
    return unresolvedGroup(mode?.reason || 'small-beam-anchorage-mode-unresolved');
  }
  if (mode.mode !== 'VERTICAL_90') {
    return {
      resolved: true,
      actualPathReady: false,
      productionReady: false,
      applicable: false,
      reason: 'vertical-90-mode-not-selected',
      alternativeRequired: mode.alternativeRequired === true,
      source: SOURCE,
      barPaths: [],
    };
  }

  const pathPlan = group.vertical90PathPlan;
  const plans = pathPlan?.barPlans;
  const bars = Array.isArray(group.bars) ? group.bars : [];
  if (!pathPlan?.resolved || pathPlan.pathPlanReady !== true || !Array.isArray(plans)) {
    return unresolvedGroup(pathPlan?.reason || 'small-beam-vertical-90-path-plan-not-ready');
  }
  if (bars.length === 0 || plans.length !== bars.length) {
    return unresolvedGroup('small-beam-vertical-90-actual-path-source-count-mismatch', {
      barCount: bars.length,
      pathPlanCount: plans.length,
    });
  }

  const barPaths = plans.map((plan) =>
    resolveSmallBeamVertical90ActualPath({
      pathPlan: plan,
      memberId: context.memberId,
      elementName: context.elementName,
    }),
  );
  const failed = barPaths.filter((fact) => !fact.resolved || fact.actualPathReady !== true);
  if (failed.length > 0) {
    return unresolvedGroup(failed[0].reason || 'small-beam-vertical-90-actual-path-unresolved', {
      barPaths,
      failedBarPaths: failed,
    });
  }

  return {
    resolved: true,
    actualPathReady: true,
    productionReady: false,
    applicable: true,
    reason: null,
    source: SOURCE,
    barPaths,
    failedBarPaths: [],
  };
}

export function attachSmallBeamVertical90ActualPathFacts(requirementFacts) {
  if (!requirementFacts?.beam) {
    return { ...(requirementFacts || {}), vertical90ActualPathUnresolved: [] };
  }

  const vertical90ActualPathUnresolved = [];
  for (const [elementId, beamFacts] of requirementFacts.beam) {
    for (const end of beamFacts?.ends || []) {
      if (end.status === 'FREE_END') continue;
      for (const group of end.requirements || []) {
        if (group.role !== 'top') continue;
        group.vertical90ActualPath = resolveSmallBeamGroupVertical90ActualPath(group, {
          memberId: elementId,
          elementName: beamFacts.elementName,
        });
        if (
          group.anchorageMode?.mode === 'VERTICAL_90' &&
          group.vertical90ActualPath?.resolved === false
        ) {
          vertical90ActualPathUnresolved.push({
            elementId,
            elementName: beamFacts.elementName,
            side: end.side,
            role: group.role,
            diaMm: group.diaMm,
            grade: group.grade,
            reason: group.vertical90ActualPath.reason,
          });
        }
      }
    }
  }

  return {
    ...requirementFacts,
    vertical90ActualPathUnresolved,
  };
}
