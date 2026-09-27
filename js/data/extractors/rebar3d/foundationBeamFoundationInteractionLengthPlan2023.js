/**
 * @fileoverview 日建連2023 図6-3追加筋の L2 / L2h / 20d 数値候補を解決する。
 *
 * 図中のどの折曲げ区間へ各寸法を割り当てるかはworld geometry層の責務とし、
 * ここでは beam側・foundation側それぞれのコンクリート強度に対する標準長候補だけを保持する。
 */

import { computeFoundationL2, computeFoundationL2h } from './foundationBeamStandardRules2023.js';

const SOURCE = 'R13-foundation-beam-foundation-interaction-length-plan-2023';

function outcome(status, reason, extra = {}) {
  return {
    status,
    resolved: status === 'READY',
    reason: reason || null,
    blockers: reason ? [reason] : [],
    source: SOURCE,
    geometryBindingResolved: false,
    productionReady: false,
    ...extra,
  };
}
function ready(extra = {}) {
  return outcome('READY', null, extra);
}
function unresolved(reason, extra = {}) {
  return outcome('UNRESOLVED', reason, extra);
}
function normalizeConcreteKind(value) {
  const kind = String(value || '')
    .trim()
    .toUpperCase();
  return kind === 'NORMAL' || kind === 'LIGHTWEIGHT' ? kind : null;
}
function lengthPair({ fc, grade, barDiaMm, lightweight }) {
  const l2 = computeFoundationL2({ fc, grade, barDiaMm, lightweight });
  const l2h = computeFoundationL2h({ fc, grade, barDiaMm, lightweight });
  if (!l2.resolved) {
    return {
      resolved: false,
      reason: l2.blockers?.[0] || 'foundation-interaction-L2-unresolved',
      l2,
      l2h: null,
    };
  }
  if (!l2h.resolved) {
    return {
      resolved: false,
      reason: l2h.blockers?.[0] || 'foundation-interaction-L2h-unresolved',
      l2,
      l2h,
    };
  }
  return { resolved: true, l2, l2h };
}

export function resolveFoundationBeamFoundationInteractionLengthPlan2023({
  materialFacts,
  concreteKind,
} = {}) {
  if (materialFacts?.status !== 'READY' || materialFacts?.resolved !== true) {
    return unresolved(materialFacts?.reason || 'foundation-interaction-material-facts-unresolved');
  }
  const normalizedConcreteKind = normalizeConcreteKind(concreteKind);
  if (!normalizedConcreteKind) {
    return unresolved('foundation-interaction-concrete-kind-unresolved');
  }

  const bar = materialFacts.additionalTie;
  const barDiaMm = Number(bar?.diaMm);
  const grade = bar?.grade || null;
  if (!(barDiaMm > 0) || !grade) {
    return unresolved('foundation-interaction-additional-tie-material-unresolved');
  }
  const lightweight = normalizedConcreteKind === 'LIGHTWEIGHT';
  const beam = lengthPair({
    fc: materialFacts.beamConcreteStrength?.value,
    grade,
    barDiaMm,
    lightweight,
  });
  if (!beam.resolved) return unresolved(beam.reason, { beamLengths: beam });
  const foundation = lengthPair({
    fc: materialFacts.foundationConcreteStrength?.value,
    grade,
    barDiaMm,
    lightweight,
  });
  if (!foundation.resolved) {
    return unresolved(foundation.reason, {
      beamLengths: beam,
      foundationLengths: foundation,
    });
  }

  return ready({
    concreteKind: normalizedConcreteKind,
    lightweight,
    additionalTie: {
      ...bar,
      pitchMm: 200,
      tail20dMm: 20 * barDiaMm,
    },
    beamLengths: beam,
    foundationLengths: foundation,
    dimensionTokens: ['L2', 'L2H', '20D'],
    geometryBindingReason: 'foundation-interaction-figure-6-3-dimension-to-path-binding-unresolved',
    productionBlockers: ['foundation-interaction-figure-6-3-dimension-to-path-binding-unresolved'],
  });
}

export const _foundationBeamFoundationInteractionLengthPlan2023Internals = Object.freeze({
  normalizeConcreteKind,
  lengthPair,
});
