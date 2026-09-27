/**
 * @fileoverview Issue #310 Phase 6a-D2b wall-wall continuity resolver。
 *
 * D2a topology -> D1a supplemental hard gate -> D1b source treatment ->
 * design-length / bar-level assignment -> available-length / W-001 gate。
 * production RebarPath mutationは行わない。
 */

import { buildWallWallJunctionResolverInput } from './wallRebarWallJunctionAdapter.js';
import { evaluateWallJunctionSupplementalBarGate } from './wallRebarContinuitySourceGate.js';
import { classifyWallWallJunctionSourceTreatment } from './wallRebarWallJunctionClassifier.js';
import {
  buildWallWallJunctionAssignments,
  requiredWallWallDesignLengthFacts,
  evaluateWallWallJunctionAssignments,
} from './wallRebarWallJunctionTreatment.js';

function finite(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function unresolved(reason, values = {}) {
  return Object.freeze({
    status: 'UNRESOLVED',
    reason,
    productionReady: false,
    ...values,
  });
}

function rejected(reason, values = {}) {
  return Object.freeze({
    status: 'REJECTED',
    reason,
    productionReady: false,
    ...values,
  });
}

export { buildWallWallJunctionResolverInput };

/**
 * D2a topology fact -> D1a -> D1b -> design-length -> bar assignment ->
 * available-length / W-001(L1のみ)。
 */
export function resolveWallWallJunctionContinuity(
  input,
  {
    supplemental = null,
    designLengths = null,
    availableLengths = null,
    zToleranceMm = 1e-4,
    lengthToleranceMm = 1e-4,
    ...spliceOptions
  } = {},
) {
  const zTolerance = finite(zToleranceMm);
  const lengthTolerance = finite(lengthToleranceMm);
  if (zTolerance === null || zTolerance < 0) {
    throw new RangeError('wall junction resolver zToleranceMm must be finite and non-negative');
  }
  if (lengthTolerance === null || lengthTolerance < 0) {
    throw new RangeError(
      'wall junction resolver lengthToleranceMm must be finite and non-negative',
    );
  }
  if (input?.status !== 'RESOLVED' || input?.topologyFact?.status !== 'RESOLVED') {
    return unresolved(input?.reason || 'wall-wall-junction-input-unresolved', {
      modelSource: input?.modelSource || null,
      sourceMemberId: text(input?.sourceMemberId),
      targetMemberId: text(input?.targetMemberId),
      topologyFact: input?.topologyFact || null,
    });
  }

  const topologyFact = input.topologyFact;
  const modelSource = text(input.modelSource);
  const topologyModelSource = text(topologyFact.modelSource);
  if (modelSource !== topologyModelSource) {
    return unresolved('wall-wall-junction-semantic-model-source-mismatch', {
      modelSource,
      topologyFact,
    });
  }
  const sourceMemberId = text(input.sourceMemberId);
  const targetMemberId = text(input.targetMemberId);
  if (
    (sourceMemberId !== null && sourceMemberId !== text(topologyFact.sourceMemberId)) ||
    (targetMemberId !== null && targetMemberId !== text(topologyFact.targetMemberId))
  ) {
    return unresolved('wall-wall-junction-member-pair-mismatch', {
      modelSource,
      sourceMemberId,
      targetMemberId,
      topologyFact,
    });
  }
  const supplementalGate = evaluateWallJunctionSupplementalBarGate({
    verticalDiaMm: supplemental?.verticalDiaMm,
    maxWallVerticalDiaMm: input.maxWallVerticalDiaMm ?? input.wallMaximums?.verticalDiaMm ?? null,
    horizontalDiaMm: supplemental?.horizontalDiaMm,
    maxWallHorizontalDiaMm:
      input.maxWallHorizontalDiaMm ?? input.wallMaximums?.horizontalDiaMm ?? null,
  });
  const classification = classifyWallWallJunctionSourceTreatment({
    topology: topologyFact.topology,
    pattern: topologyFact.pattern,
    horizontalSpacingRelation: topologyFact.horizontalSpacingRelation,
    supplementalGate,
  });

  const common = {
    phase: 'PHASE_6A_D2B',
    modelSource,
    junctionKey: topologyFact.junctionKey,
    topologyFact,
    supplementalGate,
    classification,
  };

  if (classification.status === 'REJECTED') {
    return rejected(classification.reason, { ...common, assignments: Object.freeze([]) });
  }
  if (classification.status !== 'SOURCE_CLASSIFIED') {
    return unresolved(classification.reason, { ...common, assignments: Object.freeze([]) });
  }

  const lengths = requiredWallWallDesignLengthFacts(classification, designLengths);
  if (!lengths) {
    return unresolved('wall-wall-junction-design-length-unresolved', {
      ...common,
      assignments: Object.freeze([]),
    });
  }

  const draft = buildWallWallJunctionAssignments(topologyFact, classification, lengths, {
    zToleranceMm: zTolerance,
  });
  if (draft.status !== 'RESOLVED') {
    return unresolved(draft.reason, {
      ...common,
      designLengths: lengths,
      assignments: Object.freeze([]),
    });
  }

  const evaluated = evaluateWallWallJunctionAssignments(draft.assignments, {
    availableLengths,
    lengthToleranceMm: lengthTolerance,
    ...spliceOptions,
  });
  if (evaluated.status === 'REJECTED') {
    return rejected(evaluated.reason, {
      ...common,
      designLengths: lengths,
      assignments: evaluated.assignments,
    });
  }
  if (evaluated.status !== 'RESOLVED') {
    return unresolved(evaluated.reason, {
      ...common,
      designLengths: lengths,
      assignments: evaluated.assignments,
    });
  }

  return Object.freeze({
    status: 'RESOLVED',
    reason: null,
    ...common,
    designLengths: lengths,
    assignments: evaluated.assignments,
    productionReady: false,
  });
}

// concise alias for new callers; current D2b tests/consumers keep the explicit Continuity name.
export const resolveWallWallJunction = resolveWallWallJunctionContinuity;
