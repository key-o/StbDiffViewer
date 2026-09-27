/**
 * @fileoverview 配筋指針2010 付録A A2の柱梁接合部・直交梁組立順チェック。
 *
 * A2で設計図への明示が必要なX/Y方向梁の配筋・組立順を、3D geometryから分離した
 * joint-level factとして収集する。このsliceでは上下主筋位置の自動シフトは行わず、
 * choiceが未指定ならUNRESOLVED、指定済みならRESOLVEDとしてDecision/Validation UIへ渡す。
 */

import { getRebarCommonConfig } from '../../../config/rebarCommonConfig.js';
import {
  OrthogonalBeamAssemblyOrder,
  normalizeRebarDetailingChoice,
} from '../../../config/rebarDetailingChoice.js';
import { createTagScanner, getNodeCoord } from '../columnSupportUtils.js';
import { rebarRuleTraceMetadata } from './rebarDetailingRuleRegistry.js';
import { buildBeamRebarLayoutMaps } from './beamRebarPlacement.js';
import { buildColumnRebarLayoutMap } from './columnRebarPlacement.js';
import { evaluateAppendixA2JointGeometryFeasibility } from './rebarAppendixA2JointFeasibility.js';
import { resolveAppendixA2JointProductionChoices } from './rebarAppendixA2JointProductionChoice.js';
import { buildAppendixA2CongestionStbRepresentationPlan } from './rebarAppendixA2CongestionStbRepresentation.js';
import { buildRebarModelIndex } from './rebarModelIndex.js';

const EPS = 1e-8;
const DEFAULT_ORTHOGONAL_DOT_TOLERANCE = 0.15;
const DEFAULT_GLOBAL_AXIS_OFF_TOLERANCE = 0.15;
const A2_RULE = rebarRuleTraceMetadata('APPENDIX-A2-ORTHOGONAL-BEAM-ASSEMBLY-ORDER');
const A2_LAYERING_RULE = rebarRuleTraceMetadata('APPENDIX-A2-ORTHOGONAL-BEAM-COVER-STACKING');
const A2_SIDE_INSET_RULE = rebarRuleTraceMetadata('APPENDIX-A2-SIDE-JOINT-OUTER-BAR-INSET');
const A2_CORNER_HOOK_RULE = rebarRuleTraceMetadata('APPENDIX-A2-CORNER-HOOK-INSIDE-DIA-4D');
const A2_CORNER_LAYER_RULE = rebarRuleTraceMetadata('APPENDIX-A2-CORNER-LAYER-ESCALATION');
const A2_CORNER_ANCHORAGE_RULE = rebarRuleTraceMetadata(
  'APPENDIX-A2-CORNER-JOINT-ANCHORAGE-METHOD',
);
const A2_CORNER_CONGESTION_RULE = rebarRuleTraceMetadata(
  'APPENDIX-A2-CORNER-JOINT-CONGESTION-METHOD',
);
const A2_HOOP_CONSTRUCTION_RULE = rebarRuleTraceMetadata(
  'APPENDIX-A2-JOINT-HOOP-CONSTRUCTION-METHOD',
);

function normalizeId(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function finiteOffset(element, name) {
  const value = Number(element?.getAttribute?.(name));
  return Number.isFinite(value) ? value : 0;
}

function endpointNodeId(connection) {
  const element = connection?.element;
  if (!element) return null;
  if (connection.endpoint === 'start') return normalizeId(element.getAttribute('id_node_start'));
  if (connection.endpoint === 'end') return normalizeId(element.getAttribute('id_node_end'));
  return null;
}

function otherEndpointNodeId(connection) {
  const element = connection?.element;
  if (!element) return null;
  if (connection.endpoint === 'start') return normalizeId(element.getAttribute('id_node_end'));
  if (connection.endpoint === 'end') return normalizeId(element.getAttribute('id_node_start'));
  return null;
}

function endpointOffset(connection) {
  const prefix = connection?.endpoint === 'start' ? 'offset_start' : 'offset_end';
  return {
    x: finiteOffset(connection?.element, `${prefix}_X`),
    y: finiteOffset(connection?.element, `${prefix}_Y`),
  };
}

function eligibleBeamElement(connection) {
  const element = connection?.element;
  if (!element) return false;
  const kind = String(element.getAttribute('kind_structure') || '').toUpperCase();
  return !kind || ['RC', 'SRC'].includes(kind);
}

function eligibleBeamConnection(connection) {
  return eligibleBeamElement(connection) && ['start', 'end'].includes(connection.endpoint);
}

function buildDirectionFact(scanTag, connection, index) {
  if (!eligibleBeamConnection(connection)) return null;
  const nodeId = endpointNodeId(connection);
  const otherNodeId = otherEndpointNodeId(connection);
  if (!nodeId || !otherNodeId) return null;

  const node = getNodeCoord(scanTag, nodeId, index);
  const other = getNodeCoord(scanTag, otherNodeId, index);
  if (!node || !other) return null;

  const startOffset = endpointOffset(connection);
  // STB endpoint offsets describe the member's eccentricity at the joint. They
  // are carried in centerOffsetAtNode for section/clearance checks, while the
  // global assembly axis is classified from the node-to-node member axis.
  const dx = other.x - node.x;
  const dy = other.y - node.y;
  const length = Math.hypot(dx, dy);
  if (!(length > EPS)) return null;

  const ux = dx / length;
  const uy = dy / length;
  const absX = Math.abs(ux);
  const absY = Math.abs(uy);
  const axis =
    absY <= DEFAULT_GLOBAL_AXIS_OFF_TOLERANCE
      ? 'X'
      : absX <= DEFAULT_GLOBAL_AXIS_OFF_TOLERANCE
        ? 'Y'
        : 'OTHER';

  return Object.freeze({
    id: normalizeId(connection.element.getAttribute('id')),
    name: connection.element.getAttribute('name') || null,
    tagName: connection.tagName || connection.element.localName || connection.element.nodeName,
    endpoint: connection.endpoint,
    nodeId,
    otherNodeId,
    sectionId: normalizeId(connection.element.getAttribute('id_section')),
    centerOffsetAtNode: Object.freeze({ x: startOffset.x, y: startOffset.y }),
    rollAngleDeg: Number(connection.element.getAttribute('rotate') || 0) || 0,
    unit: Object.freeze({ x: ux, y: uy }),
    axis,
  });
}

function unresolvedViaBeamFacts(connections) {
  const byId = new Map();
  for (const connection of connections || []) {
    if (connection?.endpoint !== 'via' || !eligibleBeamElement(connection)) continue;
    const id = normalizeId(connection.element.getAttribute('id'));
    if (!id || byId.has(id)) continue;
    byId.set(
      id,
      Object.freeze({
        id,
        name: connection.element.getAttribute('name') || null,
        tagName: connection.tagName || connection.element.localName || connection.element.nodeName,
        endpoint: 'via',
      }),
    );
  }
  return [...byId.values()];
}

function uniqueDirectionFacts(scanTag, connections, index) {
  const byId = new Map();
  for (const connection of connections || []) {
    const fact = buildDirectionFact(scanTag, connection, index);
    if (!fact?.id) continue;
    if (!byId.has(fact.id)) byId.set(fact.id, fact);
  }
  return [...byId.values()];
}

function orthogonalPair(a, b, tolerance = DEFAULT_ORTHOGONAL_DOT_TOLERANCE) {
  const dot = Math.abs(a.unit.x * b.unit.x + a.unit.y * b.unit.y);
  return dot <= tolerance;
}

function hasOrthogonalPair(facts) {
  for (let i = 0; i < facts.length; i += 1) {
    for (let j = i + 1; j < facts.length; j += 1) {
      if (orthogonalPair(facts[i], facts[j])) return true;
    }
  }
  return false;
}

function hasRcOrSrcColumnAtNode(index, nodeId) {
  const entry = index?.columnsByNodeId?.get(String(nodeId));
  if (!entry?.connected?.length) return false;
  return entry.connected.some(({ element, tagName }) => {
    if (tagName !== 'StbColumn') return false;
    const kind = String(element?.getAttribute?.('kind_structure') || '').toUpperCase();
    return !kind || ['RC', 'SRC'].includes(kind);
  });
}

function directionSigns(facts, axis) {
  const signs = new Set();
  for (const fact of facts) {
    if (fact.axis !== axis) continue;
    const component = axis === 'X' ? fact.unit.x : fact.unit.y;
    if (Math.abs(component) <= EPS) continue;
    signs.add(component > 0 ? 'POSITIVE' : 'NEGATIVE');
  }
  return [...signs].sort();
}

function classifyJointTopology(directions) {
  const xSides = directionSigns(directions, 'X');
  const ySides = directionSigns(directions, 'Y');
  if (xSides.length === 0 || ySides.length === 0) {
    return { kind: 'UNRESOLVED', xSides, ySides };
  }
  if (xSides.length === 2 && ySides.length === 2) {
    return { kind: 'INTERIOR', xSides, ySides };
  }
  if (
    (xSides.length === 2 && ySides.length === 1) ||
    (xSides.length === 1 && ySides.length === 2)
  ) {
    return { kind: 'SIDE', xSides, ySides };
  }
  if (xSides.length === 1 && ySides.length === 1) {
    return { kind: 'CORNER', xSides, ySides };
  }
  return { kind: 'COMPLEX', xSides, ySides };
}

function candidateRulesForTopology(topology) {
  const common = [A2_LAYERING_RULE, A2_HOOP_CONSTRUCTION_RULE];
  if (topology.kind === 'SIDE') {
    return [...common, A2_SIDE_INSET_RULE];
  }
  if (topology.kind === 'CORNER') {
    return [
      ...common,
      A2_SIDE_INSET_RULE,
      A2_CORNER_HOOK_RULE,
      A2_CORNER_LAYER_RULE,
      A2_CORNER_ANCHORAGE_RULE,
      A2_CORNER_CONGESTION_RULE,
    ];
  }
  return common;
}

function jointChoiceSnapshot(choice, topology) {
  const joint = normalizeRebarDetailingChoice(choice).joint;
  return {
    cornerAnchorageMethod: topology.kind === 'CORNER' ? joint.cornerAnchorageMethod : null,
    cornerCongestionMethod: topology.kind === 'CORNER' ? joint.cornerCongestionMethod : null,
    hoopConstructionMethod: joint.hoopConstructionMethod,
  };
}

function orderFacts(choice) {
  const order = normalizeRebarDetailingChoice(choice).joint.orthogonalBeamAssemblyOrder;
  if (order === OrthogonalBeamAssemblyOrder.X_THEN_Y) {
    return {
      order,
      firstAxis: 'X',
      secondAxis: 'Y',
      source: 'PROJECT_DETAILING_CHOICE',
      status: 'RESOLVED',
      reason: null,
    };
  }
  if (order === OrthogonalBeamAssemblyOrder.Y_THEN_X) {
    return {
      order,
      firstAxis: 'Y',
      secondAxis: 'X',
      source: 'PROJECT_DETAILING_CHOICE',
      status: 'RESOLVED',
      reason: null,
    };
  }
  return {
    order: OrthogonalBeamAssemblyOrder.EXPLICIT_REQUIRED,
    firstAxis: null,
    secondAxis: null,
    source: 'APPENDIX_A2_EXPLICIT_REQUIRED',
    status: 'UNRESOLVED',
    reason: 'appendix-a2-orthogonal-beam-assembly-order-explicit-required',
  };
}

function buildViaUnresolvedFact(nodeId, directions, viaBeams, choice) {
  const xBeams = directions.filter((fact) => fact.axis === 'X');
  const yBeams = directions.filter((fact) => fact.axis === 'Y');
  const otherBeams = directions.filter((fact) => fact.axis === 'OTHER');
  const order = orderFacts(choice);
  const topology = classifyJointTopology(directions);
  return {
    kind: 'APPENDIX_A2_ORTHOGONAL_BEAM_ASSEMBLY_ORDER',
    nodeId,
    status: 'UNRESOLVED',
    ok: false,
    reason: 'appendix-a2-via-node-beam-direction-unresolved',
    assemblyOrder: order.order,
    firstAxis: null,
    secondAxis: null,
    xBeams,
    yBeams,
    otherBeams,
    viaBeams,
    jointTopology: topology,
    projectJointChoices: jointChoiceSnapshot(choice, topology),
    candidateRules: candidateRulesForTopology(topology),
    geometryApplication: 'NOT_CONNECTED',
    source: 'RC_DETAILING_GUIDE_2010_APPENDIX_A2',
    appliedRules: [A2_RULE],
  };
}

function normalizedRotationDeg(element) {
  const raw = Number(element?.getAttribute?.('rotate'));
  if (!Number.isFinite(raw)) return 0;
  const normalized = ((raw % 360) + 360) % 360;
  return normalized;
}

function columnConnectionOffset(connection) {
  const prefix =
    connection?.endpoint === 'top'
      ? 'offset_top'
      : connection?.endpoint === 'bottom'
        ? 'offset_bottom'
        : null;
  if (!prefix) return null;
  return {
    x: finiteOffset(connection.element, `${prefix}_X`),
    y: finiteOffset(connection.element, `${prefix}_Y`),
  };
}

function columnBarsAtEndpoint(layout, endpoint) {
  const endpointFacts = layout?.endpointFacts;
  if (endpoint === 'top' && endpointFacts?.top?.bars?.length) return endpointFacts.top.bars;
  if (endpoint === 'bottom' && endpointFacts?.bottom?.bars?.length) {
    return endpointFacts.bottom.bars;
  }
  return layout?.segments?.[0]?.bars || [];
}

function resolveColumnGeometryAtNode(index, nodeId, columnLayoutMap) {
  const entry = index?.columnsByNodeId?.get(String(nodeId));
  const candidates = [];
  for (const connection of entry?.connected || []) {
    if (connection?.tagName !== 'StbColumn') continue;
    if (!['top', 'bottom'].includes(connection.endpoint)) continue;
    const kind = String(connection.element?.getAttribute?.('kind_structure') || '').toUpperCase();
    if (kind && kind !== 'RC') continue;
    const sectionId = normalizeId(connection.element?.getAttribute?.('id_section'));
    const layout = sectionId ? columnLayoutMap?.get(sectionId) : null;
    if (!layout) continue;
    const offset = columnConnectionOffset(connection);
    if (!offset) continue;
    const rotationDeg = normalizedRotationDeg(connection.element);
    const rotationModulo180 = rotationDeg % 180;
    const rotationResolved = Math.min(rotationModulo180, Math.abs(180 - rotationModulo180)) <= 1e-6;
    candidates.push({
      memberId: normalizeId(connection.element?.getAttribute?.('id')),
      sectionId,
      endpoint: connection.endpoint,
      shape: layout.shape,
      widthMm: Number(layout.width) || null,
      heightMm: Number(layout.height) || null,
      diameterMm: Number(layout.diameter) || null,
      centerOffsetAtNode: offset,
      rotationDeg,
      rotationResolved,
      bars: columnBarsAtEndpoint(layout, connection.endpoint),
      estimated: layout.estimated === true,
    });
  }
  if (candidates.length === 0) return null;

  const signatures = new Set(
    candidates.map((candidate) =>
      [
        candidate.shape,
        candidate.widthMm ?? '',
        candidate.heightMm ?? '',
        candidate.diameterMm ?? '',
        candidate.centerOffsetAtNode.x,
        candidate.centerOffsetAtNode.y,
        candidate.rotationResolved ? 'AXIS' : `ROT:${candidate.rotationDeg}`,
      ].join('|'),
    ),
  );
  if (signatures.size > 1) return null;

  const first = candidates[0];
  return {
    ...first,
    memberIds: candidates.map((candidate) => candidate.memberId).filter(Boolean),
    sectionIds: [...new Set(candidates.map((candidate) => candidate.sectionId).filter(Boolean))],
    bars: candidates.flatMap((candidate) => candidate.bars || []),
    estimated: candidates.some((candidate) => candidate.estimated),
  };
}

function resolveBeamGeometryFacts(directions, beamLayoutMaps) {
  return (directions || []).map((fact) => {
    const map = fact.tagName === 'StbBeam' ? beamLayoutMaps?.beam : beamLayoutMaps?.girder;
    return {
      fact,
      layout: fact.sectionId ? map?.get(fact.sectionId) || null : null,
    };
  });
}

function attachGeometryFeasibility(
  fact,
  index,
  beamLayoutMaps,
  columnLayoutMap,
  choice,
  options = {},
) {
  let geometryFeasibility = null;
  if (options.geometryChecks !== false && ['SIDE', 'CORNER'].includes(fact?.jointTopology?.kind)) {
    const beamGeometryFacts = resolveBeamGeometryFacts(
      [...(fact.xBeams || []), ...(fact.yBeams || [])],
      beamLayoutMaps,
    );
    const columnGeometry = resolveColumnGeometryAtNode(index, fact.nodeId, columnLayoutMap);
    geometryFeasibility = evaluateAppendixA2JointGeometryFeasibility({
      topology: fact.jointTopology,
      firstAxis: fact.firstAxis,
      secondAxis: fact.secondAxis,
      beamGeometryFacts,
      columnGeometry,
    });
  }

  const rawProductionChoices = resolveAppendixA2JointProductionChoices({
    topology: fact?.jointTopology,
    choice,
    geometryFeasibility,
    nodeId: fact?.nodeId || null,
    beams: [...(fact?.xBeams || []), ...(fact?.yBeams || [])],
    projectDetailing: options.projectDetailing,
  });
  const structuralGeometry = rawProductionChoices?.congestion?.structuralGeometry || null;
  const stbRepresentation =
    structuralGeometry?.status === 'STRUCTURAL_GEOMETRY_READY' && options.xmlDoc
      ? buildAppendixA2CongestionStbRepresentationPlan(options.xmlDoc, structuralGeometry)
      : null;
  const productionChoices = stbRepresentation
    ? {
        ...rawProductionChoices,
        congestion: {
          ...rawProductionChoices.congestion,
          stbRepresentation,
        },
      }
    : rawProductionChoices;
  return {
    ...fact,
    ...(geometryFeasibility
      ? {
          geometryFeasibility,
          geometryApplication: geometryFeasibility.geometryApplication,
        }
      : {}),
    productionChoices,
  };
}

function buildJointFact(nodeId, directions, choice) {
  const xBeams = directions.filter((fact) => fact.axis === 'X');
  const yBeams = directions.filter((fact) => fact.axis === 'Y');
  const otherBeams = directions.filter((fact) => fact.axis === 'OTHER');
  const order = orderFacts(choice);
  const topology = classifyJointTopology(directions);

  if (otherBeams.length > 0 || xBeams.length === 0 || yBeams.length === 0) {
    return {
      kind: 'APPENDIX_A2_ORTHOGONAL_BEAM_ASSEMBLY_ORDER',
      nodeId,
      status: 'UNRESOLVED',
      ok: false,
      reason: 'appendix-a2-orthogonal-beam-global-xy-axis-unresolved',
      assemblyOrder: order.order,
      firstAxis: null,
      secondAxis: null,
      xBeams,
      yBeams,
      otherBeams,
      viaBeams: [],
      jointTopology: topology,
      projectJointChoices: jointChoiceSnapshot(choice, topology),
      candidateRules: candidateRulesForTopology(topology),
      geometryApplication: 'NOT_CONNECTED',
      source: 'RC_DETAILING_GUIDE_2010_APPENDIX_A2',
      appliedRules: [A2_RULE],
    };
  }

  return {
    kind: 'APPENDIX_A2_ORTHOGONAL_BEAM_ASSEMBLY_ORDER',
    nodeId,
    status: order.status,
    ok: order.status === 'RESOLVED',
    reason: order.reason,
    assemblyOrder: order.order,
    firstAxis: order.firstAxis,
    secondAxis: order.secondAxis,
    xBeams,
    yBeams,
    otherBeams,
    viaBeams: [],
    jointTopology: topology,
    projectJointChoices: jointChoiceSnapshot(choice, topology),
    candidateRules: candidateRulesForTopology(topology),
    geometryApplication: 'NOT_CONNECTED',
    source: 'RC_DETAILING_GUIDE_2010_APPENDIX_A2',
    choiceSource: order.source,
    appliedRules: [A2_RULE],
  };
}

export function collectRebarAppendixA2JointAssemblyChecks(xmlDoc, options = {}) {
  if (!xmlDoc) return [];
  const choice = options.choice ?? getRebarCommonConfig().detailing?.choice;
  const scanTag = createTagScanner(xmlDoc);
  const index = buildRebarModelIndex(xmlDoc, { scanTag });
  if (!index?.beamsByNodeId) return [];

  const beamLayoutMaps =
    options.beamLayoutMaps ||
    (options.geometryChecks === false ? null : buildBeamRebarLayoutMaps(xmlDoc));
  const columnLayoutMap =
    options.columnLayoutMap ||
    (options.geometryChecks === false ? null : buildColumnRebarLayoutMap(xmlDoc));

  const checks = [];
  for (const [nodeId, connections] of index.beamsByNodeId) {
    if (!hasRcOrSrcColumnAtNode(index, nodeId)) continue;
    const facts = uniqueDirectionFacts(scanTag, connections, index);
    const viaBeams = unresolvedViaBeamFacts(connections);
    if (viaBeams.length > 0) {
      checks.push(buildViaUnresolvedFact(nodeId, facts, viaBeams, choice));
      continue;
    }
    if (facts.length < 2 || !hasOrthogonalPair(facts)) continue;
    checks.push(
      attachGeometryFeasibility(
        buildJointFact(nodeId, facts, choice),
        index,
        beamLayoutMaps,
        columnLayoutMap,
        choice,
        { ...options, xmlDoc },
      ),
    );
  }

  return checks.sort((a, b) =>
    String(a.nodeId).localeCompare(String(b.nodeId), undefined, {
      numeric: true,
      sensitivity: 'base',
    }),
  );
}
