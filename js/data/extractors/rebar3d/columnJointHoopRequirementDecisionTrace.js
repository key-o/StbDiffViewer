/**
 * @fileoverview Issue #273 C-005: trace existing first-hoop requirements at bent column joints.
 *
 * The render-plan fact records a two-set hoop requirement for an active bent-continuous request.
 * It does not report whether hoop paths were generated or whether the joint complies, so this
 * sidecar keeps that distinction explicit and never interprets `generated: false` as a failure.
 */

import { rebarRuleTraceMetadata } from './rebarDetailingRuleRegistry.js';

const C005_RULE_ID = 'COLUMN-JOINT-FIRST-HOOP-REQUIREMENT';
const ACTUAL_GENERATION_UNREPORTED = 'column-first-hoop-actual-generation-unreported';

function exactId(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function createTrace(requirement, modelSource) {
  const nodeId = exactId(requirement?.nodeId);
  const upperColumnId = exactId(requirement?.upperColumnId);
  if (!nodeId || !upperColumnId || requirement?.requiredSets !== 2) return null;

  const candidateRule = rebarRuleTraceMetadata(C005_RULE_ID);
  const decisionId = `COLUMN_FIRST_HOOP_REQUIREMENT:${modelSource || '-'}:${nodeId}:${upperColumnId}`;
  return Object.freeze({
    decisionId,
    subjectType: 'COLUMN_JOINT_FIRST_HOOP_REQUIREMENT',
    subjectKey: `${nodeId}:${upperColumnId}`,
    ...(modelSource ? { modelSource } : {}),
    status: 'UNRESOLVED',
    disposition: 'REQUIREMENT_ONLY',
    sourceRef: `STB_NODE:${nodeId}`,
    targetRef: `StbColumn:${upperColumnId}`,
    requiredSets: 2,
    candidateRules: Object.freeze([candidateRule]),
    appliedRules: Object.freeze([]),
    rejectedAlternatives: Object.freeze([]),
    unresolvedReason: ACTUAL_GENERATION_UNREPORTED,
    unresolvedPrerequisites: Object.freeze([ACTUAL_GENERATION_UNREPORTED]),
    candidateFacts: Object.freeze({
      nodeId,
      upperColumnId,
      requiredSets: 2,
      sourceRuleId: requirement.ruleId ?? null,
      generatedEvidence: 'NOT_REPORTED',
    }),
    provenance: Object.freeze({
      kind: 'SDV_GENERATED',
      sources: Object.freeze([
        'R6:firstHoopRequirements',
        `STB_NODE:${nodeId}`,
        `StbColumn:${upperColumnId}`,
        `RULE_REGISTRY:${C005_RULE_ID}`,
      ]),
      rules: Object.freeze([]),
      assumptions: Object.freeze([]),
    }),
    confidence: 'RULE_BASED',
    warnings: Object.freeze([ACTUAL_GENERATION_UNREPORTED]),
  });
}

/**
 * Convert existing active bent-continuous first-hoop requirement facts into read-only traces.
 *
 * The existing `generated` field is intentionally not read: these facts establish the required
 * set count, but do not report actual hoop generation or compliance.
 *
 * @param {Array<{nodeId:string,upperColumnId:string,requiredSets:number,ruleId?:string,generated?:boolean}>} firstHoopRequirements
 * @param {{modelSource?:'A'|'B'|string|null}} [options]
 * @returns {ReadonlyArray<Object>}
 */
export function buildColumnJointHoopRequirementDecisionTraces(
  firstHoopRequirements,
  { modelSource = null } = {},
) {
  const source = modelSource ? String(modelSource) : null;
  const traces = [];
  for (const requirement of Array.isArray(firstHoopRequirements) ? firstHoopRequirements : []) {
    const trace = createTrace(requirement, source);
    if (trace) traces.push(trace);
  }
  traces.sort(
    (left, right) =>
      compareText(left.subjectKey, right.subjectKey) ||
      compareText(left.decisionId, right.decisionId),
  );
  return Object.freeze(traces);
}
