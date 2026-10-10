/**
 * @fileoverview R12-AO world RebarPathを支持梁のふかし判定座標へ戻すproduction adapter。
 *
 * ST-Bridge梁の右/左は部材座標Yの負/正に対応するため、判定座標では
 * x=RIGHT(+), y=TOP(+), z=接合面から支持梁内向き(+) とする。
 * 接合面より先端小梁側の領域は隣接部材が負担するためstation=0でclipし、
 * 支持梁遠端を越える不足はANCHORAGE_CONCRETE_MISSINGとして残す。
 */

import { createArc, createLine, createRebarPath, validateRebarPath } from './rebarPath.js';
import { parseElements } from '../../../common-stb/import/parser/stbParserCore.js';
import { buildRequiredConcreteEnvelope } from './requiredConcreteEnvelope.js';
import { evaluateConcreteDeficiency } from './concreteDeficiency.js';
import { planFukashiCandidate } from './fukashiCandidatePlanner.js';
import {
  buildFukashiCandidateSolid,
  findCandidatePenetrationConflict,
  recheckFukashiCandidateSolid,
} from './fukashiCandidateSolid.js';
import { buildStbThicknessAddExportCandidate } from './concreteAccommodationStbExport.js';
import { evaluateRebarPathCollision } from './rebarPathCollision.js';
import { buildCandidateWorldObb, findCandidateMemberCollision } from './concreteMemberCollision.js';

const EPS = 1e-6;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeMemberValue(member, key) {
  const raw = member?.[key];
  if (raw === undefined || raw === null || raw === '') return 0;
  const value = finite(raw);
  return value !== null && value >= 0 ? value : null;
}

function quaternion(placement) {
  const value = placement?.rotation || {};
  const x = finite(value.x) ?? 0;
  const y = finite(value.y) ?? 0;
  const z = finite(value.z) ?? 0;
  const w = finite(value.w) ?? 1;
  const length = Math.hypot(x, y, z, w);
  if (!(length > EPS)) return null;
  return { x: x / length, y: y / length, z: z / length, w: w / length };
}

function rotateByInverseQuaternion(vector, q) {
  // q^-1 * v * q を展開。qは正規化済み。
  const ix = q.w * vector.x - q.y * vector.z + q.z * vector.y;
  const iy = q.w * vector.y - q.z * vector.x + q.x * vector.z;
  const iz = q.w * vector.z - q.x * vector.y + q.y * vector.x;
  const iw = q.x * vector.x + q.y * vector.y + q.z * vector.z;
  return {
    x: ix * q.w + iw * q.x + iy * q.z - iz * q.y,
    y: iy * q.w + iw * q.y + iz * q.x - ix * q.z,
    z: iz * q.w + iw * q.z + ix * q.y - iy * q.x,
  };
}

function inverseRoll(vector, placement) {
  const roll = Number(placement?.localRollRad) || 0;
  if (Math.abs(roll) <= EPS) return vector;
  const cos = Math.cos(-roll);
  const sin = Math.sin(-roll);
  return {
    x: vector.x * cos - vector.y * sin,
    y: vector.x * sin + vector.y * cos,
    z: vector.z,
  };
}

function worldVectorToMemberLocal(vector, placement) {
  const q = quaternion(placement);
  if (!q) return null;
  return inverseRoll(
    rotateByInverseQuaternion(
      { x: Number(vector?.x), y: Number(vector?.y), z: Number(vector?.z) },
      q,
    ),
    placement,
  );
}

function worldPointToMemberLocal(point, placement) {
  const center = placement?.center;
  if (
    !center ||
    ![point?.x, point?.y, point?.z, center.x, center.y, center.z].every((value) =>
      Number.isFinite(Number(value)),
    )
  ) {
    return null;
  }
  return worldVectorToMemberLocal(
    {
      x: Number(point.x) - Number(center.x),
      y: Number(point.y) - Number(center.y),
      z: Number(point.z) - Number(center.z),
    },
    placement,
  );
}

function stationSign(supportEndpoint) {
  if (supportEndpoint === 'start') return 1;
  if (supportEndpoint === 'end') return -1;
  return null;
}

function accommodationPoint(point, placement, supportEndpoint) {
  const local = worldPointToMemberLocal(point, placement);
  const sign = stationSign(supportEndpoint);
  const lengthMm = Number(placement?.length);
  if (!local || sign === null || !(lengthMm > 0)) return null;
  return {
    // renderer local xはSTB +Y(LEFT)なので反転し、RIGHTを正にする。
    x: -local.x,
    y: local.y,
    z: lengthMm / 2 + sign * local.z,
  };
}

function accommodationVector(vector, placement, supportEndpoint, isNormal = false) {
  const local = worldVectorToMemberLocal(vector, placement);
  const sign = stationSign(supportEndpoint);
  if (!local || sign === null) return null;
  const mapped = { x: -local.x, y: local.y, z: sign * local.z };
  if (!isNormal) return mapped;

  // RIGHT/TOP/station変換は直交変換だがendpoint=startでは鏡映を含む。
  // Arcの向きを保つため normal は det(A) を掛ける。
  const determinant = sign === 1 ? -1 : 1;
  return {
    x: mapped.x * determinant,
    y: mapped.y * determinant,
    z: mapped.z * determinant,
  };
}

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    reason,
    localPaths: [],
    envelope: null,
    existingBounds: null,
    deficiency: null,
    candidate: null,
    plannedCandidate: null,
    recheck: null,
    ...extra,
  };
}

export function worldRebarPathToBeamAccommodationLocal({
  rebarPath,
  supportPlacement,
  supportEndpoint,
} = {}) {
  const validation = validateRebarPath(rebarPath);
  if (!validation.ok) {
    return { resolved: false, reason: 'beam-accommodation-world-path-invalid', path: null };
  }
  if (
    rebarPath?.metadata?.coordinateSpace !== 'world' ||
    rebarPath?.metadata?.generationStatus !== 'CENTERLINE_READY' ||
    !rebarPath?.metadata?.identityKey ||
    !rebarPath?.metadata?.grade ||
    !(Number(rebarPath?.metadata?.dia) > 0)
  ) {
    return {
      resolved: false,
      reason: 'beam-accommodation-production-world-path-required',
      path: null,
    };
  }
  if (!['start', 'end'].includes(supportEndpoint) || !(Number(supportPlacement?.length) > 0)) {
    return { resolved: false, reason: 'beam-accommodation-support-placement-invalid', path: null };
  }

  const primitives = [];
  for (const primitive of rebarPath.primitives) {
    if (primitive.type === 'line') {
      const start = accommodationPoint(primitive.start, supportPlacement, supportEndpoint);
      const end = accommodationPoint(primitive.end, supportPlacement, supportEndpoint);
      if (!start || !end) {
        return { resolved: false, reason: 'beam-accommodation-line-transform-failed', path: null };
      }
      primitives.push(createLine(start, end));
      continue;
    }
    if (primitive.type === 'arc') {
      const center = accommodationPoint(primitive.center, supportPlacement, supportEndpoint);
      const startDirection = accommodationVector(
        primitive.startDirection,
        supportPlacement,
        supportEndpoint,
      );
      const planeNormal = accommodationVector(
        primitive.planeNormal,
        supportPlacement,
        supportEndpoint,
        true,
      );
      if (!center || !startDirection || !planeNormal) {
        return { resolved: false, reason: 'beam-accommodation-arc-transform-failed', path: null };
      }
      primitives.push(
        createArc({
          center,
          radius: primitive.radius,
          planeNormal,
          startDirection,
          sweepAngleRad: primitive.sweepAngleRad,
        }),
      );
      continue;
    }
    return { resolved: false, reason: 'beam-accommodation-primitive-unsupported', path: null };
  }

  const path = createRebarPath(primitives, {
    ...rebarPath.metadata,
    coordinateSpace: 'beam-accommodation-local',
    accommodationAxes: 'RIGHT_TOP_STATION',
    accommodationSupportEndpoint: supportEndpoint,
  });
  const localValidation = validateRebarPath(path);
  return localValidation.ok
    ? { resolved: true, reason: null, path }
    : {
        resolved: false,
        reason: 'beam-accommodation-local-path-invalid',
        path: null,
        validation: localValidation,
      };
}

export function resolveBeamExistingConcreteBounds({
  supportMember,
  supportWidthMm,
  supportDepthMm,
  supportLengthMm,
} = {}) {
  const width = Number(supportWidthMm);
  const depth = Number(supportDepthMm);
  const length = Number(supportLengthMm);
  if (!(width > 0) || !(depth > 0) || !(length > 0)) return null;

  const top = nonNegativeMemberValue(supportMember, 'thickness_add_top');
  const bottom = nonNegativeMemberValue(supportMember, 'thickness_add_bottom');
  const right = nonNegativeMemberValue(supportMember, 'thickness_add_right');
  const left = nonNegativeMemberValue(supportMember, 'thickness_add_left');
  if ([top, bottom, right, left].some((value) => value === null)) return null;

  return {
    min: { x: -width / 2 - left, y: -depth / 2 - bottom, z: 0 },
    max: { x: width / 2 + right, y: depth / 2 + top, z: length },
  };
}

function unionBounds(boundsList, key) {
  const items = boundsList.map((item) => item?.[key]).filter(Boolean);
  if (items.length === 0) return null;
  return {
    min: {
      x: Math.min(...items.map((bounds) => bounds.min.x)),
      y: Math.min(...items.map((bounds) => bounds.min.y)),
      z: Math.min(...items.map((bounds) => bounds.min.z)),
    },
    max: {
      x: Math.max(...items.map((bounds) => bounds.max.x)),
      y: Math.max(...items.map((bounds) => bounds.max.y)),
      z: Math.max(...items.map((bounds) => bounds.max.z)),
    },
  };
}

function clipRequiredBoundsToSupportJoint(bounds) {
  if (!bounds) return null;
  return {
    min: { ...bounds.min, z: Math.max(0, Number(bounds.min.z)) },
    max: { ...bounds.max },
  };
}

function classifyDeficiency(requiredBounds, existingBounds) {
  let deficiency = evaluateConcreteDeficiency({
    requiredBounds,
    existingBounds,
    sourceType: 'REBAR_ENVELOPE',
  });
  const axialOnly =
    deficiency.missingFaces?.length > 0 &&
    deficiency.missingFaces.every((face) => face === 'START' || face === 'END');
  if (axialOnly) {
    deficiency = evaluateConcreteDeficiency({
      requiredBounds,
      existingBounds,
      sourceType: 'REBAR_ANCHORAGE',
    });
  }
  return deficiency;
}

function attrNumber(element, name) {
  const raw = element?.getAttribute?.(name);
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function elementById(xmlDoc, tagName, id) {
  const wanted = String(id ?? '');
  for (const element of parseElements(xmlDoc, tagName)) {
    if (String(element.getAttribute?.('id') ?? '') === wanted) return element;
  }
  return null;
}

/**
 * ST-Bridge 2.1 StbPenetrationArrangement の Lh/e と StbSecPenetration_S.phi を
 * beam-accommodation-local の station/Y円へ変換する。
 */
export function resolveBeamPenetrationDisks({
  xmlDoc,
  supportMember,
  supportEndpoint,
  supportDepthMm,
  supportLengthMm,
} = {}) {
  if (!xmlDoc) {
    return {
      resolved: false,
      reason: 'beam-accommodation-penetration-document-unresolved',
      penetrations: [],
    };
  }
  const memberId = String(supportMember?.id ?? '');
  const length = Number(supportLengthMm);
  const depth = Number(supportDepthMm);
  if (!memberId || !(length > 0) || !(depth > 0) || !['start', 'end'].includes(supportEndpoint)) {
    return {
      resolved: false,
      reason: 'beam-accommodation-penetration-host-invalid',
      penetrations: [],
    };
  }

  const penetrations = [];
  for (const arrangement of Array.from(parseElements(xmlDoc, 'StbPenetrationArrangement'))) {
    const kind = String(arrangement.getAttribute?.('kind_member') || 'GIRDER').toUpperCase();
    if (kind !== 'BEAM' || String(arrangement.getAttribute?.('id_member') || '') !== memberId) {
      continue;
    }
    const sectionId = arrangement.getAttribute?.('id_section');
    const section = elementById(xmlDoc, 'StbSecPenetration_S', sectionId);
    const phi = attrNumber(section, 'phi');
    const lh = attrNumber(arrangement, 'Lh');
    const e = attrNumber(arrangement, 'e');
    if (!(phi > 0) || lh === null || e === null) {
      return {
        resolved: false,
        reason: 'beam-accommodation-penetration-geometry-unresolved',
        penetrations,
        arrangementId: arrangement.getAttribute?.('id') || null,
      };
    }
    const stationMm = supportEndpoint === 'start' ? lh : length - lh;
    if (!Number.isFinite(stationMm)) {
      return {
        resolved: false,
        reason: 'beam-accommodation-penetration-station-unresolved',
        penetrations,
      };
    }
    penetrations.push({
      arrangementId: arrangement.getAttribute?.('id') || null,
      sectionId: sectionId == null ? null : String(sectionId),
      stationMm,
      centerYmm: depth / 2 - e,
      radiusMm: phi / 2,
      phiMm: phi,
      source: 'StbPenetrationArrangement',
    });
  }
  return { resolved: true, reason: null, penetrations };
}

/**
 * 同じ支持梁へ入るR12-AO world pathsをまとめて1つのふかし候補へ評価する。
 * top/bottom各identityが同じ局所領域を要求してもcandidate idを重複させない。
 */
export function evaluateBeamConcreteAccommodation({
  worldPaths,
  supportMember,
  supportPlacement,
  supportEndpoint,
  supportWidthMm,
  supportDepthMm,
  requiredCoverMm,
  rule,
  sourceRuleId = 'R12-AO',
  xmlDoc = null,
  existingRebarPaths = [],
  existingRebarGeometryResolved = true,
  memberConcreteObstacles = [],
} = {}) {
  const paths = Array.isArray(worldPaths) ? worldPaths : [];
  if (paths.length === 0) return unresolved('beam-accommodation-world-path-missing');
  if (!rule?.enabled) {
    return {
      ...unresolved('CONCRETE_ACCOMMODATION_DISABLED'),
      resolved: true,
    };
  }

  const localPaths = [];
  const envelopes = [];
  for (const worldPath of paths) {
    if (
      String(worldPath?.metadata?.supportMemberId || '') !== String(supportMember?.id || '') ||
      worldPath?.metadata?.supportMemberTag !== 'StbBeam'
    ) {
      return unresolved('beam-accommodation-support-identity-mismatch');
    }
    const transformed = worldRebarPathToBeamAccommodationLocal({
      rebarPath: worldPath,
      supportPlacement,
      supportEndpoint,
    });
    if (!transformed.resolved) return unresolved(transformed.reason);

    const envelope = buildRequiredConcreteEnvelope({
      rebarPath: transformed.path,
      barDiameterMm: transformed.path.metadata.dia,
      requiredCoverMm,
      requireProductionReady: false,
    });
    if (!envelope.resolved)
      return unresolved(envelope.reason || 'beam-accommodation-envelope-failed');
    localPaths.push(transformed.path);
    envelopes.push(envelope);
  }

  const existingBounds = resolveBeamExistingConcreteBounds({
    supportMember,
    supportWidthMm,
    supportDepthMm,
    supportLengthMm: supportPlacement?.length,
  });
  if (!existingBounds) return unresolved('beam-accommodation-existing-concrete-unresolved');

  const requiredBounds = clipRequiredBoundsToSupportJoint(unionBounds(envelopes, 'requiredBounds'));
  const centerlineBounds = clipRequiredBoundsToSupportJoint(
    unionBounds(envelopes, 'centerlineBounds'),
  );
  const barBounds = clipRequiredBoundsToSupportJoint(unionBounds(envelopes, 'barBounds'));
  if (!requiredBounds || requiredBounds.max.z < -EPS) {
    return unresolved('beam-accommodation-support-overlap-missing');
  }

  const rebarCollision = evaluateRebarPathCollision({
    sourcePaths: paths,
    existingPaths: existingRebarPaths,
  });
  const deficiency = rebarCollision.collision
    ? evaluateConcreteDeficiency({
        requiredBounds,
        existingBounds,
        sourceType: 'REBAR_ENVELOPE',
        rebarCollision: true,
      })
    : classifyDeficiency(requiredBounds, existingBounds);
  const stationStartMm = Math.max(0, requiredBounds.min.z);
  const stationEndMm = Math.min(existingBounds.max.z, requiredBounds.max.z);
  const sourceIdentityKeys = [
    ...new Set(paths.map((path) => String(path.metadata.identityKey)).filter(Boolean)),
  ];
  const diagnosticId = [
    'CONCRETE_ACCOMMODATION',
    sourceRuleId || 'UNKNOWN',
    'StbBeam',
    String(supportMember?.id ?? '?'),
    [...sourceIdentityKeys].sort().join('|') || 'UNRESOLVED',
  ].join(':');
  const sourceType =
    deficiency.reason === 'ANCHORAGE_CONCRETE_MISSING'
      ? 'REBAR_ANCHORAGE'
      : deficiency.reason === 'BEND_CONCRETE_MISSING'
        ? 'REBAR_BEND'
        : 'REBAR_ENVELOPE';

  const planned =
    rebarCollision.collision !== true &&
    existingRebarGeometryResolved === false &&
    deficiency.satisfied !== true
      ? {
          automaticCandidate: false,
          candidate: null,
          reason: 'SPECIAL_DETAIL_REQUIRED',
          collisionGeometryUnresolved: true,
        }
      : planFukashiCandidate({
          deficiency,
          rule,
          hostMemberTag: 'StbBeam',
          hostMemberId: supportMember?.id,
          sourceType,
          sourceRuleId,
          sourceIdentityKeys,
          fullLength:
            stationStartMm <= EPS && stationEndMm >= Number(supportPlacement?.length) - EPS,
          stationStartMm,
          stationEndMm,
        });

  let recheck = null;
  let candidate = null;
  let candidateSolid = null;
  let candidateWorldObb = null;
  let memberCollision = null;
  let openingConflict = null;
  let penetrationResolution = { resolved: true, reason: null, penetrations: [] };
  if (planned.automaticCandidate && planned.candidate) {
    const builtSolid = buildFukashiCandidateSolid({
      candidate: planned.candidate,
      existingBounds,
    });
    candidateSolid = builtSolid.solid;
    candidateWorldObb = candidateSolid
      ? buildCandidateWorldObb({
          candidateSolid,
          supportPlacement,
          supportEndpoint,
        })
      : null;
    if (!candidateWorldObb) {
      recheck = {
        status: 'ROLLBACK',
        acceptable: false,
        reason: 'member-collision-candidate-obb-unresolved',
        solid: candidateSolid,
      };
    } else {
      memberCollision = findCandidateMemberCollision(candidateWorldObb, memberConcreteObstacles);
      if (memberCollision) {
        recheck = recheckFukashiCandidateSolid({
          candidate: planned.candidate,
          requiredBounds,
          existingBounds,
          memberCollision: true,
        });
      } else {
        penetrationResolution = resolveBeamPenetrationDisks({
          xmlDoc,
          supportMember,
          supportEndpoint,
          supportDepthMm,
          supportLengthMm: supportPlacement?.length,
        });
        if (!penetrationResolution.resolved) {
          recheck = {
            status: 'ROLLBACK',
            acceptable: false,
            reason: penetrationResolution.reason || 'SPECIAL_DETAIL_REQUIRED',
            solid: candidateSolid,
          };
        } else {
          openingConflict = findCandidatePenetrationConflict(
            candidateSolid,
            penetrationResolution.penetrations,
          );
          recheck = recheckFukashiCandidateSolid({
            candidate: planned.candidate,
            requiredBounds,
            existingBounds,
            openingConflict: Boolean(openingConflict),
          });
          candidateSolid = recheck.solid || candidateSolid;
        }
      }
    }
    if (recheck?.acceptable) candidate = planned.candidate;
  }

  const stbExportCandidate = candidate
    ? buildStbThicknessAddExportCandidate({
        candidate,
        supportMember,
        supportMemberTag: 'StbBeam',
        supportLengthMm: supportPlacement?.length,
      })
    : null;

  return {
    resolved: true,
    reason: candidate ? deficiency.reason : recheck?.reason || planned.reason,
    diagnosticId,
    hostMemberTag: 'StbBeam',
    hostMemberId: supportMember?.id == null ? null : String(supportMember.id),
    sourceRuleId,
    sourceIdentityKeys,
    planningReason: planned.reason || null,
    collisionGeometryUnresolved: planned.collisionGeometryUnresolved === true,
    localPaths,
    envelope: {
      centerlineBounds,
      barBounds,
      requiredBounds,
      sourceIdentityKeys,
    },
    existingBounds,
    deficiency,
    plannedCandidate: planned.candidate,
    candidate,
    candidateSolid,
    candidateWorldObb,
    recheck,
    penetrationResolution,
    openingConflict,
    memberCollision,
    rebarCollision,
    stbExportCandidate,
    stationStartMm,
    stationEndMm,
    supportPlacement,
    supportEndpoint,
    memberConcreteObstacles,
    existingRebarGeometryResolved,
    jointNegativeStationDelegatedToAdjacentMember: true,
  };
}

export const _beamConcreteAccommodationInternals = Object.freeze({
  accommodationPoint,
  accommodationVector,
  unionBounds,
  clipRequiredBoundsToSupportJoint,
  elementById,
});
