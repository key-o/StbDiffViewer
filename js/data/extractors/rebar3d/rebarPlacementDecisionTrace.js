/**
 * @fileoverview 配筋配置の有効化・実行結果・競合判断のDecision Trace。
 * 入力factsは読み取り専用。判定記録をproduction geometryへ戻さない。
 */

import { createTrace } from './rebarDecisionTrace.js';
import { getRebarDetailingRule } from './rebarDetailingRuleRegistry.js';

export function buildRebarPlacementActivationTrace(
  activation,
  {
    modelSource = null,
    source = 'PROJECT_DETAILING:REBAR_PLACEMENT_CONFLICT_RULES',
    subjectType = 'REBAR_PLACEMENT_RULESET',
    subjectKey = null,
    decisionPrefix = 'REBAR_PLACEMENT_RULESET',
  } = {},
) {
  if (!activation?.active || activation?.resolved) return null;
  return createTrace({
    decisionId: `${decisionPrefix}:${modelSource || '-'}:ACTIVATION`,
    subjectType,
    subjectKey: subjectKey || modelSource || 'CURRENT_MODEL',
    disposition: 'UNRESOLVED',
    appliedRuleIds: ['REBAR-FAIL-CLOSED-UNRESOLVED'],
    unresolvedReason: activation.reason || 'rebar-placement-conflict-activation-unresolved',
    sources: [source],
    modelSource,
  });
}

function placementProductionSources(memberKey, activation) {
  const sources = [String(memberKey || '')];
  const ruleActivation = activation?.ruleActivation;
  if (ruleActivation?.active) {
    const autoRuleIds = new Set(ruleActivation.autoRuleIds || []);
    if (autoRuleIds.size > 0) {
      sources.push('RULE_REGISTRY:GEOMETRY_CONDITIONED_REBAR_PLACEMENT');
    }
    const projectRuleIds = (ruleActivation.enabledRuleIds || []).filter(
      (ruleId) => !autoRuleIds.has(ruleId),
    );
    if (ruleActivation.source === 'project-detailing' && projectRuleIds.length > 0) {
      sources.push('PROJECT_DETAILING:REBAR_PLACEMENT_CONFLICT_RULES');
    }
  }
  if (activation?.overrideActivation?.active) {
    sources.push('PROJECT_DETAILING:REBAR_PLACEMENT_CONFLICT_OVERRIDE');
  }
  return [...new Set(sources)];
}

export function buildRebarPlacementProductionTrace(
  memberKey,
  memberPlan,
  { modelSource = null, activation = null } = {},
) {
  if (!memberPlan || !['READY', 'UNRESOLVED'].includes(memberPlan.status)) return null;

  const ruleIds = new Set();
  const shifts = [...(memberPlan.barShifts?.values?.() || [])];
  for (const shift of shifts) {
    for (const ruleId of shift?.sourceRuleIds || []) {
      if (getRebarDetailingRule(ruleId)) ruleIds.add(ruleId);
    }
  }

  if (memberPlan.status === 'UNRESOLVED') {
    ruleIds.add('REBAR-FAIL-CLOSED-UNRESOLVED');
    return createTrace({
      decisionId: `REBAR_PLACEMENT_PRODUCTION:${modelSource || '-'}:${memberKey}`,
      subjectType: 'REBAR_PLACEMENT_PRODUCTION',
      subjectKey: String(memberKey || ''),
      disposition: 'UNRESOLVED',
      appliedRuleIds: [...ruleIds],
      unresolvedReason: memberPlan.reason || 'rebar-placement-conflict-production-unresolved',
      rejectedAlternatives: memberPlan.rejectedCandidates || [],
      sources: placementProductionSources(memberKey, activation),
      modelSource,
    });
  }

  const endpointShifts = [...(memberPlan.endpointShifts?.values?.() || [])];
  const deltas = (endpointShifts.length ? endpointShifts : shifts)
    .map((shift) => Number(shift?.deltaU))
    .filter(Number.isFinite)
    .map(Math.abs);
  const endpointLocal = memberPlan.applicationMode === 'ENDPOINT_LOCAL';
  return createTrace({
    decisionId: `REBAR_PLACEMENT_PRODUCTION:${modelSource || '-'}:${memberKey}`,
    subjectType: 'REBAR_PLACEMENT_PRODUCTION',
    subjectKey: String(memberKey || ''),
    disposition: endpointLocal ? 'ENDPOINT_LOCAL_INSET_READY' : 'MEMBER_LAYOUT_CLONE_READY',
    appliedRuleIds: [...ruleIds],
    metrics: {
      movedBarCount: shifts.length,
      movedEndpointCount: endpointLocal ? endpointShifts.length : null,
      maxAbsDeltaUMm: deltas.length ? Math.max(...deltas) : null,
    },
    sources: placementProductionSources(memberKey, activation),
    modelSource,
  });
}

export function buildRebarConflictDecisionTrace(
  decision,
  { decisionId = null, subjectKey = null, sources = [], modelSource = null, authoring = null } = {},
) {
  if (!decision || typeof decision !== 'object') {
    throw new TypeError('Rebar conflict decision is required');
  }
  const barA = decision.barA ?? null;
  const barB = decision.barB ?? null;
  const ruleIds = new Set();
  for (const rule of decision.appliedRules || []) {
    if (rule?.ruleId && getRebarDetailingRule(rule.ruleId)) ruleIds.add(rule.ruleId);
  }
  for (const ruleId of decision.supportingRuleIds || []) {
    if (getRebarDetailingRule(ruleId)) ruleIds.add(ruleId);
  }
  if (decision.reason === 'mobility-restraint-conflict') {
    ruleIds.add('REBAR-PLACEMENT-MOBILITY-RESTRAINT');
  }
  if (decision.status !== 'RESOLVED') {
    ruleIds.add('REBAR-FAIL-CLOSED-UNRESOLVED');
  }
  if (!ruleIds.size && decision.source === 'USER_OVERRIDE') {
    ruleIds.add('REBAR-PLACEMENT-EXPLICIT-MOBILITY-OVERRIDE');
  }

  return createTrace({
    decisionId: decisionId || `REBAR_CONFLICT:${barA ?? '-'}:${barB ?? '-'}`,
    subjectType: 'REBAR_PAIR_CONFLICT',
    subjectKey: subjectKey || `${barA ?? '-'}:${barB ?? '-'}`,
    disposition: decision.selectedAction || 'UNRESOLVED',
    appliedRuleIds: [...ruleIds],
    unresolvedReason:
      decision.status === 'RESOLVED' ? null : decision.reason || 'rebar-conflict-unresolved',
    sourceRef: barA,
    targetRef: barB,
    rejectedAlternatives: decision.rejectedAlternatives || [],
    sources,
    modelSource,
    authoring,
  });
}
