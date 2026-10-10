/**
 * @fileoverview ふかし候補のpreview-only承認/却下/手動調整runtime sidecar。
 *
 * STB/Working Documentは変更しない。candidateId + modelSourceをidentityとして、
 * regeneration後も同一候補へユーザー判断を再適用する。
 */

import {
  buildFukashiCandidateSolid,
  findCandidatePenetrationConflict,
  recheckFukashiCandidateSolid,
} from '../../data/extractors/rebar3d/fukashiCandidateSolid.js';
import {
  buildCandidateWorldObb,
  findCandidateMemberCollision,
} from '../../data/extractors/rebar3d/concreteMemberCollision.js';

const DECISION_STATUSES = new Set(['CANDIDATE', 'ACCEPTED', 'REJECTED', 'MANUAL']);
const decisions = new Map();
const evaluations = new Map();

function key(modelSource, candidateId) {
  return `${modelSource || '?'}:${candidateId || ''}`;
}

function candidateFrom(evaluation) {
  return evaluation?.plannedCandidate || evaluation?.candidate || null;
}

function evaluationIdentity(evaluation) {
  const candidate = candidateFrom(evaluation);
  if (candidate?.id) return String(candidate.id);
  const diagnosticId = String(evaluation?.diagnosticId || '').trim();
  return diagnosticId || null;
}

function dispatchChanged(detail = {}) {
  if (typeof document === 'undefined' || typeof document.dispatchEvent !== 'function') return;
  const EventCtor = document.defaultView?.CustomEvent || globalThis.CustomEvent;
  if (typeof EventCtor !== 'function') return;
  document.dispatchEvent(new EventCtor('concrete-accommodation-candidates-changed', { detail }));
}

export function beginConcreteAccommodationEvaluationCycle() {
  evaluations.clear();
  dispatchChanged({ type: 'cycle' });
}

export function getConcreteAccommodationEvaluations() {
  return [...evaluations.values()].map((entry) => ({ ...entry }));
}

export function getConcreteAccommodationDecision(modelSource, candidateId) {
  const value = decisions.get(key(modelSource, candidateId));
  return value ? { ...value, overrides: value.overrides ? { ...value.overrides } : null } : null;
}

export function setConcreteAccommodationDecision({
  modelSource,
  candidateId,
  status,
  overrides = null,
} = {}) {
  if (!candidateId || !DECISION_STATUSES.has(status)) {
    return { ok: false, reason: 'concrete-accommodation-decision-invalid' };
  }
  const value = {
    modelSource: modelSource || null,
    candidateId: String(candidateId),
    status,
    overrides: overrides && typeof overrides === 'object' ? { ...overrides } : null,
  };
  if (status === 'CANDIDATE') decisions.delete(key(modelSource, candidateId));
  else decisions.set(key(modelSource, candidateId), value);
  dispatchChanged({ type: 'decision', decision: value });
  return { ok: true, decision: value };
}

function manualCandidate(base, overrides = {}) {
  const thickness = Number(overrides.proposedThicknessMm);
  const stationStart = Number(overrides.stationStartMm);
  const stationEnd = Number(overrides.stationEndMm);
  if (
    !(thickness > 0) ||
    !Number.isFinite(stationStart) ||
    !Number.isFinite(stationEnd) ||
    !(stationEnd > stationStart)
  ) {
    return null;
  }
  return {
    ...base,
    proposedThicknessMm: thickness,
    stationStartMm: stationStart,
    stationEndMm: stationEnd,
    mode: 'LOCAL_PRISM',
    status: 'MANUAL',
    automatic: false,
  };
}

function resolveOverrideCandidateDecision(evaluation, base, decision, finalStatus) {
  const candidate = manualCandidate(base, decision.overrides || {});
  const prefix = finalStatus === 'ACCEPTED' ? 'ACCEPT' : 'MANUAL';
  if (!candidate) {
    return {
      ...evaluation,
      candidate: null,
      candidateSolid: null,
      stbExportCandidate: null,
      decision,
      decisionStatus: `${prefix}_INVALID`,
    };
  }
  const unresolvedCollisionReason =
    evaluation?.penetrationResolution?.resolved !== true
      ? evaluation?.penetrationResolution?.reason ||
        'beam-accommodation-penetration-geometry-unresolved'
      : evaluation?.existingRebarGeometryResolved !== true ||
          evaluation?.rebarCollision?.resolved !== true
        ? 'SPECIAL_DETAIL_REQUIRED'
        : null;
  if (unresolvedCollisionReason) {
    const recheck = {
      status: 'ROLLBACK',
      acceptable: false,
      reason: unresolvedCollisionReason,
      solid: null,
    };
    return {
      ...evaluation,
      candidate: null,
      candidateSolid: null,
      stbExportCandidate: null,
      recheck,
      decision,
      decisionStatus: `${prefix}_BLOCKED`,
    };
  }
  const built = buildFukashiCandidateSolid({
    candidate,
    existingBounds: evaluation.existingBounds,
  });
  const openingConflict = built.solid
    ? findCandidatePenetrationConflict(
        built.solid,
        evaluation.penetrationResolution?.penetrations || [],
      )
    : null;
  const candidateWorldObb = built.solid
    ? buildCandidateWorldObb({
        candidateSolid: built.solid,
        supportPlacement: evaluation.supportPlacement,
        supportEndpoint: evaluation.supportEndpoint,
      })
    : null;
  const memberCollision = candidateWorldObb
    ? findCandidateMemberCollision(candidateWorldObb, evaluation.memberConcreteObstacles || [])
    : null;
  const recheck = candidateWorldObb
    ? recheckFukashiCandidateSolid({
        candidate,
        requiredBounds: evaluation.envelope?.requiredBounds,
        existingBounds: evaluation.existingBounds,
        openingConflict: Boolean(openingConflict),
        rebarCollision: evaluation.rebarCollision?.collision === true,
        memberCollision: Boolean(memberCollision),
      })
    : {
        status: 'ROLLBACK',
        acceptable: false,
        reason: 'member-collision-candidate-obb-unresolved',
        solid: built.solid || null,
      };
  const resolvedCandidate = recheck.acceptable ? { ...candidate, status: finalStatus } : null;
  return {
    ...evaluation,
    candidate: resolvedCandidate,
    candidateSolid: recheck.solid || built.solid || null,
    // Manual edits are always LOCAL_PRISM; an automatic FACE_OFFSET patch is stale and unsafe.
    stbExportCandidate: null,
    candidateWorldObb,
    recheck,
    openingConflict,
    memberCollision,
    decision,
    decisionStatus: recheck.acceptable ? finalStatus : `${prefix}_BLOCKED`,
  };
}

export function resolveConcreteAccommodationDecision(evaluation, { modelSource = null } = {}) {
  const base = candidateFrom(evaluation);
  if (!base?.id) return { ...evaluation, decision: null };
  const decision = getConcreteAccommodationDecision(modelSource, base.id) || {
    modelSource,
    candidateId: base.id,
    status: 'CANDIDATE',
    overrides: null,
  };

  if (decision.status === 'REJECTED') {
    return {
      ...evaluation,
      candidate: null,
      candidateSolid: null,
      decision,
      decisionStatus: 'REJECTED',
    };
  }

  if (decision.status === 'ACCEPTED') {
    if (decision.overrides) {
      return resolveOverrideCandidateDecision(evaluation, base, decision, 'ACCEPTED');
    }
    if (!evaluation?.candidate || !evaluation?.recheck?.acceptable) {
      return {
        ...evaluation,
        candidate: null,
        candidateSolid: null,
        decision,
        decisionStatus: 'ACCEPT_BLOCKED',
      };
    }
    return {
      ...evaluation,
      candidate: { ...evaluation.candidate, status: 'ACCEPTED' },
      decision,
      decisionStatus: 'ACCEPTED',
    };
  }

  if (decision.status === 'MANUAL') {
    return resolveOverrideCandidateDecision(evaluation, base, decision, 'MANUAL');
  }

  return {
    ...evaluation,
    decision,
    decisionStatus: 'CANDIDATE',
  };
}

export function recordConcreteAccommodationEvaluation(evaluation, { modelSource = null } = {}) {
  const base = candidateFrom(evaluation);
  const evaluationId = evaluationIdentity(evaluation);
  if (!evaluationId) return false;
  if (
    !base?.id &&
    evaluation?.deficiency?.satisfied === true &&
    !evaluation?.reason &&
    !evaluation?.planningReason &&
    !evaluation?.recheck?.reason
  ) {
    return false;
  }

  const resolved = base?.id
    ? resolveConcreteAccommodationDecision(evaluation, { modelSource })
    : {
        ...evaluation,
        decision: null,
        decisionStatus: 'BLOCKED',
      };
  evaluations.set(key(modelSource, evaluationId), {
    modelSource,
    candidateId: base?.id ? String(base.id) : null,
    evaluationId,
    diagnostic: !base?.id,
    evaluation: resolved,
    decisionStatus: resolved.decisionStatus || (base?.id ? 'CANDIDATE' : 'BLOCKED'),
  });
  dispatchChanged({
    type: 'evaluation',
    modelSource,
    candidateId: base?.id ? String(base.id) : null,
    evaluationId,
  });
  return true;
}

export function clearConcreteAccommodationDecisions() {
  decisions.clear();
  dispatchChanged({ type: 'decisions-cleared' });
}

export const CONCRETE_ACCOMMODATION_DECISION_STATUSES = Object.freeze([...DECISION_STATUSES]);
