/**
 * @fileoverview 日建連・JSCA 2023標準図 §6-4 の基礎大梁–最下階柱取合いを
 * ST-Bridge実geometryへ接続するread-only facts。
 *
 * 図6-4の「最下階柱」は StbFoundationColumn（基礎柱）ではなく、基礎大梁端節点から
 * 上に伸びる実 StbColumn / StbPost として解決する。柱脚側 offset・rotate・ふかしを
 * 反映した梁軸直交方向の実幅を求め、図6-4の「基礎大梁幅 > 柱幅」判定へ渡す。
 * case1の「あばら筋を通す」は実最下階柱外周の軸方向区間まで保持するが、
 * 配筋phase/world loopは後段責務。
 */

import { createTagScanner, findElementById } from '../columnSupportUtils.js';
import { resolveFoundationBeamLowestColumnGeometry2023 } from './foundationBeamLowestColumnGeometry2023.js';
import { resolveFoundationBeamLowestColumnDetailSource2023 } from './foundationBeamInteractionDetailSource2023.js';
import { resolveFoundationBeamLowestColumnInteractionRequirement2023 } from './foundationBeamInteractionStandard2023.js';

const SOURCE = 'R13-foundation-beam-lowest-column-interaction-facts-2023';

function outcome(status, reason, extra = {}) {
  return {
    status,
    resolved: status === 'READY',
    reason: reason || null,
    blockers: reason ? [reason] : [],
    source: SOURCE,
    interactionRequirementResolved: false,
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
function invalid(reason, extra = {}) {
  return outcome('INVALID', reason, extra);
}
function fromResolution(resolution, extra = {}) {
  return outcome(
    resolution?.status || 'UNRESOLVED',
    resolution?.reason || 'foundation-lowest-column-requirement-unresolved',
    {
      blockers: [...(resolution?.blockers || [])],
      requirement: resolution || null,
      ...extra,
    },
  );
}
function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
function normalizeStirrup(stirrup) {
  const diaMm = finitePositive(stirrup?.diaMm);
  const pitchMm = finitePositive(stirrup?.pitchMm);
  if (diaMm === null || pitchMm === null) return null;
  return {
    designation: stirrup?.designation || null,
    diaMm,
    pitchMm,
    grade: stirrup?.grade || null,
    legCount: Number.isInteger(Number(stirrup?.legCount)) ? Number(stirrup.legCount) : null,
  };
}
function extensionFacts(geometry) {
  const memberLengthMm = Number(geometry?.beamAxis?.lengthMm);
  const entryT = Number(geometry?.entryT);
  const exitT = Number(geometry?.exitT);
  if (
    !(memberLengthMm > 0) ||
    !Number.isFinite(entryT) ||
    !Number.isFinite(exitT) ||
    !(exitT > entryT)
  ) {
    return null;
  }
  const memberStartT = Math.max(0, entryT);
  const memberEndT = Math.min(memberLengthMm, exitT);
  return {
    entryT,
    exitT,
    intervalLengthMm: exitT - entryT,
    memberLengthMm,
    memberOverlapStartT: memberStartT,
    memberOverlapEndT: memberEndT,
    memberOverlapMm: Math.max(0, memberEndT - memberStartT),
    startExternalExtensionMm: Math.max(0, -entryT),
    endExternalExtensionMm: Math.max(0, exitT - memberLengthMm),
  };
}
function explicitDetailSource(value) {
  const normalized = String(value || '')
    .trim()
    .toUpperCase();
  if (!normalized) return null;
  if (normalized !== 'STANDARD_2023') {
    return {
      status: 'INVALID',
      resolved: false,
      value: null,
      blockers: ['foundation-interaction-detail-source-unsupported'],
      source: 'options',
    };
  }
  return {
    status: 'READY',
    resolved: true,
    value: normalized,
    blockers: [],
    source: 'options',
    basis: 'EXPLICIT_OPTION',
  };
}
function resolveDetailSource(options, topology, endFact) {
  const explicit = explicitDetailSource(options.lowestColumnInteractionDetailSource);
  if (explicit) return explicit;
  if (options.projectDetailing === undefined) return null;
  return resolveFoundationBeamLowestColumnDetailSource2023(options.projectDetailing, {
    elementId: topology.elementId,
    sectionId: topology.sectionId,
    side: endFact.side,
  });
}

export function resolveFoundationBeamLowestColumnInteractionFacts2023({
  scanTag,
  beamEl,
  endFact,
  beamWidthMm,
  beamStirrup = null,
  detailSource,
  detailSourceResolution = null,
  index = null,
} = {}) {
  if (typeof scanTag !== 'function') return invalid('foundation-lowest-column-scan-tag-missing');
  if (!beamEl) return unresolved('foundation-lowest-column-beam-element-missing');
  if (!endFact?.resolved) return unresolved('foundation-lowest-column-end-topology-unresolved');
  const beamWidth = finitePositive(beamWidthMm);
  if (beamWidth === null) return invalid('foundation-lowest-column-beam-width-invalid');

  const geometry = resolveFoundationBeamLowestColumnGeometry2023(scanTag, beamEl, endFact, {
    index,
  });
  if (geometry?.resolved !== true) {
    return unresolved(geometry?.reason || 'foundation-lowest-column-geometry-unresolved', {
      geometry: geometry || null,
      detailSourceResolution,
    });
  }
  const columnWidth = finitePositive(geometry.columnTransverseWidthMm);
  if (columnWidth === null) {
    return unresolved('foundation-lowest-column-transverse-width-unresolved', {
      geometry,
      detailSourceResolution,
    });
  }

  const requirement = resolveFoundationBeamLowestColumnInteractionRequirement2023({
    detailSource,
    beamWidthMm: beamWidth,
    columnWidthMm: columnWidth,
  });
  if (requirement?.status !== 'READY') {
    return fromResolution(requirement, { geometry, detailSourceResolution });
  }

  const interval = extensionFacts(geometry);
  if (!interval) {
    return invalid('foundation-lowest-column-pass-through-interval-invalid', {
      geometry,
      requirement,
      detailSourceResolution,
    });
  }

  if (requirement.passFoundationBeamStirrupsThroughColumn === true) {
    const stirrup = normalizeStirrup(beamStirrup);
    const productionBlockers = [];
    if (!stirrup) {
      productionBlockers.push('foundation-lowest-column-pass-through-stirrup-schedule-unresolved');
    } else {
      productionBlockers.push('foundation-lowest-column-pass-through-stirrup-phase-unresolved');
    }
    productionBlockers.push('foundation-lowest-column-pass-through-world-loop-unresolved');
    return ready({
      side: endFact.side || null,
      nodeId: endFact.nodeId || null,
      geometry,
      requirement,
      detailSourceResolution,
      interactionRequirementResolved: true,
      figureCase: requirement.figureCase,
      beamWidthMm: beamWidth,
      columnTransverseWidthMm: columnWidth,
      stirrupScheduleResolved: Boolean(stirrup),
      beamStirrup: stirrup,
      passThroughRequired: true,
      passThroughAxisInterval: interval,
      passThroughPhaseResolved: false,
      worldLoopResolved: false,
      productionBlockers,
    });
  }

  return ready({
    side: endFact.side || null,
    nodeId: endFact.nodeId || null,
    geometry,
    requirement,
    detailSourceResolution,
    interactionRequirementResolved: true,
    figureCase: requirement.figureCase,
    beamWidthMm: beamWidth,
    columnTransverseWidthMm: columnWidth,
    stirrupScheduleResolved: Boolean(normalizeStirrup(beamStirrup)),
    beamStirrup: normalizeStirrup(beamStirrup),
    passThroughRequired: null,
    passThroughAxisInterval: interval,
    passThroughPhaseResolved: false,
    worldLoopResolved: false,
    productionBlockers: ['foundation-lowest-column-case-2-pass-through-rule-unresolved'],
  });
}

function bySide(ends) {
  return new Map((ends || []).filter((end) => end?.side).map((end) => [end.side, end]));
}

/**
 * topology + stirrup factsから§6-4 read-only factsをmember/end単位で構築する。
 */
export function buildFoundationBeamLowestColumnInteractionFacts2023(
  xmlDoc,
  topologyFacts,
  stirrupFacts,
  options = {},
) {
  const beam = new Map();
  const unresolvedFacts = [];
  if (!xmlDoc || !(topologyFacts?.beam instanceof Map)) {
    return { beam, unresolved: unresolvedFacts };
  }
  const scanTag = options.scanTag || createTagScanner(xmlDoc);

  for (const [elementId, topology] of topologyFacts.beam) {
    const beamEl = findElementById(scanTag, topology.memberTag, elementId, options.index || null);
    const stirrupBySide = bySide(stirrupFacts?.beam?.get?.(String(elementId))?.ends);
    const ends = (topology.ends || []).map((endFact) => {
      if (!(endFact?.columnsAbove || []).length) return null;
      const stirrupEnd = stirrupBySide.get(endFact.side) || null;
      const detailSourceResolution = resolveDetailSource(options, topology, endFact);
      if (detailSourceResolution?.status === 'INVALID') {
        return invalid(
          detailSourceResolution.blockers?.[0] || 'foundation-interaction-detail-source-invalid',
          {
            side: endFact.side || null,
            nodeId: endFact.nodeId || null,
            detailSourceResolution,
          },
        );
      }
      return resolveFoundationBeamLowestColumnInteractionFacts2023({
        scanTag,
        beamEl,
        endFact,
        beamWidthMm: stirrupEnd?.beamWidthMm,
        beamStirrup: stirrupEnd?.stirrup || null,
        detailSource: detailSourceResolution?.resolved ? detailSourceResolution.value : null,
        detailSourceResolution,
        index: options.index || null,
      });
    });
    beam.set(String(elementId), {
      elementId: String(elementId),
      elementName: topology.elementName || null,
      memberTag: topology.memberTag || null,
      sectionId: topology.sectionId || null,
      source: SOURCE,
      ends,
      resolved: ends.filter(Boolean).every((end) => end.resolved),
      productionReady: false,
    });
    for (const end of ends) {
      if (!end || end.resolved) continue;
      unresolvedFacts.push({
        elementId: String(elementId),
        side: end.side || null,
        reason: end.reason,
        source: SOURCE,
      });
    }
  }
  return { beam, unresolved: unresolvedFacts };
}

export const _foundationBeamLowestColumnInteractionFacts2023Internals = Object.freeze({
  finitePositive,
  normalizeStirrup,
  extensionFacts,
  explicitDetailSource,
  resolveDetailSource,
  bySide,
});
