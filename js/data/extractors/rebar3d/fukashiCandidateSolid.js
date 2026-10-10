/**
 * @fileoverview FukashiCandidateをstation範囲付きの実LOCAL_PRISM/FACE_OFFSET boxへ具体化する。
 *
 * production geometry自体は変更せず、candidate solidとexisting concrete solidの和集合で
 * RequiredConcreteEnvelopeが覆われるかをpure geometryとして再検証する。
 */

const EPS = 1e-6;

function finiteBounds(bounds) {
  return ['x', 'y', 'z'].every(
    (axis) =>
      Number.isFinite(Number(bounds?.min?.[axis])) &&
      Number.isFinite(Number(bounds?.max?.[axis])) &&
      Number(bounds.min[axis]) <= Number(bounds.max[axis]),
  );
}

function cloneBounds(bounds) {
  return {
    min: { x: Number(bounds.min.x), y: Number(bounds.min.y), z: Number(bounds.min.z) },
    max: { x: Number(bounds.max.x), y: Number(bounds.max.y), z: Number(bounds.max.z) },
  };
}

function fail(reason, extra = {}) {
  return { resolved: false, reason, solid: null, ...extra };
}

export function buildFukashiCandidateSolid({ candidate, existingBounds } = {}) {
  if (!finiteBounds(existingBounds)) return fail('fukashi-solid-existing-bounds-invalid');
  const amount = Number(candidate?.proposedThicknessMm);
  if (!(amount > 0)) return fail('fukashi-solid-thickness-invalid');

  const fullLength = candidate?.mode === 'FACE_OFFSET';
  const stationStart = fullLength
    ? Number(existingBounds.min.z)
    : Number(candidate?.stationStartMm);
  const stationEnd = fullLength ? Number(existingBounds.max.z) : Number(candidate?.stationEndMm);
  if (
    !Number.isFinite(stationStart) ||
    !Number.isFinite(stationEnd) ||
    !(stationEnd > stationStart + EPS)
  ) {
    return fail('fukashi-solid-station-range-invalid');
  }

  const bounds = cloneBounds(existingBounds);
  bounds.min.z = stationStart;
  bounds.max.z = stationEnd;

  const face = candidate?.face;
  if (face === 'RIGHT') {
    bounds.min.x = Number(existingBounds.max.x);
    bounds.max.x = Number(existingBounds.max.x) + amount;
  } else if (face === 'LEFT') {
    bounds.min.x = Number(existingBounds.min.x) - amount;
    bounds.max.x = Number(existingBounds.min.x);
  } else if (face === 'TOP') {
    bounds.min.y = Number(existingBounds.max.y);
    bounds.max.y = Number(existingBounds.max.y) + amount;
  } else if (face === 'BOTTOM') {
    bounds.min.y = Number(existingBounds.min.y) - amount;
    bounds.max.y = Number(existingBounds.min.y);
  } else {
    return fail('fukashi-solid-face-invalid', { face });
  }

  return {
    resolved: true,
    reason: null,
    solid: {
      type: 'AABB_PRISM',
      coordinateSpace: 'beam-accommodation-local',
      hostMemberTag: candidate?.hostMemberTag || null,
      hostMemberId: candidate?.hostMemberId || null,
      candidateId: candidate?.id || null,
      mode: candidate?.mode || null,
      face,
      bounds,
      stationStartMm: stationStart,
      stationEndMm: stationEnd,
      proposedThicknessMm: amount,
    },
  };
}

function inside(point, bounds) {
  return (
    point.x >= bounds.min.x - EPS &&
    point.x <= bounds.max.x + EPS &&
    point.y >= bounds.min.y - EPS &&
    point.y <= bounds.max.y + EPS &&
    point.z >= bounds.min.z - EPS &&
    point.z <= bounds.max.z + EPS
  );
}

function cutsForAxis(required, boxes, axis) {
  const values = [Number(required.min[axis]), Number(required.max[axis])];
  for (const box of boxes) {
    for (const value of [Number(box.min[axis]), Number(box.max[axis])]) {
      if (value > required.min[axis] + EPS && value < required.max[axis] - EPS) values.push(value);
    }
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * required AABBの全体がexisting boxとcandidate prismの和集合に覆われるかを、
 * 各box境界で分割したcell中心点で厳密に判定する。
 */
export function coversRequiredBoundsByBoxUnion({
  requiredBounds,
  existingBounds,
  candidateSolid,
} = {}) {
  if (
    !finiteBounds(requiredBounds) ||
    !finiteBounds(existingBounds) ||
    !finiteBounds(candidateSolid?.bounds)
  ) {
    return { covered: false, reason: 'fukashi-solid-coverage-input-invalid', uncoveredCell: null };
  }
  const boxes = [existingBounds, candidateSolid.bounds];
  const xs = cutsForAxis(requiredBounds, boxes, 'x');
  const ys = cutsForAxis(requiredBounds, boxes, 'y');
  const zs = cutsForAxis(requiredBounds, boxes, 'z');

  for (let xi = 0; xi < xs.length - 1; xi += 1) {
    for (let yi = 0; yi < ys.length - 1; yi += 1) {
      for (let zi = 0; zi < zs.length - 1; zi += 1) {
        const point = {
          x: (xs[xi] + xs[xi + 1]) / 2,
          y: (ys[yi] + ys[yi + 1]) / 2,
          z: (zs[zi] + zs[zi + 1]) / 2,
        };
        if (!boxes.some((box) => inside(point, box))) {
          return {
            covered: false,
            reason: 'fukashi-solid-required-envelope-not-covered',
            uncoveredCell: {
              min: { x: xs[xi], y: ys[yi], z: zs[zi] },
              max: { x: xs[xi + 1], y: ys[yi + 1], z: zs[zi + 1] },
            },
          };
        }
      }
    }
  }
  return { covered: true, reason: null, uncoveredCell: null };
}

export function recheckFukashiCandidateSolid({
  candidate,
  requiredBounds,
  existingBounds,
  openingConflict = false,
  rebarCollision = false,
  memberCollision = false,
} = {}) {
  if (openingConflict) {
    return { status: 'ROLLBACK', acceptable: false, reason: 'OPENING_CONFLICT', solid: null };
  }
  if (rebarCollision) {
    return { status: 'ROLLBACK', acceptable: false, reason: 'REBAR_COLLISION', solid: null };
  }
  if (memberCollision) {
    return { status: 'ROLLBACK', acceptable: false, reason: 'MEMBER_COLLISION', solid: null };
  }

  const built = buildFukashiCandidateSolid({ candidate, existingBounds });
  if (!built.resolved) {
    return { status: 'ROLLBACK', acceptable: false, reason: built.reason, solid: null };
  }
  const coverage = coversRequiredBoundsByBoxUnion({
    requiredBounds,
    existingBounds,
    candidateSolid: built.solid,
  });
  return coverage.covered
    ? {
        status: 'PASS',
        acceptable: true,
        reason: null,
        solid: built.solid,
        coverage,
      }
    : {
        status: 'ROLLBACK',
        acceptable: false,
        reason: coverage.reason || 'SPECIAL_DETAIL_REQUIRED',
        solid: built.solid,
        coverage,
      };
}

function diskIntersectsRectangle(centerY, centerZ, radius, bounds) {
  const y = Math.max(bounds.min.y, Math.min(centerY, bounds.max.y));
  const z = Math.max(bounds.min.z, Math.min(centerZ, bounds.max.z));
  const dy = centerY - y;
  const dz = centerZ - z;
  return dy * dy + dz * dz < radius * radius - EPS;
}

/**
 * 梁貫通孔はbeam width方向へ貫通するため、候補prismのY-Z投影が孔円と交差すれば
 * side/top/bottomいずれの追加でも既存開口を無承認で塞ぐ可能性があるとしてblockする。
 */
export function findCandidatePenetrationConflict(candidateSolid, penetrations = []) {
  if (!finiteBounds(candidateSolid?.bounds)) return null;
  for (const penetration of penetrations || []) {
    const centerY = Number(penetration?.centerYmm);
    const centerZ = Number(penetration?.stationMm);
    const radius = Number(penetration?.radiusMm);
    if (!Number.isFinite(centerY) || !Number.isFinite(centerZ) || !(radius > 0)) {
      continue;
    }
    if (diskIntersectsRectangle(centerY, centerZ, radius, candidateSolid.bounds)) {
      return penetration;
    }
  }
  return null;
}

export const _fukashiCandidateSolidInternals = Object.freeze({
  finiteBounds,
  diskIntersectsRectangle,
});
