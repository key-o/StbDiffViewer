/**
 * @fileoverview Issue #348 / #320 Phase 6b-O6:
 * O5 small-opening actual wall pathsをproduction wall render planへatomic適用する。
 *
 * base render planは変更せず、explicit target sourceの全scopeが成立した場合だけ
 * source split pathsをactual replacement pathへ置換する。
 */

import { getRebarProjectDetailing } from '../../../config/rebarProjectDetailing.js';
import {
  SMALL_OPENING_REBAR_DEFLECTION_TARGET_DETAILING_TYPE,
  resolveSmallOpeningRebarDeflectionTargets,
} from '../../../config/smallOpeningRebarDeflectionTargetProjectDetailing.js';
import { buildSmallOpeningRebarDeflectionEvaluations } from './smallOpeningRebarSourceFacts.js';
import { buildSmallOpeningWallMainMutationPlansFromProjectTargets } from './smallOpeningWallProjectTargetMutationPlan.js';
import { buildSmallOpeningWallActualPaths } from './smallOpeningWallActualPath.js';
import { buildWallRebarRenderPlan } from './wallRebarPlacement.js';
import { createRebarPath, validateRebarPath } from './rebarPath.js';

const SOURCE = 'PHASE-6B-O6-SMALL-OPENING-WALL-PRODUCTION';
const DEFAULT_TOLERANCE_MM = 1e-4;

function text(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function finite(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeModelSource(value) {
  const normalized = text(value)?.toUpperCase() || null;
  return normalized === 'A' || normalized === 'B' ? normalized : null;
}

function scopeKey(value) {
  const modelSource = normalizeModelSource(value?.modelSource);
  const memberType = text(value?.memberType)?.toUpperCase() || null;
  const memberId = text(value?.memberId);
  const openingId = text(value?.openingId);
  if (!modelSource || !['WALL', 'SLAB'].includes(memberType) || !memberId || !openingId) {
    return null;
  }
  return `${modelSource}\u0000${memberType}\u0000${memberId}\u0000${openingId}`;
}

function targetEntry(projectDetailing) {
  if (!isPlainObject(projectDetailing)) {
    return {
      configured: true,
      resolved: false,
      reason: 'small-opening-wall-production-project-detailing-invalid',
    };
  }
  const type = SMALL_OPENING_REBAR_DEFLECTION_TARGET_DETAILING_TYPE;
  const top = Object.prototype.hasOwnProperty.call(projectDetailing, type);
  if (
    Object.prototype.hasOwnProperty.call(projectDetailing, 'special') &&
    !isPlainObject(projectDetailing.special)
  ) {
    return {
      configured: true,
      resolved: false,
      reason: 'small-opening-wall-production-project-special-invalid',
    };
  }
  const nested =
    isPlainObject(projectDetailing.special) &&
    Object.prototype.hasOwnProperty.call(projectDetailing.special, type);
  if (top && nested) {
    return {
      configured: true,
      resolved: false,
      reason: 'small-opening-wall-production-target-entry-ambiguous',
    };
  }
  if (!top && !nested) return { configured: false, resolved: true, scopes: [] };

  const entry = top ? projectDetailing[type] : projectDetailing.special[type];
  if (
    !isPlainObject(entry) ||
    entry.productionMode !== 'EXPLICIT' ||
    !Array.isArray(entry.assignments)
  ) {
    return {
      configured: true,
      resolved: false,
      reason: 'small-opening-wall-production-target-entry-invalid',
    };
  }
  if (entry.productionEnabled !== true) {
    return { configured: false, resolved: true, scopes: [] };
  }

  const exactTargets = new Set();
  const scopes = new Map();
  for (const assignment of entry.assignments) {
    const key = scopeKey(assignment);
    const barIdentity = text(assignment?.barIdentity);
    if (!key || !barIdentity) {
      return {
        configured: true,
        resolved: false,
        reason: 'small-opening-wall-production-target-assignment-invalid',
      };
    }
    const targetKey = `${key}\u0000${barIdentity}`;
    if (exactTargets.has(targetKey)) {
      return {
        configured: true,
        resolved: false,
        reason: 'small-opening-wall-production-target-duplicate',
      };
    }
    exactTargets.add(targetKey);
    const memberType = text(assignment?.memberType)?.toUpperCase() || null;
    if (memberType !== 'WALL') continue;
    if (!scopes.has(key)) {
      scopes.set(
        key,
        Object.freeze({
          modelSource: normalizeModelSource(assignment.modelSource),
          memberType: 'WALL',
          memberId: text(assignment.memberId),
          openingId: text(assignment.openingId),
        }),
      );
    }
  }

  return {
    configured: scopes.size > 0,
    resolved: true,
    scopes: [...scopes.values()].sort((left, right) => {
      const a = scopeKey(left);
      const b = scopeKey(right);
      return a < b ? -1 : a > b ? 1 : 0;
    }),
  };
}

function notConfigured(baseRenderPlan) {
  return Object.freeze({
    status: 'NOT_CONFIGURED',
    resolved: true,
    productionReady: false,
    reason: null,
    source: SOURCE,
    replacementCount: 0,
    openingResults: Object.freeze([]),
    renderPlan: baseRenderPlan,
  });
}

function unresolved(baseRenderPlan, reason, values = {}) {
  return Object.freeze({
    status: 'UNRESOLVED',
    resolved: false,
    productionReady: false,
    reason,
    source: SOURCE,
    replacementCount: 0,
    openingResults: Object.freeze([]),
    renderPlan: baseRenderPlan,
    ...values,
  });
}

function rejected(baseRenderPlan, reason, values = {}) {
  return Object.freeze({
    status: 'REJECTED',
    resolved: true,
    productionReady: false,
    reason,
    source: SOURCE,
    replacementCount: 0,
    openingResults: Object.freeze([]),
    renderPlan: baseRenderPlan,
    ...values,
  });
}

function cloneProductionPath(path, values) {
  if (!path || !Array.isArray(path.primitives)) return null;
  return createRebarPath(path.primitives, {
    ...(path.metadata || {}),
    productionReady: true,
    productionSource: SOURCE,
    productionModelSource: values.modelSource,
    productionMemberId: values.memberId,
    productionOpeningId: values.openingId,
    productionBarIdentity: values.barIdentity,
  });
}

function replacementAction(renderPlan, actualResult) {
  const modelSource = normalizeModelSource(actualResult?.modelSource);
  const memberId = text(actualResult?.memberId);
  const openingId = text(actualResult?.openingId);
  const barIdentity = text(actualResult?.barIdentity);
  if (
    !modelSource ||
    !memberId ||
    !openingId ||
    !barIdentity ||
    text(renderPlan?.provenance?.modelSource) !== modelSource
  ) {
    return { ok: false, reason: 'small-opening-wall-production-result-provenance-invalid' };
  }
  if (
    text(actualResult?.replacementPath?.metadata?.memberId) !== memberId ||
    text(actualResult?.replacementPath?.metadata?.openingId) !== openingId ||
    text(actualResult?.replacementPath?.metadata?.semanticIdentity) !== barIdentity
  ) {
    return { ok: false, reason: 'small-opening-wall-production-replacement-provenance-invalid' };
  }

  const indexes = [...(actualResult?.sourcePathIndexes || [])].map(Number);
  const identities = [...(actualResult?.sourcePathIdentityKeys || [])].map(text);
  if (
    indexes.length !== 2 ||
    identities.length !== 2 ||
    indexes.some((index) => !Number.isInteger(index) || index < 0) ||
    new Set(indexes).size !== 2 ||
    identities.some((identity) => !identity)
  ) {
    return { ok: false, reason: 'small-opening-wall-production-source-ref-invalid' };
  }

  const refs = indexes.map((sourcePathIndex, index) => ({
    sourcePathIndex,
    sourceIdentityKey: identities[index],
  }));
  for (const ref of refs) {
    const sourcePath = renderPlan?.paths?.[ref.sourcePathIndex];
    if (
      !sourcePath ||
      text(sourcePath?.metadata?.identityKey) !== ref.sourceIdentityKey ||
      sourcePath?.metadata?.memberType !== 'wall' ||
      sourcePath?.metadata?.role !== 'wallMain' ||
      text(sourcePath?.metadata?.memberId) !== memberId
    ) {
      return { ok: false, reason: 'small-opening-wall-production-source-stale' };
    }
  }

  const replacementPath = cloneProductionPath(actualResult.replacementPath, {
    modelSource,
    memberId,
    openingId,
    barIdentity,
  });
  const validation = replacementPath ? validateRebarPath(replacementPath) : { ok: false };
  if (!replacementPath || !validation.ok) {
    return { ok: false, reason: 'small-opening-wall-production-replacement-invalid' };
  }

  const sortedRefs = [...refs].sort((left, right) => left.sourcePathIndex - right.sourcePathIndex);
  return Object.freeze({
    ok: true,
    memberId,
    openingId,
    barIdentity,
    sourcePathIndexes: Object.freeze(sortedRefs.map((ref) => ref.sourcePathIndex)),
    sourcePathIdentityKeys: Object.freeze(sortedRefs.map((ref) => ref.sourceIdentityKey)),
    insertionIndex: sortedRefs[0].sourcePathIndex,
    replacementPath,
  });
}
function applyActions(baseRenderPlan, actions) {
  const usedIndexes = new Set();
  const insertions = new Map();

  for (const action of actions) {
    for (const index of action.sourcePathIndexes) {
      if (usedIndexes.has(index)) {
        return {
          ok: false,
          reason: 'small-opening-wall-production-source-overlap',
        };
      }
      usedIndexes.add(index);
    }
    if (insertions.has(action.insertionIndex)) {
      return {
        ok: false,
        reason: 'small-opening-wall-production-insertion-overlap',
      };
    }
    insertions.set(action.insertionIndex, action.replacementPath);
  }

  const paths = [];
  for (let index = 0; index < (baseRenderPlan?.paths || []).length; index += 1) {
    const replacement = insertions.get(index);
    if (replacement) paths.push(replacement);
    if (usedIndexes.has(index)) continue;
    paths.push(baseRenderPlan.paths[index]);
  }

  return { ok: true, paths, usedIndexes };
}

function updatedChecks(checks, paths, actions) {
  const replacementCounts = new Map();
  for (const action of actions) {
    replacementCounts.set(action.memberId, (replacementCounts.get(action.memberId) || 0) + 1);
  }

  return (checks || []).map((check) => {
    const memberId = text(check?.memberId);
    const replacementCount = replacementCounts.get(memberId) || 0;
    if (!replacementCount || check?.status !== 'READY') return check;
    const pathCount = paths.filter(
      (path) =>
        text(path?.metadata?.memberId) === memberId && path?.metadata?.memberType === 'wall',
    ).length;
    return {
      ...check,
      pathCount,
      smallOpeningReplacementCount: replacementCount,
    };
  });
}

/**
 * base wall render planからO6 production replacementを構築する。
 * 1件でもconfigured targetが不成立ならbase pathsを維持する。
 */
export function buildSmallOpeningWallProductionPlan(xmlDoc, baseRenderPlan, options = {}) {
  const tolerance = finite(options.toleranceMm ?? DEFAULT_TOLERANCE_MM);
  if (tolerance === null || tolerance < 0) {
    throw new RangeError(
      'small opening wall production toleranceMm must be finite and non-negative',
    );
  }

  const modelSource = normalizeModelSource(options.modelSource);
  if (!modelSource) return notConfigured(baseRenderPlan);
  if (text(baseRenderPlan?.provenance?.modelSource) !== modelSource) {
    return unresolved(
      baseRenderPlan,
      'small-opening-wall-production-render-plan-model-source-mismatch',
    );
  }

  const projectDetailing =
    options.projectDetailing === undefined ? getRebarProjectDetailing() : options.projectDetailing;
  const configuration = targetEntry(projectDetailing);
  if (!configuration.resolved) {
    return unresolved(baseRenderPlan, configuration.reason);
  }
  const scopes = (configuration.scopes || []).filter(
    (scope) => normalizeModelSource(scope.modelSource) === modelSource,
  );
  if (!configuration.configured || scopes.length === 0) return notConfigured(baseRenderPlan);

  const evaluations = buildSmallOpeningRebarDeflectionEvaluations(xmlDoc, {
    ...options,
    modelSource,
    projectDetailing,
  }).filter((evaluation) => evaluation?.memberType === 'StbWall');
  const evaluationsByScope = new Map(
    evaluations
      .map((evaluation) => [
        scopeKey({
          modelSource,
          memberType: 'WALL',
          memberId: evaluation.memberId,
          openingId: evaluation.openingId,
        }),
        evaluation,
      ])
      .filter(([key]) => key),
  );

  const openingResults = [];
  for (const scope of scopes) {
    const key = scopeKey(scope);
    const evaluation = evaluationsByScope.get(key);
    if (!evaluation) {
      return unresolved(baseRenderPlan, 'small-opening-wall-production-evaluation-not-found', {
        openingResults: Object.freeze(openingResults),
        failedScope: scope,
      });
    }

    const targetResolution = resolveSmallOpeningRebarDeflectionTargets({
      ...scope,
      projectDetailing,
    });
    if (!targetResolution?.active || !targetResolution?.resolved) {
      return unresolved(
        baseRenderPlan,
        targetResolution?.reason || 'small-opening-wall-production-target-unresolved',
        {
          openingResults: Object.freeze(openingResults),
          failedScope: scope,
        },
      );
    }

    const mutationPlan = buildSmallOpeningWallMainMutationPlansFromProjectTargets(
      xmlDoc,
      baseRenderPlan,
      evaluation,
      {
        modelSource,
        projectDetailing,
        toleranceMm: tolerance,
        wallRenderOptions: options,
      },
    );
    if (mutationPlan.status !== 'READY') {
      const values = {
        openingResults: Object.freeze(openingResults),
        failedScope: scope,
        mutationPlan,
      };
      return mutationPlan.status === 'REJECTED'
        ? rejected(baseRenderPlan, mutationPlan.reason, values)
        : unresolved(
            baseRenderPlan,
            mutationPlan.reason || 'small-opening-wall-production-mutation-plan-unresolved',
            values,
          );
    }

    const actual = buildSmallOpeningWallActualPaths(xmlDoc, baseRenderPlan, mutationPlan, {
      toleranceMm: tolerance,
      wallRenderOptions: options,
    });
    openingResults.push(
      Object.freeze({
        scope: Object.freeze({ ...scope }),
        targetResolution,
        mutationPlan,
        actual,
      }),
    );
    if (actual.status !== 'READY' || actual.actualPathReady !== true) {
      const values = {
        openingResults: Object.freeze(openingResults),
        failedScope: scope,
      };
      return actual.status === 'REJECTED'
        ? rejected(baseRenderPlan, actual.reason, values)
        : unresolved(
            baseRenderPlan,
            actual.reason || 'small-opening-wall-production-actual-path-unresolved',
            values,
          );
    }
  }

  const actions = [];
  for (const opening of openingResults) {
    for (const result of opening.actual.entries || []) {
      const action = replacementAction(baseRenderPlan, result);
      if (!action.ok) {
        return unresolved(baseRenderPlan, action.reason, {
          openingResults: Object.freeze(openingResults),
        });
      }
      actions.push(action);
    }
  }

  const applied = applyActions(baseRenderPlan, actions);
  if (!applied.ok) {
    return unresolved(baseRenderPlan, applied.reason, {
      openingResults: Object.freeze(openingResults),
    });
  }

  const checks = updatedChecks(baseRenderPlan.checks, applied.paths, actions);
  const production = Object.freeze({
    smallOpening: Object.freeze({
      status: 'READY',
      resolved: true,
      productionReady: true,
      reason: null,
      source: SOURCE,
      modelSource,
      replacementCount: actions.length,
      sourcePathCount: applied.usedIndexes.size,
      openingCount: openingResults.length,
      openingResults: Object.freeze(openingResults),
    }),
  });
  const renderPlan = {
    ...baseRenderPlan,
    paths: applied.paths,
    checks,
    readyCount: checks.filter((check) => check.status === 'READY').length,
    specialCount: checks.filter((check) => check.specialRequired).length,
    production,
  };

  return Object.freeze({
    status: 'READY',
    resolved: true,
    productionReady: true,
    reason: null,
    source: SOURCE,
    modelSource,
    replacementCount: actions.length,
    sourcePathCount: applied.usedIndexes.size,
    openingResults: Object.freeze(openingResults),
    actions: Object.freeze(actions),
    renderPlan,
  });
}

/**
 * 通常production表示用wall render plan。
 * target source未設定時は既存base planをそのまま返す。
 */
export function buildWallRebarProductionRenderPlan(xmlDoc, options = {}) {
  const baseRenderPlan = buildWallRebarRenderPlan(xmlDoc, options);
  const result = buildSmallOpeningWallProductionPlan(xmlDoc, baseRenderPlan, options);
  if (result.status === 'NOT_CONFIGURED') return baseRenderPlan;
  if (result.status === 'READY') return result.renderPlan;
  return {
    ...baseRenderPlan,
    production: Object.freeze({
      smallOpening: Object.freeze({
        status: result.status,
        resolved: result.resolved,
        productionReady: false,
        reason: result.reason,
        source: SOURCE,
        modelSource: normalizeModelSource(options.modelSource),
        replacementCount: 0,
        openingResults: result.openingResults,
      }),
    }),
  };
}

export const SMALL_OPENING_WALL_PRODUCTION_SOURCE = SOURCE;

export const __testOnly = Object.freeze({
  targetEntry,
  replacementAction,
  applyActions,
});
