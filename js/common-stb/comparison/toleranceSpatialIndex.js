/**
 * @fileoverview ToleranceStrategy の近傍候補探索用の軽量3D空間索引。
 *
 * 比較意味は持たず、compareElementDataWithTolerance() で一致し得る候補を
 * 取りこぼさないための保守的な候補集合だけを返す。
 */

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function applyOffset(coords, offset) {
  if (!coords) return null;
  const x = finiteNumber(coords.x);
  const y = finiteNumber(coords.y);
  const z = finiteNumber(coords.z);
  if (x == null || y == null || z == null) return null;

  return {
    x: x + (Number(offset?.x) || 0),
    y: y + (Number(offset?.y) || 0),
    z: z + (Number(offset?.z) || 0),
  };
}

function midpoint(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: (a.z + b.z) / 2,
  };
}

function average(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const total = points.reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y, z: sum.z + point.z }),
    { x: 0, y: 0, z: 0 },
  );
  return {
    x: total.x / points.length,
    y: total.y / points.length,
    z: total.z / points.length,
  };
}

/**
 * 許容差比較の必要条件として使える代表点を返す。
 * - Node: 座標
 * - line: offset反映後の中点（始終端反転に不変）
 * - polygon: per-vertex offset反映後の頂点平均（頂点順序に不変）
 *
 * 各点が座標軸ごとに tolerance 内なら、これらの代表点も同じ tolerance 内に入るため、
 * 代表点近傍で候補を絞っても真の一致候補を落とさない。
 */
export function getToleranceSpatialAnchor(data) {
  if (data?.coords) {
    return applyOffset(data.coords, null);
  }

  if (data?.startCoords && data?.endCoords) {
    const start = applyOffset(data.startCoords, data.startOffset);
    const end = applyOffset(data.endCoords, data.endOffset);
    return start && end ? midpoint(start, end) : null;
  }

  if (Array.isArray(data?.vertexCoordsList) && data.vertexCoordsList.length > 0) {
    const offsets = data.perVertexOffsets || [];
    const points = [];
    for (let index = 0; index < data.vertexCoordsList.length; index += 1) {
      const point = applyOffset(data.vertexCoordsList[index], offsets[index]);
      if (!point) return null;
      points.push(point);
    }
    return average(points);
  }

  return null;
}

function normalizeTolerance(config) {
  const tolerance = config?.basePoint;
  if (!tolerance) return null;

  const x = finiteNumber(tolerance.x);
  const y = finiteNumber(tolerance.y);
  const z = finiteNumber(tolerance.z);
  if (x == null || y == null || z == null || x < 0 || y < 0 || z < 0) {
    return null;
  }
  return { x, y, z };
}

function exactCoordinateKey(value) {
  return Object.is(value, -0) ? '0' : String(value);
}

function bucketForAxis(value, tolerance) {
  if (tolerance === 0) {
    return `e:${exactCoordinateKey(value)}`;
  }
  return `b:${Math.floor(value / tolerance)}`;
}

function neighboringBuckets(value, tolerance) {
  if (tolerance === 0) {
    return [bucketForAxis(value, tolerance)];
  }
  const bucket = Math.floor(value / tolerance);
  return [`b:${bucket - 1}`, `b:${bucket}`, `b:${bucket + 1}`];
}

function cellKey(x, y, z) {
  return `${x}|${y}|${z}`;
}

function compareCandidateUid(left, right) {
  return left.uid - right.uid;
}

/**
 * A側候補を tolerance 幅の3Dセルへ格納する。
 * 代表点を解けない候補は fallbackCandidates に保持し、常に query 結果へ含める。
 * これにより索引化で比較結果を変えない。
 */
export function createToleranceSpatialIndex(candidates, config) {
  const tolerance = normalizeTolerance(config);
  if (!tolerance) {
    return {
      usable: false,
      indexedCount: 0,
      fallbackCount: candidates.length,
      query: () => candidates,
    };
  }

  const cells = new Map();
  const fallbackCandidates = [];

  for (const candidate of candidates) {
    const anchor = getToleranceSpatialAnchor(candidate.data);
    if (!anchor) {
      fallbackCandidates.push(candidate);
      continue;
    }

    const key = cellKey(
      bucketForAxis(anchor.x, tolerance.x),
      bucketForAxis(anchor.y, tolerance.y),
      bucketForAxis(anchor.z, tolerance.z),
    );
    if (!cells.has(key)) {
      cells.set(key, []);
    }
    cells.get(key).push(candidate);
  }

  for (const bucket of cells.values()) {
    bucket.sort(compareCandidateUid);
  }
  fallbackCandidates.sort(compareCandidateUid);

  return {
    usable: true,
    indexedCount: candidates.length - fallbackCandidates.length,
    fallbackCount: fallbackCandidates.length,
    query(data) {
      const anchor = getToleranceSpatialAnchor(data);
      if (!anchor) {
        return candidates;
      }

      const collected = new Map();
      const xBuckets = neighboringBuckets(anchor.x, tolerance.x);
      const yBuckets = neighboringBuckets(anchor.y, tolerance.y);
      const zBuckets = neighboringBuckets(anchor.z, tolerance.z);

      for (const x of xBuckets) {
        for (const y of yBuckets) {
          for (const z of zBuckets) {
            for (const candidate of cells.get(cellKey(x, y, z)) || []) {
              collected.set(candidate.uid, candidate);
            }
          }
        }
      }
      for (const candidate of fallbackCandidates) {
        collected.set(candidate.uid, candidate);
      }

      return Array.from(collected.values()).sort(compareCandidateUid);
    },
  };
}
