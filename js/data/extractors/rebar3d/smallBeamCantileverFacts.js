/**
 * @fileoverview R12-AA 片持ち小梁の§9-3寸法factsを解決する。
 *
 * 日建連・JSCA 2023 図9-3(3)「片持ち小梁」を正本とし、支持大梁面から自由端までの
 * 片持ち長さ L と、上端2段筋の 2L/3 + 15d、下端L3/L3h requirementをgeometryから
 * 分離して保持する。この段階では自由端100程度の折返し形状や支持部L2/LaのRebarPathを
 * 生成せず、曖昧なケースはfail-closedとする。
 */

import { REBAR_STANDARD_RULES } from '../../../constants/rebarStandardRules.js';
import { createTagScanner, findElementById } from '../columnSupportUtils.js';
import { resolveBeamPlanAxis } from './rebarClearGeometry.js';
import { buildRebarModelIndex } from './rebarModelIndex.js';
import { buildSmallBeamSupportFacts } from './smallBeamSupportFacts.js';
import { buildSmallBeamAnchorageRequirementFacts } from './smallBeamAnchorageRequirementFacts.js';
import { resolveSmallBeamBottomAnchorageRequirement } from './smallBeamAnchorageRequirement.js';

const SOURCE = 'R12-AA-small-beam-cantilever-facts';
const TOLERANCE_MM = 1e-6;

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    reason,
    source: SOURCE,
    ...extra,
  };
}

function oppositeSides(left, right) {
  return (left === 'start' && right === 'end') || (left === 'end' && right === 'start');
}

/**
 * 図9-3(3)の片持ち小梁カットオフ寸法を純粋factsへ変換する。
 *
 * 上端2段筋のカットオフは支持面から自由端側へ 2L/3 を基準とし、さらに15d延長する。
 * 図中の自由端100程度は近似注記であり、production cut stationには使用しない。
 */
export function resolveSmallBeamCantileverPattern({ cantileverLengthMm, barDiaMm } = {}) {
  const length = Number(cantileverLengthMm);
  const dia = Number(barDiaMm);
  if (!(length > TOLERANCE_MM)) {
    return unresolved('small-beam-cantilever-length-nonpositive', {
      cantileverLengthMm: Number.isFinite(length) ? length : null,
    });
  }
  if (!(dia > 0)) {
    return unresolved('small-beam-cantilever-bar-diameter-unresolved', {
      cantileverLengthMm: length,
      barDiaMm: Number.isFinite(dia) ? dia : null,
    });
  }

  const cutoffReferenceFromSupportMm = (2 * length) / 3;
  const cutoffExtensionMm = 15 * dia;
  const cutoffFromSupportMm = cutoffReferenceFromSupportMm + cutoffExtensionMm;
  const straightBottom = resolveSmallBeamBottomAnchorageRequirement({
    cantilever: true,
    supportType: 'GIRDER',
    hooked: false,
    barDiaMm: dia,
  });
  const hookedBottom = resolveSmallBeamBottomAnchorageRequirement({
    cantilever: true,
    supportType: 'GIRDER',
    hooked: true,
    barDiaMm: dia,
  });

  if (!straightBottom.ok || !hookedBottom.ok) {
    return unresolved('small-beam-cantilever-bottom-anchorage-unresolved', {
      cantileverLengthMm: length,
      barDiaMm: dia,
      straightBottom,
      hookedBottom,
    });
  }

  return {
    resolved: true,
    reason: null,
    source: SOURCE,
    standardId: REBAR_STANDARD_RULES.standardId,
    ruleSection: '9-3(3)',
    cantileverLengthMm: length,
    barDiaMm: dia,
    topSecondLayerCutoff: {
      referenceRatio: 2 / 3,
      referenceFromSupportMm: cutoffReferenceFromSupportMm,
      extensionDiaFactor: 15,
      extensionMm: cutoffExtensionMm,
      requiredFromSupportMm: cutoffFromSupportMm,
      fitsWithinCantilever: cutoffFromSupportMm <= length + TOLERANCE_MM,
    },
    freeTip: {
      returnApproxMm: 100,
      exact: false,
      productionReady: false,
      reason: 'cantilever-free-tip-100mm-is-approximate-detail',
    },
    topSupportAnchorage: {
      lengthKind: 'L2',
      projectionRule: 'max(La,3B/4)',
      productionReady: false,
      reason: 'cantilever-top-L2-La-3B4-geometry-not-yet-resolved',
    },
    bottomSupportAnchorage: {
      straight: straightBottom,
      hooked: hookedBottom,
    },
  };
}

/**
 * 片持ち小梁1本について、支持端・自由端・実支持面から片持ち長さLを解決する。
 * beamAxisLengthMm / nearFaceT は同じXY plan-axis station系であることを前提とする。
 */
export function resolveSmallBeamCantileverSpanGeometry({
  beamFacts,
  beamAxisLengthMm,
  supportEnd,
  freeEnd,
  supportGeometry,
} = {}) {
  if (beamFacts?.isFoundation === true) {
    return unresolved('foundation-small-beam-out-of-r12-scope');
  }
  if (beamFacts?.isCanti !== true) {
    return unresolved('small-beam-not-cantilever');
  }
  if (supportEnd?.supportType !== 'GIRDER' || supportEnd?.resolved === false) {
    return unresolved(`cantilever-support-not-girder:${supportEnd?.supportType || 'UNKNOWN'}`);
  }
  if (freeEnd?.supportType !== 'FREE_END' || freeEnd?.resolved === false) {
    return unresolved(`cantilever-free-end-unresolved:${freeEnd?.supportType || 'UNKNOWN'}`);
  }
  if (!oppositeSides(supportEnd?.side, freeEnd?.side)) {
    return unresolved('cantilever-support-free-end-side-conflict', {
      supportSide: supportEnd?.side || null,
      freeSide: freeEnd?.side || null,
    });
  }
  if (!supportGeometry?.resolved) {
    return unresolved(supportGeometry?.reason || 'cantilever-support-face-unresolved');
  }

  const axisLength = Number(beamAxisLengthMm);
  const nearFaceT = Number(supportGeometry.nearFaceT);
  if (!(axisLength > TOLERANCE_MM) || !Number.isFinite(nearFaceT)) {
    return unresolved('cantilever-plan-axis-station-unresolved', {
      beamAxisLengthMm: Number.isFinite(axisLength) ? axisLength : null,
      nearFaceT: Number.isFinite(nearFaceT) ? nearFaceT : null,
    });
  }
  if (nearFaceT < -TOLERANCE_MM || nearFaceT > axisLength + TOLERANCE_MM) {
    return unresolved('cantilever-support-face-outside-member', {
      beamAxisLengthMm: axisLength,
      nearFaceT,
    });
  }

  const supportSide = supportEnd.side;
  const freeTipT = supportSide === 'start' ? axisLength : 0;
  const cantileverLengthMm = Math.abs(freeTipT - nearFaceT);
  if (!(cantileverLengthMm > TOLERANCE_MM)) {
    return unresolved('small-beam-cantilever-length-nonpositive', {
      cantileverLengthMm,
      beamAxisLengthMm: axisLength,
      nearFaceT,
    });
  }

  return {
    resolved: true,
    reason: null,
    source: SOURCE,
    elementId: beamFacts?.elementId == null ? null : String(beamFacts.elementId),
    elementName: beamFacts?.elementName || null,
    sectionId: beamFacts?.sectionId == null ? null : String(beamFacts.sectionId),
    supportSide,
    freeSide: freeEnd.side,
    supportId: supportEnd?.supportId == null ? null : String(supportEnd.supportId),
    beamAxisLengthMm: axisLength,
    supportNearFaceT: nearFaceT,
    freeTipT,
    cantileverLengthMm,
  };
}

export function resolveSmallBeamCantileverSpanFact(params = {}) {
  const geometry = resolveSmallBeamCantileverSpanGeometry(params);
  if (!geometry.resolved) return geometry;
  const pattern = resolveSmallBeamCantileverPattern({
    cantileverLengthMm: geometry.cantileverLengthMm,
    barDiaMm: params.barDiaMm,
  });
  if (!pattern.resolved) return pattern;
  return { ...geometry, ...pattern };
}

function groupSummary(group, geometry) {
  const pattern = resolveSmallBeamCantileverPattern({
    cantileverLengthMm: geometry.cantileverLengthMm,
    barDiaMm: Number(group?.diaMm),
  });
  return {
    role: group?.role || null,
    diaMm: Number.isFinite(Number(group?.diaMm)) ? Number(group.diaMm) : null,
    grade: group?.grade || null,
    barCount: Array.isArray(group?.bars) ? group.bars.length : null,
    pattern,
  };
}

/** requirement factsを§9-3(3)の片持ち小梁factsへ投影する。 */
export function buildSmallBeamCantileverFactsFromRequirementFacts(
  requirementFacts,
  scanTag,
  options = {},
) {
  const beam = new Map();
  const unresolvedFacts = [];
  const index = options.modelIndex || options.index || null;

  for (const [elementId, facts] of requirementFacts?.beam || []) {
    if (facts?.isCanti !== true) continue;
    const beamEl = findElementById(scanTag, 'StbBeam', String(elementId), index);
    const axis = beamEl ? resolveBeamPlanAxis(scanTag, beamEl, index) : null;
    const supportedEnds = (facts?.ends || []).filter(
      (item) => item?.status !== 'FREE_END' && item?.support?.supportType === 'GIRDER',
    );
    const freeEnds = (facts?.ends || []).filter((item) => item?.status === 'FREE_END');
    if (!beamEl || !axis || supportedEnds.length !== 1 || freeEnds.length !== 1) {
      const value = unresolved('cantilever-topology-or-plan-axis-unresolved', {
        elementId: String(elementId),
        supportEndCount: supportedEnds.length,
        freeEndCount: freeEnds.length,
      });
      beam.set(String(elementId), value);
      unresolvedFacts.push(value);
      continue;
    }

    const supportFact = supportedEnds[0];
    const geometry = resolveSmallBeamCantileverSpanGeometry({
      beamFacts: facts,
      beamAxisLengthMm: axis.lengthMm,
      supportEnd: supportFact.support,
      freeEnd: freeEnds[0].support,
      supportGeometry: supportFact.supportGeometry,
    });
    if (!geometry.resolved) {
      beam.set(String(elementId), geometry);
      unresolvedFacts.push(geometry);
      continue;
    }

    const groups = (supportFact.requirements || []).map((group) => groupSummary(group, geometry));
    const groupUnresolved = groups.filter((group) => !group.pattern.resolved);
    const value = {
      ...geometry,
      standardId: REBAR_STANDARD_RULES.standardId,
      ruleSection: '9-3(3)',
      groups,
      resolved: groupUnresolved.length === 0,
      reason: groupUnresolved[0]?.pattern?.reason || null,
    };
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

/** STB document + beam layoutから片持ち小梁§9-3(3) factsを構築する。 */
export function buildSmallBeamCantileverFacts(
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
  return buildSmallBeamCantileverFactsFromRequirementFacts(requirementFacts, scanTag, {
    ...options,
    modelIndex,
  });
}
