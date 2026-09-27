/**
 * @fileoverview R12-Q-C 一般小梁上端筋の定着mode選択strategy。
 *
 * 90°鉛直candidateが成立する場合だけVERTICAL_90を選択する。
 * 不成立時は日建連§9-2の斜め定着等が候補となり得るため、別modeを推定せずalternativeRequiredを返す。
 * このstrategyはRebarPath生成・production可否・一般的な定着OK/NG判定を行わない。
 */

const SOURCE = 'R12-small-beam-top-anchorage-mode-strategy';

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    mode: null,
    reason,
    alternativeRequired: null,
    productionReady: false,
    source: SOURCE,
    ...extra,
  };
}

export function resolveSmallBeamTopAnchorageMode({ vertical90Candidate } = {}) {
  if (!vertical90Candidate) return unresolved('vertical-90-candidate-missing');
  if (!vertical90Candidate.resolved) {
    return unresolved(vertical90Candidate.reason || 'vertical-90-candidate-unresolved');
  }

  if (vertical90Candidate.candidateReady === true) {
    return {
      resolved: true,
      mode: 'VERTICAL_90',
      reason: null,
      alternativeRequired: false,
      productionReady: false,
      candidateKind: 'TOP_VERTICAL_90',
      source: SOURCE,
    };
  }

  if (vertical90Candidate.candidateReady === false) {
    const failedConditions = [
      ...new Set(
        (vertical90Candidate.notReadyBars || []).flatMap((bar) => bar.failedConditions || []),
      ),
    ];
    return {
      resolved: true,
      mode: null,
      reason: 'vertical-90-not-ready-alternative-required',
      alternativeRequired: true,
      productionReady: false,
      candidateKind: 'TOP_VERTICAL_90',
      failedConditions,
      source: SOURCE,
    };
  }

  return unresolved('vertical-90-candidate-state-unresolved');
}
