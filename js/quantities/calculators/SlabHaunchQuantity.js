/**
 * @fileoverview RC在来スラブ・ハンチ数量。
 * NORMALスラブの全支持辺に同一ハンチが付くST-Bridge契約を、
 * 凸平面polygonの内側オフセット面積から厳密積分する。
 */

import { createQuantityResult, createUnavailableQuantityResult } from '../core/QuantityResult.js';
import { QuantityStatus } from '../core/QuantityStatus.js';
import { elementsByTagName } from '../core/StbXmlDomUtils.js';

const VERSION = 2;
const EPSILON = 1e-8;

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
  }
  return [...new Set(result)];
}

function result(context, status, values, warnings, basis = {}) {
  const payload = {
    identity: identity(context),
    status,
    values,
    basis: {
      method: 'SLAB_HAUNCH_SUPPORT_EDGE_OFFSET_INTEGRAL',
      calculator: 'PanelQuantityCalculator',
      calculatorVersion: VERSION,
      unitSystem: 'STB_MM',
      ...basis,
    },
    dependencies: dependencies(context),
    warnings,
    revision: context.revision,
  };
  return status === QuantityStatus.CALCULATED
    ? createQuantityResult(payload)
    : createUnavailableQuantityResult(payload);
}

function unavailable(context, status, warning, values = {}, basis = {}) {
  return result(context, status, values, [warning], basis);
}

function memberParameters(context) {
  if (context.memberParameters) return context.memberParameters;
  const document = context.sectionNode?.ownerDocument;
  const nodes = elementsByTagName(document, 'StbSlab');
  const member = nodes.find(
    (node) => String(node.getAttribute?.('id')) === String(context.element?.id),
  );
  if (!member) return {};
  return {
    kind_slab: member.getAttribute?.('kind_slab') || null,
    thickness_add_top: member.getAttribute?.('thickness_add_top'),
    thickness_add_bottom: member.getAttribute?.('thickness_add_bottom'),
  };
}

function fukashi(context) {
  const member = memberParameters(context);
  const top = optionalNonnegative(member.thickness_add_top);
  const bottom = optionalNonnegative(member.thickness_add_bottom);
  if (!top.ok || !bottom.ok) return null;
  return { top: top.value, bottom: bottom.value, total: top.value + bottom.value };
}

function normalizePoint(point) {
  const x = Number(point?.x ?? point?.X);
  const y = Number(point?.y ?? point?.Y);
  const z = Number(point?.z ?? point?.Z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
}

function localPolygon(points) {
  const normalized = (points || []).map(normalizePoint);
  if (normalized.length < 3 || normalized.some((point) => !point)) return null;
  const origin = normalized[0];
  let ux = null;
  for (let index = 1; index < normalized.length; index++) {
    const dx = normalized[index].x - origin.x;
    const dy = normalized[index].y - origin.y;
    const dz = normalized[index].z - origin.z;
    const length = Math.hypot(dx, dy, dz);
    if (length > EPSILON) {
      ux = { x: dx / length, y: dy / length, z: dz / length };
      break;
    }
  }
  if (!ux) return null;

  let normal = null;
  for (let index = 2; index < normalized.length; index++) {
    const vx = normalized[index].x - origin.x;
    const vy = normalized[index].y - origin.y;
    const vz = normalized[index].z - origin.z;
    const cx = ux.y * vz - ux.z * vy;
    const cy = ux.z * vx - ux.x * vz;
    const cz = ux.x * vy - ux.y * vx;
    const length = Math.hypot(cx, cy, cz);
    if (length > EPSILON) {
      normal = { x: cx / length, y: cy / length, z: cz / length };
      break;
    }
  }
  if (!normal) return null;
  const uy = {
    x: normal.y * ux.z - normal.z * ux.y,
    y: normal.z * ux.x - normal.x * ux.z,
    z: normal.x * ux.y - normal.y * ux.x,
  };

  let maxDeviation = 0;
  const polygon = normalized.map((point) => {
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    const dz = point.z - origin.z;
    maxDeviation = Math.max(maxDeviation, Math.abs(dx * normal.x + dy * normal.y + dz * normal.z));
    return { x: dx * ux.x + dy * ux.y + dz * ux.z, y: dx * uy.x + dy * uy.y + dz * uy.z };
  });
  const span = Math.max(
    ...normalized.map((point) =>
      Math.hypot(point.x - origin.x, point.y - origin.y, point.z - origin.z),
    ),
  );
  const tolerance = Math.max(1e-6, span * 1e-9);
  if (maxDeviation > tolerance) return { error: 'NON_PLANAR_PANEL', maxDeviation };
  return { polygon };
}

function signedArea(polygon) {
  let sum = 0;
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function polygonArea(polygon) {
  return Math.abs(signedArea(polygon));
}

function normalizeCcw(polygon) {
  return signedArea(polygon) >= 0 ? [...polygon] : [...polygon].reverse();
}

function cross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function isConvex(polygon) {
  if (polygon.length < 3) return false;
  let sign = 0;
  for (let index = 0; index < polygon.length; index++) {
    const value = cross(
      polygon[index],
      polygon[(index + 1) % polygon.length],
      polygon[(index + 2) % polygon.length],
    );
    if (Math.abs(value) <= EPSILON) continue;
    const current = Math.sign(value);
    if (sign && current !== sign) return false;
    sign = current;
  }
  return sign !== 0;
}

function clipHalfPlane(polygon, nx, ny, threshold, tolerance) {
  const result = [];
  const inside = (point) => nx * point.x + ny * point.y >= threshold - tolerance;
  const intersection = (a, b) => {
    const av = nx * a.x + ny * a.y - threshold;
    const bv = nx * b.x + ny * b.y - threshold;
    const denom = av - bv;
    if (Math.abs(denom) <= EPSILON) return null;
    const t = av / denom;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const aInside = inside(a);
    const bInside = inside(b);
    if (aInside) result.push(a);
    if (aInside !== bInside) {
      const point = intersection(a, b);
      if (point) result.push(point);
    }
  }
  return result;
}

function insetPolygon(polygon, distance) {
  let result = normalizeCcw(polygon);
  const original = result;
  const scale = Math.max(1, ...result.map((point) => Math.hypot(point.x, point.y)));
  const tolerance = scale * 1e-10 + 1e-7;
  for (let index = 0; index < original.length; index++) {
    const a = original[index];
    const b = original[(index + 1) % original.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length <= tolerance) return [];
    const nx = -dy / length;
    const ny = dx / length;
    const threshold = nx * a.x + ny * a.y + distance;
    result = clipHalfPlane(result, nx, ny, threshold, tolerance);
    if (result.length < 3) return [];
  }
  return result;
}

function resolveHaunchProfile(context) {
  const conventional = elementsByTagName(
    context.sectionNode,
    'StbSecSlab_RC_ConventionalHaunch',
  )[0];
  if (conventional) {
    return {
      baseDepth: positive(conventional.getAttribute?.('base_depth')),
      centerDepth: positive(conventional.getAttribute?.('tip_depth')),
      haunchLength: positive(conventional.getAttribute?.('haunch_length')),
      tipOffset: optionalFinite(conventional.getAttribute?.('tip_offset')),
    };
  }

  const legacy = elementsByTagName(context.sectionNode, 'StbSecSlab_RC_Haunch');
  if (legacy.length === 0) return null;

  // ST-Bridge 2.0.2 stores base thickness, center thickness, and haunch length
  // as three pos/depth elements rather than one conventional element.
  const byPosition = new Map(
    legacy.map((node) => [String(node.getAttribute?.('pos') || '').toUpperCase(), node]),
  );
  const base = byPosition.get('BASE');
  const center = byPosition.get('CENTER');
  const haunch = byPosition.get('HAUNCH');
  if (base && center && haunch) {
    return {
      baseDepth: positive(base.getAttribute?.('depth')),
      centerDepth: positive(center.getAttribute?.('depth')),
      haunchLength: positive(haunch.getAttribute?.('depth')),
      tipOffset: { ok: true, value: 0 },
    };
  }

  // Keep accepting the single-node shape used by older converted fixtures.
  const node = legacy[0];
  return {
    baseDepth: positive(node.getAttribute?.('base_depth')),
    centerDepth: positive(node.getAttribute?.('tip_depth')),
    haunchLength: positive(node.getAttribute?.('haunch_length')),
    tipOffset: optionalFinite(node.getAttribute?.('tip_offset')),
  };
}

/** 対象外の場合 null。 */
export function calculateSlabHaunchQuantity(context) {
  if (context?.elementType !== 'StbSlab') return null;
  const profile = resolveHaunchProfile(context);
  if (!profile) return null;

  const member = memberParameters(context);
  if (String(member.kind_slab || context.element?.kind_slab || '').toUpperCase() !== 'NORMAL') {
    return unavailable(context, QuantityStatus.UNSUPPORTED, 'SLAB_HAUNCH_NORMAL_SLAB_REQUIRED');
  }
  const baseDepthRaw = profile.baseDepth;
  const centerDepthRaw = profile.centerDepth;
  const haunchLength = profile.haunchLength;
  const tipOffset = profile.tipOffset;
  const extra = fukashi(context);
  if (!baseDepthRaw || !centerDepthRaw || !haunchLength || !tipOffset.ok || !extra) {
    return unavailable(context, QuantityStatus.INSUFFICIENT_DATA, 'SLAB_HAUNCH_DIMENSIONS_INVALID');
  }
  const local = localPolygon(context.points);
  if (!local) return unavailable(context, QuantityStatus.INVALID_GEOMETRY, 'PANEL_NODE_MISSING');
  if (local.error) {
    return unavailable(
      context,
      QuantityStatus.INVALID_GEOMETRY,
      local.error,
      {},
      { maxPlaneDeviationMm: local.maxDeviation },
    );
  }
  const polygon = normalizeCcw(local.polygon);
  if (!isConvex(polygon)) {
    return unavailable(context, QuantityStatus.UNSUPPORTED, 'SLAB_HAUNCH_CONVEX_PANEL_REQUIRED');
  }
  const area0 = polygonArea(polygon);
  if (!(area0 > 0))
    return unavailable(context, QuantityStatus.INVALID_GEOMETRY, 'PANEL_AREA_INVALID');

  const halfInset = insetPolygon(polygon, haunchLength / 2);
  const fullInset = insetPolygon(polygon, haunchLength);
  const areaHalf = polygonArea(halfInset);
  const areaFull = polygonArea(fullInset);
  const areaTolerance = Math.max(1e-6, area0 * 1e-12);
  if (
    halfInset.length < 3 ||
    fullInset.length < 3 ||
    areaHalf <= areaTolerance ||
    areaFull <= areaTolerance
  ) {
    return unavailable(
      context,
      QuantityStatus.INVALID_GEOMETRY,
      'SLAB_HAUNCH_LENGTH_EXCEEDS_PANEL_CORE',
      { surfaceAreaMm2: area0 },
    );
  }
  if (halfInset.length !== polygon.length || fullInset.length !== polygon.length) {
    return unavailable(
      context,
      QuantityStatus.UNSUPPORTED,
      'SLAB_HAUNCH_OFFSET_TOPOLOGY_CHANGE_UNSUPPORTED',
      { surfaceAreaMm2: area0 },
    );
  }

  const normalizedHaunchArea = (5 * area0 - 4 * areaHalf - areaFull) / 6;
  if (!(normalizedHaunchArea >= 0 && normalizedHaunchArea <= area0 + EPSILON)) {
    return unavailable(context, QuantityStatus.INVALID_GEOMETRY, 'SLAB_HAUNCH_INTEGRAL_INVALID');
  }

  const baseDepth = baseDepthRaw + extra.total;
  const centerDepth = centerDepthRaw + extra.total;
  const gross = area0 * centerDepth + normalizedHaunchArea * (baseDepth - centerDepth);
  const hasOpenings = Array.isArray(context.openings) && context.openings.length > 0;
  const status = hasOpenings ? QuantityStatus.PARTIAL : QuantityStatus.CALCULATED;
  const warnings = hasOpenings ? ['SLAB_HAUNCH_OPENING_DEDUCTION_UNRESOLVED'] : [];
  const net = hasOpenings ? null : gross;

  return result(
    context,
    status,
    {
      surfaceAreaMm2: area0,
      grossVolumeMm3: gross,
      netVolumeMm3: net,
      concreteVolumeMm3: net,
      openingVolumeMm3: null,
    },
    warnings,
    {
      baseDepthMm: baseDepth,
      centerDepthMm: centerDepth,
      haunchLengthMm: haunchLength,
      tipOffsetMm: tipOffset.value,
      fukashiMm: { top: extra.top, bottom: extra.bottom },
      coreAreaMm2: areaFull,
      normalizedHaunchAreaMm2: normalizedHaunchArea,
    },
  );
}
