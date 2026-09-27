/**
 * @fileoverview Issue #310 Phase 6a-B: RC壁同士のadjacency candidateをtrace-onlyで構築する。
 * production RebarPathは変更せず、one-to-oneで根拠が揃う候補だけを返す。
 */

import { collectWallRebarFacts } from './wallRebarSectionFacts.js';
import { buildWallFrame } from './wallRebarGeometry.js';
import { buildWallRebarTopologySnapshot } from './wallRebarTopology.js';

const EPS = 1e-9;
const DEFAULT_TOLERANCE_MM = 1e-4;
const DEFAULT_ANGLE_TOLERANCE = 1e-8;

const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (v, k) => ({ x: v.x * k, y: v.y * k, z: v.z * k });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const magnitude = (v) => Math.hypot(v.x, v.y, v.z);
const distance = (a, b) => magnitude(sub(a, b));
const normalize = (v) => {
  const length = magnitude(v);
  return length > EPS ? scale(v, 1 / length) : null;
};

function idCompare(a, b) {
  const an = Number(a);
  const bn = Number(b);
  return Number.isFinite(an) && Number.isFinite(bn) && an !== bn
    ? an - bn
    : String(a).localeCompare(String(b));
}

function collinearOverlap(a0, a1, b0, b1, toleranceMm, angleTolerance) {
  const av = sub(a1, a0);
  const bv = sub(b1, b0);
  const al = magnitude(av);
  const bl = magnitude(bv);
  if (!(al > toleranceMm) || !(bl > toleranceMm)) return null;
  const au = scale(av, 1 / al);
  const bu = scale(bv, 1 / bl);
  if (magnitude(cross(au, bu)) > angleTolerance) return null;
  const lineDistance = (p) => magnitude(cross(sub(p, a0), au));
  if (lineDistance(b0) > toleranceMm || lineDistance(b1) > toleranceMm) return null;
  const t0 = dot(sub(b0, a0), au);
  const t1 = dot(sub(b1, a0), au);
  const start = Math.max(0, Math.min(t0, t1));
  const end = Math.min(al, Math.max(t0, t1));
  if (end - start <= toleranceMm) return null;
  return {
    start: add(a0, scale(au, start)),
    end: add(a0, scale(au, end)),
    lengthMm: end - start,
  };
}

function pointSegmentDistance(point, start, end) {
  const v = sub(end, start);
  const length2 = dot(v, v);
  if (!(length2 > EPS)) return distance(point, start);
  const t = Math.max(0, Math.min(1, dot(sub(point, start), v) / length2));
  return distance(point, add(start, scale(v, t)));
}

function wallGeometry(wall, facts, check) {
  const points = [];
  for (const id of wall.nodeIds || []) {
    const node = facts.nodes.get(String(id));
    if (!node)
      return { memberId: String(wall.id), wall, check, points: null, frame: null, edges: [] };
    const offset = wall.offsets.get(String(id)) || { x: 0, y: 0, z: 0 };
    points.push({ x: node.x + offset.x, y: node.y + offset.y, z: node.z + offset.z });
  }
  const edges = points.map((start, index) => ({
    index,
    start,
    end: points[(index + 1) % points.length],
  }));
  return {
    memberId: String(wall.id),
    wall,
    check: check || null,
    points,
    frame: points.length >= 3 ? buildWallFrame(points) : null,
    edges,
  };
}

function boundaryKey(relation) {
  const pointKey = (p) => `${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}`;
  const endpoints = [pointKey(relation.start), pointKey(relation.end)].sort();
  return `${relation.sourceMemberId}:E${relation.sourceEdgeIndex}|${relation.targetMemberId}:E${relation.targetEdgeIndex}|${endpoints.join('|')}`;
}

function makeUnresolved(reason, values = {}) {
  return Object.freeze({ status: 'UNRESOLVED', reason, ...values });
}

function buildMemberRelations(geometries, toleranceMm, angleTolerance) {
  const raw = [];
  const unresolved = [];
  for (let i = 0; i < geometries.length; i += 1) {
    for (let j = i + 1; j < geometries.length; j += 1) {
      const a = geometries[i];
      const b = geometries[j];
      const overlaps = [];
      for (const edgeA of a.edges) {
        for (const edgeB of b.edges) {
          const overlap = collinearOverlap(
            edgeA.start,
            edgeA.end,
            edgeB.start,
            edgeB.end,
            toleranceMm,
            angleTolerance,
          );
          if (overlap) overlaps.push({ edgeA, edgeB, ...overlap });
        }
      }
      if (!overlaps.length) continue;
      if (overlaps.length !== 1) {
        unresolved.push(
          makeUnresolved('wall-adjacency-multiple-shared-boundaries', {
            subjectType: 'WALL_MEMBER_ADJACENCY',
            sourceMemberId: a.memberId,
            targetMemberId: b.memberId,
            sharedBoundaryCount: overlaps.length,
          }),
        );
        continue;
      }
      const overlap = overlaps[0];
      raw.push({
        sourceMemberId: a.memberId,
        targetMemberId: b.memberId,
        sourceEdgeIndex: overlap.edgeA.index,
        targetEdgeIndex: overlap.edgeB.index,
        start: overlap.start,
        end: overlap.end,
        lengthMm: overlap.lengthMm,
        sourceGeometry: a,
        targetGeometry: b,
      });
    }
  }

  const edgeUse = new Map();
  for (const relation of raw) {
    for (const key of [
      `${relation.sourceMemberId}:E${relation.sourceEdgeIndex}`,
      `${relation.targetMemberId}:E${relation.targetEdgeIndex}`,
    ]) {
      edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
    }
  }

  const accepted = [];
  for (const relation of raw) {
    const sourceKey = `${relation.sourceMemberId}:E${relation.sourceEdgeIndex}`;
    const targetKey = `${relation.targetMemberId}:E${relation.targetEdgeIndex}`;
    if (edgeUse.get(sourceKey) !== 1 || edgeUse.get(targetKey) !== 1) {
      unresolved.push(
        makeUnresolved('wall-adjacency-edge-tie', {
          subjectType: 'WALL_MEMBER_ADJACENCY',
          sourceMemberId: relation.sourceMemberId,
          targetMemberId: relation.targetMemberId,
          sourceEdgeIndex: relation.sourceEdgeIndex,
          targetEdgeIndex: relation.targetEdgeIndex,
        }),
      );
      continue;
    }
    accepted.push({ ...relation, boundaryKey: boundaryKey(relation) });
  }
  return { accepted, unresolved };
}

function crossingDirection(frame, start, end, angleTolerance) {
  if (!frame?.xAxis || !frame?.yAxis) return null;
  const axis = normalize(sub(end, start));
  if (!axis) return null;
  const xMatch = 1 - Math.abs(dot(axis, frame.xAxis)) <= angleTolerance;
  const yMatch = 1 - Math.abs(dot(axis, frame.yAxis)) <= angleTolerance;
  if (xMatch === yMatch) return null;
  return xMatch ? 'VERTICAL' : 'HORIZONTAL';
}

function projectToPlane(point, frame) {
  const delta = sub(point, frame.origin);
  return add(
    add(frame.origin, scale(frame.xAxis, dot(delta, frame.xAxis))),
    scale(frame.yAxis, dot(delta, frame.yAxis)),
  );
}

function boundaryTouch(path, fact, geometry, relation, toleranceMm) {
  const lines = (path?.primitives || []).filter((primitive) => primitive?.type === 'line');
  if (lines.length !== 1 || !geometry.frame)
    return { unresolved: 'wall-adjacency-path-geometry-unresolved' };
  const line = lines[0];
  const startProjected = projectToPlane(line.start, geometry.frame);
  const endProjected = projectToPlane(line.end, geometry.frame);
  const startOn = pointSegmentDistance(startProjected, relation.start, relation.end) <= toleranceMm;
  const endOn = pointSegmentDistance(endProjected, relation.start, relation.end) <= toleranceMm;
  if (startOn === endOn)
    return startOn ? { unresolved: 'wall-adjacency-path-lies-on-boundary' } : null;
  const actual = startOn ? line.start : line.end;
  const projected = startOn ? startProjected : endProjected;
  const axis = normalize(sub(line.end, line.start));
  if (!axis) return { unresolved: 'wall-adjacency-path-axis-unresolved' };
  return { fact, actual, projected, axis };
}

function directChildren(element, tagName) {
  return Array.from(element?.childNodes || []).filter(
    (node) => node?.nodeType === 1 && (node.tagName === tagName || node.localName === tagName),
  );
}

function commonStrengthMap(xmlDoc) {
  const result = new Map();
  const list = xmlDoc?.getElementsByTagName?.('StbReinforcementStrengthList')?.[0];
  for (const element of directChildren(list, 'StbReinforcementStrength')) {
    const dia = String(element.getAttribute('D') || '')
      .trim()
      .toUpperCase();
    const strength = String(element.getAttribute('strength') || '').trim();
    if (dia && strength) result.set(dia, strength);
  }
  return result;
}

function effectiveGrade(fact, strengths) {
  if (fact.grade) return { grade: String(fact.grade), source: 'EXPLICIT' };
  const grade =
    strengths.get(
      String(fact.diaName || '')
        .trim()
        .toUpperCase(),
    ) || null;
  return { grade, source: grade ? 'COMMON' : 'UNRESOLVED' };
}

function touchesForMember(geometry, direction, relation, topology, paths, toleranceMm) {
  const byIdentity = new Map();
  const duplicate = new Set();
  for (const path of paths || []) {
    if (path?.metadata?.role !== 'wallMain' || String(path.metadata.memberId) !== geometry.memberId)
      continue;
    const key = String(path.metadata.identityKey || '');
    if (byIdentity.has(key)) duplicate.add(key);
    byIdentity.set(key, path);
  }
  if (duplicate.size) {
    return {
      touches: [],
      unresolved: [
        makeUnresolved('wall-adjacency-duplicate-path-identity', {
          subjectType: 'WALL_MEMBER_ADJACENCY',
          memberId: geometry.memberId,
        }),
      ],
    };
  }

  const touches = [];
  const unresolved = [];
  for (const fact of (topology.facts || []).filter(
    (value) => value.memberId === geometry.memberId && value.direction === direction,
  )) {
    const path = byIdentity.get(fact.sourceIdentityKey);
    if (!path) {
      unresolved.push(
        makeUnresolved('wall-adjacency-source-path-missing', {
          subjectType: 'WALL_BAR_ADJACENCY',
          memberId: geometry.memberId,
          sourceIdentity: fact.semanticIdentity,
        }),
      );
      continue;
    }
    const touch = boundaryTouch(path, fact, geometry, relation, toleranceMm);
    if (!touch) continue;
    if (touch.unresolved) {
      unresolved.push(
        makeUnresolved(touch.unresolved, {
          subjectType: 'WALL_BAR_ADJACENCY',
          memberId: geometry.memberId,
          sourceSegmentIdentity: fact.segmentIdentity,
        }),
      );
      continue;
    }
    touches.push(touch);
  }
  touches.sort((a, b) => a.fact.segmentIdentity.localeCompare(b.fact.segmentIdentity));
  return { touches, unresolved };
}

function faceCompatible(a, b, toleranceMm, angleTolerance) {
  const aOffset = sub(a.actual, a.projected);
  const bOffset = sub(b.actual, b.projected);
  const am = magnitude(aOffset);
  const bm = magnitude(bOffset);
  if (am <= toleranceMm && bm <= toleranceMm) return true;
  if (am <= toleranceMm || bm <= toleranceMm) return false;
  return 1 - dot(scale(aOffset, 1 / am), scale(bOffset, 1 / bm)) <= angleTolerance;
}

function pairBars(
  relation,
  sourceTouches,
  targetTouches,
  modelSource,
  toleranceMm,
  angleTolerance,
) {
  const candidates = [];
  const unresolved = [];
  const provisional = [];

  for (const source of sourceTouches) {
    const location = targetTouches.filter(
      (target) => distance(source.projected, target.projected) <= toleranceMm,
    );
    const axis = location.filter(
      (target) => 1 - Math.abs(dot(source.axis, target.axis)) <= angleTolerance,
    );
    const face = axis.filter((target) =>
      faceCompatible(source, target, toleranceMm, angleTolerance),
    );
    const dia = face.filter((target) => Math.abs(source.fact.dia - target.fact.dia) <= EPS);
    const grade = dia.filter(
      (target) =>
        source.grade.grade && target.grade.grade && source.grade.grade === target.grade.grade,
    );

    let reason = null;
    if (!location.length) reason = 'wall-adjacency-no-target-at-boundary-position';
    else if (!axis.length) reason = 'wall-adjacency-axis-unresolved';
    else if (!face.length) reason = 'wall-adjacency-face-mapping-unresolved';
    else if (!dia.length) reason = 'wall-adjacency-diameter-mismatch';
    else if (!source.grade.grade || dia.some((target) => !target.grade.grade))
      reason = 'wall-adjacency-grade-unresolved';
    else if (!grade.length) reason = 'wall-adjacency-grade-mismatch';
    else if (grade.length !== 1) reason = 'wall-adjacency-bar-tie';

    if (reason) {
      unresolved.push(
        makeUnresolved(reason, {
          subjectType: 'WALL_BAR_ADJACENCY',
          boundaryKey: relation.boundaryKey,
          sourceMemberId: relation.sourceMemberId,
          targetMemberId: relation.targetMemberId,
          sourceIdentity: source.fact.semanticIdentity,
          sourceSegmentIdentity: source.fact.segmentIdentity,
        }),
      );
    } else provisional.push({ source, target: grade[0] });
  }

  const targetUse = new Map();
  for (const pair of provisional) {
    const key = pair.target.fact.segmentIdentity;
    targetUse.set(key, (targetUse.get(key) || 0) + 1);
  }
  const acceptedTargets = new Set();
  for (const pair of provisional) {
    const targetKey = pair.target.fact.segmentIdentity;
    if (targetUse.get(targetKey) !== 1) {
      unresolved.push(
        makeUnresolved('wall-adjacency-bar-tie', {
          subjectType: 'WALL_BAR_ADJACENCY',
          boundaryKey: relation.boundaryKey,
          sourceMemberId: relation.sourceMemberId,
          targetMemberId: relation.targetMemberId,
          sourceIdentity: pair.source.fact.semanticIdentity,
          targetIdentity: pair.target.fact.semanticIdentity,
        }),
      );
      continue;
    }
    acceptedTargets.add(targetKey);
    const candidateKey = [
      'WALL_ADJACENCY',
      modelSource || '-',
      relation.sourceMemberId,
      relation.targetMemberId,
      pair.source.fact.segmentIdentity,
      pair.target.fact.segmentIdentity,
    ].join(':');
    candidates.push(
      Object.freeze({
        status: 'CANDIDATE',
        candidateType: 'WALL_BAR_ADJACENCY',
        candidateKey,
        modelSource: modelSource || null,
        boundaryKey: relation.boundaryKey,
        boundaryLengthMm: relation.lengthMm,
        sourceMemberId: relation.sourceMemberId,
        targetMemberId: relation.targetMemberId,
        direction: pair.source.fact.direction,
        sourceIdentity: pair.source.fact.semanticIdentity,
        targetIdentity: pair.target.fact.semanticIdentity,
        sourceSegmentIdentity: pair.source.fact.segmentIdentity,
        targetSegmentIdentity: pair.target.fact.segmentIdentity,
        sourceFace: pair.source.fact.face,
        targetFace: pair.target.fact.face,
        dia: pair.source.fact.dia,
        diaName: pair.source.fact.diaName,
        grade: pair.source.grade.grade,
        sourceGradeSource: pair.source.grade.source,
        targetGradeSource: pair.target.grade.source,
        endpointGapMm: distance(pair.source.actual, pair.target.actual),
        axisDotAbs: Math.abs(dot(pair.source.axis, pair.target.axis)),
        axisRelation: 'PARALLEL',
      }),
    );
  }

  for (const target of targetTouches) {
    if (acceptedTargets.has(target.fact.segmentIdentity)) continue;
    if (
      provisional.some((pair) => pair.target.fact.segmentIdentity === target.fact.segmentIdentity)
    )
      continue;
    unresolved.push(
      makeUnresolved('wall-adjacency-unmatched-target-bar', {
        subjectType: 'WALL_BAR_ADJACENCY',
        boundaryKey: relation.boundaryKey,
        sourceMemberId: relation.sourceMemberId,
        targetMemberId: relation.targetMemberId,
        targetIdentity: target.fact.semanticIdentity,
        targetSegmentIdentity: target.fact.segmentIdentity,
      }),
    );
  }
  return { candidates, unresolved };
}

/** wall-wall adjacencyをproduction geometryへ書き戻さずsnapshot化する。 */
export function buildWallRebarAdjacencySnapshot(
  xmlDoc,
  renderPlan,
  {
    modelSource = null,
    topology = null,
    toleranceMm = DEFAULT_TOLERANCE_MM,
    angleTolerance = DEFAULT_ANGLE_TOLERANCE,
  } = {},
) {
  const facts = collectWallRebarFacts(xmlDoc);
  const semantic = topology || buildWallRebarTopologySnapshot(renderPlan, { modelSource });
  const checks = new Map(
    (renderPlan?.checks || []).map((check) => [String(check.memberId), check]),
  );
  const geometries = [...facts.walls]
    .sort((a, b) => idCompare(a.id, b.id))
    .map((wall) => wallGeometry(wall, facts, checks.get(String(wall.id))));
  const strengths = commonStrengthMap(xmlDoc);
  const unresolvedMembers = new Set(
    (semantic.unresolved || []).map((item) => String(item.memberId || '')).filter(Boolean),
  );
  const relations = buildMemberRelations(geometries, toleranceMm, angleTolerance);
  const memberAdjacencies = [];
  const candidates = [];
  const unresolved = [...relations.unresolved];

  for (const relation of relations.accepted) {
    const sourceCheck = relation.sourceGeometry.check;
    const targetCheck = relation.targetGeometry.check;
    const unresolvedRelation = (reason, extra = {}) =>
      makeUnresolved(reason, {
        subjectType: 'WALL_MEMBER_ADJACENCY',
        boundaryKey: relation.boundaryKey,
        sourceMemberId: relation.sourceMemberId,
        targetMemberId: relation.targetMemberId,
        ...extra,
      });

    if (sourceCheck?.status !== 'READY' || targetCheck?.status !== 'READY') {
      unresolved.push(
        unresolvedRelation('wall-adjacency-member-not-ready', {
          sourceCheckCode: sourceCheck?.code || null,
          targetCheckCode: targetCheck?.code || null,
        }),
      );
      continue;
    }
    if (
      unresolvedMembers.has(relation.sourceMemberId) ||
      unresolvedMembers.has(relation.targetMemberId)
    ) {
      unresolved.push(unresolvedRelation('wall-adjacency-semantic-facts-unresolved'));
      continue;
    }
    const sourceDirection = crossingDirection(
      relation.sourceGeometry.frame,
      relation.start,
      relation.end,
      angleTolerance,
    );
    const targetDirection = crossingDirection(
      relation.targetGeometry.frame,
      relation.start,
      relation.end,
      angleTolerance,
    );
    if (!sourceDirection || !targetDirection) {
      unresolved.push(unresolvedRelation('wall-adjacency-boundary-axis-unresolved'));
      continue;
    }
    if (sourceDirection !== targetDirection) {
      unresolved.push(unresolvedRelation('wall-adjacency-direction-mismatch'));
      continue;
    }

    const sourceTouch = touchesForMember(
      relation.sourceGeometry,
      sourceDirection,
      relation,
      semantic,
      renderPlan?.paths || [],
      toleranceMm,
    );
    const targetTouch = touchesForMember(
      relation.targetGeometry,
      targetDirection,
      relation,
      semantic,
      renderPlan?.paths || [],
      toleranceMm,
    );
    unresolved.push(...sourceTouch.unresolved, ...targetTouch.unresolved);
    if (sourceTouch.unresolved.length || targetTouch.unresolved.length) continue;

    const sourceTouches = sourceTouch.touches.map((touch) => ({
      ...touch,
      grade: effectiveGrade(touch.fact, strengths),
    }));
    const targetTouches = targetTouch.touches.map((touch) => ({
      ...touch,
      grade: effectiveGrade(touch.fact, strengths),
    }));
    const paired = pairBars(
      relation,
      sourceTouches,
      targetTouches,
      modelSource,
      toleranceMm,
      angleTolerance,
    );
    unresolved.push(...paired.unresolved);
    candidates.push(...paired.candidates);
    memberAdjacencies.push(
      Object.freeze({
        status: 'ADJACENT',
        modelSource: modelSource || null,
        relationKey: `WALL_ADJACENCY:${relation.sourceMemberId}:${relation.targetMemberId}`,
        boundaryKey: relation.boundaryKey,
        sourceMemberId: relation.sourceMemberId,
        targetMemberId: relation.targetMemberId,
        sourceEdgeIndex: relation.sourceEdgeIndex,
        targetEdgeIndex: relation.targetEdgeIndex,
        boundaryLengthMm: relation.lengthMm,
        direction: sourceDirection,
        candidateCount: paired.candidates.length,
      }),
    );
  }

  memberAdjacencies.sort((a, b) => a.relationKey.localeCompare(b.relationKey));
  candidates.sort((a, b) => a.candidateKey.localeCompare(b.candidateKey));
  unresolved.sort((a, b) =>
    `${a.subjectType || ''}:${a.boundaryKey || ''}:${a.sourceSegmentIdentity || ''}:${a.reason}`.localeCompare(
      `${b.subjectType || ''}:${b.boundaryKey || ''}:${b.sourceSegmentIdentity || ''}:${b.reason}`,
    ),
  );
  return Object.freeze({
    modelSource: modelSource || null,
    memberAdjacencies: Object.freeze(memberAdjacencies),
    candidates: Object.freeze(candidates),
    unresolved: Object.freeze(unresolved),
  });
}

export const __testOnly = Object.freeze({
  collinearOverlap,
  pointSegmentDistance,
  crossingDirection,
});
