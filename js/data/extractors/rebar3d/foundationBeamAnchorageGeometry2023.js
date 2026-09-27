/**
 * @fileoverview R13 基礎大梁定着のrequirement -> path -> FD containmentを1本単位で集約する。
 *
 * ここでREADYになるのはanchor-local geometryまで。既存member main-bar identityとの接続と
 * world変換は後段の責務とし、productionReady=falseを維持する。
 */

import { resolveFoundationBeamAnchoragePathCandidate2023 } from './foundationBeamAnchoragePathCandidate2023.js';
import { resolveFoundationBeamAnchoragePlanCover2023 } from './foundationBeamAnchoragePlanCover2023.js';
import { resolveFoundationBeamAnchorageVerticalContainment2023 } from './foundationBeamAnchorageVerticalContainment2023.js';

const SOURCE = 'R13-foundation-beam-anchorage-geometry-2023';

function stop(stage, resolution) {
  return {
    status: resolution?.status || 'UNRESOLVED',
    resolved: false,
    geometryReady: false,
    productionReady: false,
    productionPathCandidate: false,
    productionConsumer: null,
    reason: resolution?.reason || `foundation-anchorage-${stage}-unresolved`,
    blockers: [...(resolution?.blockers || [])],
    source: SOURCE,
    stage,
    path: null,
    candidate: stage === 'candidate' ? resolution || null : null,
    verticalContainment: stage === 'verticalContainment' ? resolution || null : null,
    planCover: stage === 'planCover' ? resolution || null : null,
  };
}

/**
 * @param {Object} params
 * @param {function(string): Element[]} params.scanTag
 * @param {Element} params.beamEl
 * @param {Object} params.endFact
 * @param {Object} params.bar
 * @param {Object|null} [params.index]
 */
export function resolveFoundationBeamAnchorageGeometry2023({
  scanTag,
  beamEl,
  endFact,
  bar,
  index = null,
} = {}) {
  const candidate = resolveFoundationBeamAnchoragePathCandidate2023({
    side: endFact?.side,
    bar,
  });
  if (candidate?.status !== 'READY') return stop('candidate', candidate);

  const verticalContainment = resolveFoundationBeamAnchorageVerticalContainment2023({
    scanTag,
    beamEl,
    endFact,
    bar,
    candidate,
    index,
  });
  if (verticalContainment?.status !== 'READY') {
    return {
      ...stop('verticalContainment', verticalContainment),
      candidate,
    };
  }

  const planCover = resolveFoundationBeamAnchoragePlanCover2023({
    scanTag,
    endFact,
    candidate,
    index,
  });
  if (planCover?.status !== 'READY') {
    return {
      ...stop('planCover', planCover),
      candidate,
      verticalContainment,
    };
  }

  return {
    status: 'READY',
    resolved: true,
    geometryReady: true,
    productionReady: false,
    productionPathCandidate: true,
    productionConsumer: 'foundation-beam-anchor-local-path-pending-identity',
    reason: null,
    blockers: [],
    productionBlockers: ['foundation-anchorage-member-identity-world-continuity-unresolved'],
    source: SOURCE,
    stage: 'READY',
    side: endFact?.side || null,
    barIndex: bar?.barIndex ?? null,
    role: bar?.role || null,
    layer: bar?.layer ?? null,
    path: candidate.path,
    candidate,
    verticalContainment,
    planCover,
  };
}
