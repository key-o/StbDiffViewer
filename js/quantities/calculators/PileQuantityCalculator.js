/**
 * @fileoverview StbPile 派生数量 calculator。
 */

import { createQuantityResult, createUnavailableQuantityResult } from '../core/QuantityResult.js';
import { QuantityStatus } from '../core/QuantityStatus.js';

export const PILE_QUANTITY_CALCULATOR_VERSION = 3;

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
  if (context.element?.id_node_bottom) result.push(`StbNode:${context.element.id_node_bottom}`);
  if (context.element?.id_node_top) result.push(`StbNode:${context.element.id_node_top}`);
  if (context.section?.id !== null && context.section?.id !== undefined) {
    result.push(`${context.section.sectionType || 'StbPileSection'}:${context.section.id}`);
  }
  return [...new Set(result)];
}

function build(context, status, values, method, warnings = [], basis = {}) {
  const payload = {
    identity: identity(context),
    status,
    values,
    basis: {
      method,
      calculator: 'PileQuantityCalculator',
      calculatorVersion: PILE_QUANTITY_CALCULATOR_VERSION,
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

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== '';
}

function distance3d(a, b) {
  if (!a || !b) return null;
  const values = [a.x, a.y, a.z, b.x, b.y, b.z].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const length = Math.hypot(values[3] - values[0], values[4] - values[1], values[5] - values[2]);
  return length > 0 ? length : null;
}

function resolveMemberLength(context) {
  const explicitRaw = context.element?.length_all;
  if (hasValue(explicitRaw)) {
    const explicit = Number(explicitRaw);
    if (!Number.isFinite(explicit) || explicit <= 0) {
      return { invalid: true, basis: 'StbPile.length_all' };
    }
    return { lengthMm: explicit, basis: 'StbPile.length_all' };
  }
  if (
    Array.isArray(context.points) &&
    context.points.length === 2 &&
    context.points.every((point) => Boolean(point))
  ) {
    const length = distance3d(context.points[0], context.points[1]);
    if (length) return { lengthMm: length, basis: 'node-distance' };
    return { invalid: true, basis: 'node-distance' };
  }
  return null;
}

function circleArea(D) {
  return (Math.PI * D * D) / 4;
}

function pipeArea(D, t) {
  const inner = D - 2 * t;
  if (!(inner > 0)) return null;
  return (Math.PI * (D * D - inner * inner)) / 4;
}

function frustumVolumeByDiameters(D1, D2, length) {
  return (Math.PI * length * (D1 * D1 + D1 * D2 + D2 * D2)) / 12;
}

function parseRequiredPositive(value) {
  if (!hasValue(value)) return { missing: true };
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return { invalid: true };
  return { value: number };
}

function parseRequiredNonnegative(value) {
  if (!hasValue(value)) return { missing: true };
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return { invalid: true };
  return { value: number };
}

function taperLengthByDiameters(Dextended, Daxial, angleDeg) {
  if (Dextended < Daxial) return { invalid: true };
  const radiusDiff = (Dextended - Daxial) / 2;
  if (radiusDiff === 0) return { lengthMm: 0 };
  if (!hasValue(angleDeg)) return { missing: true };
  const angle = Number(angleDeg);
  if (!Number.isFinite(angle) || angle <= 0 || angle >= 90) return { invalid: true };
  return { lengthMm: radiusDiff / Math.tan((angle * Math.PI) / 180), angleDeg: angle };
}

function extendedGeometryFailure(context, code, status = QuantityStatus.INVALID_GEOMETRY) {
  return build(context, status, {}, 'PILE_RC_EXTENDED_PROFILE_INTEGRAL', [code]);
}

function calculateRcExtended(context) {
  const shape = context.shape || {};
  const kind = shape.kind;
  const hasTop = kind === 'RC_EXTENDED_TOP' || kind === 'RC_EXTENDED_TOP_FOOT';
  const hasFoot = kind === 'RC_EXTENDED_FOOT' || kind === 'RC_EXTENDED_TOP_FOOT';

  const totalLength = resolveMemberLength(context);
  if (totalLength?.invalid) {
    return extendedGeometryFailure(context, 'PILE_RC_EXTENDED_LENGTH_INVALID');
  }
  if (!totalLength) {
    return extendedGeometryFailure(
      context,
      'PILE_RC_EXTENDED_LENGTH_MISSING',
      QuantityStatus.INSUFFICIENT_DATA,
    );
  }

  const axial = parseRequiredPositive(shape.DaxialMm);
  if (axial.missing) {
    return extendedGeometryFailure(
      context,
      'PILE_RC_EXTENDED_AXIAL_DIAMETER_MISSING',
      QuantityStatus.INSUFFICIENT_DATA,
    );
  }
  if (axial.invalid) {
    return extendedGeometryFailure(context, 'PILE_RC_EXTENDED_AXIAL_DIAMETER_INVALID');
  }

  const basis = {
    lengthMm: totalLength.lengthMm,
    lengthBasis: totalLength.basis,
    DaxialMm: axial.value,
  };
  let volume = circleArea(axial.value) * totalLength.lengthMm;
  let occupiedLength = 0;

  if (hasTop) {
    const top = parseRequiredPositive(shape.DextendedTopMm);
    if (top.missing) {
      return extendedGeometryFailure(
        context,
        'PILE_RC_EXTENDED_TOP_DIAMETER_MISSING',
        QuantityStatus.INSUFFICIENT_DATA,
      );
    }
    if (top.invalid || top.value < axial.value) {
      return extendedGeometryFailure(context, 'PILE_RC_EXTENDED_TOP_DIAMETER_INVALID');
    }
    const topTaper = taperLengthByDiameters(top.value, axial.value, shape.angleExtendedTopDeg);
    if (topTaper.missing) {
      return extendedGeometryFailure(
        context,
        'PILE_RC_EXTENDED_TOP_ANGLE_MISSING',
        QuantityStatus.INSUFFICIENT_DATA,
      );
    }
    if (topTaper.invalid) {
      return extendedGeometryFailure(context, 'PILE_RC_EXTENDED_TOP_ANGLE_INVALID');
    }
    const head = parseRequiredPositive(context.element?.length_head);
    if (head.missing) {
      return extendedGeometryFailure(
        context,
        'PILE_RC_EXTENDED_HEAD_LENGTH_MISSING',
        QuantityStatus.INSUFFICIENT_DATA,
      );
    }
    if (head.invalid || head.value < topTaper.lengthMm || head.value > totalLength.lengthMm) {
      return extendedGeometryFailure(context, 'PILE_RC_EXTENDED_HEAD_LENGTH_INVALID');
    }

    const topStraightLength = head.value - topTaper.lengthMm;
    const axialArea = circleArea(axial.value);
    const topArea = circleArea(top.value);
    volume += (topArea - axialArea) * topStraightLength;
    volume +=
      frustumVolumeByDiameters(top.value, axial.value, topTaper.lengthMm) -
      axialArea * topTaper.lengthMm;
    occupiedLength += head.value;
    Object.assign(basis, {
      DextendedTopMm: top.value,
      lengthHeadMm: head.value,
      topStraightLengthMm: topStraightLength,
      topTaperLengthMm: topTaper.lengthMm,
      angleExtendedTopDeg: topTaper.angleDeg ?? Number(shape.angleExtendedTopDeg),
    });
  }

  if (hasFoot) {
    const foot = parseRequiredPositive(shape.DextendedFootMm);
    if (foot.missing) {
      return extendedGeometryFailure(
        context,
        'PILE_RC_EXTENDED_FOOT_DIAMETER_MISSING',
        QuantityStatus.INSUFFICIENT_DATA,
      );
    }
    if (foot.invalid || foot.value < axial.value) {
      return extendedGeometryFailure(context, 'PILE_RC_EXTENDED_FOOT_DIAMETER_INVALID');
    }
    const footStraight = parseRequiredNonnegative(shape.lengthExtendedFootMm);
    if (footStraight.missing) {
      return extendedGeometryFailure(
        context,
        'PILE_RC_EXTENDED_FOOT_LENGTH_MISSING',
        QuantityStatus.INSUFFICIENT_DATA,
      );
    }
    if (footStraight.invalid) {
      return extendedGeometryFailure(context, 'PILE_RC_EXTENDED_FOOT_LENGTH_INVALID');
    }
    const footTaper = taperLengthByDiameters(foot.value, axial.value, shape.angleExtendedFootDeg);
    if (footTaper.missing) {
      return extendedGeometryFailure(
        context,
        'PILE_RC_EXTENDED_FOOT_ANGLE_MISSING',
        QuantityStatus.INSUFFICIENT_DATA,
      );
    }
    if (footTaper.invalid) {
      return extendedGeometryFailure(context, 'PILE_RC_EXTENDED_FOOT_ANGLE_INVALID');
    }

    const footZoneLength = footStraight.value + footTaper.lengthMm;
    occupiedLength += footZoneLength;
    if (occupiedLength > totalLength.lengthMm + 1e-9) {
      return extendedGeometryFailure(
        context,
        hasTop ? 'PILE_RC_EXTENDED_ZONES_OVERLAP' : 'PILE_RC_EXTENDED_FOOT_ZONE_EXCEEDS_LENGTH',
      );
    }

    const axialArea = circleArea(axial.value);
    const footArea = circleArea(foot.value);
    volume += (footArea - axialArea) * footStraight.value;
    volume +=
      frustumVolumeByDiameters(axial.value, foot.value, footTaper.lengthMm) -
      axialArea * footTaper.lengthMm;
    Object.assign(basis, {
      DextendedFootMm: foot.value,
      footStraightLengthMm: footStraight.value,
      footTaperLengthMm: footTaper.lengthMm,
      angleExtendedFootDeg: footTaper.angleDeg ?? Number(shape.angleExtendedFootDeg),
    });
  }

  return build(
    context,
    QuantityStatus.CALCULATED,
    {
      lengthMm: totalLength.lengthMm,
      grossVolumeMm3: volume,
      netVolumeMm3: volume,
      concreteVolumeMm3: volume,
    },
    'PILE_RC_EXTENDED_PROFILE_INTEGRAL',
    [],
    basis,
  );
}

function calculateRcStraight(context) {
  const diameterRaw = context.shape?.Dmm;
  if (!hasValue(diameterRaw)) {
    return build(context, QuantityStatus.INSUFFICIENT_DATA, {}, 'PILE_RC_STRAIGHT_CYLINDER', [
      'PILE_RC_STRAIGHT_DIMENSIONS_MISSING',
    ]);
  }
  const diameter = Number(diameterRaw);
  if (!Number.isFinite(diameter) || diameter <= 0) {
    return build(context, QuantityStatus.INVALID_GEOMETRY, {}, 'PILE_RC_STRAIGHT_CYLINDER', [
      'PILE_RC_STRAIGHT_DIAMETER_INVALID',
    ]);
  }

  const length = resolveMemberLength(context);
  if (length?.invalid) {
    return build(
      context,
      QuantityStatus.INVALID_GEOMETRY,
      {},
      'PILE_RC_STRAIGHT_CYLINDER',
      ['PILE_RC_STRAIGHT_LENGTH_INVALID'],
      { lengthBasis: length.basis },
    );
  }
  if (!length) {
    return build(context, QuantityStatus.INSUFFICIENT_DATA, {}, 'PILE_RC_STRAIGHT_CYLINDER', [
      'PILE_RC_STRAIGHT_LENGTH_MISSING',
    ]);
  }

  const area = circleArea(diameter);
  const volume = area * length.lengthMm;
  return build(
    context,
    QuantityStatus.CALCULATED,
    {
      lengthMm: length.lengthMm,
      sectionAreaMm2: area,
      grossVolumeMm3: volume,
      netVolumeMm3: volume,
      concreteVolumeMm3: volume,
    },
    'PILE_RC_STRAIGHT_CYLINDER',
    [],
    { diameterMm: diameter, lengthBasis: length.basis },
  );
}

function calculateSteelSegments(context) {
  const segments = context.shape?.segments || [];
  if (segments.length === 0) {
    return build(context, QuantityStatus.INSUFFICIENT_DATA, {}, 'PILE_S_SEGMENT_INTEGRAL', [
      'PILE_S_SEGMENTS_MISSING',
    ]);
  }

  let totalLength = 0;
  let steelVolume = 0;
  let resolvedVolumeSegmentCount = 0;
  let partial = false;
  const warnings = [];
  for (const segment of segments) {
    if (!positiveInteger(segment.id_order)) {
      return build(context, QuantityStatus.INVALID_GEOMETRY, {}, 'PILE_S_SEGMENT_INTEGRAL', [
        'PILE_S_SEGMENT_ORDER_INVALID',
      ]);
    }
    const length = positive(segment.length_pile);
    const t = positive(segment.t);
    if (!length) {
      return build(context, QuantityStatus.INVALID_GEOMETRY, {}, 'PILE_S_SEGMENT_INTEGRAL', [
        'PILE_S_SEGMENT_LENGTH_INVALID',
      ]);
    }
    totalLength += length;

    if (segment.kind === 'STRAIGHT') {
      const D = positive(segment.D);
      const area = D && t ? pipeArea(D, t) : null;
      if (!area) {
        return build(context, QuantityStatus.INVALID_GEOMETRY, {}, 'PILE_S_SEGMENT_INTEGRAL', [
          'PILE_S_STRAIGHT_DIMENSIONS_INVALID',
        ]);
      }
      steelVolume += area * length;
      resolvedVolumeSegmentCount++;
      continue;
    }

    if (segment.kind === 'TAPER') {
      const D1 = positive(segment.D1);
      const D2 = positive(segment.D2);
      if (!D1 || !D2 || !t || D1 <= 2 * t || D2 <= 2 * t) {
        return build(context, QuantityStatus.INVALID_GEOMETRY, {}, 'PILE_S_SEGMENT_INTEGRAL', [
          'PILE_S_TAPER_DIMENSIONS_INVALID',
        ]);
      }
      const outer = frustumVolumeByDiameters(D1, D2, length);
      const inner = frustumVolumeByDiameters(D1 - 2 * t, D2 - 2 * t, length);
      steelVolume += outer - inner;
      resolvedVolumeSegmentCount++;
      continue;
    }

    if (segment.kind === 'ROTATIONAL') {
      const D = positive(segment.D1);
      const area = D && t ? pipeArea(D, t) : null;
      if (!area) {
        return build(context, QuantityStatus.INVALID_GEOMETRY, {}, 'PILE_S_SEGMENT_INTEGRAL', [
          'PILE_S_ROTATIONAL_SHAFT_DIMENSIONS_INVALID',
        ]);
      }
      steelVolume += area * length;
      resolvedVolumeSegmentCount++;
      partial = true;
      warnings.push('PILE_S_ROTATIONAL_WING_VOLUME_UNRESOLVED');
      continue;
    }

    if (segment.kind === 'PRODUCT') {
      partial = true;
      warnings.push('PILE_S_PRODUCT_GEOMETRY_UNRESOLVED');
      continue;
    }

    return build(context, QuantityStatus.UNSUPPORTED, {}, 'PILE_S_SEGMENT_INTEGRAL', [
      `PILE_S_SEGMENT_UNSUPPORTED:${segment.kind || 'UNKNOWN'}`,
    ]);
  }

  if (resolvedVolumeSegmentCount === 0) {
    return build(
      context,
      QuantityStatus.INSUFFICIENT_DATA,
      { lengthMm: totalLength },
      'PILE_S_SEGMENT_INTEGRAL',
      warnings.length ? warnings : ['PILE_S_SEGMENT_VOLUME_UNRESOLVED'],
      { segmentCount: segments.length, resolvedVolumeSegmentCount },
    );
  }

  return build(
    context,
    partial ? QuantityStatus.PARTIAL : QuantityStatus.CALCULATED,
    {
      lengthMm: totalLength,
      grossVolumeMm3: steelVolume,
      netVolumeMm3: steelVolume,
      structuralSteelVolumeMm3: steelVolume,
    },
    'PILE_S_SEGMENT_INTEGRAL',
    warnings,
    { segmentCount: segments.length, resolvedVolumeSegmentCount },
  );
}

export function calculatePileQuantity(context) {
  if (!context?.element || context.elementType !== 'StbPile') {
    throw new TypeError('StbPile quantity context is required');
  }
  const kind = context.shape?.kind;
  if (kind === 'RC_STRAIGHT') return calculateRcStraight(context);
  if (kind === 'S_SEGMENTS') return calculateSteelSegments(context);
  if (kind === 'MISSING') {
    return build(context, QuantityStatus.INSUFFICIENT_DATA, {}, 'PILE_SECTION_UNRESOLVED', [
      'PILE_SECTION_OR_SHAPE_MISSING',
    ]);
  }
  if (['RC_EXTENDED_FOOT', 'RC_EXTENDED_TOP', 'RC_EXTENDED_TOP_FOOT'].includes(kind)) {
    return calculateRcExtended(context);
  }
  if (kind === 'PRODUCT_SECTION') {
    return build(context, QuantityStatus.INSUFFICIENT_DATA, {}, 'PILE_PRODUCT_UNRESOLVED', [
      'PILE_PRODUCT_GEOMETRY_UNRESOLVED',
    ]);
  }
  return build(context, QuantityStatus.UNSUPPORTED, {}, 'PILE_SHAPE_UNSUPPORTED', [
    `PILE_SHAPE_UNSUPPORTED:${kind || 'UNKNOWN'}`,
  ]);
}
