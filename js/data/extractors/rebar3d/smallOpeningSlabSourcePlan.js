/**
 * @fileoverview Issue #350 / #320 Phase 6b-O7a:
 * RCスラブ小開口のsource RebarPath / exact bar identity / crossing factsを構築する。
 *
 * production geometry mutationは行わず、既存SLAB_OPENING_DEFERREDをdefaultのまま維持する。
 */

import { resolveSmallOpeningRebarDeflectionTargets } from '../../../config/smallOpeningRebarDeflectionTargetProjectDetailing.js';
import { buildSlabRebarSmallOpeningSourceRenderPlan } from './slabRebarPlacement.js';
import { appliedVertices, buildRectFrame } from './slabRebarGeometry.js';
import { getNodeIds, getOffsets, readNodeMap } from './slabRebarSectionFacts.js';
import { collectSmallOpeningRebarSourceFacts } from './smallOpeningRebarSourceFacts.js';

const SOURCE = 'PHASE-6B-O7A-SMALL-OPENING-SLAB-SOURCE';
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

function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function worldToLocal(frame, point) {
  const rel = subtract(point, frame.origin);
  return {
    x: dot(rel, frame.xAxis),
    y: dot(rel, frame.yAxis),
    z: dot(rel, frame.normal),
  };
}

function openingPoint(opening, u, v) {
  const cos = Math.cos(opening.rotationRad);
  const sin = Math.sin(opening.rotationRad);
  return {
    x: opening.positionX + u * cos - v * sin,
    y: opening.positionY + u * sin + v * cos,
  };
}

function openingGeometry(fact, frame, toleranceMm) {
  const positionX = finite(fact?.positionXMm);
  const positionY = finite(fact?.positionYMm);
  const width = finite(fact?.openingWidthMm);
  const height = finite(fact?.openingHeightMm);
  const rotateDeg = finite(fact?.rotateDeg);
  if (
    positionX === null ||
    positionY === null ||
    !(width > 0) ||
    !(height > 0) ||
    rotateDeg === null
  ) {
    return {
      ok: false,
      reason: 'small-opening-slab-opening-geometry-unresolved',
    };
  }

  const rotationRad = (rotateDeg * Math.PI) / 180;
  const opening = {
    positionX,
    positionY,
    width,
    height,
    rotateDeg,
    rotationRad,
  };
  const corners = [
    openingPoint(opening, 0, 0),
    openingPoint(opening, width, 0),
    openingPoint(opening, width, height),
    openingPoint(opening, 0, height),
  ];
  const inside = corners.every(
    (point) =>
      point.x >= -toleranceMm &&
      point.x <= frame.width + toleranceMm &&
      point.y >= -toleranceMm &&
      point.y <= frame.height + toleranceMm,
  );
  if (!inside) {
    return {
      ok: false,
      reason: 'small-opening-slab-opening-outside-member',
      corners,
    };
  }

  return {
    ok: true,
    opening: Object.freeze({
      ...opening,
      corners: Object.freeze(corners.map((point) => Object.freeze({ ...point }))),
    }),
  };
}

function toOpeningCoordinates(opening, point) {
  const dx = point.x - opening.positionX;
  const dy = point.y - opening.positionY;
  const cos = Math.cos(opening.rotationRad);
  const sin = Math.sin(opening.rotationRad);
  return {
    u: dx * cos + dy * sin,
    v: -dx * sin + dy * cos,
  };
}

function clipAxis(start, delta, min, max, interval) {
  if (Math.abs(delta) <= 1e-12) {
    return start >= min && start <= max ? interval : null;
  }
  const first = (min - start) / delta;
  const second = (max - start) / delta;
  const low = Math.min(first, second);
  const high = Math.max(first, second);
  const t0 = Math.max(interval[0], low);
  const t1 = Math.min(interval[1], high);
  return t0 <= t1 ? [t0, t1] : null;
}

function segmentCrossesOpeningInterior(start, end, opening, toleranceMm) {
  const a = toOpeningCoordinates(opening, start);
  const b = toOpeningCoordinates(opening, end);
  const minU = toleranceMm;
  const maxU = opening.width - toleranceMm;
  const minV = toleranceMm;
  const maxV = opening.height - toleranceMm;
  if (!(maxU > minU && maxV > minV)) return false;

  let interval = [0, 1];
  interval = clipAxis(a.u, b.u - a.u, minU, maxU, interval);
  if (!interval) return false;
  interval = clipAxis(a.v, b.v - a.v, minV, maxV, interval);
  if (!interval) return false;
  return interval[1] - interval[0] > 1e-12;
}

function pathCrossesOpening(path, frame, opening, toleranceMm) {
  for (const primitive of path?.primitives || []) {
    if (primitive?.type !== 'line') continue;
    const start = worldToLocal(frame, primitive.start);
    const end = worldToLocal(frame, primitive.end);
    if (segmentCrossesOpeningInterior(start, end, opening, toleranceMm)) return true;
  }
  return false;
}

function slabElementsById(xmlDoc) {
  const map = new Map();
  for (const element of Array.from(xmlDoc?.getElementsByTagName?.('StbSlab') || [])) {
    const id = text(element.getAttribute('id'));
    if (id) map.set(id, element);
  }
  return map;
}

function frameForSlab(slabElement, nodes) {
  if (!slabElement) return null;
  const nodeIds = getNodeIds(slabElement);
  const vertices = appliedVertices(nodeIds, nodes, getOffsets(slabElement));
  return buildRectFrame(vertices);
}

function candidateFromPath(path, pathIndex, openingFact) {
  const barIdentity = text(path?.metadata?.identityKey);
  if (!barIdentity) return null;
  return Object.freeze({
    modelSource: openingFact.modelSource,
    memberType: 'SLAB',
    memberId: text(openingFact.memberId),
    openingId: text(openingFact.openingId),
    barIdentity,
    sourcePathIndex: pathIndex,
    position: text(path?.metadata?.position),
    direction: text(path?.metadata?.direction),
    face: text(path?.metadata?.face),
    zone: text(path?.metadata?.zone),
    diaMm: finite(path?.metadata?.dia),
    pitchMm: finite(path?.metadata?.pitchMm),
    strength: text(path?.metadata?.strength),
    runAxis: text(path?.metadata?.runAxis),
    crossCoordMm: finite(path?.metadata?.crossCoordMm),
    runStartMm: finite(path?.metadata?.runStartMm),
    runEndMm: finite(path?.metadata?.runEndMm),
  });
}

function sourceFailure(reason, values = {}) {
  return Object.freeze({
    status: 'UNRESOLVED',
    resolved: false,
    sourceReady: false,
    productionReady: false,
    reason,
    source: SOURCE,
    openings: Object.freeze([]),
    ...values,
  });
}

/**
 * O7a source-only slab opening plan.
 */
export function buildSmallOpeningSlabSourcePlan(
  xmlDoc,
  { modelSource = null, toleranceMm = DEFAULT_TOLERANCE_MM, slabRenderOptions = {} } = {},
) {
  const normalizedModelSource = normalizeModelSource(modelSource);
  const tolerance = finite(toleranceMm);
  if (!normalizedModelSource) {
    return sourceFailure('small-opening-slab-model-source-unresolved');
  }
  if (tolerance === null || tolerance < 0) {
    throw new RangeError('small opening slab source toleranceMm must be finite and non-negative');
  }
  if (!xmlDoc) return sourceFailure('small-opening-slab-xml-missing');

  const baseRenderPlan = buildSlabRebarSmallOpeningSourceRenderPlan(xmlDoc, slabRenderOptions);
  const nodes = readNodeMap(xmlDoc);
  const slabs = slabElementsById(xmlDoc);
  const sourceFacts = collectSmallOpeningRebarSourceFacts(xmlDoc, slabRenderOptions)
    .filter((fact) => fact.memberType === 'SLAB')
    .map((fact) => Object.freeze({ ...fact, modelSource: normalizedModelSource }));

  if (sourceFacts.length === 0) {
    return Object.freeze({
      status: 'NOT_CONFIGURED',
      resolved: true,
      sourceReady: true,
      productionReady: false,
      reason: null,
      source: SOURCE,
      modelSource: normalizedModelSource,
      baseRenderPlan,
      openings: Object.freeze([]),
      candidateCount: 0,
    });
  }

  const seenIdentities = new Map();
  for (let pathIndex = 0; pathIndex < baseRenderPlan.paths.length; pathIndex += 1) {
    const path = baseRenderPlan.paths[pathIndex];
    if (path?.metadata?.memberType !== 'slab') continue;
    const identity = text(path?.metadata?.identityKey);
    if (!identity) {
      return sourceFailure('small-opening-slab-bar-identity-missing', {
        modelSource: normalizedModelSource,
        baseRenderPlan,
      });
    }
    if (seenIdentities.has(identity)) {
      return sourceFailure('small-opening-slab-bar-identity-duplicate', {
        modelSource: normalizedModelSource,
        baseRenderPlan,
        duplicateIdentity: identity,
        duplicatePathIndexes: Object.freeze([seenIdentities.get(identity), pathIndex]),
      });
    }
    seenIdentities.set(identity, pathIndex);
  }

  const openings = [];
  for (const fact of sourceFacts) {
    const memberId = text(fact.memberId);
    const slabElement = slabs.get(memberId);
    const memberCheck = baseRenderPlan.checks.find(
      (check) => text(check?.memberId) === memberId,
    );
    if (!memberCheck || memberCheck.status !== 'READY') {
      return sourceFailure('small-opening-slab-source-render-plan-unresolved', {
        modelSource: normalizedModelSource,
        baseRenderPlan,
        failedMemberId: memberId,
        failedOpeningId: text(fact.openingId),
        sourceCheck: memberCheck || null,
      });
    }
    const frame = frameForSlab(slabElement, nodes);
    if (!frame) {
      return sourceFailure('small-opening-slab-frame-unresolved', {
        modelSource: normalizedModelSource,
        baseRenderPlan,
        failedMemberId: memberId,
        failedOpeningId: text(fact.openingId),
      });
    }

    const geometry = openingGeometry(fact, frame, tolerance);
    if (!geometry.ok) {
      return sourceFailure(geometry.reason, {
        modelSource: normalizedModelSource,
        baseRenderPlan,
        failedMemberId: memberId,
        failedOpeningId: text(fact.openingId),
      });
    }

    const crossingCandidates = [];
    for (let pathIndex = 0; pathIndex < baseRenderPlan.paths.length; pathIndex += 1) {
      const path = baseRenderPlan.paths[pathIndex];
      if (
        path?.metadata?.memberType !== 'slab' ||
        text(path?.metadata?.memberId) !== memberId
      ) {
        continue;
      }
      if (!pathCrossesOpening(path, frame, geometry.opening, tolerance)) continue;
      const candidate = candidateFromPath(path, pathIndex, fact);
      if (!candidate) {
        return sourceFailure('small-opening-slab-crossing-identity-unresolved', {
          modelSource: normalizedModelSource,
          baseRenderPlan,
          failedMemberId: memberId,
          failedOpeningId: text(fact.openingId),
        });
      }
      crossingCandidates.push(candidate);
    }

    crossingCandidates.sort((left, right) =>
      left.barIdentity < right.barIdentity ? -1 : left.barIdentity > right.barIdentity ? 1 : 0,
    );
    openings.push(
      Object.freeze({
        modelSource: normalizedModelSource,
        memberType: 'SLAB',
        memberId,
        openingId: text(fact.openingId),
        sourceFact: fact,
        openingGeometry: geometry.opening,
        frame: Object.freeze({
          width: frame.width,
          height: frame.height,
          origin: Object.freeze({ ...frame.origin }),
          xAxis: Object.freeze({ ...frame.xAxis }),
          yAxis: Object.freeze({ ...frame.yAxis }),
          normal: Object.freeze({ ...frame.normal }),
        }),
        crossingCount: crossingCandidates.length,
        crossingCandidates: Object.freeze(crossingCandidates),
      }),
    );
  }

  openings.sort((left, right) => {
    const a = `${left.memberId}\u0000${left.openingId}`;
    const b = `${right.memberId}\u0000${right.openingId}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return Object.freeze({
    status: 'READY',
    resolved: true,
    sourceReady: true,
    productionReady: false,
    reason: null,
    source: SOURCE,
    modelSource: normalizedModelSource,
    baseRenderPlan,
    openingCount: openings.length,
    candidateCount: openings.reduce((sum, opening) => sum + opening.crossingCount, 0),
    openings: Object.freeze(openings),
  });
}

function targetFailure(sourcePlan, reason, values = {}) {
  return Object.freeze({
    status: 'UNRESOLVED',
    resolved: false,
    targetPlanReady: false,
    productionReady: false,
    reason,
    source: SOURCE,
    sourcePlan,
    targets: Object.freeze([]),
    ...values,
  });
}

/**
 * source crossing candidatesとexplicit SLAB targetをexact identityで照合する。
 * crossing candidateの自動target化は行わない。
 */
export function buildSmallOpeningSlabTargetPlan(
  xmlDoc,
  {
    modelSource = null,
    projectDetailing,
    toleranceMm = DEFAULT_TOLERANCE_MM,
    slabRenderOptions = {},
  } = {},
) {
  const sourcePlan = buildSmallOpeningSlabSourcePlan(xmlDoc, {
    modelSource,
    toleranceMm,
    slabRenderOptions,
  });
  if (sourcePlan.status !== 'READY') {
    if (sourcePlan.status === 'NOT_CONFIGURED') {
      return Object.freeze({
        status: 'NOT_CONFIGURED',
        resolved: true,
        targetPlanReady: false,
        productionReady: false,
        reason: null,
        source: SOURCE,
        sourcePlan,
        targets: Object.freeze([]),
        openings: Object.freeze([]),
      });
    }
    return targetFailure(sourcePlan, sourcePlan.reason || 'small-opening-slab-source-unresolved');
  }

  const openingResults = [];
  const aggregateTargets = [];
  for (const opening of sourcePlan.openings) {
    const resolution = resolveSmallOpeningRebarDeflectionTargets({
      modelSource: opening.modelSource,
      memberType: 'SLAB',
      memberId: opening.memberId,
      openingId: opening.openingId,
      projectDetailing,
    });

    if (opening.crossingCount === 0) {
      if (resolution?.active && !resolution?.resolved) {
        return targetFailure(
          sourcePlan,
          resolution.reason || 'small-opening-slab-target-unresolved',
          {
            openingResults: Object.freeze(openingResults),
            failedOpening: opening,
          },
        );
      }
      if (resolution?.active && (resolution.targets || []).length > 0) {
        return targetFailure(sourcePlan, 'small-opening-slab-target-not-crossing', {
          openingResults: Object.freeze(openingResults),
          failedOpening: opening,
          failedTarget: resolution.targets[0],
        });
      }
      openingResults.push(
        Object.freeze({
          opening,
          status: 'NO_CROSSING',
          resolved: true,
          targetPlanReady: true,
          targetSourceRef: resolution?.sourceRef || null,
          targets: Object.freeze([]),
          untargetedBarIdentities: Object.freeze([]),
        }),
      );
      continue;
    }

    if (!resolution?.active || !resolution?.resolved) {
      return targetFailure(
        sourcePlan,
        resolution?.reason || 'small-opening-slab-target-not-configured',
        {
          openingResults: Object.freeze(openingResults),
          failedOpening: opening,
        },
      );
    }

    const candidates = new Map(
      opening.crossingCandidates.map((candidate) => [candidate.barIdentity, candidate]),
    );
    const resolvedTargets = [];
    for (const target of resolution.targets || []) {
      const candidate = candidates.get(text(target?.barIdentity));
      if (!candidate) {
        return targetFailure(sourcePlan, 'small-opening-slab-target-not-crossing', {
          openingResults: Object.freeze(openingResults),
          failedOpening: opening,
          failedTarget: target,
        });
      }
      resolvedTargets.push(Object.freeze({ target: Object.freeze({ ...target }), candidate }));
    }

    const targetIdentitySet = new Set(resolvedTargets.map((entry) => entry.candidate.barIdentity));
    const untargeted = opening.crossingCandidates
      .map((candidate) => candidate.barIdentity)
      .filter((identity) => !targetIdentitySet.has(identity));
    if (untargeted.length > 0) {
      return targetFailure(sourcePlan, 'small-opening-slab-target-coverage-incomplete', {
        openingResults: Object.freeze(openingResults),
        failedOpening: opening,
        untargetedBarIdentities: Object.freeze(untargeted),
      });
    }

    openingResults.push(
      Object.freeze({
        opening,
        status: 'READY',
        resolved: true,
        targetPlanReady: true,
        targetSourceRef: resolution.sourceRef || null,
        targets: Object.freeze(resolvedTargets),
        untargetedBarIdentities: Object.freeze([]),
      }),
    );
    aggregateTargets.push(...resolvedTargets);
  }

  return Object.freeze({
    status: 'READY',
    resolved: true,
    targetPlanReady: true,
    productionReady: false,
    reason: null,
    source: SOURCE,
    modelSource: sourcePlan.modelSource,
    sourcePlan,
    openingCount: sourcePlan.openingCount,
    targetCount: aggregateTargets.length,
    targets: Object.freeze(aggregateTargets),
    openings: Object.freeze(openingResults),
  });
}

export const SMALL_OPENING_SLAB_SOURCE_PLAN_SOURCE = SOURCE;

export const __testOnly = Object.freeze({
  openingGeometry,
  segmentCrossesOpeningInterior,
  pathCrossesOpening,
});
