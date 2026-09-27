/**
 * @fileoverview Phase 6b-O5 aggregate actual-path contract validation.
 *
 * O4 project-target planだけをactual-path aggregateへ通し、opening/member/model/bar
 * scopeとexplicit target provenanceの不一致をfail-closedにする。
 */

import { SMALL_OPENING_REBAR_DEFLECTION_TARGET_SOURCE } from '../../../config/smallOpeningRebarDeflectionTargetProjectDetailing.js';
import { SMALL_OPENING_WALL_PROJECT_TARGET_PLAN_SOURCE } from './smallOpeningWallProjectTargetMutationPlan.js';

function text(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

export function validateSmallOpeningWallActualPathAggregatePlan(mutationPlan) {
  const openingId = text(mutationPlan?.openingId);
  const memberId = text(mutationPlan?.memberId);
  const modelSource = text(mutationPlan?.modelSource);
  const common = { openingId, memberId, modelSource };

  if (text(mutationPlan?.source) !== SMALL_OPENING_WALL_PROJECT_TARGET_PLAN_SOURCE) {
    return {
      ok: false,
      reason: 'small-opening-wall-actual-path-project-target-plan-source-mismatch',
      ...common,
    };
  }
  if (text(mutationPlan?.targetSourceRef) !== SMALL_OPENING_REBAR_DEFLECTION_TARGET_SOURCE) {
    return {
      ok: false,
      reason: 'small-opening-wall-actual-path-target-source-mismatch',
      ...common,
    };
  }

  const entries = Array.isArray(mutationPlan?.entries) ? mutationPlan.entries : [];
  const targets = Array.isArray(mutationPlan?.targets) ? mutationPlan.targets : [];
  const targetCount = Number(mutationPlan?.targetCount);
  if (
    !openingId ||
    !memberId ||
    !modelSource ||
    !Number.isInteger(targetCount) ||
    targetCount < 1 ||
    targetCount !== targets.length ||
    entries.length !== targets.length
  ) {
    return {
      ok: false,
      reason: 'small-opening-wall-actual-path-target-cardinality-mismatch',
      ...common,
    };
  }

  const targetIdentities = new Set();
  for (const target of targets) {
    const barIdentity = text(target?.barIdentity);
    if (
      text(target?.modelSource) !== modelSource ||
      text(target?.memberType) !== 'WALL' ||
      text(target?.memberId) !== memberId ||
      text(target?.openingId) !== openingId ||
      !barIdentity ||
      targetIdentities.has(barIdentity)
    ) {
      return {
        ok: false,
        reason: 'small-opening-wall-actual-path-target-scope-mismatch',
        ...common,
      };
    }
    targetIdentities.add(barIdentity);
  }

  const entryIdentities = new Set();
  for (const entry of entries) {
    const barIdentity = text(entry?.barIdentity);
    if (
      text(entry?.modelSource) !== modelSource ||
      text(entry?.memberId) !== memberId ||
      text(entry?.openingId) !== openingId ||
      !barIdentity ||
      !targetIdentities.has(barIdentity) ||
      entryIdentities.has(barIdentity)
    ) {
      return {
        ok: false,
        reason: 'small-opening-wall-actual-path-entry-scope-mismatch',
        ...common,
      };
    }
    entryIdentities.add(barIdentity);
  }

  if (
    entryIdentities.size !== targetIdentities.size ||
    [...targetIdentities].some((identity) => !entryIdentities.has(identity))
  ) {
    return {
      ok: false,
      reason: 'small-opening-wall-actual-path-target-entry-mismatch',
      ...common,
    };
  }

  return { ok: true, ...common };
}
