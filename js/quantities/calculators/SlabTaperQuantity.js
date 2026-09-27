/**
 * @fileoverview RC片持ちスラブ tapered quantity。
 * StbNode.kind=OTHER の2節点を先端辺として根元→先端の線形厚さを積分する。
 */

import { createQuantityResult, createUnavailableQuantityResult } from '../core/QuantityResult.js';
import { QuantityStatus } from '../core/QuantityStatus.js';
import {
  convexPolygonsOverlap2d,
  createPanelLocalGeometry,
  isConvexPolygon2d,
  openingCorners2d,
  pointInPolygon2d,
} from '../core/PanelQuantityGeometry.js';
import { elementsByTagName } from '../core/StbXmlDomUtils.js';

const VERSION = 3;

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function optionalNonnegative(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: 0 };
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? { ok: true, value: number }
    : { ok: false, value: null };
}

function optionalFinite(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: 0 };
  const number = Number(value);
  return Number.isFinite(number) ? { ok: true, value: number } : { ok: false, value: null };
}

function identity(context) {
  return {
    elementType: context.elementType,
    elementId: context.element?.id,
    guid: context.element?.guid || null,
  };
}

function dependencies(context) {
  const result = (context.element?.node_ids || []).map((id) => `StbNode:${id}`);
  if (context.section?.id !== undefined && context.section?.id !== null) {
    result.push(`${context.section.sectionType || 'StbSecSlab_RC'}:${context.section.id}`);
  }
  for (const opening of context.openings || []) {
    result.push(
      `${opening.sourceVersion === '2.1.0' ? 'StbOpenArrangement' : 'StbOpen'}:${opening.id}`,
    );
    if (opening.id_section) result.push(`StbSecOpen_RC:${opening.id_section}`);
  }
  return [...new Set(result)];
}

function buildResult(context, status, values, warnings, extraBasis) {
  const payload = {
    identity: identity(context),
    status,
    values,
    basis: {
      method: 'SLAB_TAPER_LINEAR_THICKNESS',
      calculator: 'PanelQuantityCalculator',
      calculatorVersion: VERSION,
      unitSystem: 'STB_MM',
      ...extraBasis,
    },
    dependencies: dependencies(context),
    warnings,
    revision: context.revision,
  };
  return status === QuantityStatus.CALCULATED
    ? createQuantityResult(payload)
    : createUnavailableQuantityResult(payload);
}

function unavailable(context, status, warning, values = {}) {
  return buildResult(context, status, values, [warning], {});
}

function rawDocument(context) {
  return context.sectionNode?.ownerDocument || null;
}

function slabFukashi(context) {
  if (context.memberParameters) {
    const top = optionalNonnegative(context.memberParameters.thickness_add_top);
    const bottom = optionalNonnegative(context.memberParameters.thickness_add_bottom);
    if (!top.ok || !bottom.ok) return null;
    return { top: top.value, bottom: bottom.value, total: top.value + bottom.value };
  }
  const document = rawDocument(context);
  const nodes = elementsByTagName(document, 'StbSlab');
  const member = nodes.find(
    (node) => String(node.getAttribute?.('id')) === String(context.element?.id),
  );
  const top = optionalNonnegative(member?.getAttribute?.('thickness_add_top'));
  const bottom = optionalNonnegative(member?.getAttribute?.('thickness_add_bottom'));
  if (!top.ok || !bottom.ok) return null;
  return { top: top.value, bottom: bottom.value, total: top.value + bottom.value };
}

function rawNodeKinds(context) {
  const document = rawDocument(context);
  if (!document) return null;
  const byId = new Map(
    elementsByTagName(document, 'StbNode').map((node) => [
      String(node.getAttribute?.('id')),
      node.getAttribute?.('kind') || '',
    ]),
  );
  return (context.element?.node_ids || []).map((id) => byId.get(String(id)) || null);
}

function adjacentPair(indices, count) {
  return (
    indices.length === 2 &&
    (Math.abs(indices[0] - indices[1]) === 1 || Math.abs(indices[0] - indices[1]) === count - 1)
  );
}

function resolveTaperDirection(context, polygon2d) {
  const kinds = rawNodeKinds(context);
  if (!kinds || kinds.length !== polygon2d.length) return null;
  const tipIndices = kinds.flatMap((kind, index) => (kind === 'OTHER' ? [index] : []));
  if (!adjacentPair(tipIndices, polygon2d.length)) return null;
  const baseIndices = polygon2d
    .map((_point, index) => index)
    .filter((index) => !tipIndices.includes(index));
  if (!adjacentPair(baseIndices, polygon2d.length)) return null;

  const midpoint = (indices) => ({
    x: (polygon2d[indices[0]].x + polygon2d[indices[1]].x) / 2,
    y: (polygon2d[indices[0]].y + polygon2d[indices[1]].y) / 2,
  });
  const baseMid = midpoint(baseIndices);
  const tipMid = midpoint(tipIndices);
  const dx = tipMid.x - baseMid.x;
  const dy = tipMid.y - baseMid.y;
  const length = Math.hypot(dx, dy);
  if (length <= 1e-7) return null;
  const axis = { x: dx / length, y: dy / length };
  const projection = (point) => point.x * axis.x + point.y * axis.y;
  const baseProjection = baseIndices.map((index) => projection(polygon2d[index]));
  const tipProjection = tipIndices.map((index) => projection(polygon2d[index]));
  const tolerance = length * 1e-7 + 1e-6;
  if (Math.abs(baseProjection[0] - baseProjection[1]) > tolerance) return null;
  if (Math.abs(tipProjection[0] - tipProjection[1]) > tolerance) return null;
  const baseS = (baseProjection[0] + baseProjection[1]) / 2;
  const tipS = (tipProjection[0] + tipProjection[1]) / 2;
  if (tipS <= baseS + tolerance) return null;
  return { axis, baseS, tipS, spanMm: tipS - baseS, tipIndices, baseIndices };
}

function polygonCentroid(polygon) {
  let twiceArea = 0;
  let cx6a = 0;
  let cy6a = 0;
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross;
    cx6a += (a.x + b.x) * cross;
    cy6a += (a.y + b.y) * cross;
  }
  if (Math.abs(twiceArea) <= 1e-9) return null;
  return { x: cx6a / (3 * twiceArea), y: cy6a / (3 * twiceArea) };
}

function thicknessAt(point, direction, baseDepth, tipDepth) {
  const s = point.x * direction.axis.x + point.y * direction.axis.y;
  const ratio = Math.max(0, Math.min(1, (s - direction.baseS) / direction.spanMm));
  return baseDepth + (tipDepth - baseDepth) * ratio;
}

function openingPlan(context, polygon2d) {
  const openings = context.openings || [];
  if (openings.length === 0)
    return { status: QuantityStatus.CALCULATED, rectangles: [], warnings: [] };
  if (!isConvexPolygon2d(polygon2d)) {
    return {
      status: QuantityStatus.PARTIAL,
      rectangles: [],
      warnings: ['NON_CONVEX_PANEL_OPENING_CONTAINMENT_UNRESOLVED'],
    };
  }
  const rectangles = [];
  for (const opening of openings) {
    if (!positive(opening.length_X) || !positive(opening.length_Y)) {
      return {
        status: QuantityStatus.INSUFFICIENT_DATA,
        rectangles: [],
        warnings: ['OPENING_DIMENSIONS_MISSING'],
      };
    }
    const corners = openingCorners2d(opening);
    if (!corners) {
      return {
        status: QuantityStatus.INSUFFICIENT_DATA,
        rectangles: [],
        warnings: ['OPENING_PLACEMENT_MISSING'],
      };
    }
    if (!corners.every((corner) => pointInPolygon2d(corner, polygon2d))) {
      return {
        status: QuantityStatus.INVALID_GEOMETRY,
        rectangles: [],
        warnings: ['OPENING_OUTSIDE_PANEL'],
      };
    }
    if (rectangles.some((existing) => convexPolygonsOverlap2d(existing.corners, corners))) {
      return {
        status: QuantityStatus.PARTIAL,
        rectangles: [],
        warnings: ['OVERLAPPING_OPENINGS_UNRESOLVED'],
      };
    }
    rectangles.push({
      opening,
      corners,
      areaMm2: Number(opening.length_X) * Number(opening.length_Y),
    });
  }
  return { status: QuantityStatus.CALCULATED, rectangles, warnings: [] };
}

function resolveTaperProfile(context) {
  const conventional = elementsByTagName(context.sectionNode, 'StbSecSlab_RC_ConventionalTaper')[0];
  if (conventional) {
    return {
      baseDepth: positive(conventional.getAttribute?.('base_depth')),
      tipDepth: positive(conventional.getAttribute?.('tip_depth')),
      tipOffset: optionalFinite(conventional.getAttribute?.('tip_offset')),
    };
  }

  const legacy = elementsByTagName(context.sectionNode, 'StbSecSlab_RC_Taper');
  if (legacy.length === 0) return null;

  // ST-Bridge 2.0.2 stores the profile as two elements with pos/depth.
  const byPosition = new Map(
    legacy.map((node) => [String(node.getAttribute?.('pos') || '').toUpperCase(), node]),
  );
  const base = byPosition.get('BASE');
  const tip = byPosition.get('TIP');
  if (base && tip) {
    return {
      baseDepth: positive(base.getAttribute?.('depth')),
      tipDepth: positive(tip.getAttribute?.('depth')),
      tipOffset: { ok: true, value: 0 },
    };
  }

  // Keep accepting the single-node shape used by older converted fixtures.
  const node = legacy[0];
  return {
    baseDepth: positive(node.getAttribute?.('base_depth')),
    tipDepth: positive(node.getAttribute?.('tip_depth')),
    tipOffset: optionalFinite(node.getAttribute?.('tip_offset')),
  };
}

/** 対象外の場合null。 */
export function calculateSlabTaperQuantity(context) {
  if (context?.elementType !== 'StbSlab') return null;
  const profile = resolveTaperProfile(context);
  if (!profile) return null;
  const isCantiAttribute = context.sectionNode?.getAttribute?.('isCanti');
  const isCanti =
    isCantiAttribute === null || isCantiAttribute === undefined || isCantiAttribute === ''
      ? String(context.element?.kind_slab || '').toUpperCase() === 'CANTI'
      : isCantiAttribute === 'true';
  if (!isCanti) {
    return unavailable(
      context,
      QuantityStatus.INVALID_GEOMETRY,
      'SLAB_TAPER_REQUIRES_CANTILEVER_SECTION',
    );
  }

  const baseDepthRaw = profile.baseDepth;
  const tipDepthRaw = profile.tipDepth;
  const tipOffset = profile.tipOffset;
  const fukashi = slabFukashi(context);
  if (!baseDepthRaw || !tipDepthRaw || !tipOffset.ok || !fukashi) {
    return unavailable(context, QuantityStatus.INSUFFICIENT_DATA, 'SLAB_TAPER_DIMENSIONS_INVALID');
  }
  if (
    !Array.isArray(context.points) ||
    context.points.length !== 4 ||
    context.points.some((point) => !point)
  ) {
    return unavailable(context, QuantityStatus.UNSUPPORTED, 'SLAB_TAPER_FOUR_NODE_REQUIRED');
  }

  let geometry;
  try {
    geometry = createPanelLocalGeometry(context.points);
  } catch (error) {
    return unavailable(
      context,
      QuantityStatus.INVALID_GEOMETRY,
      `PANEL_AREA_INVALID:${error?.message || error}`,
    );
  }
  if (!geometry.measure.planar) {
    return unavailable(context, QuantityStatus.INVALID_GEOMETRY, 'NON_PLANAR_PANEL', {
      surfaceAreaMm2: geometry.measure.areaMm2,
    });
  }
  const direction = resolveTaperDirection(context, geometry.polygon2d);
  if (!direction) {
    return unavailable(context, QuantityStatus.INSUFFICIENT_DATA, 'SLAB_TAPER_TIP_EDGE_UNRESOLVED');
  }
  const centroid = polygonCentroid(geometry.polygon2d);
  if (!centroid)
    return unavailable(context, QuantityStatus.INVALID_GEOMETRY, 'SLAB_TAPER_CENTROID_INVALID');

  const baseDepth = baseDepthRaw + fukashi.total;
  const tipDepth = tipDepthRaw + fukashi.total;
  const meanThickness = thicknessAt(centroid, direction, baseDepth, tipDepth);
  const gross = geometry.measure.areaMm2 * meanThickness;

  const openings = openingPlan(context, geometry.polygon2d);
  let openingVolume = 0;
  if (openings.status === QuantityStatus.CALCULATED) {
    for (const item of openings.rectangles) {
      const center = {
        x: item.corners.reduce((sum, point) => sum + point.x, 0) / item.corners.length,
        y: item.corners.reduce((sum, point) => sum + point.y, 0) / item.corners.length,
      };
      openingVolume += item.areaMm2 * thicknessAt(center, direction, baseDepth, tipDepth);
    }
  } else {
    openingVolume = null;
  }
  const net = openingVolume === null ? null : gross - openingVolume;

  return buildResult(
    context,
    openings.status,
    {
      surfaceAreaMm2: geometry.measure.areaMm2,
      grossVolumeMm3: gross,
      netVolumeMm3: net,
      concreteVolumeMm3: net,
      openingVolumeMm3: context.openings?.length ? openingVolume : null,
    },
    openings.warnings,
    {
      baseDepthMm: baseDepth,
      tipDepthMm: tipDepth,
      tipOffsetMm: tipOffset.value,
      taperSpanMm: direction.spanMm,
      fukashiMm: { top: fukashi.top, bottom: fukashi.bottom },
    },
  );
}
