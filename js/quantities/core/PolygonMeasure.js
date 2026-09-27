/**
 * @fileoverview Three.js 非依存の2次元 polygon 面積計算。
 */

function normalizeVertices(vertices) {
  if (!Array.isArray(vertices) || vertices.length < 3) {
    throw new TypeError('polygon requires at least 3 vertices');
  }

  const normalized = vertices.map((vertex, index) => {
    const x = Number(vertex?.x);
    const y = Number(vertex?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new TypeError(`polygon vertex ${index} must have finite x/y coordinates`);
    }
    return { x, y };
  });

  // ProfileCalculator の円形等は始終点を重複して閉じる場合がある。
  if (normalized.length >= 4) {
    const first = normalized[0];
    const last = normalized[normalized.length - 1];
    if (first.x === last.x && first.y === last.y) {
      normalized.pop();
    }
  }

  if (normalized.length < 3) {
    throw new TypeError('polygon requires at least 3 distinct vertices');
  }

  return normalized;
}

/**
 * Shoelace formula による符号付き面積。
 * 頂点順が反転すると符号も反転する。
 *
 * @param {Array<{x:number,y:number}>} vertices
 * @returns {number}
 */
export function signedPolygonArea(vertices) {
  const points = normalizeVertices(vertices);
  let twiceArea = 0;

  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }

  return twiceArea / 2;
}

/**
 * @param {Array<{x:number,y:number}>} vertices
 * @returns {number}
 */
export function polygonArea(vertices) {
  return Math.abs(signedPolygonArea(vertices));
}

/**
 * 外周 - 穴で profile 面積を求める。
 *
 * @param {Object} profile
 * @param {Array<{x:number,y:number}>} profile.vertices
 * @param {Array<Array<{x:number,y:number}>>} [profile.holes]
 * @returns {number}
 */
export function profileArea(profile) {
  if (!profile || !Array.isArray(profile.vertices)) {
    throw new TypeError('profile.vertices is required');
  }

  const outerArea = polygonArea(profile.vertices);
  const holeArea = (profile.holes || []).reduce((sum, hole) => sum + polygonArea(hole), 0);
  const netArea = outerArea - holeArea;

  if (!Number.isFinite(netArea) || netArea <= 0) {
    throw new RangeError(`profile area must be positive (outer=${outerArea}, holes=${holeArea})`);
  }

  return netArea;
}
