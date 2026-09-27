/**
 * @fileoverview R12-U VERTICAL_90 actual pathをR5主筋identityへ一意に結び付ける。
 *
 * R12-Tでmember端の幾何連続性を確認した後だけ、同じlayout barへ付与されたidentityKeyと
 * member-local endpoint pathのidentityKeyが一致することを要求する。
 */

import { createRebarPath, validateRebarPath } from './rebarPath.js';

const SOURCE = 'R12-small-beam-vertical-90-identity';
const GROUP_SOURCE = 'R12-small-beam-group-vertical-90-identity';

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    identityReady: false,
    productionReady: false,
    reason,
    source: SOURCE,
    identityKey: null,
    boundPath: null,
    ...extra,
  };
}

function unresolvedGroup(reason, extra = {}) {
  return {
    resolved: false,
    identityReady: false,
    productionReady: false,
    reason,
    source: GROUP_SOURCE,
    barIdentities: [],
    ...extra,
  };
}

function text(value) {
  if (value === null || value === undefined || value === '') return null;
  const result = String(value);
  return result.trim() === '' ? null : result;
}

/** 1本のactual pathを、連続するmember-local主筋identityへbindする。 */
export function resolveSmallBeamVertical90BarIdentity({
  bar,
  pathPlan,
  actualPathFact,
  continuityFact,
  memberId = null,
  barIndex = null,
} = {}) {
  if (
    !actualPathFact?.resolved ||
    actualPathFact.actualPathReady !== true ||
    !actualPathFact.path
  ) {
    return unresolved(actualPathFact?.reason || 'small-beam-vertical-90-actual-path-not-ready');
  }
  if (
    !continuityFact?.resolved ||
    continuityFact.continuityReady !== true ||
    !continuityFact.memberPath
  ) {
    return unresolved(continuityFact?.reason || 'small-beam-vertical-90-continuity-not-ready');
  }

  const identityKey = text(bar?.identityKey);
  if (!identityKey || bar?.unresolvedMatch === true || bar?.identityStatus === 'unresolved') {
    return unresolved('small-beam-vertical-90-bar-identity-unresolved', {
      barIdentityStatus: bar?.identityStatus || null,
      barUnresolvedMatch: bar?.unresolvedMatch === true,
    });
  }

  const memberPathIdentityKey = text(continuityFact.memberPath?.metadata?.identityKey);
  if (!memberPathIdentityKey) {
    return unresolved('small-beam-vertical-90-member-path-identity-unresolved', {
      identityKey,
      memberPathIdentityStatus: continuityFact.memberPath?.metadata?.identityStatus || null,
    });
  }
  if (memberPathIdentityKey !== identityKey) {
    return unresolved('small-beam-vertical-90-member-path-identity-mismatch', {
      identityKey,
      memberPathIdentityKey,
    });
  }

  const plannedIdentityKey = text(pathPlan?.identityKey);
  if (plannedIdentityKey && plannedIdentityKey !== identityKey) {
    return unresolved('small-beam-vertical-90-path-plan-identity-mismatch', {
      identityKey,
      plannedIdentityKey,
    });
  }
  const actualIdentityKey = text(actualPathFact.path?.metadata?.identityKey);
  if (actualIdentityKey && actualIdentityKey !== identityKey) {
    return unresolved('small-beam-vertical-90-actual-path-identity-mismatch', {
      identityKey,
      actualIdentityKey,
    });
  }

  const boundPath = createRebarPath(actualPathFact.path.primitives, {
    ...actualPathFact.path.metadata,
    memberId: memberId === null || memberId === undefined ? null : String(memberId),
    memberTag: 'StbBeam',
    endpoint: actualPathFact.anchor,
    identityKey,
    identityStatus:
      bar.identityStatus || continuityFact.memberPath.metadata?.identityStatus || null,
    unresolvedMatch: false,
    source: 'small-beam-r12-vertical-90',
    ruleId: 'R12-U',
  });
  const validation = validateRebarPath(boundPath);
  if (!validation.ok) {
    return unresolved('small-beam-vertical-90-identity-bound-path-invalid', {
      identityKey,
      validation,
    });
  }

  return {
    resolved: true,
    identityReady: true,
    productionReady: false,
    reason: null,
    source: SOURCE,
    identityKey,
    identityStatus: bar.identityStatus || null,
    memberPathIdentityKey,
    memberId: memberId === null || memberId === undefined ? null : String(memberId),
    side: actualPathFact.anchor,
    barIndex: Number.isInteger(barIndex) ? barIndex : null,
    boundPath,
    validation,
  };
}

export function resolveSmallBeamGroupVertical90Identity(group, memberId = null) {
  if (group?.role !== 'top') return null;
  const mode = group.anchorageMode;
  if (!mode?.resolved)
    return unresolvedGroup(mode?.reason || 'small-beam-anchorage-mode-unresolved');
  if (mode.mode !== 'VERTICAL_90') {
    return {
      resolved: true,
      identityReady: false,
      productionReady: false,
      applicable: false,
      reason: 'vertical-90-mode-not-selected',
      source: GROUP_SOURCE,
      barIdentities: [],
    };
  }

  const bars = Array.isArray(group.bars) ? group.bars : [];
  const pathPlans = group.vertical90PathPlan?.barPlans;
  const actualPaths = group.vertical90ActualPath?.barPaths;
  const continuities = group.vertical90Continuity?.barContinuities;
  if (
    !Array.isArray(pathPlans) ||
    !Array.isArray(actualPaths) ||
    !Array.isArray(continuities) ||
    bars.length === 0
  ) {
    return unresolvedGroup('small-beam-vertical-90-identity-source-facts-missing');
  }
  if (
    pathPlans.length !== bars.length ||
    actualPaths.length !== bars.length ||
    continuities.length !== bars.length
  ) {
    return unresolvedGroup('small-beam-vertical-90-identity-source-count-mismatch', {
      barCount: bars.length,
      pathPlanCount: pathPlans.length,
      actualPathCount: actualPaths.length,
      continuityCount: continuities.length,
    });
  }

  const barIdentities = bars.map((bar, index) =>
    resolveSmallBeamVertical90BarIdentity({
      bar,
      pathPlan: pathPlans[index],
      actualPathFact: actualPaths[index],
      continuityFact: continuities[index],
      memberId,
      barIndex: index,
    }),
  );
  const failed = barIdentities.filter((fact) => !fact.resolved || fact.identityReady !== true);
  if (failed.length > 0) {
    return unresolvedGroup(failed[0].reason || 'small-beam-vertical-90-identity-unresolved', {
      barIdentities,
      failedBarIdentities: failed,
    });
  }

  const keys = barIdentities.map((fact) => fact.identityKey);
  if (new Set(keys).size !== keys.length) {
    return unresolvedGroup('small-beam-vertical-90-identity-not-unique', {
      barIdentities,
      identityKeys: keys,
    });
  }

  return {
    resolved: true,
    identityReady: true,
    productionReady: false,
    applicable: true,
    reason: null,
    source: GROUP_SOURCE,
    barIdentities,
    failedBarIdentities: [],
    identityKeys: keys,
  };
}

export function attachSmallBeamVertical90IdentityFacts(requirementFacts) {
  if (!requirementFacts?.beam) {
    return { ...(requirementFacts || {}), vertical90IdentityUnresolved: [] };
  }

  const vertical90IdentityUnresolved = [];
  for (const [elementId, beamFacts] of requirementFacts.beam) {
    for (const end of beamFacts?.ends || []) {
      if (end.status === 'FREE_END') continue;
      for (const group of end.requirements || []) {
        if (group.role !== 'top') continue;
        group.vertical90Identity = resolveSmallBeamGroupVertical90Identity(group, elementId);
        if (
          group.anchorageMode?.mode === 'VERTICAL_90' &&
          group.vertical90Identity?.resolved === false
        ) {
          vertical90IdentityUnresolved.push({
            elementId,
            elementName: beamFacts.elementName,
            side: end.side,
            role: group.role,
            diaMm: group.diaMm,
            grade: group.grade,
            reason: group.vertical90Identity.reason,
          });
        }
      }
    }
  }

  return {
    ...requirementFacts,
    vertical90IdentityUnresolved,
  };
}
