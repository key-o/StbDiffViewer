/**
 * @fileoverview P2 preliminary broad-phase only: identify potentially overlapping
 * member world-space AABBs without assigning or subtracting a material volume.
 *
 * AABB intersections are NOT mesh/solid intersections. Callers must run an exact,
 * material-aware solid intersection/union before reporting a net building quantity.
 */

const DEFAULT_MAX_CANDIDATES = 10000;
const DEFAULT_MAX_COMPARISONS = 200000;
const AXES = ['x', 'y', 'z'];

function isFinitePoint(point) {
  return point && AXES.every((axis) => Number.isFinite(point[axis]));
}

function normalizeMember(member) {
  const elementType = member?.elementType;
  const rawId = member?.elementId;
  const elementId = rawId === null || rawId === undefined ? '' : String(rawId);
  const { min, max } = member?.bounds || {};
  if (
    typeof elementType !== 'string' ||
    !elementType.trim() ||
    !elementId.trim() ||
    !isFinitePoint(min) ||
    !isFinitePoint(max) ||
    !AXES.every((axis) => min[axis] < max[axis])
  ) {
    return null;
  }

  return {
    elementType,
    elementId,
    key: JSON.stringify([elementType, elementId]),
    bounds: {
      min: { x: min.x, y: min.y, z: min.z },
      max: { x: max.x, y: max.y, z: max.z },
    },
  };
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function isOverlap(a, b, axis, tolerance) {
  return (
    Math.min(a.bounds.max[axis], b.bounds.max[axis]) -
      Math.max(a.bounds.min[axis], b.bounds.min[axis]) >
    tolerance
  );
}

function candidateFor(a, b) {
  return {
    first: { elementType: a.elementType, elementId: a.elementId },
    second: { elementType: b.elementType, elementId: b.elementId },
    // This is an AABB intersection only, NOT a solid-intersection volume.
    broadPhaseIntersectionBounds: {
      min: Object.fromEntries(
        AXES.map((axis) => [axis, Math.max(a.bounds.min[axis], b.bounds.min[axis])]),
      ),
      max: Object.fromEntries(
        AXES.map((axis) => [axis, Math.min(a.bounds.max[axis], b.bounds.max[axis])]),
      ),
    },
  };
}

/**
 * Return conservative broad-phase candidates for a future exact solid check.
 *
 * The bounds must be in the same world coordinate system, expressed in mm.
 * Zero-volume boxes, duplicate element keys and malformed entries are skipped.
 * A contact along a face/edge/point is not considered positive-volume overlap.
 * A positive tolerance deliberately suppresses very thin intersections; for a
 * no-false-negative broad-phase use the default tolerance 0.
 *
 * Pair/comparison limits bound synchronous work. A truncated result must never
 * be used to claim no further collisions; results do not affect QuantityService.
 *
 * @param {Array<{elementType:string,elementId:string|number,bounds:{min:object,max:object}}>} members
 * @param {{maxCandidates?:number,maxComparisons?:number,overlapToleranceMm?:number}} options
 */
export function findAabbOverlapCandidates(
  members,
  {
    maxCandidates = DEFAULT_MAX_CANDIDATES,
    maxComparisons = DEFAULT_MAX_COMPARISONS,
    overlapToleranceMm = 0,
  } = {},
) {
  if (!Array.isArray(members)) throw new TypeError('members must be an array');
  requirePositiveInteger(maxCandidates, 'maxCandidates');
  requirePositiveInteger(maxComparisons, 'maxComparisons');
  if (!Number.isFinite(overlapToleranceMm) || overlapToleranceMm < 0) {
    throw new RangeError('overlapToleranceMm must be finite and nonnegative');
  }

  const seen = new Set();
  const valid = [];
  let skippedMembers = 0;
  for (const member of members) {
    const normalized = normalizeMember(member);
    if (!normalized || seen.has(normalized.key)) {
      skippedMembers += 1;
      continue;
    }
    seen.add(normalized.key);
    valid.push(normalized);
  }
  valid.sort(
    (a, b) => a.bounds.min.x - b.bounds.min.x || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  const candidates = [];
  let comparisons = 0;
  let truncated = false;
  const active = [];
  outer: for (const current of valid) {
    // Sweep-and-prune in X. The remaining Y/Z tests are still broad phase.
    for (let i = active.length - 1; i >= 0; i--) {
      if (!isOverlap(active[i], current, 'x', overlapToleranceMm)) {
        active.splice(i, 1);
      }
    }
    for (const previous of active) {
      if (comparisons >= maxComparisons) {
        truncated = true;
        break outer;
      }
      comparisons += 1;
      if (
        !isOverlap(previous, current, 'y', overlapToleranceMm) ||
        !isOverlap(previous, current, 'z', overlapToleranceMm)
      ) {
        continue;
      }
      if (candidates.length >= maxCandidates) {
        truncated = true;
        break outer;
      }
      candidates.push(candidateFor(previous, current));
    }
    active.push(current);
  }

  return {
    candidates,
    validMembers: valid.length,
    skippedMembers,
    comparisons,
    truncated,
    // Full input coverage is unknown if some members were invalid or the scan was capped.
    coverageComplete: !truncated && skippedMembers === 0,
    // These invariant fields prevent confusion with the exact P2 result.
    verification: 'not_verified',
    quantityEffect: 'none',
  };
}
