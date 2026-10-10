/**
 * @fileoverview ふかし候補と周辺RC部材の実solid越境をpure OBBで判定する。
 *
 * candidateはbeam-accommodation-localのAABB、既存部材はmember-localの直方体として
 * world OBBへ変換し、15軸SATで正の体積を持つ交差だけをMEMBER_COLLISIONとする。
 * 端面が接するだけの状態はcollisionにしない。
 */

const EPS = 1e-9;
const TOUCH_TOLERANCE_MM = 1e-6;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finitePoint(point) {
  return ['x', 'y', 'z'].every((axis) => finite(point?.[axis]) !== null);
}

function finiteBounds(bounds) {
  return (
    finitePoint(bounds?.min) &&
    finitePoint(bounds?.max) &&
    ['x', 'y', 'z'].every((axis) => Number(bounds.min[axis]) <= Number(bounds.max[axis]))
  );
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function normalize(vector) {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (!(length > EPS)) return null;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function normalizedQuaternion(placement) {
  const q = placement?.rotation || {};
  const x = finite(q.x) ?? 0;
  const y = finite(q.y) ?? 0;
  const z = finite(q.z) ?? 0;
  const w = finite(q.w) ?? 1;
  const length = Math.hypot(x, y, z, w);
  if (!(length > EPS)) return null;
  return { x: x / length, y: y / length, z: z / length, w: w / length };
}

function rotateByQuaternion(vector, q) {
  const ix = q.w * vector.x + q.y * vector.z - q.z * vector.y;
  const iy = q.w * vector.y + q.z * vector.x - q.x * vector.z;
  const iz = q.w * vector.z + q.x * vector.y - q.y * vector.x;
  const iw = -q.x * vector.x - q.y * vector.y - q.z * vector.z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}

function rollLocal(vector, roll) {
  if (Math.abs(roll) <= EPS) return vector;
  const cos = Math.cos(roll);
  const sin = Math.sin(roll);
  return {
    x: vector.x * cos - vector.y * sin,
    y: vector.x * sin + vector.y * cos,
    z: vector.z,
  };
}

function localVectorToWorld(vector, placement) {
  const q = normalizedQuaternion(placement);
  if (!q) return null;
  return rotateByQuaternion(rollLocal(vector, Number(placement?.localRollRad) || 0), q);
}

function localPointToWorld(point, placement) {
  const center = placement?.center;
  if (!finitePoint(point) || !finitePoint(center)) return null;
  const rotated = localVectorToWorld(point, placement);
  if (!rotated) return null;
  return {
    x: rotated.x + Number(center.x),
    y: rotated.y + Number(center.y),
    z: rotated.z + Number(center.z),
  };
}

function obbFromLocalBounds({
  localBounds,
  placement,
  memberTag = null,
  memberId = null,
  nodeIds = [],
  approximation = null,
} = {}) {
  if (!finiteBounds(localBounds) || !placement) return null;
  const localCenter = {
    x: (Number(localBounds.min.x) + Number(localBounds.max.x)) / 2,
    y: (Number(localBounds.min.y) + Number(localBounds.max.y)) / 2,
    z: (Number(localBounds.min.z) + Number(localBounds.max.z)) / 2,
  };
  const center = localPointToWorld(localCenter, placement);
  const axes = [
    localVectorToWorld({ x: 1, y: 0, z: 0 }, placement),
    localVectorToWorld({ x: 0, y: 1, z: 0 }, placement),
    localVectorToWorld({ x: 0, y: 0, z: 1 }, placement),
  ].map(normalize);
  if (!center || axes.some((axis) => !axis)) return null;
  return {
    type: 'OBB',
    center,
    axes,
    halfSize: [
      (Number(localBounds.max.x) - Number(localBounds.min.x)) / 2,
      (Number(localBounds.max.y) - Number(localBounds.min.y)) / 2,
      (Number(localBounds.max.z) - Number(localBounds.min.z)) / 2,
    ],
    memberTag,
    memberId: memberId == null ? null : String(memberId),
    nodeIds: (nodeIds || []).filter((value) => value !== null && value !== undefined).map(String),
    approximation,
  };
}

function nonNegativeMemberValue(member, key) {
  const raw = member?.[key];
  if (raw === undefined || raw === null || raw === '') return 0;
  const value = finite(raw);
  return value !== null && value >= 0 ? value : null;
}

export function buildCandidateWorldObb({ candidateSolid, supportPlacement, supportEndpoint } = {}) {
  const bounds = candidateSolid?.bounds;
  const length = Number(supportPlacement?.length);
  if (!finiteBounds(bounds) || !(length > 0) || !['start', 'end'].includes(supportEndpoint)) {
    return null;
  }

  const localBounds = {
    min: {
      x: -Number(bounds.max.x),
      y: Number(bounds.min.y),
      z:
        supportEndpoint === 'start'
          ? Number(bounds.min.z) - length / 2
          : length / 2 - Number(bounds.max.z),
    },
    max: {
      x: -Number(bounds.min.x),
      y: Number(bounds.max.y),
      z:
        supportEndpoint === 'start'
          ? Number(bounds.max.z) - length / 2
          : length / 2 - Number(bounds.min.z),
    },
  };
  return obbFromLocalBounds({
    localBounds,
    placement: supportPlacement,
    memberTag: candidateSolid?.hostMemberTag || null,
    memberId: candidateSolid?.hostMemberId || null,
  });
}

export function buildBeamMemberConcreteObb({
  member,
  placement,
  layout,
  memberTag = 'StbBeam',
} = {}) {
  const width = Number(layout?.width);
  const depth = Number(layout?.depth);
  const length = Number(placement?.length);
  if (!(width > 0) || !(depth > 0) || !(length > 0)) return null;

  const top = nonNegativeMemberValue(member, 'thickness_add_top');
  const bottom = nonNegativeMemberValue(member, 'thickness_add_bottom');
  const right = nonNegativeMemberValue(member, 'thickness_add_right');
  const left = nonNegativeMemberValue(member, 'thickness_add_left');
  if ([top, bottom, right, left].some((value) => value === null)) return null;

  return obbFromLocalBounds({
    localBounds: {
      min: { x: -width / 2 - right, y: -depth / 2 - bottom, z: -length / 2 },
      max: { x: width / 2 + left, y: depth / 2 + top, z: length / 2 },
    },
    placement,
    memberTag,
    memberId: member?.id,
    nodeIds: [member?.id_node_start, member?.id_node_end],
  });
}

export function buildColumnMemberConcreteObb({
  member,
  placement,
  layout,
  memberTag = 'StbColumn',
} = {}) {
  const length = Number(placement?.length);
  if (!(length > 0)) return null;

  const isCircle = layout?.shape === 'CIRCLE';
  const width = isCircle ? Number(layout?.diameter) : Number(layout?.width);
  const height = isCircle ? Number(layout?.diameter) : Number(layout?.height);
  if (!(width > 0) || !(height > 0)) return null;

  const startX = nonNegativeMemberValue(member, 'thickness_add_start_X');
  const endX = nonNegativeMemberValue(member, 'thickness_add_end_X');
  const startY = nonNegativeMemberValue(member, 'thickness_add_start_Y');
  const endY = nonNegativeMemberValue(member, 'thickness_add_end_Y');
  if ([startX, endX, startY, endY].some((value) => value === null)) return null;

  if (isCircle) {
    // ST-Bridgeでは円形柱のふかしはX始のみを用いる。非標準の他方向値がある場合は
    // 過小評価を避けるため従来の外接矩形へfail-safe fallbackする。
    if ([endX, startY, endY].some((value) => value > EPS)) {
      return obbFromLocalBounds({
        localBounds: {
          min: {
            x: -width / 2 - Math.max(startX, endX),
            y: -height / 2 - Math.max(startY, endY),
            z: -length / 2,
          },
          max: {
            x: width / 2 + Math.max(startX, endX),
            y: height / 2 + Math.max(startY, endY),
            z: length / 2,
          },
        },
        placement,
        memberTag,
        memberId: member?.id,
        nodeIds: [member?.id_node_bottom, member?.id_node_top],
        approximation: 'CIRCLE_NONSTANDARD_FUKASHI_ENCLOSING_BOX',
      });
    }

    const axes = [
      localVectorToWorld({ x: 1, y: 0, z: 0 }, placement),
      localVectorToWorld({ x: 0, y: 1, z: 0 }, placement),
      localVectorToWorld({ x: 0, y: 0, z: 1 }, placement),
    ].map(normalize);
    if (!finitePoint(placement?.center) || axes.some((axis) => !axis)) return null;
    return {
      type: 'CIRCULAR_PRISM',
      center: {
        x: Number(placement.center.x),
        y: Number(placement.center.y),
        z: Number(placement.center.z),
      },
      axes,
      radius: width / 2 + startX,
      halfLength: length / 2,
      memberTag,
      memberId: member?.id == null ? null : String(member.id),
      nodeIds: [member?.id_node_bottom, member?.id_node_top]
        .filter((value) => value !== null && value !== undefined)
        .map(String),
      approximation: null,
    };
  }

  return obbFromLocalBounds({
    localBounds: {
      min: { x: -width / 2 - endX, y: -height / 2 - endY, z: -length / 2 },
      max: { x: width / 2 + startX, y: height / 2 + startY, z: length / 2 },
    },
    placement,
    memberTag,
    memberId: member?.id,
    nodeIds: [member?.id_node_bottom, member?.id_node_top],
  });
}

function validCircularPrism(prism) {
  return (
    prism?.type === 'CIRCULAR_PRISM' &&
    finitePoint(prism.center) &&
    Array.isArray(prism.axes) &&
    prism.axes.length === 3 &&
    prism.axes.every(finitePoint) &&
    Number.isFinite(Number(prism.radius)) &&
    Number(prism.radius) > 0 &&
    Number.isFinite(Number(prism.halfLength)) &&
    Number(prism.halfLength) > 0
  );
}

function obbVertices(obb) {
  const vertices = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const signs = [sx, sy, sz];
        const point = { ...obb.center };
        for (let axisIndex = 0; axisIndex < 3; axisIndex += 1) {
          const amount = signs[axisIndex] * Number(obb.halfSize[axisIndex]);
          point.x += obb.axes[axisIndex].x * amount;
          point.y += obb.axes[axisIndex].y * amount;
          point.z += obb.axes[axisIndex].z * amount;
        }
        vertices.push(point);
      }
    }
  }
  return vertices;
}

function prismLocalPoint(worldPoint, prism) {
  const relative = subtract(worldPoint, prism.center);
  return {
    x: dot(relative, prism.axes[0]),
    y: dot(relative, prism.axes[1]),
    z: dot(relative, prism.axes[2]),
  };
}

function interpolatePoint(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

function clippedObbProjectionPoints(obb, prism, halfLength) {
  const worldVertices = obbVertices(obb);
  const vertices = worldVertices.map((point) => prismLocalPoint(point, prism));
  const points = vertices
    .filter((point) => point.z >= -halfLength && point.z <= halfLength)
    .map((point) => ({ x: point.x, y: point.y }));

  const edges = [];
  for (let index = 0; index < 8; index += 1) {
    for (const bit of [1, 2, 4]) {
      const other = index ^ bit;
      if (index < other) edges.push([index, other]);
    }
  }

  for (const [aIndex, bIndex] of edges) {
    const a = vertices[aIndex];
    const b = vertices[bIndex];
    const dz = b.z - a.z;
    if (Math.abs(dz) <= EPS) continue;
    for (const planeZ of [-halfLength, halfLength]) {
      const t = (planeZ - a.z) / dz;
      if (t < 0 || t > 1) continue;
      const point = interpolatePoint(a, b, t);
      points.push({ x: point.x, y: point.y });
    }
  }
  return points;
}

function cross2d(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function convexHull2d(points) {
  const unique = [];
  const sorted = [...points]
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .sort((a, b) => a.x - b.x || a.y - b.y);
  for (const point of sorted) {
    const previous = unique[unique.length - 1];
    if (
      previous &&
      Math.abs(previous.x - point.x) <= EPS &&
      Math.abs(previous.y - point.y) <= EPS
    ) {
      continue;
    }
    unique.push(point);
  }
  if (unique.length <= 2) return unique;

  const lower = [];
  for (const point of unique) {
    while (
      lower.length >= 2 &&
      cross2d(lower[lower.length - 2], lower[lower.length - 1], point) <= EPS
    ) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper = [];
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index];
    while (
      upper.length >= 2 &&
      cross2d(upper[upper.length - 2], upper[upper.length - 1], point) <= EPS
    ) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function polygonArea2d(polygon) {
  let area2 = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    area2 += a.x * b.y - a.y * b.x;
  }
  return Math.abs(area2) / 2;
}

function originInsideConvexPolygon(polygon) {
  let sign = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const cross = a.x * b.y - a.y * b.x;
    if (Math.abs(cross) <= EPS) continue;
    const current = Math.sign(cross);
    if (sign === 0) sign = current;
    else if (sign !== current) return false;
  }
  return sign !== 0;
}

function pointSegmentDistanceSqToOrigin(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= EPS) return a.x * a.x + a.y * a.y;
  const t = Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lengthSq));
  const x = a.x + dx * t;
  const y = a.y + dy * t;
  return x * x + y * y;
}

/**
 * OBBと有限円柱（円形柱）の厳密断面判定。
 *
 * 円柱軸方向でOBBをclipし、その凸多面体を円柱断面へ正射影する。
 * 円柱は「円盤 × 軸区間」なので、この2D凸包と円盤の交差がそのまま3D交差となる。
 * touchTolerance分だけ円柱を縮め、面・辺が接するだけの状態はcollisionにしない。
 */
export function obbIntersectsCircularPrism(
  obb,
  prism,
  { touchToleranceMm = TOUCH_TOLERANCE_MM } = {},
) {
  if (!validObb(obb) || !validCircularPrism(prism)) return false;
  const tolerance = Math.max(0, Number(touchToleranceMm) || 0);
  const radius = Number(prism.radius) - tolerance;
  const halfLength = Number(prism.halfLength) - tolerance;
  if (!(radius > 0) || !(halfLength > 0)) return false;

  const localVertices = obbVertices(obb).map((point) => prismLocalPoint(point, prism));
  const minZ = Math.min(...localVertices.map((point) => point.z));
  const maxZ = Math.max(...localVertices.map((point) => point.z));
  const axialOverlap = Math.min(maxZ, halfLength) - Math.max(minZ, -halfLength);
  if (!(axialOverlap > EPS)) return false;

  const hull = convexHull2d(clippedObbProjectionPoints(obb, prism, halfLength));
  if (hull.length < 3 || polygonArea2d(hull) <= EPS) return false;
  if (originInsideConvexPolygon(hull)) return true;

  const radiusSq = radius * radius;
  let minDistanceSq = Infinity;
  for (let index = 0; index < hull.length; index += 1) {
    minDistanceSq = Math.min(
      minDistanceSq,
      pointSegmentDistanceSqToOrigin(hull[index], hull[(index + 1) % hull.length]),
    );
  }
  return minDistanceSq < radiusSq - EPS;
}

function validObb(obb) {
  return (
    finitePoint(obb?.center) &&
    Array.isArray(obb?.axes) &&
    obb.axes.length === 3 &&
    obb.axes.every(finitePoint) &&
    Array.isArray(obb?.halfSize) &&
    obb.halfSize.length === 3 &&
    obb.halfSize.every((value) => Number.isFinite(Number(value)) && Number(value) > 0)
  );
}

/**
 * Oriented box同士の15軸SAT。面・辺がtouchするだけのケースはcollisionにしない。
 */
export function obbIntersectsObb(a, b, { touchToleranceMm = TOUCH_TOLERANCE_MM } = {}) {
  if (!validObb(a) || !validObb(b)) return false;
  const tolerance = Math.max(0, Number(touchToleranceMm) || 0);
  const R = Array.from({ length: 3 }, () => Array(3).fill(0));
  const absR = Array.from({ length: 3 }, () => Array(3).fill(0));

  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      R[i][j] = dot(a.axes[i], b.axes[j]);
      absR[i][j] = Math.abs(R[i][j]) + EPS;
    }
  }

  const tWorld = subtract(b.center, a.center);
  const t = a.axes.map((axis) => dot(tWorld, axis));

  const separated = (distance, radiusA, radiusB) =>
    Math.abs(distance) >= radiusA + radiusB - tolerance;

  for (let i = 0; i < 3; i += 1) {
    const ra = Number(a.halfSize[i]);
    const rb =
      Number(b.halfSize[0]) * absR[i][0] +
      Number(b.halfSize[1]) * absR[i][1] +
      Number(b.halfSize[2]) * absR[i][2];
    if (separated(t[i], ra, rb)) return false;
  }

  for (let j = 0; j < 3; j += 1) {
    const ra =
      Number(a.halfSize[0]) * absR[0][j] +
      Number(a.halfSize[1]) * absR[1][j] +
      Number(a.halfSize[2]) * absR[2][j];
    const rb = Number(b.halfSize[j]);
    const distance = dot(tWorld, b.axes[j]);
    if (separated(distance, ra, rb)) return false;
  }

  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      // 平行軸同士の外積はゼロベクトルなので、SAT軸として評価しない。
      const crossAxisLengthSq = Math.max(0, 1 - R[i][j] * R[i][j]);
      if (crossAxisLengthSq <= 1e-12) continue;
      const ra =
        Number(a.halfSize[(i + 1) % 3]) * absR[(i + 2) % 3][j] +
        Number(a.halfSize[(i + 2) % 3]) * absR[(i + 1) % 3][j];
      const rb =
        Number(b.halfSize[(j + 1) % 3]) * absR[i][(j + 2) % 3] +
        Number(b.halfSize[(j + 2) % 3]) * absR[i][(j + 1) % 3];
      const distance = t[(i + 2) % 3] * R[(i + 1) % 3][j] - t[(i + 1) % 3] * R[(i + 2) % 3][j];
      if (separated(distance, ra, rb)) return false;
    }
  }

  return true;
}

export function findCandidateMemberCollision(candidateObb, obstacles = []) {
  if (!validObb(candidateObb)) return null;
  for (const obstacle of obstacles || []) {
    const intersects = validObb(obstacle)
      ? obbIntersectsObb(candidateObb, obstacle)
      : validCircularPrism(obstacle)
        ? obbIntersectsCircularPrism(candidateObb, obstacle)
        : false;
    if (!intersects) continue;
    return {
      reason: 'MEMBER_COLLISION',
      memberTag: obstacle.memberTag || null,
      memberId: obstacle.memberId || null,
      nodeIds: obstacle.nodeIds || [],
      approximation: obstacle.approximation || null,
      geometryType: obstacle.type || null,
      obstacle,
    };
  }
  return null;
}

export const _concreteMemberCollisionInternals = Object.freeze({
  finiteBounds,
  localPointToWorld,
  localVectorToWorld,
  obbFromLocalBounds,
  validCircularPrism,
  clippedObbProjectionPoints,
  convexHull2d,
});
