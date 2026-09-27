/**
 * @fileoverview 付録A2 隅柱納まり別法をST-Bridgeへ表現できるかを判定する純関数plan。
 *
 * このモジュールはXMLを変更しない。配筋指針2010 A2のgeometry choiceと、
 * ST-Bridgeの StbGirder offset / StbSecFigureBeam_RC /
 * StbGirderConcreteSwitch の表現能力の境界だけを固定する。
 */

import { CornerJointCongestionMethod } from '../../../config/rebarDetailingChoice.js';

const EPS = 1e-6;

function elementName(element) {
  return element?.localName || element?.nodeName || '';
}

function children(element, tagName) {
  return Array.from(element?.childNodes || []).filter(
    (child) => child?.nodeType === 1 && elementName(child) === tagName,
  );
}

function all(doc, tagName) {
  return Array.from(doc?.getElementsByTagName?.(tagName) || []);
}

function byId(doc, tagNames, id) {
  const matches = [];
  for (const tag of tagNames) {
    for (const element of all(doc, tag)) {
      if (String(element.getAttribute('id')) === String(id)) matches.push(element);
    }
  }
  return matches;
}

function finiteAttr(element, name, fallback = null) {
  const raw = element?.getAttribute?.(name);
  if (raw === null || raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function point(doc, nodeId) {
  const matches = byId(doc, ['StbNode'], nodeId);
  if (matches.length !== 1) return null;
  const node = matches[0];
  const value = {
    x: finiteAttr(node, 'X'),
    y: finiteAttr(node, 'Y'),
    z: finiteAttr(node, 'Z'),
  };
  return Object.values(value).every(Number.isFinite) ? value : null;
}

function memberOffsets(member) {
  return {
    start: {
      x: finiteAttr(member, 'offset_start_X', 0),
      y: finiteAttr(member, 'offset_start_Y', 0),
      z: finiteAttr(member, 'offset_start_Z', 0),
    },
    end: {
      x: finiteAttr(member, 'offset_end_X', 0),
      y: finiteAttr(member, 'offset_end_Y', 0),
      z: finiteAttr(member, 'offset_end_Z', 0),
    },
  };
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function magnitude(v) {
  return Math.hypot(v.x, v.y, v.z);
}

function memberGeometry(doc, member) {
  if (children(member, 'StbGirderViaNode').length || children(member, 'StbBeamViaNode').length) {
    return { ok: false, reason: 'appendix-a2-stb-plan-via-node-member-not-supported' };
  }
  const startNode = point(doc, member.getAttribute('id_node_start'));
  const endNode = point(doc, member.getAttribute('id_node_end'));
  if (!startNode || !endNode) {
    return { ok: false, reason: 'appendix-a2-stb-plan-member-node-unresolved' };
  }
  const offsets = memberOffsets(member);
  const start = add(startNode, offsets.start);
  const end = add(endNode, offsets.end);
  const vector = subtract(end, start);
  const lengthMm = magnitude(vector);
  if (!(lengthMm > EPS)) {
    return { ok: false, reason: 'appendix-a2-stb-plan-member-length-invalid' };
  }
  const planLength = Math.hypot(vector.x, vector.y);
  if (!(planLength > EPS)) {
    return { ok: false, reason: 'appendix-a2-stb-plan-member-plan-axis-unresolved' };
  }
  return {
    ok: true,
    start,
    end,
    offsets,
    lengthMm,
    planUnit: { x: vector.x / planLength, y: vector.y / planLength },
  };
}

function rcSectionFact(doc, member) {
  const sectionId = member.getAttribute('id_section');
  if (!sectionId) return { ok: false, reason: 'appendix-a2-stb-plan-section-id-missing' };
  const sections = byId(doc, ['StbSecBeam_RC'], sectionId);
  if (sections.length !== 1) {
    return {
      ok: false,
      reason:
        sections.length === 0
          ? 'appendix-a2-stb-plan-rc-section-missing'
          : 'appendix-a2-stb-plan-rc-section-ambiguous',
    };
  }
  const section = sections[0];
  const figures = children(section, 'StbSecFigureBeam_RC');
  if (figures.length !== 1) {
    return {
      ok: false,
      reason: 'appendix-a2-stb-plan-existing-multi-figure-section-not-supported',
      figureCount: figures.length,
    };
  }
  const straight = children(figures[0], 'StbSecBeamStraight');
  if (straight.length !== 1) {
    return { ok: false, reason: 'appendix-a2-stb-plan-baseline-straight-section-required' };
  }
  const widthMm = finiteAttr(straight[0], 'width');
  const depthMm = finiteAttr(straight[0], 'depth');
  const horizontalOffsetMm = finiteAttr(straight[0], 'horizontal_offset', 0);
  const verticalOffsetMm = finiteAttr(straight[0], 'vertical_offset', 0);
  if (!(widthMm > 0) || !(depthMm > 0)) {
    return { ok: false, reason: 'appendix-a2-stb-plan-section-dimensions-unresolved' };
  }
  const referenceCount = [...all(doc, 'StbGirder'), ...all(doc, 'StbBeam')].filter(
    (candidate) => String(candidate.getAttribute('id_section')) === String(sectionId),
  ).length;
  return {
    ok: true,
    sectionId: String(sectionId),
    widthMm,
    depthMm,
    horizontalOffsetMm,
    verticalOffsetMm,
    referenceCount,
  };
}

function resolveMember(doc, memberId) {
  const matches = byId(doc, ['StbGirder', 'StbBeam'], memberId);
  if (matches.length !== 1) {
    return {
      ok: false,
      reason:
        matches.length === 0
          ? 'appendix-a2-stb-plan-member-missing'
          : 'appendix-a2-stb-plan-member-id-ambiguous',
    };
  }
  const member = matches[0];
  const kind = String(member.getAttribute('kind_structure') || '').toUpperCase();
  if (kind && kind !== 'RC') {
    return {
      ok: false,
      reason: 'appendix-a2-stb-plan-initial-consumer-rc-only',
      kindStructure: kind,
    };
  }
  return { ok: true, member };
}

function projectionPlan(doc, assignment, memberSpec) {
  const resolved = resolveMember(doc, memberSpec.memberId);
  if (!resolved.ok) return resolved;
  const member = resolved.member;
  const geometry = memberGeometry(doc, member);
  if (!geometry.ok) return geometry;
  const section = rcSectionFact(doc, member);
  if (!section.ok) return section;

  const zoneLengthMm = Number(memberSpec.zoneLengthMm);
  if (
    !(zoneLengthMm > EPS) ||
    memberSpec.zoneLengthVerified !== true ||
    !(zoneLengthMm < geometry.lengthMm - EPS)
  ) {
    return {
      ok: false,
      reason: 'appendix-a2-beam-projection-verified-zone-length-required',
      memberLengthMm: geometry.lengthMm,
    };
  }
  const sign = memberSpec.outsideSide === 'POSITIVE' ? 1 : -1;
  const projected = {
    widthMm: section.widthMm + Number(memberSpec.projectionMm),
    depthMm: section.depthMm,
    horizontalOffsetMm: section.horizontalOffsetMm + (sign * Number(memberSpec.projectionMm)) / 2,
    verticalOffsetMm: section.verticalOffsetMm,
  };
  const baseline = {
    widthMm: section.widthMm,
    depthMm: section.depthMm,
    horizontalOffsetMm: section.horizontalOffsetMm,
    verticalOffsetMm: section.verticalOffsetMm,
  };
  const startSide = memberSpec.endpoint === 'start';
  const boundaryMm = startSide ? zoneLengthMm : geometry.lengthMm - zoneLengthMm;
  const figures = startSide
    ? [
        { order: 1, kind: 'STRAIGHT', ...projected },
        { order: 2, kind: 'STRAIGHT', ...baseline },
      ]
    : [
        { order: 1, kind: 'STRAIGHT', ...baseline },
        { order: 2, kind: 'STRAIGHT', ...projected },
      ];

  return {
    ok: true,
    status: 'STB_CONCRETE_REPRESENTATION_READY',
    productionReady: false,
    strategy: 'CLONE_RC_SECTION_WITH_CONCRETE_SWITCH',
    memberId: String(memberSpec.memberId),
    memberTag: elementName(member),
    endpoint: memberSpec.endpoint,
    sourceSectionId: section.sectionId,
    sourceSectionReferenceCount: section.referenceCount,
    requiresDedicatedSectionClone: true,
    memberLengthMm: geometry.lengthMm,
    figures,
    concreteSwitches: [
      { order: 1, distanceMm: boundaryMm },
      { order: 2, distanceMm: geometry.lengthMm },
    ],
    barArrangementStrategy: 'PRESERVE_EXISTING_BASELINE_PENDING_LOCAL_REBAR_CONSUMER',
    blockers: ['working-document-mutation-consumer-not-connected'],
    source: 'STB StbSecFigureBeam_RC + StbSecBeamStraight + StbGirderConcreteSwitch',
  };
}

function innerSetbackPlan(doc, assignment, memberSpec) {
  const resolved = resolveMember(doc, memberSpec.memberId);
  if (!resolved.ok) return resolved;
  const member = resolved.member;
  const geometry = memberGeometry(doc, member);
  if (!geometry.ok) return geometry;

  if (memberSpec.offsetScope === 'JOINT_END_LOCAL') {
    return {
      ok: false,
      status: 'STB_REPRESENTATION_REQUIRED',
      reason: 'appendix-a2-inner-setback-joint-end-local-stb-mapping-not-connected',
      memberId: String(memberSpec.memberId),
      endpoint: memberSpec.endpoint,
      source:
        'STB supports member offsets and section horizontal offsets, but local end scope needs an explicit switch/transition contract',
    };
  }
  if (
    memberSpec.offsetScope !== 'WHOLE_MEMBER' ||
    memberSpec.oppositeEndpointImpactAccepted !== true
  ) {
    return {
      ok: false,
      status: 'STB_REPRESENTATION_REQUIRED',
      reason: 'appendix-a2-inner-setback-whole-member-opposite-end-acceptance-required',
      memberId: String(memberSpec.memberId),
      endpoint: memberSpec.endpoint,
    };
  }

  const delta = {
    x: Number(memberSpec.offsetXmm),
    y: Number(memberSpec.offsetYmm),
    z: 0,
  };
  const current = geometry.offsets;
  return {
    ok: true,
    status: 'STB_MEMBER_OFFSET_REPRESENTATION_READY',
    productionReady: false,
    strategy: 'UPDATE_MEMBER_START_END_OFFSETS',
    memberId: String(memberSpec.memberId),
    memberTag: elementName(member),
    endpoint: memberSpec.endpoint,
    currentOffsets: current,
    targetOffsets: {
      start: add(current.start, delta),
      end: add(current.end, delta),
    },
    affectsOppositeEndpoint: true,
    oppositeEndpointImpactAccepted: true,
    blockers: ['working-document-mutation-consumer-not-connected'],
    source: 'STB StbGirder/StbBeam offset_start_X/Y + offset_end_X/Y',
  };
}

/**
 * 検証済み A2 structuralGeometry sidecar を STB representation plan へ変換する。
 * XML mutationは行わない。
 */
export function buildAppendixA2CongestionStbRepresentationPlan(xmlDoc, structuralGeometry) {
  if (!xmlDoc || structuralGeometry?.status !== 'STRUCTURAL_GEOMETRY_READY') {
    return {
      resolved: false,
      status: 'STB_REPRESENTATION_REQUIRED',
      productionReady: false,
      reason: 'appendix-a2-congestion-structural-geometry-not-ready',
      members: [],
    };
  }
  const assignment = structuralGeometry.assignment;
  const method = assignment?.method;
  const plans = [];
  const unresolved = [];

  for (const memberSpec of assignment?.members || []) {
    const plan =
      method === CornerJointCongestionMethod.BEAM_PROJECTION
        ? projectionPlan(xmlDoc, assignment, memberSpec)
        : method === CornerJointCongestionMethod.BEAM_INNER_SETBACK
          ? innerSetbackPlan(xmlDoc, assignment, memberSpec)
          : {
              ok: false,
              reason: 'appendix-a2-congestion-stb-representation-method-unsupported',
            };
    if (plan.ok) plans.push(plan);
    else unresolved.push({ memberId: memberSpec.memberId, ...plan });
  }

  if (unresolved.length > 0 || plans.length !== (assignment?.members || []).length) {
    return {
      resolved: false,
      status: 'STB_REPRESENTATION_REQUIRED',
      productionReady: false,
      reason: unresolved[0]?.reason || 'appendix-a2-congestion-stb-representation-unresolved',
      method,
      members: plans,
      unresolved,
    };
  }

  return {
    resolved: true,
    status: 'STB_REPRESENTATION_READY',
    productionReady: false,
    reason: 'appendix-a2-congestion-working-document-consumer-not-connected',
    method,
    nodeId: assignment.nodeId,
    members: plans,
    unresolved: [],
    blockers: ['working-document-mutation-consumer-not-connected'],
  };
}
