/**
 * @fileoverview RC壁配筋の厚さ方向レイヤリングを補正・検証する。
 *
 * DoubleNet / InsideAndOutside は geometry 層で交差筋の内外順を反映済み。
 * Zigzag は各方向を面ごとに交互配置した後、outer_bar_direction と直交する
 * 鉄筋を外側筋径ぶん壁芯側へ移動して交差筋の重なりを避ける。
 *
 * @module data/extractors/rebar3d/wallRebarLayering
 */

const EPS = 1e-7;

function maxDiameter(bar) {
  const values = (bar?.diametersMm || []).filter((value) => Number.isFinite(value) && value > 0);
  return values.length > 0 ? Math.max(...values) : NaN;
}

function findBar(section, pos) {
  return section?.bars?.find((bar) => bar.pos === pos) || null;
}

function requiredSurfaceDepth(coverMm, bar, direction, outerDirection, outerMaxDiaMm) {
  const diaMm = maxDiameter(bar);
  if (![coverMm, diaMm, outerMaxDiaMm].every(Number.isFinite)) return NaN;
  return coverMm + diaMm / 2 + (direction === outerDirection ? 0 : outerMaxDiaMm);
}

function exceedsHalfThickness(required, halfThickness) {
  return !Number.isFinite(required) || required >= halfThickness - EPS;
}

/**
 * 交差筋を厚さ方向に積層しても壁芯を越えないことを検証する。
 * @returns {string|null} SPECIAL_REQUIRED code or null
 */
export function validateWallRebarLayering(section, typeOutside = null) {
  if (!section || section.pattern === 'SINGLE') return null;
  const thicknessMm = Number(section.shape?.thicknessMm);
  if (!(thicknessMm > 0)) return 'WALL_REBAR_LAYER_GEOMETRY_INVALID';

  const outerDirection = section.outerBarDirection === 'HORIZONTAL' ? 'HORIZONTAL' : 'VERTICAL';
  const halfThickness = thicknessMm / 2;

  if (section.pattern === 'INSIDE_OUTSIDE') {
    for (const side of ['OUTSIDE', 'INSIDE']) {
      const coverMm = side === 'OUTSIDE' ? section.covers?.outsideMm : section.covers?.insideMm;
      const outerBar = findBar(section, `${outerDirection}_${side}`);
      const outerMaxDiaMm = maxDiameter(outerBar);
      if (!Number.isFinite(coverMm) || !Number.isFinite(outerMaxDiaMm)) {
        return 'WALL_REBAR_LAYER_GEOMETRY_INVALID';
      }
      for (const direction of ['VERTICAL', 'HORIZONTAL']) {
        const bar = findBar(section, `${direction}_${side}`);
        const required = requiredSurfaceDepth(
          coverMm,
          bar,
          direction,
          outerDirection,
          outerMaxDiaMm,
        );
        if (exceedsHalfThickness(required, halfThickness)) {
          return 'WALL_REBAR_THICKNESS_LAYER_CONFLICT';
        }
      }
    }
    return null;
  }

  const outerBar = findBar(section, outerDirection);
  const outerMaxDiaMm = maxDiameter(outerBar);
  if (!Number.isFinite(outerMaxDiaMm)) return 'WALL_REBAR_LAYER_GEOMETRY_INVALID';

  const covers = ['TYPE_PLUS', 'TYPE_MINUS'].includes(typeOutside)
    ? [section.covers?.outsideMm, section.covers?.insideMm]
    : [section.covers?.outsideMm];

  for (const coverMm of covers) {
    if (!Number.isFinite(coverMm)) return 'WALL_REBAR_LAYER_GEOMETRY_INVALID';
    for (const direction of ['VERTICAL', 'HORIZONTAL']) {
      const required = requiredSurfaceDepth(
        coverMm,
        findBar(section, direction),
        direction,
        outerDirection,
        outerMaxDiaMm,
      );
      if (exceedsHalfThickness(required, halfThickness)) {
        return 'WALL_REBAR_THICKNESS_LAYER_CONFLICT';
      }
    }
  }
  return null;
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale(v, factor) {
  return { x: v.x * factor, y: v.y * factor, z: v.z * factor };
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function translatePrimitive(primitive, offset) {
  if (primitive?.type !== 'line') return { ...primitive };
  return {
    ...primitive,
    start: add(primitive.start, offset),
    end: add(primitive.end, offset),
  };
}

/**
 * Zigzag の内側方向筋だけを外側方向筋の最大径ぶん壁芯側へ移動する。
 * 入力 path は変更せず、新しい path 配列を返す。
 */
export function applyWallRebarLayering(paths, { frame, section } = {}) {
  if (!Array.isArray(paths) || section?.pattern !== 'ZIGZAG' || !frame?.zAxis || !frame?.origin) {
    return paths;
  }

  const outerDirection = section.outerBarDirection === 'HORIZONTAL' ? 'HORIZONTAL' : 'VERTICAL';
  const outerMaxDiaMm = maxDiameter(findBar(section, outerDirection));
  if (!(outerMaxDiaMm > 0)) return paths;

  return paths.map((path) => {
    if (path?.metadata?.role !== 'wallMain' || path.metadata.direction === outerDirection) {
      return path;
    }
    const start = path.primitives?.find((primitive) => primitive?.type === 'line')?.start;
    if (!start) return path;
    const localDepth = dot(sub(start, frame.origin), frame.zAxis);
    if (Math.abs(localDepth) <= EPS) return path;
    const sign = localDepth > 0 ? 1 : -1;
    const offset = scale(frame.zAxis, -sign * outerMaxDiaMm);
    return {
      ...path,
      primitives: (path.primitives || []).map((primitive) => translatePrimitive(primitive, offset)),
    };
  });
}

export const __testOnly = { maxDiameter, requiredSurfaceDepth };
