/**
 * @fileoverview Issue #273 Phase 1: existing R6/R7 factsからDecision Traceを生成するsidecar。
 *
 * 既存transition / matcher factsは変更せず読み取り専用で扱う。Phase 1のtraceは
 * production geometryの入力には戻さない。
 */

import { getRebarDetailingRule, rebarRuleTraceMetadata } from './rebarDetailingRuleRegistry.js';

function finiteOrNull(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactMetrics(values = {}) {
  const metrics = {};
  for (const [key, value] of Object.entries(values)) {
    const finite = finiteOrNull(value);
    if (finite !== null) metrics[key] = finite;
  }
  return metrics;
}

function barReference(bar, fallback) {
  if (!bar) return fallback;
  if (bar.identityKey) return String(bar.identityKey);
  const role = bar.role ?? 'BAR';
  const layer = bar.layer ?? '-';
  const index = bar.barIndex ?? bar.index ?? fallback;
  return `${role}:${layer}:${index}`;
}

function rulesForUnresolvedReason(reason) {
  if (reason === 'semantic-mismatch') return ['REBAR-SEMANTIC-MISMATCH-UNRESOLVED'];
  if (reason === 'ambiguous-position-match') return ['REBAR-AMBIGUOUS-MATCH-UNRESOLVED'];
  return ['REBAR-FAIL-CLOSED-UNRESOLVED'];
}

function validColumnBendWindow(transition) {
  if (transition?.disposition !== 'BENT_CONTINUOUS') return null;
  const lowerZ = transition.bendWindow?.lowerZ;
  const upperZ = transition.bendWindow?.upperZ;
  if (!Number.isFinite(lowerZ) || !Number.isFinite(upperZ) || !(upperZ > lowerZ)) {
    return null;
  }
  return { lowerZ, upperZ };
}

function columnTransitionUnresolvedReason(transition, bendWindow) {
  if (transition?.unresolvedReason) return transition.unresolvedReason;
  if (transition?.disposition !== 'BENT_CONTINUOUS' || bendWindow) return null;
  return transition.bendWindow == null
    ? 'column-bend-window-missing'
    : 'column-bend-window-invalid';
}

function createTrace({
  decisionId,
  subjectType,
  subjectKey,
  disposition,
  appliedRuleIds,
  metrics = {},
  unresolvedReason = null,
  sourceRef = null,
  targetRef = null,
  sources = [],
  rejectedAlternatives = [],
  modelSource = null,
  authoring = null,
}) {
  const appliedRules = appliedRuleIds.map(rebarRuleTraceMetadata);
  return Object.freeze({
    decisionId,
    subjectType,
    subjectKey,
    ...(modelSource ? { modelSource } : {}),
    ...(authoring ? { authoring } : {}),
    status: unresolvedReason ? 'UNRESOLVED' : 'RESOLVED',
    disposition,
    sourceRef,
    targetRef,
    appliedRules,
    rejectedAlternatives: Object.freeze(rejectedAlternatives.slice()),
    metrics: Object.freeze(compactMetrics(metrics)),
    unresolvedReason,
    provenance: Object.freeze({
      kind: 'SDV_GENERATED',
      sources: Object.freeze(sources.filter(Boolean).map(String)),
      rules: Object.freeze(appliedRules.map((rule) => rule.ruleId)),
      assumptions: Object.freeze([]),
    }),
    confidence: 'RULE_BASED',
    warnings: Object.freeze(unresolvedReason ? [unresolvedReason] : []),
  });
}

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

function columnTransitionRuleIds(transition) {
  const ids = ['REBAR-SEMANTIC-IDENTITY-MATCH'];
  if (transition.matchBasis === 'column-explicit-override') {
    ids.push('COLUMN-EXPLICIT-CONTINUITY-OVERRIDE');
  }
  if (transition.matchBasis === 'column-corner-priority') {
    ids.push('COLUMN-CORNER-PRIORITY');
  }
  if (transition.disposition === 'STRAIGHT') {
    ids.push('COLUMN-CONTINUITY-STRAIGHT-FIRST', 'COLUMN-STRAIGHT-EQUAL-POSITION');
  } else if (transition.disposition === 'BENT_CONTINUOUS') {
    ids.push('COLUMN-BENT-CONTINUOUS-ONE-SIXTH');
    if (validColumnBendWindow(transition)) {
      ids.push('COLUMN-BEND-POSITION-WITHIN-BEAM-MAIN-SPACING');
    }
  } else if (transition.disposition === 'SEPARATE_ANCHORAGE') {
    ids.push('COLUMN-SEPARATE-ANCHORAGE-OVER-ONE-SIXTH');
  } else {
    ids.push(...rulesForUnresolvedReason(transition.unresolvedReason));
  }
  return [...new Set(ids)];
}

function girderTransitionRuleIds(transition) {
  const ids = ['REBAR-SEMANTIC-IDENTITY-MATCH'];
  const horizontalCandidate =
    transition.candidateRuleId === 'GIRDER-BENT-HORIZONTAL-ONE-SIXTH-CANDIDATE';
  const productionReady = ['CENTERLINE_READY', 'THROUGH_READY'].includes(
    transition.productionStatus,
  );
  const productionUnresolved = transition.productionStatus === 'UNRESOLVED';

  if (transition.matchBasis === 'girder-explicit-override') {
    ids.push('GIRDER-EXPLICIT-CONTINUITY-OVERRIDE');
  }
  if (transition.matchBasis === 'world-straight-first') {
    ids.push('GIRDER-CONTINUITY-STRAIGHT-FIRST');
  }
  if (transition.matchBasis === 'girder-corner-priority') {
    ids.push('GIRDER-CORNER-PRIORITY');
  }
  if (transition.disposition === 'STRAIGHT_THROUGH') {
    ids.push('GIRDER-STRAIGHT-THROUGH');
  } else if (transition.disposition === 'BENT_VERTICAL_THROUGH') {
    ids.push('GIRDER-BENT-VERTICAL-ONE-SIXTH');
  }
  if (horizontalCandidate) {
    ids.push('GIRDER-BENT-HORIZONTAL-ONE-SIXTH-CANDIDATE');
  }

  if (productionUnresolved) {
    ids.push(
      ...rulesForUnresolvedReason(
        transition.productionReason ||
          transition.unresolvedReason ||
          'girder-production-unresolved',
      ),
    );
  } else if (
    transition.unresolvedReason === 'horizontal-offset-auto-bend-disabled' &&
    !(horizontalCandidate && productionReady)
  ) {
    ids.push('GIRDER-HORIZONTAL-OFFSET-AUTO-BEND-DISABLED');
  } else if (
    transition.unresolvedReason === 'vertical-bend-slope-exceeds-1-over-6' ||
    transition.unresolvedReason === 'horizontal-bend-slope-exceeds-1-over-6'
  ) {
    ids.push('GIRDER-SEPARATE-ANCHORAGE-OVER-ONE-SIXTH');
  } else if (transition.unresolvedReason && !productionReady) {
    ids.push(...rulesForUnresolvedReason(transition.unresolvedReason));
  }
  return [...new Set(ids)];
}

function girderTraceDisposition(transition) {
  if (transition?.productionStatus === 'CENTERLINE_READY' && transition?.productionDisposition) {
    return transition.productionDisposition;
  }
  return transition?.disposition || 'UNRESOLVED';
}

function girderTraceUnresolvedReason(transition) {
  if (transition?.productionStatus === 'UNRESOLVED') {
    return (
      transition.productionReason || transition.unresolvedReason || 'girder-production-unresolved'
    );
  }
  if (['CENTERLINE_READY', 'THROUGH_READY'].includes(transition?.productionStatus)) {
    return null;
  }
  return transition?.unresolvedReason || null;
}

function girderTraceRatio(transition) {
  const readinessRatio = finiteOrNull(transition?.productionReadiness?.ratio);
  if (readinessRatio !== null) return readinessRatio;

  const productionJtMm = finiteOrNull(transition?.productionWindow?.jtMm);
  const eMm = finiteOrNull(transition?.eMm);
  if (productionJtMm !== null && productionJtMm > 0 && eMm !== null) {
    return eMm / productionJtMm;
  }
  return transition?.ratio;
}

function appendUnresolvedMatchTraces(
  result,
  memberType,
  nodeId,
  matches,
  sourceIds = [],
  modelSource = null,
) {
  for (const [index, match] of (matches || []).entries()) {
    result.push(
      createTrace({
        decisionId: `${memberType}:${nodeId}:UNRESOLVED_MATCH:${index}`,
        subjectType: `${memberType}_BAR_MATCH`,
        subjectKey: `${nodeId}:${match.semanticKey || match.baseKey || index}`,
        disposition: 'UNRESOLVED',
        appliedRuleIds: rulesForUnresolvedReason(match.reason),
        unresolvedReason: match.reason || 'match-unresolved',
        sources: sourceIds,
        modelSource,
      }),
    );
  }
}

function appendUnmatchedBarTraces(
  result,
  memberType,
  nodeId,
  side,
  bars,
  sourceIds = [],
  modelSource = null,
) {
  for (const [index, bar] of (bars || []).entries()) {
    result.push(
      createTrace({
        decisionId: `${memberType}:${nodeId}:UNMATCHED_${side}:${index}`,
        subjectType: `${memberType}_BAR_MATCH`,
        subjectKey: `${nodeId}:${barReference(bar, index)}`,
        disposition: 'UNMATCHED',
        appliedRuleIds: ['REBAR-FAIL-CLOSED-UNRESOLVED'],
        unresolvedReason: `unmatched-${String(side).toLowerCase()}-bar`,
        sourceRef: side === 'LOWER' || side === 'LEFT' ? barReference(bar, index) : null,
        targetRef: side === 'UPPER' || side === 'RIGHT' ? barReference(bar, index) : null,
        sources: sourceIds,
        modelSource,
      }),
    );
  }
}

function appendColumnCountChangeTraces(result, joint, sourceIds = [], modelSource = null) {
  const ruleIds = ['COLUMN-COUNT-CHANGE-NEW-TERMINATE'];
  if (Number(joint?.priorityResolver?.cornerMatchCount) > 0) {
    ruleIds.push('COLUMN-CORNER-PRIORITY');
  }

  for (const [index, assignment] of (joint?.countChangeAssignments || []).entries()) {
    const disposition = assignment?.disposition;
    if (!['NEW', 'TERMINATE'].includes(disposition) || !assignment?.bar) continue;
    const ref = barReference(assignment.bar, index);
    result.push(
      createTrace({
        decisionId: `COLUMN:${joint.nodeId}:${disposition}:${ref}`,
        subjectType: 'COLUMN_BAR_COUNT_CHANGE',
        subjectKey: `${joint.nodeId}:${ref}`,
        disposition,
        appliedRuleIds: ruleIds,
        sourceRef: disposition === 'TERMINATE' ? ref : null,
        targetRef: disposition === 'NEW' ? ref : null,
        sources: sourceIds,
        modelSource,
      }),
    );
  }
}

function appendGirderCountChangeTraces(result, joint, sourceIds = [], modelSource = null) {
  const ruleIds = ['GIRDER-COUNT-CHANGE-NEW-TERMINATE'];
  if (Number(joint?.priorityResolver?.cornerMatchCount) > 0) {
    ruleIds.push('GIRDER-CORNER-PRIORITY');
  }

  for (const [index, assignment] of (joint?.countChangeAssignments || []).entries()) {
    const disposition = assignment?.disposition;
    if (!['NEW', 'TERMINATE'].includes(disposition) || !assignment?.bar) continue;
    const ref = barReference(assignment.bar, index);
    result.push(
      createTrace({
        decisionId: `GIRDER:${joint.nodeId}:${disposition}:${ref}`,
        subjectType: 'GIRDER_BAR_COUNT_CHANGE',
        subjectKey: `${joint.nodeId}:${ref}`,
        disposition,
        appliedRuleIds: ruleIds,
        sourceRef: disposition === 'TERMINATE' ? ref : null,
        targetRef: disposition === 'NEW' ? ref : null,
        sources: sourceIds,
        modelSource,
      }),
    );
  }
}

export function buildColumnJointDecisionTraces(facts) {
  const result = [];
  for (const joint of facts?.joints || []) {
    const modelSource = joint.modelSource || null;
    const sources = [
      joint.lowerColumnId ? `StbColumn:${joint.lowerColumnId}` : null,
      joint.upperColumnId ? `StbColumn:${joint.upperColumnId}` : null,
      joint.explicitOverride?.active ? 'PROJECT_DETAILING:COLUMN_BAR_CONTINUITY_OVERRIDE' : null,
    ];
    if (joint.unresolvedReason) {
      const appliedRuleIds = ['REBAR-FAIL-CLOSED-UNRESOLVED'];
      if (joint.explicitOverride?.active) {
        appliedRuleIds.push('COLUMN-EXPLICIT-CONTINUITY-OVERRIDE');
      }
      result.push(
        createTrace({
          decisionId: `COLUMN:${joint.nodeId}:JOINT`,
          subjectType: 'COLUMN_JOINT',
          subjectKey: String(joint.nodeId),
          disposition: 'UNRESOLVED',
          appliedRuleIds,
          unresolvedReason: joint.unresolvedReason,
          sources,
          modelSource,
        }),
      );
    }
    for (const [index, transition] of (joint.transitions || []).entries()) {
      const bendWindow = validColumnBendWindow(transition);
      result.push(
        createTrace({
          decisionId: transition.identityKey || `COLUMN:${joint.nodeId}:TRANSITION:${index}`,
          subjectType: 'COLUMN_BAR_TRANSITION',
          subjectKey: transition.identityKey || `${joint.nodeId}:${index}`,
          disposition: transition.disposition,
          appliedRuleIds: columnTransitionRuleIds(transition),
          metrics: {
            eMm: transition.eMm,
            jtMm: transition.jtMm,
            ratio: transition.ratio,
            bendWindowLowerZMm: bendWindow?.lowerZ,
            bendWindowUpperZMm: bendWindow?.upperZ,
          },
          unresolvedReason: columnTransitionUnresolvedReason(transition, bendWindow),
          sourceRef: barReference(transition.bottomBar, `BOTTOM:${index}`),
          targetRef: barReference(transition.topBar, `TOP:${index}`),
          rejectedAlternatives: transition.rejectedAlternatives || [],
          sources,
          modelSource,
        }),
      );
    }
    appendUnresolvedMatchTraces(
      result,
      'COLUMN',
      joint.nodeId,
      joint.unresolvedMatches,
      sources,
      modelSource,
    );
    if (joint.countChangeAssignments?.length) {
      appendColumnCountChangeTraces(result, joint, sources, modelSource);
    } else {
      appendUnmatchedBarTraces(
        result,
        'COLUMN',
        joint.nodeId,
        'LOWER',
        joint.unmatchedLowerBars,
        sources,
        modelSource,
      );
      appendUnmatchedBarTraces(
        result,
        'COLUMN',
        joint.nodeId,
        'UPPER',
        joint.unmatchedUpperBars,
        sources,
        modelSource,
      );
    }
  }
  for (const [index, joint] of (facts?.unresolvedJoints || []).entries()) {
    result.push(
      createTrace({
        decisionId: `COLUMN:${joint.nodeId}:UNRESOLVED_JOINT:${index}`,
        subjectType: 'COLUMN_JOINT',
        subjectKey: String(joint.nodeId),
        disposition: 'UNRESOLVED',
        appliedRuleIds: ['REBAR-FAIL-CLOSED-UNRESOLVED'],
        unresolvedReason: joint.reason || 'column-joint-unresolved',
        sources: [...(joint.lowerColumnIds || []), ...(joint.upperColumnIds || [])].map(
          (id) => `StbColumn:${id}`,
        ),
        modelSource: joint.modelSource || null,
      }),
    );
  }
  return Object.freeze(result);
}

export function buildGirderJointDecisionTraces(facts) {
  const result = [];
  for (const joint of facts?.joints || []) {
    const modelSource = joint.modelSource || null;
    const sources = [
      joint.leftGirderId ? `StbGirder:${joint.leftGirderId}` : null,
      joint.rightGirderId ? `StbGirder:${joint.rightGirderId}` : null,
      joint.explicitOverride?.active ? 'PROJECT_DETAILING:GIRDER_BAR_CONTINUITY_OVERRIDE' : null,
    ];
    if (joint.unresolvedReason) {
      const appliedRuleIds = ['REBAR-FAIL-CLOSED-UNRESOLVED'];
      if (joint.explicitOverride?.active) {
        appliedRuleIds.push('GIRDER-EXPLICIT-CONTINUITY-OVERRIDE');
      }
      result.push(
        createTrace({
          decisionId: `GIRDER:${joint.nodeId}:JOINT`,
          subjectType: 'GIRDER_JOINT',
          subjectKey: String(joint.nodeId),
          disposition: 'UNRESOLVED',
          appliedRuleIds,
          unresolvedReason: joint.unresolvedReason,
          sources,
          modelSource,
        }),
      );
    }
    for (const [index, transition] of (joint.transitions || []).entries()) {
      result.push(
        createTrace({
          decisionId: `GIRDER:${joint.nodeId}:TRANSITION:${index}`,
          subjectType: 'GIRDER_BAR_TRANSITION',
          subjectKey: `${joint.nodeId}:${index}`,
          disposition: girderTraceDisposition(transition),
          appliedRuleIds: girderTransitionRuleIds(transition),
          metrics: {
            eMm: transition.eMm,
            jtMm: transition.productionWindow?.jtMm ?? transition.jtMm,
            ratio: girderTraceRatio(transition),
            horizontalRatio: transition.horizontalRatio,
            verticalRatio: transition.verticalRatio,
            horizontalOffsetMm: transition.horizontalOffsetMm,
            verticalOffsetMm: transition.verticalOffsetMm,
            productionClearanceMm: transition.productionReadiness?.clearance?.minimumClearMm,
            productionPathOuterDiameterMm: transition.productionReadiness?.pathOuterDiameterMm,
          },
          unresolvedReason: girderTraceUnresolvedReason(transition),
          sourceRef: barReference(transition.leftBar, `LEFT:${index}`),
          targetRef: barReference(transition.rightBar, `RIGHT:${index}`),
          rejectedAlternatives: transition.rejectedAlternatives || [],
          sources,
          modelSource,
        }),
      );
    }
    appendUnresolvedMatchTraces(
      result,
      'GIRDER',
      joint.nodeId,
      joint.unresolvedMatches,
      sources,
      modelSource,
    );
    if (joint.countChangeAssignments?.length) {
      appendGirderCountChangeTraces(result, joint, sources, modelSource);
    } else {
      appendUnmatchedBarTraces(
        result,
        'GIRDER',
        joint.nodeId,
        'LEFT',
        joint.unmatchedLeftBars,
        sources,
        modelSource,
      );
      appendUnmatchedBarTraces(
        result,
        'GIRDER',
        joint.nodeId,
        'RIGHT',
        joint.unmatchedRightBars,
        sources,
        modelSource,
      );
    }
  }
  for (const [index, joint] of (facts?.unresolvedJoints || []).entries()) {
    result.push(
      createTrace({
        decisionId: `GIRDER:${joint.nodeId}:UNRESOLVED_JOINT:${index}`,
        subjectType: 'GIRDER_JOINT',
        subjectKey: String(joint.nodeId),
        disposition: 'UNRESOLVED',
        appliedRuleIds: ['REBAR-FAIL-CLOSED-UNRESOLVED'],
        unresolvedReason: joint.reason || 'girder-joint-unresolved',
        sources: (joint.girderIds || []).map((id) => `StbGirder:${id}`),
        modelSource: joint.modelSource || null,
      }),
    );
  }
  return Object.freeze(result);
}

const GIRDER_HAUNCH_RULE_ID = 'GIRDER-HAUNCH-CORNER-CONTINUITY';
const GIRDER_HAUNCH_FAIL_CLOSED_RULE_ID = 'REBAR-FAIL-CLOSED-UNRESOLVED';

function compareTraceText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactHaunchId(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function freezeTraceValue(value) {
  if (Array.isArray(value)) {
    value.forEach(freezeTraceValue);
    return Object.freeze(value);
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeTraceValue);
    return Object.freeze(value);
  }
  return value;
}

function haunchEndpointTransitionCandidates(plan, memberId, side) {
  const transitions = plan?.memberTransitions?.get?.(memberId) || [];
  return transitions
    .filter((transition) => transition?.side === side)
    .map((transition) => ({
      role: transition.role ?? null,
      layer: finiteOrNull(transition.layer),
      diaMm: finiteOrNull(transition.diaMm),
      grade: exactHaunchId(transition.grade),
      lengthMm: finiteOrNull(transition.lengthMm),
      endpointZone: exactHaunchId(transition.endpointZone),
      targetZone: exactHaunchId(transition.targetZone),
      from: {
        u: finiteOrNull(transition.from?.u),
        v: finiteOrNull(transition.from?.v),
      },
      to: {
        u: finiteOrNull(transition.to?.u),
        v: finiteOrNull(transition.to?.v),
      },
      sourceCheck: transition.sourceCheck || null,
    }));
}

function haunchTransitionGeometryIsValid(candidate) {
  return (
    ['top', 'bottom'].includes(candidate.role) &&
    Number.isInteger(candidate.layer) &&
    candidate.layer > 0 &&
    Number.isFinite(candidate.diaMm) &&
    candidate.diaMm > 0 &&
    Number.isFinite(candidate.lengthMm) &&
    candidate.lengthMm > 0 &&
    [candidate.from.u, candidate.from.v, candidate.to.u, candidate.to.v].every(Number.isFinite)
  );
}

function haunchUnresolvedReason(checks, transitionCandidates, memberId) {
  const explicitSource = checks.every(
    (check) =>
      typeof check.haunchGeometrySource === 'string' &&
      check.haunchGeometrySource.startsWith('stb-'),
  );
  if (!explicitSource) return 'girder-haunch-explicit-stb-source-unresolved';
  if (!memberId) return 'girder-haunch-member-id-unresolved';

  const gateBlockers = checks.flatMap((check) => [
    ...(Array.isArray(check.productionGateBlockers) ? check.productionGateBlockers : []),
    check.haunchProductionBlocker,
  ]);
  const firstGateBlocker = gateBlockers.find((blocker) => typeof blocker === 'string' && blocker);
  if (firstGateBlocker) return firstGateBlocker;

  const gateReady = checks.every(
    (check) =>
      check.productionGateStatus === 'READY' &&
      check.productionGateReady === true &&
      check.productionGateMode === 'STANDARD_WITH_STB' &&
      check.productionPathCandidate === true,
  );
  if (!gateReady) return 'girder-haunch-production-gate-unresolved';

  if (checks.some((check) => check.haunchKind !== 'SLOPE')) {
    return checks.some((check) => check.haunchKind === 'DROP')
      ? 'stb-haunch-drop-production-unsupported'
      : 'stb-haunch-kind-unresolved';
  }

  for (const check of checks) {
    const lengthMm = finiteOrNull(check.haunchLengthMm);
    const memberLengthMm = finiteOrNull(check.memberLengthMm);
    if (!(lengthMm > 0)) return 'stb-haunch-length-unresolved';
    if (!(memberLengthMm > 0)) return 'stb-girder-member-length-unresolved';
    if (lengthMm >= memberLengthMm) return 'stb-haunch-length-outside-member';
    if (!check.haunchProductionGeometry) return 'stb-haunch-production-geometry-unresolved';

    const expectedCount = Number(check.count);
    const normalizedGrade = (value) =>
      String(value || '')
        .trim()
        .toUpperCase();
    const actualCount = transitionCandidates.filter(
      (candidate) =>
        Number(candidate.diaMm) === Number(check.diaMm) &&
        normalizedGrade(candidate.grade) === normalizedGrade(check.grade),
    ).length;
    if (!Number.isInteger(expectedCount) || expectedCount <= 0 || actualCount !== expectedCount) {
      return 'stb-haunch-corner-transition-count-inconsistent';
    }
  }

  if (!transitionCandidates.length) return 'girder-haunch-transition-candidates-missing';
  if (transitionCandidates.some((candidate) => !haunchTransitionGeometryIsValid(candidate))) {
    return 'stb-haunch-corner-transition-position-unresolved';
  }
  return null;
}

/**
 * Convert existing STB-explicit girder haunch checks and the render plan's member-local
 * transition specs into a read-only B-005 candidate trace. The specs remain candidates here;
 * this trace does not assert that a RebarPath or viewer geometry was generated.
 *
 * @param {{checks?:Array<Object>,memberTransitions?:Map<string,Array<Object>>}} haunchPlan
 * @param {{modelSource?:'A'|'B'|string|null}} [options]
 * @returns {ReadonlyArray<Object>}
 */
export function buildGirderHaunchDecisionTraces(haunchPlan, { modelSource = null } = {}) {
  const groupedChecks = new Map();
  for (const check of Array.isArray(haunchPlan?.checks) ? haunchPlan.checks : []) {
    if (
      check?.specialDetailingType !== 'GIRDER_HAUNCH_CORNER_CONTINUITY' ||
      check?.specialDetailingRequired !== true
    ) {
      continue;
    }
    const memberId = exactHaunchId(check.elementId);
    const side = check.side === 'start' || check.side === 'end' ? check.side : 'unknown';
    const key = `${memberId || '-'}|${side}`;
    const group = groupedChecks.get(key) || { memberId, side, checks: [] };
    group.checks.push(check);
    groupedChecks.set(key, group);
  }

  const candidateRule = rebarRuleTraceMetadata(GIRDER_HAUNCH_RULE_ID);
  const failClosedRule = rebarRuleTraceMetadata(GIRDER_HAUNCH_FAIL_CLOSED_RULE_ID);
  const traces = [];
  for (const { memberId, side, checks } of groupedChecks.values()) {
    const orderedChecks = checks
      .slice()
      .sort((left, right) =>
        compareTraceText(
          `${left.role || ''}:${left.diaMm ?? ''}:${left.grade || ''}`,
          `${right.role || ''}:${right.diaMm ?? ''}:${right.grade || ''}`,
        ),
      );
    const rawTransitions = haunchEndpointTransitionCandidates(haunchPlan, memberId, side);
    const unresolvedReason = haunchUnresolvedReason(orderedChecks, rawTransitions, memberId);
    const isCandidate = !unresolvedReason;
    const transitionFacts = rawTransitions.map(({ sourceCheck: _sourceCheck, ...candidate }) =>
      freezeTraceValue(candidate),
    );
    const gateStatuses = [
      ...new Set(
        orderedChecks.map((check) => exactHaunchId(check.productionGateStatus) || 'UNKNOWN'),
      ),
    ].sort(compareTraceText);
    const gateModes = [
      ...new Set(
        orderedChecks.map((check) => exactHaunchId(check.productionGateMode) || 'UNKNOWN'),
      ),
    ].sort(compareTraceText);
    const gateBlockers = [
      ...new Set(
        orderedChecks
          .flatMap((check) => [
            ...(Array.isArray(check.productionGateBlockers) ? check.productionGateBlockers : []),
            check.haunchProductionBlocker,
          ])
          .filter((blocker) => typeof blocker === 'string' && blocker),
      ),
    ].sort(compareTraceText);
    const firstCheck = orderedChecks[0];
    const sourceIds = [
      memberId ? `StbGirder:${memberId}` : null,
      'R8-D:girderHaunchRenderPlan.checks',
      rawTransitions.length ? 'R8-D:girderHaunchRenderPlan.memberTransitions' : null,
      ...orderedChecks.map((check) =>
        check.haunchGeometrySource ? `STB_HAUNCH_SOURCE:${check.haunchGeometrySource}` : null,
      ),
      `RULE_REGISTRY:${GIRDER_HAUNCH_RULE_ID}`,
    ].filter(Boolean);
    const appliedRules = unresolvedReason ? [failClosedRule] : [];
    const subjectKey = `${memberId || 'UNKNOWN'}:${side}`;
    const candidateFacts = freezeTraceValue({
      memberId,
      memberName: exactHaunchId(firstCheck.elementName),
      sectionName: exactHaunchId(firstCheck.sectionName),
      side,
      haunchKind: exactHaunchId(firstCheck.haunchKind),
      haunchHorizontalType: exactHaunchId(firstCheck.haunchHorizontalType),
      haunchVerticalType: exactHaunchId(firstCheck.haunchVerticalType),
      haunchGeometrySource: exactHaunchId(firstCheck.haunchGeometrySource),
      productionGateStatuses: gateStatuses,
      productionGateModes: gateModes,
      productionGateBlockers: gateBlockers,
      candidatePath: {
        status: isCandidate ? 'CANDIDATE' : 'UNRESOLVED',
        source: rawTransitions.length ? 'R8-D:girderHaunchRenderPlan.memberTransitions' : null,
        rebarPathGenerationEvidence: 'NOT_REPORTED',
        transitionCandidates: transitionFacts,
      },
    });

    traces.push(
      Object.freeze({
        decisionId: `GIRDER_HAUNCH:${modelSource || '-'}:${memberId || 'UNKNOWN'}:${side}:B005`,
        subjectType: 'GIRDER_HAUNCH_CORNER_CONTINUITY',
        subjectKey,
        ...(modelSource ? { modelSource } : {}),
        status: isCandidate ? 'RESOLVED' : 'UNRESOLVED',
        disposition: isCandidate ? 'BENT_THROUGH_PATH_CANDIDATE' : 'UNRESOLVED',
        sourceRef: memberId ? `StbGirder:${memberId}` : null,
        targetRef: null,
        candidateRules: Object.freeze([candidateRule]),
        appliedRules: Object.freeze(appliedRules),
        rejectedAlternatives: Object.freeze([]),
        metrics: Object.freeze(
          compactMetrics({
            haunchLengthMm: firstCheck.haunchLengthMm,
            memberLengthMm: firstCheck.memberLengthMm,
            candidateTransitionCount: transitionFacts.length,
          }),
        ),
        unresolvedReason,
        unresolvedPrerequisites: Object.freeze(
          unresolvedReason
            ? [...new Set([...gateBlockers, unresolvedReason])].sort(compareTraceText)
            : [],
        ),
        candidateFacts,
        provenance: Object.freeze({
          kind: 'SDV_GENERATED',
          sources: Object.freeze([...new Set(sourceIds)]),
          rules: Object.freeze(appliedRules.map((rule) => rule.ruleId)),
          assumptions: Object.freeze([]),
        }),
        confidence: 'RULE_BASED',
        warnings: Object.freeze(unresolvedReason ? [unresolvedReason] : []),
      }),
    );
  }

  traces.sort(
    (left, right) =>
      compareTraceText(left.subjectKey, right.subjectKey) ||
      compareTraceText(left.decisionId, right.decisionId),
  );
  return Object.freeze(traces);
}

function wallSpliceRegionSource(region) {
  if (!region?.memberType || !region?.memberId) return null;
  const prefix =
    region.memberType === 'COLUMN'
      ? 'StbColumn'
      : region.memberType === 'GIRDER'
        ? 'StbGirder'
        : region.memberType === 'BEAM'
          ? 'StbBeam'
          : null;
  return prefix ? `${prefix}:${region.memberId}` : null;
}

function wallWallSourceRuleIds(classification) {
  const ids = [];
  for (const treatment of classification?.treatments || []) {
    if (treatment?.disposition === 'L1_LAP') ids.push('WALL-WALL-L1-LAP');
    if (treatment?.disposition === 'L2_ANCHORAGE') ids.push('WALL-WALL-L2-ANCHORAGE');
    if (treatment?.disposition === 'CONTINUOUS_THROUGH') ids.push('WALL-WALL-T-MAIN-THROUGH');
  }
  if (classification?.status === 'REJECTED') {
    ids.push('WALL-JUNCTION-SUPPLEMENTAL-MIN-DIA');
  }
  if (classification?.status === 'UNRESOLVED') {
    ids.push('REBAR-FAIL-CLOSED-UNRESOLVED');
  }
  return [...new Set(ids)];
}

export function buildWallWallJunctionSourceDecisionTraces(
  classifications,
  { modelSource = null } = {},
) {
  const values = Array.isArray(classifications)
    ? classifications
    : classifications
      ? [classifications]
      : [];
  const result = [];
  for (const [index, classification] of values.entries()) {
    const unresolved = classification?.status === 'UNRESOLVED';
    const rejected = classification?.status === 'REJECTED';
    const disposition = unresolved
      ? 'UNRESOLVED'
      : rejected
        ? 'SOURCE_TREATMENT_REJECTED'
        : 'SOURCE_TREATMENT_CLASSIFIED';
    result.push(
      createTrace({
        decisionId: `WALL_WALL_SOURCE:${modelSource || '-'}:${index}`,
        subjectType: 'WALL_WALL_SOURCE_TREATMENT',
        subjectKey: `${classification?.topology || '-'}:${classification?.pattern || '-'}:${classification?.horizontalSpacingRelation || '-'}:${index}`,
        disposition,
        appliedRuleIds: wallWallSourceRuleIds(classification),
        metrics: {
          treatmentCount: classification?.treatments?.length,
        },
        unresolvedReason: unresolved
          ? classification.reason || 'wall-wall-source-treatment-unresolved'
          : null,
        rejectedAlternatives: rejected ? [classification] : [],
        sources: classification?.sourceFigure
          ? [`NIKKENREN_JSCA_RC_DETAILING_20230401_FIG_${classification.sourceFigure}`]
          : [],
        modelSource,
      }),
    );
  }
  return Object.freeze(result);
}

export function buildWallJunctionSupplementalGateDecisionTraces(
  evaluations,
  { modelSource = null } = {},
) {
  const values = Array.isArray(evaluations) ? evaluations : evaluations ? [evaluations] : [];
  const result = [];
  for (const [index, evaluation] of values.entries()) {
    const unresolved = evaluation?.status === 'UNRESOLVED';
    const disposition =
      evaluation?.status === 'PASS'
        ? 'SUPPLEMENTAL_DIA_ACCEPTED'
        : evaluation?.status === 'REJECTED'
          ? 'SUPPLEMENTAL_DIA_REJECTED'
          : 'UNRESOLVED';
    const appliedRuleIds = ['WALL-JUNCTION-SUPPLEMENTAL-MIN-DIA'];
    if (unresolved) appliedRuleIds.push('REBAR-FAIL-CLOSED-UNRESOLVED');
    result.push(
      createTrace({
        decisionId: `WALL_JUNCTION_SUPPLEMENTAL:${modelSource || '-'}:${index}`,
        subjectType: 'WALL_JUNCTION_SUPPLEMENTAL',
        subjectKey: `${modelSource || '-'}:${index}`,
        disposition,
        appliedRuleIds,
        metrics: {
          verticalDiaMm: evaluation?.directions?.vertical?.actualDiaMm,
          verticalRequiredDiaMm: evaluation?.directions?.vertical?.requiredDiaMm,
          horizontalDiaMm: evaluation?.directions?.horizontal?.actualDiaMm,
          horizontalRequiredDiaMm: evaluation?.directions?.horizontal?.requiredDiaMm,
        },
        unresolvedReason: unresolved
          ? evaluation.reason || 'wall-junction-supplemental-dia-unresolved'
          : null,
        rejectedAlternatives:
          evaluation?.status === 'REJECTED'
            ? [evaluation?.directions?.vertical, evaluation?.directions?.horizontal].filter(
                (item) => item?.status === 'REJECTED',
              )
            : [],
        sources: ['NIKKENREN_JSCA_RC_DETAILING_20230401_§11-2'],
        modelSource,
      }),
    );
  }
  return Object.freeze(result);
}

export function buildWallRebarSpliceGateDecisionTraces(evaluations, { modelSource = null } = {}) {
  const result = [];
  for (const [index, evaluation] of (evaluations || []).entries()) {
    const unresolved = evaluation?.status === 'UNRESOLVED';
    const disposition =
      evaluation?.status === 'PASS'
        ? 'SPLICE_REGION_ACCEPTED'
        : evaluation?.status === 'REJECTED'
          ? 'SPLICE_REGION_REJECTED'
          : 'UNRESOLVED';
    const appliedRuleIds = ['WALL-SPLICE-IN-WALL'];
    if (unresolved) appliedRuleIds.push('REBAR-FAIL-CLOSED-UNRESOLVED');
    result.push(
      createTrace({
        decisionId:
          evaluation?.candidateKey ||
          `WALL_SPLICE:${modelSource || '-'}:${evaluation?.wallMemberId || '-'}:${index}`,
        subjectType: 'WALL_SPLICE_REGION',
        subjectKey:
          evaluation?.candidateKey ||
          evaluation?.barIdentity ||
          `${evaluation?.wallMemberId || '-'}:${index}`,
        disposition,
        appliedRuleIds,
        metrics: {
          spliceStartStationMm: evaluation?.candidateInterval?.startStationMm,
          spliceEndStationMm: evaluation?.candidateInterval?.endStationMm,
          blockingRegionCount: evaluation?.blockingRegions?.length,
        },
        unresolvedReason: unresolved ? evaluation.reason || 'wall-splice-region-unresolved' : null,
        sourceRef: evaluation?.barIdentity || null,
        rejectedAlternatives:
          evaluation?.status === 'REJECTED' ? evaluation.blockingRegions || [] : [],
        sources: [
          evaluation?.wallMemberId ? `StbWall:${evaluation.wallMemberId}` : null,
          ...(evaluation?.blockingRegions || []).map(wallSpliceRegionSource),
        ],
        modelSource,
      }),
    );
  }
  return Object.freeze(result);
}

export function buildWallRebarAdjacencyDecisionTraces(adjacency) {
  const result = [];
  for (const candidate of adjacency?.candidates || []) {
    result.push(
      createTrace({
        decisionId: candidate.candidateKey,
        subjectType: 'WALL_BAR_ADJACENCY',
        subjectKey: candidate.candidateKey,
        disposition: 'ADJACENT_CANDIDATE',
        appliedRuleIds: ['REBAR-SEMANTIC-IDENTITY-MATCH', 'WALL-ADJACENCY-ONE-TO-ONE'],
        metrics: {
          boundaryLengthMm: candidate.boundaryLengthMm,
          endpointGapMm: candidate.endpointGapMm,
          axisDotAbs: candidate.axisDotAbs,
        },
        sourceRef: candidate.sourceSegmentIdentity || candidate.sourceIdentity || null,
        targetRef: candidate.targetSegmentIdentity || candidate.targetIdentity || null,
        sources: [
          candidate.sourceMemberId ? `StbWall:${candidate.sourceMemberId}` : null,
          candidate.targetMemberId ? `StbWall:${candidate.targetMemberId}` : null,
        ],
        modelSource: candidate.modelSource || adjacency?.modelSource || null,
      }),
    );
  }

  for (const [index, unresolved] of (adjacency?.unresolved || []).entries()) {
    const sourceRef =
      unresolved.sourceSegmentIdentity ||
      unresolved.sourceIdentity ||
      unresolved.sourceMemberId ||
      null;
    const targetRef =
      unresolved.targetSegmentIdentity ||
      unresolved.targetIdentity ||
      unresolved.targetMemberId ||
      null;
    result.push(
      createTrace({
        decisionId:
          unresolved.decisionId ||
          `WALL_ADJACENCY:${adjacency?.modelSource || '-'}:UNRESOLVED:${index}`,
        subjectType: unresolved.subjectType || 'WALL_ADJACENCY',
        subjectKey:
          unresolved.boundaryKey ||
          unresolved.sourceSegmentIdentity ||
          unresolved.targetSegmentIdentity ||
          `UNRESOLVED:${index}`,
        disposition: 'UNRESOLVED',
        appliedRuleIds: ['WALL-ADJACENCY-ONE-TO-ONE', 'REBAR-FAIL-CLOSED-UNRESOLVED'],
        unresolvedReason: unresolved.reason || 'wall-adjacency-unresolved',
        sourceRef,
        targetRef,
        rejectedAlternatives: [unresolved],
        sources: [
          unresolved.sourceMemberId ? `StbWall:${unresolved.sourceMemberId}` : null,
          unresolved.targetMemberId ? `StbWall:${unresolved.targetMemberId}` : null,
        ],
        modelSource: adjacency?.modelSource || null,
      }),
    );
  }

  return Object.freeze(result);
}

export function buildWallRebarSemanticDecisionTraces(topology) {
  const result = [];
  for (const [index, fact] of (topology?.facts || []).entries()) {
    result.push(
      createTrace({
        decisionId: `WALL:${fact.modelSource || '-'}:${fact.memberId}:SEMANTIC:${fact.barIndex}:${fact.segmentIndex}`,
        subjectType: 'WALL_BAR_SEMANTIC',
        subjectKey: fact.segmentIdentity || fact.semanticIdentity || `WALL:${index}`,
        disposition: 'CLASSIFIED',
        appliedRuleIds: ['REBAR-SEMANTIC-IDENTITY-MATCH'],
        sourceRef: fact.sourceIdentityKey || null,
        sources: [
          fact.memberId ? `StbWall:${fact.memberId}` : null,
          fact.sectionId ? `StbSecWall_RC:${fact.sectionId}` : null,
        ],
        modelSource: fact.modelSource || null,
      }),
    );
  }
  for (const [index, unresolved] of (topology?.unresolved || []).entries()) {
    result.push(
      createTrace({
        decisionId: `WALL:${unresolved.modelSource || '-'}:${unresolved.memberId || '-'}:SEMANTIC_UNRESOLVED:${index}`,
        subjectType: 'WALL_BAR_SEMANTIC',
        subjectKey: unresolved.sourceIdentityKey || `WALL_UNRESOLVED:${index}`,
        disposition: 'UNRESOLVED',
        appliedRuleIds: ['REBAR-FAIL-CLOSED-UNRESOLVED'],
        unresolvedReason: unresolved.reason || 'wall-semantic-unresolved',
        sourceRef: unresolved.sourceIdentityKey || null,
        sources: [unresolved.memberId ? `StbWall:${unresolved.memberId}` : null],
        modelSource: unresolved.modelSource || null,
      }),
    );
  }
  return Object.freeze(result);
}

function stbMemberSource(context) {
  if (!context?.memberId) return null;
  const tag = context.memberTag || 'StbGirder';
  return `${tag}:${context.memberId}`;
}

export function buildFoundationBeamCountDifferenceDecisionTraces(
  resolutions,
  { modelSource = null } = {},
) {
  const snapshot =
    !Array.isArray(resolutions) && Array.isArray(resolutions?.joints) ? resolutions : null;
  const values = snapshot
    ? snapshot.joints
    : Array.isArray(resolutions)
      ? resolutions
      : resolutions
        ? [resolutions]
        : [];
  const result = [];

  for (const [resolutionIndex, resolution] of values.entries()) {
    const sources = [stbMemberSource(resolution?.left), stbMemberSource(resolution?.right)];
    const nodeId = resolution?.nodeId || '-';

    for (const [index, match] of (resolution?.matches || []).entries()) {
      result.push(
        createTrace({
          decisionId: `FOUNDATION_BEAM:${nodeId}:THROUGH:${resolutionIndex}:${index}`,
          subjectType: 'FOUNDATION_BEAM_BAR_CONTINUITY',
          subjectKey: `${nodeId}:${match.leftBarRef || index}`,
          disposition: 'THROUGH_CANDIDATE',
          appliedRuleIds: ['FOUNDATION-BEAM-COUNT-DIFFERENCE-EXACT-THROUGH'],
          sourceRef: match.leftBarRef || null,
          targetRef: match.rightBarRef || null,
          sources,
          modelSource: resolution?.modelSource || modelSource,
        }),
      );
    }

    for (const [index, assignment] of (resolution?.anchorageRequired || []).entries()) {
      result.push(
        createTrace({
          decisionId: `FOUNDATION_BEAM:${nodeId}:ANCHORAGE:${resolutionIndex}:${index}`,
          subjectType: 'FOUNDATION_BEAM_BAR_COUNT_DIFFERENCE',
          subjectKey: `${nodeId}:${assignment.barRef || index}`,
          disposition: 'ANCHORAGE_REQUIRED',
          appliedRuleIds: ['FOUNDATION-BEAM-COUNT-DIFFERENCE-ANCHORAGE'],
          sourceRef: assignment.side === 'LEFT' ? assignment.barRef || null : null,
          targetRef: assignment.side === 'RIGHT' ? assignment.barRef || null : null,
          sources,
          modelSource: resolution?.modelSource || modelSource,
        }),
      );
    }

    for (const [index, unresolved] of (resolution?.unresolved || []).entries()) {
      const appliedRuleIds = ['REBAR-FAIL-CLOSED-UNRESOLVED'];
      if (unresolved?.reason === 'foundation-beam-count-difference-semantic-mismatch') {
        appliedRuleIds.unshift('REBAR-SEMANTIC-MISMATCH-UNRESOLVED');
      } else if (unresolved?.reason === 'foundation-beam-count-difference-position-ambiguous') {
        appliedRuleIds.unshift('FOUNDATION-BEAM-COUNT-DIFFERENCE-EXACT-THROUGH');
      }
      result.push(
        createTrace({
          decisionId: `FOUNDATION_BEAM:${nodeId}:UNRESOLVED:${resolutionIndex}:${index}`,
          subjectType: 'FOUNDATION_BEAM_BAR_COUNT_DIFFERENCE',
          subjectKey: `${nodeId}:UNRESOLVED:${index}`,
          disposition: 'UNRESOLVED',
          appliedRuleIds,
          unresolvedReason: unresolved?.reason || 'foundation-beam-count-difference-unresolved',
          sourceRef: unresolved?.leftBarRefs?.[0] || null,
          targetRef: unresolved?.rightBarRefs?.[0] || null,
          rejectedAlternatives: [unresolved],
          sources,
          modelSource: resolution?.modelSource || modelSource,
        }),
      );
    }
  }

  for (const [index, item] of (snapshot?.unresolved || []).entries()) {
    const nodeId = item?.nodeId || '-';
    result.push(
      createTrace({
        decisionId: `FOUNDATION_BEAM:${nodeId}:PAIR_UNRESOLVED:${index}`,
        subjectType: 'FOUNDATION_BEAM_COUNT_DIFFERENCE_PAIR',
        subjectKey: `${nodeId}:${index}`,
        disposition: 'UNRESOLVED',
        appliedRuleIds: [
          'FOUNDATION-BEAM-COUNT-DIFFERENCE-EXACT-THROUGH',
          'REBAR-FAIL-CLOSED-UNRESOLVED',
        ],
        unresolvedReason: item?.reason || 'foundation-beam-count-difference-pair-unresolved',
        rejectedAlternatives: [item],
        sources: item?.memberRefs || [],
        modelSource,
      }),
    );
  }

  return Object.freeze(result);
}

export function buildSlabThroughDecisionTraces(paths, { modelSource = null } = {}) {
  const result = [];
  for (const [pathIndex, path] of (paths || []).entries()) {
    const metadata = path?.metadata || {};
    for (const side of ['start', 'end']) {
      const prefix = side === 'start' ? 'boundaryStart' : 'boundaryEnd';
      if (metadata[`${prefix}Mode`] !== 'THROUGH') continue;
      const otherSlabId = metadata[`${prefix}ThroughSlabId`] || null;
      const edgeKey = metadata[`${prefix}EdgeKey`] || null;
      const supportMemberId = metadata[`${prefix}SupportMemberId`] || null;
      const memberId = metadata.memberId || null;
      result.push(
        createTrace({
          decisionId: `SLAB:${memberId || '-'}:${pathIndex}:${side}:THROUGH:${edgeKey || '-'}`,
          subjectType: 'SLAB_BAR_BOUNDARY',
          subjectKey: `${memberId || '-'}:${pathIndex}:${side}`,
          disposition: 'THROUGH',
          appliedRuleIds: ['SLAB-SAME-REBAR-THROUGH-CANDIDATE'],
          sourceRef: memberId ? `StbSlab:${memberId}` : null,
          targetRef: otherSlabId ? `StbSlab:${otherSlabId}` : null,
          sources: [
            memberId ? `StbSlab:${memberId}` : null,
            otherSlabId ? `StbSlab:${otherSlabId}` : null,
            supportMemberId ? `SUPPORT_MEMBER:${supportMemberId}` : null,
          ],
          modelSource,
        }),
      );
    }
  }
  return Object.freeze(result);
}

export function buildSmallOpeningDeflectionDecisionTraces(
  evaluations,
  { modelSource = null } = {},
) {
  const values = Array.isArray(evaluations) ? evaluations : evaluations ? [evaluations] : [];
  const result = [];

  for (const [index, evaluation] of values.entries()) {
    const eligible = evaluation?.eligibleCandidates || [];
    const eligibleRuleIds = eligible.map((candidate) => candidate.ruleId).filter(Boolean);
    const isCandidate = evaluation?.status === 'CANDIDATE' && eligibleRuleIds.length > 0;
    const disposition =
      eligible.length > 1
        ? 'MULTIPLE_DEFLECTION_CANDIDATES'
        : eligible[0]?.disposition || evaluation?.status || 'UNRESOLVED';
    const evaluatedRuleIds = (evaluation?.candidates || [])
      .map((candidate) => candidate.ruleId)
      .filter(Boolean);
    const prerequisiteRuleIds = [];
    if (evaluation?.sizeGateStatus) {
      prerequisiteRuleIds.push('SMALL-OPENING-SIZE-WITHIN-BOTH-SPACINGS');
    }
    if (evaluation?.sizeGateStatus === 'PASS' && evaluation?.coverStatus) {
      prerequisiteRuleIds.push('SMALL-OPENING-DESIGN-COVER-GATE');
    }
    const isUnresolved = evaluation?.status === 'UNRESOLVED';
    const decisionRuleIds = isCandidate ? eligibleRuleIds : evaluatedRuleIds;
    const appliedRuleIds = [
      ...prerequisiteRuleIds,
      ...decisionRuleIds,
      ...(isUnresolved ? ['REBAR-FAIL-CLOSED-UNRESOLVED'] : []),
    ].filter((ruleId, index, values) => values.indexOf(ruleId) === index);
    const bend = (evaluation?.candidates || []).find(
      (candidate) => candidate.ruleId === 'SMALL-OPENING-BEND-ONE-SIXTH-CANDIDATE',
    );
    const shift = (evaluation?.candidates || []).find(
      (candidate) => candidate.ruleId === 'SMALL-OPENING-SHIFT-50MM-CANDIDATE',
    );

    result.push(
      createTrace({
        decisionId: `SMALL_OPENING:${evaluation?.openingId || '-'}:${evaluation?.barIdentity || index}`,
        subjectType: 'SMALL_OPENING_BAR_DEFLECTION',
        subjectKey: evaluation?.barIdentity || `${evaluation?.openingId || '-'}:${index}`,
        disposition,
        appliedRuleIds,
        metrics: {
          bendOffsetMm: bend?.metrics?.bendOffsetMm,
          bendRunMm: bend?.metrics?.bendRunMm,
          ratio: bend?.metrics?.ratio,
          shiftMm: shift?.metrics?.shiftMm,
        },
        unresolvedReason: isUnresolved
          ? evaluation?.projectSourceReason ||
            evaluation?.reason ||
            'small-opening-deflection-unresolved'
          : null,
        sourceRef: evaluation?.barIdentity || null,
        rejectedAlternatives: (evaluation?.candidates || []).filter(
          (candidate) => candidate.eligible === false,
        ),
        sources: [
          evaluation?.openingId
            ? `${evaluation.openingElementName || 'StbOpenArrangement'}:${evaluation.openingId}`
            : null,
          evaluation?.memberType && evaluation?.memberId
            ? `${evaluation.memberType}:${evaluation.memberId}`
            : null,
          evaluation?.source || null,
          evaluation?.projectSourceRef || null,
        ],
        modelSource,
      }),
    );
  }

  return Object.freeze(result);
}

export function buildRebarDecisionTraceSnapshot({ columnFacts = null, girderFacts = null } = {}) {
  const column = buildColumnJointDecisionTraces(columnFacts);
  const girder = buildGirderJointDecisionTraces(girderFacts);
  return Object.freeze({
    column,
    girder,
    all: Object.freeze([...column, ...girder]),
  });
}
