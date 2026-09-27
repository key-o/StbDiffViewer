/**
 * @fileoverview RC梁主筋 identity から部材ローカル RebarPath を組み立てる。
 *
 * R5では同一identityかつ断面内座標が連続する区間だけを1本のLineへ統合する。
 * 断面内位置が区間境界で変わる場合は通常は分割したままとし、R8でSTB明示ハンチの
 * コーナー主筋transitionがproduction gateを通った場合だけ実ハンチ長で置換する。
 * R10-Dではそのtransitionのsharp cornerを実曲げ半径Arcへ置換する。
 *
 * @module data/extractors/rebar3d/beamRebarPathBuilder
 */

import { createLine, createRebarPath, validateRebarPath } from './rebarPath.js';
import {
  buildDoglegTransitionPath,
  resolveRoundedTransitionCorner,
} from './rebarTransitionArcGeometry.js';
import { assignBeamBarIdentities } from './rebarIdentityMatcher.js';

const DEFAULT_POSITION_TOLERANCE_MM = 1e-6;
const EPS = 1e-9;

function isMainBar(bar) {
  return bar?.role === 'top' || bar?.role === 'bottom';
}

function samePosition(left, right, tolerance) {
  return (
    Math.abs(Number(left?.u) - Number(right?.u)) <= tolerance &&
    Math.abs(Number(left?.v) - Number(right?.v)) <= tolerance &&
    Number(left?.dia) === Number(right?.dia)
  );
}

function pathMetadata(bar, identityKey, zones, continuitySplit = false) {
  return {
    memberId: null,
    memberTag: null,
    role: bar.role || null,
    layer: bar.layer ?? null,
    dia: Number(bar.dia),
    diaName: bar.diaName || null,
    grade: bar.grade || null,
    positionZone: zones.join('->'),
    positionZones: zones,
    source: 'beam-r5-identity',
    ruleId: 'R5',
    endpoint: null,
    identityKey,
    identityStatus: bar.identityStatus || (identityKey ? 'local' : 'unresolved'),
    unresolvedMatch: Boolean(bar.unresolvedMatch),
    continuitySplit,
    coordinateSpace: 'member-local',
  };
}

function runToPath(run, memberLengthMm, continuitySplit) {
  const first = run[0];
  const last = run[run.length - 1];
  const startZ = memberLengthMm * (first.segment.startRatio - 0.5);
  const endZ = memberLengthMm * (last.segment.endRatio - 0.5);
  const zones = run.map((item) => item.segment.positionZone || `SEG${item.segmentIndex}`);
  return createRebarPath(
    [
      createLine(
        { x: Number(first.bar.u), y: Number(first.bar.v), z: startZ },
        { x: Number(last.bar.u), y: Number(last.bar.v), z: endZ },
      ),
    ],
    pathMetadata(first.bar, first.bar.identityKey || null, zones, continuitySplit),
  );
}

function gradeKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function layerKey(value) {
  return value === null || value === undefined || value === '' ? '' : String(value);
}

function trimMatchesPath(path, line, spec, endpoint, tolerance) {
  const bar = spec?.bar;
  const local = bar?.localPosition || bar;
  const point = endpoint === 'start' ? line.start : line.end;
  const expectedIdentityKey = String(spec?.identityKey || '').trim();
  return (
    spec?.endpoint === endpoint &&
    (!expectedIdentityKey || path?.metadata?.identityKey === expectedIdentityKey) &&
    path?.metadata?.role === bar?.role &&
    layerKey(path?.metadata?.layer) === layerKey(bar?.layer) &&
    Number(path?.metadata?.dia) === Number(bar?.dia) &&
    gradeKey(path?.metadata?.grade) === gradeKey(bar?.grade) &&
    Number.isFinite(Number(local?.u)) &&
    Number.isFinite(Number(local?.v)) &&
    Math.abs(Number(point.x) - Number(local.u)) <= tolerance &&
    Math.abs(Number(point.y) - Number(local.v)) <= tolerance
  );
}

function resolvedTrimMm(path, line, specs, endpoint, tolerance) {
  const values = (specs || [])
    .filter((spec) => trimMatchesPath(path, line, spec, endpoint, tolerance))
    .map((spec) => Number(spec.trimMm))
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? Math.max(...values) : 0;
}

function endpointInsetSemanticMatches(path, expected) {
  return (
    path?.metadata?.role === expected?.role &&
    layerKey(path?.metadata?.layer) === layerKey(expected?.layer) &&
    Number(path?.metadata?.dia) === Number(expected?.dia) &&
    gradeKey(path?.metadata?.grade) === gradeKey(expected?.grade)
  );
}

function endpointInsetPointMatches(point, expected, tolerance) {
  // Appendix A2 vertical stacking may already have shifted local-v before this
  // horizontal inset is applied. Match the protected horizontal datum (u) and
  // semantic facts here; the actual endpoint v is then used for the dogleg.
  return (
    Number.isFinite(Number(expected?.localPosition?.u)) &&
    Math.abs(Number(point?.x) - Number(expected.localPosition.u)) <= tolerance
  );
}

function lineLength(line) {
  if (!line) return 0;
  return Math.hypot(
    Number(line.end.x) - Number(line.start.x),
    Number(line.end.y) - Number(line.start.y),
    Number(line.end.z) - Number(line.start.z),
  );
}

function issue317TransitionMetadata(path, spec, memberId) {
  return {
    ...path.metadata,
    memberId: memberId || path.metadata?.memberId || null,
    memberTag: 'StbGirder',
    source: 'issue317-a2-side-endpoint-inset',
    ruleId: 'APPENDIX-A2-SIDE-JOINT-OUTER-BAR-INSET',
    endpoint: spec.endpoint,
    placementConflictEndpointInset: true,
    issue317PlacementConflictDeltaU: Number(spec.deltaU),
    issue317PlacementConflictSourceRules: (spec.sourceRuleIds || []).slice(),
    coordinateSpace: 'member-local',
    bendGeometry: 'actual-arc',
  };
}

function planPlacementConflictEndpointInset(paths, spec, memberLengthMm, tolerance, memberId) {
  const endpoint = String(spec?.endpoint || '');
  const expected = spec?.expectedBar;
  const deltaU = Number(spec?.deltaU);
  const transitionLeadMm = Number(spec?.transitionLeadMm);
  const transitionRunMm = Number(spec?.transitionRunMm);
  if (
    !['start', 'end'].includes(endpoint) ||
    !Number.isFinite(deltaU) ||
    Math.abs(deltaU) <= tolerance ||
    !(transitionLeadMm > 0) ||
    !(transitionRunMm > 0) ||
    !expected?.localPosition ||
    !Number.isFinite(Number(expected.localPosition.u)) ||
    !Number.isFinite(Number(expected.localPosition.v))
  ) {
    return { ok: false, reason: 'issue317-endpoint-inset-spec-invalid', spec };
  }

  const endpointZ = endpoint === 'start' ? -memberLengthMm / 2 : memberLengthMm / 2;
  const candidates = (paths || []).filter((path) => {
    const line = singleLine(path);
    if (!line || !endpointInsetSemanticMatches(path, expected)) return false;
    const point = endpoint === 'start' ? line.start : line.end;
    return (
      Math.abs(Number(point?.z) - endpointZ) <= tolerance &&
      endpointInsetPointMatches(point, expected, tolerance)
    );
  });
  if (candidates.length !== 1) {
    return {
      ok: false,
      reason:
        candidates.length === 0
          ? 'issue317-endpoint-inset-main-path-unresolved'
          : 'issue317-endpoint-inset-main-path-ambiguous',
      spec,
      candidateCount: candidates.length,
    };
  }

  const targetPath = candidates[0];
  const line = singleLine(targetPath);
  const targetEndpoint = endpoint === 'start' ? line.start : line.end;
  const originalU = Number(targetEndpoint.x);
  const v = Number(targetEndpoint.y);
  const shiftedU = originalU + deltaU;
  const inwardSign = endpoint === 'start' ? 1 : -1;
  const sharpStart =
    endpoint === 'start'
      ? { x: shiftedU, y: v, z: endpointZ + transitionLeadMm }
      : { x: originalU, y: v, z: endpointZ - transitionLeadMm - transitionRunMm };
  const sharpEnd =
    endpoint === 'start'
      ? { x: originalU, y: v, z: endpointZ + transitionLeadMm + transitionRunMm }
      : { x: shiftedU, y: v, z: endpointZ - transitionLeadMm };
  const rounded = buildDoglegTransitionPath({
    sharpStart,
    sharpEnd,
    incomingDirection: { x: 0, y: 0, z: 1 },
    outgoingDirection: { x: 0, y: 0, z: 1 },
    grade: expected.grade || targetPath.metadata?.grade,
    barDiaMm: Number(expected.dia || targetPath.metadata?.dia),
    metadata: issue317TransitionMetadata(targetPath, spec, memberId),
  });
  if (!rounded.ok || !rounded.path) {
    return {
      ok: false,
      reason: rounded.reason || 'issue317-endpoint-inset-dogleg-unresolved',
      spec,
    };
  }

  const transitionReachMm =
    transitionLeadMm + transitionRunMm + rounded.endCorner.tangentDistanceMm;
  if (!(transitionReachMm < memberLengthMm - tolerance)) {
    return {
      ok: false,
      reason: 'issue317-endpoint-inset-member-length-insufficient',
      spec,
      transitionReachMm,
      memberLengthMm,
    };
  }

  const shiftedEndpoint = { x: shiftedU, y: v, z: endpointZ };
  let transitionPrimitives;
  let adjustedLine;
  if (endpoint === 'start') {
    const lead = createLine(shiftedEndpoint, rounded.startCorner.incomingTangent);
    if (!(lineLength(lead) > tolerance)) {
      return { ok: false, reason: 'issue317-endpoint-inset-start-lead-too-short', spec };
    }
    transitionPrimitives = [lead, ...rounded.path.primitives];
    adjustedLine = createLine(rounded.endCorner.outgoingTangent, line.end);
  } else {
    const lead = createLine(rounded.endCorner.outgoingTangent, shiftedEndpoint);
    if (!(lineLength(lead) > tolerance)) {
      return { ok: false, reason: 'issue317-endpoint-inset-end-lead-too-short', spec };
    }
    transitionPrimitives = [...rounded.path.primitives, lead];
    adjustedLine = createLine(line.start, rounded.startCorner.incomingTangent);
  }
  const axialBodyRunMm = Number(adjustedLine.end.z) - Number(adjustedLine.start.z);
  if (!(axialBodyRunMm > tolerance)) {
    return {
      ok: false,
      reason: 'issue317-endpoint-inset-body-overlap',
      spec,
      axialBodyRunMm,
    };
  }
  if (!(lineLength(adjustedLine) > tolerance)) {
    return { ok: false, reason: 'issue317-endpoint-inset-body-too-short', spec };
  }

  const transitionPath = createRebarPath(
    transitionPrimitives,
    issue317TransitionMetadata(targetPath, spec, memberId),
  );
  const adjustedPath = createRebarPath([adjustedLine], {
    ...targetPath.metadata,
    memberId: memberId || targetPath.metadata?.memberId || null,
    issue317PlacementConflictAdjusted: true,
    issue317PlacementConflictEndpoint: endpoint,
    issue317PlacementConflictDeltaU: deltaU,
  });
  if (!validateRebarPath(transitionPath).ok || !validateRebarPath(adjustedPath).ok) {
    return { ok: false, reason: 'issue317-endpoint-inset-path-invalid', spec };
  }

  return {
    ok: true,
    spec,
    targetPath,
    adjustedPath,
    transitionPath,
    rounded,
    inwardSign,
  };
}

function applyPlacementConflictEndpointInsets(paths, memberLengthMm, specs = [], options = {}) {
  if (!Array.isArray(specs) || specs.length === 0) {
    return { paths, applied: [], unresolved: [], transitionPaths: [] };
  }
  const tolerance = Number.isFinite(Number(options.positionToleranceMm))
    ? Number(options.positionToleranceMm)
    : DEFAULT_POSITION_TOLERANCE_MM;
  const ordered = specs.slice().sort((a, b) => {
    const endpointOrder = a.endpoint === b.endpoint ? 0 : a.endpoint === 'start' ? -1 : 1;
    return endpointOrder || Number(a.barIndex) - Number(b.barIndex);
  });
  let working = paths.slice();
  const applied = [];
  const transitionPaths = [];

  for (const spec of ordered) {
    const mutation = planPlacementConflictEndpointInset(
      working,
      spec,
      memberLengthMm,
      tolerance,
      options.memberId,
    );
    if (!mutation.ok) {
      return {
        paths,
        applied: [],
        transitionPaths: [],
        unresolved: [{ reason: mutation.reason, spec, candidateCount: mutation.candidateCount }],
      };
    }
    working = working.filter((path) => path !== mutation.targetPath);
    working.push(mutation.adjustedPath, mutation.transitionPath);
    applied.push(spec);
    transitionPaths.push(mutation.transitionPath);
  }

  return { paths: working, applied, unresolved: [], transitionPaths };
}

/**
 * R7の仕口bend境界に合わせ、対象主筋だけを部材端から切り戻す。
 * 非対象筋、材端まで到達していないcutoff path、複数primitive pathは変更しない。
 */
function trimBeamMemberRebarPaths(paths, memberLengthMm, endpointTrims = [], options = {}) {
  if (!Array.isArray(paths) || !endpointTrims?.length || !(memberLengthMm > 0)) return paths || [];
  const tolerance = Number.isFinite(Number(options.positionToleranceMm))
    ? Number(options.positionToleranceMm)
    : DEFAULT_POSITION_TOLERANCE_MM;
  const result = [];

  for (const path of paths) {
    if (path?.primitives?.length !== 1 || path.primitives[0]?.type !== 'line') {
      result.push(path);
      continue;
    }
    const line = path.primitives[0];
    const from = Number(line.start.z) + memberLengthMm / 2;
    const to = Number(line.end.z) + memberLengthMm / 2;
    if (![from, to].every(Number.isFinite) || to <= from) {
      result.push(path);
      continue;
    }

    const startTrim =
      Math.abs(from) <= tolerance
        ? resolvedTrimMm(path, line, endpointTrims, 'start', tolerance)
        : 0;
    const endTrim =
      Math.abs(to - memberLengthMm) <= tolerance
        ? resolvedTrimMm(path, line, endpointTrims, 'end', tolerance)
        : 0;
    if (!(startTrim > 0) && !(endTrim > 0)) {
      result.push(path);
      continue;
    }

    const startZ = Number(line.start.z) + startTrim;
    const endZ = Number(line.end.z) - endTrim;
    if (!(endZ > startZ + tolerance)) continue;
    result.push(
      createRebarPath([createLine({ ...line.start, z: startZ }, { ...line.end, z: endZ })], {
        ...path.metadata,
        jointTrimmed: true,
        jointTrimStartMm: startTrim,
        jointTrimEndMm: endTrim,
      }),
    );
  }
  return result;
}

function finitePoint2d(point) {
  return Number.isFinite(Number(point?.u)) && Number.isFinite(Number(point?.v));
}

function samePoint2d(point, target, tolerance) {
  return (
    Math.abs(Number(point?.x) - Number(target?.u)) <= tolerance &&
    Math.abs(Number(point?.y) - Number(target?.v)) <= tolerance
  );
}

function sameSpecPosition(left, right, tolerance) {
  return (
    Math.abs(Number(left?.u) - Number(right?.u)) <= tolerance &&
    Math.abs(Number(left?.v) - Number(right?.v)) <= tolerance
  );
}

function subtract3(left, right) {
  return {
    x: Number(left.x) - Number(right.x),
    y: Number(left.y) - Number(right.y),
    z: Number(left.z) - Number(right.z),
  };
}

function magnitude3(value) {
  return Math.hypot(value.x, value.y, value.z);
}

function normalize3(value) {
  const length = magnitude3(value);
  if (!(length > EPS)) return null;
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function distance3(left, right) {
  return magnitude3(subtract3(left, right));
}

function pathMatchesHaunchSemantic(path, spec) {
  return (
    path?.metadata?.role === spec?.role &&
    layerKey(path?.metadata?.layer) === layerKey(spec?.layer) &&
    Number(path?.metadata?.dia) === Number(spec?.diaMm) &&
    gradeKey(path?.metadata?.grade) === gradeKey(spec?.grade)
  );
}

function singleLine(path) {
  return path?.primitives?.length === 1 && path.primitives[0]?.type === 'line'
    ? path.primitives[0]
    : null;
}

function findEndpointPath(paths, spec, memberLengthMm, tolerance) {
  const endpointZ = spec.side === 'start' ? -memberLengthMm / 2 : memberLengthMm / 2;
  const candidates = paths.filter((path) => {
    const line = singleLine(path);
    if (!line || !pathMatchesHaunchSemantic(path, spec)) return false;
    const point = spec.side === 'start' ? line.start : line.end;
    return (
      Math.abs(Number(point.z) - endpointZ) <= tolerance && samePoint2d(point, spec.from, tolerance)
    );
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function findTargetPath(paths, spec, endpointPath, memberLengthMm, tolerance) {
  const endpointZ = spec.side === 'start' ? -memberLengthMm / 2 : memberLengthMm / 2;
  let candidates = paths.filter((path) => {
    if (path === endpointPath || !pathMatchesHaunchSemantic(path, spec)) return false;
    const line = singleLine(path);
    if (!line) return false;
    if (
      !samePoint2d(line.start, spec.to, tolerance) ||
      !samePoint2d(line.end, spec.to, tolerance)
    ) {
      return false;
    }
    return spec.side === 'start'
      ? Number(line.start.z) > endpointZ + tolerance
      : Number(line.end.z) < endpointZ - tolerance;
  });

  const identityKey = endpointPath?.metadata?.identityKey;
  if (identityKey) {
    const sameIdentity = candidates.filter((path) => path.metadata?.identityKey === identityKey);
    if (sameIdentity.length) candidates = sameIdentity;
  }
  if (!candidates.length) return null;

  const ranked = candidates
    .map((path) => ({
      path,
      axial:
        spec.side === 'start' ? Number(singleLine(path).start.z) : Number(singleLine(path).end.z),
    }))
    .sort((left, right) =>
      spec.side === 'start' ? left.axial - right.axial : right.axial - left.axial,
    );
  if (ranked.length > 1 && Math.abs(ranked[0].axial - ranked[1].axial) <= tolerance) return null;
  return ranked[0].path;
}

function haunchGroupKey(spec) {
  return `${spec?.side || ''}|${Number(spec?.lengthMm)}`;
}

function haunchPathMetadata(endpointPath, spec, memberId, extra = {}) {
  return {
    ...endpointPath.metadata,
    memberId: memberId || endpointPath.metadata?.memberId || null,
    memberTag: 'StbGirder',
    source: 'girder-r8-haunch',
    ruleId: '8-2-4',
    endpoint: spec.side,
    positionZone: `${spec.endpointZone || spec.side}->${spec.targetZone || 'CENTER'}`,
    positionZones: [spec.endpointZone || spec.side, spec.targetZone || 'CENTER'],
    continuitySplit: false,
    haunchTransition: true,
    haunchLengthMm: Number(spec.lengthMm),
    coordinateSpace: 'member-local',
    ...extra,
  };
}

function planHaunchMutation(paths, spec, memberLengthMm, tolerance, memberId) {
  if (
    !['start', 'end'].includes(spec?.side) ||
    !(Number(spec?.lengthMm) > 0) ||
    !(Number(spec.lengthMm) < memberLengthMm) ||
    !finitePoint2d(spec.from) ||
    !finitePoint2d(spec.to)
  ) {
    return { ok: false, reason: 'invalid-haunch-transition-spec' };
  }
  if (sameSpecPosition(spec.from, spec.to, tolerance)) {
    return { ok: true, noop: true, spec };
  }

  const endpointPath = findEndpointPath(paths, spec, memberLengthMm, tolerance);
  if (!endpointPath) return { ok: false, reason: 'haunch-endpoint-path-unresolved', spec };
  const targetPath = findTargetPath(paths, spec, endpointPath, memberLengthMm, tolerance);
  if (!targetPath) return { ok: false, reason: 'haunch-target-path-unresolved', spec };

  const targetLine = singleLine(targetPath);
  const endpointZ = spec.side === 'start' ? -memberLengthMm / 2 : memberLengthMm / 2;
  const boundaryZ =
    spec.side === 'start' ? endpointZ + Number(spec.lengthMm) : endpointZ - Number(spec.lengthMm);
  const endpointPoint = {
    x: Number(spec.from.u),
    y: Number(spec.from.v),
    z: endpointZ,
  };
  const boundaryPoint = {
    x: Number(spec.to.u),
    y: Number(spec.to.v),
    z: boundaryZ,
  };
  const diagonalDirection =
    spec.side === 'start'
      ? normalize3(subtract3(boundaryPoint, endpointPoint))
      : normalize3(subtract3(endpointPoint, boundaryPoint));
  if (!diagonalDirection) return { ok: false, reason: 'haunch-transition-run-nonpositive', spec };

  const corner = resolveRoundedTransitionCorner({
    corner: boundaryPoint,
    incomingDirection: spec.side === 'start' ? diagonalDirection : { x: 0, y: 0, z: 1 },
    outgoingDirection: spec.side === 'start' ? { x: 0, y: 0, z: 1 } : diagonalDirection,
    grade: spec.grade,
    barDiaMm: Number(spec.diaMm),
  });
  if (!corner.ok) return { ok: false, reason: corner.reason || 'haunch-bend-arc-unresolved', spec };

  const diagonalLengthMm = distance3(endpointPoint, boundaryPoint);
  if (!(diagonalLengthMm > corner.tangentDistanceMm + tolerance)) {
    return { ok: false, reason: 'haunch-transition-run-too-short-for-bend-radius', spec };
  }

  const adjustedLine =
    spec.side === 'start'
      ? createLine(corner.outgoingTangent, targetLine.end)
      : createLine(targetLine.start, corner.incomingTangent);
  if (!(Number(adjustedLine.end.z) > Number(adjustedLine.start.z) + tolerance)) {
    return { ok: false, reason: 'haunch-target-path-nonpositive', spec };
  }

  const transitionPrimitives = [];
  if (spec.side === 'start') {
    transitionPrimitives.push(createLine(endpointPoint, corner.incomingTangent), corner.arc);
  } else {
    transitionPrimitives.push(corner.arc, createLine(corner.outgoingTangent, endpointPoint));
  }
  const transitionPath = createRebarPath(
    transitionPrimitives,
    haunchPathMetadata(endpointPath, spec, memberId, {
      bendGeometry: 'actual-arc',
      bendAngleDeg: corner.bendAngleDeg,
      bendRuleAngleDeg: corner.ruleAngleDeg,
      insideDiameterMm: corner.insideDiameterMm,
      centerlineRadiusMm: corner.centerlineRadiusMm,
      sharpBoundaryMm: Number(spec.lengthMm),
    }),
  );
  const validation = validateRebarPath(transitionPath);
  if (!validation.ok) {
    return { ok: false, reason: 'haunch-transition-arc-path-invalid', spec, validation };
  }

  return {
    ok: true,
    noop: false,
    spec,
    endpointPath,
    targetPath,
    adjustedTargetPath: createRebarPath([adjustedLine], {
      ...targetPath.metadata,
      memberId: memberId || targetPath.metadata?.memberId || null,
      haunchAdjusted: true,
      haunchAdjustedSide: spec.side,
      haunchBoundaryMm: Number(spec.lengthMm),
      haunchArcTangentMm: corner.tangentDistanceMm,
    }),
    transitionPath,
    bendGeometry: corner,
  };
}

/**
 * R8のハンチtransitionを端部単位で原子的に適用する。
 * R7 trim後のpathを入力するため、同じ筋が仕口側で既に切り戻されていればendpoint pathが
 * 見つからず、その端部のハンチ置換全体を行わない。
 */
function applyHaunchTransitions(paths, memberLengthMm, specs = [], options = {}) {
  if (!specs?.length) return { paths, applied: [], unresolved: [] };
  const tolerance = Number.isFinite(Number(options.positionToleranceMm))
    ? Number(options.positionToleranceMm)
    : DEFAULT_POSITION_TOLERANCE_MM;
  let working = paths.slice();
  const applied = [];
  const unresolved = [];
  const groups = new Map();
  for (const spec of specs) {
    const key = haunchGroupKey(spec);
    const list = groups.get(key);
    if (list) list.push(spec);
    else groups.set(key, [spec]);
  }

  for (const group of groups.values()) {
    const mutations = group.map((spec) =>
      planHaunchMutation(working, spec, memberLengthMm, tolerance, options.memberId),
    );
    const failed = mutations.filter((mutation) => !mutation.ok);
    if (failed.length) {
      unresolved.push(...failed.map(({ reason, spec }) => ({ reason, spec })));
      continue;
    }

    const effective = mutations.filter((mutation) => !mutation.noop);
    const endpoints = new Set(effective.map((mutation) => mutation.endpointPath));
    const targetReplacements = new Map(
      effective.map((mutation) => [mutation.targetPath, mutation.adjustedTargetPath]),
    );
    if (
      endpoints.size !== effective.length ||
      targetReplacements.size !== effective.length ||
      [...endpoints].some((path) => targetReplacements.has(path))
    ) {
      unresolved.push(...group.map((spec) => ({ reason: 'haunch-path-mutation-conflict', spec })));
      continue;
    }

    const next = [];
    for (const path of working) {
      if (endpoints.has(path)) continue;
      next.push(targetReplacements.get(path) || path);
    }
    next.push(...effective.map((mutation) => mutation.transitionPath));
    working = next;
    applied.push(...group);
  }

  return { paths: working, applied, unresolved };
}

/**
 * 断面layoutと実部材長から主筋のRebarPathを作る。
 * @returns {{paths:Array<Object>, identity:Object, semanticMainBarCount:number, haunchTransitions:Object}}
 */
export function buildBeamMemberRebarPaths(layout, memberLengthMm, options = {}) {
  const segments = layout?.segments || [];
  if (!(memberLengthMm > 0) || segments.length === 0) {
    return {
      paths: [],
      identity: { transitions: [], unresolvedMatches: [] },
      semanticMainBarCount: 0,
      placementConflictTransitions: { applied: [], unresolved: [], transitionPaths: [] },
      haunchTransitions: { applied: [], unresolved: [] },
    };
  }

  const positionToleranceMm = Number.isFinite(Number(options.positionToleranceMm))
    ? Number(options.positionToleranceMm)
    : DEFAULT_POSITION_TOLERANCE_MM;
  const identity = assignBeamBarIdentities(segments, options.identityOptions || {});
  const groups = new Map();
  let semanticMainBarCount = 0;

  segments.forEach((segment, segmentIndex) => {
    (segment.bars || []).forEach((bar, barIndex) => {
      if (!isMainBar(bar)) return;
      semanticMainBarCount += 1;
      const key = bar.identityKey
        ? `identity:${bar.identityKey}`
        : `local:${segmentIndex}:${barIndex}`;
      const list = groups.get(key);
      const item = { segment, segmentIndex, bar };
      if (list) list.push(item);
      else groups.set(key, [item]);
    });
  });

  const paths = [];
  for (const items of groups.values()) {
    items.sort((a, b) => a.segmentIndex - b.segmentIndex);
    let run = [items[0]];
    for (let index = 1; index < items.length; index += 1) {
      const previous = run[run.length - 1];
      const current = items[index];
      const contiguous =
        current.segmentIndex === previous.segmentIndex + 1 &&
        Math.abs(previous.segment.endRatio - current.segment.startRatio) <= 1e-9;
      if (contiguous && samePosition(previous.bar, current.bar, positionToleranceMm)) {
        run.push(current);
        continue;
      }
      paths.push(runToPath(run, memberLengthMm, items.length > run.length));
      run = [current];
    }
    paths.push(runToPath(run, memberLengthMm, items.length > run.length));
  }

  // Issue #317: A2 side-jointで柱隅筋と干渉する梁外側主筋は、柱筋位置を保持したまま
  // 対象endpointだけを内寄せし、実曲げArc付きdoglegで元の梁断面位置へ戻す。
  const placementConflict = applyPlacementConflictEndpointInsets(
    paths,
    memberLengthMm,
    options.endpointInsets || [],
    { positionToleranceMm, memberId: options.memberId },
  );

  // R7の仕口trimを先に適用する。同じ端部筋がR7で既に切り戻されている場合、
  // 後段R8ハンチはendpoint pathを解決できず、その端部を原子的にfail-closedする。
  const jointTrimmedPaths = trimBeamMemberRebarPaths(
    placementConflict.paths,
    memberLengthMm,
    options.endpointTrims,
    { positionToleranceMm },
  );
  const haunch = applyHaunchTransitions(
    jointTrimmedPaths,
    memberLengthMm,
    options.haunchTransitions || [],
    { positionToleranceMm, memberId: options.memberId },
  );
  return {
    paths: haunch.paths,
    identity,
    semanticMainBarCount,
    placementConflictTransitions: {
      applied: placementConflict.applied,
      unresolved: placementConflict.unresolved,
      transitionPaths: placementConflict.transitionPaths,
    },
    haunchTransitions: { applied: haunch.applied, unresolved: haunch.unresolved },
  };
}
