/**
 * @fileoverview Issue #302 Phase 5c-B2: horizontal dogleg productionのpure atomic staging。
 *
 * readiness評価とproduction mutationを分離し、joint内の水平candidateが全てREADYのときだけ
 * path / trim / anchorage suppression proposalを返す。
 */

import { evaluateHorizontalDoglegReadiness } from './rebarHorizontalDoglegReadiness.js';

const EPS = 1e-6;
const READY_DISPOSITION = 'BENT_HORIZONTAL_THROUGH';

function text(value) {
  return String(value ?? '').trim();
}

function unresolvedDecision(transition, readiness, reason) {
  return {
    transition,
    readiness,
    productionStatus: 'UNRESOLVED',
    productionReason: reason,
    productionDisposition: null,
  };
}

function readyDecision(transition, readiness) {
  return {
    transition,
    readiness,
    productionStatus: 'CENTERLINE_READY',
    productionReason: null,
    productionDisposition: READY_DISPOSITION,
  };
}

function jointResolved(joint) {
  return Boolean(
    text(joint?.leftGirderId) &&
    text(joint?.rightGirderId) &&
    text(joint?.leftEndpoint) &&
    text(joint?.rightEndpoint),
  );
}

function barProductionKey(joint, transition, side) {
  const left = side === 'left';
  const memberId = text(left ? joint?.leftGirderId : joint?.rightGirderId);
  const endpoint = text(left ? joint?.leftEndpoint : joint?.rightEndpoint);
  const bar = left ? transition?.leftBar : transition?.rightBar;
  const semanticIdentity = text(bar?.semanticIdentity);
  const barIndex = Number(bar?.barIndex);
  const identity =
    semanticIdentity || (Number.isInteger(barIndex) && barIndex >= 0 ? `INDEX:${barIndex}` : '');
  if (!memberId || !endpoint || !identity) return null;
  return `${memberId}|${endpoint}|${identity}`;
}

function findReusedBar(joint, transitions) {
  const seen = new Set();
  for (const transition of transitions) {
    for (const side of ['left', 'right']) {
      const key = barProductionKey(joint, transition, side);
      if (!key)
        return { reason: 'horizontal-dogleg-production-bar-identity-unresolved', key: null };
      if (seen.has(key)) return { reason: 'horizontal-dogleg-production-bar-reused', key };
      seen.add(key);
    }
  }
  return null;
}

function normalizeReadiness(readiness) {
  if (!readiness?.ready) return readiness;
  if (!readiness.path) {
    return {
      ...readiness,
      ready: false,
      status: 'UNRESOLVED',
      reason: 'horizontal-dogleg-readiness-path-required',
      path: null,
    };
  }
  if (readiness.path?.metadata?.disposition !== READY_DISPOSITION) {
    return {
      ...readiness,
      ready: false,
      status: 'UNRESOLVED',
      reason: 'horizontal-dogleg-readiness-path-disposition-invalid',
      path: null,
    };
  }
  return readiness;
}

function unresolvedPlan(reason, transitions = [], extra = {}) {
  return {
    ...extra,
    ready: false,
    reason,
    decisions: transitions.map((transition) => unresolvedDecision(transition, null, reason)),
    paths: [],
    trims: [],
    suppressions: [],
  };
}

/**
 * @returns {{
 *  ready:boolean,
 *  decisions:Array<object>,
 *  paths:Array<object>,
 *  trims:Array<object>,
 *  suppressions:Array<object>
 * }}
 */
export function stageHorizontalDoglegProduction({
  joint,
  transitions,
  window,
  columnBars,
  columnBoundaries,
  readinessEvaluator = evaluateHorizontalDoglegReadiness,
} = {}) {
  const candidates = Array.isArray(transitions) ? transitions : [];
  if (
    !jointResolved(joint) ||
    candidates.length === 0 ||
    typeof readinessEvaluator !== 'function'
  ) {
    return unresolvedPlan('horizontal-dogleg-production-input-unresolved');
  }

  const reused = findReusedBar(joint, candidates);
  if (reused) {
    return unresolvedPlan(reused.reason, candidates, { conflictingBarKey: reused.key });
  }

  const staged = candidates.map((transition) => {
    const readiness = normalizeReadiness(
      readinessEvaluator({
        transition,
        window,
        columnBars,
        columnBoundaries,
      }),
    );
    return { transition, readiness };
  });
  const failed = staged.filter((entry) => !entry.readiness?.ready);
  if (failed.length) {
    return {
      ready: false,
      reason: 'horizontal-dogleg-joint-atomic-rollback',
      decisions: staged.map((entry) =>
        unresolvedDecision(
          entry.transition,
          entry.readiness,
          entry.readiness?.ready
            ? 'horizontal-dogleg-joint-atomic-rollback'
            : entry.readiness?.reason || 'horizontal-dogleg-readiness-unresolved',
        ),
      ),
      paths: [],
      trims: [],
      suppressions: [],
    };
  }

  const decisions = staged.map((entry) => readyDecision(entry.transition, entry.readiness));
  const paths = staged.map((entry) => entry.readiness.path);
  const trims = [];
  const suppressions = [];

  for (const { transition, readiness } of staged) {
    if (readiness.leftTrimMm > EPS) {
      trims.push({
        memberId: String(joint.leftGirderId),
        endpoint: String(joint.leftEndpoint),
        bar: transition.leftBar,
        trimMm: readiness.leftTrimMm,
      });
    }
    if (readiness.rightTrimMm > EPS) {
      trims.push({
        memberId: String(joint.rightGirderId),
        endpoint: String(joint.rightEndpoint),
        bar: transition.rightBar,
        trimMm: readiness.rightTrimMm,
      });
    }
    suppressions.push(
      {
        memberId: String(joint.leftGirderId),
        endpoint: String(joint.leftEndpoint),
        bar: transition.leftBar,
      },
      {
        memberId: String(joint.rightGirderId),
        endpoint: String(joint.rightEndpoint),
        bar: transition.rightBar,
      },
    );
  }

  return {
    ready: true,
    reason: null,
    decisions,
    paths,
    trims,
    suppressions,
  };
}
