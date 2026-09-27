/**
 * @fileoverview RC 3D配筋の中心線を表す RebarPath 最小カーネル
 *
 * 配筋ルール判定とThree.js geometry生成を分離し、Line / Arcを同じ中心線モデルで扱う。
 * 座標は任意の3D直交座標系でよく、梁・柱では通常ローカル(u, v, axial)を(x, y, z)へ対応させる。
 *
 * @module data/extractors/rebar3d/rebarPath
 */

const EPS = 1e-9;
const TAU = Math.PI * 2;

function number(value) {
  return Number(value);
}

function vec3(value) {
  return {
    x: number(value?.x),
    y: number(value?.y),
    z: number(value?.z),
  };
}

function isFiniteVec3(value) {
  return [value?.x, value?.y, value?.z].every(Number.isFinite);
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale(v, factor) {
  return { x: v.x * factor, y: v.y * factor, z: v.z * factor };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function magnitude(v) {
  return Math.hypot(v.x, v.y, v.z);
}

function normalize(v) {
  const length = magnitude(v);
  if (!(length > EPS)) return null;
  return scale(v, 1 / length);
}

function distance(a, b) {
  return magnitude(subtract(a, b));
}

function almostEqualVec3(a, b, tolerance = 1e-6) {
  return distance(a, b) <= tolerance;
}

function rotateAroundAxis(vector, axis, angle) {
  const n = normalize(axis);
  if (!n) return { x: NaN, y: NaN, z: NaN };
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return add(
    add(scale(vector, cos), scale(cross(n, vector), sin)),
    scale(n, dot(n, vector) * (1 - cos)),
  );
}

/** Line primitiveを作る。 */
export function createLine(start, end) {
  return { type: 'line', start: vec3(start), end: vec3(end) };
}

/** Arc primitiveを作る。 */
export function createArc({ center, radius, planeNormal, startDirection, sweepAngleRad }) {
  return {
    type: 'arc',
    center: vec3(center),
    radius: number(radius),
    planeNormal: vec3(planeNormal),
    startDirection: vec3(startDirection),
    sweepAngleRad: number(sweepAngleRad),
  };
}

/** RebarPathを作る。 */
export function createRebarPath(primitives, metadata = {}) {
  return {
    primitives: Array.isArray(primitives) ? primitives.map((primitive) => ({ ...primitive })) : [],
    metadata: { ...metadata },
  };
}

function arcBasis(arc) {
  const normal = normalize(arc.planeNormal);
  const rawStart = normalize(arc.startDirection);
  if (!normal || !rawStart) return null;
  const inPlane = subtract(rawStart, scale(normal, dot(rawStart, normal)));
  const start = normalize(inPlane);
  if (!start) return null;
  const tangent = normalize(cross(normal, start));
  if (!tangent) return null;
  return { normal, start, tangent };
}

/** primitive始点を返す。 */
export function getPrimitiveStart(primitive) {
  if (primitive?.type === 'line') return vec3(primitive.start);
  if (primitive?.type === 'arc') {
    const basis = arcBasis(primitive);
    if (!basis) return { x: NaN, y: NaN, z: NaN };
    return add(vec3(primitive.center), scale(basis.start, primitive.radius));
  }
  return { x: NaN, y: NaN, z: NaN };
}

/** primitive終点を返す。 */
export function getPrimitiveEnd(primitive) {
  if (primitive?.type === 'line') return vec3(primitive.end);
  if (primitive?.type === 'arc') {
    const basis = arcBasis(primitive);
    if (!basis) return { x: NaN, y: NaN, z: NaN };
    const direction = rotateAroundAxis(basis.start, basis.normal, primitive.sweepAngleRad);
    return add(vec3(primitive.center), scale(direction, primitive.radius));
  }
  return { x: NaN, y: NaN, z: NaN };
}

export function getPathStart(path) {
  const first = path?.primitives?.[0];
  return first ? getPrimitiveStart(first) : null;
}

export function getPathEnd(path) {
  const primitives = path?.primitives || [];
  const last = primitives[primitives.length - 1];
  return last ? getPrimitiveEnd(last) : null;
}

/** 中心線実長を返す。 */
export function getCenterlineLength(path) {
  let length = 0;
  for (const primitive of path?.primitives || []) {
    if (primitive.type === 'line') {
      length += distance(vec3(primitive.start), vec3(primitive.end));
    } else if (primitive.type === 'arc') {
      length += Math.abs(number(primitive.radius) * number(primitive.sweepAngleRad));
    }
  }
  return length;
}

/**
 * path始終点間の指定方向投影長を返す。
 * 定着投影長のように「始点から終点までの差」を評価する用途向け。
 */
export function getProjectedLength(path, direction) {
  const start = getPathStart(path);
  const end = getPathEnd(path);
  const axis = normalize(vec3(direction));
  if (!start || !end || !axis) return NaN;
  return Math.abs(dot(subtract(end, start), axis));
}

function normalizeAnglePositive(angle) {
  const value = angle % TAU;
  return value < 0 ? value + TAU : value;
}

function angleOnSweep(angle, sweep) {
  if (Math.abs(sweep) >= TAU - EPS) return true;
  if (sweep >= 0) return normalizeAnglePositive(angle) <= sweep + EPS;
  return normalizeAnglePositive(-angle) <= -sweep + EPS;
}

function primitiveProjectionCandidates(primitive, axis) {
  if (primitive.type === 'line') {
    return [dot(vec3(primitive.start), axis), dot(vec3(primitive.end), axis)];
  }
  if (primitive.type !== 'arc') return [];

  const basis = arcBasis(primitive);
  if (!basis) return [];
  const centerProjection = dot(vec3(primitive.center), axis);
  const a = dot(basis.start, axis);
  const b = dot(basis.tangent, axis);
  const evaluate = (angle) =>
    centerProjection + primitive.radius * (a * Math.cos(angle) + b * Math.sin(angle));

  const angles = [0, primitive.sweepAngleRad];
  const critical = Math.atan2(b, a);
  for (const candidate of [
    critical,
    critical + Math.PI,
    critical - Math.PI,
    critical + TAU,
    critical - TAU,
  ]) {
    if (angleOnSweep(candidate, primitive.sweepAngleRad)) angles.push(candidate);
  }
  return angles.map(evaluate);
}

/**
 * path全体が指定方向に占める幾何学的投影範囲(max-min)を返す。
 * 始終点差とは別APIとし、180°Arc等で投影幅を失わない。
 */
export function getProjectedExtent(path, direction) {
  const axis = normalize(vec3(direction));
  if (!axis) return NaN;
  const values = (path?.primitives || []).flatMap((primitive) =>
    primitiveProjectionCandidates(primitive, axis),
  );
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) return NaN;
  return Math.max(...values) - Math.min(...values);
}

/**
 * Arcを表示adapter用のLine chordへ分割する。
 * 配筋ルールや曲げ半径判定は行わない。
 */
export function rebarPathToLineSegments(path, options = {}) {
  const maxArcAngleRad = Number(options.maxArcAngleRad) || Math.PI / 18;
  const result = [];
  for (const primitive of path?.primitives || []) {
    if (primitive.type === 'line') {
      result.push(createLine(primitive.start, primitive.end));
      continue;
    }
    if (primitive.type !== 'arc') continue;
    const basis = arcBasis(primitive);
    if (!basis) continue;
    const steps = Math.max(1, Math.ceil(Math.abs(primitive.sweepAngleRad) / maxArcAngleRad));
    let previous = getPrimitiveStart(primitive);
    for (let index = 1; index <= steps; index += 1) {
      const angle = (primitive.sweepAngleRad * index) / steps;
      const direction = rotateAroundAxis(basis.start, basis.normal, angle);
      const next = add(vec3(primitive.center), scale(direction, primitive.radius));
      result.push(createLine(previous, next));
      previous = next;
    }
  }
  return result;
}

/**
 * RebarPathの構造・数値・primitive連続性を検証する。
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateRebarPath(path, options = {}) {
  const tolerance = Number(options.continuityToleranceMm) || 1e-6;
  const errors = [];
  const primitives = path?.primitives;
  if (!Array.isArray(primitives) || primitives.length === 0) {
    errors.push('empty-primitives');
    return { ok: false, errors };
  }

  for (const [index, primitive] of primitives.entries()) {
    const prefix = `primitive-${index}`;
    if (primitive?.type === 'line') {
      if (!isFiniteVec3(primitive.start) || !isFiniteVec3(primitive.end)) {
        errors.push(`${prefix}:non-finite-line`);
      } else if (distance(primitive.start, primitive.end) <= EPS) {
        errors.push(`${prefix}:zero-length-line`);
      }
    } else if (primitive?.type === 'arc') {
      if (
        !isFiniteVec3(primitive.center) ||
        !isFiniteVec3(primitive.planeNormal) ||
        !isFiniteVec3(primitive.startDirection) ||
        !Number.isFinite(primitive.radius) ||
        !Number.isFinite(primitive.sweepAngleRad)
      ) {
        errors.push(`${prefix}:non-finite-arc`);
      } else {
        if (!(primitive.radius > EPS)) errors.push(`${prefix}:invalid-radius`);
        if (Math.abs(primitive.sweepAngleRad) <= EPS) errors.push(`${prefix}:zero-sweep`);
        if (!(magnitude(primitive.planeNormal) > EPS))
          errors.push(`${prefix}:invalid-plane-normal`);
        const basis = arcBasis(primitive);
        if (!basis) errors.push(`${prefix}:invalid-start-direction`);
      }
    } else {
      errors.push(`${prefix}:unknown-type`);
    }

    if (index > 0) {
      const previousEnd = getPrimitiveEnd(primitives[index - 1]);
      const currentStart = getPrimitiveStart(primitive);
      if (
        !isFiniteVec3(previousEnd) ||
        !isFiniteVec3(currentStart) ||
        !almostEqualVec3(previousEnd, currentStart, tolerance)
      ) {
        errors.push(`${prefix}:discontinuous`);
      }
    }
  }

  const dia = number(path?.metadata?.dia);
  const hasDiaName =
    typeof path?.metadata?.diaName === 'string' && path.metadata.diaName.length > 0;
  if (!(dia > 0) && !hasDiaName) errors.push('metadata:missing-dia');
  return { ok: errors.length === 0, errors };
}
