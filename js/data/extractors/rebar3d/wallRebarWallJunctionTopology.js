/**
 * @fileoverview Issue #310 Phase 6a-D2a:
 * RC壁 L/T junction の normalized topology facts を pure に導出する。
 *
 * Phase 6a-B adjacency は shared-edge + parallel-bar one-to-one gate であり、
 * 直交する L/T 壁筋そのものを bar adjacency として確定できない。
 * 本 module は production RebarPath を変更せず、壁の plan run と semantic bar facts から
 * L/T・main/branch・横筋間隔 relation・double 配筋の physical corner side を形式化する。
 */

const DEFAULT_TOLERANCE_MM = 1e-4;
const DEFAULT_ORTHOGONAL_TOLERANCE = 1e-8;
const SUPPORTED_PATTERNS = new Set(['SINGLE', 'DOUBLE_NET']);

function finite(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positive(value) {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
}

function text(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function point2(value) {
  const x = finite(value?.x);
  const y = finite(value?.y);
  return x === null || y === null ? null : Object.freeze({ x, y });
}

function point3(value) {
  const point = point2(value);
  const z = finite(value?.z);
  return !point || z === null ? null : Object.freeze({ x: point.x, y: point.y, z });
}

const sub2 = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add2 = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const scale2 = (v, k) => ({ x: v.x * k, y: v.y * k });
const dot2 = (a, b) => a.x * b.x + a.y * b.y;
const cross2 = (a, b) => a.x * b.y - a.y * b.x;
const magnitude2 = (v) => Math.hypot(v.x, v.y);
const distance2 = (a, b) => magnitude2(sub2(a, b));

function normalize2(v) {
  const length = magnitude2(v);
  return length > Number.EPSILON ? scale2(v, 1 / length) : null;
}

function normalizedRun(run) {
  const start = point2(run?.start);
  const end = point2(run?.end);
  if (!start || !end) return null;
  const vector = sub2(end, start);
  const lengthMm = magnitude2(vector);
  const axis = normalize2(vector);
  if (!axis || !(lengthMm > 0)) return null;
  return Object.freeze({ start, end, axis, lengthMm });
}

function parameterRole(parameter, lengthMm, toleranceMm) {
  const edgeTolerance = Math.min(0.25, toleranceMm / Math.max(lengthMm, toleranceMm));
  if (Math.abs(parameter) <= edgeTolerance || Math.abs(1 - parameter) <= edgeTolerance) {
    return 'ENDPOINT';
  }
  if (parameter > edgeTolerance && parameter < 1 - edgeTolerance) return 'INTERIOR';
  return 'OUTSIDE';
}

function endpointRunFromJunction(run, parameter, junctionPoint, toleranceMm) {
  const role = parameterRole(parameter, run.lengthMm, toleranceMm);
  if (role !== 'ENDPOINT') return null;
  const far = Math.abs(parameter) <= Math.abs(1 - parameter) ? run.end : run.start;
  const axis = normalize2(sub2(far, junctionPoint));
  return axis ? Object.freeze(axis) : null;
}

function unresolved(reason, values = {}) {
  return Object.freeze({
    status: 'UNRESOLVED',
    reason,
    productionReady: false,
    ...values,
  });
}

/**
 * plan run 2本から、直交壁junctionを L / T として一意化する。
 * endpoint-endpoint => L、endpoint-interior => T。
 * interior-interior(X形)、平行、非直交、segment外交点は fail-closed。
 */
export function deriveWallWallJunctionTopology(
  sourceRunValue,
  targetRunValue,
  { toleranceMm = DEFAULT_TOLERANCE_MM, orthogonalTolerance = DEFAULT_ORTHOGONAL_TOLERANCE } = {},
) {
  const tolerance = finite(toleranceMm);
  const angleTolerance = finite(orthogonalTolerance);
  if (tolerance === null || tolerance < 0) {
    throw new RangeError('wall junction toleranceMm must be finite and non-negative');
  }
  if (angleTolerance === null || angleTolerance < 0) {
    throw new RangeError('wall junction orthogonalTolerance must be finite and non-negative');
  }

  const sourceRun = normalizedRun(sourceRunValue);
  const targetRun = normalizedRun(targetRunValue);
  if (!sourceRun || !targetRun) {
    return unresolved('wall-wall-junction-run-unresolved');
  }

  const axisDotAbs = Math.abs(dot2(sourceRun.axis, targetRun.axis));
  if (axisDotAbs > angleTolerance) {
    return unresolved('wall-wall-junction-not-orthogonal', { axisDotAbs });
  }

  const sourceVector = sub2(sourceRun.end, sourceRun.start);
  const targetVector = sub2(targetRun.end, targetRun.start);
  const denominator = cross2(sourceVector, targetVector);
  if (Math.abs(denominator) <= Number.EPSILON) {
    return unresolved('wall-wall-junction-plan-intersection-unresolved', { axisDotAbs });
  }

  const delta = sub2(targetRun.start, sourceRun.start);
  const sourceParameter = cross2(delta, targetVector) / denominator;
  const targetParameter = cross2(delta, sourceVector) / denominator;
  const sourceRole = parameterRole(sourceParameter, sourceRun.lengthMm, tolerance);
  const targetRole = parameterRole(targetParameter, targetRun.lengthMm, tolerance);

  if (sourceRole === 'OUTSIDE' || targetRole === 'OUTSIDE') {
    return unresolved('wall-wall-junction-plan-segments-disjoint', {
      sourceParameter,
      targetParameter,
      axisDotAbs,
    });
  }

  const sourcePoint = add2(sourceRun.start, scale2(sourceVector, sourceParameter));
  const targetPoint = add2(targetRun.start, scale2(targetVector, targetParameter));
  if (distance2(sourcePoint, targetPoint) > tolerance) {
    return unresolved('wall-wall-junction-plan-intersection-tolerance-exceeded', {
      sourceParameter,
      targetParameter,
      axisDotAbs,
    });
  }
  const junctionPoint = Object.freeze({
    x: (sourcePoint.x + targetPoint.x) / 2,
    y: (sourcePoint.y + targetPoint.y) / 2,
  });

  if (sourceRole === 'ENDPOINT' && targetRole === 'ENDPOINT') {
    const sourceRunFromJunction = endpointRunFromJunction(
      sourceRun,
      sourceParameter,
      junctionPoint,
      tolerance,
    );
    const targetRunFromJunction = endpointRunFromJunction(
      targetRun,
      targetParameter,
      junctionPoint,
      tolerance,
    );
    if (!sourceRunFromJunction || !targetRunFromJunction) {
      return unresolved('wall-wall-junction-endpoint-direction-unresolved');
    }
    return Object.freeze({
      status: 'RESOLVED',
      topology: 'L',
      junctionPoint,
      sourceRole,
      targetRole,
      sourceParameter,
      targetParameter,
      sourceRunFromJunction,
      targetRunFromJunction,
      mainSide: null,
      branchSide: null,
      axisDotAbs,
      productionReady: false,
    });
  }

  if (
    (sourceRole === 'INTERIOR' && targetRole === 'ENDPOINT') ||
    (sourceRole === 'ENDPOINT' && targetRole === 'INTERIOR')
  ) {
    return Object.freeze({
      status: 'RESOLVED',
      topology: 'T',
      junctionPoint,
      sourceRole,
      targetRole,
      sourceParameter,
      targetParameter,
      sourceRunFromJunction:
        sourceRole === 'ENDPOINT'
          ? endpointRunFromJunction(sourceRun, sourceParameter, junctionPoint, tolerance)
          : null,
      targetRunFromJunction:
        targetRole === 'ENDPOINT'
          ? endpointRunFromJunction(targetRun, targetParameter, junctionPoint, tolerance)
          : null,
      mainSide: sourceRole === 'INTERIOR' ? 'SOURCE' : 'TARGET',
      branchSide: sourceRole === 'ENDPOINT' ? 'SOURCE' : 'TARGET',
      axisDotAbs,
      productionReady: false,
    });
  }

  return unresolved('wall-wall-junction-cross-intersection-unsupported', {
    sourceRole,
    targetRole,
    sourceParameter,
    targetParameter,
    axisDotAbs,
  });
}

export function deriveWallHorizontalSpacingRelation(
  sourcePitchValue,
  targetPitchValue,
  { toleranceMm = DEFAULT_TOLERANCE_MM } = {},
) {
  const tolerance = finite(toleranceMm);
  if (tolerance === null || tolerance < 0) {
    throw new RangeError('wall junction spacing toleranceMm must be finite and non-negative');
  }
  const sourcePitchMm = positive(sourcePitchValue);
  const targetPitchMm = positive(targetPitchValue);
  if (sourcePitchMm === null || targetPitchMm === null) {
    return unresolved('wall-wall-horizontal-spacing-unresolved', {
      sourcePitchMm,
      targetPitchMm,
    });
  }
  return Object.freeze({
    status: 'RESOLVED',
    relation: Math.abs(sourcePitchMm - targetPitchMm) <= tolerance ? 'SAME' : 'DIFFERENT',
    sourcePitchMm,
    targetPitchMm,
    productionReady: false,
  });
}

/**
 * L形 double 配筋のbarを physical INNER / OUTER cornerへ分類する。
 * semantic PLUS/MINUSを固定規則へ変換せず、world plan上のbar点とwall runの向きで判定する。
 */
export function classifyWallJunctionCornerSide(
  { memberRunFromJunction, otherRunFromJunction, junctionPoint, barPoint },
  { toleranceMm = DEFAULT_TOLERANCE_MM } = {},
) {
  const tolerance = finite(toleranceMm);
  if (tolerance === null || tolerance < 0) {
    throw new RangeError('wall junction corner-side toleranceMm must be finite and non-negative');
  }
  const memberRun = normalize2(point2(memberRunFromJunction));
  const otherRun = normalize2(point2(otherRunFromJunction));
  const junction = point2(junctionPoint);
  const point = point2(barPoint);
  if (!memberRun || !otherRun || !junction || !point) {
    return unresolved('wall-wall-junction-corner-side-input-unresolved');
  }

  const normal = { x: -memberRun.y, y: memberRun.x };
  const innerProjection = dot2(normal, otherRun);
  if (Math.abs(innerProjection) <= DEFAULT_ORTHOGONAL_TOLERANCE) {
    return unresolved('wall-wall-junction-inner-side-unresolved');
  }
  const barProjection = dot2(sub2(point, junction), normal);
  if (Math.abs(barProjection) <= tolerance) {
    return unresolved('wall-wall-junction-bar-on-center-plane');
  }

  return Object.freeze({
    status: 'RESOLVED',
    side: Math.sign(barProjection) === Math.sign(innerProjection) ? 'INNER' : 'OUTER',
    barProjectionMm: barProjection,
    innerProjection,
    productionReady: false,
  });
}

function normalizeBar(bar, index) {
  const semanticIdentity = text(bar?.semanticIdentity);
  const segmentIdentity = text(bar?.segmentIdentity) || semanticIdentity;
  const direction = text(bar?.direction)?.toUpperCase() || null;
  const face = text(bar?.face)?.toUpperCase() || null;
  const point = point3(bar?.junctionPoint || bar?.point);
  const dia = positive(bar?.dia);
  const grade = text(bar?.grade)?.toUpperCase() || null;
  if (
    !semanticIdentity ||
    !segmentIdentity ||
    direction !== 'HORIZONTAL' ||
    !point ||
    dia === null ||
    !grade
  ) {
    return { unresolved: true, index, reason: 'wall-wall-junction-bar-semantic-unresolved' };
  }
  return {
    semanticIdentity,
    segmentIdentity,
    direction,
    face,
    dia,
    grade,
    junctionPoint: point,
  };
}

function normalizedMember(member, bars) {
  const memberId = text(member?.memberId);
  const pattern = text(member?.pattern)?.toUpperCase() || null;
  const run = normalizedRun(member?.run);
  const horizontalPitchMm = positive(member?.horizontalPitchMm);
  if (!memberId || !run) return null;
  const normalizedBars = (Array.isArray(bars) ? bars : [])
    .map(normalizeBar)
    .sort((a, b) => String(a.segmentIdentity || '').localeCompare(String(b.segmentIdentity || '')));
  return { memberId, pattern, run, horizontalPitchMm, bars: normalizedBars };
}

/**
 * D2a normalized topology fact。
 * junction keyはmember idをsortし、bar factsはsegment identityでdeterministicに整列する。
 */
export function buildWallWallJunctionTopologyFact(
  {
    modelSource = null,
    junctionKey = null,
    sourceMember,
    targetMember,
    sourceBars = [],
    targetBars = [],
  },
  options = {},
) {
  const source = normalizedMember(sourceMember, sourceBars);
  const target = normalizedMember(targetMember, targetBars);
  if (!source || !target) {
    return unresolved('wall-wall-junction-member-fact-unresolved', {
      modelSource: text(modelSource),
      junctionKey: text(junctionKey),
    });
  }
  if (source.memberId === target.memberId) {
    return unresolved('wall-wall-junction-member-identity-duplicate', {
      modelSource: text(modelSource),
      junctionKey: text(junctionKey),
      sourceMemberId: source.memberId,
      targetMemberId: target.memberId,
    });
  }

  const topology = deriveWallWallJunctionTopology(source.run, target.run, options);
  if (topology.status !== 'RESOLVED') {
    return unresolved(topology.reason, {
      modelSource: text(modelSource),
      junctionKey: text(junctionKey),
      sourceMemberId: source.memberId,
      targetMemberId: target.memberId,
      topologyFact: topology,
    });
  }

  if (
    !SUPPORTED_PATTERNS.has(source.pattern) ||
    !SUPPORTED_PATTERNS.has(target.pattern) ||
    source.pattern !== target.pattern
  ) {
    return unresolved('wall-wall-junction-pattern-unresolved', {
      modelSource: text(modelSource),
      junctionKey: text(junctionKey),
      sourceMemberId: source.memberId,
      targetMemberId: target.memberId,
      sourcePattern: source.pattern,
      targetPattern: target.pattern,
      topology: topology.topology,
    });
  }

  const spacing = deriveWallHorizontalSpacingRelation(
    source.horizontalPitchMm,
    target.horizontalPitchMm,
    options,
  );
  if (spacing.status !== 'RESOLVED') {
    return unresolved(spacing.reason, {
      modelSource: text(modelSource),
      junctionKey: text(junctionKey),
      sourceMemberId: source.memberId,
      targetMemberId: target.memberId,
      topology: topology.topology,
      pattern: source.pattern,
      spacingFact: spacing,
    });
  }

  if (source.bars.length === 0 || target.bars.length === 0) {
    return unresolved('wall-wall-junction-horizontal-bars-unresolved', {
      modelSource: text(modelSource),
      junctionKey: text(junctionKey),
      sourceMemberId: source.memberId,
      targetMemberId: target.memberId,
      topology: topology.topology,
      pattern: source.pattern,
      horizontalSpacingRelation: spacing.relation,
    });
  }

  const badSourceBar = source.bars.find((bar) => bar.unresolved);
  const badTargetBar = target.bars.find((bar) => bar.unresolved);
  if (badSourceBar || badTargetBar) {
    return unresolved('wall-wall-junction-bar-semantic-unresolved', {
      modelSource: text(modelSource),
      junctionKey: text(junctionKey),
      sourceMemberId: source.memberId,
      targetMemberId: target.memberId,
    });
  }

  const annotateBars = (memberBars, side) => {
    if (topology.topology !== 'L' || source.pattern !== 'DOUBLE_NET') {
      return memberBars.map((bar) => Object.freeze({ ...bar, cornerSide: null }));
    }
    const memberRunFromJunction =
      side === 'SOURCE' ? topology.sourceRunFromJunction : topology.targetRunFromJunction;
    const otherRunFromJunction =
      side === 'SOURCE' ? topology.targetRunFromJunction : topology.sourceRunFromJunction;
    return memberBars.map((bar) => {
      const corner = classifyWallJunctionCornerSide(
        {
          memberRunFromJunction,
          otherRunFromJunction,
          junctionPoint: topology.junctionPoint,
          barPoint: bar.junctionPoint,
        },
        options,
      );
      return Object.freeze({
        ...bar,
        cornerSide: corner.status === 'RESOLVED' ? corner.side : null,
        cornerSideStatus: corner.status,
        cornerSideReason: corner.status === 'RESOLVED' ? null : corner.reason,
      });
    });
  };

  const normalizedSourceBars = annotateBars(source.bars, 'SOURCE');
  const normalizedTargetBars = annotateBars(target.bars, 'TARGET');
  if (
    topology.topology === 'L' &&
    source.pattern === 'DOUBLE_NET' &&
    [...normalizedSourceBars, ...normalizedTargetBars].some(
      (bar) => bar.cornerSideStatus !== 'RESOLVED',
    )
  ) {
    return unresolved('wall-wall-junction-double-face-mapping-unresolved', {
      modelSource: text(modelSource),
      junctionKey: text(junctionKey),
      sourceMemberId: source.memberId,
      targetMemberId: target.memberId,
      topology: topology.topology,
      pattern: source.pattern,
      horizontalSpacingRelation: spacing.relation,
    });
  }

  const mainMemberId =
    topology.topology === 'T'
      ? topology.mainSide === 'SOURCE'
        ? source.memberId
        : target.memberId
      : null;
  const branchMemberId =
    topology.topology === 'T'
      ? topology.branchSide === 'SOURCE'
        ? source.memberId
        : target.memberId
      : null;

  const resolvedJunctionKey =
    text(junctionKey) ||
    [
      'WALL_WALL_JUNCTION',
      text(modelSource) || '-',
      ...[source.memberId, target.memberId].sort(),
      topology.junctionPoint.x.toFixed(6),
      topology.junctionPoint.y.toFixed(6),
    ].join(':');

  return Object.freeze({
    status: 'RESOLVED',
    phase: 'PHASE_6A_D2A',
    modelSource: text(modelSource),
    junctionKey: resolvedJunctionKey,
    topology: topology.topology,
    pattern: source.pattern,
    horizontalSpacingRelation: spacing.relation,
    sourceMemberId: source.memberId,
    targetMemberId: target.memberId,
    mainMemberId,
    branchMemberId,
    junctionPoint: topology.junctionPoint,
    sourceRole: topology.sourceRole,
    targetRole: topology.targetRole,
    sourceRunFromJunction: topology.sourceRunFromJunction,
    targetRunFromJunction: topology.targetRunFromJunction,
    sourceHorizontalPitchMm: spacing.sourcePitchMm,
    targetHorizontalPitchMm: spacing.targetPitchMm,
    sourceBars: Object.freeze(normalizedSourceBars),
    targetBars: Object.freeze(normalizedTargetBars),
    productionReady: false,
  });
}

export const __testOnly = Object.freeze({
  SUPPORTED_PATTERNS,
  normalizedRun,
  parameterRole,
});
