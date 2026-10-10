/** @fileoverview DrawingProject semantic member-axis anchor用の配置基準線解決。 */

const LINE_TYPES = new Set(['Column', 'Post', 'Girder', 'Beam', 'Brace']);
const VIA_NODE_TYPES = new Set(['Column', 'Post', 'Girder', 'Beam']);
const EPSILON = 1e-9;

function nodeLookup(nodes, id) {
  if (!(nodes instanceof Map) || id == null) return null;
  return nodes.get(String(id)) || nodes.get(id) || null;
}

function finite(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function offsetPoint3d(node, offsets = {}) {
  if (!node) return null;
  const x = finite(node.x);
  const y = finite(node.y);
  const z = finite(node.z, 0);
  if (x == null || y == null || z == null) return null;
  const ox = finite(offsets.x, 0);
  const oy = finite(offsets.y, 0);
  const oz = finite(offsets.z, 0);
  if (ox == null || oy == null || oz == null) return null;
  return [x + ox, y + oy, z + oz];
}

function endpointOffsets(element, prefix) {
  return {
    x: element?.['offset_' + prefix + '_X'],
    y: element?.['offset_' + prefix + '_Y'],
    z: element?.['offset_' + prefix + '_Z'],
  };
}

function normalizeViaNodes(viaNodes, elementType) {
  if (viaNodes == null) return [];
  if (!Array.isArray(viaNodes)) return null;
  if (viaNodes.length > 0 && !VIA_NODE_TYPES.has(String(elementType))) return null;

  const seen = new Set();
  const normalized = [];
  for (const via of viaNodes) {
    const id = via?.id_node == null ? '' : String(via.id_node).trim();
    if (!id || seen.has(id)) return null;
    seen.add(id);
    const x = finite(via.offset_X, 0);
    const y = finite(via.offset_Y, 0);
    const z = finite(via.offset_Z, 0);
    if (x == null || y == null || z == null) return null;
    normalized.push({ id_node: id, offset_X: x, offset_Y: y, offset_Z: z });
  }
  return normalized;
}

function freezePoint(point) {
  return Object.freeze([point[0], point[1]]);
}

function hasPlanSpread(points) {
  const [x0, y0] = points[0];
  return points.some(([x, y]) => Math.hypot(x - x0, y - y0) > EPSILON);
}

/**
 * 線材の配置基準線をmodel XYとして返す。
 *
 * via nodeを持つ場合は始端→中間節点→終端の3D実経路長でstationを定義し、
 * 各stationの表示位置だけをXYへ投影する。始終端chordへは近似しない。
 */
export function resolveMemberAxisModel({ elementType, element, nodes, viaNodes = [] } = {}) {
  if (!LINE_TYPES.has(String(elementType)) || !element) return null;

  const isColumn = elementType === 'Column' || elementType === 'Post';
  const startId = isColumn ? element.id_node_bottom : element.id_node_start;
  const endId = isColumn ? element.id_node_top : element.id_node_end;
  const startPrefix = isColumn ? 'bottom' : 'start';
  const endPrefix = isColumn ? 'top' : 'end';

  const normalizedVia = normalizeViaNodes(viaNodes, elementType);
  if (!normalizedVia) return null;

  const stationInputs = [
    {
      id: startId,
      offsets: endpointOffsets(element, startPrefix),
    },
    ...normalizedVia.map((via) => ({
      id: via.id_node,
      offsets: { x: via.offset_X, y: via.offset_Y, z: via.offset_Z },
    })),
    {
      id: endId,
      offsets: endpointOffsets(element, endPrefix),
    },
  ];

  if (stationInputs.some((item) => item.id == null || String(item.id).trim() === '')) return null;
  const stationIds = stationInputs.map((item) => String(item.id));
  if (new Set(stationIds).size !== stationIds.length) return null;

  const points3d = stationInputs.map((item) =>
    offsetPoint3d(nodeLookup(nodes, item.id), item.offsets),
  );
  if (points3d.some((item) => !item)) return null;

  const distances = [0];
  for (let index = 1; index < points3d.length; index++) {
    const previous = points3d[index - 1];
    const current = points3d[index];
    const segmentLength = Math.hypot(
      current[0] - previous[0],
      current[1] - previous[1],
      current[2] - previous[2],
    );
    if (!Number.isFinite(segmentLength) || segmentLength <= EPSILON) return null;
    distances.push(distances[index - 1] + segmentLength);
  }

  const points = points3d.map(([x, y]) => [x, y]);
  if (!hasPlanSpread(points)) return null;

  if (normalizedVia.length === 0) {
    return Object.freeze({
      kind: 'straight-member-axis',
      start: freezePoint(points[0]),
      end: freezePoint(points[points.length - 1]),
      units: 'mm',
    });
  }

  return Object.freeze({
    kind: 'polyline-member-axis',
    points: Object.freeze(points.map(freezePoint)),
    distances: Object.freeze([...distances]),
    totalLength: distances[distances.length - 1],
    units: 'mm',
  });
}

/**
 * 後方互換用。via nodeがある場合は従来どおりnullを返す。
 */
export function resolveStraightMemberAxisModel({
  elementType,
  element,
  nodes,
  hasViaNodes = false,
} = {}) {
  if (hasViaNodes) return null;
  return resolveMemberAxisModel({ elementType, element, nodes, viaNodes: [] });
}

function stationRatio(value) {
  const t = Number(value);
  if (!Number.isFinite(t) || t < 0 || t > 1)
    throw new RangeError('member-axis stationRatioは0〜1で指定してください。');
  return t;
}

export function pointOnStraightMemberAxis(axis, ratio) {
  if (
    axis?.kind !== 'straight-member-axis' ||
    !Array.isArray(axis.start) ||
    !Array.isArray(axis.end) ||
    axis.start.length !== 2 ||
    axis.end.length !== 2 ||
    ![...axis.start, ...axis.end].every(Number.isFinite)
  ) {
    throw new TypeError('straight member axisが不正です。');
  }
  const t = stationRatio(ratio);
  return [
    axis.start[0] + (axis.end[0] - axis.start[0]) * t,
    axis.start[1] + (axis.end[1] - axis.start[1]) * t,
  ];
}

function pointOnPolylineMemberAxis(axis, ratio) {
  if (
    axis?.kind !== 'polyline-member-axis' ||
    axis.units !== 'mm' ||
    !Array.isArray(axis.points) ||
    !Array.isArray(axis.distances) ||
    axis.points.length < 3 ||
    axis.points.length !== axis.distances.length ||
    !axis.points.every(
      (point) =>
        Array.isArray(point) &&
        point.length === 2 &&
        point.every((value) => Number.isFinite(value)),
    ) ||
    !axis.distances.every(Number.isFinite)
  ) {
    throw new TypeError('polyline member axisが不正です。');
  }

  const totalLength = Number(axis.totalLength);
  if (
    !(totalLength > 0) ||
    Math.abs(axis.distances[axis.distances.length - 1] - totalLength) > 1e-6
  )
    throw new TypeError('polyline member axisの経路長が不正です。');
  if (axis.distances[0] !== 0) throw new TypeError('polyline member axisのstationが不正です。');
  for (let index = 1; index < axis.distances.length; index++) {
    if (!(axis.distances[index] > axis.distances[index - 1]))
      throw new TypeError('polyline member axisのstation順序が不正です。');
  }

  const t = stationRatio(ratio);
  if (t === 0) return [...axis.points[0]];
  if (t === 1) return [...axis.points[axis.points.length - 1]];

  const target = totalLength * t;
  for (let index = 1; index < axis.distances.length; index++) {
    if (target > axis.distances[index]) continue;
    const startDistance = axis.distances[index - 1];
    const endDistance = axis.distances[index];
    const local = (target - startDistance) / (endDistance - startDistance);
    const start = axis.points[index - 1];
    const end = axis.points[index];
    return [start[0] + (end[0] - start[0]) * local, start[1] + (end[1] - start[1]) * local];
  }

  throw new RangeError('polyline member axisのstationを解決できません。');
}

export function pointOnMemberAxis(axis, ratio) {
  if (axis?.kind === 'straight-member-axis') return pointOnStraightMemberAxis(axis, ratio);
  if (axis?.kind === 'polyline-member-axis') return pointOnPolylineMemberAxis(axis, ratio);
  throw new TypeError('member axisが不正です。');
}
