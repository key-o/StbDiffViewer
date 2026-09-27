/**
 * @fileoverview R12-Q-B 90°鉛直定着candidateを既存小梁requirement factsへ後段接続する。
 *
 * R12-N/O/Pが保持するbarFactsを同一bar indexで対応付け、R12-Q-A pure resolverへ渡す。
 * candidate-readyは定着mode採用やproduction可否を意味せず、既存requirement.resolvedも変更しない。
 */

import { resolveSmallBeamTopVertical90Candidate } from './smallBeamVerticalAnchorageCandidate.js';

function unresolvedCandidate(reason, extra = {}) {
  return {
    resolved: false,
    candidateReady: null,
    reason,
    barFacts: [],
    notReadyBars: [],
    source: 'R12-small-beam-group-vertical-90-candidate',
    ...extra,
  };
}

export function resolveSmallBeamGroupVertical90Candidate(group) {
  if (group?.role !== 'top') return null;
  const requirement = group.requirement;
  if (!requirement?.ok) {
    return unresolvedCandidate(requirement?.reason || 'top-anchorage-requirement-unresolved');
  }

  const bars = Array.isArray(group.bars) ? group.bars : [];
  const projectionFacts = group.projectionAvailability?.barFacts;
  const tailFacts = group.tailAvailability?.barFacts;
  const totalLengthFacts = group.totalLengthAvailability?.barFacts;

  if (
    bars.length === 0 ||
    !Array.isArray(projectionFacts) ||
    !Array.isArray(tailFacts) ||
    !Array.isArray(totalLengthFacts)
  ) {
    return unresolvedCandidate('small-beam-vertical-90-source-facts-missing');
  }

  if (
    projectionFacts.length !== bars.length ||
    tailFacts.length !== bars.length ||
    totalLengthFacts.length !== bars.length
  ) {
    return unresolvedCandidate('small-beam-vertical-90-source-count-mismatch', {
      barCount: bars.length,
      projectionCount: projectionFacts.length,
      tailCount: tailFacts.length,
      totalLengthCount: totalLengthFacts.length,
    });
  }

  const barFacts = bars.map((bar, index) => ({
    ...resolveSmallBeamTopVertical90Candidate({
      projectionFact: projectionFacts[index],
      tailFact: tailFacts[index],
      totalLengthFact: totalLengthFacts[index],
      requirement,
    }),
    barIndex: index,
    barLayer: bar?.layer ?? null,
  }));

  const unresolvedBar = barFacts.find((fact) => !fact.resolved);
  if (unresolvedBar) {
    return unresolvedCandidate(
      unresolvedBar.reason || 'small-beam-vertical-90-candidate-unresolved',
      { barFacts },
    );
  }

  const notReadyBars = barFacts.filter((fact) => fact.candidateReady !== true);
  return {
    resolved: true,
    candidateReady: notReadyBars.length === 0,
    reason: null,
    barFacts,
    notReadyBars,
    source: 'R12-small-beam-group-vertical-90-candidate',
  };
}

/**
 * requirement factsへvertical90Candidateを付加する。
 * 元のbeam/end/groupオブジェクトは表示・後続strategyが同じfactsを参照できるようin-place更新する。
 */
export function attachSmallBeamVertical90CandidateFacts(requirementFacts) {
  if (!requirementFacts?.beam) {
    return { ...(requirementFacts || {}), vertical90CandidateUnresolved: [] };
  }

  const vertical90CandidateUnresolved = [];
  for (const [elementId, beamFacts] of requirementFacts.beam) {
    for (const end of beamFacts?.ends || []) {
      if (end.status === 'FREE_END') continue;
      for (const group of end.requirements || []) {
        if (group.role !== 'top') continue;
        group.vertical90Candidate = resolveSmallBeamGroupVertical90Candidate(group);
        if (group.requirement?.ok && group.vertical90Candidate?.resolved === false) {
          vertical90CandidateUnresolved.push({
            elementId,
            elementName: beamFacts.elementName,
            side: end.side,
            role: group.role,
            diaMm: group.diaMm,
            grade: group.grade,
            reason: group.vertical90Candidate.reason,
          });
        }
      }
    }
  }

  return {
    ...requirementFacts,
    vertical90CandidateUnresolved,
  };
}
