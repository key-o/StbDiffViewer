/**
 * @fileoverview Three.js 非依存の3次元パネル計測。
 */

function finiteCoordinate(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`);
  return number;
}

function normalizePoint(point, index) {
  return {
    x: finiteCoordinate(point?.x ?? point?.X, `point[${index}].x`),
    y: finiteCoordinate(point?.y ?? point?.Y, `point[${index}].y`),
    z: finiteCoordinate(point?.z ?? point?.Z, `point[${index}].z`),
  };
}

export function distance3d(start, end) {
  const a = normalizePoint(start, 0);
  const b = normalizePoint(end, 1);
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

/**
 * Newell法で平面polygonの実面積を求め、同時に非平面を検出する。
 * @param {Array<{x:number,y:number,z:number}>} points
 * @param {Object} [options]
 * @returns {{areaMm2:number, planar:boolean, maxPlaneDeviationMm:number}}
 */
export function measurePlanarPolygon3d(points, { planarToleranceMm = null } = {}) {
  if (!Array.isArray(points) || points.length < 3) {
    throw new TypeError('panel polygon requires at least 3 points');
  }
  const p = points.map(normalizePoint);

  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < p.length; i++) {
    const current = p[i];
    const next = p[(i + 1) % p.length];
    nx += (current.y - next.y) * (current.z + next.z);
    ny += (current.z - next.z) * (current.x + next.x);
    nz += (current.x - next.x) * (current.y + next.y);
  }

  const normalMagnitude = Math.hypot(nx, ny, nz);
  const areaMm2 = normalMagnitude / 2;
  if (!Number.isFinite(areaMm2) || areaMm2 <= 0) {
    throw new RangeError('panel polygon area must be positive');
  }

  const ux = nx / normalMagnitude;
  const uy = ny / normalMagnitude;
  const uz = nz / normalMagnitude;
  const origin = p[0];
  let maxPlaneDeviationMm = 0;
  let spanMm = 0;
  for (const point of p) {
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    const dz = point.z - origin.z;
    maxPlaneDeviationMm = Math.max(maxPlaneDeviationMm, Math.abs(dx * ux + dy * uy + dz * uz));
    spanMm = Math.max(spanMm, Math.hypot(dx, dy, dz));
  }
  const tolerance = planarToleranceMm ?? Math.max(1e-6, spanMm * 1e-9);

  return {
    areaMm2,
    planar: maxPlaneDeviationMm <= tolerance,
    maxPlaneDeviationMm,
  };
}
