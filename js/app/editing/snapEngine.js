/**
 * @fileoverview Working Document 向け semantic Snap Engine。
 *
 * pointer event や Three.js scene には依存せず、ST-Bridge Working Document から
 * Node / member endpoint / midpoint / member axis / grid axis の軽量 primitive を構築する。
 * query は model-space tolerance を受け取り、priority → distance → stable key の順で
 * deterministic に候補を解決する。
 */

import { STB_TAG_NAMES } from '../../constants/elementTypes.js';

export const SNAP_TYPES = Object.freeze({
  NODE: 'node',
  ENDPOINT: 'endpoint',
  MIDPOINT: 'midpoint',
  MEMBER_AXIS: 'memberAxis',
  GRID: 'grid',
});

export const SNAP_PRIORITY = Object.freeze({
  [SNAP_TYPES.NODE]: 10,
  [SNAP_TYPES.ENDPOINT]: 20,
  [SNAP_TYPES.MIDPOINT]: 30,
  [SNAP_TYPES.MEMBER_AXIS]: 40,
  [SNAP_TYPES.GRID]: 50,
});

const LINE_ELEMENT_DEFINITIONS = Object.freeze([
  {
    elementType: 'Column',
    tagName: STB_TAG_NAMES.COLUMN,
    start: 'id_node_bottom',
    end: 'id_node_top',
  },
  { elementType: 'Post', tagName: STB_TAG_NAMES.POST, start: 'id_node_bottom', end: 'id_node_top' },
  {
    elementType: 'Girder',
    tagName: STB_TAG_NAMES.GIRDER,
    start: 'id_node_start',
    end: 'id_node_end',
  },
  { elementType: 'Beam', tagName: STB_TAG_NAMES.BEAM, start: 'id_node_start', end: 'id_node_end' },
  {
    elementType: 'Brace',
    tagName: STB_TAG_NAMES.BRACE,
    start: 'id_node_start',
    end: 'id_node_end',
  },
  {
    elementType: 'Parapet',
    tagName: STB_TAG_NAMES.PARAPET,
    start: 'id_node_start',
    end: 'id_node_end',
  },
  {
    elementType: 'StripFooting',
    tagName: STB_TAG_NAMES.STRIP_FOOTING,
    start: 'id_node_start',
    end: 'id_node_end',
  },
]);

const EPSILON = 1e-9;
const AXIS_ORDER = Object.freeze(['X', 'Y', 'Z']);

function finiteNumber(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finitePosition(value) {
  if (!value || typeof value !== 'object') return null;
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  const z = finiteNumber(value.z);
  return x === null || y === null || z === null ? null : { x, y, z };
}

function distanceSquared(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function positionFromNodeMap(nodeMap, nodeId) {
  if (!(nodeMap instanceof Map)) return null;
  const targetId = String(nodeId);
  if (nodeMap.has(targetId)) return finitePosition(nodeMap.get(targetId));
  for (const [key, value] of nodeMap.entries()) {
    if (String(key) === targetId) return finitePosition(value);
  }
  return null;
}

function createNodePositionResolver(document, nodeMap) {
  const xmlPositions = new Map();
  for (const node of document ? [...document.getElementsByTagName(STB_TAG_NAMES.NODE)] : []) {
    const id = node.getAttribute('id');
    if (!id) continue;
    const position = finitePosition({
      x: node.getAttribute('X'),
      y: node.getAttribute('Y'),
      z: node.getAttribute('Z'),
    });
    if (position) xmlPositions.set(String(id), position);
  }

  return {
    ids: [...xmlPositions.keys()],
    get(nodeId) {
      return positionFromNodeMap(nodeMap, nodeId) || xmlPositions.get(String(nodeId)) || null;
    },
  };
}

function midpoint(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: (a.z + b.z) / 2,
  };
}

function nearestOnSegment(query, start, end) {
  const vx = end.x - start.x;
  const vy = end.y - start.y;
  const vz = end.z - start.z;
  const lengthSquared = vx * vx + vy * vy + vz * vz;
  if (!(lengthSquared > EPSILON)) return { ...start };
  const wx = query.x - start.x;
  const wy = query.y - start.y;
  const wz = query.z - start.z;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy + wz * vz) / lengthSquared));
  return { x: start.x + vx * t, y: start.y + vy * t, z: start.z + vz * t };
}

function normalizeDegrees(value) {
  const normalized = Number(value) % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function angleOnArc(angle, startAngle, endAngle) {
  if (Math.abs(endAngle - startAngle) >= 360 - EPSILON) return true;
  const angleN = normalizeDegrees(angle);
  const startN = normalizeDegrees(startAngle);
  const endN = normalizeDegrees(endAngle);
  if (startN <= endN) return angleN >= startN - EPSILON && angleN <= endN + EPSILON;
  return angleN >= startN - EPSILON || angleN <= endN + EPSILON;
}

function angularDistanceDegrees(a, b) {
  const delta = Math.abs(normalizeDegrees(a) - normalizeDegrees(b));
  return Math.min(delta, 360 - delta);
}

function nearestOnArc(query, axis) {
  const dx = query.x - axis.originX;
  const dy = query.y - axis.originY;
  const radius = Number(axis.radius);
  if (!(radius > 0) || !Number.isFinite(dx) || !Number.isFinite(dy)) return null;

  const rawAngle = normalizeDegrees((Math.atan2(dy, dx) * 180) / Math.PI);
  let angle = rawAngle;
  if (!angleOnArc(rawAngle, axis.startAngle, axis.endAngle)) {
    angle =
      angularDistanceDegrees(rawAngle, axis.startAngle) <=
      angularDistanceDegrees(rawAngle, axis.endAngle)
        ? normalizeDegrees(axis.startAngle)
        : normalizeDegrees(axis.endAngle);
  }
  const rad = (angle * Math.PI) / 180;
  return {
    x: axis.originX + radius * Math.cos(rad),
    y: axis.originY + radius * Math.sin(rad),
    z: query.z,
  };
}

function nearestOnGridAxis(query, axis) {
  if (axis.axisKind === 'parallel') {
    const angle = (Number(axis.angle) * Math.PI) / 180;
    const px = Number(axis.x);
    const py = Number(axis.y);
    if (![angle, px, py].every(Number.isFinite)) return null;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const t = (query.x - px) * ux + (query.y - py) * uy;
    return { x: px + ux * t, y: py + uy * t, z: query.z };
  }

  if (axis.axisKind === 'radial') {
    const angle = (Number(axis.angle) * Math.PI) / 180;
    const px = Number(axis.originX);
    const py = Number(axis.originY);
    if (![angle, px, py].every(Number.isFinite)) return null;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const t = (query.x - px) * ux + (query.y - py) * uy;
    return { x: px + ux * t, y: py + uy * t, z: query.z };
  }

  if (axis.axisKind === 'arc') return nearestOnArc(query, axis);
  return null;
}

function primitiveKey(primitive) {
  return primitive.key || `${primitive.type}:${primitive.id || ''}`;
}

function addPointCandidate(result, primitive, query, toleranceSquared, excludedNodeIds) {
  if (primitive.nodeId && excludedNodeIds.has(String(primitive.nodeId))) return;
  const d2 = distanceSquared(query, primitive.position);
  if (d2 > toleranceSquared) return;
  result.push({
    type: primitive.type,
    priority: SNAP_PRIORITY[primitive.type],
    distance: Math.sqrt(d2),
    position: { ...primitive.position },
    source: primitive.source,
    key: primitiveKey(primitive),
  });
}

function addDynamicCandidate(result, primitive, query, toleranceSquared) {
  const position = primitive.closest(query);
  if (!position) return;
  const d2 = distanceSquared(query, position);
  if (d2 > toleranceSquared) return;
  result.push({
    type: primitive.type,
    priority: SNAP_PRIORITY[primitive.type],
    distance: Math.sqrt(d2),
    position,
    source: primitive.source,
    key: primitiveKey(primitive),
  });
}

function collectNodePrimitives(resolver, result) {
  for (const nodeId of resolver.ids) {
    const position = resolver.get(nodeId);
    if (!position) continue;
    result.push({
      type: SNAP_TYPES.NODE,
      nodeId,
      position,
      source: { elementType: 'Node', elementId: nodeId },
      key: `node:${nodeId}`,
    });
  }
}

function collectMemberPrimitives(document, resolver, result) {
  if (!document) return;
  for (const definition of LINE_ELEMENT_DEFINITIONS) {
    for (const element of [...document.getElementsByTagName(definition.tagName)]) {
      const elementId = element.getAttribute('id');
      const startNodeId = element.getAttribute(definition.start);
      const endNodeId = element.getAttribute(definition.end);
      const start = resolver.get(startNodeId);
      const end = resolver.get(endNodeId);
      if (!elementId || !startNodeId || !endNodeId || !start || !end) continue;
      const sourceBase = { elementType: definition.elementType, elementId: String(elementId) };

      result.push({
        type: SNAP_TYPES.ENDPOINT,
        nodeId: String(startNodeId),
        position: start,
        source: { ...sourceBase, role: 'start', nodeId: String(startNodeId) },
        key: `endpoint:${definition.elementType}:${elementId}:start`,
      });
      result.push({
        type: SNAP_TYPES.ENDPOINT,
        nodeId: String(endNodeId),
        position: end,
        source: { ...sourceBase, role: 'end', nodeId: String(endNodeId) },
        key: `endpoint:${definition.elementType}:${elementId}:end`,
      });
      result.push({
        type: SNAP_TYPES.MIDPOINT,
        position: midpoint(start, end),
        source: sourceBase,
        key: `midpoint:${definition.elementType}:${elementId}`,
      });
      result.push({
        type: SNAP_TYPES.MEMBER_AXIS,
        closest: (query) => nearestOnSegment(query, start, end),
        source: sourceBase,
        key: `memberAxis:${definition.elementType}:${elementId}`,
      });
    }
  }
}

function collectGridAxes(document) {
  const axes = [];
  if (!document) return axes;

  for (const axis of [...document.getElementsByTagName(STB_TAG_NAMES.PARALLEL_AXIS)]) {
    const parent = axis.parentElement || axis.parentNode;
    const id = axis.getAttribute('id');
    const distance = finiteNumber(axis.getAttribute('distance'));
    const originX = finiteNumber(parent?.getAttribute?.('X')) ?? 0;
    const originY = finiteNumber(parent?.getAttribute?.('Y')) ?? 0;
    const angle = finiteNumber(parent?.getAttribute?.('angle')) ?? 0;
    if (!id || distance === null) continue;
    const perpendicular = (angle * Math.PI) / 180 + Math.PI / 2;
    axes.push({
      id: String(id),
      name: axis.getAttribute('name') || null,
      axisKind: 'parallel',
      angle,
      x: originX + distance * Math.cos(perpendicular),
      y: originY + distance * Math.sin(perpendicular),
    });
  }

  for (const axis of [...document.getElementsByTagName(STB_TAG_NAMES.RADIAL_AXIS)]) {
    const parent = axis.parentElement || axis.parentNode;
    const id = axis.getAttribute('id');
    const angle = finiteNumber(axis.getAttribute('angle'));
    const originX = finiteNumber(parent?.getAttribute?.('X')) ?? 0;
    const originY = finiteNumber(parent?.getAttribute?.('Y')) ?? 0;
    if (!id || angle === null) continue;
    axes.push({
      id: String(id),
      name: axis.getAttribute('name') || null,
      axisKind: 'radial',
      angle,
      originX,
      originY,
    });
  }

  for (const axis of [...document.getElementsByTagName(STB_TAG_NAMES.ARC_AXIS)]) {
    const parent = axis.parentElement || axis.parentNode;
    const id = axis.getAttribute('id');
    const radius = finiteNumber(axis.getAttribute('radius'));
    const originX = finiteNumber(parent?.getAttribute?.('X')) ?? 0;
    const originY = finiteNumber(parent?.getAttribute?.('Y')) ?? 0;
    const startAngle = finiteNumber(parent?.getAttribute?.('start_angle'));
    const endAngle = finiteNumber(parent?.getAttribute?.('end_angle'));
    if (!id || radius === null || !(radius > 0) || startAngle === null || endAngle === null) {
      continue;
    }
    axes.push({
      id: String(id),
      name: axis.getAttribute('name') || null,
      axisKind: 'arc',
      radius,
      originX,
      originY,
      startAngle,
      endAngle,
    });
  }

  return axes;
}

function collectGridPrimitives(document, result) {
  if (!document) return;
  const unique = new Map();
  for (const axis of collectGridAxes(document)) {
    const key = `grid:${axis.axisKind}:${String(axis.id)}:${String(axis.name || '')}`;
    if (unique.has(key)) continue;
    unique.set(key, axis);
  }
  for (const [key, axis] of unique) {
    result.push({
      type: SNAP_TYPES.GRID,
      closest: (query) => nearestOnGridAxis(query, axis),
      source: {
        elementType: 'Axis',
        elementId: String(axis.id),
        name: axis.name || null,
        axisKind: axis.axisKind,
      },
      key,
    });
  }
}

export function buildSnapPrimitives(document, options = {}) {
  const resolver = createNodePositionResolver(document, options.nodeMap || null);
  const result = [];
  collectNodePrimitives(resolver, result);
  collectMemberPrimitives(document, resolver, result);
  collectGridPrimitives(document, result);
  return result;
}

function normalizeEnabledTypes(enabledTypes) {
  if (!enabledTypes) return null;
  if (typeof enabledTypes === 'string') return new Set([enabledTypes]);
  return new Set(Array.isArray(enabledTypes) ? enabledTypes : [...enabledTypes]);
}

export function querySnapCandidates(primitives, queryPosition, options = {}) {
  const query = finitePosition(queryPosition);
  const tolerance = finiteNumber(options.tolerance);
  if (!query || tolerance === null || tolerance < 0) return [];
  const toleranceSquared = tolerance * tolerance;
  const excludedNodeIds = new Set((options.excludeNodeIds || []).map(String));
  const enabledTypes = normalizeEnabledTypes(options.enabledTypes);
  const result = [];

  for (const primitive of Array.isArray(primitives) ? primitives : []) {
    if (!SNAP_PRIORITY[primitive?.type]) continue;
    if (enabledTypes && !enabledTypes.has(primitive.type)) continue;
    if (primitive.position) {
      addPointCandidate(result, primitive, query, toleranceSquared, excludedNodeIds);
    } else if (typeof primitive.closest === 'function') {
      addDynamicCandidate(result, primitive, query, toleranceSquared);
    }
  }

  return result.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (Math.abs(a.distance - b.distance) > EPSILON) return a.distance - b.distance;
    return a.key.localeCompare(b.key);
  });
}

export function resolveSnapCandidate(primitives, queryPosition, options = {}) {
  return querySnapCandidates(primitives, queryPosition, options)[0] || null;
}

export function createSnapEngine(document, options = {}) {
  const primitives = buildSnapPrimitives(document, options);
  return Object.freeze({
    query(queryPosition, queryOptions = {}) {
      return querySnapCandidates(primitives, queryPosition, queryOptions);
    },
    resolve(queryPosition, queryOptions = {}) {
      return resolveSnapCandidate(primitives, queryPosition, queryOptions);
    },
    getPrimitiveCount() {
      return primitives.length;
    },
  });
}

function normalizeAxis(axis) {
  if (axis === null || axis === undefined || axis === '') return null;
  const normalized = String(axis).toUpperCase();
  return AXIS_ORDER.includes(normalized) ? normalized : null;
}

export function constrainPosition(startPosition, queryPosition, options = {}) {
  const start = finitePosition(startPosition);
  const query = finitePosition(queryPosition);
  if (!start || !query) return null;

  const explicitAxis = normalizeAxis(options.axis);
  if (explicitAxis) {
    const result = { ...start };
    result[explicitAxis.toLowerCase()] = query[explicitAxis.toLowerCase()];
    return result;
  }

  if (options.ortho !== true) return { ...query };
  const delta = {
    X: Math.abs(query.x - start.x),
    Y: Math.abs(query.y - start.y),
    Z: Math.abs(query.z - start.z),
  };
  let axis = AXIS_ORDER[0];
  for (const candidate of AXIS_ORDER.slice(1)) {
    if (delta[candidate] > delta[axis] + EPSILON) axis = candidate;
  }
  const result = { ...start };
  result[axis.toLowerCase()] = query[axis.toLowerCase()];
  return result;
}
