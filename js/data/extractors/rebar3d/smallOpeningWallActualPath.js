/**
 * @fileoverview Issue #337 / #320 Phase 6b-O5:
 * explicit small-opening wallMain mutation planをactual RebarPath candidateへ変換する。
 *
 * source path / opening / bar identity / signed deflection geometryが一意に成立する場合だけ
 * actual centerlineを生成する。renderPlan自体は変更せず、production wiringは後段へ分離する。
 */

import { collectWallRebarFacts, getWallRebarCoverOverride } from './wallRebarSectionFacts.js';
import { buildWallFrame } from './wallRebarGeometry.js';
import { getWallRebarSourceFingerprint } from './wallRebarPlacement.js';
import {
  createLine,
  createRebarPath,
  getPathEnd,
  getPathStart,
  validateRebarPath,
} from './rebarPath.js';
import { buildDoglegTransitionPath } from './rebarTransitionArcGeometry.js';
import {
  buildSmallOpeningWallOpeningProfile,
  pathInsideWallAndOutsideOpening,
} from './smallOpeningWallActualPathValidation.js';
import { validateSmallOpeningWallActualPathAggregatePlan } from './smallOpeningWallActualPathAggregate.js';
import {
  axisDirection,
  axisValue,
  resolveSmallOpeningWallActualPathSource,
  setAxisValue,
  setCrossAxisValue,
} from './smallOpeningWallActualPathSource.js';
import { SMALL_OPENING_REBAR_DEFLECTION_SOURCE } from '../../../config/smallOpeningRebarDeflectionProjectDetailing.js';

const SOURCE = 'PHASE-6B-O5-SMALL-OPENING-WALL-ACTUAL-PATH';
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

function unresolved(reason, extra = {}) {
  return Object.freeze({
    status: 'UNRESOLVED',
    resolved: false,
    actualPathReady: false,
    productionReady: false,
    reason,
    source: SOURCE,
    replacementPath: null,
    ...extra,
  });
}

function rejected(reason, extra = {}) {
  return Object.freeze({
    status: 'REJECTED',
    resolved: true,
    actualPathReady: false,
    productionReady: false,
    reason,
    source: SOURCE,
    replacementPath: null,
    ...extra,
  });
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale(value, factor) {
  return { x: value.x * factor, y: value.y * factor, z: value.z * factor };
}

function magnitude(value) {
  return Math.hypot(value.x, value.y, value.z);
}

function distance(a, b) {
  return magnitude(subtract(a, b));
}

function localToWorld(frame, point) {
  return add(
    add(add(frame.origin, scale(frame.xAxis, point.x)), scale(frame.yAxis, point.y)),
    scale(frame.zAxis, point.z || 0),
  );
}

function localVectorToWorld(frame, vector) {
  return add(
    add(scale(frame.xAxis, vector.x), scale(frame.yAxis, vector.y)),
    scale(frame.zAxis, vector.z || 0),
  );
}

function transformPrimitiveToWorld(frame, primitive) {
  if (primitive?.type === 'line') {
    return createLine(localToWorld(frame, primitive.start), localToWorld(frame, primitive.end));
  }
  if (primitive?.type === 'arc') {
    return {
      ...primitive,
      center: localToWorld(frame, primitive.center),
      planeNormal: localVectorToWorld(frame, primitive.planeNormal),
      startDirection: localVectorToWorld(frame, primitive.startDirection),
    };
  }
  return null;
}

function translatePrimitive(primitive, delta) {
  if (primitive?.type === 'line') {
    return createLine(add(primitive.start, delta), add(primitive.end, delta));
  }
  if (primitive?.type === 'arc') {
    return { ...primitive, center: add(primitive.center, delta) };
  }
  return null;
}

function translatedPath(path, delta) {
  const primitives = (path?.primitives || []).map((primitive) =>
    translatePrimitive(primitive, delta),
  );
  if (primitives.some((primitive) => !primitive)) return null;
  return createRebarPath(primitives, path?.metadata || {});
}

function referencePointsForWall(wall, nodes) {
  const points = [];
  for (const nodeId of wall?.nodeIds || []) {
    const node = nodes?.get?.(String(nodeId));
    if (!node) return null;
    const offset = wall?.offsets?.get?.(String(nodeId)) || { x: 0, y: 0, z: 0 };
    const x = finite(node.x);
    const y = finite(node.y);
    const z = finite(node.z);
    if (x === null || y === null || z === null) return null;
    points.push({
      x: x + (finite(offset.x) ?? 0),
      y: y + (finite(offset.y) ?? 0),
      z: z + (finite(offset.z) ?? 0),
    });
  }
  return points;
}

function geometryProvenanceMatches(entry) {
  const modelSource = text(entry?.modelSource);
  const memberId = text(entry?.memberId);
  const openingId = text(entry?.openingId);
  const expectedSourceKey =
    modelSource && memberId && openingId ? `${modelSource}:WALL:${memberId}:${openingId}` : null;
  if (!expectedSourceKey || text(entry?.evaluationSourceKey) !== expectedSourceKey) return false;

  const detailingSource = text(entry?.detailingSource);
  const projectSourceRef = text(entry?.projectSourceRef);
  if (detailingSource === 'CALLER_OVERRIDE') return projectSourceRef === null;
  if (detailingSource === 'PROJECT_DETAILING') {
    return projectSourceRef === SMALL_OPENING_REBAR_DEFLECTION_SOURCE;
  }
  return false;
}

function buildShiftLocalPath(source, shiftMm, metadata) {
  const shiftedCross = source.baseCross + shiftMm;
  const start = setCrossAxisValue(source.beforeOuter, source.direction, shiftedCross);
  const end = setCrossAxisValue(source.afterOuter, source.direction, shiftedCross);
  return createRebarPath([createLine(start, end)], metadata);
}

function concatLocalPaths(parts, metadata, toleranceMm) {
  const primitives = [];
  for (const part of parts) {
    if (!part) continue;
    const partPrimitives = part.primitives || [];
    for (const primitive of partPrimitives) {
      const previous = primitives[primitives.length - 1];
      if (previous) {
        const previousEnd =
          previous.type === 'line' ? previous.end : getPathEnd(createRebarPath([previous]));
        const currentStart =
          primitive.type === 'line' ? primitive.start : getPathStart(createRebarPath([primitive]));
        if (distance(previousEnd, currentStart) > toleranceMm) return null;
      }
      primitives.push(primitive);
    }
  }
  return primitives.length ? createRebarPath(primitives, metadata) : null;
}

function optionalLine(start, end, dia, grade, toleranceMm) {
  if (distance(start, end) <= toleranceMm) return null;
  return createRebarPath([createLine(start, end)], { dia, grade });
}

function buildBendLocalPath(source, geometry, entry, metadata, toleranceMm) {
  const offsetMm = finite(geometry?.bendOffsetMm);
  const runMm = finite(geometry?.bendRunMm);
  const diaMm = finite(entry?.diaMm);
  const grade = text(entry?.grade);
  if (
    offsetMm === null ||
    runMm === null ||
    !(runMm > 0) ||
    Math.abs(offsetMm) / runMm > 1 / 6 + 1e-12 ||
    diaMm === null ||
    !grade
  ) {
    return unresolved('small-opening-wall-bend-source-geometry-unresolved');
  }

  const direction = source.direction;
  const axis = axisDirection(direction);
  const shiftedCross = source.baseCross + offsetMm;
  const baseZ = source.z;

  const firstSharpStart = setCrossAxisValue({ x: 0, y: 0, z: baseZ }, direction, source.baseCross);
  const firstSharpEnd = setCrossAxisValue(
    setAxisValue({ x: 0, y: 0, z: baseZ }, direction, runMm),
    direction,
    shiftedCross,
  );
  const firstBuilt = buildDoglegTransitionPath({
    sharpStart: firstSharpStart,
    sharpEnd: firstSharpEnd,
    incomingDirection: axis,
    outgoingDirection: axis,
    grade,
    barDiaMm: diaMm,
    metadata: { diaName: entry?.diaName || null },
  });
  if (!firstBuilt.ok || !firstBuilt.path) {
    return unresolved('small-opening-wall-bend-entry-dogleg-unresolved', {
      doglegReason: firstBuilt.reason || null,
    });
  }

  const desiredFirstEnd = setCrossAxisValue(source.gapStart, direction, shiftedCross);
  const firstEnd = getPathEnd(firstBuilt.path);
  const firstPath = translatedPath(firstBuilt.path, subtract(desiredFirstEnd, firstEnd));
  if (!firstPath) return unresolved('small-opening-wall-bend-entry-transform-unresolved');

  const secondSharpStart = setCrossAxisValue({ x: 0, y: 0, z: baseZ }, direction, shiftedCross);
  const secondSharpEnd = setCrossAxisValue(
    setAxisValue({ x: 0, y: 0, z: baseZ }, direction, runMm),
    direction,
    source.baseCross,
  );
  const secondBuilt = buildDoglegTransitionPath({
    sharpStart: secondSharpStart,
    sharpEnd: secondSharpEnd,
    incomingDirection: axis,
    outgoingDirection: axis,
    grade,
    barDiaMm: diaMm,
    metadata: { diaName: entry?.diaName || null },
  });
  if (!secondBuilt.ok || !secondBuilt.path) {
    return unresolved('small-opening-wall-bend-exit-dogleg-unresolved', {
      doglegReason: secondBuilt.reason || null,
    });
  }

  const desiredSecondStart = setCrossAxisValue(source.gapEnd, direction, shiftedCross);
  const secondStart = getPathStart(secondBuilt.path);
  const secondPath = translatedPath(secondBuilt.path, subtract(desiredSecondStart, secondStart));
  if (!secondPath) return unresolved('small-opening-wall-bend-exit-transform-unresolved');

  const firstStart = getPathStart(firstPath);
  const secondEnd = getPathEnd(secondPath);
  if (
    !(axisValue(firstStart, direction) > axisValue(source.beforeOuter, direction) + toleranceMm) ||
    !(axisValue(secondEnd, direction) < axisValue(source.afterOuter, direction) - toleranceMm)
  ) {
    return unresolved('small-opening-wall-bend-run-does-not-fit-source-span');
  }

  const prefix = optionalLine(source.beforeOuter, firstStart, diaMm, grade, toleranceMm);
  const central = optionalLine(
    getPathEnd(firstPath),
    getPathStart(secondPath),
    diaMm,
    grade,
    toleranceMm,
  );
  const suffix = optionalLine(secondEnd, source.afterOuter, diaMm, grade, toleranceMm);
  if (!central) return unresolved('small-opening-wall-bend-central-run-unresolved');

  const path = concatLocalPaths(
    [prefix, firstPath, central, secondPath, suffix],
    metadata,
    toleranceMm,
  );
  if (!path) return unresolved('small-opening-wall-bend-path-discontinuous');
  return { status: 'READY', path, firstBuilt, secondBuilt };
}

function actualMetadata(source, entry) {
  const sourceMetadata = source.beforePath?.metadata || {};
  return {
    ...sourceMetadata,
    coordinateSpace: 'world',
    dia: Number(entry.diaMm),
    diaName: entry.diaName || sourceMetadata.diaName || null,
    grade: entry.grade || sourceMetadata.grade || sourceMetadata.strength || null,
    strength: entry.grade || sourceMetadata.strength || null,
    memberType: 'wall',
    memberId: String(entry.memberId),
    role: 'wallMain',
    source: SOURCE,
    ruleId: entry.candidateRuleId || null,
    openingId: String(entry.openingId),
    semanticIdentity: entry.barIdentity,
    identityKey: `wall:${entry.memberId}:small-opening:${entry.openingId}:${entry.barIdentity}`,
    deflectionMethod:
      entry.candidateType === 'BEND_CANDIDATE'
        ? 'BEND'
        : entry.candidateType === 'SHIFT_CANDIDATE'
          ? 'SHIFT'
          : null,
    sourcePathIdentityKeys: [
      source.beforePath?.metadata?.identityKey || null,
      source.afterPath?.metadata?.identityKey || null,
    ],
  };
}

function toWorldPath(frame, localPath, metadata) {
  const primitives = (localPath?.primitives || []).map((primitive) =>
    transformPrimitiveToWorld(frame, primitive),
  );
  if (primitives.some((primitive) => !primitive)) return null;
  return createRebarPath(primitives, metadata);
}

/**
 * O3/O4 mutation plan entry 1本をactual RebarPath candidateへ変換する。
 */
export function buildSmallOpeningWallActualPath(
  xmlDoc,
  renderPlan,
  entry,
  { toleranceMm = DEFAULT_TOLERANCE_MM, wallRenderOptions = {} } = {},
) {
  const tolerance = finite(toleranceMm);
  if (tolerance === null || tolerance < 0) {
    throw new RangeError('small opening actual path toleranceMm must be finite and non-negative');
  }

  const common = {
    openingId: text(entry?.openingId),
    memberId: text(entry?.memberId),
    modelSource: text(entry?.modelSource),
    barIdentity: text(entry?.barIdentity),
  };
  if (
    entry?.status !== 'READY' ||
    entry?.resolved !== true ||
    entry?.pathPlanReady !== true ||
    !common.openingId ||
    !common.memberId ||
    !common.modelSource ||
    !common.barIdentity
  ) {
    return unresolved(entry?.reason || 'small-opening-wall-actual-path-plan-not-ready', common);
  }
  if (!geometryProvenanceMatches(entry)) {
    return unresolved('small-opening-wall-actual-path-geometry-provenance-mismatch', common);
  }
  if (text(renderPlan?.provenance?.modelSource) !== common.modelSource) {
    return unresolved('small-opening-wall-actual-path-model-source-mismatch', {
      ...common,
      renderPlanModelSource: text(renderPlan?.provenance?.modelSource),
    });
  }

  const expectedCoverMm = getWallRebarCoverOverride(wallRenderOptions);
  if (expectedCoverMm !== renderPlan?.provenance?.coverMm) {
    return unresolved('small-opening-wall-actual-path-render-options-mismatch', common);
  }

  const facts = collectWallRebarFacts(xmlDoc, wallRenderOptions);
  const renderPlanSourceFingerprint = text(
    renderPlan?.provenance?.wallSourceFingerprints?.[common.memberId],
  );
  if (
    !renderPlanSourceFingerprint ||
    renderPlanSourceFingerprint !== getWallRebarSourceFingerprint(facts, common.memberId)
  ) {
    return unresolved('small-opening-wall-actual-path-source-fingerprint-mismatch', common);
  }

  const walls = (facts?.walls || []).filter((wall) => String(wall?.id) === common.memberId);
  if (walls.length !== 1) {
    return unresolved('small-opening-wall-actual-path-member-unresolved', common);
  }
  const wall = walls[0];
  const openingMatches = (wall.openings || []).filter(
    (opening) => String(opening?.id) === common.openingId,
  );
  if (openingMatches.length !== 1) {
    return unresolved('small-opening-wall-actual-path-opening-unresolved', common);
  }
  const points = referencePointsForWall(wall, facts.nodes);
  const frame = points ? buildWallFrame(points) : null;
  const opening = buildSmallOpeningWallOpeningProfile(openingMatches[0]);
  if (!frame || !opening) {
    return unresolved('small-opening-wall-actual-path-geometry-unresolved', common);
  }

  const sourceResolution = resolveSmallOpeningWallActualPathSource(
    renderPlan,
    entry,
    frame,
    common.modelSource,
    tolerance,
  );
  if (!sourceResolution.ok || !sourceResolution.source) {
    return unresolved(
      sourceResolution.reason || 'small-opening-wall-actual-path-source-stale',
      common,
    );
  }
  const source = sourceResolution.source;

  const metadata = actualMetadata(source, entry);
  if (!metadata.deflectionMethod) {
    return unresolved('small-opening-wall-actual-path-method-unresolved', common);
  }
  if (text(entry?.geometry?.method) !== metadata.deflectionMethod) {
    return unresolved('small-opening-wall-actual-path-signed-geometry-mismatch', common);
  }

  let localPath = null;
  let bendFacts = null;
  if (metadata.deflectionMethod === 'SHIFT') {
    const shiftMm = finite(entry?.geometry?.shiftMm);
    if (shiftMm === null || Math.abs(shiftMm) > 50 + tolerance) {
      return unresolved('small-opening-wall-shift-geometry-unresolved', common);
    }
    localPath = buildShiftLocalPath(source, shiftMm, { dia: entry.diaMm, grade: entry.grade });
    metadata.shiftMm = shiftMm;
    metadata.bendGeometry = 'straight-shift';
  } else {
    const built = buildBendLocalPath(source, entry?.geometry, entry, metadata, tolerance);
    if (built.status !== 'READY' || !built.path) {
      return unresolved(built.reason || 'small-opening-wall-bend-path-unresolved', {
        ...common,
        doglegReason: built.doglegReason || null,
      });
    }
    localPath = built.path;
    bendFacts = built;
    metadata.bendOffsetMm = finite(entry?.geometry?.bendOffsetMm);
    metadata.bendRunMm = finite(entry?.geometry?.bendRunMm);
    metadata.bendGeometry = 'actual-arc';
  }

  const localValidation = validateRebarPath(localPath);
  if (!localValidation.ok) {
    return unresolved('small-opening-wall-actual-local-path-invalid', {
      ...common,
      validation: localValidation,
    });
  }
  if (!pathInsideWallAndOutsideOpening(localPath, frame.profile, opening, tolerance)) {
    return rejected('small-opening-wall-actual-path-intersects-opening-or-leaves-wall', common);
  }

  const replacementPath = toWorldPath(frame, localPath, metadata);
  const validation = replacementPath
    ? validateRebarPath(replacementPath)
    : { ok: false, errors: [] };
  if (!replacementPath || !validation.ok) {
    return unresolved('small-opening-wall-actual-world-path-invalid', {
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
    method: metadata.deflectionMethod,
    candidateType: entry.candidateType,
    candidateRuleId: entry.candidateRuleId,
    sourcePathIndexes: Object.freeze([source.beforePathIndex, source.afterPathIndex]),
    sourcePathIdentityKeys: Object.freeze([...metadata.sourcePathIdentityKeys]),
    replacementPath,
    validation,
    bendFacts:
      bendFacts === null
        ? null
        : Object.freeze({
            entryBendAnglesDeg: Object.freeze(
              bendFacts.firstBuilt.path.metadata.bendAnglesDeg || [],
            ),
            exitBendAnglesDeg: Object.freeze(
              bendFacts.secondBuilt.path.metadata.bendAnglesDeg || [],
            ),
          }),
  });
}

/**
 * O4 aggregate mutation planの全explicit targetをatomicにactual pathへ変換する。
 */
export function buildSmallOpeningWallActualPaths(xmlDoc, renderPlan, mutationPlan, options = {}) {
  if (
    mutationPlan?.status !== 'READY' ||
    mutationPlan?.resolved !== true ||
    mutationPlan?.pathPlanReady !== true ||
    !Array.isArray(mutationPlan?.entries) ||
    mutationPlan.entries.length === 0
  ) {
    return unresolved(mutationPlan?.reason || 'small-opening-wall-actual-path-group-not-ready', {
      entries: Object.freeze([]),
      candidateResults: Object.freeze([]),
    });
  }

  const aggregateContract = validateSmallOpeningWallActualPathAggregatePlan(mutationPlan);
  if (!aggregateContract.ok) {
    return unresolved(aggregateContract.reason, {
      openingId: aggregateContract.openingId,
      memberId: aggregateContract.memberId,
      modelSource: aggregateContract.modelSource,
      entries: Object.freeze([]),
      candidateResults: Object.freeze([]),
    });
  }

  const candidateResults = mutationPlan.entries.map((entry) =>
    buildSmallOpeningWallActualPath(xmlDoc, renderPlan, entry, options),
  );
  const failed = candidateResults.filter(
    (result) => result.status !== 'READY' || result.actualPathReady !== true,
  );
  if (failed.length > 0) {
    const failureValues = {
      openingId: text(mutationPlan.openingId),
      memberId: text(mutationPlan.memberId),
      modelSource: text(mutationPlan.modelSource),
      entries: Object.freeze([]),
      candidateResults: Object.freeze(candidateResults),
    };
    const reason = failed[0].reason || 'small-opening-wall-actual-path-group-unresolved';
    return failed.every((result) => result.status === 'REJECTED')
      ? rejected(reason, failureValues)
      : unresolved(reason, failureValues);
  }

  const usedSourceIndexes = new Set();
  for (const result of candidateResults) {
    for (const index of result.sourcePathIndexes || []) {
      if (usedSourceIndexes.has(index)) {
        return unresolved('small-opening-wall-actual-path-source-reused', {
          openingId: text(mutationPlan.openingId),
          memberId: text(mutationPlan.memberId),
          modelSource: text(mutationPlan.modelSource),
          entries: Object.freeze([]),
          candidateResults: Object.freeze(candidateResults),
        });
      }
      usedSourceIndexes.add(index);
    }
  }

  return Object.freeze({
    status: 'READY',
    resolved: true,
    actualPathReady: true,
    productionReady: false,
    reason: null,
    source: SOURCE,
    openingId: text(mutationPlan.openingId),
    memberId: text(mutationPlan.memberId),
    modelSource: text(mutationPlan.modelSource),
    entryCount: candidateResults.length,
    entries: Object.freeze(candidateResults),
    candidateResults: Object.freeze(candidateResults),
    replacementPaths: Object.freeze(candidateResults.map((result) => result.replacementPath)),
    sourcePathIndexes: Object.freeze([...usedSourceIndexes].sort((a, b) => a - b)),
  });
}

export const SMALL_OPENING_WALL_ACTUAL_PATH_SOURCE = SOURCE;
