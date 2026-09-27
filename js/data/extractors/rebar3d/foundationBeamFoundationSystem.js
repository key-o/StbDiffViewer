/**
 * @fileoverview 日建連2023標準図 §6-1 の基礎大梁type適用条件に使う基礎形式を、
 * foundationBeamTopologyFacts の明示関係から保守的に解決する。
 *
 * - StbFooting / StbPile が同一端部に明示: PILE_OR_ISOLATED
 * - StbStripFooting が同一端部に明示: RAFT_OR_CONTINUOUS のうち連続基礎として扱う
 * - 両系統が同時に存在: 推定せずUNRESOLVED
 * - 基礎柱だけで下部基礎が不明: 推定せずUNRESOLVED
 *
 * べた基礎は現 topology facts では直接収集していないため、このresolverだけでは判定しない。
 */

function unresolved(reason, extra = {}) {
  return {
    status: 'UNRESOLVED',
    resolved: false,
    foundationSystem: null,
    source: 'R13-foundation-beam-topology-facts',
    blockers: [reason],
    ...extra,
  };
}

function ready(foundationSystem, basis, extra = {}) {
  return {
    status: 'READY',
    resolved: true,
    foundationSystem,
    source: 'R13-foundation-beam-topology-facts',
    basis,
    blockers: [],
    ...extra,
  };
}

function nonEmpty(values) {
  return Array.isArray(values) && values.length > 0;
}

/**
 * @param {Object} endFact foundationBeamTopologyFactsのendpoint fact
 */
export function resolveFoundationBeamFoundationSystem(endFact = {}) {
  if (!endFact?.resolved) {
    return unresolved('foundation-system-topology-unresolved', {
      topologyReasons: [...(endFact?.reasons || [])],
    });
  }

  const hasFooting = Boolean(endFact.footing) || nonEmpty(endFact.footings);
  const hasPile = Boolean(endFact.pile) || nonEmpty(endFact.piles);
  const hasStrip = nonEmpty(endFact.stripFootings);
  const hasPileOrIsolated = hasFooting || hasPile;

  if (hasPileOrIsolated && hasStrip) {
    return unresolved('foundation-system-multiple-system-facts', {
      hasFooting,
      hasPile,
      hasStripFooting: true,
    });
  }
  if (hasPileOrIsolated) {
    return ready(
      'PILE_OR_ISOLATED',
      hasPile && hasFooting ? 'FOOTING_AND_PILE' : hasPile ? 'PILE' : 'FOOTING',
      {
        hasFooting,
        hasPile,
        hasStripFooting: false,
      },
    );
  }
  if (hasStrip) {
    return ready('RAFT_OR_CONTINUOUS', 'STRIP_FOOTING', {
      hasFooting: false,
      hasPile: false,
      hasStripFooting: true,
    });
  }

  return unresolved('foundation-system-not-explicit-in-topology', {
    primaryContext: endFact.primaryContext || 'UNRESOLVED',
  });
}
