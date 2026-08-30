/**
 * @fileoverview DXF平面図用のメッシュ水平断面抽出
 *
 * EdgesGeometryによる既存稜線抽出ではなく、BufferGeometryの各三角形と
 * Z=constant 平面の交線を求め、重複除去・端点接続・共線点除去を経て
 * CAD向けの閉ループを生成する。
 */

import * as THREE from 'three';
import { extractWallOuterSectionLoops } from './DxfWallPlanCollector.js';

const DEFAULT_TOLERANCE = 0.1;

function pointKey(point, tolerance) {
  return `${Math.round(point.x / tolerance)}:${Math.round(point.y / tolerance)}:${Math.round(point.z / tolerance)}`;
}

function samePoint(a, b, tolerance) {
  return a.distanceToSquared(b) <= tolerance * tolerance;
}

function uniquePoints(points, tolerance) {
  const result = [];
  for (const point of points) {
    if (!result.some((existing) => samePoint(existing, point, tolerance))) {
      result.push(point);
    }
  }
  return result;
}

function farthestPair(points) {
  let best = null;
  let bestDistance = -1;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const distance = points[i].distanceToSquared(points[j]);
      if (distance > bestDistance) {
        bestDistance = distance;
        best = [points[i], points[j]];
      }
    }
  }
  return best;
}

function intersectTriangleAtZ(a, b, c, z, tolerance) {
  const vertices = [a, b, c];
  const distances = vertices.map((p) => p.z - z);

  // 三角形全体が切断面上にある場合は除外する。
  // 面内三角形の対角線を断面線として出さないため、境界は隣接する側面から得る。
  if (distances.every((d) => Math.abs(d) <= tolerance)) return null;

  const intersections = [];
  const edges = [
    [0, 1],
    [1, 2],
    [2, 0],
  ];

  for (const [i, j] of edges) {
    const p1 = vertices[i];
    const p2 = vertices[j];
    const d1 = distances[i];
    const d2 = distances[j];
    const p1On = Math.abs(d1) <= tolerance;
    const p2On = Math.abs(d2) <= tolerance;

    if (p1On && p2On) {
      intersections.push(p1.clone(), p2.clone());
    } else if (p1On) {
      intersections.push(p1.clone());
    } else if (p2On) {
      intersections.push(p2.clone());
    } else if ((d1 < -tolerance && d2 > tolerance) || (d1 > tolerance && d2 < -tolerance)) {
      const t = (z - p1.z) / (p2.z - p1.z);
      intersections.push(new THREE.Vector3().lerpVectors(p1, p2, t));
    }
  }

  const unique = uniquePoints(intersections, tolerance);
  if (unique.length < 2) return null;

  const pair = unique.length === 2 ? unique : farthestPair(unique);
  if (!pair || samePoint(pair[0], pair[1], tolerance)) return null;

  pair[0].z = z;
  pair[1].z = z;
  return { start: pair[0], end: pair[1] };
}

function segmentKey(segment, tolerance) {
  const a = pointKey(segment.start, tolerance);
  const b = pointKey(segment.end, tolerance);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function extractRawHorizontalSectionSegments(mesh, z, tolerance) {
  if (!mesh?.geometry) return [];
  const geometry = mesh.geometry;
  const positions = geometry.getAttribute('position');
  if (!positions) return [];

  mesh.updateWorldMatrix(true, false);
  const matrixWorld = mesh.matrixWorld;
  const index = geometry.getIndex();
  const triangleCount = index ? index.count / 3 : positions.count / 3;
  const segments = [];
  const seen = new Set();

  const readVertex = (vertexIndex) =>
    new THREE.Vector3(
      positions.getX(vertexIndex),
      positions.getY(vertexIndex),
      positions.getZ(vertexIndex),
    ).applyMatrix4(matrixWorld);

  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex++) {
    const base = triangleIndex * 3;
    const ia = index ? index.getX(base) : base;
    const ib = index ? index.getX(base + 1) : base + 1;
    const ic = index ? index.getX(base + 2) : base + 2;
    const segment = intersectTriangleAtZ(
      readVertex(ia),
      readVertex(ib),
      readVertex(ic),
      z,
      tolerance,
    );
    if (!segment) continue;

    const key = segmentKey(segment, tolerance);
    if (seen.has(key)) continue;
    seen.add(key);
    segments.push(segment);
  }
  return segments;
}

/**
 * Segment群を端点接続し、閉ループへ変換する。
 * @param {Array<{start:THREE.Vector3,end:THREE.Vector3}>} segments
 * @param {number} [tolerance=0.1]
 * @returns {Array<Array<THREE.Vector3>>}
 */
export function connectSectionSegmentsToLoops(segments, tolerance = DEFAULT_TOLERANCE) {
  const vertices = new Map();
  const edges = [];

  const registerPoint = (point) => {
    const key = pointKey(point, tolerance);
    if (!vertices.has(key)) vertices.set(key, { point: point.clone(), edges: [] });
    return key;
  };

  for (const segment of segments || []) {
    const startKey = registerPoint(segment.start);
    const endKey = registerPoint(segment.end);
    if (startKey === endKey) continue;
    const edgeIndex = edges.length;
    edges.push({ startKey, endKey });
    vertices.get(startKey).edges.push(edgeIndex);
    vertices.get(endKey).edges.push(edgeIndex);
  }

  const visited = new Set();
  const loops = [];

  for (let seed = 0; seed < edges.length; seed++) {
    if (visited.has(seed)) continue;
    const startKey = edges[seed].startKey;
    let currentKey = startKey;
    let edgeIndex = seed;
    const loop = [];
    let closed = false;

    for (let guard = 0; guard <= edges.length + 1; guard++) {
      if (visited.has(edgeIndex)) break;
      visited.add(edgeIndex);
      const edge = edges[edgeIndex];
      const nextKey = edge.startKey === currentKey ? edge.endKey : edge.startKey;
      loop.push(vertices.get(currentKey).point.clone());
      currentKey = nextKey;

      if (currentKey === startKey) {
        closed = true;
        break;
      }

      const nextEdge = vertices.get(currentKey).edges.find((candidate) => !visited.has(candidate));
      if (nextEdge == null) break;
      edgeIndex = nextEdge;
    }

    if (closed && loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function isCollinear2D(prev, current, next, tolerance) {
  const ax = current.x - prev.x;
  const ay = current.y - prev.y;
  const bx = next.x - current.x;
  const by = next.y - current.y;
  const cross = ax * by - ay * bx;
  const scale = Math.max(Math.hypot(ax, ay) * Math.hypot(bx, by), 1);
  if (Math.abs(cross) > tolerance * scale) return false;

  // 180度折返しは削除しない。進行方向が同じ場合のみ中間点とみなす。
  return ax * bx + ay * by >= 0;
}

/**
 * 三角形分割由来の共線中間点を閉ループから除去する。
 * @param {Array<THREE.Vector3>} loop
 * @param {number} [tolerance=0.1]
 * @returns {Array<THREE.Vector3>}
 */
export function simplifySectionLoop(loop, tolerance = DEFAULT_TOLERANCE) {
  let result = (loop || []).map((p) => p.clone());
  if (result.length <= 3) return result;

  let changed = true;
  while (changed && result.length > 3) {
    changed = false;
    const nextResult = [];
    for (let i = 0; i < result.length; i++) {
      const prev = result[(i - 1 + result.length) % result.length];
      const current = result[i];
      const next = result[(i + 1) % result.length];
      if (isCollinear2D(prev, current, next, tolerance)) {
        changed = true;
        continue;
      }
      nextResult.push(current);
    }
    if (nextResult.length < 3) break;
    result = nextResult;
  }
  return result;
}

/**
 * メッシュの水平断面を閉ループとして取得する。
 * Wallは外周メタデータを優先し、StbOpenの穴をWallレイヤへ反映しない。
 * 開口自体はDxfOpeningCollectorからOpenレイヤへ独立出力する。
 *
 * @param {THREE.Mesh} mesh
 * @param {number} z
 * @param {number} [tolerance=0.1]
 * @returns {Array<Array<THREE.Vector3>>}
 */
export function extractHorizontalSectionLoops(mesh, z, tolerance = DEFAULT_TOLERANCE) {
  const wallOuterLoops = extractWallOuterSectionLoops(mesh, z, tolerance);
  if (wallOuterLoops !== null) {
    return wallOuterLoops
      .map((loop) => simplifySectionLoop(loop, tolerance))
      .filter((loop) => loop.length >= 3);
  }

  const rawSegments = extractRawHorizontalSectionSegments(mesh, z, tolerance);
  return connectSectionSegmentsToLoops(rawSegments, tolerance)
    .map((loop) => simplifySectionLoop(loop, tolerance))
    .filter((loop) => loop.length >= 3);
}

/**
 * メッシュと水平面の交線Segmentを取得する。
 * 三角形分割で細分された共線Segmentは、閉ループ正規化後の辺へ統合して返す。
 * @param {THREE.Mesh} mesh
 * @param {number} z
 * @param {number} [tolerance=0.1]
 * @returns {Array<{start:THREE.Vector3,end:THREE.Vector3}>}
 */
export function extractHorizontalSectionSegments(mesh, z, tolerance = DEFAULT_TOLERANCE) {
  const segments = [];
  for (const loop of extractHorizontalSectionLoops(mesh, z, tolerance)) {
    for (let i = 0; i < loop.length; i++) {
      segments.push({
        start: loop[i].clone(),
        end: loop[(i + 1) % loop.length].clone(),
      });
    }
  }
  return segments;
}

export { DEFAULT_TOLERANCE };
