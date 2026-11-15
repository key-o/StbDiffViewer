/**
 * @fileoverview Exact geometric union for certified axis-aligned cuboids only.
 *
 * Computes a plane-sweep union, not sum(pairwise intersections). Three-way and
 * higher overlaps are thus counted once. Requires certificates issued by the
 * strict mesh validator; never uses arbitrary AABBs as a solid proxy.
 * No STB or QuantityService changes and no whole-building verification claim.
 */

import { isIssuedOrthogonalBoxCertificate } from './CertifiedOrthogonalBox.js';

const AXES = ['x', 'y', 'z'];
const MATERIALS = ['CONCRETE', 'STEEL'];
const MAX_BOXES = 64;
const CERTIFICATE = 'closed-axis-aligned-12-triangle-cuboid-v1';

function sortedEdges(boxes, axis) {
  return [...new Set(boxes.flatMap(({ bounds }) => [bounds.min[axis], bounds.max[axis]]))].sort(
    (a, b) => a - b,
  );
}

function unionLength(intervals) {
  if (!intervals.length) return 0;
  const sorted = intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let [start, end] = sorted[0];
  let total = 0;
  for (let i = 1; i < sorted.length; i++) {
    const [nextStart, nextEnd] = sorted[i];
    if (nextStart <= end) end = Math.max(end, nextEnd);
    else {
      total += end - start;
      start = nextStart;
      end = nextEnd;
    }
  }
  return total + end - start;
}

function unionVolume(boxes) {
  if (!boxes.length) return 0;
  const xEdges = sortedEdges(boxes, 'x');
  let volume = 0;
  for (let xi = 1; xi < xEdges.length; xi++) {
    const x0 = xEdges[xi - 1];
    const x1 = xEdges[xi];
    const activeX = boxes.filter((box) => box.bounds.min.x < x1 && box.bounds.max.x > x0);
    const yEdges = sortedEdges(activeX, 'y');
    let area = 0;
    for (let yi = 1; yi < yEdges.length; yi++) {
      const y0 = yEdges[yi - 1];
      const y1 = yEdges[yi];
      const intervals = activeX
        .filter((box) => box.bounds.min.y < y1 && box.bounds.max.y > y0)
        .map((box) => [box.bounds.min.z, box.bounds.max.z]);
      area += (y1 - y0) * unionLength(intervals);
    }
    volume += (x1 - x0) * area;
  }
  return volume;
}

function isCertified(box) {
  if (
    !isIssuedOrthogonalBoxCertificate(box) ||
    box?.certified !== true ||
    box.certificate !== CERTIFICATE ||
    typeof box.elementType !== 'string' ||
    !box.elementType.trim() ||
    typeof box.elementId !== 'string' ||
    !box.elementId.trim() ||
    !MATERIALS.includes(box.materialKind)
  ) {
    return false;
  }
  const bounds = box.bounds;
  return (
    bounds &&
    AXES.every(
      (axis) =>
        Number.isFinite(bounds.min?.[axis]) &&
        Number.isFinite(bounds.max?.[axis]) &&
        bounds.max[axis] > bounds.min[axis],
    ) &&
    Number.isFinite(box.volumeMm3) &&
    Math.abs(
      box.volumeMm3 -
        AXES.reduce((volume, axis) => volume * (bounds.max[axis] - bounds.min[axis]), 1),
    ) <= Math.max(1e-4, box.volumeMm3 * 1e-12)
  );
}

/**
 * @param {object[]} certifiedBoxes Verified single-cuboid solids, same working revision.
 * @returns {object} Material-specific volumes for this certified subset only.
 */
export function calculateCertifiedBoxUnion(certifiedBoxes) {
  if (!Array.isArray(certifiedBoxes)) throw new TypeError('certifiedBoxes must be an array');
  if (certifiedBoxes.length > MAX_BOXES) throw new RangeError('certified subset exceeds box limit');
  const ids = new Set();
  for (const box of certifiedBoxes) {
    if (!isCertified(box)) throw new TypeError('uncertified or malformed box');
    const key = JSON.stringify([box.elementType, box.elementId]);
    if (ids.has(key)) throw new TypeError('multiple or duplicate solids per member');
    ids.add(key);
  }
  const byMaterial = {};
  for (const materialKind of MATERIALS) {
    const boxes = certifiedBoxes.filter((box) => box.materialKind === materialKind);
    const memberSumMm3 = boxes.reduce((sum, box) => sum + box.volumeMm3, 0);
    const unionMm3 = unionVolume(boxes);
    const overlappingMm3 = memberSumMm3 - unionMm3;
    if (
      ![memberSumMm3, unionMm3, overlappingMm3].every(Number.isFinite) ||
      memberSumMm3 > Number.MAX_SAFE_INTEGER ||
      overlappingMm3 < -1e-6
    ) {
      throw new RangeError('union volume outside safe numeric range');
    }
    byMaterial[materialKind] = {
      certifiedMemberCount: boxes.length,
      memberSumMm3,
      unionMm3,
      overlappingMm3: Math.max(0, overlappingMm3),
    };
  }
  return {
    method: 'certified-orthogonal-cuboid-union-only',
    verifiedScope: 'supplied-certified-subset',
    buildingCoverageVerified: false,
    quantityServiceUpdated: false,
    certifiedMemberCount: certifiedBoxes.length,
    byMaterial,
  };
}
