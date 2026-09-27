/**
 * @fileoverview 壁開口を構造平面図DXFの独立Openレイヤへ変換する。
 */

import * as THREE from 'three';
import { resolveStoryPlanCutZ } from './DxfPlanCut.js';

const DEFAULT_TOLERANCE = 0.1;

function openingProfilePoints(opening) {
  const x = Number(opening?.positionX) || 0;
  const z = Number(opening?.positionY) || 0;
  const width = Number(opening?.width) || 0;
  const height = Number(opening?.height) || 0;
  const angle = THREE.MathUtils.degToRad(Number(opening?.rotate) || 0);

  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const ux = new THREE.Vector2(cos, sin);
  const uz = new THREE.Vector2(-sin, cos);

  const p0 = new THREE.Vector2(x, z);
  const p1 = p0.clone().addScaledVector(ux, width);
  const p2 = p1.clone().addScaledVector(uz, height);
  const p3 = p0.clone().addScaledVector(uz, height);
  return [p0, p1, p2, p3];
}

function uniqueNumbers(values, tolerance) {
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
 * 壁ローカル開口矩形とローカル水平線Z=localZの交差X範囲を返す。
 * rotate付き開口にも対応する。
 * @param {Object} opening
 * @param {number} localZ
 * @param {number} [tolerance=0.1]
 * @returns {{minX:number,maxX:number}|null}
 */
export function intersectOpeningAtLocalZ(opening, localZ, tolerance = DEFAULT_TOLERANCE) {
  const points = openingProfilePoints(opening);
  const xs = [];

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const da = a.y - localZ;
    const db = b.y - localZ;
    const aOn = Math.abs(da) <= tolerance;
    const bOn = Math.abs(db) <= tolerance;

    if (aOn && bOn) {
      xs.push(a.x, b.x);
      continue;
    }
    if (aOn) {
      xs.push(a.x);
      continue;
    }
    if (bOn) {
      xs.push(b.x);
      continue;
    }
    if ((da < -tolerance && db > tolerance) || (da > tolerance && db < -tolerance)) {
      const t = (localZ - a.y) / (b.y - a.y);
      xs.push(a.x + (b.x - a.x) * t);
    }
  }

  const unique = uniqueNumbers(xs, tolerance);
  if (unique.length < 2) return null;
  return { minX: unique[0], maxX: unique[unique.length - 1] };
}

/**
 * 表示中Wall Meshの開口をOpenレイヤ用閉ポリラインへ変換する。
 * @param {THREE.Group|Object|null} wallGroup
 * @param {Object|null} clippingState
 * @param {Object} [options]
 * @param {number} [options.planCutOffset=1500]
 * @param {number} [options.tolerance=0.1]
 * @returns {Array<{points:Array<THREE.Vector3>,layer:string,closed:boolean,openingId:string,wallId:string}>}
 */
export function collectWallOpeningPolylines(wallGroup, clippingState, options = {}) {
  if (!wallGroup?.traverse || clippingState?.type !== 'story') return [];

  const planCutOffset = options.planCutOffset ?? 1500;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const polylines = [];
  const seen = new Set();

  wallGroup.traverse((mesh) => {
    if (!mesh?.isMesh || !mesh.visible) return;
    const wallData = mesh.userData?.wallData;
    if (!wallData?.openings?.length || !wallData.firstReferencePoint) return;

    mesh.updateWorldMatrix(true, false);
    const box = new THREE.Box3().setFromObject(mesh);
    const cutZ = resolveStoryPlanCutZ('Wall', box, clippingState, planCutOffset, tolerance);
    if (cutZ == null) return;

    const origin = wallData.firstReferencePoint;
    const direction = new THREE.Vector3(
      Number(wallData.direction?.x) || 0,
      Number(wallData.direction?.y) || 0,
      0,
    ).normalize();
    const normal = new THREE.Vector3(
      Number(wallData.normal?.x) || -direction.y,
      Number(wallData.normal?.y) || direction.x,
      0,
    ).normalize();
    const thickness = Number(wallData.thickness) || 0;
    const halfT = thickness / 2;
    const localZ = cutZ - Number(origin.z || 0);

    for (const opening of wallData.openings) {
      const openingId = String(opening?.id ?? '');
      const wallId = String(mesh.userData?.elementId ?? mesh.userData?.stbElementId ?? '');
      const key = `${wallId}:${openingId}`;
      if (seen.has(key)) continue;

      const span = intersectOpeningAtLocalZ(opening, localZ, tolerance);
      if (!span || span.maxX - span.minX <= tolerance) continue;

      const pointAt = (localX, normalOffset) =>
        new THREE.Vector3(Number(origin.x || 0), Number(origin.y || 0), cutZ)
          .addScaledVector(direction, localX)
          .addScaledVector(normal, normalOffset);

      polylines.push({
        points: [
          pointAt(span.minX, -halfT),
          pointAt(span.maxX, -halfT),
          pointAt(span.maxX, halfT),
          pointAt(span.minX, halfT),
        ],
        layer: 'Open',
        closed: true,
        openingId,
        wallId,
      });
      seen.add(key);
    }
  });

  return polylines;
}

export { openingProfilePoints, DEFAULT_TOLERANCE };
