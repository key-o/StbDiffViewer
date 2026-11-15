/**
 * #510: In-plane, rectangular STB wall face outlines for axis elevations.
 * 2D model coordinates derive from the wall's STB nodes, never the 3D camera.
 * Wall thickness/oblique planes/openings need dedicated geometry and must not
 * be silently represented as complete solids.
 */
import { createElementRef, elementRefKey } from '../../data/drawing/drawingModel.js';
import { resolveWallElevationContours } from './axisElevationWallOpenings.js';

const EPS = 1e-6;

function uniqueCoordinates(values) {
  const unique = [];
  for (const value of values) {
    if (!unique.some((item) => Math.abs(item - value) <= EPS)) unique.push(value);
  }
  return unique;
}

function warn(drawing, key, detail) {
  drawing.diagnostics.push({
    code: 'ELEVATION_WALL_OUTLINE_UNSUPPORTED',
    elementKey: key,
    detail,
  });
}

function readWallOffsets(wall, ids) {
  const offsets = new Map();
  for (const element of Array.from(wall.getElementsByTagNameNS('*', 'StbWallOffset'))) {
    const id = element.getAttribute('id_node');
    if (!id || !ids.includes(id) || offsets.has(id))
      throw new Error('壁の節点オフセットIDに欠落・重複・未知参照があります。');
    const axisValues = ['X', 'Y', 'Z'].map((axis) => {
      const raw = element.getAttribute('offset_' + axis);
      const value = raw == null ? 0 : Number(raw);
      if (raw === '' || !Number.isFinite(value))
        throw new Error('壁の節点オフセット値が不正です。');
      return value;
    });
    offsets.set(id, axisValues);
  }
  return offsets;
}

export function addAxisElevationWallOutlines({ drawing, document, nodes } = {}) {
  if (drawing?.view?.type !== 'elevation' || drawing?.source?.modelKey !== 'A')
    throw new TypeError('STB-Aの軸組図DrawingModelが必要です。');
  if (document?.nodeType !== 9) throw new TypeError('STB XML Documentが必要です。');
  const axis = drawing.view.axisDirection;
  if (!['X', 'Y'].includes(axis)) throw new TypeError('通り芯方向が不正です。');
  const depthAxis = axis === 'X' ? 'x' : 'y';
  const horizontalAxis = axis === 'X' ? 'y' : 'x';
  const nodeIndex = new Map((nodes || []).map((node) => [String(node.id), node]));
  const seen = new Set();
  let count = 0;

  for (const wall of Array.from(document.getElementsByTagNameNS('*', 'StbWall'))) {
    const id = wall.getAttribute('id');
    if (!id || seen.has(id)) throw new Error('StbWall IDが欠落または重複しています。');
    seen.add(id);
    const ref = createElementRef(drawing.source, 'Wall', id, wall.getAttribute('guid'));
    const key = elementRefKey(ref);
    const order = wall.getElementsByTagNameNS('*', 'StbNodeIdOrder')[0]?.textContent?.trim();
    if (!order) {
      warn(drawing, key, '壁の節点順序がありません。');
      continue;
    }
    const ids = order.split(/\s+/);
    if (ids.length !== 4 || new Set(ids).size !== 4) {
      warn(drawing, key, '四隅を持つ矩形壁以外の輪郭には未対応です。');
      continue;
    }
    let points3d;
    try {
      const offsets = readWallOffsets(wall, ids);
      points3d = ids.map((nodeId) => {
        const node = nodeIndex.get(nodeId);
        if (!node || ![node.x, node.y, node.z].every(Number.isFinite))
          throw new Error(`壁 ${id} の節点 ${nodeId} が見つかりません。`);
        const [dx, dy, dz] = offsets.get(nodeId) || [0, 0, 0];
        return { x: node.x + dx, y: node.y + dy, z: node.z + dz };
      });
    } catch (error) {
      // One malformed wall must not suppress other valid wall/member outlines.
      warn(drawing, key, error instanceof Error ? error.message : String(error));
      continue;
    }
    const depth = points3d.map((point) => point[depthAxis]);
    // 奥行範囲外の壁は図面に関係しないため、面外判定や診断より先に除外する。
    if (
      Math.max(...depth) < drawing.view.lowerBound - EPS ||
      Math.min(...depth) > drawing.view.upperBound + EPS
    )
      continue;
    if (Math.max(...depth) - Math.min(...depth) > EPS) {
      warn(drawing, key, '斜め壁・奥行方向の壁は面外投影のため未対応です。');
      continue;
    }
    const points = points3d.map((node) => [node[horizontalAxis], node.z]);
    const xs = uniqueCoordinates(points.map(([x]) => x));
    const ys = uniqueCoordinates(points.map(([, y]) => y));
    if (
      xs.length !== 2 ||
      ys.length !== 2 ||
      Math.abs(xs[1] - xs[0]) <= EPS ||
      Math.abs(ys[1] - ys[0]) <= EPS ||
      points.some((point, index) =>
        points
          .slice(index + 1)
          .some(
            (candidate) =>
              Math.abs(point[0] - candidate[0]) <= EPS && Math.abs(point[1] - candidate[1]) <= EPS,
          ),
      ) ||
      // NodeIdOrder is the wall perimeter. A bow-tie/crossed ordering cannot
      // be silently canonicalized into a solid rectangle.
      points.some(([x0, y0], index) => {
        const [x1, y1] = points[(index + 1) % points.length];
        return Math.abs(x0 - x1) <= EPS === Math.abs(y0 - y1) <= EPS;
      })
    ) {
      warn(drawing, key, '壁面の投影が矩形として確定できません。');
      continue;
    }
    // STB may list rectangle corners in different winding/order. Canonicalize
    // the four corners only after verifying this really is an axis rectangle.
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const canonical = [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ];
    if (
      !canonical.every(([x, y]) =>
        points.some(([px, py]) => Math.abs(px - x) <= EPS && Math.abs(py - y) <= EPS),
      )
    ) {
      warn(drawing, key, '壁の四隅が完全な矩形として成立しません。');
      continue;
    }
    let resolved;
    try {
      resolved = resolveWallElevationContours({
        document,
        wall,
        points3d,
        axisDirection: axis,
        wallBounds: { left: minX, right: maxX, bottom: minY, top: maxY },
      });
    } catch (error) {
      // Invalid opening data is scoped to its wall; other valid walls still
      // appear, while the offending wall is omitted with an explicit warning.
      const detail = error instanceof Error ? error.message : String(error);
      warn(drawing, key, `壁開口の解析に失敗しました: ${detail}`);
      continue;
    }
    if (resolved.status !== 'outlines') {
      warn(drawing, key, resolved.reason);
      continue;
    }
    const primitiveIds = [];
    drawing.elements.push({
      key,
      ref,
      renderType: 'Wall',
      state: 'drawn',
      mark: wall.getAttribute('name') || '',
      sectionId: wall.getAttribute('id_section'),
      taggable: false,
      primitiveIds,
    });
    resolved.contours.forEach((contour, index) => {
      const primitiveId = JSON.stringify([
        key,
        index === 0 ? 'elevation-wall-outline' : 'elevation-wall-opening-' + index,
      ]);
      primitiveIds.push(primitiveId);
      drawing.primitives.push({
        id: primitiveId,
        kind: 'polyline',
        role: index === 0 ? 'member-outline' : 'wall-opening-outline',
        closed: true,
        ref,
        elementKey: key,
        points: contour,
      });
    });
    for (const [x, y] of points) {
      drawing.bounds.minX = Math.min(drawing.bounds.minX, x);
      drawing.bounds.maxX = Math.max(drawing.bounds.maxX, x);
      drawing.bounds.minY = Math.min(drawing.bounds.minY, y);
      drawing.bounds.maxY = Math.max(drawing.bounds.maxY, y);
    }
    count++;
  }
  return count;
}
