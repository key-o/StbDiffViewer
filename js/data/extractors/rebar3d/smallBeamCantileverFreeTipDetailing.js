/**
 * @fileoverview R12-AE 片持ち小梁自由端「100程度」をexact productionへ昇格する明示detail契約。
 *
 * 日建連・JSCA 2023 図9-3(3)の100程度は、自由端面から折曲げ位置までの材軸方向
 * 近似寸法であり、そのままexact geometryとして採用しない。projectDetailingで
 * member/end、対象identity、折曲げ位置、鉛直余長が明示・確認された場合だけproduction候補とする。
 */

import { getRebarProjectDetailing } from '../../../config/rebarProjectDetailing.js';

const SMALL_BEAM_CANTILEVER_FREE_TIP_DETAILING_TYPE = 'SMALL_BEAM_CANTILEVER_FREE_TIP';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonBlank(value) {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
}

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    productionReady: false,
    status: 'UNRESOLVED',
    reason,
    source: null,
    assignment: null,
    blockers: [reason],
    ...extra,
  };
}

function projectEntry(projectDetailing) {
  if (!isPlainObject(projectDetailing)) return null;
  if (
    Object.prototype.hasOwnProperty.call(
      projectDetailing,
      SMALL_BEAM_CANTILEVER_FREE_TIP_DETAILING_TYPE,
    )
  ) {
    return projectDetailing[SMALL_BEAM_CANTILEVER_FREE_TIP_DETAILING_TYPE];
  }
  if (
    isPlainObject(projectDetailing.special) &&
    Object.prototype.hasOwnProperty.call(
      projectDetailing.special,
      SMALL_BEAM_CANTILEVER_FREE_TIP_DETAILING_TYPE,
    )
  ) {
    return projectDetailing.special[SMALL_BEAM_CANTILEVER_FREE_TIP_DETAILING_TYPE];
  }
  return null;
}

function identityKeys(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const keys = value.map(nonBlank);
  if (keys.some((key) => !key)) return null;
  if (new Set(keys).size !== keys.length) return null;
  return keys;
}

export function resolveSmallBeamCantileverFreeTipDetailing({
  memberId,
  endpoint,
  projectDetailing,
} = {}) {
  const id = nonBlank(memberId);
  if (!id || !['start', 'end'].includes(endpoint)) {
    return unresolved('small-beam-cantilever-free-tip-member-end-invalid');
  }

  const source = projectDetailing === undefined ? getRebarProjectDetailing() : projectDetailing;
  const entry = projectEntry(source);
  if (entry === null || entry === undefined) {
    return unresolved('small-beam-cantilever-free-tip-explicit-detail-required', {
      source: 'standard-approximate-only',
      approximateBendInsetMm: 100,
    });
  }
  if (!isPlainObject(entry)) {
    return unresolved('small-beam-cantilever-free-tip-project-detailing-entry-invalid');
  }
  if (entry.productionEnabled !== true) {
    return unresolved('small-beam-cantilever-free-tip-production-not-enabled');
  }
  if (entry.productionMode !== 'EXPLICIT') {
    return unresolved('small-beam-cantilever-free-tip-explicit-production-mode-required');
  }
  if (!Array.isArray(entry.assignments)) {
    return unresolved('small-beam-cantilever-free-tip-assignments-required');
  }

  const matches = entry.assignments.filter(
    (assignment) =>
      isPlainObject(assignment) &&
      String(assignment.memberId) === id &&
      assignment.endpoint === endpoint,
  );
  if (matches.length !== 1) {
    return unresolved(
      matches.length === 0
        ? 'small-beam-cantilever-free-tip-assignment-missing'
        : 'small-beam-cantilever-free-tip-assignment-ambiguous',
      { assignmentCount: matches.length },
    );
  }

  const assignment = matches[0];
  const bendInsetMm = positive(assignment.bendInsetMm);
  if (bendInsetMm === null || assignment.bendInsetVerified !== true) {
    return unresolved('small-beam-cantilever-free-tip-verified-bend-inset-required');
  }
  const tailLengthMm = positive(assignment.tailLengthMm);
  if (tailLengthMm === null || assignment.tailLengthVerified !== true) {
    return unresolved('small-beam-cantilever-free-tip-verified-tail-length-required');
  }
  const selectedIdentityKeys = identityKeys(assignment.identityKeys);
  if (!selectedIdentityKeys) {
    return unresolved('small-beam-cantilever-free-tip-identity-keys-required');
  }

  return {
    resolved: true,
    productionReady: true,
    status: 'EXPLICIT_DETAIL_READY',
    reason: null,
    source: 'project-detailing',
    standardApproximateBendInsetMm: 100,
    assignment: {
      memberId: id,
      endpoint,
      identityKeys: selectedIdentityKeys,
      bendInsetMm,
      bendInsetVerified: true,
      tailLengthMm,
      tailLengthVerified: true,
      bendAngleDeg: 90,
      bendDirection: 'DOWN',
      note: nonBlank(assignment.note),
    },
    blockers: [],
  };
}
