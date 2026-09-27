/**
 * @fileoverview 壁・スラブ・パラペットの派生数量calculator。
 */

import { createQuantityResult, createUnavailableQuantityResult } from '../core/QuantityResult.js';
import { QuantityStatus } from '../core/QuantityStatus.js';
import { distance3d, measurePlanarPolygon3d } from '../core/PanelMeasure.js';

export const PANEL_QUANTITY_CALCULATOR_VERSION = 1;

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
  if (context.element?.id_node_start) result.push(`StbNode:${context.element.id_node_start}`);
  if (context.element?.id_node_end) result.push(`StbNode:${context.element.id_node_end}`);
  if (context.section?.id !== null && context.section?.id !== undefined) {
    result.push(`${context.section.sectionType || 'StbSection'}:${context.section.id}`);
  }
  for (const opening of context.openings || []) {
    const tag = opening.sourceVersion === '2.1.0' ? 'StbOpenArrangement' : 'StbOpen';
    result.push(`${tag}:${opening.id}`);
  }
  return result;
}

function unavailable(context, status, warning, values = {}) {
  return createUnavailableQuantityResult({
    identity: identity(context),
    status,
    values,
    basis: {
      calculator: 'PanelQuantityCalculator',
      calculatorVersion: PANEL_QUANTITY_CALCULATOR_VERSION,
      unitSystem: 'STB_MM',
    },
    dependencies: dependencies(context),
    warnings: [warning],
    revision: context.revision,
  });
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function openingDeduction(context, panelAreaMm2, thicknessMm) {
  const openings = context.openings || [];
  if (openings.length === 0)
    return { status: QuantityStatus.CALCULATED, volumeMm3: 0, warnings: [] };
  if (openings.length > 1) {
    return {
      status: QuantityStatus.PARTIAL,
      volumeMm3: null,
      warnings: ['MULTIPLE_OPENINGS_UNRESOLVED: 重複判定未実装のため正味体積を確定しません。'],
    };
  }

  const opening = openings[0];
  const width = positiveNumber(opening.length_X);
  const height = positiveNumber(opening.length_Y);
  if (!width || !height) {
    return {
      status: QuantityStatus.INSUFFICIENT_DATA,
      volumeMm3: null,
      warnings: ['OPENING_DIMENSIONS_MISSING: 開口寸法を確定できません。'],
    };
  }
  const area = width * height;
  if (area >= panelAreaMm2) {
    return {
      status: QuantityStatus.INVALID_GEOMETRY,
      volumeMm3: null,
      warnings: ['OPENING_AREA_INVALID: 開口面積がパネル面積以上です。'],
    };
  }
  return { status: QuantityStatus.CALCULATED, volumeMm3: area * thicknessMm, warnings: [] };
}

function calculateConstantThicknessPanel(context, { thicknessMm, method }) {
  const thickness = positiveNumber(thicknessMm);
  if (!thickness) {
    return unavailable(
      context,
      QuantityStatus.INSUFFICIENT_DATA,
      'PANEL_THICKNESS_MISSING: パネル厚を確定できません。',
    );
  }
  if (!Array.isArray(context.points) || context.points.some((point) => !point)) {
    return unavailable(
      context,
      QuantityStatus.INVALID_GEOMETRY,
      'PANEL_NODE_MISSING: 節点を解決できません。',
    );
  }

  let measure;
  try {
    measure = measurePlanarPolygon3d(context.points);
  } catch (error) {
    return unavailable(
      context,
      QuantityStatus.INVALID_GEOMETRY,
      `PANEL_AREA_INVALID: ${error?.message || error}`,
    );
  }
  if (!measure.planar) {
    return unavailable(
      context,
      QuantityStatus.INVALID_GEOMETRY,
      `NON_PLANAR_PANEL: 平面外偏差 ${measure.maxPlaneDeviationMm.toFixed(6)} mm`,
      { surfaceAreaMm2: measure.areaMm2 },
    );
  }

  const gross = measure.areaMm2 * thickness;
  const deduction = openingDeduction(context, measure.areaMm2, thickness);
  const values = {
    surfaceAreaMm2: measure.areaMm2,
    grossVolumeMm3: gross,
    netVolumeMm3: deduction.volumeMm3 === null ? null : gross - deduction.volumeMm3,
    concreteVolumeMm3: deduction.volumeMm3 === null ? null : gross - deduction.volumeMm3,
    openingVolumeMm3: context.openings?.length ? deduction.volumeMm3 : null,
  };

  if (deduction.status !== QuantityStatus.CALCULATED) {
    return createUnavailableQuantityResult({
      identity: identity(context),
      status: deduction.status,
      values,
      basis: {
        method,
        calculator: 'PanelQuantityCalculator',
        calculatorVersion: PANEL_QUANTITY_CALCULATOR_VERSION,
        unitSystem: 'STB_MM',
        thicknessMm: thickness,
      },
      dependencies: dependencies(context),
      warnings: deduction.warnings,
      revision: context.revision,
    });
  }

  return createQuantityResult({
    identity: identity(context),
    status: QuantityStatus.CALCULATED,
    values,
    basis: {
      method,
      calculator: 'PanelQuantityCalculator',
      calculatorVersion: PANEL_QUANTITY_CALCULATOR_VERSION,
      unitSystem: 'STB_MM',
      thicknessMm: thickness,
    },
    dependencies: dependencies(context),
    warnings: [],
    revision: context.revision,
  });
}

function calculateParapet(context) {
  if (context.shapeKind !== 'PARAPET_TYPE_I') {
    return unavailable(
      context,
      context.shapeKind === 'UNKNOWN'
        ? QuantityStatus.INSUFFICIENT_DATA
        : QuantityStatus.UNSUPPORTED,
      `PARAPET_SHAPE_UNSUPPORTED: ${context.shapeKind || 'UNKNOWN'}`,
    );
  }
  const thickness = positiveNumber(context.shapeParameters?.t_T);
  const height = positiveNumber(context.shapeParameters?.depth_H);
  if (!thickness || !height) {
    return unavailable(
      context,
      QuantityStatus.INSUFFICIENT_DATA,
      'PARAPET_DIMENSIONS_MISSING: t_T / depth_H を確定できません。',
    );
  }
  if (
    !Array.isArray(context.points) ||
    context.points.length !== 2 ||
    context.points.some((point) => !point)
  ) {
    return unavailable(
      context,
      QuantityStatus.INVALID_GEOMETRY,
      'PARAPET_NODE_MISSING: 始終端節点を解決できません。',
    );
  }
  const lengthMm = distance3d(context.points[0], context.points[1]);
  if (!Number.isFinite(lengthMm) || lengthMm <= 0) {
    return unavailable(
      context,
      QuantityStatus.INVALID_GEOMETRY,
      'PARAPET_LENGTH_INVALID: 部材長が0以下です。',
    );
  }
  const areaMm2 = thickness * height;
  const volumeMm3 = areaMm2 * lengthMm;
  return createQuantityResult({
    identity: identity(context),
    status: QuantityStatus.CALCULATED,
    values: {
      lengthMm,
      sectionAreaMm2: areaMm2,
      grossVolumeMm3: volumeMm3,
      netVolumeMm3: volumeMm3,
      concreteVolumeMm3: volumeMm3,
    },
    basis: {
      method: 'PARAPET_TYPE_I_PRISM',
      calculator: 'PanelQuantityCalculator',
      calculatorVersion: PANEL_QUANTITY_CALCULATOR_VERSION,
      unitSystem: 'STB_MM',
    },
    dependencies: dependencies(context),
    warnings: [],
    revision: context.revision,
  });
}

export function calculatePanelQuantity(context) {
  if (!context?.element || !context?.elementType) {
    throw new TypeError('panel quantity context is required');
  }

  if (context.elementType === 'StbWall') {
    if (context.shapeKind === 'WALL_STRAIGHT') {
      return calculateConstantThicknessPanel(context, {
        thicknessMm: context.shapeParameters?.t,
        method: 'PLANAR_AREA_X_WALL_THICKNESS',
      });
    }
    return unavailable(
      context,
      context.shapeKind === 'UNKNOWN'
        ? QuantityStatus.INSUFFICIENT_DATA
        : QuantityStatus.UNSUPPORTED,
      `WALL_SHAPE_UNSUPPORTED: ${context.shapeKind || 'UNKNOWN'}`,
    );
  }

  if (context.elementType === 'StbSlab') {
    if (context.shapeKind === 'SLAB_STRAIGHT') {
      return calculateConstantThicknessPanel(context, {
        thicknessMm: context.shapeParameters?.depth,
        method: 'PLANAR_AREA_X_SLAB_DEPTH',
      });
    }
    return unavailable(
      context,
      context.shapeKind === 'UNKNOWN'
        ? QuantityStatus.INSUFFICIENT_DATA
        : QuantityStatus.UNSUPPORTED,
      `SLAB_SHAPE_UNSUPPORTED: ${context.shapeKind || 'UNKNOWN'}`,
    );
  }

  if (context.elementType === 'StbParapet') return calculateParapet(context);

  return unavailable(
    context,
    QuantityStatus.UNSUPPORTED,
    `PANEL_ELEMENT_UNSUPPORTED: ${context.elementType}`,
  );
}
