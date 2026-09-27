/**
 * @fileoverview 配筋指針2010 付録A A2 隅柱接合部「納まり別法」の構造geometry契約。
 *
 * A2 d) は配筋混雑時の別法として「梁突出し法」「梁内寄せ法」を示すが、
 * 突出し寸法・内寄せ量は標準図だけから一意に決定できない。したがって本モジュールは
 * structural member geometry を推定せず、projectDetailing の EXPLICIT assignment を
 * 検証してproduction sidecarへ昇格するだけとする。STB Working Documentはここでは変更しない。
 */

import { getRebarProjectDetailing } from '../../../config/rebarProjectDetailing.js';
import { CornerJointCongestionMethod } from '../../../config/rebarDetailingChoice.js';
import { rebarRuleTraceMetadata } from './rebarDetailingRuleRegistry.js';

export const APPENDIX_A2_CORNER_CONGESTION_GEOMETRY_TYPE = 'APPENDIX_A2_CORNER_CONGESTION_GEOMETRY';

const A2_CONGESTION_RULE = rebarRuleTraceMetadata('APPENDIX-A2-CORNER-JOINT-CONGESTION-METHOD');
const A2_EXPLICIT_GEOMETRY_RULE = rebarRuleTraceMetadata(
  'APPENDIX-A2-CORNER-CONGESTION-EXPLICIT-GEOMETRY',
);
const A2_JASS5_BEND_RULE = rebarRuleTraceMetadata('APPENDIX-A2-ALTERNATIVE-DETAIL-JASS5-BEND-DIA');
const A2_PROJECTION_REBAR_RULE = rebarRuleTraceMetadata(
  'APPENDIX-A2-BEAM-PROJECTION-SUPPLEMENTAL-REBAR',
);
const A2_INNER_SETBACK_RULE = rebarRuleTraceMetadata('APPENDIX-A2-BEAM-INNER-SETBACK-ALIGNMENT');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positive(value) {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function projectEntry(projectDetailing) {
  if (!isPlainObject(projectDetailing)) return null;
  if (
    Object.prototype.hasOwnProperty.call(
      projectDetailing,
      APPENDIX_A2_CORNER_CONGESTION_GEOMETRY_TYPE,
    )
  ) {
    return projectDetailing[APPENDIX_A2_CORNER_CONGESTION_GEOMETRY_TYPE];
  }
  if (
    isPlainObject(projectDetailing.special) &&
    Object.prototype.hasOwnProperty.call(
      projectDetailing.special,
      APPENDIX_A2_CORNER_CONGESTION_GEOMETRY_TYPE,
    )
  ) {
    return projectDetailing.special[APPENDIX_A2_CORNER_CONGESTION_GEOMETRY_TYPE];
  }
  return null;
}

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    status: 'STRUCTURAL_GEOMETRY_REQUIRED',
    productionReady: false,
    reason,
    geometryApplication: 'MEMBER_GEOMETRY_NOT_MUTATED',
    assignment: null,
    members: [],
    requirements: null,
    blockers: [reason],
    appliedRules: [A2_CONGESTION_RULE, A2_EXPLICIT_GEOMETRY_RULE, A2_JASS5_BEND_RULE],
    ...extra,
  };
}

function connectedBeamKeys(beams) {
  return new Set(
    (beams || [])
      .filter((beam) => beam?.id && ['start', 'end'].includes(beam.endpoint))
      .map((beam) => `${beam.id}|${beam.endpoint}`),
  );
}

function validateCommonMember(raw, index, expectedMethod, connected) {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: `appendix-a2-congestion-member-${index}-invalid` };
  }
  const memberId = text(String(raw.memberId ?? ''));
  const endpoint = raw.endpoint;
  if (!memberId || !['start', 'end'].includes(endpoint)) {
    return { ok: false, reason: `appendix-a2-congestion-member-${index}-identity-required` };
  }
  if (!connected.has(`${memberId}|${endpoint}`)) {
    return {
      ok: false,
      reason: `appendix-a2-congestion-member-${index}-not-connected-to-joint`,
      memberId,
      endpoint,
    };
  }
  if (raw.method && raw.method !== expectedMethod) {
    return {
      ok: false,
      reason: `appendix-a2-congestion-member-${index}-method-mismatch`,
      memberId,
      endpoint,
    };
  }
  return { ok: true, memberId, endpoint };
}

function projectionRequirements() {
  return Object.freeze({
    source: 'RC_DETAILING_GUIDE_2010_APPENDIX_A2_FIG_A2_6_A2_7',
    beamBarBendInsideDiameterMustFollowJass5: true,
    supplementalUBarDiaMm: 13,
    supplementalUBarColumnAnchorageApproxDiaFactor: 20,
    endVerticalBarDiaMm: 13,
    endReturnBendMinDiaFactor: 8,
    columnFaceStirrupUsesBeamStirrupDiameter: true,
    protrudingZoneStirrupUsesBeamStirrupDiameter: true,
    protrudingZoneStirrupMaxSpacingMm: 200,
    note: '梁突出し部は柱面に梁と同径のあばら筋を設け、以降200mm以下。小口面に補強U字筋D13、柱への定着は20d程度。所定定着長が直線で取れる場合も梁上下筋末端は8d以上梁内へ折曲げ、縦補助筋D13を設ける。',
  });
}

function innerSetbackRequirements() {
  return Object.freeze({
    source: 'RC_DETAILING_GUIDE_2010_APPENDIX_A2_FIG_A2_8',
    beamBarBendInsideDiameterMustFollowJass5: true,
    beamInnerFaceAlignedToColumnInnerCorner: true,
    bendStartLinePerpendicularToBeamOuterFace: true,
    columnAnchorageRequired: true,
    largeColumnEccentricityWarning: true,
    note: '梁内面を柱の入隅に合わせ、梁筋折曲げ起点を直交する梁外側に設け柱断面内へ定着。梁幅に対して柱断面が極端に大きい場合は柱偏心取付けとなるため避ける。STB上で全長offsetとするか端部局所geometryとするかは標準図から決めず明示scopeを要求する。',
  });
}

function validateProjectionMember(raw, common, index, { allowUnspecifiedZoneLength = false } = {}) {
  const projectionMm = positive(raw.projectionMm);
  if (projectionMm === null || raw.projectionVerified !== true) {
    return {
      ok: false,
      reason: `appendix-a2-beam-projection-member-${index}-verified-projection-required`,
    };
  }
  const zoneLengthMm = positive(raw.zoneLengthMm);
  if (zoneLengthMm === null || raw.zoneLengthVerified !== true) {
    if (!allowUnspecifiedZoneLength)
      return {
        ok: false,
        reason: `appendix-a2-beam-projection-member-${index}-verified-zone-length-required`,
      };
  }
  if (!['POSITIVE', 'NEGATIVE'].includes(raw.outsideSide)) {
    return {
      ok: false,
      reason: `appendix-a2-beam-projection-member-${index}-outside-side-required`,
    };
  }
  if (raw.concreteGeometryVerified !== true) {
    return {
      ok: false,
      reason: `appendix-a2-beam-projection-member-${index}-concrete-geometry-verification-required`,
    };
  }
  if (zoneLengthMm === null || raw.zoneLengthVerified !== true) {
    return {
      ok: true,
      member: {
        memberId: common.memberId,
        endpoint: common.endpoint,
        method: CornerJointCongestionMethod.BEAM_PROJECTION,
        coordinateSpace: 'beam-cross-section',
        projectionMm,
        projectionVerified: true,
        zoneLengthMm: null,
        zoneLengthVerified: false,
        outsideSide: raw.outsideSide,
        concreteGeometryVerified: true,
        note: text(raw.note),
      },
    };
  }
  return {
    ok: true,
    member: {
      memberId: common.memberId,
      endpoint: common.endpoint,
      method: CornerJointCongestionMethod.BEAM_PROJECTION,
      coordinateSpace: 'beam-cross-section',
      projectionMm,
      projectionVerified: true,
      zoneLengthMm,
      zoneLengthVerified: true,
      outsideSide: raw.outsideSide,
      concreteGeometryVerified: true,
      note: text(raw.note),
    },
  };
}

function validateInnerSetbackMember(raw, common, index) {
  const offsetXmm = finite(raw.offsetXmm);
  const offsetYmm = finite(raw.offsetYmm);
  if (offsetXmm === null || offsetYmm === null || raw.planOffsetVerified !== true) {
    return {
      ok: false,
      reason: `appendix-a2-beam-inner-setback-member-${index}-verified-plan-offset-required`,
    };
  }
  if (Math.hypot(offsetXmm, offsetYmm) <= 1e-8) {
    return {
      ok: false,
      reason: `appendix-a2-beam-inner-setback-member-${index}-zero-plan-offset`,
    };
  }
  if (
    !['WHOLE_MEMBER', 'JOINT_END_LOCAL'].includes(raw.offsetScope) ||
    raw.offsetScopeVerified !== true
  ) {
    return {
      ok: false,
      reason: `appendix-a2-beam-inner-setback-member-${index}-verified-offset-scope-required`,
    };
  }
  if (raw.innerFaceAlignmentVerified !== true) {
    return {
      ok: false,
      reason: `appendix-a2-beam-inner-setback-member-${index}-inner-face-alignment-verification-required`,
    };
  }
  if (raw.columnEccentricityAccepted !== true) {
    return {
      ok: false,
      reason: `appendix-a2-beam-inner-setback-member-${index}-column-eccentricity-acceptance-required`,
    };
  }
  return {
    ok: true,
    member: {
      memberId: common.memberId,
      endpoint: common.endpoint,
      method: CornerJointCongestionMethod.BEAM_INNER_SETBACK,
      coordinateSpace: 'world-plan',
      offsetXmm,
      offsetYmm,
      planOffsetVerified: true,
      offsetScope: raw.offsetScope,
      offsetScopeVerified: true,
      oppositeEndpointImpactAccepted: raw.oppositeEndpointImpactAccepted === true,
      innerFaceAlignmentVerified: true,
      columnEccentricityAccepted: true,
      note: text(raw.note),
    },
  };
}

/**
 * A2 corner congestion method の explicit structural geometry を解決する。
 *
 * geometryを返すだけでSTB要素は変更しない。consumer未接続のため、
 * status=STRUCTURAL_GEOMETRY_READY でも productionReady=false を維持する。
 */
export function resolveAppendixA2CornerCongestionGeometry({
  nodeId,
  method,
  beams = [],
  projectDetailing,
  allowUnspecifiedZoneLength = false,
} = {}) {
  if (
    ![
      CornerJointCongestionMethod.BEAM_PROJECTION,
      CornerJointCongestionMethod.BEAM_INNER_SETBACK,
    ].includes(method)
  ) {
    return unresolved('appendix-a2-congestion-explicit-geometry-not-applicable', {
      status: 'NOT_APPLICABLE',
      geometryApplication: 'NOT_APPLIED',
    });
  }

  const source = projectDetailing === undefined ? getRebarProjectDetailing() : projectDetailing;
  const entry = projectEntry(source);
  if (entry === null || entry === undefined) {
    return unresolved('appendix-a2-congestion-explicit-geometry-required');
  }
  if (!isPlainObject(entry)) {
    return unresolved('appendix-a2-congestion-project-detailing-entry-invalid');
  }
  if (entry.productionEnabled !== true) {
    return unresolved('appendix-a2-congestion-production-not-enabled');
  }
  if (entry.productionMode !== 'EXPLICIT') {
    return unresolved('appendix-a2-congestion-explicit-production-mode-required');
  }
  if (!Array.isArray(entry.assignments)) {
    return unresolved('appendix-a2-congestion-assignments-required');
  }

  const normalizedNodeId = text(String(nodeId ?? ''));
  if (!normalizedNodeId) {
    return unresolved('appendix-a2-congestion-node-id-required');
  }
  const matches = entry.assignments.filter(
    (assignment) =>
      isPlainObject(assignment) &&
      String(assignment.nodeId) === normalizedNodeId &&
      assignment.method === method,
  );
  if (matches.length !== 1) {
    return unresolved(
      matches.length === 0
        ? 'appendix-a2-congestion-joint-assignment-missing'
        : 'appendix-a2-congestion-joint-assignment-ambiguous',
      { assignmentCount: matches.length },
    );
  }

  const assignment = matches[0];
  if (!Array.isArray(assignment.members) || assignment.members.length === 0) {
    return unresolved('appendix-a2-congestion-member-assignments-required');
  }

  const connected = connectedBeamKeys(beams);
  const seen = new Set();
  const members = [];
  for (const [index, raw] of assignment.members.entries()) {
    const common = validateCommonMember(raw, index, method, connected);
    if (!common.ok) return unresolved(common.reason, common);
    const key = `${common.memberId}|${common.endpoint}`;
    if (seen.has(key)) {
      return unresolved('appendix-a2-congestion-member-assignment-duplicate', {
        memberId: common.memberId,
        endpoint: common.endpoint,
      });
    }
    seen.add(key);

    const checked =
      method === CornerJointCongestionMethod.BEAM_PROJECTION
        ? validateProjectionMember(raw, common, index, { allowUnspecifiedZoneLength })
        : validateInnerSetbackMember(raw, common, index);
    if (!checked.ok) return unresolved(checked.reason);
    members.push(checked.member);
  }

  const requirements =
    method === CornerJointCongestionMethod.BEAM_PROJECTION
      ? projectionRequirements()
      : innerSetbackRequirements();
  const methodRules =
    method === CornerJointCongestionMethod.BEAM_PROJECTION
      ? [A2_PROJECTION_REBAR_RULE]
      : [A2_INNER_SETBACK_RULE];

  return {
    resolved: true,
    status: 'STRUCTURAL_GEOMETRY_READY',
    productionReady: false,
    reason: 'appendix-a2-congestion-structural-geometry-consumer-not-connected',
    geometryApplication: 'EXPLICIT_MEMBER_GEOMETRY_PENDING_CONSUMER',
    assignment: {
      nodeId: normalizedNodeId,
      method,
      members,
    },
    members,
    requirements,
    blockers: ['structural-member-geometry-consumer-not-connected'],
    source: 'project-detailing',
    appliedRules: [
      A2_CONGESTION_RULE,
      A2_EXPLICIT_GEOMETRY_RULE,
      A2_JASS5_BEND_RULE,
      ...methodRules,
    ],
  };
}
