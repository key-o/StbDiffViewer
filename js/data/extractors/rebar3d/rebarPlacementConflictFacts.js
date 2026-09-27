/**
 * @fileoverview Actual world/topology facts and Appendix A2 geometry for Issue #292.
 */

import { barOuterDiameterMm } from '../../../constants/beamOpeningRules.js';
import {
  columnEndpointBarFacts,
  columnTransitionGeometry,
} from './columnJointTransitionGeometry.js';
import { classifyGirderJointBarTopology } from './girderPriorityResolver.js';
import {
  girderEndpointBarFacts,
  resolveGirderEndpointGeometry,
} from './girderJointTransitionGeometry.js';
import {
  RebarPlacementCandidateEffect,
  buildAppendixA2PlacementGeometryContext,
} from './rebarPlacementGeometryGate.js';

const EPS = 1e-6;
const DEFAULT_COLLISION_TOLERANCE_MM = 0.5;

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim().toUpperCase();
}

function finite(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isRc(element) {
  const kind = text(element?.getAttribute?.('kind_structure'));
  return !kind || kind === 'RC';
}

function endpointAtNode(element, nodeId) {
  if (element?.getAttribute?.('id_node_start') === String(nodeId)) return 'start';
  if (element?.getAttribute?.('id_node_end') === String(nodeId)) return 'end';
  return null;
}

function columnEndpointAtNode(element, nodeId) {
  if (element?.getAttribute?.('id_node_top') === String(nodeId)) return 'top';
  if (element?.getAttribute?.('id_node_bottom') === String(nodeId)) return 'bottom';
  return null;
}

function outerDiameter(bar) {
  const dia = finite(bar?.dia);
  const resolved = barOuterDiameterMm(bar?.diaName, dia ?? NaN);
  return Number.isFinite(Number(resolved)) && Number(resolved) > 0 ? Number(resolved) : dia;
}

function semanticBarKey(bar) {
  return [
    text(bar?.role),
    Number.isInteger(Number(bar?.layer)) ? Number(bar.layer) : '',
    text(bar?.diaName || bar?.dia),
    text(bar?.grade),
    text(bar?.topologyRole),
    text(bar?.topologyPosition),
  ].join('|');
}

function pointKey(point) {
  return [point?.x, point?.y]
    .map((value) => {
      const number = finite(value);
      return number === null ? '' : number.toFixed(6);
    })
    .join(':');
}

function stableId(parts) {
  return parts.map((value) => String(value ?? '')).join(':');
}

function memberTypeForTag(tagName) {
  return tagName === 'StbBeam' ? 'BEAM' : 'GIRDER';
}

function stableColumnFact(bar, memberId, endpoint) {
  return Object.freeze({
    ...bar,
    memberType: 'COLUMN',
    roleClass: 'MAIN',
    semanticIdentity: stableId(['COLUMN', memberId, endpoint, bar.barIndex]),
    sourceMemberId: String(memberId),
    sourceEndpoint: endpoint,
    outerDiameterMm: outerDiameter(bar),
  });
}

function stableBeamFact(bar, memberId, endpoint, memberType, geometry) {
  const sectionAxis = geometry?.planDirection || null;
  const jointAxis = geometry?.outwardPlanDirection || sectionAxis;
  const sectionTransverse = sectionAxis ? { x: -sectionAxis.y, y: sectionAxis.x } : null;
  const jointTransverse = jointAxis ? { x: -jointAxis.y, y: jointAxis.x } : null;
  const center = geometry?.center || null;
  const crossOffsetMm =
    jointTransverse && center && bar?.worldPosition
      ? (bar.worldPosition.x - center.x) * jointTransverse.x +
        (bar.worldPosition.y - center.y) * jointTransverse.y
      : finite(bar?.localPosition?.u);
  return Object.freeze({
    ...bar,
    memberType,
    roleClass: ['TOP', 'BOTTOM'].includes(text(bar?.role)) ? 'MAIN' : text(bar?.role),
    semanticIdentity: stableId([memberType, memberId, endpoint, bar.barIndex]),
    sourceMemberId: String(memberId),
    sourceEndpoint: endpoint,
    planDirection: jointAxis ? Object.freeze({ x: jointAxis.x, y: jointAxis.y }) : null,
    transverseDirection: jointTransverse ? Object.freeze(jointTransverse) : null,
    sectionTransverseDirection: sectionTransverse ? Object.freeze(sectionTransverse) : null,
    sectionRollRad: Number(geometry?.rollRad) || 0,
    memberLengthMm:
      geometry?.start && geometry?.end
        ? Math.hypot(
            Number(geometry.end.x) - Number(geometry.start.x),
            Number(geometry.end.y) - Number(geometry.start.y),
            Number(geometry.end.z) - Number(geometry.start.z),
          )
        : null,
    crossOffsetMm,
    a2Side: crossOffsetMm === null ? null : crossOffsetMm >= 0 ? 'POSITIVE' : 'NEGATIVE',
    outerDiameterMm: outerDiameter(bar),
  });
}

function sameLocalPosition(left, right) {
  const a = left?.localPosition;
  const b = right?.localPosition;
  return (
    a && b && [a.u, a.v, b.u, b.v].every(Number.isFinite) && Math.hypot(a.u - b.u, a.v - b.v) <= EPS
  );
}

function groupColumnJointFacts(bars, nodeId) {
  const groups = new Map();
  for (const bar of bars) {
    const key = [pointKey(bar.worldPosition), semanticBarKey(bar)].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(bar);
  }

  const result = [];
  for (const key of [...groups.keys()].sort()) {
    const items = groups
      .get(key)
      .slice()
      .sort((a, b) => a.semanticIdentity.localeCompare(b.semanticIdentity));
    const endpoints = new Set(items.map((item) => item.sourceEndpoint));
    const memberIds = [...new Set(items.map((item) => item.sourceMemberId))].sort();
    const endpointCounts = new Map();
    for (const item of items) {
      const endpoint = String(item.sourceEndpoint || '');
      endpointCounts.set(endpoint, (endpointCounts.get(endpoint) || 0) + 1);
    }
    const duplicateEndpointSource = [...endpointCounts.values()].some((count) => count > 1);
    const first = items[0];
    const localPositionConsistent = items.every((item) => sameLocalPosition(first, item));
    result.push(
      Object.freeze({
        ...first,
        localPosition: localPositionConsistent ? first.localPosition : null,
        conflictSourceAmbiguity: duplicateEndpointSource
          ? 'column-joint-multiple-members-at-same-endpoint'
          : null,
        semanticIdentity: stableId([
          'COLUMN_JOINT',
          nodeId,
          text(first.topologyPosition) || pointKey(first.worldPosition),
          text(first.role),
          first.layer ?? '',
          text(first.diaName || first.dia),
        ]),
        sourceMemberId: memberIds[0] || null,
        sourceMemberIds: Object.freeze(memberIds),
        sourceEndpoint: endpoints.size > 1 ? 'joint' : first.sourceEndpoint,
        continuity:
          endpoints.has('top') && endpoints.has('bottom') ? 'STRAIGHT' : text(first.continuity),
      }),
    );
  }
  return result;
}

function canonicalDirection(direction) {
  if (!direction) return null;
  const x = Math.abs(direction.x) <= EPS ? 0 : direction.x;
  const y = Math.abs(direction.y) <= EPS ? 0 : direction.y;
  if (Math.abs(x) >= Math.abs(y)) return x >= 0 ? { x, y } : { x: -x, y: -y };
  return y >= 0 ? { x, y } : { x: -x, y: -y };
}

function beamLineKey(bar) {
  const direction = canonicalDirection(bar.planDirection);
  if (!direction || !bar.worldPosition) return bar.semanticIdentity;
  const transverse = { x: -direction.y, y: direction.x };
  const offset = bar.worldPosition.x * transverse.x + bar.worldPosition.y * transverse.y;
  return [
    direction.x.toFixed(9),
    direction.y.toFixed(9),
    offset.toFixed(6),
    Number(bar.worldPosition.z).toFixed(6),
    text(bar.role),
    bar.layer ?? '',
    text(bar.diaName || bar.dia),
    text(bar.grade),
  ].join('|');
}

function annotateBeamContinuity(bars) {
  const groups = new Map();
  for (const bar of bars) {
    const key = beamLineKey(bar);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(bar);
  }
  return bars.map((bar) => {
    const group = groups.get(beamLineKey(bar)) || [];
    const distinctMembers = new Set(group.map((item) => item.sourceMemberId));
    return Object.freeze({
      ...bar,
      continuity: distinctMembers.size > 1 ? 'STRAIGHT' : text(bar.continuity),
    });
  });
}

function columnFactsAtNode(scanTag, nodeId, columnLayouts) {
  const bars = [];
  const endpointMemberCounts = new Map([
    ['top', 0],
    ['bottom', 0],
  ]);
  for (const element of scanTag('StbColumn')) {
    if (!isRc(element)) continue;
    const endpoint = columnEndpointAtNode(element, nodeId);
    if (!endpoint) continue;
    endpointMemberCounts.set(endpoint, (endpointMemberCounts.get(endpoint) || 0) + 1);
    const memberId = element.getAttribute('id');
    const layout = columnLayouts?.get(String(element.getAttribute('id_section')));
    const geometry = layout ? columnTransitionGeometry(scanTag, element) : null;
    if (!memberId || !layout || !geometry) continue;
    for (const bar of columnEndpointBarFacts(element, layout, geometry, endpoint)) {
      if (!bar?.worldPosition || !Object.values(bar.worldPosition).every(Number.isFinite)) continue;
      bars.push(stableColumnFact(bar, memberId, endpoint));
    }
  }

  const grouped = groupColumnJointFacts(bars, nodeId);
  const ambiguousNode = [...endpointMemberCounts.values()].some((count) => count > 1);
  if (!ambiguousNode) return grouped;
  return grouped.map((bar) =>
    Object.freeze({
      ...bar,
      conflictSourceAmbiguity: 'column-joint-multiple-members-at-same-endpoint',
    }),
  );
}

function beamFactsAtNode(scanTag, nodeId, beamLayoutMaps) {
  const bars = [];
  for (const tagName of ['StbGirder', 'StbBeam']) {
    const map = tagName === 'StbBeam' ? beamLayoutMaps?.beam : beamLayoutMaps?.girder;
    for (const element of scanTag(tagName)) {
      if (!isRc(element)) continue;
      const endpoint = endpointAtNode(element, nodeId);
      if (!endpoint) continue;
      const memberId = element.getAttribute('id');
      const layout = map?.get(String(element.getAttribute('id_section')));
      const geometry = layout
        ? resolveGirderEndpointGeometry(scanTag, element, layout, endpoint)
        : null;
      if (!memberId || !layout || !geometry) continue;
      const endpointBars = girderEndpointBarFacts(element, layout, geometry).map((bar) => ({
        ...bar,
        jointTransverseMm: finite(bar?.localPosition?.u),
      }));
      const classified = classifyGirderJointBarTopology(endpointBars);
      for (const bar of classified) {
        if (!bar?.worldPosition || !Object.values(bar.worldPosition).every(Number.isFinite))
          continue;
        bars.push(stableBeamFact(bar, memberId, endpoint, memberTypeForTag(tagName), geometry));
      }
    }
  }
  return annotateBeamContinuity(bars).sort((a, b) =>
    a.semanticIdentity.localeCompare(b.semanticIdentity),
  );
}

export function measureColumnBeamPlanConflict(columnBar, beamBar, options = {}) {
  const direction = beamBar?.planDirection;
  const columnPoint = columnBar?.worldPosition;
  const beamPoint = beamBar?.worldPosition;
  if (!direction || !columnPoint || !beamPoint) {
    return Object.freeze({ collision: false, reason: 'world-geometry-unresolved' });
  }
  if (
    ![columnPoint.x, columnPoint.y, beamPoint.x, beamPoint.y, direction.x, direction.y].every(
      Number.isFinite,
    )
  ) {
    return Object.freeze({ collision: false, reason: 'world-geometry-unresolved' });
  }
  const transverse = { x: -direction.y, y: direction.x };
  const deltaX = columnPoint.x - beamPoint.x;
  const deltaY = columnPoint.y - beamPoint.y;
  const centerDistanceMm = Math.abs(deltaX * transverse.x + deltaY * transverse.y);
  const axialDistanceMm = deltaX * direction.x + deltaY * direction.y;
  const columnOuter = finite(columnBar?.outerDiameterMm);
  const beamOuter = finite(beamBar?.outerDiameterMm);
  if (!(columnOuter > 0) || !(beamOuter > 0)) {
    return Object.freeze({ collision: false, reason: 'bar-diameter-unresolved' });
  }
  const clearMm = centerDistanceMm - (columnOuter + beamOuter) / 2;
  const collisionToleranceMm =
    finite(options.collisionToleranceMm) ?? DEFAULT_COLLISION_TOLERANCE_MM;
  return Object.freeze({
    collision: clearMm < collisionToleranceMm + EPS,
    reason: null,
    centerDistanceMm,
    axialDistanceMm,
    clearMm,
    collisionToleranceMm,
    columnOuterDiameterMm: columnOuter,
    beamOuterDiameterMm: beamOuter,
  });
}

function scopeMatch(item, pair) {
  if (item?.side && text(item.side) !== text(pair.beam.a2Side)) return false;
  if (item?.role && text(item.role) !== text(pair.beam.role)) return false;
  return true;
}

function proposedEffects(baseGeometryContext, pair) {
  const effects = [];
  for (const required of baseGeometryContext?.geometryRequirements || []) {
    if (!scopeMatch(required, pair)) continue;
    if (
      required.type === RebarPlacementCandidateEffect.SIDE_OUTER_BAR_INSET &&
      Number.isFinite(required.minimumDistanceMm)
    ) {
      effects.push({
        type: required.type,
        side: required.side,
        role: required.role,
        distanceMm: required.minimumDistanceMm,
      });
    }
  }
  return effects;
}

function scopedGeometryContext(jointCheck, pair) {
  if (!jointCheck) {
    return Object.freeze({
      hardConstraintViolations: Object.freeze([]),
      geometryRequirements: Object.freeze([]),
      candidateEffects: Object.freeze([]),
    });
  }
  const base = buildAppendixA2PlacementGeometryContext(jointCheck);
  const effects = proposedEffects(base, pair);
  const evaluated = buildAppendixA2PlacementGeometryContext(jointCheck, {
    candidateEffects: effects,
  });
  return Object.freeze({
    hardConstraintViolations: Object.freeze(
      (evaluated.hardConstraintViolations || []).filter((item) => scopeMatch(item, pair)),
    ),
    geometryRequirements: Object.freeze(
      (evaluated.geometryRequirements || []).filter((item) => scopeMatch(item, pair)),
    ),
    candidateEffects: Object.freeze(effects),
  });
}

function pairSortKey(pair) {
  return [String(pair.nodeId), pair.column.semanticIdentity, pair.beam.semanticIdentity].join('|');
}

export { finite, isRc, columnFactsAtNode, beamFactsAtNode, scopedGeometryContext, pairSortKey };
