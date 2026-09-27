/**
 * @fileoverview Issue #310 Phase 6a-D1a:
 * §11-2 wall junction supplemental rebar minimum-diameter hard gate。
 *
 * 2023.04.01 RC配筋標準図 §11-2:
 * - 縦補強筋 D13以上かつ壁縦筋最大径以上
 * - 横補強筋 D13以上かつ壁横筋最大径以上
 *
 * geometry / L1 / L2 disposition は扱わず、径条件だけを pure gate として分離する。
 */

const MIN_SUPPLEMENTAL_DIA_MM = 13;
const DEFAULT_TOLERANCE_MM = 1e-9;

function finitePositive(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function requiredDia(maxWallDiaMm) {
  const maxWall = finitePositive(maxWallDiaMm);
  return maxWall === null ? null : Math.max(MIN_SUPPLEMENTAL_DIA_MM, maxWall);
}

function result(values) {
  return Object.freeze({
    ruleId: 'WALL-JUNCTION-SUPPLEMENTAL-MIN-DIA',
    ...values,
  });
}

function evaluateDirection(direction, actualDiaMm, maxWallDiaMm, toleranceMm) {
  const actual = finitePositive(actualDiaMm);
  const required = requiredDia(maxWallDiaMm);
  const lower = direction.toLowerCase();
  if (actual === null || required === null) {
    return Object.freeze({
      direction,
      status: 'UNRESOLVED',
      actualDiaMm: actual,
      maxWallDiaMm: finitePositive(maxWallDiaMm),
      requiredDiaMm: required,
      reason: 'wall-junction-' + lower + '-supplemental-dia-unresolved',
    });
  }
  if (actual + toleranceMm < required) {
    return Object.freeze({
      direction,
      status: 'REJECTED',
      actualDiaMm: actual,
      maxWallDiaMm: finitePositive(maxWallDiaMm),
      requiredDiaMm: required,
      reason: 'wall-junction-' + lower + '-supplemental-dia-insufficient',
    });
  }
  return Object.freeze({
    direction,
    status: 'PASS',
    actualDiaMm: actual,
    maxWallDiaMm: finitePositive(maxWallDiaMm),
    requiredDiaMm: required,
    reason: null,
  });
}

/**
 * @param {{
 *  verticalDiaMm?:number,
 *  maxWallVerticalDiaMm?:number,
 *  horizontalDiaMm?:number,
 *  maxWallHorizontalDiaMm?:number
 * }} facts
 */
export function evaluateWallJunctionSupplementalBarGate(
  facts,
  { toleranceMm = DEFAULT_TOLERANCE_MM } = {},
) {
  const tolerance = Number(toleranceMm);
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError('wall junction supplemental toleranceMm must be non-negative');
  }

  const vertical = evaluateDirection(
    'VERTICAL',
    facts?.verticalDiaMm,
    facts?.maxWallVerticalDiaMm,
    tolerance,
  );
  const horizontal = evaluateDirection(
    'HORIZONTAL',
    facts?.horizontalDiaMm,
    facts?.maxWallHorizontalDiaMm,
    tolerance,
  );

  const directions = Object.freeze({ vertical, horizontal });
  const unresolved = [vertical, horizontal].filter((item) => item.status === 'UNRESOLVED');
  if (unresolved.length) {
    return result({
      status: 'UNRESOLVED',
      allowed: null,
      reason: 'wall-junction-supplemental-dia-unresolved',
      directions,
    });
  }

  const rejected = [vertical, horizontal].filter((item) => item.status === 'REJECTED');
  if (rejected.length) {
    return result({
      status: 'REJECTED',
      allowed: false,
      reason: 'wall-junction-supplemental-dia-insufficient',
      directions,
    });
  }

  return result({
    status: 'PASS',
    allowed: true,
    reason: null,
    directions,
  });
}

export const __testOnly = Object.freeze({
  MIN_SUPPLEMENTAL_DIA_MM,
  requiredDia,
});
