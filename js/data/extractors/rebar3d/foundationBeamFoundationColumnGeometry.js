/**
 * @fileoverview R13 基礎梁端の StbFoundationColumn FD 外周との平面交差を解決する。
 *
 * topology facts で一意化された基礎柱について、基礎梁の実基準線（始終端offset反映）と
 * 基礎柱 FD 断面外周（offset_FD_X/Y・rotate・FDふかし反映）の交差区間を求める。
 * あわせて §6-4 の「基礎大梁幅 / 柱幅」比較に使う、梁軸直交方向の実FD幅を返す。
 * 定着長・折曲げ形式・RebarPath はここでは決めない。
 *
 * @module data/extractors/rebar3d/foundationBeamFoundationColumnGeometry
 */

import { extractColumnPlanDimensions } from '../columnSupportUtils.js';
import { resolveBeamPlanAxis } from './rebarClearGeometry.js';

const EPS = 1e-9;
const BOUNDARY_TOLERANCE_MM = 1e-6;

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    reason,
    source: 'R13-foundation-beam-foundation-column-geometry',
    ...extra,
  };
}

function rotateIntoLocal(vector, angleRad) {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    x: cos * vector.x + sin * vector.y,
    y: -sin * vector.x + cos * vector.y,
  };
}

function rotateFromLocal(vector, angleRad) {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    x: cos * vector.x - sin * vector.y,
    y: sin * vector.x + cos * vector.y,
  };
}

function pointAt(axis, t) {
  return {
    x: axis.start.x + axis.direction.x * t,
    y: axis.start.y + axis.direction.y * t,
  };
}

function rectangleBounds(dims, foundationColumn) {
  return {
    minX: -dims.widthX / 2 - Math.max(0, Number(foundationColumn.thicknessAddFdStartXmm) || 0),
    maxX: dims.widthX / 2 + Math.max(0, Number(foundationColumn.thicknessAddFdEndXmm) || 0),
    minY: -dims.widthY / 2 - Math.max(0, Number(foundationColumn.thicknessAddFdStartYmm) || 0),
    maxY: dims.widthY / 2 + Math.max(0, Number(foundationColumn.thicknessAddFdEndYmm) || 0),
  };
}

function circleEffectiveDiameter(dims, foundationColumn) {
  const fukashi = Math.max(
    0,
    Number(foundationColumn.thicknessAddFdStartXmm) || 0,
    Number(foundationColumn.thicknessAddFdEndXmm) || 0,
    Number(foundationColumn.thicknessAddFdStartYmm) || 0,
    Number(foundationColumn.thicknessAddFdEndYmm) || 0,
  );
  return dims.widthX + 2 * fukashi;
}

function rectangleProjectedWidth(bounds, rotateDeg, axis) {
  if (!bounds || !axis) return null;
  const length = Math.hypot(Number(axis.x), Number(axis.y));
  if (!(length > EPS)) return null;
  const unit = { x: Number(axis.x) / length, y: Number(axis.y) / length };
  const angleRad = (rotateDeg * Math.PI) / 180;
  const corners = [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ].map((point) => rotateFromLocal(point, angleRad));
  const projections = corners.map((point) => point.x * unit.x + point.y * unit.y);
  const width = Math.max(...projections) - Math.min(...projections);
  return width > EPS ? width : null;
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

function resolveFoundationColumnInterval(beamAxis, endFact, dims) {
  const foundationColumn = endFact.foundationColumn;
  const center = {
    x: Number(endFact.node.X) + (Number(foundationColumn.offsetFdXmm) || 0),
    y: Number(endFact.node.Y) + (Number(foundationColumn.offsetFdYmm) || 0),
  };

  if (dims.shape === 'CIRCLE') {
    const effectiveDiameterMm = circleEffectiveDiameter(dims, foundationColumn);
    return {
      center,
      interval: intersectLineWithCircle(
        beamAxis.start,
        beamAxis.direction,
        center,
        effectiveDiameterMm,
      ),
      bounds: null,
      effectiveDiameterMm,
    };
  }

  const bounds = rectangleBounds(dims, foundationColumn);
  return {
    center,
    interval: intersectLineWithRectangle(
      beamAxis.start,
      beamAxis.direction,
      center,
      bounds,
      Number(foundationColumn.rotateDeg) || 0,
    ),
    bounds,
    effectiveDiameterMm: null,
  };
}

function resolveTransverseWidth(beamAxis, endFact, dims, resolved) {
  const transverse = { x: -beamAxis.direction.y, y: beamAxis.direction.x };
  if (dims.shape === 'CIRCLE') {
    return {
      transverse,
      widthMm: resolved.effectiveDiameterMm,
      basis: 'FD_CIRCLE_EFFECTIVE_DIAMETER',
    };
  }
  const widthMm = rectangleProjectedWidth(
    resolved.bounds,
    Number(endFact.foundationColumn.rotateDeg) || 0,
    transverse,
  );
  return widthMm
    ? { transverse, widthMm, basis: 'FD_RECT_PROJECTED_TO_BEAM_TRANSVERSE_AXIS' }
    : null;
}

/**
 * 基礎梁端の基礎柱 FD 外周交差を解決する。
 *
 * @param {function(string): Element[]} scanTag タグscanner
 * @param {Element} beamEl 対象 StbGirder / StbBeam
 * @param {Object} endFact foundationBeamTopologyFacts の end fact
 * @param {Object} [options]
 * @param {Object|null} [options.index=null] RebarModelIndex
 * @returns {Object} resolved / unresolved geometry fact
 */
export function resolveFoundationBeamFoundationColumnGeometry(
  scanTag,
  beamEl,
  endFact,
  options = {},
) {
  const side = endFact?.side;
  if (!['start', 'end'].includes(side)) {
    return unresolved('foundation-beam-end-side-unresolved', { side: side ?? null });
  }
  if (!beamEl) return unresolved('foundation-beam-element-not-found', { side });
  if (!endFact?.resolved) {
    return unresolved('foundation-beam-end-topology-unresolved', {
      side,
      reasons: [...(endFact?.reasons || [])],
    });
  }
  const foundationColumn = endFact.foundationColumn;
  if (!foundationColumn) {
    return unresolved('foundation-column-not-found-at-end', {
      side,
      nodeId: endFact.nodeId || null,
    });
  }
  if (foundationColumn.kindStructure && foundationColumn.kindStructure !== 'RC') {
    return unresolved('foundation-column-not-rc', {
      side,
      foundationColumnId: foundationColumn.id,
      kindStructure: foundationColumn.kindStructure,
    });
  }
  if (!endFact.node || ![endFact.node.X, endFact.node.Y].every(Number.isFinite)) {
    return unresolved('foundation-column-node-coordinate-unresolved', {
      side,
      nodeId: endFact.nodeId || null,
    });
  }
  if (!foundationColumn.sectionFdId) {
    return unresolved('foundation-column-fd-section-id-missing', {
      side,
      foundationColumnId: foundationColumn.id,
    });
  }

  const index = options.index || null;
  const dims = extractColumnPlanDimensions(scanTag, foundationColumn.sectionFdId, index);
  if (!dims || !(dims.widthX > 0) || !(dims.widthY > 0)) {
    return unresolved('foundation-column-fd-plan-dimensions-unresolved', {
      side,
      foundationColumnId: foundationColumn.id,
      sectionFdId: foundationColumn.sectionFdId,
    });
  }

  const beamAxis = resolveBeamPlanAxis(scanTag, beamEl, index);
  if (!beamAxis) return unresolved('foundation-beam-plan-axis-unresolved', { side });

  const resolved = resolveFoundationColumnInterval(beamAxis, endFact, dims);
  if (!resolved.interval) {
    return unresolved('foundation-beam-axis-does-not-cross-foundation-column-fd', {
      side,
      foundationColumnId: foundationColumn.id,
      sectionFdId: foundationColumn.sectionFdId,
      foundationColumnCenter: resolved.center,
      foundationColumnShape: dims.shape,
    });
  }

  const transverse = resolveTransverseWidth(beamAxis, endFact, dims, resolved);
  if (!transverse || !(transverse.widthMm > EPS)) {
    return unresolved('foundation-column-transverse-width-unresolved', {
      side,
      foundationColumnId: foundationColumn.id,
      sectionFdId: foundationColumn.sectionFdId,
    });
  }

  const endpointT = side === 'start' ? 0 : beamAxis.lengthMm;
  const { entryT, exitT } = resolved.interval;
  const endpointInside =
    endpointT >= entryT - BOUNDARY_TOLERANCE_MM && endpointT <= exitT + BOUNDARY_TOLERANCE_MM;
  if (!endpointInside) {
    return unresolved('foundation-beam-end-outside-foundation-column-fd', {
      side,
      foundationColumnId: foundationColumn.id,
      endpointT,
      entryT,
      exitT,
    });
  }

  const faceT = side === 'start' ? exitT : entryT;
  const oppositeFaceT = side === 'start' ? entryT : exitT;
  const projectionMm = exitT - entryT;
  if (!(projectionMm > EPS)) {
    return unresolved('foundation-column-projection-invalid', {
      side,
      foundationColumnId: foundationColumn.id,
      entryT,
      exitT,
    });
  }

  return {
    resolved: true,
    reason: null,
    source: 'R13-foundation-beam-foundation-column-geometry',
    basis: 'STB_FOUNDATION_BEAM_AXIS_X_FOUNDATION_COLUMN_FD_PLAN',
    side,
    nodeId: endFact.nodeId,
    foundationColumnId: foundationColumn.id,
    foundationColumnName: foundationColumn.name || null,
    sectionFdId: foundationColumn.sectionFdId,
    foundationColumnShape: dims.shape,
    foundationColumnWidthXmm: dims.widthX,
    foundationColumnWidthYmm: dims.widthY,
    foundationColumnTransverseWidthMm: transverse.widthMm,
    foundationColumnTransverseWidthBasis: transverse.basis,
    beamTransverseDirection: transverse.transverse,
    foundationColumnCenter: resolved.center,
    foundationColumnRotateDeg: Number(foundationColumn.rotateDeg) || 0,
    foundationColumnBounds: resolved.bounds,
    beamAxis,
    endpointT,
    entryT,
    exitT,
    faceT,
    oppositeFaceT,
    projectionMm,
    face: pointAt(beamAxis, faceT),
    oppositeFace: pointAt(beamAxis, oppositeFaceT),
  };
}

export const _foundationBeamFoundationColumnGeometryInternals = Object.freeze({
  intersectLineWithRectangle,
  intersectLineWithCircle,
  rectangleBounds,
  circleEffectiveDiameter,
  rectangleProjectedWidth,
  resolveTransverseWidth,
  rotateIntoLocal,
  rotateFromLocal,
});
