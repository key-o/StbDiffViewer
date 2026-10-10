/**
 * @fileoverview 基礎梁の通し筋・本数差・未解決接合部のDecision Trace。
 * 入力factsは読み取り専用。判定記録をproduction geometryへ戻さない。
 */

import { createTrace } from './rebarDecisionTrace.js';

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
