/**
 * @fileoverview 日建連・JSCA 2023標準図 §6-4 の「最下階柱」を、
 * 基礎大梁端節点から上に伸びる StbColumn / StbPost の実平面geometryとして解決する。
 *
 * StbFoundationColumn は基礎柱であり、図6-4が対象とする最下階柱とは別要素なので使用しない。
 * 柱脚側 offset・rotate・ふかしを反映し、基礎梁実軸との交差区間と梁軸直交方向の実幅を返す。
 */

import { extractColumnPlanDimensions, findElementById } from '../columnSupportUtils.js';
import { resolveBeamPlanAxis } from './rebarClearGeometry.js';

const SOURCE = 'R13-foundation-beam-lowest-column-geometry-2023';
const EPS = 1e-9;
const BOUNDARY_TOLERANCE_MM = 1e-6;

function unresolved(reason, extra = {}) {
  return { resolved: false, reason, blockers: [reason], source: SOURCE, ...extra };
}

function finiteAttribute(element, name, fallback = null) {
  if (!element?.hasAttribute?.(name)) return fallback;
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) ? value : null;
}

function nonNegativeAttribute(element, name) {
  const value = finiteAttribute(element, name, 0);
  return value !== null && value >= 0 ? value : null;
}

function rotateIntoLocal(vector, angleRad) {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    x: cos * vector.x + sin * vector.y,
    y: -sin * vector.x + cos * vector.y,
  };
}

function rectangleBounds(columnEl, dims) {
  const startX = nonNegativeAttribute(columnEl, 'thickness_add_start_X');
  const endX = nonNegativeAttribute(columnEl, 'thickness_add_end_X');
  const startY = nonNegativeAttribute(columnEl, 'thickness_add_start_Y');
  const endY = nonNegativeAttribute(columnEl, 'thickness_add_end_Y');
  if ([startX, endX, startY, endY].some((value) => value === null)) return null;
  return {
    minX: -dims.widthX / 2 - startX,
    maxX: dims.widthX / 2 + endX,
    minY: -dims.widthY / 2 - startY,
    maxY: dims.widthY / 2 + endY,
  };
}

function intersectLineWithRectangle(origin, direction, center, bounds, rotateDeg) {
  const angleRad = (rotateDeg * Math.PI) / 180;
  const localOrigin = rotateIntoLocal({ x: origin.x - center.x, y: origin.y - center.y }, angleRad);
  const localDirection = rotateIntoLocal(direction, angleRad);
  let entryT = -Infinity;
  let exitT = Infinity;

  for (const axis of ['x', 'y']) {
    const value = localOrigin[axis];
    const delta = localDirection[axis];
    const min = axis === 'x' ? bounds.minX : bounds.minY;
    const max = axis === 'x' ? bounds.maxX : bounds.maxY;
    if (Math.abs(delta) <= EPS) {
      if (value < min - EPS || value > max + EPS) return null;
      continue;
    }
    const first = (min - value) / delta;
    const second = (max - value) / delta;
    entryT = Math.max(entryT, Math.min(first, second));
    exitT = Math.min(exitT, Math.max(first, second));
    if (entryT > exitT + EPS) return null;
  }
  return Number.isFinite(entryT) && Number.isFinite(exitT) ? { entryT, exitT } : null;
}

function intersectLineWithCircle(origin, direction, center, diameterMm) {
  const radius = diameterMm / 2;
  const dx = origin.x - center.x;
  const dy = origin.y - center.y;
  const b = 2 * (dx * direction.x + dy * direction.y);
  const c = dx * dx + dy * dy - radius * radius;
  const discriminant = b * b - 4 * c;
  if (discriminant < -EPS) return null;
  const root = Math.sqrt(Math.max(0, discriminant));
  return { entryT: (-b - root) / 2, exitT: (-b + root) / 2 };
}

function worldRectangleCorners(center, bounds, rotateDeg) {
  const angle = (rotateDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ].map((point) => ({
    x: center.x + point.x * cos - point.y * sin,
    y: center.y + point.x * sin + point.y * cos,
  }));
}

function transverseWidth(beamAxis, dims, center, bounds, rotateDeg, circleDiameterMm = null) {
  if (dims.shape === 'CIRCLE') return circleDiameterMm ?? dims.widthX;
  const transverse = { x: -beamAxis.direction.y, y: beamAxis.direction.x };
  const projections = worldRectangleCorners(center, bounds, rotateDeg).map(
    (point) => point.x * transverse.x + point.y * transverse.y,
  );
  return Math.max(...projections) - Math.min(...projections);
}

function pointAt(axis, t) {
  return {
    x: axis.start.x + axis.direction.x * t,
    y: axis.start.y + axis.direction.y * t,
  };
}

export function resolveFoundationBeamLowestColumnGeometry2023(
  scanTag,
  beamEl,
  endFact,
  options = {},
) {
  const side = endFact?.side;
  if (!['start', 'end'].includes(side)) {
    return unresolved('foundation-lowest-column-end-side-unresolved', { side: side ?? null });
  }
  if (!beamEl) return unresolved('foundation-lowest-column-beam-element-missing', { side });
  if (!endFact?.resolved) {
    return unresolved('foundation-lowest-column-end-topology-unresolved', {
      side,
      reasons: [...(endFact?.reasons || [])],
    });
  }

  const columnsAbove = endFact.columnsAbove || [];
  if (columnsAbove.length !== 1) {
    return unresolved(
      columnsAbove.length === 0
        ? 'foundation-lowest-column-not-found-at-end'
        : 'foundation-lowest-column-ambiguous-at-end',
      { side, nodeId: endFact.nodeId || null, columnCount: columnsAbove.length },
    );
  }
  const columnFact = columnsAbove[0];
  if (columnFact.kindStructure && columnFact.kindStructure !== 'RC') {
    return unresolved('foundation-lowest-column-not-rc', {
      side,
      columnId: columnFact.id,
      kindStructure: columnFact.kindStructure,
    });
  }

  const columnEl = findElementById(
    scanTag,
    columnFact.tagName || 'StbColumn',
    columnFact.id,
    options.index || null,
  );
  if (!columnEl) {
    return unresolved('foundation-lowest-column-element-not-found', {
      side,
      columnId: columnFact.id,
    });
  }
  if (String(columnEl.getAttribute('id_node_bottom') || '') !== String(endFact.nodeId || '')) {
    return unresolved('foundation-lowest-column-bottom-node-mismatch', {
      side,
      columnId: columnFact.id,
      nodeId: endFact.nodeId || null,
    });
  }

  const sectionId = columnFact.sectionId || columnEl.getAttribute('id_section') || null;
  const dims = extractColumnPlanDimensions(scanTag, sectionId, options.index || null);
  if (!dims || !(dims.widthX > 0) || !(dims.widthY > 0)) {
    return unresolved('foundation-lowest-column-plan-dimensions-unresolved', {
      side,
      columnId: columnFact.id,
      sectionId,
    });
  }
  if (!endFact.node || ![endFact.node.X, endFact.node.Y].every(Number.isFinite)) {
    return unresolved('foundation-lowest-column-node-coordinate-unresolved', {
      side,
      nodeId: endFact.nodeId || null,
    });
  }

  const offsetX = finiteAttribute(columnEl, 'offset_bottom_X', 0);
  const offsetY = finiteAttribute(columnEl, 'offset_bottom_Y', 0);
  const rotateDeg = finiteAttribute(columnEl, 'rotate', 0);
  if (![offsetX, offsetY, rotateDeg].every(Number.isFinite)) {
    return unresolved('foundation-lowest-column-placement-invalid', {
      side,
      columnId: columnFact.id,
    });
  }
  const center = {
    x: Number(endFact.node.X) + offsetX,
    y: Number(endFact.node.Y) + offsetY,
  };
  const beamAxis = resolveBeamPlanAxis(scanTag, beamEl, options.index || null);
  if (!beamAxis) return unresolved('foundation-lowest-column-beam-axis-unresolved', { side });

  let interval;
  let bounds = null;
  let circleDiameterMm = null;
  if (dims.shape === 'CIRCLE') {
    const fukashi = nonNegativeAttribute(columnEl, 'thickness_add_start_X');
    if (fukashi === null) {
      return unresolved('foundation-lowest-column-fukashi-invalid', {
        side,
        columnId: columnFact.id,
      });
    }
    circleDiameterMm = dims.widthX + 2 * fukashi;
    interval = intersectLineWithCircle(
      beamAxis.start,
      beamAxis.direction,
      center,
      circleDiameterMm,
    );
  } else {
    bounds = rectangleBounds(columnEl, dims);
    if (!bounds) {
      return unresolved('foundation-lowest-column-fukashi-invalid', {
        side,
        columnId: columnFact.id,
      });
    }
    interval = intersectLineWithRectangle(
      beamAxis.start,
      beamAxis.direction,
      center,
      bounds,
      rotateDeg,
    );
  }
  if (!interval) {
    return unresolved('foundation-beam-axis-does-not-cross-lowest-column', {
      side,
      columnId: columnFact.id,
      sectionId,
    });
  }

  const endpointT = side === 'start' ? 0 : beamAxis.lengthMm;
  if (
    endpointT < interval.entryT - BOUNDARY_TOLERANCE_MM ||
    endpointT > interval.exitT + BOUNDARY_TOLERANCE_MM
  ) {
    return unresolved('foundation-beam-end-outside-lowest-column', {
      side,
      columnId: columnFact.id,
      endpointT,
      entryT: interval.entryT,
      exitT: interval.exitT,
    });
  }

  const faceT = side === 'start' ? interval.exitT : interval.entryT;
  const oppositeFaceT = side === 'start' ? interval.entryT : interval.exitT;
  const projectionMm = interval.exitT - interval.entryT;
  const columnTransverseWidthMm = transverseWidth(
    beamAxis,
    dims,
    center,
    bounds,
    rotateDeg,
    circleDiameterMm,
  );
  if (!(projectionMm > EPS) || !(columnTransverseWidthMm > EPS)) {
    return unresolved('foundation-lowest-column-projection-invalid', {
      side,
      columnId: columnFact.id,
    });
  }

  return {
    resolved: true,
    reason: null,
    blockers: [],
    source: SOURCE,
    basis: 'STB_FOUNDATION_BEAM_AXIS_X_LOWEST_COLUMN_PLAN',
    side,
    nodeId: endFact.nodeId,
    lowestColumnId: columnFact.id,
    lowestColumnName: columnFact.name || null,
    lowestColumnTagName: columnFact.tagName || 'StbColumn',
    sectionId,
    columnShape: dims.shape,
    columnWidthXmm: dims.widthX,
    columnWidthYmm: dims.widthY,
    columnTransverseWidthMm,
    columnCenter: center,
    columnRotateDeg: rotateDeg,
    columnBounds: bounds,
    beamAxis,
    endpointT,
    entryT: interval.entryT,
    exitT: interval.exitT,
    faceT,
    oppositeFaceT,
    projectionMm,
    face: pointAt(beamAxis, faceT),
    oppositeFace: pointAt(beamAxis, oppositeFaceT),
  };
}

export const _foundationBeamLowestColumnGeometry2023Internals = Object.freeze({
  rotateIntoLocal,
  rectangleBounds,
  intersectLineWithRectangle,
  intersectLineWithCircle,
  worldRectangleCorners,
  transverseWidth,
});
