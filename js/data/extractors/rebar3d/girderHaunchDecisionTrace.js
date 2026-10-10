/**
 * @fileoverview STBで明示された大梁ハンチ候補のDecision Trace。
 * 入力factsは読み取り専用。判定記録をproduction geometryへ戻さない。
 */

import { compactMetrics, finiteOrNull } from './rebarDecisionTrace.js';
import { rebarRuleTraceMetadata } from './rebarDetailingRuleRegistry.js';

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
