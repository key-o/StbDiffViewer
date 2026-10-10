/**
 * @fileoverview R12-AJ 図9-4-2の先端小梁主筋requirementを実endpoint identityへ拘束する。
 *
 * 図9-4-2は先端小梁主筋を片持ち梁へ定着する納まりとして扱う。
 * 片持ち梁主筋とのpairingは作らず、先端小梁endpointのtop/bottom主筋identityを
 * layer / 径 / grade / 本数でrequirement groupへ一意に対応させる。
 */

import { REBAR_STANDARD_RULES } from '../../../constants/rebarStandardRules.js';
import { assignBeamBarIdentities } from './rebarIdentityMatcher.js';

const SOURCE = 'R12-AJ-small-beam-cantilever-tip-beam-main-bar-identity';

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    identityReady: false,
    productionReady: false,
    reason,
    source: SOURCE,
    topGroups: [],
    bottomGroups: [],
    blockers: [reason],
    ...extra,
  };
}

function endpointSegment(layout, side) {
  const segments = Array.isArray(layout?.segments) ? layout.segments : [];
  if (segments.length === 0) return null;
  if (side === 'start') return segments[0];
  if (side === 'end') return segments[segments.length - 1];
  return null;
}

function gradeKey(value) {
  const normalized = REBAR_STANDARD_RULES.normalizeGrade(value);
  return (
    normalized ||
    String(value || '')
      .trim()
      .toUpperCase()
  );
}

function signature(bar) {
  return {
    identityKey: bar?.identityKey || null,
    identityStatus: bar?.identityStatus || null,
    role: bar?.role || null,
    layer: bar?.layer ?? null,
    diaMm: Number.isFinite(Number(bar?.dia)) ? Number(bar.dia) : null,
    grade: bar?.grade || null,
    normalizedGrade: gradeKey(bar?.grade) || null,
    u: Number.isFinite(Number(bar?.u)) ? Number(bar.u) : null,
    v: Number.isFinite(Number(bar?.v)) ? Number(bar.v) : null,
  };
}

function barMatchesGroup(bar, role, group) {
  return (
    bar?.role === role &&
    Number(bar?.layer) === Number(group?.step) &&
    Number(bar?.dia) === Number(group?.diaMm) &&
    gradeKey(bar?.grade) === gradeKey(group?.grade)
  );
}

function resolveGroup(role, group, endpointBars, groupIndex) {
  const bars = endpointBars.filter((bar) => barMatchesGroup(bar, role, group));
  const requiredCount = Number(group?.count);
  if (!(requiredCount > 0)) {
    return {
      ok: false,
      reason: 'cantilever-tip-beam-' + role + '-requirement-count-unresolved',
      groupIndex,
    };
  }
  if (bars.length !== requiredCount) {
    return {
      ok: false,
      reason: 'cantilever-tip-beam-' + role + '-identity-count-mismatch',
      groupIndex,
      requiredCount,
      identityCount: bars.length,
      bars: bars.map(signature),
    };
  }

  const unresolvedBars = bars.filter(
    (bar) =>
      !bar?.identityKey || bar?.identityStatus === 'unresolved' || bar?.unresolvedMatch === true,
  );
  if (unresolvedBars.length > 0) {
    return {
      ok: false,
      reason: 'cantilever-tip-beam-' + role + '-identity-unresolved',
      groupIndex,
      bars: bars.map(signature),
    };
  }

  const keys = bars.map((bar) => bar.identityKey);
  if (new Set(keys).size !== keys.length) {
    return {
      ok: false,
      reason: 'cantilever-tip-beam-' + role + '-identity-not-unique',
      groupIndex,
      bars: bars.map(signature),
    };
  }

  return {
    ok: true,
    resolved: true,
    role,
    groupIndex,
    requirement: group,
    identityKeys: keys,
    bars: bars.map(signature),
  };
}

function resolveGroups(role, groups, endpointBars) {
  const resolved = (groups || []).map((group, index) =>
    resolveGroup(role, group, endpointBars, index),
  );
  const failed = resolved.find((group) => !group.ok);
  return failed
    ? { ok: false, reason: failed.reason, groups: resolved, failedGroup: failed }
    : { ok: true, reason: null, groups: resolved };
}

export function resolveSmallBeamCantileverTipBeamMainBarIdentity({ fact, tipBeamLayout } = {}) {
  if (!fact?.resolved) {
    return unresolved(fact?.reason || 'cantilever-tip-beam-fact-unresolved');
  }

  if (fact.figureCase === 'FIGURE_9_4_1') {
    return {
      resolved: true,
      identityReady: true,
      identityRequired: false,
      productionReady: false,
      applicable: false,
      reason: null,
      source: SOURCE,
      topGroups: [],
      bottomGroups: [],
      blockers: ['cantilever-tip-beam-c-bar-production-path-not-yet-connected'],
    };
  }
  if (fact.figureCase !== 'FIGURE_9_4_2') {
    return unresolved('cantilever-tip-beam-figure-case-unresolved');
  }
  if (!fact.tipBeamMainAnchorage?.resolved) {
    return unresolved(
      fact.tipBeamMainAnchorage?.reason ||
        'cantilever-tip-beam-main-anchorage-requirement-unresolved',
    );
  }
  if (!['start', 'end'].includes(fact.tipBeamConnection)) {
    return unresolved('cantilever-tip-beam-main-identity-requires-endpoint-connection');
  }
  if (!tipBeamLayout?.segments?.length) {
    return unresolved('cantilever-tip-beam-main-layout-unresolved');
  }

  assignBeamBarIdentities(tipBeamLayout.segments);
  const segment = endpointSegment(tipBeamLayout, fact.tipBeamConnection);
  const endpointBars = (segment?.bars || []).filter(
    (bar) => bar?.role === 'top' || bar?.role === 'bottom',
  );
  if (endpointBars.length === 0) {
    return unresolved('cantilever-tip-beam-main-endpoint-bars-empty');
  }

  const top = resolveGroups('top', fact.tipBeamMainAnchorage.top, endpointBars);
  if (!top.ok) {
    return unresolved(top.reason, {
      topGroups: top.groups,
      failedGroup: top.failedGroup,
    });
  }
  const bottom = resolveGroups('bottom', fact.tipBeamMainAnchorage.bottom, endpointBars);
  if (!bottom.ok) {
    return unresolved(bottom.reason, {
      topGroups: top.groups,
      bottomGroups: bottom.groups,
      failedGroup: bottom.failedGroup,
    });
  }

  const allKeys = [...top.groups, ...bottom.groups].flatMap((group) => group.identityKeys);
  if (new Set(allKeys).size !== allKeys.length) {
    return unresolved('cantilever-tip-beam-main-identity-reused-across-groups', {
      topGroups: top.groups,
      bottomGroups: bottom.groups,
    });
  }

  return {
    resolved: true,
    identityReady: true,
    identityRequired: true,
    productionReady: false,
    applicable: true,
    reason: null,
    source: SOURCE,
    topGroups: top.groups,
    bottomGroups: bottom.groups,
    identityKeys: allKeys,
    blockers: ['cantilever-tip-beam-main-bar-geometry-not-yet-resolved'],
  };
}

export function attachSmallBeamCantileverTipBeamMainBarIdentity(facts, beamLayoutMap) {
  if (!facts?.beam) {
    return {
      ...(facts || {}),
      mainBarIdentityUnresolved: [],
    };
  }

  const mainBarIdentityUnresolved = [];
  for (const [elementId, fact] of facts.beam) {
    if (!fact?.resolved) continue;
    const tipBeamLayout = beamLayoutMap?.get?.(String(fact.tipBeamSection?.sectionId));
    fact.tipBeamMainBarIdentity = resolveSmallBeamCantileverTipBeamMainBarIdentity({
      fact,
      tipBeamLayout,
    });
    if (!fact.tipBeamMainBarIdentity.resolved) {
      mainBarIdentityUnresolved.push({
        elementId: String(elementId),
        tipBeamId: fact.tipBeamId || null,
        figureCase: fact.figureCase || null,
        reason: fact.tipBeamMainBarIdentity.reason,
      });
    }
  }

  return {
    ...facts,
    mainBarIdentityUnresolved,
  };
}
