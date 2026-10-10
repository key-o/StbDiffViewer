/**
 * @fileoverview R12-AG 日建連・JSCA 2023 図9-4「片持ち梁・先端小梁のおさまり」のfacts。
 *
 * 片持ち小梁の先端がRC小梁へ接続する場合だけを対象にし、接続topology・直交性・
 * 先端小梁あばら筋を解決する。図9-4-1/9-4-2のgeometry生成は後段へ分離する。
 */

import { barDiameterMm } from '../../../constants/beamOpeningRules.js';
import { parseConcreteFc } from '../../../constants/rebarAnchorageRules.js';
import { REBAR_STANDARD_RULES } from '../../../constants/rebarStandardRules.js';
import { extractRcBeamSectionDetail } from '../beamSectionList/sectionDetail.js';
import { createTagScanner, findElementById, getNodeCoord } from '../columnSupportUtils.js';
import { buildRebarModelIndex } from './rebarModelIndex.js';
import { buildSmallBeamSupportFacts } from './smallBeamSupportFacts.js';

const SOURCE = 'R12-AG-small-beam-cantilever-tip-beam-facts';
const ORTHOGONAL_DOT_TOLERANCE = 1e-3;
const COLLINEAR_CROSS_TOLERANCE = 1e-3;

function unresolved(reason, extra = {}) {
  return { resolved: false, reason, source: SOURCE, productionReady: false, ...extra };
}

function directChildElements(parent, tagName) {
  return Array.from(parent?.childNodes || []).filter(
    (child) => child?.nodeType === 1 && (child.localName || child.nodeName) === tagName,
  );
}

function memberConnection(memberEl, nodeId) {
  if (!memberEl || !nodeId) return null;
  const id = String(nodeId);
  if (memberEl.getAttribute('id_node_start') === id) return 'start';
  if (memberEl.getAttribute('id_node_end') === id) return 'end';
  const viaTag = memberEl.tagName === 'StbGirder' ? 'StbGirderViaNode' : 'StbBeamViaNode';
  const via = directChildElements(memberEl, viaTag)[0];
  const order = directChildElements(via, 'StbNodeIdOrder')[0];
  const ids = String(order?.textContent || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return ids.includes(id) ? 'via' : null;
}

function orderedMemberNodeIds(memberEl) {
  const startId = memberEl?.getAttribute('id_node_start');
  const endId = memberEl?.getAttribute('id_node_end');
  if (!startId || !endId) return [];
  const viaTag = memberEl.tagName === 'StbGirder' ? 'StbGirderViaNode' : 'StbBeamViaNode';
  const via = directChildElements(memberEl, viaTag)[0];
  const order = directChildElements(via, 'StbNodeIdOrder')[0];
  const viaIds = String(order?.textContent || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const result = viaIds.length > 0 ? viaIds.slice() : [];
  if (result[0] !== String(startId)) result.unshift(String(startId));
  if (result[result.length - 1] !== String(endId)) result.push(String(endId));
  return result.filter((id, index) => index === 0 || id !== result[index - 1]);
}

function nodeOffset(memberEl, nodeId) {
  if (memberEl.getAttribute('id_node_start') === String(nodeId)) {
    return {
      x: Number(memberEl.getAttribute('offset_start_X') || 0),
      y: Number(memberEl.getAttribute('offset_start_Y') || 0),
      z: Number(memberEl.getAttribute('offset_start_Z') || 0),
    };
  }
  if (memberEl.getAttribute('id_node_end') === String(nodeId)) {
    return {
      x: Number(memberEl.getAttribute('offset_end_X') || 0),
      y: Number(memberEl.getAttribute('offset_end_Y') || 0),
      z: Number(memberEl.getAttribute('offset_end_Z') || 0),
    };
  }
  const viaTag = memberEl.tagName === 'StbGirder' ? 'StbGirderViaNode' : 'StbBeamViaNode';
  const via = directChildElements(memberEl, viaTag)[0];
  const offset = directChildElements(via, 'StbMemberOffsetList').find(
    (item) => item.getAttribute('id_node') === String(nodeId),
  );
  return {
    x: Number(offset?.getAttribute('offset_X') || 0),
    y: Number(offset?.getAttribute('offset_Y') || 0),
    z: Number(offset?.getAttribute('offset_Z') || 0),
  };
}

function planPoint(scanTag, memberEl, nodeId, index) {
  const node = getNodeCoord(scanTag, nodeId, index);
  if (!node) return null;
  const offset = nodeOffset(memberEl, nodeId);
  if (!Number.isFinite(offset.x) || !Number.isFinite(offset.y)) return null;
  return { x: node.x + offset.x, y: node.y + offset.y };
}

function spatialPoint(scanTag, memberEl, nodeId, index) {
  const node = getNodeCoord(scanTag, nodeId, index);
  if (!node) return null;
  const offset = nodeOffset(memberEl, nodeId);
  if (![offset.x, offset.y, offset.z].every(Number.isFinite)) return null;
  return {
    x: node.x + offset.x,
    y: node.y + offset.y,
    z: node.z + offset.z,
  };
}

function distance3d(first, second) {
  if (!first || !second) return null;
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const dz = second.z - first.z;
  const length = Math.hypot(dx, dy, dz);
  return length > 1e-9 ? length : null;
}

function memberStationAtNode(scanTag, memberEl, nodeId, index) {
  const ids = orderedMemberNodeIds(memberEl);
  const nodeIndex = ids.indexOf(String(nodeId));
  if (nodeIndex < 0 || ids.length < 2) {
    return unresolved('tip-beam-member-station-node-order-unresolved');
  }

  const planPoints = ids.map((id) => planPoint(scanTag, memberEl, id, index));
  const spatialPoints = ids.map((id) => spatialPoint(scanTag, memberEl, id, index));
  if (planPoints.some((point) => !point) || spatialPoints.some((point) => !point)) {
    return unresolved('tip-beam-member-station-point-unresolved');
  }

  let planLengthMm = 0;
  let spatialLengthMm = 0;
  let connectionPlanStationMm = 0;
  let connectionSpatialStationMm = 0;
  for (let i = 1; i < ids.length; i += 1) {
    const planLength = directionBetween(planPoints[i - 1], planPoints[i])?.lengthMm || null;
    const spatialLength = distance3d(spatialPoints[i - 1], spatialPoints[i]);
    if (!(planLength > 0) || !(spatialLength > 0)) {
      return unresolved('tip-beam-member-station-segment-unresolved', {
        segmentIndex: i - 1,
      });
    }
    planLengthMm += planLength;
    spatialLengthMm += spatialLength;
    if (i <= nodeIndex) {
      connectionPlanStationMm += planLength;
      connectionSpatialStationMm += spatialLength;
    }
  }

  const horizontalPlanCompatible = Math.abs(spatialLengthMm - planLengthMm) <= 1e-6;
  return {
    resolved: true,
    reason: null,
    nodeIds: ids,
    nodeIndex,
    planLengthMm,
    spatialLengthMm,
    connectionPlanStationMm,
    connectionSpatialStationMm,
    connectionRatio: planLengthMm > 0 ? connectionPlanStationMm / planLengthMm : null,
    horizontalPlanCompatible,
  };
}

function directionBetween(first, second) {
  if (!first || !second) return null;
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const length = Math.hypot(dx, dy);
  return length > 1e-9 ? { x: dx / length, y: dy / length, lengthMm: length } : null;
}

function localAxisAtNode(scanTag, memberEl, nodeId, index) {
  const ids = orderedMemberNodeIds(memberEl);
  const nodeIndex = ids.indexOf(String(nodeId));
  if (nodeIndex < 0) return unresolved('tip-beam-connection-node-order-unresolved');

  if (nodeIndex === 0 || nodeIndex === ids.length - 1) {
    const neighborIndex = nodeIndex === 0 ? 1 : ids.length - 2;
    const from = planPoint(scanTag, memberEl, ids[nodeIndex], index);
    const to = planPoint(scanTag, memberEl, ids[neighborIndex], index);
    const direction = nodeIndex === 0 ? directionBetween(from, to) : directionBetween(to, from);
    return direction
      ? { resolved: true, reason: null, direction, connection: nodeIndex === 0 ? 'start' : 'end' }
      : unresolved('tip-beam-end-local-axis-unresolved');
  }

  const before = planPoint(scanTag, memberEl, ids[nodeIndex - 1], index);
  const current = planPoint(scanTag, memberEl, ids[nodeIndex], index);
  const after = planPoint(scanTag, memberEl, ids[nodeIndex + 1], index);
  const incoming = directionBetween(before, current);
  const outgoing = directionBetween(current, after);
  if (!incoming || !outgoing) return unresolved('tip-beam-via-local-axis-unresolved');
  const cross = incoming.x * outgoing.y - incoming.y * outgoing.x;
  const dot = incoming.x * outgoing.x + incoming.y * outgoing.y;
  if (Math.abs(cross) > COLLINEAR_CROSS_TOLERANCE || dot <= 0) {
    return unresolved('tip-beam-via-local-axis-nonlinear', { cross, dot });
  }
  return {
    resolved: true,
    reason: null,
    direction: {
      x: (incoming.x + outgoing.x) / 2,
      y: (incoming.y + outgoing.y) / 2,
    },
    connection: 'via',
    cross,
    dot,
  };
}

function endpointPosition(detail, connection) {
  const positions = detail?.positions || {};
  const keys = Object.keys(positions);
  if (keys.length === 0) return null;
  if (keys.length === 1) return { key: keys[0], position: positions[keys[0]], uniform: true };
  if (detail.positionPattern === 'END_CENTER' && positions.LEFT) {
    return { key: 'LEFT', position: positions.LEFT, uniform: false, sharedEnd: true };
  }
  const wanted =
    connection === 'start' ? ['LEFT', 'START'] : connection === 'end' ? ['RIGHT', 'END'] : [];
  for (const key of wanted) {
    if (positions[key]) return { key, position: positions[key], uniform: false };
  }
  return null;
}

function sameStirrup(left, right) {
  return (
    left?.dia === right?.dia &&
    Number(left?.pitch) === Number(right?.pitch) &&
    Number(left?.count) === Number(right?.count)
  );
}

function positionAtConnection(detail, connection) {
  if (connection !== 'via') return endpointPosition(detail, connection);
  const entries = Object.entries(detail?.positions || {});
  if (entries.length === 0) return null;
  const first = entries[0][1];
  const uniform = entries.every(
    ([, position]) =>
      Number(position?.width) === Number(first?.width) &&
      Number(position?.depth) === Number(first?.depth) &&
      sameStirrup(position?.stirrup, first?.stirrup),
  );
  return uniform ? { key: 'UNIFORM', position: first, uniform: true } : null;
}

function barGroups(bar) {
  if (!bar) return [];
  const source = Array.isArray(bar.layers) && bar.layers.length > 0 ? bar.layers : [bar];
  return source
    .map((layer) => ({
      step: Number(layer?.step) || 1,
      count: Number(layer?.count) || 0,
      dia: layer?.dia || bar.dia || null,
      grade: layer?.grade || bar.grade || null,
      diaMm: barDiameterMm(layer?.dia || bar.dia, Number.NaN),
    }))
    .filter((layer) => layer.count > 0 && Number.isFinite(layer.diaMm) && layer.diaMm > 0);
}

function resolveMemberSectionAtConnection(scanTag, memberEl, connection, index) {
  const sectionId = memberEl?.getAttribute('id_section');
  const sectionEl = sectionId
    ? findElementById(scanTag, 'StbSecBeam_RC', String(sectionId), index)
    : null;
  if (!sectionEl) return unresolved('tip-beam-section-unresolved', { sectionId });
  const detail = extractRcBeamSectionDetail(sectionEl);
  const selected = positionAtConnection(detail, connection);
  if (!selected) {
    return unresolved(
      connection === 'via'
        ? 'tip-beam-section-varies-at-via'
        : 'tip-beam-end-section-position-unresolved',
      { sectionId, connection },
    );
  }
  return {
    resolved: true,
    reason: null,
    sectionId: String(sectionId),
    sectionName: detail.name || null,
    positionZone: selected.key,
    position: selected.position,
    detail,
  };
}

function cBarFacts(stirrup) {
  const designation = stirrup?.dia || null;
  const diaMm = barDiameterMm(designation, Number.NaN);
  const rule = REBAR_STANDARD_RULES.resolveSmallBeamCantileverTipBeamCBar({
    barDiaMm: diaMm,
    pitchMm: Number(stirrup?.pitch),
  });
  return {
    ...rule,
    role: 'C_BAR',
    designation,
    grade: null,
    gradeRule: 'NOT_SPECIFIED_BY_FIGURE_9_4',
    sourceStirrupGrade: stirrup?.grade || null,
    productionReady: false,
  };
}

function tipBeamMainAnchorageFacts(tipBeamSection, cantileverSection) {
  const tipBeamPosition = tipBeamSection?.position;
  const cantileverPosition = cantileverSection?.position;
  const anchorageConcreteFc = parseConcreteFc(cantileverSection?.detail?.concrete?.strength);
  const cantileverBeamWidthMm = Number(cantileverPosition?.width);

  const top = barGroups(tipBeamPosition?.topBar).map((bar) => {
    const l2 = REBAR_STANDARD_RULES.resolveLengthFactor({
      kind: 'l2',
      fc: anchorageConcreteFc,
      grade: bar.grade,
    });
    return {
      ...bar,
      memberRole: 'TIP_BEAM',
      lengthKind: 'L2',
      anchorageConcreteFc,
      l2Factor: l2.factor,
      l2RequiredMm: l2.ok ? l2.factor * bar.diaMm : null,
      l2Resolved: l2.ok === true,
      additionalStraight: REBAR_STANDARD_RULES.resolveSmallBeamCantileverTipBeamCornerTop({
        barDiaMm: bar.diaMm,
        cantileverBeamWidthMm,
      }),
    };
  });

  const bottom = barGroups(tipBeamPosition?.bottomBar).map((bar) => {
    const l3 = REBAR_STANDARD_RULES.resolveSmallBeamBottomAnchorage({
      barDiaMm: bar.diaMm,
      cantilever: false,
      hooked: false,
    });
    return {
      ...bar,
      memberRole: 'TIP_BEAM',
      lengthKind: 'L3',
      l3Factor: l3.factor,
      l3RequiredMm: l3.requiredMm,
      l3Resolved: l3.ok === true,
    };
  });

  return {
    sourceFigure: '9-4-2',
    memberRole: 'TIP_BEAM',
    supportMemberRole: 'CANTILEVER_BEAM',
    anchorageConcreteFc,
    cantileverBeamWidthMm:
      Number.isFinite(cantileverBeamWidthMm) && cantileverBeamWidthMm > 0
        ? cantileverBeamWidthMm
        : null,
    top,
    bottom,
    resolved:
      Number.isFinite(anchorageConcreteFc) &&
      Number.isFinite(cantileverBeamWidthMm) &&
      cantileverBeamWidthMm > 0 &&
      top.length > 0 &&
      bottom.length > 0 &&
      top.every((bar) => bar.l2Resolved && bar.additionalStraight?.ok) &&
      bottom.every((bar) => bar.l3Resolved),
    productionReady: false,
  };
}

export function buildSmallBeamCantileverTipBeamFacts(xmlDoc, options = {}, sharedScanTag = null) {
  const beam = new Map();
  const unresolvedFacts = [];
  if (!xmlDoc) return { resolved: true, source: SOURCE, beam, unresolved: unresolvedFacts };

  const scanTag = sharedScanTag || createTagScanner(xmlDoc);
  const modelIndex =
    options.modelIndex || options.index || buildRebarModelIndex(xmlDoc, { scanTag });
  const supports = buildSmallBeamSupportFacts(xmlDoc, scanTag, modelIndex);

  for (const [elementId, facts] of supports.beam || []) {
    if (facts?.isCanti !== true || facts?.isFoundation === true) continue;
    const tipEnds = (facts.ends || []).filter(
      (end) => end?.supportType === 'BEAM' && end?.resolved === true,
    );
    if (tipEnds.length === 0) continue;

    const rootEnds = (facts.ends || []).filter(
      (end) => end?.supportType === 'GIRDER' && end?.resolved === true,
    );
    if (tipEnds.length !== 1 || rootEnds.length !== 1) {
      const value = unresolved('cantilever-tip-beam-topology-unresolved', {
        elementId: String(elementId),
        tipEndCount: tipEnds.length,
        rootEndCount: rootEnds.length,
      });
      beam.set(String(elementId), value);
      unresolvedFacts.push(value);
      continue;
    }

    const tipEnd = tipEnds[0];
    const cantileverEl = findElementById(scanTag, 'StbBeam', String(elementId), modelIndex);
    const tipBeamEl = findElementById(scanTag, 'StbBeam', String(tipEnd.supportId), modelIndex);
    if (!cantileverEl || !tipBeamEl) {
      const value = unresolved('cantilever-or-tip-beam-element-unresolved', {
        elementId: String(elementId),
        tipBeamId: tipEnd.supportId || null,
      });
      beam.set(String(elementId), value);
      unresolvedFacts.push(value);
      continue;
    }

    const connection = memberConnection(tipBeamEl, tipEnd.nodeId);
    const cantileverAxis = localAxisAtNode(scanTag, cantileverEl, tipEnd.nodeId, modelIndex);
    const tipAxis = localAxisAtNode(scanTag, tipBeamEl, tipEnd.nodeId, modelIndex);
    if (!connection || !cantileverAxis.resolved || !tipAxis.resolved) {
      const value = unresolved(
        cantileverAxis.reason || tipAxis.reason || 'cantilever-tip-beam-local-axis-unresolved',
        {
          elementId: String(elementId),
          tipBeamId: String(tipEnd.supportId),
          connection,
        },
      );
      beam.set(String(elementId), value);
      unresolvedFacts.push(value);
      continue;
    }

    const tipBeamStation = memberStationAtNode(scanTag, tipBeamEl, tipEnd.nodeId, modelIndex);
    if (!tipBeamStation.resolved) {
      const value = unresolved(tipBeamStation.reason, {
        elementId: String(elementId),
        tipBeamId: String(tipEnd.supportId),
        connection,
      });
      beam.set(String(elementId), value);
      unresolvedFacts.push(value);
      continue;
    }

    const axisDot = Math.abs(
      cantileverAxis.direction.x * tipAxis.direction.x +
        cantileverAxis.direction.y * tipAxis.direction.y,
    );
    if (axisDot > ORTHOGONAL_DOT_TOLERANCE) {
      const value = unresolved('cantilever-tip-beam-not-orthogonal', {
        elementId: String(elementId),
        tipBeamId: String(tipEnd.supportId),
        connection,
        axisDot,
      });
      beam.set(String(elementId), value);
      unresolvedFacts.push(value);
      continue;
    }

    const tipSection = resolveMemberSectionAtConnection(scanTag, tipBeamEl, connection, modelIndex);
    const cantileverSection = resolveMemberSectionAtConnection(
      scanTag,
      cantileverEl,
      tipEnd.side,
      modelIndex,
    );
    if (!tipSection.resolved || !cantileverSection.resolved) {
      const value = unresolved(tipSection.reason || cantileverSection.reason, {
        elementId: String(elementId),
        tipBeamId: String(tipEnd.supportId),
        connection,
      });
      beam.set(String(elementId), value);
      unresolvedFacts.push(value);
      continue;
    }

    const stirrup = tipSection.position?.stirrup;
    const cBar = cBarFacts(stirrup);
    if (!cBar.ok) {
      const value = unresolved('cantilever-tip-beam-stirrup-source-unresolved', {
        elementId: String(elementId),
        tipBeamId: String(tipEnd.supportId),
        connection,
        stirrup: stirrup || null,
      });
      beam.set(String(elementId), value);
      unresolvedFacts.push(value);
      continue;
    }

    const figureCase = connection === 'via' ? 'FIGURE_9_4_1' : 'FIGURE_9_4_2';
    const tipBeamWidthMm = Number(tipSection.position?.width);
    const cantileverBeamWidthMm = Number(cantileverSection.position?.width);
    const mainAnchorage =
      figureCase === 'FIGURE_9_4_2'
        ? tipBeamMainAnchorageFacts(tipSection, cantileverSection)
        : null;
    if (mainAnchorage && mainAnchorage.resolved !== true) {
      const value = unresolved('cantilever-tip-beam-main-bar-requirement-unresolved', {
        elementId: String(elementId),
        tipBeamId: String(tipEnd.supportId),
        connection,
        tipBeamMainAnchorage: mainAnchorage,
      });
      beam.set(String(elementId), value);
      unresolvedFacts.push(value);
      continue;
    }

    const value = {
      resolved: true,
      reason: null,
      source: SOURCE,
      standardId: REBAR_STANDARD_RULES.standardId,
      ruleSection: '9-4',
      figureCase,
      elementId: String(elementId),
      elementName: facts.elementName || null,
      cantileverSectionId: facts.sectionId == null ? null : String(facts.sectionId),
      cantileverTipSection: {
        sectionId: cantileverSection.sectionId,
        sectionName: cantileverSection.sectionName,
        positionZone: cantileverSection.positionZone,
        widthMm: Number.isFinite(cantileverBeamWidthMm) ? cantileverBeamWidthMm : null,
        depthMm: Number(cantileverSection.position?.depth) || null,
        concreteFc: parseConcreteFc(cantileverSection.detail?.concrete?.strength),
      },
      rootSide: rootEnds[0].side,
      tipSide: tipEnd.side,
      tipNodeId: String(tipEnd.nodeId),
      tipBeamId: String(tipEnd.supportId),
      tipBeamName: tipEnd.supportName || null,
      tipBeamConnection: connection,
      tipBeamPlanGeometry: tipBeamStation,
      orthogonal: true,
      axisDot,
      tipBeamSection: {
        sectionId: tipSection.sectionId,
        sectionName: tipSection.sectionName,
        positionZone: tipSection.positionZone,
        widthMm: Number.isFinite(tipBeamWidthMm) ? tipBeamWidthMm : null,
        depthMm: Number(tipSection.position?.depth) || null,
        stirrup: stirrup || null,
      },
      cBar,
      tipBeamMainAnchorage: mainAnchorage,
      productionReady: false,
    };
    beam.set(String(elementId), value);
  }

  return {
    resolved: unresolvedFacts.length === 0,
    source: SOURCE,
    beam,
    unresolved: unresolvedFacts,
  };
}
