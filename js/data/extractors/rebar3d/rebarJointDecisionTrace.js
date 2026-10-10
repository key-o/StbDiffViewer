/**
 * @fileoverview 柱・大梁の接合部、継続筋、本数増減のDecision Trace。
 * 入力factsは読み取り専用。判定記録をproduction geometryへ戻さない。
 */

import { createTrace, finiteOrNull } from './rebarDecisionTrace.js';

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

function appendCountChangeTraces(result, memberType, joint, sourceIds = [], modelSource = null) {
  const ruleIds = [`${memberType}-COUNT-CHANGE-NEW-TERMINATE`];
  if (Number(joint?.priorityResolver?.cornerMatchCount) > 0) {
    ruleIds.push(`${memberType}-CORNER-PRIORITY`);
  }

  for (const [index, assignment] of (joint?.countChangeAssignments || []).entries()) {
    const disposition = assignment?.disposition;
    if (!['NEW', 'TERMINATE'].includes(disposition) || !assignment?.bar) continue;
    const ref = barReference(assignment.bar, index);
    result.push(
      createTrace({
        decisionId: `${memberType}:${joint.nodeId}:${disposition}:${ref}`,
        subjectType: `${memberType}_BAR_COUNT_CHANGE`,
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
      appendCountChangeTraces(result, 'COLUMN', joint, sources, modelSource);
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
      appendCountChangeTraces(result, 'GIRDER', joint, sources, modelSource);
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

export function buildRebarDecisionTraceSnapshot({ columnFacts = null, girderFacts = null } = {}) {
  const column = buildColumnJointDecisionTraces(columnFacts);
  const girder = buildGirderJointDecisionTraces(girderFacts);
  return Object.freeze({
    column,
    girder,
    all: Object.freeze([...column, ...girder]),
  });
}
