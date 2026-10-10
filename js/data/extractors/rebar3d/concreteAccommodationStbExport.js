/**
 * @fileoverview accepted FukashiCandidateをST-Bridge標準のthickness_add_*へ写像できるか判定する。
 *
 * LOCAL_PRISMは局所station情報を失うため標準属性へは還元しない。
 * このmoduleはexport patch候補を返すだけでSTB Documentを変更しない。
 */

const FACE_ATTRIBUTE = Object.freeze({
  TOP: 'thickness_add_top',
  BOTTOM: 'thickness_add_bottom',
  RIGHT: 'thickness_add_right',
  LEFT: 'thickness_add_left',
});

function memberValue(member, key) {
  const raw = member?.[key];
  if (raw === undefined || raw === null || raw === '') return 0;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function buildStbThicknessAddExportCandidate({
  candidate,
  supportMember,
  supportMemberTag = 'StbBeam',
  supportLengthMm = null,
} = {}) {
  if (!candidate) {
    return { resolved: false, exportable: false, reason: 'fukashi-export-candidate-missing' };
  }
  if (!['StbBeam', 'StbGirder'].includes(supportMemberTag)) {
    return {
      resolved: true,
      exportable: false,
      reason: 'fukashi-export-host-tag-unsupported',
      candidate,
    };
  }
  if (candidate.mode !== 'FACE_OFFSET') {
    return {
      resolved: true,
      exportable: false,
      reason: 'LOCAL_FUKASHI_NOT_STB_STANDARD_ATTRIBUTE',
      candidate,
    };
  }

  const attribute = FACE_ATTRIBUTE[candidate.face];
  if (!attribute) {
    return {
      resolved: true,
      exportable: false,
      reason: 'fukashi-export-face-unsupported',
      candidate,
    };
  }
  const existingMm = memberValue(supportMember, attribute);
  const incrementMm = Number(candidate.proposedThicknessMm);
  if (existingMm === null || !(incrementMm > 0)) {
    return {
      resolved: false,
      exportable: false,
      reason: 'fukashi-export-thickness-invalid',
      candidate,
    };
  }

  const length = Number(supportLengthMm);
  const start = Number(candidate.stationStartMm);
  const end = Number(candidate.stationEndMm);
  if (
    Number.isFinite(length) &&
    length > 0 &&
    (!Number.isFinite(start) ||
      !Number.isFinite(end) ||
      Math.abs(start) > 1e-6 ||
      Math.abs(end - length) > 1e-6)
  ) {
    return {
      resolved: true,
      exportable: false,
      reason: 'fukashi-export-face-offset-not-full-length',
      candidate,
    };
  }

  return {
    resolved: true,
    exportable: true,
    reason: null,
    hostMemberTag: supportMemberTag,
    hostMemberId:
      supportMember?.id == null ? candidate.hostMemberId || null : String(supportMember.id),
    attribute,
    existingMm,
    incrementMm,
    valueMm: existingMm + incrementMm,
    candidateId: candidate.id || null,
    approvalRequired: candidate.requireApproval !== false,
    status: 'EXPORT_CANDIDATE',
  };
}

export const CONCRETE_ACCOMMODATION_STB_FACE_ATTRIBUTE = FACE_ATTRIBUTE;
