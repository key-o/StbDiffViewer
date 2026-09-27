/**
 * @fileoverview Q2 panel quantity の追加規則。
 * straight wall/slab のふかし・複数開口、wall taper、構造スリットfail-closedを扱う。
 */

import { createQuantityResult, createUnavailableQuantityResult } from '../core/QuantityResult.js';
import { QuantityStatus } from '../core/QuantityStatus.js';
import {
  convexPolygonsOverlap2d,
  createPanelLocalGeometry,
  isConvexPolygon2d,
  openingCorners2d,
  pointInPolygon2d,
  polygonBounds2d,
} from '../core/PanelQuantityGeometry.js';
import { elementsByTagName } from '../core/StbXmlDomUtils.js';

const VERSION = 3;

function identity(context) {
  return {
    elementType: context.elementType,
    elementId: context.element?.id,
    guid: context.element?.guid || null,
  };
}

function dependencies(context) {
  const result = [];
  for (const nodeId of context.element?.node_ids || []) result.push(`StbNode:${nodeId}`);
  if (context.section?.id !== null && context.section?.id !== undefined) {
    result.push(`${context.section.sectionType || 'StbSection'}:${context.section.id}`);
  }
  for (const opening of context.openings || []) {
    result.push(
      `${opening.sourceVersion === '2.1.0' ? 'StbOpenArrangement' : 'StbOpen'}:${opening.id}`,
    );
    if (opening.id_section) result.push(`StbSecOpen_RC:${opening.id_section}`);
  }
  return [...new Set(result)];
}

function basis(method, extra = {}) {
  return {
    method,
    calculator: 'PanelQuantityCalculator',
    calculatorVersion: VERSION,
    unitSystem: 'STB_MM',
    ...extra,
  };
}

function buildResult(context, { status, values, method, warnings = [], extraBasis = {} }) {
  const payload = {
    identity: identity(context),
    status,
    values,
    basis: basis(method, extraBasis),
    dependencies: dependencies(context),
    warnings,
    revision: context.revision,
  };
  return status === QuantityStatus.CALCULATED
    ? createQuantityResult(payload)
    : createUnavailableQuantityResult(payload);
}

function unavailable(context, status, warning, values = {}, method = 'PANEL_QUANTITY') {
  return buildResult(context, { status, values, method, warnings: [warning] });
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function optionalNonnegative(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: 0 };
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? { ok: true, value: number }
    : { ok: false, value: null };
}

function findRawMemberNode(context) {
  const document = context.sectionNode?.ownerDocument;
  if (!document || !context.elementType || context.element?.id === undefined) return null;
  const nodes = elementsByTagName(document, context.elementType);
  return (
    nodes.find((node) => String(node.getAttribute?.('id')) === String(context.element.id)) || null
  );
}

function rawMemberParameters(context) {
  if (context.memberParameters) return context.memberParameters;
  const node = findRawMemberNode(context);
  if (!node) return {};
  const names =
    context.elementType === 'StbWall'
      ? [
          'thickness_add_right',
          'thickness_add_left',
          'slit_upper',
          'slit_bottom',
          'slit_right',
          'slit_left',
        ]
      : ['thickness_add_top', 'thickness_add_bottom'];
  const result = {};
  for (const name of names) {
    const raw = node.getAttribute?.(name);
    if (raw !== null && raw !== '') result[name] = Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  return result;
}

function fukashi(context) {
  const member = rawMemberParameters(context);
  const names =
    context.elementType === 'StbWall'
      ? ['thickness_add_right', 'thickness_add_left']
      : ['thickness_add_top', 'thickness_add_bottom'];
  const values = {};
  let totalMm = 0;
  for (const name of names) {
    const parsed = optionalNonnegative(member[name]);
    if (!parsed.ok) return { ok: false, warning: `PANEL_FUKASHI_INVALID: ${name}` };
    values[name] = parsed.value;
    totalMm += parsed.value;
  }
  return { ok: true, values, totalMm };
}

function wallSlits(context) {
  if (context.elementType !== 'StbWall') return { invalid: null, active: [] };
  const member = rawMemberParameters(context);
  const active = [];
  for (const name of ['slit_upper', 'slit_bottom', 'slit_right', 'slit_left']) {
    const raw = member[name];
    if (raw === undefined || raw === null || raw === '') continue;
    const parsed = optionalNonnegative(raw);
    if (!parsed.ok) return { invalid: name, active: [] };
    if (parsed.value > 0) active.push(name);
  }
  return { invalid: null, active };
}

function panelGeometry(context) {
  if (
    !Array.isArray(context.points) ||
    context.points.length < 3 ||
    context.points.some((p) => !p)
  ) {
    return { error: unavailable(context, QuantityStatus.INVALID_GEOMETRY, 'PANEL_NODE_MISSING') };
  }
  try {
    const geometry = createPanelLocalGeometry(context.points);
    if (!geometry.measure.planar) {
      return {
        error: unavailable(
          context,
          QuantityStatus.INVALID_GEOMETRY,
          `NON_PLANAR_PANEL: ${geometry.measure.maxPlaneDeviationMm}`,
          { surfaceAreaMm2: geometry.measure.areaMm2 },
        ),
      };
    }
    return geometry;
  } catch (error) {
    return {
      error: unavailable(
        context,
        QuantityStatus.INVALID_GEOMETRY,
        `PANEL_AREA_INVALID: ${error?.message || error}`,
      ),
    };
  }
}

function openingPlan(context, polygon2d, panelAreaMm2) {
  const openings = context.openings || [];
  if (openings.length === 0) {
    return { status: QuantityStatus.CALCULATED, rectangles: [], areaMm2: 0, warnings: [] };
  }
  if (!isConvexPolygon2d(polygon2d)) {
    return {
      status: QuantityStatus.PARTIAL,
      rectangles: [],
      areaMm2: null,
      warnings: ['NON_CONVEX_PANEL_OPENING_CONTAINMENT_UNRESOLVED'],
    };
  }

  const rectangles = [];
  let areaMm2 = 0;
  for (const opening of openings) {
    const width = positive(opening.length_X);
    const height = positive(opening.length_Y);
    const corners = openingCorners2d(opening);
    if (!width || !height || !corners) {
      return {
        status: QuantityStatus.INSUFFICIENT_DATA,
        rectangles: [],
        areaMm2: null,
        warnings: ['OPENING_DIMENSIONS_OR_PLACEMENT_MISSING'],
      };
    }
    if (!corners.every((corner) => pointInPolygon2d(corner, polygon2d))) {
      return {
        status: QuantityStatus.INVALID_GEOMETRY,
        rectangles: [],
        areaMm2: null,
        warnings: ['OPENING_OUTSIDE_PANEL'],
      };
    }
    const rectangle = { opening, corners, areaMm2: width * height };
    if (rectangles.some((existing) => convexPolygonsOverlap2d(existing.corners, corners))) {
      return {
        status: QuantityStatus.PARTIAL,
        rectangles: [...rectangles, rectangle],
        areaMm2: null,
        warnings: ['OVERLAPPING_OPENINGS_UNRESOLVED'],
      };
    }
    rectangles.push(rectangle);
    areaMm2 += rectangle.areaMm2;
  }
  if (areaMm2 >= panelAreaMm2) {
    return {
      status: QuantityStatus.INVALID_GEOMETRY,
      rectangles,
      areaMm2: null,
      warnings: ['OPENING_AREA_INVALID'],
    };
  }
  return { status: QuantityStatus.CALCULATED, rectangles, areaMm2, warnings: [] };
}

function calculateStraight(context, baseThickness, method) {
  const base = positive(baseThickness);
  if (!base)
    return unavailable(context, QuantityStatus.INSUFFICIENT_DATA, 'PANEL_THICKNESS_MISSING');
  const extra = fukashi(context);
  if (!extra.ok) return unavailable(context, QuantityStatus.INVALID_GEOMETRY, extra.warning);
  const geometry = panelGeometry(context);
  if (geometry.error) return geometry.error;
  const thicknessMm = base + extra.totalMm;
  const openings = openingPlan(context, geometry.polygon2d, geometry.measure.areaMm2);
  const gross = geometry.measure.areaMm2 * thicknessMm;
  const openingVolume = openings.areaMm2 === null ? null : openings.areaMm2 * thicknessMm;
  let status = openings.status;
  const warnings = [...openings.warnings];

  const slits = wallSlits(context);
  if (slits.invalid)
    return unavailable(
      context,
      QuantityStatus.INVALID_GEOMETRY,
      `WALL_SLIT_INVALID:${slits.invalid}`,
    );
  if (slits.active.length) {
    if (status === QuantityStatus.CALCULATED) status = QuantityStatus.PARTIAL;
    warnings.push(`WALL_STRUCTURAL_SLIT_UNRESOLVED:${slits.active.join(',')}`);
  }

  const net = openingVolume !== null && !slits.active.length ? gross - openingVolume : null;
  return buildResult(context, {
    status,
    values: {
      surfaceAreaMm2: geometry.measure.areaMm2,
      grossVolumeMm3: gross,
      netVolumeMm3: net,
      concreteVolumeMm3: net,
      openingVolumeMm3: context.openings?.length ? openingVolume : null,
    },
    method,
    warnings,
    extraBasis: { baseThicknessMm: base, thicknessMm, fukashiMm: extra.values },
  });
}

function rectangularWall(geometry) {
  if (!geometry.polygon2d || geometry.polygon2d.length !== 4) return null;
  const bounds = polygonBounds2d(geometry.polygon2d);
  const widthMm = bounds.maxX - bounds.minX;
  const heightMm = bounds.maxY - bounds.minY;
  const tolerance = Math.max(widthMm, heightMm) * 1e-7 + 1e-6;
  if (widthMm <= tolerance || heightMm <= tolerance) return null;
  if (
    Math.abs(geometry.measure.areaMm2 - widthMm * heightMm) >
    tolerance * Math.max(widthMm, heightMm)
  ) {
    return null;
  }
  const corners = [
    [bounds.minX, bounds.minY],
    [bounds.maxX, bounds.minY],
    [bounds.maxX, bounds.maxY],
    [bounds.minX, bounds.maxY],
  ];
  if (
    corners.some(
      ([x, y]) =>
        !geometry.polygon2d.some((point) => Math.hypot(point.x - x, point.y - y) <= tolerance),
    )
  ) {
    return null;
  }
  return { ...bounds, widthMm, heightMm };
}

function integrateThickness(y0, y1, profile) {
  let start = Math.max(0, Math.min(profile.heightMm, y0));
  let end = Math.max(0, Math.min(profile.heightMm, y1));
  if (end < start) [start, end] = [end, start];
  const transitionStart = profile.depthHbMm;
  const transitionEnd = profile.heightMm - profile.depthHtMm;
  let result = 0;

  const constant = (a, b, thickness) => {
    const from = Math.max(start, a);
    const to = Math.min(end, b);
    return to > from ? (to - from) * thickness : 0;
  };
  result += constant(0, transitionStart, profile.tBottomMm);

  const from = Math.max(start, transitionStart);
  const to = Math.min(end, transitionEnd);
  if (to > from) {
    const transitionLength = transitionEnd - transitionStart;
    if (transitionLength <= 1e-9) {
      result += (to - from) * ((profile.tBottomMm + profile.tTopMm) / 2);
    } else {
      const slope = (profile.tTopMm - profile.tBottomMm) / transitionLength;
      const F = (y) =>
        profile.tBottomMm * (y - transitionStart) + 0.5 * slope * (y - transitionStart) ** 2;
      result += F(to) - F(from);
    }
  }
  result += constant(transitionEnd, profile.heightMm, profile.tTopMm);
  return result;
}

function taperTypeStraight(context) {
  const taper = elementsByTagName(context.sectionNode, 'StbSecWall_RC_Taper')[0];
  return taper?.getAttribute?.('type_straight') || 'OUTSIDE';
}

function calculateTaperWall(context) {
  const geometry = panelGeometry(context);
  if (geometry.error) return geometry.error;
  const rectangle = rectangularWall(geometry);
  if (!rectangle) {
    return unavailable(
      context,
      QuantityStatus.UNSUPPORTED,
      'WALL_TAPER_RECTANGLE_REQUIRED',
      { surfaceAreaMm2: geometry.measure.areaMm2 },
      'WALL_TAPER_PIECEWISE_THICKNESS',
    );
  }

  const bottom = positive(context.shapeParameters?.t_bottom);
  const top = positive(context.shapeParameters?.t_top);
  const hb = optionalNonnegative(context.shapeParameters?.depth_Hb);
  const ht = optionalNonnegative(context.shapeParameters?.depth_Ht);
  if (!bottom || !top)
    return unavailable(context, QuantityStatus.INSUFFICIENT_DATA, 'WALL_TAPER_THICKNESS_MISSING');
  if (!hb.ok || !ht.ok || hb.value + ht.value > rectangle.heightMm + 1e-7) {
    return unavailable(context, QuantityStatus.INVALID_GEOMETRY, 'WALL_TAPER_SWITCH_DEPTH_INVALID');
  }
  const extra = fukashi(context);
  if (!extra.ok) return unavailable(context, QuantityStatus.INVALID_GEOMETRY, extra.warning);

  const profile = {
    heightMm: rectangle.heightMm,
    tBottomMm: bottom + extra.totalMm,
    tTopMm: top + extra.totalMm,
    depthHbMm: hb.value,
    depthHtMm: ht.value,
  };
  const gross = rectangle.widthMm * integrateThickness(0, rectangle.heightMm, profile);
  const openings = openingPlan(context, geometry.polygon2d, geometry.measure.areaMm2);
  let openingVolume = 0;
  let openingResolved = openings.status === QuantityStatus.CALCULATED;
  const warnings = [...openings.warnings];
  if (openingResolved) {
    for (const rectangleOpening of openings.rectangles) {
      const angle = ((Number(rectangleOpening.opening.rotate ?? 0) % 360) + 360) % 360;
      if (Math.min(angle, 360 - angle) > 1e-7) {
        openingResolved = false;
        warnings.push('TAPER_WALL_ROTATED_OPENING_UNRESOLVED');
        break;
      }
      const bounds = polygonBounds2d(rectangleOpening.corners);
      openingVolume +=
        (bounds.maxX - bounds.minX) * integrateThickness(bounds.minY, bounds.maxY, profile);
    }
  }
  if (!openingResolved) openingVolume = null;
  let status = openings.status;
  if (status === QuantityStatus.CALCULATED && !openingResolved) status = QuantityStatus.PARTIAL;

  const slits = wallSlits(context);
  if (slits.invalid)
    return unavailable(
      context,
      QuantityStatus.INVALID_GEOMETRY,
      `WALL_SLIT_INVALID:${slits.invalid}`,
    );
  if (slits.active.length) {
    if (status === QuantityStatus.CALCULATED) status = QuantityStatus.PARTIAL;
    warnings.push(`WALL_STRUCTURAL_SLIT_UNRESOLVED:${slits.active.join(',')}`);
  }
  const net = openingVolume !== null && !slits.active.length ? gross - openingVolume : null;

  return buildResult(context, {
    status,
    values: {
      surfaceAreaMm2: geometry.measure.areaMm2,
      grossVolumeMm3: gross,
      netVolumeMm3: net,
      concreteVolumeMm3: net,
      openingVolumeMm3: context.openings?.length ? openingVolume : null,
    },
    method: 'WALL_TAPER_PIECEWISE_THICKNESS',
    warnings,
    extraBasis: {
      widthMm: rectangle.widthMm,
      heightMm: rectangle.heightMm,
      tBottomMm: profile.tBottomMm,
      tTopMm: profile.tTopMm,
      depthHbMm: hb.value,
      depthHtMm: ht.value,
      typeStraight: taperTypeStraight(context),
      fukashiMm: extra.values,
    },
  });
}

/**
 * 対応する場合QuantityResult、既存calculatorへ委譲する場合null。
 */
export function calculateEnhancedPanelQuantity(context) {
  if (context?.elementType === 'StbWall') {
    if (context.shapeKind === 'WALL_STRAIGHT') {
      return calculateStraight(context, context.shapeParameters?.t, 'PLANAR_AREA_X_WALL_THICKNESS');
    }
    if (context.shapeKind === 'WALL_TAPER') return calculateTaperWall(context);
  }
  if (context?.elementType === 'StbSlab' && context.shapeKind === 'SLAB_STRAIGHT') {
    return calculateStraight(context, context.shapeParameters?.depth, 'PLANAR_AREA_X_SLAB_DEPTH');
  }
  return null;
}
