/**
 * @fileoverview Certify a very restricted world-space solid for exact box union.
 *
 * An AABB alone is NEVER a solid. The source must be a single closed,
 * outward-wound, axis-aligned cuboid represented by exactly two triangles on
 * each of six rectangular faces. Complex, rotated, open and composite meshes
 * fail closed rather than contributing a guessed volume.
 */

import * as THREE from 'three';

const MATERIALS = new Set(['CONCRETE', 'STEEL']);
const AXES = ['x', 'y', 'z'];
const EPS_MM = 1e-6;
const MAX_COORD_MM = 1e9;
const CORNERS = [0, 1];
const issuedCertificates = new WeakSet();

function failure(reason) {
  return { certified: false, reason };
}

function cubeCorner(point, min, max) {
  let code = 0;
  for (const [i, axis] of AXES.entries()) {
    const lo = Math.abs(point[axis] - min[axis]) <= EPS_MM;
    const hi = Math.abs(point[axis] - max[axis]) <= EPS_MM;
    if (!lo && !hi) return -1;
    if (hi) code |= 1 << i;
  }
  return code;
}

/**
 * @param {THREE.Mesh} mesh An uninstanced mesh in its current world transform.
 * @param {{elementType:string,elementId:string|number,materialKind:'CONCRETE'|'STEEL'}} identity
 * @returns {object} Either a certified axis-aligned cuboid or a rejection reason.
 */
export function certifyOrthogonalBoxMesh(mesh, { elementType, elementId, materialKind } = {}) {
  if (
    typeof elementType !== 'string' ||
    !elementType.trim() ||
    elementId === null ||
    elementId === undefined ||
    !String(elementId).trim() ||
    !MATERIALS.has(materialKind)
  ) {
    return failure('invalid-identity-or-material');
  }
  if (!mesh?.isMesh || mesh.isInstancedMesh || mesh.isSkinnedMesh) {
    return failure('unsupported-mesh');
  }
  if (
    mesh.userData?.isPoly ||
    mesh.userData?.isLine ||
    mesh.userData?.isOverlayModelB ||
    ['B', 'onlyB'].includes(mesh.userData?.modelSource)
  ) {
    return failure('non-working-solid');
  }
  if (
    (mesh.userData?.elementType !== undefined && mesh.userData.elementType !== elementType) ||
    (mesh.userData?.elementId !== undefined &&
      String(mesh.userData.elementId) !== String(elementId))
  ) {
    return failure('member-identity-mismatch');
  }
  const geometry = mesh.geometry;
  const position = geometry?.getAttribute?.('position');
  const index = geometry?.getIndex?.();
  if (
    !geometry?.isBufferGeometry ||
    !position ||
    position.itemSize !== 3 ||
    (index ? index.count : position.count) !== 36 ||
    geometry.morphAttributes?.position?.length ||
    mesh.morphTargetInfluences?.some((value) => value !== 0) ||
    geometry.drawRange?.start !== 0 ||
    (Number.isFinite(geometry.drawRange?.count) && geometry.drawRange.count < 36)
  ) {
    return failure('not-twelve-triangle-cuboid');
  }
  mesh.updateWorldMatrix(true, false);
  if (!mesh.matrixWorld.elements.every(Number.isFinite) || mesh.matrixWorld.determinant() <= 0) {
    return failure('invalid-world-transform');
  }
  const vertices = [];
  const p = new THREE.Vector3();
  for (let i = 0; i < 36; i++) {
    const vertexIndex = index ? index.getX(i) : i;
    if (!Number.isSafeInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= position.count) {
      return failure('invalid-triangle-index');
    }
    p.fromBufferAttribute(position, vertexIndex).applyMatrix4(mesh.matrixWorld);
    if (!AXES.every((axis) => Number.isFinite(p[axis]) && Math.abs(p[axis]) <= MAX_COORD_MM)) {
      return failure('invalid-world-vertex');
    }
    vertices.push(p.clone());
  }
  const min = Object.fromEntries(
    AXES.map((axis) => [axis, Math.min(...vertices.map((v) => v[axis]))]),
  );
  const max = Object.fromEntries(
    AXES.map((axis) => [axis, Math.max(...vertices.map((v) => v[axis]))]),
  );
  if (!AXES.every((axis) => max[axis] - min[axis] > EPS_MM)) {
    return failure('degenerate-box');
  }
  const cornerCodes = vertices.map((v) => cubeCorner(v, min, max));
  if (cornerCodes.includes(-1) || new Set(cornerCodes).size !== 8) {
    return failure('not-axis-aligned-box-corners');
  }
  const faces = new Map();
  for (let i = 0; i < 36; i += 3) {
    const points = vertices.slice(i, i + 3);
    const codes = cornerCodes.slice(i, i + 3);
    if (new Set(codes).size !== 3) return failure('degenerate-triangle');
    const matches = [];
    for (const axis of AXES) {
      for (const side of CORNERS) {
        const value = side === 0 ? min[axis] : max[axis];
        if (points.every((point) => Math.abs(point[axis] - value) <= EPS_MM)) {
          matches.push({ axis, side });
        }
      }
    }
    if (matches.length !== 1) return failure('triangle-not-on-one-face');
    const { axis, side } = matches[0];
    const normal = new THREE.Vector3()
      .subVectors(points[1], points[0])
      .cross(new THREE.Vector3().subVectors(points[2], points[0]));
    const outward = side === 0 ? -1 : 1;
    if (normal[axis] * outward <= 0) return failure('inward-or-degenerate-face');
    const faceKey = `${axis}:${side}`;
    if (!faces.has(faceKey)) faces.set(faceKey, []);
    faces.get(faceKey).push(codes);
  }
  if (faces.size !== 6) return failure('missing-face');
  for (const triangles of faces.values()) {
    if (triangles.length !== 2) return failure('invalid-face-triangulation');
    const union = new Set([...triangles[0], ...triangles[1]]);
    const common = triangles[0].filter((code) => triangles[1].includes(code));
    // The shared edge must be a face diagonal (opposite rectangle corners).
    // Sharing a boundary edge could leave a hole and overlap both triangles.
    const diagonalBits = common.length === 2 ? common[0] ^ common[1] : 0;
    const isDiagonal = [3, 5, 6].includes(diagonalBits);
    if (union.size !== 4 || common.length !== 2 || !isDiagonal) {
      return failure('invalid-face-triangulation');
    }
  }
  const volumeMm3 = AXES.reduce((v, axis) => v * (max[axis] - min[axis]), 1);
  if (!Number.isFinite(volumeMm3) || volumeMm3 > Number.MAX_SAFE_INTEGER) {
    return failure('volume-exceeds-safe-range');
  }
  const bounds = Object.freeze({ min: Object.freeze(min), max: Object.freeze(max) });
  const certificate = Object.freeze({
    certified: true,
    certificate: 'closed-axis-aligned-12-triangle-cuboid-v1',
    elementType,
    elementId: String(elementId),
    materialKind,
    bounds,
    volumeMm3,
  });
  issuedCertificates.add(certificate);
  return certificate;
}

/** A certificate must originate in this module and be immutable. */
export function isIssuedOrthogonalBoxCertificate(value) {
  return value !== null && typeof value === 'object' && issuedCertificates.has(value);
}
