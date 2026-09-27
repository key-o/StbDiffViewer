/**
 * @fileoverview Issue #310 Phase 6a-D2b:
 * wall-wall bar-level resolver resultを既存Decision Trace schema互換へ変換する。
 */

import { rebarRuleTraceMetadata } from './rebarDetailingRuleRegistry.js';

function finiteOrNull(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactMetrics(values = {}) {
  const result = {};
  for (const [key, value] of Object.entries(values)) {
    const number = finiteOrNull(value);
    if (number !== null) result[key] = number;
  }
  return result;
}

function rulesForAssignment(assignment, unresolved = false, supplementalEvaluated = false) {
  const ids = [];
  if (assignment?.disposition === 'L1_LAP') {
    const spliceEvaluated =
      assignment?.spliceGate || String(assignment?.reason || '').includes('l1-splice');
    if (spliceEvaluated) ids.push('WALL-SPLICE-IN-WALL');
  }
  if (supplementalEvaluated) ids.push('WALL-JUNCTION-SUPPLEMENTAL-MIN-DIA');
  if (assignment?.disposition === 'L1_LAP') {
    ids.push('WALL-WALL-L1-LAP');
  } else if (assignment?.disposition === 'L2_ANCHORAGE') {
    ids.push('WALL-WALL-L2-ANCHORAGE');
  } else if (assignment?.disposition === 'CONTINUOUS_THROUGH') {
    ids.push('WALL-WALL-T-MAIN-THROUGH');
  }
  if (unresolved) ids.push('REBAR-FAIL-CLOSED-UNRESOLVED');
  return [...new Set(ids)];
}

function rulesForClassification(classification) {
  if (classification?.status !== 'SOURCE_CLASSIFIED') return [];
  const ids = [];
  for (const treatment of classification?.treatments || []) {
    if (treatment?.disposition === 'L1_LAP') ids.push('WALL-WALL-L1-LAP');
    if (treatment?.disposition === 'L2_ANCHORAGE') ids.push('WALL-WALL-L2-ANCHORAGE');
    if (treatment?.disposition === 'CONTINUOUS_THROUGH') ids.push('WALL-WALL-T-MAIN-THROUGH');
  }
  return [...new Set(ids)];
}

function sourceStrings(resolution, assignment = null) {
  const values = ['NIKKENREN_JSCA_RC_DETAILING_20230401_FIG_11-2-1'];
  const sourceMemberId = resolution?.topologyFact?.sourceMemberId || resolution?.sourceMemberId;
  const targetMemberId = resolution?.topologyFact?.targetMemberId || resolution?.targetMemberId;
  if (sourceMemberId) {
    values.push(`StbWall:${sourceMemberId}`);
  }
  if (targetMemberId) {
    values.push(`StbWall:${targetMemberId}`);
  }
  const provenance = assignment?.designLengthProvenance?.source;
  if (provenance) values.push(String(provenance));
  const availabilityProvenance = assignment?.availability?.provenance?.source;
  if (availabilityProvenance) values.push(String(availabilityProvenance));
  return [...new Set(values.filter(Boolean))];
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
}) {
  const appliedRules = appliedRuleIds.map(rebarRuleTraceMetadata);
  return Object.freeze({
    decisionId,
    subjectType,
    subjectKey,
    ...(modelSource ? { modelSource } : {}),
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

function wallPairTraceKey(resolution) {
  const explicitKey = resolution?.junctionKey || resolution?.topologyFact?.junctionKey;
  if (explicitKey) return String(explicitKey);
  const sourceMemberId =
    resolution?.topologyFact?.sourceMemberId || resolution?.sourceMemberId || '-';
  const targetMemberId =
    resolution?.topologyFact?.targetMemberId || resolution?.targetMemberId || '-';
  return `${sourceMemberId}:${targetMemberId}`;
}

function invalidAssignmentTrace(resolution, index) {
  const modelSource = resolution?.modelSource || resolution?.topologyFact?.modelSource || null;
  const pairTraceKey = wallPairTraceKey(resolution);
  const subjectKey = `${pairTraceKey}:assignment:${index}`;
  return createTrace({
    decisionId: `WALL_WALL_ASSIGNMENT:${modelSource || '-'}:${subjectKey}`,
    subjectType: 'WALL_WALL_BAR_CONTINUITY',
    subjectKey,
    disposition: 'UNRESOLVED',
    appliedRuleIds: ['REBAR-FAIL-CLOSED-UNRESOLVED'],
    unresolvedReason: 'wall-wall-junction-assignment-trace-unresolved',
    sources: sourceStrings(resolution),
    modelSource,
  });
}

/**
 * resolved時はbar assignmentごとにtraceを出す。
 * junction-level hard reject / unresolvedは、bar決定が存在しない場合でも1件のfail-closed traceを残す。
 */
export function buildWallWallJunctionBarDecisionTraces(resolution) {
  if (!resolution) return Object.freeze([]);
  const result = [];
  const modelSource = resolution.modelSource || resolution.topologyFact?.modelSource || null;
  const assignments = Array.isArray(resolution.assignments) ? resolution.assignments : [];

  for (const [index, assignment] of assignments.entries()) {
    if (
      !assignment ||
      typeof assignment !== 'object' ||
      Array.isArray(assignment) ||
      typeof assignment.assignmentKey !== 'string' ||
      !assignment.assignmentKey.trim() ||
      !['RESOLVED', 'REJECTED', 'UNRESOLVED'].includes(assignment.status) ||
      typeof assignment.disposition !== 'string' ||
      !assignment.disposition.trim()
    ) {
      result.push(invalidAssignmentTrace(resolution, index));
      continue;
    }
    const unresolved = assignment?.status === 'UNRESOLVED';
    const rejected = assignment?.status === 'REJECTED';
    result.push(
      createTrace({
        decisionId: assignment.assignmentKey,
        subjectType: 'WALL_WALL_BAR_CONTINUITY',
        subjectKey: assignment.assignmentKey,
        disposition: unresolved
          ? 'UNRESOLVED'
          : rejected
            ? 'BAR_TREATMENT_REJECTED'
            : assignment.disposition,
        appliedRuleIds: rulesForAssignment(
          assignment,
          unresolved,
          Boolean(resolution.supplementalGate),
        ),
        metrics: {
          requiredLengthMm: assignment.requiredLengthMm,
          spliceStartStationMm: assignment.spliceGate?.candidateInterval?.startStationMm,
          spliceEndStationMm: assignment.spliceGate?.candidateInterval?.endStationMm,
          blockingRegionCount: assignment.spliceGate?.blockingRegions?.length,
          availableSourceMm: assignment.availability?.sourceMm,
          availableTargetMm: assignment.availability?.targetMm,
        },
        unresolvedReason: unresolved ? assignment.reason || resolution.reason : null,
        sourceRef: assignment.sourceRef || null,
        targetRef: assignment.targetRef || null,
        sources: sourceStrings(resolution, assignment),
        rejectedAlternatives: rejected
          ? [
              ...(assignment.spliceGate?.blockingRegions || []),
              ...(assignment.availability?.status === 'REJECTED' ? [assignment.availability] : []),
            ]
          : [],
        modelSource,
      }),
    );
  }

  if (result.length === 0 && resolution.status !== 'RESOLVED') {
    const supplementalRejected = resolution.supplementalGate?.status === 'REJECTED';
    const unresolved = resolution.status === 'UNRESOLVED';
    const pairTraceKey = wallPairTraceKey(resolution);
    const appliedRuleIds = [
      ...(resolution.supplementalGate ? ['WALL-JUNCTION-SUPPLEMENTAL-MIN-DIA'] : []),
      ...rulesForClassification(resolution.classification),
    ];
    if (unresolved) appliedRuleIds.push('REBAR-FAIL-CLOSED-UNRESOLVED');
    result.push(
      createTrace({
        decisionId: `WALL_WALL_JUNCTION:${modelSource || '-'}:${pairTraceKey}`,
        subjectType: 'WALL_WALL_JUNCTION_CONTINUITY',
        subjectKey: pairTraceKey,
        disposition: supplementalRejected ? 'JUNCTION_REJECTED' : 'UNRESOLVED',
        appliedRuleIds,
        metrics: {
          verticalRequiredDiaMm: resolution.supplementalGate?.directions?.vertical?.requiredDiaMm,
          horizontalRequiredDiaMm:
            resolution.supplementalGate?.directions?.horizontal?.requiredDiaMm,
        },
        unresolvedReason: unresolved ? resolution.reason || 'wall-wall-junction-unresolved' : null,
        sources: sourceStrings(resolution),
        rejectedAlternatives: supplementalRejected ? [resolution.supplementalGate] : [],
        modelSource,
      }),
    );
  }

  result.sort((a, b) => a.decisionId.localeCompare(b.decisionId));
  return Object.freeze(result);
}

export const __testOnly = Object.freeze({ rulesForAssignment, sourceStrings });
