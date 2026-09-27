/**
 * @fileoverview Issue #354 / #320 Phase 6b-O7b:
 * O7a exact slab target planをsigned BEND / SHIFT actual RebarPath candidateへ変換する。
 *
 * 通常slab render planへは接続せず、全targetがcurrent source / opening / project geometryと
 * exactに再照合できた場合だけ actualPathReady=true / productionReady=false を返す。
 */

import { SMALL_OPENING_REBAR_DEFLECTION_SOURCE } from '../../../config/smallOpeningRebarDeflectionProjectDetailing.js';
import { buildSmallOpeningRebarDeflectionEvaluations } from './smallOpeningRebarSourceFacts.js';
import { buildSmallOpeningSlabTargetPlan } from './smallOpeningSlabSourcePlan.js';
import { validateRebarPath } from './rebarPath.js';
import {
  MAX_GEOMETRY_TOLERANCE_MM,
  buildSlabBendLocalPath,
  buildSlabShiftLocalPath,
  pathInsideSlabAndOutsideOpening,
  pathOutsideOpening,
  sourceHasBoundaryDetailing,
  toSlabLocalPath,
  toSlabWorldPath,
} from './smallOpeningSlabActualPathGeometry.js';

const SOURCE = 'PHASE-6B-O7B-SMALL-OPENING-SLAB-ACTUAL-PATH';
const DEFAULT_TOLERANCE_MM = 1e-4;
const MAX_SHIFT_MM = 50;
const MAX_BEND_RATIO = 1 / 6;

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

function unresolved(reason, values = {}) {
  return Object.freeze({
    status: 'UNRESOLVED',
    resolved: false,
    actualPathReady: false,
    productionReady: false,
    reason,
    source: SOURCE,
    replacementPath: null,
    ...values,
  });
}

function rejected(reason, values = {}) {
  return Object.freeze({
    status: 'REJECTED',
    resolved: true,
    actualPathReady: false,
    productionReady: false,
    reason,
    source: SOURCE,
    replacementPath: null,
    ...values,
  });
}

function notConfigured(values = {}) {
  return Object.freeze({
    status: 'NOT_CONFIGURED',
    resolved: true,
    actualPathReady: false,
    productionReady: false,
    reason: null,
    source: SOURCE,
    replacementPath: null,
    ...values,
  });
}

function signatureNumber(value) {
  const number = finite(value);
  if (number === null) return null;
  const rounded = Math.round(number * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function vectorSignature(value) {
  if (!value) return null;
  return [signatureNumber(value.x), signatureNumber(value.y), signatureNumber(value.z)];
}

function primitiveSignature(primitive) {
  if (primitive?.type === 'line') {
    return ['line', vectorSignature(primitive.start), vectorSignature(primitive.end)];
  }
  if (primitive?.type === 'arc') {
    return [
      'arc',
      vectorSignature(primitive.center),
      signatureNumber(primitive.radius),
      vectorSignature(primitive.planeNormal),
      vectorSignature(primitive.startDirection),
      signatureNumber(primitive.sweepAngleRad),
    ];
  }
  return ['unknown'];
}

function targetPlanSignature(plan) {
  if (!plan || !Array.isArray(plan.openings)) return null;
  const rows = [];
  for (const openingResult of plan.openings) {
    if (openingResult?.status === 'NO_CROSSING') {
      const opening = openingResult.opening;
      rows.push([
        'NO_CROSSING',
        normalizeModelSource(opening?.modelSource),
        text(opening?.memberId),
        text(opening?.openingId),
      ]);
      continue;
    }
    if (!Array.isArray(openingResult?.targets)) return null;
    for (const entry of openingResult.targets) {
      const candidate = entry?.candidate;
      const target = entry?.target;
      const pathIndex = Number(candidate?.sourcePathIndex);
      const sourcePath =
        Number.isInteger(pathIndex) && pathIndex >= 0
          ? plan?.sourcePlan?.baseRenderPlan?.paths?.[pathIndex]
          : null;
      rows.push([
        'TARGET',
        normalizeModelSource(openingResult?.opening?.modelSource),
        text(openingResult?.opening?.memberId),
        text(openingResult?.opening?.openingId),
        text(target?.barIdentity),
        text(candidate?.barIdentity),
        Number.isInteger(pathIndex) ? pathIndex : null,
        signatureNumber(candidate?.diaMm),
        text(candidate?.strength)?.toUpperCase() || null,
        text(sourcePath?.metadata?.identityKey),
        signatureNumber(sourcePath?.metadata?.dia),
        text(sourcePath?.metadata?.strength)?.toUpperCase() || null,
        (sourcePath?.primitives || []).map(primitiveSignature),
      ]);
    }
  }
  rows.sort((left, right) => {
    const a = JSON.stringify(left);
    const b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return JSON.stringify({
    modelSource: normalizeModelSource(plan.modelSource),
    targetCount: Number(plan.targetCount),
    rows,
  });
}

function revalidateTargetPlan(
  xmlDoc,
  targetPlan,
  { modelSource, projectDetailing, toleranceMm, slabRenderOptions },
) {
  const current = buildSmallOpeningSlabTargetPlan(xmlDoc, {
    modelSource,
    projectDetailing,
    toleranceMm,
    slabRenderOptions,
  });
  if (
    current?.status !== 'READY' ||
    current?.resolved !== true ||
    current?.targetPlanReady !== true
  ) {
    return {
      ok: false,
      reason: current?.reason || 'small-opening-slab-actual-current-target-plan-unresolved',
      currentTargetPlan: current,
    };
  }

  const suppliedSignature = targetPlanSignature(targetPlan);
  const currentSignature = targetPlanSignature(current);
  if (!suppliedSignature || !currentSignature || suppliedSignature !== currentSignature) {
    return {
      ok: false,
      reason: 'small-opening-slab-actual-target-plan-stale',
      currentTargetPlan: current,
    };
  }
  return { ok: true, currentTargetPlan: current };
}

function sourceResolution(targetPlan, openingResult, targetEntry, toleranceMm) {
  const opening = openingResult?.opening;
  const candidate = targetEntry?.candidate;
  const target = targetEntry?.target;
  const baseRenderPlan = targetPlan?.sourcePlan?.baseRenderPlan;
  const sourcePathIndex = Number(candidate?.sourcePathIndex);
  const barIdentity = text(candidate?.barIdentity);
  if (
    !opening ||
    !candidate ||
    !target ||
    !Number.isInteger(sourcePathIndex) ||
    sourcePathIndex < 0 ||
    !barIdentity ||
    text(target?.barIdentity) !== barIdentity
  ) {
    return { ok: false, reason: 'small-opening-slab-actual-source-selector-invalid' };
  }

  const sourcePath = baseRenderPlan?.paths?.[sourcePathIndex];
  if (
    !sourcePath ||
    text(sourcePath?.metadata?.identityKey) !== barIdentity ||
    text(sourcePath?.metadata?.memberType)?.toUpperCase() !== 'SLAB' ||
    text(sourcePath?.metadata?.memberId) !== text(opening.memberId)
  ) {
    return { ok: false, reason: 'small-opening-slab-actual-source-stale' };
  }

  const runAxis = text(candidate.runAxis)?.toLowerCase();
  const crossCoordMm = finite(candidate.crossCoordMm);
  const runStartMm = finite(candidate.runStartMm);
  const runEndMm = finite(candidate.runEndMm);
  const diaMm = finite(candidate.diaMm);
  const sourceDiaMm = finite(sourcePath?.metadata?.dia);
  const candidateGrade = text(candidate.strength);
  const sourceGrade = text(sourcePath?.metadata?.strength);
  const grade = sourceGrade;
  if (
    (runAxis !== 'x' && runAxis !== 'y') ||
    crossCoordMm === null ||
    runStartMm === null ||
    runEndMm === null ||
    !(runEndMm > runStartMm) ||
    !(diaMm > 0) ||
    sourceDiaMm === null ||
    Math.abs(sourceDiaMm - diaMm) > toleranceMm ||
    (candidateGrade && sourceGrade && candidateGrade.toUpperCase() !== sourceGrade.toUpperCase()) ||
    !grade ||
    text(sourcePath?.metadata?.runAxis)?.toLowerCase() !== runAxis ||
    Math.abs((finite(sourcePath?.metadata?.crossCoordMm) ?? NaN) - crossCoordMm) > toleranceMm ||
    Math.abs((finite(sourcePath?.metadata?.runStartMm) ?? NaN) - runStartMm) > toleranceMm ||
    Math.abs((finite(sourcePath?.metadata?.runEndMm) ?? NaN) - runEndMm) > toleranceMm
  ) {
    return { ok: false, reason: 'small-opening-slab-actual-source-metadata-stale' };
  }

  const frame = opening.frame;
  const openingGeometry = opening.openingGeometry;
  if (!frame?.origin || !frame?.xAxis || !frame?.yAxis || !frame?.normal || !openingGeometry) {
    return { ok: false, reason: 'small-opening-slab-actual-frame-unresolved' };
  }
  const localPath = toSlabLocalPath(frame, sourcePath, {
    ...sourcePath.metadata,
    coordinateSpace: 'slab-local',
  });
  const validation = localPath ? validateRebarPath(localPath) : { ok: false };
  if (!localPath || !validation.ok) {
    return { ok: false, reason: 'small-opening-slab-actual-source-path-invalid' };
  }

  return {
    ok: true,
    sourcePath,
    sourcePathIndex,
    localPath,
    runAxis,
    crossCoordMm,
    runStartMm,
    runEndMm,
    diaMm,
    grade,
    frame,
    openingGeometry,
    boundaryRecheckRequired: sourceHasBoundaryDetailing(sourcePath),
  };
}

function evaluationKey(modelSource, memberId, openingId) {
  return `${modelSource}\u0000${memberId}\u0000${openingId}`;
}

function evaluationResolution(evaluation, modelSource, memberId, openingId) {
  const expectedSourceKey = `${modelSource}:SLAB:${memberId}:${openingId}`;
  if (
    !evaluation ||
    evaluation.status !== 'CANDIDATE' ||
    evaluation.resolved !== true ||
    evaluation.coverStatus !== 'PASS' ||
    evaluation.sizeGateStatus !== 'PASS' ||
    text(evaluation.sourceKey) !== expectedSourceKey ||
    text(evaluation.detailingSource) !== 'PROJECT_DETAILING' ||
    text(evaluation.projectSourceRef) !== SMALL_OPENING_REBAR_DEFLECTION_SOURCE ||
    !evaluation.deflectionGeometry
  ) {
    return {
      ok: false,
      reason: evaluation?.reason || 'small-opening-slab-evaluation-not-candidate',
    };
  }

  const method = text(evaluation.deflectionGeometry.method)?.toUpperCase();
  const eligible = evaluation.eligibleCandidates || [];
  if (
    (method !== 'SHIFT' && method !== 'BEND') ||
    eligible.length !== 1 ||
    (method === 'SHIFT' && eligible[0].disposition !== 'SHIFT_CANDIDATE') ||
    (method === 'BEND' && eligible[0].disposition !== 'BEND_CANDIDATE')
  ) {
    return { ok: false, reason: 'small-opening-slab-evaluation-method-ambiguous' };
  }

  return {
    ok: true,
    method,
    geometry: evaluation.deflectionGeometry,
    candidateType: eligible[0].disposition,
    candidateRuleId: eligible[0].ruleId,
  };
}

function actualMetadata(source, opening, geometry) {
  const sourceMetadata = source.sourcePath?.metadata || {};
  const method = geometry.method;
  const barIdentity = text(sourceMetadata.identityKey);
  return {
    ...sourceMetadata,
    coordinateSpace: 'world',
    identityKey: `slab:${opening.memberId}:small-opening:${opening.openingId}:${barIdentity}`,
    semanticIdentity: barIdentity,
    sourceIdentityKey: barIdentity,
    sourcePathIndex: source.sourcePathIndex,
    memberType: 'slab',
    memberId: text(opening.memberId),
    openingId: text(opening.openingId),
    modelSource: text(opening.modelSource),
    source: SOURCE,
    productionReady: false,
    boundaryRecheckRequired: source.boundaryRecheckRequired,
    deflectionMethod: method,
    shiftMm: method === 'SHIFT' ? finite(geometry.shiftMm) : null,
    bendOffsetMm: method === 'BEND' ? finite(geometry.bendOffsetMm) : null,
    bendRunMm: method === 'BEND' ? finite(geometry.bendRunMm) : null,
  };
}

function buildGeometry(source, evaluated, metadata, toleranceMm) {
  if (evaluated.method === 'SHIFT') {
    const shiftMm = finite(evaluated.geometry.shiftMm);
    if (shiftMm === null || Math.abs(shiftMm) > MAX_SHIFT_MM + toleranceMm) {
      return { ok: false, reason: 'small-opening-slab-shift-geometry-unresolved' };
    }
    const path = buildSlabShiftLocalPath({
      sourcePath: source.localPath,
      runAxis: source.runAxis,
      shiftMm,
      metadata,
    });
    return path
      ? { ok: true, path, bendFacts: null, boundaryRecheckRequired: true }
      : { ok: false, reason: 'small-opening-slab-shift-path-unresolved' };
  }

  const offsetMm = finite(evaluated.geometry.bendOffsetMm);
  const runMm = finite(evaluated.geometry.bendRunMm);
  if (
    offsetMm === null ||
    runMm === null ||
    !(runMm > 0) ||
    Math.abs(offsetMm) / runMm > MAX_BEND_RATIO + 1e-12
  ) {
    return { ok: false, reason: 'small-opening-slab-bend-geometry-unresolved' };
  }
  const built = buildSlabBendLocalPath({
    sourcePath: source.localPath,
    runAxis: source.runAxis,
    crossCoordMm: source.crossCoordMm,
    openingGeometry: source.openingGeometry,
    offsetMm,
    runMm,
    diaMm: source.diaMm,
    grade: source.grade,
    metadata,
    toleranceMm,
  });
  return built.ok
    ? {
        ok: true,
        path: built.path,
        bendFacts: Object.freeze({
          entryBendAnglesDeg: Object.freeze(built.firstBuilt.path.metadata.bendAnglesDeg || []),
          exitBendAnglesDeg: Object.freeze(built.secondBuilt.path.metadata.bendAnglesDeg || []),
        }),
      }
    : built;
}

function buildEntry(targetPlan, openingResult, targetEntry, evaluation, toleranceMm) {
  const opening = openingResult.opening;
  const common = {
    modelSource: normalizeModelSource(opening?.modelSource),
    memberId: text(opening?.memberId),
    openingId: text(opening?.openingId),
    barIdentity: text(targetEntry?.candidate?.barIdentity),
  };
  if (!common.modelSource || !common.memberId || !common.openingId || !common.barIdentity) {
    return unresolved('small-opening-slab-actual-entry-scope-unresolved', common);
  }

  const source = sourceResolution(targetPlan, openingResult, targetEntry, toleranceMm);
  if (!source.ok) return unresolved(source.reason, common);
  const evaluated = evaluationResolution(
    evaluation,
    common.modelSource,
    common.memberId,
    common.openingId,
  );
  if (!evaluated.ok) {
    const reason = evaluated.reason || 'small-opening-slab-evaluation-not-candidate';
    return reason.includes('failed') || evaluation?.status === 'REJECTED'
      ? rejected(reason, common)
      : unresolved(reason, common);
  }

  const metadata = actualMetadata(source, opening, evaluated.geometry);
  const built = buildGeometry(source, evaluated, metadata, toleranceMm);
  if (built?.boundaryRecheckRequired === true) {
    metadata.boundaryRecheckRequired = true;
  }
  if (!built.ok || !built.path) {
    return unresolved(built.reason || 'small-opening-slab-actual-path-unresolved', {
      ...common,
      doglegReason: built.doglegReason || null,
    });
  }

  const localValidation = validateRebarPath(built.path);
  if (!localValidation.ok) {
    return unresolved('small-opening-slab-actual-local-path-invalid', {
      ...common,
      validation: localValidation,
    });
  }
  const boundaryRecheckRequired =
    built.boundaryRecheckRequired === true || source.boundaryRecheckRequired;
  const geometryAccepted = boundaryRecheckRequired
    ? pathOutsideOpening(built.path, source.openingGeometry, toleranceMm)
    : pathInsideSlabAndOutsideOpening(
        built.path,
        source.frame,
        source.openingGeometry,
        toleranceMm,
      );
  if (!geometryAccepted) {
    return rejected('small-opening-slab-actual-path-intersects-opening-or-leaves-slab', common);
  }

  const replacementPath = toSlabWorldPath(source.frame, built.path, metadata);
  const validation = replacementPath
    ? validateRebarPath(replacementPath)
    : { ok: false, errors: [] };
  if (!replacementPath || !validation.ok) {
    return unresolved('small-opening-slab-actual-world-path-invalid', {
      ...common,
      validation,
    });
  }

  return Object.freeze({
    status: 'READY',
    resolved: true,
    actualPathReady: true,
    productionReady: false,
    reason: null,
    source: SOURCE,
    ...common,
    sourcePathIndex: source.sourcePathIndex,
    sourcePathIdentityKey: common.barIdentity,
    candidateType: evaluated.candidateType,
    candidateRuleId: evaluated.candidateRuleId,
    method: evaluated.method,
    boundaryRecheckRequired,
    productionReason: boundaryRecheckRequired
      ? 'small-opening-slab-boundary-recheck-required'
      : 'small-opening-slab-o7b-candidate-only',
    replacementPath,
    validation,
    bendFacts: built.bendFacts,
  });
}

/**
 * O7a target plan全体をatomicにactual slab path candidateへ変換する。
 */
export function buildSmallOpeningSlabActualPaths(
  xmlDoc,
  targetPlan,
  { projectDetailing, toleranceMm = DEFAULT_TOLERANCE_MM, slabRenderOptions = {} } = {},
) {
  const tolerance = finite(toleranceMm);
  if (tolerance === null || tolerance < 0 || tolerance > MAX_GEOMETRY_TOLERANCE_MM) {
    throw new RangeError(
      `small opening slab actual toleranceMm must be between 0 and ${MAX_GEOMETRY_TOLERANCE_MM}mm`,
    );
  }

  const modelSource = normalizeModelSource(targetPlan?.modelSource);
  if (
    targetPlan?.status !== 'READY' ||
    targetPlan?.resolved !== true ||
    targetPlan?.targetPlanReady !== true ||
    targetPlan?.sourcePlan?.status !== 'READY' ||
    !modelSource ||
    !Array.isArray(targetPlan?.openings)
  ) {
    return unresolved(targetPlan?.reason || 'small-opening-slab-actual-target-plan-not-ready', {
      modelSource,
      entries: Object.freeze([]),
      candidateResults: Object.freeze([]),
    });
  }
  if (!(targetPlan.targetCount > 0)) {
    return notConfigured({
      modelSource,
      entries: Object.freeze([]),
      candidateResults: Object.freeze([]),
      targetPlan,
    });
  }

  const revalidated = revalidateTargetPlan(xmlDoc, targetPlan, {
    modelSource,
    projectDetailing,
    toleranceMm: tolerance,
    slabRenderOptions,
  });
  if (!revalidated.ok) {
    return unresolved(revalidated.reason, {
      modelSource,
      entries: Object.freeze([]),
      candidateResults: Object.freeze([]),
      targetPlan,
      currentTargetPlan: revalidated.currentTargetPlan,
    });
  }
  const currentTargetPlan = revalidated.currentTargetPlan;

  const evaluations = buildSmallOpeningRebarDeflectionEvaluations(xmlDoc, {
    modelSource,
    projectDetailing,
    ...slabRenderOptions,
  }).filter((evaluation) => evaluation?.memberType === 'StbSlab');
  const evaluationMap = new Map(
    evaluations.map((evaluation) => [
      evaluationKey(modelSource, text(evaluation.memberId), text(evaluation.openingId)),
      evaluation,
    ]),
  );

  const candidateResults = [];
  const usedSourcePathIndexes = new Set();
  for (const openingResult of currentTargetPlan.openings) {
    if (openingResult?.status === 'NO_CROSSING') continue;
    if (
      openingResult?.status !== 'READY' ||
      openingResult?.resolved !== true ||
      openingResult?.targetPlanReady !== true ||
      !Array.isArray(openingResult?.targets)
    ) {
      return unresolved('small-opening-slab-actual-opening-target-not-ready', {
        modelSource,
        entries: Object.freeze([]),
        candidateResults: Object.freeze(candidateResults),
      });
    }
    const opening = openingResult.opening;
    const key = evaluationKey(modelSource, text(opening?.memberId), text(opening?.openingId));
    const evaluation = evaluationMap.get(key);
    if (!evaluation) {
      return unresolved('small-opening-slab-evaluation-not-found', {
        modelSource,
        failedOpening: opening,
        entries: Object.freeze([]),
        candidateResults: Object.freeze(candidateResults),
      });
    }

    for (const targetEntry of openingResult.targets) {
      const result = buildEntry(
        currentTargetPlan,
        openingResult,
        targetEntry,
        evaluation,
        tolerance,
      );
      candidateResults.push(result);
      if (result.status !== 'READY' || result.actualPathReady !== true) continue;
      if (usedSourcePathIndexes.has(result.sourcePathIndex)) {
        return unresolved('small-opening-slab-actual-source-path-reused', {
          modelSource,
          failedSourcePathIndex: result.sourcePathIndex,
          entries: Object.freeze([]),
          candidateResults: Object.freeze(candidateResults),
        });
      }
      usedSourcePathIndexes.add(result.sourcePathIndex);
    }
  }

  const failed = candidateResults.filter(
    (result) => result.status !== 'READY' || result.actualPathReady !== true,
  );
  if (failed.length > 0) {
    const values = {
      modelSource,
      entries: Object.freeze([]),
      candidateResults: Object.freeze(candidateResults),
      targetPlan: currentTargetPlan,
      inputTargetPlan: targetPlan,
    };
    const reason = failed[0].reason || 'small-opening-slab-actual-group-unresolved';
    return failed.every((result) => result.status === 'REJECTED')
      ? rejected(reason, values)
      : unresolved(reason, values);
  }

  if (candidateResults.length !== currentTargetPlan.targetCount) {
    return unresolved('small-opening-slab-actual-target-cardinality-mismatch', {
      modelSource,
      entries: Object.freeze([]),
      candidateResults: Object.freeze(candidateResults),
      targetPlan: currentTargetPlan,
      inputTargetPlan: targetPlan,
    });
  }

  const entries = Object.freeze(candidateResults);
  const memberIds = [...new Set(entries.map((entry) => entry.memberId))];
  const openingIds = [...new Set(entries.map((entry) => entry.openingId))];
  return Object.freeze({
    status: 'READY',
    resolved: true,
    actualPathReady: true,
    productionReady: false,
    reason: null,
    source: SOURCE,
    modelSource,
    memberId: memberIds.length === 1 ? memberIds[0] : null,
    openingId: openingIds.length === 1 ? openingIds[0] : null,
    targetCount: entries.length,
    entries,
    candidateResults: entries,
    replacementPaths: Object.freeze(entries.map((entry) => entry.replacementPath)),
    sourcePathIndexes: Object.freeze(
      [...usedSourcePathIndexes].sort((left, right) => left - right),
    ),
    productionReason: 'small-opening-slab-o7c-production-wiring-required',
    targetPlan: currentTargetPlan,
    inputTargetPlan: targetPlan,
  });
}

export const SMALL_OPENING_SLAB_ACTUAL_PATH_SOURCE = SOURCE;

export const __testOnly = Object.freeze({
  targetPlanSignature,
});
