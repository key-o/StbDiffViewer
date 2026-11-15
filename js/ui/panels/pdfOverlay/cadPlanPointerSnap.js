/**
 * Plan-only adapter for the shared semantic snap engine.
 * All pointer coordinates and tolerances are in Working Document model mm.
 * This adapter projects eligible 3D semantic candidates onto the current plan,
 * never mutating the Working Document or using screen/SVG positions as model data.
 */
import {
  SNAP_TYPES,
  buildSnapPrimitives,
  constrainPosition,
  querySnapCandidates,
} from '../../../app/editing/snapEngine.js';
import {
  cadDrawingEditProjection,
  cadEditDepthVisible,
  cadProjectEditPoint,
} from './cadDrawingEditProjection.js';
import {
  buildCadProjectedSegments,
  queryCadProjectedIntersections,
} from './cadProjectedIntersections.js';

const EPSILON = 1e-7;
const EMPTY_QUERY = () => [];

/** Member offsets are semantic STB attributes, not presentation transforms. */
const LINE_MEMBER_OFFSETS = Object.freeze({
  Column: ['offset_bottom', 'offset_top'],
  Post: ['offset_bottom', 'offset_top'],
  Girder: ['offset_start', 'offset_end'],
  Beam: ['offset_start', 'offset_end'],
  Brace: ['offset_start', 'offset_end'],
});

function memberOffset(element, prefix) {
  const offset = {};
  for (const axis of ['X', 'Y', 'Z']) {
    const raw = element.getAttribute(`${prefix}_${axis}`);
    const value = raw == null || raw.trim() === '' ? 0 : Number(raw);
    if (!Number.isFinite(value)) return null;
    offset[axis.toLowerCase()] = value;
  }
  return offset;
}

function indexLineMemberOffsets(document) {
  const result = new Map();
  for (const [type, [startPrefix, endPrefix]] of Object.entries(LINE_MEMBER_OFFSETS)) {
    for (const element of document.getElementsByTagName(`Stb${type}`)) {
      const id = element.getAttribute('id');
      if (!id) continue;
      const start = memberOffset(element, startPrefix);
      const end = memberOffset(element, endPrefix);
      result.set(`${type}:${id}`, start && end ? { start, end } : null);
    }
  }
  return result;
}

function effectiveMemberPosition(primitive, offsets) {
  const base = primitive.position;
  if (!offsets) return null;
  const offset =
    primitive.type === SNAP_TYPES.MIDPOINT
      ? {
          x: (offsets.start.x + offsets.end.x) / 2,
          y: (offsets.start.y + offsets.end.y) / 2,
          z: (offsets.start.z + offsets.end.z) / 2,
        }
      : primitive.source?.role === 'start'
        ? offsets.start
        : primitive.source?.role === 'end'
          ? offsets.end
          : null;
  if (!offset) return null;
  return { x: base.x + offset.x, y: base.y + offset.y, z: base.z + offset.z };
}

function point2(value) {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
}

function inViewRange(position, view) {
  if (view?.type === 'elevation') return cadEditDepthVisible(view, position, EPSILON);
  const z = position?.z;
  const lower = Number(view?.lowerZ);
  const upper = Number(view?.upperZ);
  return (
    Number.isFinite(z) &&
    Number.isFinite(lower) &&
    Number.isFinite(upper) &&
    z >= lower - EPSILON &&
    z <= upper + EPSILON
  );
}

/**
 * Only geometry belonging to a drawn model-A member can supply endpoint/midpoint
 * snaps. Nodes in the current story range and global axes are also eligible.
 * 3D member axes are deliberately excluded: a sloped/vertical axis requires a
 * separate explicit 2D projection contract to avoid incorrect nearest points.
 */
export function createCadPlanSnapEngine(
  document,
  { nodeMap = null, drawing = null, view = null, visibleTypes = null } = {},
) {
  const projection = cadDrawingEditProjection(view);
  if (!document || !projection) {
    return Object.freeze({ query: EMPTY_QUERY, resolve: () => null });
  }
  const visible = new Set(
    (drawing?.elements || [])
      .filter((record) => {
        if (record?.state !== 'drawn' || record.ref?.modelKey !== 'A') return false;
        const renderType = record.renderType || record.ref.elementType;
        const visibilitySource = record.visibilitySource || renderType;
        return visibleTypes?.[visibilitySource] !== false && visibleTypes?.[renderType] !== false;
      })
      .map((record) => `${record.ref.elementType}:${String(record.ref.elementId)}`),
  );
  const projected = [];
  const memberOffsets = indexLineMemberOffsets(document);
  for (const primitive of buildSnapPrimitives(document, { nodeMap })) {
    if (primitive.type === SNAP_TYPES.GRID && typeof primitive.closest === 'function') {
      // The 3D plan GRID callback is not a projected elevation-grid primitive.
      if (view.type !== 'plan' || visibleTypes?.Axis === false) continue;
      projected.push({
        ...primitive,
        closest: (query) => {
          const result = primitive.closest({ ...query, z: Number(view.baseZ) || 0 });
          return result ? { x: result.x, y: result.y, z: 0 } : null;
        },
      });
      continue;
    }
    if (![SNAP_TYPES.NODE, SNAP_TYPES.ENDPOINT, SNAP_TYPES.MIDPOINT].includes(primitive.type))
      continue;
    if (primitive.type === SNAP_TYPES.NODE && visibleTypes?.Node === false) continue;
    const memberKey = `${primitive.source?.elementType}:${String(primitive.source?.elementId)}`;
    if (primitive.type !== SNAP_TYPES.NODE && !visible.has(memberKey)) continue;
    const positionsNeedOffsets =
      primitive.type !== SNAP_TYPES.NODE &&
      Object.hasOwn(LINE_MEMBER_OFFSETS, primitive.source?.elementType);
    const position = positionsNeedOffsets
      ? effectiveMemberPosition(primitive, memberOffsets.get(memberKey))
      : primitive.position;
    if (!position || !inViewRange(position, view)) continue;
    const [x, y] = cadProjectEditPoint(projection, position);
    projected.push({ ...primitive, position: { x, y, z: 0 } });
  }
  const segments = buildCadProjectedSegments(projected);
  const query = (point, options = {}) => {
    if (!point2(point)) return [];
    // In plans, a member may have a semantic offset from its unchanged node.
    // Prefer the nearest projected location rather than letting an offset's
    // stale node win solely because NODE has a higher semantic type priority.
    const intersections = queryCadProjectedIntersections(
      segments,
      point,
      Number(options.tolerance),
      options,
    );
    return querySnapCandidates(
      [...projected, ...intersections],
      { x: point[0], y: point[1], z: 0 },
      options,
    ).sort((a, b) => {
      const difference = a.distance - b.distance;
      return Math.abs(difference) > EPSILON
        ? difference
        : a.priority - b.priority || a.key.localeCompare(b.key);
    });
  };
  return Object.freeze({
    query,
    resolve: (point, options = {}) => query(point, options)[0] || null,
  });
}

/** Convert a 10px screen pick radius to model mm, including SVG CTM/zoom/mirror. */
export function cadPlanSnapToleranceMm(modelToSvg, screenCtm, tolerancePx = 10) {
  if (
    !Array.isArray(modelToSvg) ||
    modelToSvg.length !== 6 ||
    !modelToSvg.every(Number.isFinite) ||
    !screenCtm ||
    ![screenCtm.a, screenCtm.b, screenCtm.c, screenCtm.d].every(Number.isFinite) ||
    !Number.isFinite(tolerancePx) ||
    tolerancePx <= 0
  )
    return 0;
  const [a, b, c, d] = modelToSvg;
  const sx = Math.hypot(screenCtm.a * a + screenCtm.c * b, screenCtm.b * a + screenCtm.d * b);
  const sy = Math.hypot(screenCtm.a * c + screenCtm.c * d, screenCtm.b * c + screenCtm.d * d);
  const minScale = Math.min(sx, sy);
  return minScale > 1e-12 ? tolerancePx / minScale : 0;
}

/**
 * Ortho is resolved in *model* axes before snap selection. An off-axis snap
 * cannot silently defeat Ortho, even if it is within the cursor radius.
 */
export function resolveCadPlanPointerPoint(
  rawPoint,
  {
    snapEngine = null,
    startPoint = null,
    snap = false,
    ortho = false,
    axis = null,
    excludeNodeIds = [],
    toleranceMm = 0,
  } = {},
) {
  if (!point2(rawPoint)) throw new TypeError('図面上の点座標が不正です。');
  if (startPoint != null && !point2(startPoint))
    throw new TypeError('始点のモデル座標が不正です。');
  const lockedAxis = axis === 'X' || axis === 'Y' ? axis : null;
  const constrained =
    startPoint && (ortho || lockedAxis)
      ? constrainPosition(
          { x: startPoint[0], y: startPoint[1], z: 0 },
          { x: rawPoint[0], y: rawPoint[1], z: 0 },
          { ortho: true, axis: lockedAxis },
        )
      : null;
  const resolvedAxis = constrained
    ? lockedAxis ||
      (Math.abs(rawPoint[0] - startPoint[0]) >= Math.abs(rawPoint[1] - startPoint[1]) ? 'X' : 'Y')
    : null;
  const modelPoint = constrained ? [constrained.x, constrained.y] : [...rawPoint];
  const candidates =
    snap && toleranceMm > 0 && snapEngine
      ? snapEngine.query(modelPoint, { tolerance: toleranceMm, excludeNodeIds })
      : [];
  const candidate =
    candidates.find(
      (item) =>
        !resolvedAxis ||
        Math.abs(
          item.position[resolvedAxis === 'X' ? 'y' : 'x'] -
            startPoint[resolvedAxis === 'X' ? 1 : 0],
        ) <= EPSILON,
    ) || null;
  const position = candidate ? [candidate.position.x, candidate.position.y] : modelPoint;
  const finalPosition =
    resolvedAxis === 'X'
      ? [position[0], startPoint[1]]
      : resolvedAxis === 'Y'
        ? [startPoint[0], position[1]]
        : position;
  return { point: finalPosition, snap: candidate, orthoAxis: resolvedAxis };
}
