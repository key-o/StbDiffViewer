/**
 * @fileoverview Issue #333 / #320 Phase 6b-O4:
 * opening-level O-001 evaluationをproject-scoped explicit bar targetsへ展開し、
 * 既存のsingle-bar mutation-plan hard gateへ接続する。
 *
 * このmoduleはtarget resolution / aggregate planのみを担当し、
 * actual RebarPath geometryは変更しない。
 */

import { resolveSmallOpeningRebarDeflectionTargets } from '../../../config/smallOpeningRebarDeflectionTargetProjectDetailing.js';
import { buildSmallOpeningWallMainMutationPlan } from './smallOpeningWallMainMutationPlan.js';

const PROJECT_TARGET_SOURCE = 'PHASE-6B-O4-SMALL-OPENING-WALL-PROJECT-TARGET-PLAN';
const DEFAULT_TOLERANCE_MM = 1e-4;

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
    resolved: false,
    pathPlanReady: false,
    productionReady: false,
    reason,
    source: PROJECT_TARGET_SOURCE,
    entries: Object.freeze([]),
    ...values,
  });
}

/**
 * opening-level O-001 evaluationをproject-scoped explicit bar targetへ展開し、
 * 既存のsingle-bar mutation-plan hard gateを各targetに適用する。
 *
 * targetが複数ある場合も全件を明示assignmentとして扱い、1件でも不成立なら
 * aggregate planはfail-closedにする。
 */
export function buildSmallOpeningWallMainMutationPlansFromProjectTargets(
  xmlDoc,
  renderPlan,
  evaluation,
  {
    modelSource = null,
    projectDetailing,
    toleranceMm = DEFAULT_TOLERANCE_MM,
    wallRenderOptions = {},
  } = {},
) {
  const tolerance = finite(toleranceMm);
  if (tolerance === null || tolerance < 0) {
    throw new RangeError(
      'small opening project target mutation plan toleranceMm must be finite and non-negative',
    );
  }

  const expectedModelSource = text(modelSource);
  const evaluationModelSource = text(evaluation?.modelSource);
  const openingId = text(evaluation?.openingId);
  const memberId = text(evaluation?.memberId);
  const common = {
    openingId,
    memberId,
    modelSource: expectedModelSource,
  };

  if (evaluation?.memberType !== 'StbWall') {
    return unresolved('small-opening-wall-project-target-member-type-unsupported', common);
  }
  if (!expectedModelSource || evaluationModelSource !== expectedModelSource) {
    return unresolved('small-opening-wall-project-target-model-source-mismatch', {
      ...common,
      evaluationModelSource,
    });
  }
  if (!openingId || !memberId) {
    return unresolved('small-opening-wall-project-target-source-identity-unresolved', common);
  }

  const targetResolution = resolveSmallOpeningRebarDeflectionTargets({
    modelSource: expectedModelSource,
    memberType: 'WALL',
    memberId,
    openingId,
    projectDetailing,
  });

  if (!targetResolution?.active) {
    return unresolved('small-opening-wall-project-target-not-configured', {
      ...common,
      targetStatus: targetResolution?.status || null,
    });
  }
  if (!targetResolution?.resolved) {
    return unresolved(
      targetResolution?.reason || 'small-opening-wall-project-target-unresolved',
      {
        ...common,
        targetStatus: targetResolution?.status || null,
        targetSourceRef: targetResolution?.sourceRef || null,
      },
    );
  }

  const targets = Array.isArray(targetResolution.targets) ? targetResolution.targets : [];
  if (targets.length === 0) {
    return unresolved('small-opening-wall-project-target-empty', {
      ...common,
      targetSourceRef: targetResolution?.sourceRef || null,
    });
  }

  const targetPlans = targets.map((target) =>
    Object.freeze({
      target: Object.freeze({ ...target }),
      plan: buildSmallOpeningWallMainMutationPlan(xmlDoc, renderPlan, evaluation, {
        modelSource: expectedModelSource,
        targetBarIdentity: target.barIdentity,
        toleranceMm: tolerance,
        wallRenderOptions,
      }),
    }),
  );

  if (targetPlans.every((item) => item.plan.status === 'READY')) {
    const entries = targetPlans.flatMap((item) => item.plan.entries || []);
    return Object.freeze({
      status: 'READY',
      resolved: true,
      pathPlanReady: true,
      productionReady: false,
      reason: null,
      source: PROJECT_TARGET_SOURCE,
      openingId,
      memberId,
      modelSource: expectedModelSource,
      targetSourceRef: targetResolution.sourceRef || null,
      targetCount: targets.length,
      targets: Object.freeze(targets.map((target) => Object.freeze({ ...target }))),
      targetPlans: Object.freeze(targetPlans),
      entries: Object.freeze(entries),
      unresolved: Object.freeze([]),
    });
  }

  const allRejected = targetPlans.every((item) => item.plan.status === 'REJECTED');
  return Object.freeze({
    status: allRejected ? 'REJECTED' : 'UNRESOLVED',
    resolved: allRejected,
    pathPlanReady: false,
    productionReady: false,
    reason: allRejected
      ? targetPlans[0]?.plan?.reason || 'small-opening-wall-project-target-rejected'
      : 'small-opening-wall-project-target-plan-unresolved',
    source: PROJECT_TARGET_SOURCE,
    openingId,
    memberId,
    modelSource: expectedModelSource,
    targetSourceRef: targetResolution.sourceRef || null,
    targetCount: targets.length,
    targets: Object.freeze(targets.map((target) => Object.freeze({ ...target }))),
    targetPlans: Object.freeze(targetPlans),
    entries: Object.freeze([]),
    unresolved: Object.freeze(
      targetPlans
        .filter((item) => item.plan.status !== 'READY')
        .map((item) =>
          Object.freeze({
            barIdentity: item.target.barIdentity,
            status: item.plan.status,
            reason: item.plan.reason || null,
          }),
        ),
    ),
  });
}

export const SMALL_OPENING_WALL_PROJECT_TARGET_PLAN_SOURCE = PROJECT_TARGET_SOURCE;
