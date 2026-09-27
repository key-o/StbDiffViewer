/**
 * @fileoverview 独立基礎 StbFooting の派生数量 calculator。
 */

import { createQuantityResult, createUnavailableQuantityResult } from '../core/QuantityResult.js';
import { QuantityStatus } from '../core/QuantityStatus.js';

export const FOOTING_QUANTITY_CALCULATOR_VERSION = 4;

function identity(context) {
  return {
    elementType: context.elementType,
    elementId: context.element?.id,
    guid: context.element?.guid || null,
  };
}

function dependencies(context) {
  const result = [];
  if (context.element?.id_node) result.push(`StbNode:${context.element.id_node}`);
  if (context.element?.id_node_start) result.push(`StbNode:${context.element.id_node_start}`);
  if (context.element?.id_node_end) result.push(`StbNode:${context.element.id_node_end}`);
  if (context.section?.id !== null && context.section?.id !== undefined) {
    result.push(`${context.section.sectionType || 'StbSecFoundation_RC'}:${context.section.id}`);
  }
  return result;
}

function build(context, status, values, method, warnings = [], basis = {}) {
  const payload = {
    identity: identity(context),
    status,
    values,
    basis: {
      method,
      calculator: 'FootingQuantityCalculator',
      calculatorVersion: FOOTING_QUANTITY_CALCULATOR_VERSION,
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

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function polygonArea(points) {
  if (!Array.isArray(points) || points.length < 3) return null;
  let twiceArea = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    if (![a?.x, a?.y, b?.x, b?.y].every(Number.isFinite)) return null;
    twiceArea += a.x * b.y - b.x * a.y;
  }
  const area = Math.abs(twiceArea) / 2;
  return Number.isFinite(area) && area > 0 ? area : null;
}

function constantDepthResult(context, footprintAreaMm2, depthMm, method, basis = {}) {
  const area = positive(footprintAreaMm2);
  const depth = positive(depthMm);
  if (!area || !depth) {
    return build(context, QuantityStatus.INVALID_GEOMETRY, {}, method, [
      'FOOTING_SHAPE_DIMENSIONS_INVALID',
    ]);
  }
  const volumeMm3 = area * depth;
  return build(
    context,
    QuantityStatus.CALCULATED,
    {
      footprintAreaMm2: area,
      grossVolumeMm3: volumeMm3,
      netVolumeMm3: volumeMm3,
      concreteVolumeMm3: volumeMm3,
    },
    method,
    [],
    { depthMm: depth, ...basis },
  );
}

function triangleFootprint(shape) {
  const widthX = positive(shape.widthXmm);
  const widthY = positive(shape.widthYmm);
  const chamferX = nonnegative(shape.chamferXmm);
  const chamferY = nonnegative(shape.chamferYmm);
  if (!widthX || !widthY || chamferX === null || chamferY === null) return null;
  if (chamferX >= widthX || chamferY >= widthY) return null;
  const halfX = widthX / 2;
  const halfY = widthY / 2;
  const points = [
    { x: -halfX, y: -halfY },
    { x: halfX, y: -halfY },
    { x: halfX, y: -halfY + chamferY },
    { x: -halfX + chamferX, y: halfY },
    { x: -halfX, y: halfY },
  ];
  return {
    areaMm2: polygonArea(points),
    widthXmm: widthX,
    widthYmm: widthY,
    chamferXmm: chamferX,
    chamferYmm: chamferY,
  };
}

function equiTriangleFootprint(shape) {
  const base = positive(shape.widthBaseMm);
  const chamfer = nonnegative(shape.widthChamferMm);
  if (!base || chamfer === null) return null;
  const originalSide = base + 2 * chamfer;
  const height = (Math.sqrt(3) * originalSide) / 2;
  const bottomY = -height / 3;
  const topY = (2 * height) / 3;
  const points = [
    { x: -base / 2, y: bottomY },
    { x: base / 2, y: bottomY },
    { x: base / 2 + chamfer / 2, y: bottomY + (Math.sqrt(3) * chamfer) / 2 },
    { x: chamfer / 2, y: topY - (Math.sqrt(3) * chamfer) / 2 },
    { x: -chamfer / 2, y: topY - (Math.sqrt(3) * chamfer) / 2 },
    { x: -base / 2 - chamfer / 2, y: bottomY + (Math.sqrt(3) * chamfer) / 2 },
  ];
  return { areaMm2: polygonArea(points), widthBaseMm: base, widthChamferMm: chamfer };
}

function octagonFootprint(shape) {
  const widthX = positive(shape.widthXmm);
  const widthY = positive(shape.widthYmm);
  if (!widthX || !widthY || !Array.isArray(shape.chamfers) || shape.chamfers.length !== 4)
    return null;
  const chamfers = shape.chamfers.map((entry) => ({
    x: nonnegative(entry?.x),
    y: nonnegative(entry?.y),
  }));
  if (chamfers.some((entry) => entry.x === null || entry.y === null)) return null;
  const [c1, c2, c3, c4] = chamfers;
  if (
    c1.x + c2.x > widthX ||
    c4.x + c3.x > widthX ||
    c1.y + c4.y > widthY ||
    c2.y + c3.y > widthY
  ) {
    return null;
  }
  const halfX = widthX / 2;
  const halfY = widthY / 2;
  const points = [
    { x: -halfX + c1.x, y: -halfY },
    { x: halfX - c2.x, y: -halfY },
    { x: halfX, y: -halfY + c2.y },
    { x: halfX, y: halfY - c3.y },
    { x: halfX - c3.x, y: halfY },
    { x: -halfX + c4.x, y: halfY },
    { x: -halfX, y: halfY - c4.y },
    { x: -halfX, y: -halfY + c1.y },
  ];
  return { areaMm2: polygonArea(points), widthXmm: widthX, widthYmm: widthY, chamfers };
}

function distance3d(a, b) {
  if (!a || !b) return null;
  const values = [a.x, a.y, a.z, b.x, b.y, b.z].map(Number);
  if (!values.every(Number.isFinite)) return null;
  return Math.hypot(values[3] - values[0], values[4] - values[1], values[5] - values[2]);
}

export function calculateFootingQuantity(context) {
  if (!context?.element || context.elementType !== 'StbFooting') {
    throw new TypeError('StbFooting quantity context is required');
  }

  const shape = context.shape || {};
  if (shape.kind === 'RECT') {
    const widthX = positive(shape.widthXmm);
    const widthY = positive(shape.widthYmm);
    return constantDepthResult(
      context,
      widthX && widthY ? widthX * widthY : null,
      shape.depthMm,
      'FOOTING_RECT_PRISM',
      { widthXmm: widthX, widthYmm: widthY },
    );
  }

  if (shape.kind === 'TRIANGLE') {
    const footprint = triangleFootprint(shape);
    return constantDepthResult(
      context,
      footprint?.areaMm2,
      shape.depthMm,
      'FOOTING_TRIANGLE_PRISM',
      footprint || {},
    );
  }

  if (shape.kind === 'EQUI_TRIANGLE') {
    const footprint = equiTriangleFootprint(shape);
    return constantDepthResult(
      context,
      footprint?.areaMm2,
      shape.depthMm,
      'FOOTING_EQUI_TRIANGLE_PRISM',
      footprint || {},
    );
  }

  if (shape.kind === 'OCTAGON') {
    const footprint = octagonFootprint(shape);
    return constantDepthResult(
      context,
      footprint?.areaMm2,
      shape.depthMm,
      'FOOTING_OCTAGON_PRISM',
      footprint || {},
    );
  }

  if (shape.kind === 'MISSING') {
    return build(context, QuantityStatus.INSUFFICIENT_DATA, {}, 'FOOTING_SECTION_UNRESOLVED', [
      'FOOTING_SECTION_OR_SHAPE_MISSING',
    ]);
  }

  if (shape.kind === 'TAPERED_RECT') {
    return build(
      context,
      QuantityStatus.UNSUPPORTED,
      {},
      'FOOTING_TAPERED_RECT_UNDERDETERMINED',
      ['FOOTING_TAPERED_RECT_PROFILE_UNDERDETERMINED'],
      {
        widthXmm: shape.widthXmm,
        widthYmm: shape.widthYmm,
        depthBaseMm: shape.depthBaseMm,
        depthTipMm: shape.depthTipMm,
      },
    );
  }

  if (shape.kind === 'CONTINUOUS') {
    return build(
      context,
      QuantityStatus.UNSUPPORTED,
      {},
      'FOOTING_CONTINUOUS_REQUIRES_STRIP_MEMBER',
      ['FOOTING_CONTINUOUS_SHAPE_REQUIRES_STB_STRIP_FOOTING_LENGTH'],
    );
  }

  return build(context, QuantityStatus.UNSUPPORTED, {}, 'FOOTING_SHAPE_UNSUPPORTED', [
    `FOOTING_SHAPE_UNSUPPORTED:${shape.kind || 'UNKNOWN'}`,
  ]);
}

export function calculateStripFootingQuantity(context) {
  if (!context?.element || context.elementType !== 'StbStripFooting') {
    throw new TypeError('StbStripFooting quantity context is required');
  }
  const shape = context.shape || {};
  if (shape.kind !== 'CONTINUOUS') {
    return build(context, QuantityStatus.UNSUPPORTED, {}, 'STRIP_FOOTING_SHAPE_UNSUPPORTED', [
      `STRIP_FOOTING_SHAPE_UNSUPPORTED:${shape.kind || 'UNKNOWN'}`,
    ]);
  }

  const width = positive(shape.widthMm);
  const depthBase = positive(shape.depthBaseMm);
  const depthTip = positive(shape.depthTipMm);
  const type = String(shape.type || '').toUpperCase();
  if (!width || !depthBase || !depthTip || !['RIGHT_L', 'LEFT_L', 'REVERSE_T'].includes(type)) {
    return build(context, QuantityStatus.INVALID_GEOMETRY, {}, 'STRIP_FOOTING_CONTINUOUS_PRISM', [
      'STRIP_FOOTING_CONTINUOUS_DIMENSIONS_INVALID',
    ]);
  }

  if (
    !Array.isArray(context.points) ||
    context.points.length !== 2 ||
    context.points.some((p) => !p)
  ) {
    return build(context, QuantityStatus.INVALID_GEOMETRY, {}, 'STRIP_FOOTING_CONTINUOUS_PRISM', [
      'STRIP_FOOTING_NODE_MISSING',
    ]);
  }

  const baseLengthMm = distance3d(context.points[0], context.points[1]);
  const lengthExStartMm = finiteOrNull(
    context.lengthExStartMm ?? context.element?.length_ex_start ?? 0,
  );
  const lengthExEndMm = finiteOrNull(context.lengthExEndMm ?? context.element?.length_ex_end ?? 0);
  if (!(baseLengthMm > 0) || lengthExStartMm === null || lengthExEndMm === null) {
    return build(context, QuantityStatus.INVALID_GEOMETRY, {}, 'STRIP_FOOTING_CONTINUOUS_PRISM', [
      'STRIP_FOOTING_LENGTH_INVALID',
    ]);
  }

  // ST-Bridge の length_ex_start / length_ex_end は、梁始終端の基準点から
  // 外側へ出る余長を正とする。負値は内側への短縮なので、基準線長へ符号付きで加算する。
  const lengthMm = baseLengthMm + lengthExStartMm + lengthExEndMm;
  if (!(lengthMm > 0)) {
    return build(context, QuantityStatus.INVALID_GEOMETRY, {}, 'STRIP_FOOTING_CONTINUOUS_PRISM', [
      'STRIP_FOOTING_EFFECTIVE_LENGTH_INVALID',
    ]);
  }

  // RIGHT_L / LEFT_L は一方向、REVERSE_T は左右対称だが、いずれも
  // width全体に対する線形厚さ分布の平均厚は (depth_base + depth_tip) / 2。
  const sectionAreaMm2 = (width * (depthBase + depthTip)) / 2;
  const volumeMm3 = sectionAreaMm2 * lengthMm;
  return build(
    context,
    QuantityStatus.CALCULATED,
    {
      lengthMm,
      sectionAreaMm2,
      grossVolumeMm3: volumeMm3,
      netVolumeMm3: volumeMm3,
      concreteVolumeMm3: volumeMm3,
    },
    'STRIP_FOOTING_CONTINUOUS_PRISM',
    [],
    {
      widthMm: width,
      depthBaseMm: depthBase,
      depthTipMm: depthTip,
      type,
      baseLengthMm,
      lengthExStartMm,
      lengthExEndMm,
    },
  );
}
