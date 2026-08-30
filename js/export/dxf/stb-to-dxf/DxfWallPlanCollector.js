/**
 * @fileoverview 構造平面図DXF用の壁外形断面
 *
 * 壁Meshの穴（StbOpen）をそのまま断面化すると、開口高さでは1つの壁が
 * 複数の閉ループへ分割される。構造平面図では壁外形と開口を別レイヤで
 * 扱うため、wallData.referenceProfile の外周だけを水平切断する。
 */

import * as THREE from 'three';

const DEFAULT_TOLERANCE = 0.1;

function uniqueSortedNumbers(values, tolerance) {
  const sorted = [...values].sort((a, b) => a - b);
  const result = [];
  for (const value of sorted) {
    if (result.length === 0 || Math.abs(value - result[result.length - 1]) > tolerance) {
      result.push(value);
    }
  }
  return result;
}

/**
 * 壁ローカル輪郭と水平線 Y=localY の交差区間を返す。
 * 単純多角形では交点をX順に並べ、偶数奇数規則で区間化する。
 *
 * @param {Array<{x:number,y:number}>} profile
 * @param {number} localY
 * @param {number} [tolerance=0.1]
 * @returns {Array<{minX:number,maxX:number}>}
 */
export function intersectWallProfileAtLocalY(
  profile,
  localY,
  tolerance = DEFAULT_TOLERANCE,
) {
  if (!Array.isArray(profile) || profile.length < 3) return [];

  const xs = [];
  for (let i = 0; i < profile.length; i++) {
    const a = profile[i];
    const b = profile[(i + 1) % profile.length];
    const ay = Number(a.y);
    const by = Number(b.y);
    const ax = Number(a.x);
    const bx = Number(b.x);
    const da = ay - localY;
    const db = by - localY;
    const aOn = Math.abs(da) <= tolerance;
    const bOn = Math.abs(db) <= tolerance;

    if (aOn && bOn) {
      xs.push(ax, bx);
      continue;
    }
    if (aOn) {
      xs.push(ax);
      continue;
    }
    if (bOn) {
      xs.push(bx);
      continue;
    }
    if ((da < -tolerance && db > tolerance) || (da > tolerance && db < -tolerance)) {
      const t = (localY - ay) / (by - ay);
      xs.push(ax + (bx - ax) * t);
    }
  }

  const unique = uniqueSortedNumbers(xs, tolerance);
  const spans = [];
  for (let i = 0; i + 1 < unique.length; i += 2) {
    if (unique[i + 1] - unique[i] > tolerance) {
      spans.push({ minX: unique[i], maxX: unique[i + 1] });
    }
  }
  return spans;
}

/**
 * Wall Meshの外周だけを指定Zで切断して閉ループを返す。
 * StbOpenのholesは意図的に無視し、開口はOpenレイヤへ分離する。
 *
 * @param {THREE.Mesh} mesh
 * @param {number} z
 * @param {number} [tolerance=0.1]
 * @returns {Array<Array<THREE.Vector3>>|null} 壁メタデータがない場合はnull
 */
export function extractWallOuterSectionLoops(mesh, z, tolerance = DEFAULT_TOLERANCE) {
  const wallData = mesh?.userData?.wallData;
  if (!wallData?.firstReferencePoint || !wallData?.referenceProfile?.length) return null;

  const origin = wallData.firstReferencePoint;
  const direction = new THREE.Vector3(
    Number(wallData.direction?.x) || 0,
    Number(wallData.direction?.y) || 0,
    0,
  );
  if (direction.lengthSq() <= tolerance * tolerance) return [];
  direction.normalize();

  const normal = new THREE.Vector3(
    Number(wallData.normal?.x) || -direction.y,
    Number(wallData.normal?.y) || direction.x,
    0,
  );
  if (normal.lengthSq() <= tolerance * tolerance) return [];
  normal.normalize();

  const thickness = Number(wallData.thickness) || 0;
  if (thickness <= tolerance) return [];

  const localY = z - Number(origin.z || 0);
  const spans = intersectWallProfileAtLocalY(wallData.referenceProfile, localY, tolerance);
  const halfT = thickness / 2;

  const pointAt = (localX, normalOffset) =>
    new THREE.Vector3(Number(origin.x || 0), Number(origin.y || 0), z)
      .addScaledVector(direction, localX)
      .addScaledVector(normal, normalOffset);

  return spans.map((span) => [
    pointAt(span.minX, -halfT),
    pointAt(span.maxX, -halfT),
    pointAt(span.maxX, halfT),
    pointAt(span.minX, halfT),
  ]);
}

export { DEFAULT_TOLERANCE };
