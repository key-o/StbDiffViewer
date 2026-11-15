/**
 * Intersections of *drawn projected member axes* in a CAD view, not 3D joins.
 * Inputs are semantic endpoints already filtered by view depth/visibility and
 * adjusted for Working Document offsets. Nothing here mutates the STB model.
 */
const EPSILON = 1e-9;
const MAX_LOCAL_SEGMENTS = 128;

function finitePoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

export function buildCadProjectedSegments(primitives) {
  const members = new Map();
  for (const primitive of primitives || []) {
    if (primitive?.type !== 'endpoint' || !finitePoint(primitive.position)) continue;
    const { elementType, elementId, role } = primitive.source || {};
    if (!elementType || elementId == null || !['start', 'end'].includes(role)) continue;
    const key = `${elementType}:${String(elementId)}`;
    if (!members.has(key)) members.set(key, { key, start: null, end: null, nodeIds: new Set() });
    members.get(key)[role] = primitive.position;
    if (primitive.nodeId != null) members.get(key).nodeIds.add(String(primitive.nodeId));
  }
  return [...members.values()]
    .filter(
      ({ start, end }) => start && end && Math.hypot(end.x - start.x, end.y - start.y) > EPSILON,
    )
    .sort((a, b) => a.key.localeCompare(b.key));
}

function withinExpandedBounds(segment, point, tolerance) {
  return (
    point[0] >= Math.min(segment.start.x, segment.end.x) - tolerance &&
    point[0] <= Math.max(segment.start.x, segment.end.x) + tolerance &&
    point[1] >= Math.min(segment.start.y, segment.end.y) - tolerance &&
    point[1] <= Math.max(segment.start.y, segment.end.y) + tolerance
  );
}

function interiorIntersection(a, b) {
  const ux = a.end.x - a.start.x;
  const uy = a.end.y - a.start.y;
  const vx = b.end.x - b.start.x;
  const vy = b.end.y - b.start.y;
  const denominator = ux * vy - uy * vx;
  const lengthProduct = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  // Parallel, collinear and numerically ill-conditioned crossings are ambiguous.
  if (Math.abs(denominator) <= lengthProduct * EPSILON) return null;
  const dx = b.start.x - a.start.x;
  const dy = b.start.y - a.start.y;
  const t = (dx * vy - dy * vx) / denominator;
  const s = (dx * uy - dy * ux) / denominator;
  // Endpoint connections already have higher-fidelity semantic endpoint snaps.
  if (t <= EPSILON || t >= 1 - EPSILON || s <= EPSILON || s >= 1 - EPSILON) return null;
  return { x: a.start.x + t * ux, y: a.start.y + t * uy, z: 0 };
}

/**
 * The query-dependent bounding filter avoids quadratic work across the whole
 * model. Intersection geometry is only computed for members near this pointer.
 */
export function queryCadProjectedIntersections(
  segments,
  point,
  toleranceMm,
  { excludeNodeIds = [] } = {},
) {
  if (
    !Array.isArray(point) ||
    point.length !== 2 ||
    !point.every(Number.isFinite) ||
    !Number.isFinite(toleranceMm) ||
    toleranceMm < 0
  )
    return [];
  const excluded = new Set(excludeNodeIds.map(String));
  const local = (segments || []).filter(
    (segment) =>
      ![...(segment.nodeIds || [])].some((id) => excluded.has(id)) &&
      withinExpandedBounds(segment, point, toleranceMm),
  );
  // Avoid quadratic pointer latency in exceptionally dense projections.
  if (local.length > MAX_LOCAL_SEGMENTS) return [];
  const result = [];
  const maxDistanceSquared = toleranceMm * toleranceMm;
  for (let i = 0; i < local.length; i++) {
    for (let j = i + 1; j < local.length; j++) {
      const position = interiorIntersection(local[i], local[j]);
      if (!position) continue;
      const dx = point[0] - position.x;
      const dy = point[1] - position.y;
      if (dx * dx + dy * dy > maxDistanceSquared) continue;
      result.push({
        type: 'intersection',
        position,
        source: {
          elementType: 'CADProjectedIntersection',
          memberKeys: [local[i].key, local[j].key],
        },
        key: `intersection:${local[i].key}|${local[j].key}`,
      });
    }
  }
  return result;
}
