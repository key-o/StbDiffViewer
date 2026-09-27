/**
 * @fileoverview 配筋指針2010 付録A A2 隅柱接合部 U字形定着の明示pairing契約。
 *
 * 付録A2本文は「抱え込み定着またはU字形定着」を基本候補とするが、
 * individual bar の top/bottom pairing とU字形の投影位置・折曲げ内法寸法までは
 * STBから一意に解けない。本モジュールは、それらを推定せず projectDetailing の
 * EXPLICIT assignment が与えられた場合にだけ anchor-local RebarPath を生成する。
 */

import { getRebarProjectDetailing } from '../../../config/rebarProjectDetailing.js';
import {
  createArc,
  createLine,
  createRebarPath,
  getPathEnd,
  getPathStart,
  validateRebarPath,
} from './rebarPath.js';
import { rebarRuleTraceMetadata } from './rebarDetailingRuleRegistry.js';

export const APPENDIX_A2_U_SHAPE_DETAILING_TYPE = 'APPENDIX_A2_CORNER_U_SHAPE_PAIRING';

const EPS = 1e-8;
const POSITION_TOLERANCE_MM = 1e-5;
const A2_ANCHORAGE_RULE = rebarRuleTraceMetadata('APPENDIX-A2-CORNER-JOINT-ANCHORAGE-METHOD');
const A2_U_SHAPE_PAIRING_RULE = rebarRuleTraceMetadata('APPENDIX-A2-U-SHAPE-EXPLICIT-PAIRING');

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

function nonBlank(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function gradeKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function closeEnough(left, right, tolerance = POSITION_TOLERANCE_MM) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    status: 'UNRESOLVED',
    productionReady: false,
    reason,
    assignment: null,
    paths: [],
    blockers: [reason],
    appliedRules: [A2_ANCHORAGE_RULE, A2_U_SHAPE_PAIRING_RULE],
    ...extra,
  };
}

function projectEntry(projectDetailing) {
  if (!isPlainObject(projectDetailing)) return null;
  if (Object.prototype.hasOwnProperty.call(projectDetailing, APPENDIX_A2_U_SHAPE_DETAILING_TYPE)) {
    return projectDetailing[APPENDIX_A2_U_SHAPE_DETAILING_TYPE];
  }
  if (
    isPlainObject(projectDetailing.special) &&
    Object.prototype.hasOwnProperty.call(
      projectDetailing.special,
      APPENDIX_A2_U_SHAPE_DETAILING_TYPE,
    )
  ) {
    return projectDetailing.special[APPENDIX_A2_U_SHAPE_DETAILING_TYPE];
  }
  return null;
}

function validatePair(pair, pairIndex) {
  if (!isPlainObject(pair)) {
    return { ok: false, reason: `appendix-a2-u-shape-pair-${pairIndex}-invalid` };
  }
  const topIdentityKey = nonBlank(pair.topIdentityKey);
  const bottomIdentityKey = nonBlank(pair.bottomIdentityKey);
  const projectionMm = positive(pair.projectionMm);
  const insideDiameterMm = positive(pair.insideDiameterMm);
  if (!topIdentityKey || !bottomIdentityKey) {
    return { ok: false, reason: `appendix-a2-u-shape-pair-${pairIndex}-identity-required` };
  }
  if (topIdentityKey === bottomIdentityKey) {
    return { ok: false, reason: `appendix-a2-u-shape-pair-${pairIndex}-identity-must-differ` };
  }
  if (projectionMm === null || pair.projectionVerified !== true) {
    return {
      ok: false,
      reason: `appendix-a2-u-shape-pair-${pairIndex}-verified-projection-required`,
    };
  }
  if (insideDiameterMm === null || pair.insideDiameterVerified !== true) {
    return {
      ok: false,
      reason: `appendix-a2-u-shape-pair-${pairIndex}-verified-inside-diameter-required`,
    };
  }
  return {
    ok: true,
    pair: {
      topIdentityKey,
      bottomIdentityKey,
      projectionMm,
      projectionVerified: true,
      insideDiameterMm,
      insideDiameterVerified: true,
      note: nonBlank(pair.note),
    },
  };
}

/**
 * projectDetailingから member/end 固有のU字pairing assignmentを解決する。
 *
 * 形式:
 * {
 *   APPENDIX_A2_CORNER_U_SHAPE_PAIRING: {
 *     productionEnabled: true,
 *     productionMode: 'EXPLICIT',
 *     assignments: [{
 *       memberId: '101',
 *       endpoint: 'start',
 *       pairs: [{
 *         topIdentityKey: '...',
 *         bottomIdentityKey: '...',
 *         projectionMm: 300,
 *         projectionVerified: true,
 *         insideDiameterMm: 125,
 *         insideDiameterVerified: true
 *       }]
 *     }]
 *   }
 * }
 */
export function resolveAppendixA2UShapePairingAssignment({
  memberId,
  endpoint,
  projectDetailing,
} = {}) {
  const source = projectDetailing === undefined ? getRebarProjectDetailing() : projectDetailing;
  const entry = projectEntry(source);
  if (entry === null || entry === undefined) {
    return unresolved('appendix-a2-u-shape-explicit-pairing-required');
  }
  if (!isPlainObject(entry)) {
    return unresolved('appendix-a2-u-shape-project-detailing-entry-invalid');
  }
  if (entry.productionEnabled !== true) {
    return unresolved('appendix-a2-u-shape-production-not-enabled');
  }
  if (entry.productionMode !== 'EXPLICIT') {
    return unresolved('appendix-a2-u-shape-explicit-production-mode-required');
  }
  if (!Array.isArray(entry.assignments)) {
    return unresolved('appendix-a2-u-shape-assignments-required');
  }
  if (!['start', 'end'].includes(endpoint) || !nonBlank(String(memberId || ''))) {
    return unresolved('appendix-a2-u-shape-member-end-invalid');
  }

  const matches = entry.assignments.filter(
    (assignment) =>
      isPlainObject(assignment) &&
      String(assignment.memberId) === String(memberId) &&
      assignment.endpoint === endpoint,
  );
  if (matches.length !== 1) {
    return unresolved(
      matches.length === 0
        ? 'appendix-a2-u-shape-member-end-assignment-missing'
        : 'appendix-a2-u-shape-member-end-assignment-ambiguous',
      { assignmentCount: matches.length },
    );
  }

  const assignment = matches[0];
  if (!Array.isArray(assignment.pairs) || assignment.pairs.length === 0) {
    return unresolved('appendix-a2-u-shape-pairs-required');
  }

  const pairs = [];
  const seen = new Set();
  for (const [index, rawPair] of assignment.pairs.entries()) {
    const checked = validatePair(rawPair, index);
    if (!checked.ok) return unresolved(checked.reason);
    for (const identityKey of [checked.pair.topIdentityKey, checked.pair.bottomIdentityKey]) {
      if (seen.has(identityKey)) {
        return unresolved('appendix-a2-u-shape-identity-reused', { identityKey });
      }
      seen.add(identityKey);
    }
    pairs.push(checked.pair);
  }

  return {
    resolved: true,
    status: 'PAIRING_READY',
    productionReady: true,
    reason: null,
    source: 'project-detailing',
    assignment: {
      memberId: String(memberId),
      endpoint,
      pairs,
    },
    blockers: [],
    appliedRules: [A2_ANCHORAGE_RULE, A2_U_SHAPE_PAIRING_RULE],
  };
}

function endpointOf(path, endpoint) {
  return endpoint === 'start' ? getPathStart(path) : getPathEnd(path);
}

function findIdentityPath(memberPaths, identityKey, role, endpoint, memberLengthMm) {
  const endpointZ = endpoint === 'start' ? -memberLengthMm / 2 : memberLengthMm / 2;
  const candidates = (memberPaths || []).filter((path) => {
    if (
      path?.metadata?.coordinateSpace !== 'member-local' ||
      path.metadata.identityKey !== identityKey ||
      path.metadata.role !== role ||
      !validateRebarPath(path).ok
    ) {
      return false;
    }
    return closeEnough(endpointOf(path, endpoint)?.z, endpointZ);
  });
  return candidates.length === 1
    ? { ok: true, path: candidates[0] }
    : {
        ok: false,
        reason:
          candidates.length === 0
            ? 'appendix-a2-u-shape-identity-path-missing'
            : 'appendix-a2-u-shape-identity-path-ambiguous',
        candidateCount: candidates.length,
      };
}

function quarterArc({ sharpCorner, incomingDirection, outgoingDirection, radius }) {
  const incomingTangent = {
    x: sharpCorner.x - incomingDirection.x * radius,
    y: sharpCorner.y - incomingDirection.y * radius,
    z: sharpCorner.z - incomingDirection.z * radius,
  };
  const outgoingTangent = {
    x: sharpCorner.x + outgoingDirection.x * radius,
    y: sharpCorner.y + outgoingDirection.y * radius,
    z: sharpCorner.z + outgoingDirection.z * radius,
  };
  const center = {
    x: incomingTangent.x + outgoingDirection.x * radius,
    y: incomingTangent.y + outgoingDirection.y * radius,
    z: incomingTangent.z + outgoingDirection.z * radius,
  };
  const startDirection = {
    x: incomingTangent.x - center.x,
    y: incomingTangent.y - center.y,
    z: incomingTangent.z - center.z,
  };
  const startLength = Math.hypot(startDirection.x, startDirection.y, startDirection.z);
  const normalizedStart = {
    x: startDirection.x / startLength,
    y: startDirection.y / startLength,
    z: startDirection.z / startLength,
  };
  const planeNormal = {
    x: incomingDirection.y * outgoingDirection.z - incomingDirection.z * outgoingDirection.y,
    y: incomingDirection.z * outgoingDirection.x - incomingDirection.x * outgoingDirection.z,
    z: incomingDirection.x * outgoingDirection.y - incomingDirection.y * outgoingDirection.x,
  };
  const arc = createArc({
    center,
    radius,
    planeNormal,
    startDirection: normalizedStart,
    sweepAngleRad: Math.PI / 2,
  });
  return { incomingTangent, outgoingTangent, arc };
}

function buildPairPath({
  topPath,
  bottomPath,
  endpoint,
  projectionMm,
  insideDiameterMm,
  memberId,
  pair,
}) {
  const top = endpointOf(topPath, endpoint);
  const bottom = endpointOf(bottomPath, endpoint);
  const dia = positive(topPath?.metadata?.dia);
  const bottomDia = positive(bottomPath?.metadata?.dia);
  if (!top || !bottom || dia === null || bottomDia === null || !closeEnough(dia, bottomDia)) {
    return { ok: false, reason: 'appendix-a2-u-shape-pair-diameter-mismatch' };
  }
  if (gradeKey(topPath?.metadata?.grade) !== gradeKey(bottomPath?.metadata?.grade)) {
    return { ok: false, reason: 'appendix-a2-u-shape-pair-grade-mismatch' };
  }
  if (!closeEnough(top.x, bottom.x)) {
    return { ok: false, reason: 'appendix-a2-u-shape-pair-u-mismatch' };
  }
  if (!(Number(top.y) > Number(bottom.y) + POSITION_TOLERANCE_MM)) {
    return { ok: false, reason: 'appendix-a2-u-shape-top-bottom-order-invalid' };
  }

  const radius = (insideDiameterMm + dia) / 2;
  if (!(projectionMm > radius + EPS)) {
    return {
      ok: false,
      reason: 'appendix-a2-u-shape-projection-too-short-for-bend-radius',
      centerlineRadiusMm: radius,
    };
  }
  const verticalDistanceMm = Number(top.y) - Number(bottom.y);
  if (!(verticalDistanceMm > 2 * radius + EPS)) {
    return {
      ok: false,
      reason: 'appendix-a2-u-shape-vertical-clearance-too-small',
      centerlineRadiusMm: radius,
      verticalDistanceMm,
    };
  }

  const u = Number(top.x);
  const farZ = -projectionMm;
  const topLocal = { x: u, y: Number(top.y), z: 0 };
  const bottomLocal = { x: u, y: Number(bottom.y), z: 0 };
  const down = { x: 0, y: -1, z: 0 };
  const intoSupport = { x: 0, y: 0, z: -1 };
  const towardMember = { x: 0, y: 0, z: 1 };
  const topCorner = { x: u, y: topLocal.y, z: farZ };
  const bottomCorner = { x: u, y: bottomLocal.y, z: farZ };
  const first = quarterArc({
    sharpCorner: topCorner,
    incomingDirection: intoSupport,
    outgoingDirection: down,
    radius,
  });
  const second = quarterArc({
    sharpCorner: bottomCorner,
    incomingDirection: down,
    outgoingDirection: towardMember,
    radius,
  });

  const primitives = [
    createLine(topLocal, first.incomingTangent),
    first.arc,
    createLine(first.outgoingTangent, second.incomingTangent),
    second.arc,
    createLine(second.outgoingTangent, bottomLocal),
  ];
  const path = createRebarPath(primitives, {
    memberId: String(memberId),
    memberTag: 'StbGirder',
    endpoint,
    coordinateSpace: 'anchor-local',
    source: 'PROJECT_EXPLICIT + RC_DETAILING_GUIDE_2010_APPENDIX_A2',
    ruleId: 'APPENDIX-A2-CORNER-JOINT-ANCHORAGE-METHOD',
    anchorageMethod: 'U_SHAPE_ANCHORAGE',
    productionMode: 'EXPLICIT',
    productionPathCandidate: true,
    productionConsumer: 'appendix-a2-u-shape-anchor-local-path',
    generationStatus: 'CENTERLINE_READY',
    dia,
    diaName: topPath.metadata?.diaName || null,
    grade: topPath.metadata?.grade || null,
    topIdentityKey: pair.topIdentityKey,
    bottomIdentityKey: pair.bottomIdentityKey,
    projectionMm,
    insideDiameterMm,
    insideDiameterVerified: true,
    centerlineRadiusMm: radius,
    bendCount: 2,
    bendAngleDeg: 90,
  });
  const validation = validateRebarPath(path);
  if (!validation.ok) {
    return {
      ok: false,
      reason: 'appendix-a2-u-shape-generated-path-invalid',
      validation,
    };
  }
  return { ok: true, path, validation };
}

/**
 * explicit pairing assignmentとmember-local main-bar pathからU字形定着pathを生成する。
 */
export function buildAppendixA2UShapeAnchorPaths({
  memberId,
  endpoint,
  memberPaths,
  memberLengthMm,
  projectDetailing,
} = {}) {
  if (!(Number(memberLengthMm) > 0)) {
    return unresolved('appendix-a2-u-shape-member-length-invalid');
  }
  const pairing = resolveAppendixA2UShapePairingAssignment({
    memberId,
    endpoint,
    projectDetailing,
  });
  if (!pairing.resolved) return pairing;

  const paths = [];
  const failedPairs = [];
  for (const pair of pairing.assignment.pairs) {
    const top = findIdentityPath(
      memberPaths,
      pair.topIdentityKey,
      'top',
      endpoint,
      Number(memberLengthMm),
    );
    const bottom = findIdentityPath(
      memberPaths,
      pair.bottomIdentityKey,
      'bottom',
      endpoint,
      Number(memberLengthMm),
    );
    if (!top.ok || !bottom.ok) {
      failedPairs.push({
        pair,
        reason: top.reason || bottom.reason,
        topCandidateCount: top.candidateCount ?? null,
        bottomCandidateCount: bottom.candidateCount ?? null,
      });
      continue;
    }
    const built = buildPairPath({
      topPath: top.path,
      bottomPath: bottom.path,
      endpoint,
      projectionMm: pair.projectionMm,
      insideDiameterMm: pair.insideDiameterMm,
      memberId,
      pair,
    });
    if (!built.ok) {
      failedPairs.push({ pair, reason: built.reason });
      continue;
    }
    paths.push(built.path);
  }

  if (failedPairs.length > 0 || paths.length !== pairing.assignment.pairs.length) {
    return unresolved(failedPairs[0]?.reason || 'appendix-a2-u-shape-pair-path-unresolved', {
      assignment: pairing.assignment,
      failedPairs,
      generatedPathCount: paths.length,
    });
  }

  return {
    resolved: true,
    status: 'CENTERLINE_READY',
    productionReady: true,
    reason: null,
    source: 'project-detailing',
    assignment: pairing.assignment,
    paths,
    blockers: [],
    failedPairs: [],
    appliedRules: [A2_ANCHORAGE_RULE, A2_U_SHAPE_PAIRING_RULE],
  };
}
