/**
 * @fileoverview Issue #356 / #320 Phase 6b-O7c:
 * O7b slab small-opening actual candidatesをraw slab pathsへatomic適用し、
 * その後にslab boundary detailingを再解決するproduction plannerとdisplay wrapper。
 *
 * O7c-Bはこのwrapperをnormal slab displayとcache keyへ接続する。
 */

import { getRebarProjectDetailing } from '../../../config/rebarProjectDetailing.js';
import { SMALL_OPENING_REBAR_DEFLECTION_TARGET_DETAILING_TYPE } from '../../../config/smallOpeningRebarDeflectionTargetProjectDetailing.js';
import {
  buildSlabRebarRenderPlan,
  buildSlabRebarSmallOpeningRawSourceState,
} from './slabRebarPlacement.js';
import { applySlabBoundaryDetailing } from './slabRebarBoundaryDetailing.js';
import { buildSmallOpeningSlabTargetPlan } from './smallOpeningSlabSourcePlan.js';
import { buildSmallOpeningSlabActualPaths } from './smallOpeningSlabActualPath.js';
import {
  buildSlabBendLocalPath,
  buildSlabShiftLocalPath,
  pathInsideSlabAndOutsideOpening,
  toSlabLocalPath,
  toSlabWorldPath,
} from './smallOpeningSlabActualPathGeometry.js';
import { createRebarPath, validateRebarPath } from './rebarPath.js';

const SOURCE = 'PHASE-6B-O7C-SMALL-OPENING-SLAB-PRODUCTION';
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

function normalizeModelSource(value) {
  const normalized = text(value)?.toUpperCase() || null;
  return normalized === 'A' || normalized === 'B' ? normalized : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function slabTargetConfiguration(projectDetailing, modelSource) {
  if (!isPlainObject(projectDetailing)) {
    return {
      configured: true,
      resolved: false,
      reason: 'small-opening-slab-production-project-detailing-invalid',
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
      reason: 'small-opening-slab-production-project-special-invalid',
    };
  }
  const nested =
    isPlainObject(projectDetailing.special) &&
    Object.prototype.hasOwnProperty.call(projectDetailing.special, type);
  if (top && nested) {
    return {
      configured: true,
      resolved: false,
      reason: 'small-opening-slab-production-target-entry-ambiguous',
    };
  }
  if (!top && !nested) return { configured: false, resolved: true };

  const entry = top ? projectDetailing[type] : projectDetailing.special[type];
  if (
    !isPlainObject(entry) ||
    entry.productionMode !== 'EXPLICIT' ||
    !Array.isArray(entry.assignments)
  ) {
    return {
      configured: true,
      resolved: false,
      reason: 'small-opening-slab-production-target-entry-invalid',
    };
  }
  if (entry.productionEnabled !== true) return { configured: false, resolved: true };

  const configured = entry.assignments.some(
    (assignment) =>
      text(assignment?.memberType)?.toUpperCase() === 'SLAB' &&
      normalizeModelSource(assignment?.modelSource) === modelSource,
  );
  return { configured, resolved: true };
}

function notConfigured(defaultRenderPlan, values = {}) {
  return Object.freeze({
    status: 'NOT_CONFIGURED',
    resolved: true,
    productionReady: false,
    reason: null,
    source: SOURCE,
    replacementCount: 0,
    renderPlan: defaultRenderPlan,
    ...values,
  });
}

function unresolved(defaultRenderPlan, reason, values = {}) {
  return Object.freeze({
    status: 'UNRESOLVED',
    resolved: false,
    productionReady: false,
    reason,
    source: SOURCE,
    replacementCount: 0,
    renderPlan: defaultRenderPlan,
    ...values,
  });
}

function rejected(defaultRenderPlan, reason, values = {}) {
  return Object.freeze({
    status: 'REJECTED',
    resolved: true,
    productionReady: false,
    reason,
    source: SOURCE,
    replacementCount: 0,
    renderPlan: defaultRenderPlan,
    ...values,
  });
}

function openingKey(memberId, openingId) {
  const member = text(memberId);
  const opening = text(openingId);
  return member && opening ? `${member}\u0000${opening}` : null;
}

function targetEntriesByOpening(targetPlan) {
  const map = new Map();
  for (const result of targetPlan?.openings || []) {
    if (result?.status !== 'READY') continue;
    const key = openingKey(result?.opening?.memberId, result?.opening?.openingId);
    if (!key) continue;
    map.set(key, result);
  }
  return map;
}

function productionMetadata(rawPath, actualEntry) {
  const barIdentity = text(actualEntry?.barIdentity);
  return {
    ...(rawPath?.metadata || {}),
    coordinateSpace: 'world',
    identityKey: barIdentity,
    semanticIdentity: barIdentity,
    productionReady: true,
    productionSource: SOURCE,
    productionModelSource: normalizeModelSource(actualEntry?.modelSource),
    productionMemberId: text(actualEntry?.memberId),
    productionOpeningId: text(actualEntry?.openingId),
    productionBarIdentity: barIdentity,
    smallOpeningDeflectionMethod: text(actualEntry?.method)?.toUpperCase() || null,
    smallOpeningCandidateType: text(actualEntry?.candidateType),
    smallOpeningCandidateRuleId: text(actualEntry?.candidateRuleId),
    boundaryRecheckRequired: true,
  };
}

function rawSourceForActual(rawPlan, actualEntry) {
  const index = Number(actualEntry?.sourcePathIndex);
  const identity = text(actualEntry?.sourcePathIdentityKey) || text(actualEntry?.barIdentity);
  if (!Number.isInteger(index) || index < 0 || !identity) {
    return { ok: false, reason: 'small-opening-slab-production-source-ref-invalid' };
  }
  const path = rawPlan?.paths?.[index];
  if (
    !path ||
    text(path?.metadata?.memberType)?.toUpperCase() !== 'SLAB' ||
    text(path?.metadata?.memberId) !== text(actualEntry?.memberId) ||
    text(path?.metadata?.identityKey) !== identity
  ) {
    return { ok: false, reason: 'small-opening-slab-production-raw-source-stale' };
  }
  return { ok: true, path, sourcePathIndex: index, barIdentity: identity };
}

function targetEntryForActual(openingResult, actualEntry) {
  const barIdentity = text(actualEntry?.barIdentity);
  const entries = (openingResult?.targets || []).filter(
    (entry) =>
      text(entry?.target?.barIdentity) === barIdentity &&
      text(entry?.candidate?.barIdentity) === barIdentity,
  );
  return entries.length === 1 ? entries[0] : null;
}

function rebuildRawReplacement(rawPlan, targetPlan, actualEntry, toleranceMm) {
  const source = rawSourceForActual(rawPlan, actualEntry);
  if (!source.ok) return source;

  const key = openingKey(actualEntry?.memberId, actualEntry?.openingId);
  const openingResult = targetEntriesByOpening(targetPlan).get(key);
  const targetEntry = targetEntryForActual(openingResult, actualEntry);
  const opening = openingResult?.opening;
  if (!opening || !targetEntry) {
    return { ok: false, reason: 'small-opening-slab-production-target-provenance-unresolved' };
  }
  if (
    normalizeModelSource(opening.modelSource) !== normalizeModelSource(actualEntry.modelSource) ||
    text(opening.memberId) !== text(actualEntry.memberId) ||
    text(opening.openingId) !== text(actualEntry.openingId)
  ) {
    return { ok: false, reason: 'small-opening-slab-production-scope-mismatch' };
  }

  const frame = opening.frame;
  const openingGeometry = opening.openingGeometry;
  if (!frame?.origin || !frame?.xAxis || !frame?.yAxis || !frame?.normal || !openingGeometry) {
    return { ok: false, reason: 'small-opening-slab-production-frame-unresolved' };
  }

  const candidate = targetEntry.candidate;
  const runAxis = text(candidate?.runAxis)?.toLowerCase();
  const crossCoordMm = finite(candidate?.crossCoordMm);
  const diaMm = finite(source.path?.metadata?.dia);
  const grade = text(source.path?.metadata?.strength) || text(source.path?.metadata?.grade);
  if ((runAxis !== 'x' && runAxis !== 'y') || crossCoordMm === null || !(diaMm > 0) || !grade) {
    return { ok: false, reason: 'small-opening-slab-production-source-metadata-unresolved' };
  }

  const metadata = productionMetadata(source.path, actualEntry);
  const localPath = toSlabLocalPath(frame, source.path, {
    ...metadata,
    coordinateSpace: 'slab-local',
  });
  if (!localPath || !validateRebarPath(localPath).ok) {
    return { ok: false, reason: 'small-opening-slab-production-raw-local-path-invalid' };
  }

  const method = text(actualEntry?.method)?.toUpperCase();
  const actualMetadata = actualEntry?.replacementPath?.metadata || {};
  let built = null;
  if (method === 'SHIFT') {
    const shiftMm = finite(actualMetadata.shiftMm);
    if (shiftMm === null) {
      return { ok: false, reason: 'small-opening-slab-production-shift-missing' };
    }
    const path = buildSlabShiftLocalPath({
      sourcePath: localPath,
      runAxis,
      shiftMm,
      metadata: { ...metadata, shiftMm },
    });
    built = path ? { ok: true, path } : null;
  } else if (method === 'BEND') {
    const offsetMm = finite(actualMetadata.bendOffsetMm);
    const runMm = finite(actualMetadata.bendRunMm);
    if (offsetMm === null || runMm === null) {
      return { ok: false, reason: 'small-opening-slab-production-bend-missing' };
    }
    built = buildSlabBendLocalPath({
      sourcePath: localPath,
      runAxis,
      crossCoordMm,
      openingGeometry,
      offsetMm,
      runMm,
      diaMm,
      grade,
      metadata: {
        ...metadata,
        bendOffsetMm: offsetMm,
        bendRunMm: runMm,
      },
      toleranceMm,
    });
  } else {
    return { ok: false, reason: 'small-opening-slab-production-method-unresolved' };
  }

  if (!built?.ok || !built.path) {
    return {
      ok: false,
      reason: built?.reason || 'small-opening-slab-production-raw-replacement-unresolved',
      doglegReason: built?.doglegReason || null,
    };
  }
  if (!validateRebarPath(built.path).ok) {
    return { ok: false, reason: 'small-opening-slab-production-local-replacement-invalid' };
  }
  if (!pathInsideSlabAndOutsideOpening(built.path, frame, openingGeometry, toleranceMm)) {
    return { ok: false, rejected: true, reason: 'small-opening-slab-production-path-invalid' };
  }

  const replacementPath = toSlabWorldPath(frame, built.path, metadata);
  const validation = replacementPath ? validateRebarPath(replacementPath) : { ok: false };
  if (!replacementPath || !validation.ok) {
    return {
      ok: false,
      reason: 'small-opening-slab-production-world-replacement-invalid',
      validation,
    };
  }

  return Object.freeze({
    ok: true,
    sourcePathIndex: source.sourcePathIndex,
    memberId: text(actualEntry.memberId),
    openingId: text(actualEntry.openingId),
    barIdentity: source.barIdentity,
    method,
    replacementPath,
  });
}

function applyActions(rawPlan, actions) {
  const paths = [...(rawPlan?.paths || [])];
  const used = new Set();
  for (const action of actions) {
    if (used.has(action.sourcePathIndex)) {
      return { ok: false, reason: 'small-opening-slab-production-source-reused' };
    }
    if (!paths[action.sourcePathIndex]) {
      return { ok: false, reason: 'small-opening-slab-production-source-index-missing' };
    }
    used.add(action.sourcePathIndex);
    paths[action.sourcePathIndex] = action.replacementPath;
  }
  return { ok: true, paths, used };
}

function affectedBoundaryFailure(boundary, affectedMemberIds) {
  return (
    (boundary?.checks || []).find((check) => affectedMemberIds.has(text(check?.memberId))) || null
  );
}

function finalizeProductionPaths(plan, actions) {
  for (const action of actions) {
    const path = plan?.paths?.[action.sourcePathIndex];
    const validation = path ? validateRebarPath(path) : { ok: false };
    if (!path || !validation.ok) {
      return {
        ok: false,
        reason: 'small-opening-slab-production-final-path-invalid',
        sourcePathIndex: action.sourcePathIndex,
        validation,
      };
    }
    plan.paths[action.sourcePathIndex] = createRebarPath(path.primitives, {
      ...(path.metadata || {}),
      identityKey: action.barIdentity,
      semanticIdentity: action.barIdentity,
      productionReady: true,
      productionSource: SOURCE,
      productionMemberId: action.memberId,
      productionOpeningId: action.openingId,
      productionBarIdentity: action.barIdentity,
      productionBoundaryResolved: true,
      boundaryRecheckRequired: false,
    });
  }
  return { ok: true };
}

/**
 * Builds the raw production plan used by the O7c-B slab display wrapper.
 */
export function buildSmallOpeningSlabProductionPlan(xmlDoc, options = {}) {
  const tolerance = finite(options.toleranceMm ?? DEFAULT_TOLERANCE_MM);
  if (tolerance === null || tolerance < 0) {
    throw new RangeError(
      'small opening slab production toleranceMm must be finite and non-negative',
    );
  }

  const modelSource = normalizeModelSource(options.modelSource);
  const slabRenderOptions = options.slabRenderOptions || options;
  const defaultRenderPlan = buildSlabRebarRenderPlan(xmlDoc, slabRenderOptions);
  if (!modelSource) {
    return notConfigured(defaultRenderPlan, { modelSource: null });
  }

  const projectDetailing =
    options.projectDetailing === undefined ? getRebarProjectDetailing() : options.projectDetailing;
  const configuration = slabTargetConfiguration(projectDetailing, modelSource);
  if (!configuration.resolved) {
    return unresolved(defaultRenderPlan, configuration.reason, { modelSource });
  }
  if (!configuration.configured) {
    return notConfigured(defaultRenderPlan, { modelSource });
  }

  const targetPlan = buildSmallOpeningSlabTargetPlan(xmlDoc, {
    modelSource,
    projectDetailing,
    toleranceMm: tolerance,
    slabRenderOptions,
  });

  if (targetPlan.status === 'NOT_CONFIGURED' || targetPlan.targetCount === 0) {
    return notConfigured(defaultRenderPlan, { modelSource, targetPlan });
  }
  if (targetPlan.status !== 'READY' || targetPlan.targetPlanReady !== true) {
    return unresolved(
      defaultRenderPlan,
      targetPlan.reason || 'small-opening-slab-production-target-plan-unresolved',
      { modelSource, targetPlan },
    );
  }

  const actual = buildSmallOpeningSlabActualPaths(xmlDoc, targetPlan, {
    projectDetailing,
    toleranceMm: tolerance,
    slabRenderOptions,
  });
  if (actual.status !== 'READY' || actual.actualPathReady !== true) {
    const values = { modelSource, targetPlan, actual };
    return actual.status === 'REJECTED'
      ? rejected(
          defaultRenderPlan,
          actual.reason || 'small-opening-slab-production-actual-rejected',
          values,
        )
      : unresolved(
          defaultRenderPlan,
          actual.reason || 'small-opening-slab-production-actual-unresolved',
          values,
        );
  }

  const rawState = buildSlabRebarSmallOpeningRawSourceState(xmlDoc, slabRenderOptions);
  const rawPlan = rawState?.renderPlan;
  if (!rawPlan || !rawState?.contexts || rawPlan.boundaryDetailingPending !== true) {
    return unresolved(defaultRenderPlan, 'small-opening-slab-production-raw-source-unresolved', {
      modelSource,
      targetPlan,
      actual,
    });
  }

  const actions = [];
  for (const entry of actual.entries || []) {
    const action = rebuildRawReplacement(rawPlan, targetPlan, entry, tolerance);
    if (!action.ok) {
      const values = { modelSource, targetPlan, actual, failedEntry: entry, action };
      return action.rejected
        ? rejected(defaultRenderPlan, action.reason, values)
        : unresolved(defaultRenderPlan, action.reason, values);
    }
    actions.push(action);
  }
  if (actions.length !== actual.targetCount || actions.length !== targetPlan.targetCount) {
    return unresolved(defaultRenderPlan, 'small-opening-slab-production-cardinality-mismatch', {
      modelSource,
      targetPlan,
      actual,
      actionCount: actions.length,
    });
  }

  const applied = applyActions(rawPlan, actions);
  if (!applied.ok) {
    return unresolved(defaultRenderPlan, applied.reason, {
      modelSource,
      targetPlan,
      actual,
    });
  }

  const workingPlan = {
    ...rawPlan,
    paths: applied.paths,
    checks: [...(rawPlan.checks || [])],
    boundaryDetailingPending: false,
  };
  const boundary = applySlabBoundaryDetailing(xmlDoc, workingPlan, rawState.contexts);
  workingPlan.throughCount = boundary.throughCount;
  workingPlan.anchoredCount = boundary.anchoredCount;
  workingPlan.boundaryPartialCount = boundary.partialCount;

  const affectedMemberIds = new Set(actions.map((action) => action.memberId));
  const boundaryFailure = affectedBoundaryFailure(boundary, affectedMemberIds);
  if (boundaryFailure) {
    return unresolved(defaultRenderPlan, 'small-opening-slab-production-boundary-unresolved', {
      modelSource,
      targetPlan,
      actual,
      boundaryFailure,
      boundary,
    });
  }

  const finalized = finalizeProductionPaths(workingPlan, actions);
  if (!finalized.ok) {
    return unresolved(defaultRenderPlan, finalized.reason, {
      modelSource,
      targetPlan,
      actual,
      finalized,
    });
  }

  workingPlan.readyCount = workingPlan.checks.filter((check) => check.status === 'READY').length;
  workingPlan.specialCount = workingPlan.checks.filter((check) => check.specialRequired).length;
  workingPlan.production = Object.freeze({
    smallOpening: Object.freeze({
      status: 'READY',
      resolved: true,
      productionReady: true,
      reason: null,
      source: SOURCE,
      modelSource,
      replacementCount: actions.length,
      sourcePathCount: applied.used.size,
      openingCount: new Set(actions.map((action) => openingKey(action.memberId, action.openingId)))
        .size,
      boundaryReapplied: true,
      openingReinforcementSuppressed: false,
    }),
  });

  return Object.freeze({
    status: 'READY',
    resolved: true,
    productionReady: true,
    reason: null,
    source: SOURCE,
    modelSource,
    replacementCount: actions.length,
    sourcePathCount: applied.used.size,
    actions: Object.freeze(actions),
    boundary,
    targetPlan,
    actual,
    renderPlan: workingPlan,
  });
}

/**
 * O7c-B display adapter for normal slab mesh generation. Failed production
 * checks preserve the default render plan and report their status separately.
 */
export function buildSlabRebarProductionRenderPlan(xmlDoc, options = {}) {
  const result = buildSmallOpeningSlabProductionPlan(xmlDoc, options);
  if (result.status === 'NOT_CONFIGURED' || result.status === 'READY') {
    return result.renderPlan;
  }

  const basePlan =
    result.renderPlan || buildSlabRebarRenderPlan(xmlDoc, options.slabRenderOptions || options);
  return {
    ...basePlan,
    production: Object.freeze({
      ...(basePlan.production || {}),
      smallOpening: Object.freeze({
        status: result.status,
        resolved: result.resolved,
        productionReady: false,
        reason: result.reason,
        source: SOURCE,
        modelSource: normalizeModelSource(options.modelSource),
        replacementCount: 0,
      }),
    }),
  };
}

export const SMALL_OPENING_SLAB_PRODUCTION_SOURCE = SOURCE;

export const __testOnly = Object.freeze({
  rawSourceForActual,
  rebuildRawReplacement,
  applyActions,
  affectedBoundaryFailure,
  slabTargetConfiguration,
});
