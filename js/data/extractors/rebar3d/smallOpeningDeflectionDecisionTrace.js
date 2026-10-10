/**
 * @fileoverview 小開口による配筋の曲げ・寄せ候補のDecision Trace。
 * 入力factsは読み取り専用。判定記録をproduction geometryへ戻さない。
 */

import { createTrace } from './rebarDecisionTrace.js';

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
