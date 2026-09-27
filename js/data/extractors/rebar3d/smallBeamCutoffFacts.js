/**
 * @fileoverview R12-ZA 小梁カットオフの内法スパン Lo・連続/単独span区分・標準寸法factsを解決する。
 *
 * 日建連・JSCA 2023 §9-1 図9-1-1 / 図9-1-2 の寸法を geometry から分離して保持する。
 * この段階では実際の RebarPath を切断せず、支持面間 Lo と理論カットオフ基準位置、
 * 15d / 20d の必要余長だけを返す。bar identity / path mutation は後続R12-ZBで扱う。
 * 片持ち小梁は同じproduction fact setへR12-AA §9-3(3) factsを合流させる。
 */

import { REBAR_STANDARD_RULES } from '../../../constants/rebarStandardRules.js';
import { createTagScanner, findElementById } from '../columnSupportUtils.js';
import { resolveBeamPlanAxis } from './rebarClearGeometry.js';
import { buildRebarModelIndex } from './rebarModelIndex.js';
import { buildSmallBeamSupportFacts } from './smallBeamSupportFacts.js';
import { buildSmallBeamAnchorageRequirementFacts } from './smallBeamAnchorageRequirementFacts.js';
import { buildSmallBeamCantileverFactsFromRequirementFacts } from './smallBeamCantileverFacts.js';

const SOURCE = 'R12-ZA-small-beam-cutoff-facts';
const TOLERANCE_MM = 1e-6;
const CONTINUATION_ANGLE_TOLERANCE_DEG = 5;
const CONTINUATION_DOT_LIMIT = -Math.cos((CONTINUATION_ANGLE_TOLERANCE_DEG * Math.PI) / 180);

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    reason,
    source: SOURCE,
    ...extra,
  };
}

function endpointNodeId(beamEl, side) {
  if (!['start', 'end'].includes(side)) return null;
  return beamEl?.getAttribute?.(side === 'start' ? 'id_node_start' : 'id_node_end') || null;
}

function endpointInteriorDirection(scanTag, beamEl, side, index = null) {
  const axis = resolveBeamPlanAxis(scanTag, beamEl, index);
  if (!axis) return null;
  if (side === 'start') return axis.direction;
  if (side === 'end') return { x: -axis.direction.x, y: -axis.direction.y };
  return null;
}

function candidateSideAtNode(candidateEl, nodeId) {
  if (!candidateEl || !nodeId) return null;
  if (candidateEl.getAttribute?.('id_node_start') === String(nodeId)) return 'start';
  if (candidateEl.getAttribute?.('id_node_end') === String(nodeId)) return 'end';
  return null;
}

function dot2(left, right) {
  return Number(left?.x) * Number(right?.x) + Number(left?.y) * Number(right?.y);
}

function ordinaryRcSmallBeamFacts(facts) {
  return Boolean(
    facts &&
    facts.sectionResolved !== false &&
    facts.isFoundation !== true &&
    facts.isCanti !== true,
  );
}

/**
 * 1端について、同一直線上で支持大梁を越えて続くRC小梁が一意かを解決する。
 * 直交・斜交する別小梁は連続spanとはみなさない。候補が複数なら推定しない。
 */
export function resolveSmallBeamCutoffEndKind({
  scanTag,
  beamEl,
  side,
  supportFacts,
  index = null,
} = {}) {
  if (!beamEl) return unresolved('small-beam-element-not-found', { endKind: null });
  if (!['start', 'end'].includes(side)) {
    return unresolved('small-beam-cutoff-side-unresolved', { side: side ?? null, endKind: null });
  }
  const nodeId = endpointNodeId(beamEl, side);
  if (!nodeId) return unresolved('small-beam-cutoff-end-node-missing', { side, endKind: null });
  const currentDirection = endpointInteriorDirection(scanTag, beamEl, side, index);
  if (!currentDirection) {
    return unresolved('small-beam-cutoff-plan-axis-unresolved', { side, nodeId, endKind: null });
  }

  const currentId = String(beamEl.getAttribute?.('id') || '');
  const candidates = [];
  for (const [candidateId, facts] of supportFacts?.beam || []) {
    if (String(candidateId) === currentId || !ordinaryRcSmallBeamFacts(facts)) continue;
    const candidateEl = findElementById(scanTag, 'StbBeam', String(candidateId), index);
    if (!candidateEl) continue;
    const candidateSide = candidateSideAtNode(candidateEl, nodeId);
    if (!candidateSide) continue;
    const candidateDirection = endpointInteriorDirection(
      scanTag,
      candidateEl,
      candidateSide,
      index,
    );
    if (!candidateDirection) continue;
    const alignmentDot = dot2(currentDirection, candidateDirection);
    if (alignmentDot > CONTINUATION_DOT_LIMIT) continue;
    candidates.push({
      elementId: String(candidateId),
      elementName: facts.elementName || candidateEl.getAttribute?.('name') || null,
      side: candidateSide,
      alignmentDot,
    });
  }

  if (candidates.length > 1) {
    return unresolved('small-beam-cutoff-continuation-ambiguous', {
      side,
      nodeId: String(nodeId),
      endKind: null,
      candidates,
    });
  }
  if (candidates.length === 1) {
    return {
      resolved: true,
      reason: null,
      source: SOURCE,
      side,
      nodeId: String(nodeId),
      endKind: 'CONTINUOUS',
      continuation: candidates[0],
      candidates,
    };
  }
  return {
    resolved: true,
    reason: null,
    source: SOURCE,
    side,
    nodeId: String(nodeId),
    endKind: 'TERMINAL',
    continuation: null,
    candidates: [],
  };
}

function cutoffRatios(startKind, endKind) {
  if (startKind === 'TERMINAL' && endKind === 'TERMINAL') {
    return {
      spanType: 'SINGLE_SPAN',
      bottomZones: [1 / 6, 2 / 3, 1 / 6],
    };
  }
  if (startKind === 'TERMINAL' && endKind === 'CONTINUOUS') {
    return {
      spanType: 'CONTINUOUS_EDGE_SPAN',
      bottomZones: [1 / 6, 7 / 12, 1 / 4],
    };
  }
  if (startKind === 'CONTINUOUS' && endKind === 'TERMINAL') {
    return {
      spanType: 'CONTINUOUS_EDGE_SPAN',
      bottomZones: [1 / 4, 7 / 12, 1 / 6],
    };
  }
  if (startKind === 'CONTINUOUS' && endKind === 'CONTINUOUS') {
    return {
      spanType: 'CONTINUOUS_INTERIOR_SPAN',
      bottomZones: [1 / 4, 1 / 2, 1 / 4],
    };
  }
  return null;
}

/**
 * §9-1のdimension lineをLo基準のfactsへ変換する。
 * topは両図共通でLo/4-Lo/2-Lo/4 + 15d、bottomはspan typeごとの区分 + 20d。
 */
export function resolveSmallBeamCutoffPattern({ clearSpanMm, startKind, endKind } = {}) {
  const lo = Number(clearSpanMm);
  if (!(lo > TOLERANCE_MM)) {
    return unresolved('small-beam-cutoff-clear-span-nonpositive', {
      clearSpanMm: Number.isFinite(lo) ? lo : null,
    });
  }
  const ratios = cutoffRatios(startKind, endKind);
  if (!ratios) {
    return unresolved('small-beam-cutoff-span-type-unresolved', {
      clearSpanMm: lo,
      startKind: startKind || null,
      endKind: endKind || null,
    });
  }

  const bottomZoneMm = ratios.bottomZones.map((ratio) => lo * ratio);
  const bottomStartReferenceMm = bottomZoneMm[0];
  const bottomEndReferenceMm = bottomZoneMm[0] + bottomZoneMm[1];
  return {
    resolved: true,
    reason: null,
    source: SOURCE,
    standardId: REBAR_STANDARD_RULES.standardId,
    ruleSection: '9-1',
    clearSpanMm: lo,
    spanType: ratios.spanType,
    startKind,
    endKind,
    top: {
      zoneRatios: [1 / 4, 1 / 2, 1 / 4],
      zoneMm: [lo / 4, lo / 2, lo / 4],
      startReferenceFromStartNearFaceMm: lo / 4,
      endReferenceFromStartNearFaceMm: (3 * lo) / 4,
      extensionDiaFactor: 15,
      sourceFigure: ratios.spanType === 'SINGLE_SPAN' ? '9-1-2' : '9-1-1',
    },
    bottom: {
      zoneRatios: ratios.bottomZones,
      zoneMm: bottomZoneMm,
      startReferenceFromStartNearFaceMm: bottomStartReferenceMm,
      endReferenceFromStartNearFaceMm: bottomEndReferenceMm,
      extensionDiaFactor: 20,
      sourceFigure: ratios.spanType === 'SINGLE_SPAN' ? '9-1-2' : '9-1-1',
    },
  };
}

/**
 * 支持面geometryと端部継続性から1spanのcutoff factsを作る。
 */
export function resolveSmallBeamCutoffSpanFact({
  beamFacts,
  startGeometry,
  endGeometry,
  startEndKind,
  endEndKind,
} = {}) {
  if (beamFacts?.isFoundation === true) {
    return unresolved('foundation-small-beam-out-of-r12-scope');
  }
  if (beamFacts?.isCanti === true) {
    return unresolved('cantilever-small-beam-out-of-r12-z-scope');
  }
  if (!startGeometry?.resolved || !endGeometry?.resolved) {
    return unresolved('small-beam-cutoff-support-face-unresolved', {
      startGeometry: startGeometry || null,
      endGeometry: endGeometry || null,
    });
  }
  if (!startEndKind?.resolved || !endEndKind?.resolved) {
    return unresolved(
      startEndKind?.reason || endEndKind?.reason || 'small-beam-cutoff-end-kind-unresolved',
      { startEndKind: startEndKind || null, endEndKind: endEndKind || null },
    );
  }

  const startNearFaceT = Number(startGeometry.nearFaceT);
  const endNearFaceT = Number(endGeometry.nearFaceT);
  if (!Number.isFinite(startNearFaceT) || !Number.isFinite(endNearFaceT)) {
    return unresolved('small-beam-cutoff-near-face-position-unresolved');
  }
  const clearSpanMm = endNearFaceT - startNearFaceT;
  const pattern = resolveSmallBeamCutoffPattern({
    clearSpanMm,
    startKind: startEndKind.endKind,
    endKind: endEndKind.endKind,
  });
  if (!pattern.resolved) return pattern;

  return {
    ...pattern,
    elementId: beamFacts?.elementId ? String(beamFacts.elementId) : null,
    elementName: beamFacts?.elementName || null,
    sectionId:
      beamFacts?.sectionId === null || beamFacts?.sectionId === undefined
        ? null
        : String(beamFacts.sectionId),
    startNearFaceT,
    endNearFaceT,
    startEndKind,
    endEndKind,
  };
}

/**
 * span-level referenceをbar径へ展開する。まだpathの切断方向は決めない。
 */
export function resolveSmallBeamCutoffBarRequirement(spanFact, bar) {
  if (!spanFact?.resolved) {
    return unresolved(spanFact?.reason || 'small-beam-cutoff-span-unresolved');
  }
  const role = bar?.role;
  if (role !== 'top' && role !== 'bottom') {
    return unresolved('small-beam-cutoff-role-not-main-bar', { role: role || null });
  }
  const dia = Number(bar?.dia);
  if (!(dia > 0)) return unresolved('small-beam-cutoff-bar-diameter-unresolved');
  const rule = spanFact[role];
  if (!rule) return unresolved('small-beam-cutoff-role-rule-unresolved', { role });

  return {
    resolved: true,
    reason: null,
    source: SOURCE,
    standardId: spanFact.standardId,
    ruleSection: spanFact.ruleSection,
    spanType: spanFact.spanType,
    role,
    barDiaMm: dia,
    startReferenceFromStartNearFaceMm: rule.startReferenceFromStartNearFaceMm,
    endReferenceFromStartNearFaceMm: rule.endReferenceFromStartNearFaceMm,
    extensionDiaFactor: rule.extensionDiaFactor,
    requiredExtensionMm: rule.extensionDiaFactor * dia,
    sourceFigure: rule.sourceFigure,
    pathMutationReady: false,
    pathMutationReason: 'small-beam-cutoff-path-direction-not-yet-applied',
  };
}

/** requirement factsに含まれる実支持面を再利用し、cutoff span factsを構築する。 */
export function buildSmallBeamCutoffFactsFromRequirementFacts(
  requirementFacts,
  supportFacts,
  scanTag,
  options = {},
) {
  const beam = new Map();
  const unresolvedFacts = [];
  const index = options.modelIndex || options.index || null;
  const cantileverFacts = buildSmallBeamCantileverFactsFromRequirementFacts(
    requirementFacts,
    scanTag,
    { ...options, modelIndex: index },
  );

  for (const [elementId, facts] of requirementFacts?.beam || []) {
    const sourceSupportFacts = supportFacts?.beam?.get?.(String(elementId)) || null;
    if (facts?.isFoundation === true) {
      const value = unresolved('foundation-small-beam-out-of-r12-scope', {
        elementId: String(elementId),
      });
      beam.set(String(elementId), value);
      unresolvedFacts.push(value);
      continue;
    }
    if (facts?.isCanti === true) {
      const value =
        cantileverFacts?.beam?.get?.(String(elementId)) ||
        unresolved('cantilever-small-beam-facts-unresolved', {
          elementId: String(elementId),
        });
      beam.set(String(elementId), value);
      if (!value.resolved) unresolvedFacts.push(value);
      continue;
    }

    const beamEl = findElementById(scanTag, 'StbBeam', String(elementId), index);
    if (!beamEl || !sourceSupportFacts) {
      const value = unresolved('small-beam-cutoff-source-facts-unresolved', {
        elementId: String(elementId),
      });
      beam.set(String(elementId), value);
      unresolvedFacts.push(value);
      continue;
    }

    const start = (facts.ends || []).find((item) => item?.side === 'start');
    const end = (facts.ends || []).find((item) => item?.side === 'end');
    if (!start || !end) {
      const value = unresolved('small-beam-cutoff-end-facts-missing', {
        elementId: String(elementId),
      });
      beam.set(String(elementId), value);
      unresolvedFacts.push(value);
      continue;
    }
    if (start.support?.supportType !== 'GIRDER' || end.support?.supportType !== 'GIRDER') {
      const value = unresolved('small-beam-cutoff-non-girder-support', {
        elementId: String(elementId),
        startSupportType: start.support?.supportType || null,
        endSupportType: end.support?.supportType || null,
      });
      beam.set(String(elementId), value);
      unresolvedFacts.push(value);
      continue;
    }

    const startEndKind = resolveSmallBeamCutoffEndKind({
      scanTag,
      beamEl,
      side: 'start',
      supportFacts,
      index,
    });
    const endEndKind = resolveSmallBeamCutoffEndKind({
      scanTag,
      beamEl,
      side: 'end',
      supportFacts,
      index,
    });
    const value = resolveSmallBeamCutoffSpanFact({
      beamFacts: facts,
      startGeometry: start.supportGeometry,
      endGeometry: end.supportGeometry,
      startEndKind,
      endEndKind,
    });
    beam.set(String(elementId), value);
    if (!value.resolved) unresolvedFacts.push(value);
  }

  return {
    resolved: unresolvedFacts.length === 0,
    source: SOURCE,
    beam,
    unresolved: unresolvedFacts,
  };
}

/** STB document + beam layoutからR12-ZA / R12-AA cutoff factsを構築する。 */
export function buildSmallBeamCutoffFacts(
  xmlDoc,
  beamLayoutMap,
  options = {},
  sharedScanTag = null,
) {
  if (!xmlDoc || !beamLayoutMap?.size) {
    return { resolved: true, source: SOURCE, beam: new Map(), unresolved: [] };
  }
  const scanTag = sharedScanTag || createTagScanner(xmlDoc);
  const modelIndex =
    options.modelIndex || options.index || buildRebarModelIndex(xmlDoc, { scanTag });
  const supportFacts = buildSmallBeamSupportFacts(xmlDoc, scanTag, modelIndex);
  const requirementFacts = buildSmallBeamAnchorageRequirementFacts(
    xmlDoc,
    { beam: beamLayoutMap },
    supportFacts,
    scanTag,
    { ...options, modelIndex },
  );
  return buildSmallBeamCutoffFactsFromRequirementFacts(requirementFacts, supportFacts, scanTag, {
    ...options,
    modelIndex,
  });
}
