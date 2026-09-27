/**
 * @fileoverview ST-Bridge 断面寸法から断面積を算出する Three.js 非依存コア。
 *
 * Q0 対象: RECTANGLE / CIRCLE / H / BOX / PIPE / T / C / L
 */

import { QuantityStatus } from './QuantityStatus.js';

const CALCULATOR_VERSION = 1;
const RADIUS_APPROX_WARNING =
  'STBの丸み半径を持つ断面ですが、Q0では直線板要素による断面積を使用しています。';

const TYPE_ALIASES = new Map([
  ['RECT', 'RECTANGLE'],
  ['RECTANGULAR', 'RECTANGLE'],
  ['STBSECCOLUMNRECT', 'RECTANGLE'],
  ['CIRCULAR', 'CIRCLE'],
  ['STBSECCOLUMNCIRCLE', 'CIRCLE'],
  ['H-SHAPE', 'H'],
  ['H_SHAPE', 'H'],
  ['ROLL-H', 'H'],
  ['BUILD-H', 'H'],
  ['STBSECROLL-H', 'H'],
  ['STBSECBUILD-H', 'H'],
  ['RECTANGULAR_HOLLOW', 'BOX'],
  ['STBSECROLL-BOX', 'BOX'],
  ['STBSECBUILD-BOX', 'BOX'],
  ['CIRCULAR_HOLLOW', 'PIPE'],
  ['STBSECPIPE', 'PIPE'],
  ['T-SHAPE', 'T'],
  ['STBSECROLL-T', 'T'],
  ['STBSECBUILD-T', 'T'],
  ['CHANNEL', 'C'],
  ['STBSECROLL-C', 'C'],
  ['ANGLE', 'L'],
  ['STBSECROLL-L', 'L'],
]);

function normalizeType(sectionType) {
  if (sectionType === null || sectionType === undefined) return '';
  const normalized = String(sectionType).trim().toUpperCase();
  return TYPE_ALIASES.get(normalized) || normalized;
}

function firstDefined(params, keys) {
  for (const key of keys) {
    const value = params?.[key];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return undefined;
}

function positiveNumber(params, keys, label) {
  const raw = firstDefined(params, keys);
  if (raw === undefined) {
    return { ok: false, missing: true, label };
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, missing: false, label, value };
  }
  return { ok: true, value };
}

function optionalNonNegativeNumber(params, keys) {
  const raw = firstDefined(params, keys);
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return Number.NaN;
  return value;
}

function missingResult(type, fields) {
  return {
    status: QuantityStatus.INSUFFICIENT_DATA,
    areaMm2: null,
    method: null,
    calculatorVersion: CALCULATOR_VERSION,
    sectionType: type,
    warnings: [`断面積計算に必要な寸法が不足しています: ${fields.join(', ')}`],
  };
}

function invalidResult(type, message) {
  return {
    status: QuantityStatus.INVALID_GEOMETRY,
    areaMm2: null,
    method: null,
    calculatorVersion: CALCULATOR_VERSION,
    sectionType: type,
    warnings: [message],
  };
}

function calculatedResult(type, areaMm2, method, warnings = []) {
  if (!Number.isFinite(areaMm2) || areaMm2 <= 0) {
    return invalidResult(type, `算出断面積が正ではありません: ${areaMm2}`);
  }
  return {
    status: warnings.length ? QuantityStatus.PARTIAL : QuantityStatus.CALCULATED,
    areaMm2,
    method,
    calculatorVersion: CALCULATOR_VERSION,
    sectionType: type,
    warnings,
  };
}

function collectRequired(params, definitions) {
  const values = {};
  const missing = [];
  for (const [name, keys] of Object.entries(definitions)) {
    const result = positiveNumber(params, keys, name);
    if (!result.ok) {
      if (result.missing) missing.push(name);
      else return { invalid: `${name} は正の有限値である必要があります` };
    } else {
      values[name] = result.value;
    }
  }
  return { values, missing };
}

function radiusWarnings(params, keys) {
  let hasPositiveRadius = false;

  for (const key of keys) {
    const value = optionalNonNegativeNumber(params, [key]);
    if (Number.isNaN(value)) {
      return { invalid: `${key} は0以上の有限値である必要があります` };
    }
    if (value !== null && value > 0) {
      hasPositiveRadius = true;
    }
  }

  return { warnings: hasPositiveRadius ? [RADIUS_APPROX_WARNING] : [] };
}

function calculateRectangle(params) {
  const required = collectRequired(params, {
    width: ['width', 'B', 'width_X', 'overallWidth', 'outer_width'],
    height: ['height', 'A', 'width_Y', 'depth', 'overallDepth', 'outer_height'],
  });
  if (required.invalid) return invalidResult('RECTANGLE', required.invalid);
  if (required.missing.length) return missingResult('RECTANGLE', required.missing);
  return calculatedResult(
    'RECTANGLE',
    required.values.width * required.values.height,
    'RECTANGLE_ANALYTIC',
  );
}

function calculateCircle(params) {
  const required = collectRequired(params, {
    diameter: ['diameter', 'D', 'outerDiameter', 'outer_diameter'],
  });
  if (required.invalid) return invalidResult('CIRCLE', required.invalid);
  if (required.missing.length) return missingResult('CIRCLE', required.missing);
  return calculatedResult(
    'CIRCLE',
    (Math.PI * required.values.diameter ** 2) / 4,
    'CIRCLE_ANALYTIC',
  );
}

function calculateH(params) {
  const required = collectRequired(params, {
    depth: ['overallDepth', 'overall_depth', 'A', 'height'],
    width: ['overallWidth', 'overall_width', 'B', 'width'],
    webThickness: ['webThickness', 'web_thickness', 't1'],
    flangeThickness: ['flangeThickness', 'flange_thickness', 't2'],
  });
  if (required.invalid) return invalidResult('H', required.invalid);
  if (required.missing.length) return missingResult('H', required.missing);

  const { depth, width, webThickness, flangeThickness } = required.values;
  if (2 * flangeThickness >= depth || webThickness >= width) {
    return invalidResult('H', 'H形断面の板厚が外形寸法以上です');
  }
  const radius = radiusWarnings(params, ['r', 'radius', 'rootRadius']);
  if (radius.invalid) return invalidResult('H', radius.invalid);
  const area = 2 * width * flangeThickness + (depth - 2 * flangeThickness) * webThickness;
  return calculatedResult('H', area, 'H_SHARP_ANALYTIC', radius.warnings);
}

function calculateBox(params) {
  const required = collectRequired(params, {
    depth: ['height', 'A', 'outer_height', 'overallDepth'],
    width: ['width', 'B', 'outer_width', 'overallWidth'],
  });
  if (required.invalid) return invalidResult('BOX', required.invalid);
  if (required.missing.length) return missingResult('BOX', required.missing);

  const commonThickness = firstDefined(params, [
    'wallThickness',
    'wall_thickness',
    'thickness',
    't',
  ]);
  let thicknessDepth;
  let thicknessWidth;
  if (commonThickness !== undefined) {
    const t = Number(commonThickness);
    if (!Number.isFinite(t) || t <= 0)
      return invalidResult('BOX', 't は正の有限値である必要があります');
    thicknessDepth = t;
    thicknessWidth = t;
  } else {
    const thicknesses = collectRequired(params, {
      thicknessDepth: ['t2', 'thickness_depth'],
      thicknessWidth: ['t1', 'thickness_width'],
    });
    if (thicknesses.invalid) return invalidResult('BOX', thicknesses.invalid);
    if (thicknesses.missing.length) return missingResult('BOX', thicknesses.missing);
    thicknessDepth = thicknesses.values.thicknessDepth;
    thicknessWidth = thicknesses.values.thicknessWidth;
  }

  const { depth, width } = required.values;
  const innerDepth = depth - 2 * thicknessDepth;
  const innerWidth = width - 2 * thicknessWidth;
  if (innerDepth <= 0 || innerWidth <= 0) {
    return invalidResult('BOX', 'BOX断面の板厚により内空寸法が0以下になります');
  }

  const radius = radiusWarnings(params, ['r', 'radius', 'cornerRadius']);
  if (radius.invalid) return invalidResult('BOX', radius.invalid);
  const area = depth * width - innerDepth * innerWidth;
  return calculatedResult('BOX', area, 'BOX_SHARP_ANALYTIC', radius.warnings);
}

function calculatePipe(params) {
  const required = collectRequired(params, {
    diameter: ['outerDiameter', 'outer_diameter', 'diameter', 'D'],
    thickness: ['wallThickness', 'wall_thickness', 'thickness', 't'],
  });
  if (required.invalid) return invalidResult('PIPE', required.invalid);
  if (required.missing.length) return missingResult('PIPE', required.missing);

  const { diameter, thickness } = required.values;
  const innerDiameter = diameter - 2 * thickness;
  if (innerDiameter <= 0) {
    return invalidResult('PIPE', 'PIPE断面の板厚により内径が0以下になります');
  }
  const area = (Math.PI * (diameter ** 2 - innerDiameter ** 2)) / 4;
  return calculatedResult('PIPE', area, 'PIPE_ANALYTIC');
}

function calculateT(params) {
  const required = collectRequired(params, {
    depth: ['overallDepth', 'overall_depth', 'A', 'height'],
    width: ['flangeWidth', 'flange_width', 'B', 'width'],
    webThickness: ['webThickness', 'web_thickness', 't1'],
    flangeThickness: ['flangeThickness', 'flange_thickness', 't2'],
  });
  if (required.invalid) return invalidResult('T', required.invalid);
  if (required.missing.length) return missingResult('T', required.missing);

  const { depth, width, webThickness, flangeThickness } = required.values;
  if (flangeThickness >= depth || webThickness >= width) {
    return invalidResult('T', 'T形断面の板厚が外形寸法以上です');
  }
  const radius = radiusWarnings(params, ['r', 'radius', 'rootRadius']);
  if (radius.invalid) return invalidResult('T', radius.invalid);
  const area = width * flangeThickness + (depth - flangeThickness) * webThickness;
  return calculatedResult('T', area, 'T_SHARP_ANALYTIC', radius.warnings);
}

function calculateChannel(params) {
  const type = String(firstDefined(params, ['type']) || 'SINGLE').toUpperCase();
  if (!['SINGLE', 'C', 'CHANNEL', ''].includes(type)) {
    return {
      status: QuantityStatus.UNSUPPORTED,
      areaMm2: null,
      method: null,
      calculatorVersion: CALCULATOR_VERSION,
      sectionType: 'C',
      warnings: [`Q0では溝形鋼の複数丁配置 type=${type} を扱いません`],
    };
  }

  const required = collectRequired(params, {
    depth: ['overallDepth', 'overall_depth', 'A', 'height'],
    flangeWidth: ['flangeWidth', 'flange_width', 'B', 'width'],
    webThickness: ['webThickness', 'web_thickness', 't1'],
    flangeThickness: ['flangeThickness', 'flange_thickness', 't2'],
  });
  if (required.invalid) return invalidResult('C', required.invalid);
  if (required.missing.length) return missingResult('C', required.missing);

  const { depth, flangeWidth, webThickness, flangeThickness } = required.values;
  if (2 * flangeThickness >= depth || webThickness >= flangeWidth) {
    return invalidResult('C', '溝形鋼の板厚が外形寸法以上です');
  }
  const radius = radiusWarnings(params, ['r', 'r1', 'r2', 'radius']);
  if (radius.invalid) return invalidResult('C', radius.invalid);
  const area = depth * webThickness + 2 * (flangeWidth - webThickness) * flangeThickness;
  return calculatedResult('C', area, 'CHANNEL_SHARP_ANALYTIC', radius.warnings);
}

function calculateAngle(params) {
  const type = String(firstDefined(params, ['type']) || 'SINGLE').toUpperCase();
  if (!['SINGLE', 'L', 'ANGLE', ''].includes(type)) {
    return {
      status: QuantityStatus.UNSUPPORTED,
      areaMm2: null,
      method: null,
      calculatorVersion: CALCULATOR_VERSION,
      sectionType: 'L',
      warnings: [`Q0では山形鋼の複数丁配置 type=${type} を扱いません`],
    };
  }

  const required = collectRequired(params, {
    depth: ['depth', 'A', 'height', 'leg1'],
    width: ['width', 'B', 'leg2'],
    thicknessDepth: ['t1', 'thicknessDepth', 'thickness_depth', 'thickness', 't'],
    thicknessWidth: ['t2', 'thicknessWidth', 'thickness_width', 'thickness', 't'],
  });
  if (required.invalid) return invalidResult('L', required.invalid);
  if (required.missing.length) return missingResult('L', required.missing);

  const { depth, width, thicknessDepth, thicknessWidth } = required.values;
  if (thicknessDepth >= width || thicknessWidth >= depth) {
    return invalidResult('L', '山形鋼の板厚が外形寸法以上です');
  }
  const radius = radiusWarnings(params, ['r', 'r1', 'r2', 'radius']);
  if (radius.invalid) return invalidResult('L', radius.invalid);
  const area = depth * thicknessDepth + width * thicknessWidth - thicknessDepth * thicknessWidth;
  return calculatedResult('L', area, 'ANGLE_SHARP_ANALYTIC', radius.warnings);
}

const CALCULATORS = {
  RECTANGLE: calculateRectangle,
  CIRCLE: calculateCircle,
  H: calculateH,
  BOX: calculateBox,
  PIPE: calculatePipe,
  T: calculateT,
  C: calculateChannel,
  L: calculateAngle,
};

/**
 * @param {string} sectionType
 * @param {Object} params
 * @returns {{status:string, areaMm2:number|null, method:string|null, calculatorVersion:number, sectionType:string, warnings:string[]}}
 */
export function calculateSectionArea(sectionType, params = {}) {
  const type = normalizeType(sectionType);
  const calculator = CALCULATORS[type];
  if (!calculator) {
    return {
      status: QuantityStatus.UNSUPPORTED,
      areaMm2: null,
      method: null,
      calculatorVersion: CALCULATOR_VERSION,
      sectionType: type || String(sectionType || ''),
      warnings: [`未対応の断面タイプです: ${sectionType}`],
    };
  }
  return calculator(params || {});
}

export { CALCULATOR_VERSION as SECTION_AREA_CALCULATOR_VERSION };
