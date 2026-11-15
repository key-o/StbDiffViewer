/**
 * CAD 2D mouse tools. A projected *closed* outline has pickable edges; open
 * centre-lines are deliberately excluded because they are not member faces.
 * Coordinates here are immutable model-space mm, never SVG or screen pixels.
 */

function point2d(point) {
  return Array.isArray(point) && point.length === 2 && point.every(Number.isFinite);
}

export function collectCadPlanEdges(drawing, { elementKey = null, visibleTypes = null } = {}) {
  const records = new Map(
    (drawing?.elements || [])
      .filter(
        (record) =>
          record?.ref?.modelKey === 'A' &&
          record?.state === 'drawn' &&
          (elementKey == null || record.key === elementKey),
      )
      .map((record) => [record.key, record]),
  );
  const edges = [];
  for (const primitive of drawing?.primitives || []) {
    const record = records.get(primitive.elementKey);
    if (!record || primitive.kind !== 'polyline' || primitive.closed !== true) continue;
    if (visibleTypes?.[record.renderType || record.ref.elementType] === false) continue;
    const points = primitive.points;
    if (!Array.isArray(points) || points.length < 3 || !points.every(point2d)) continue;
    for (let index = 0; index < points.length; index++) {
      const start = points[index];
      const end = points[(index + 1) % points.length];
      if (Math.hypot(end[0] - start[0], end[1] - start[1]) <= 1e-7) continue;
      edges.push({
        elementKey: record.key,
        ref: record.ref,
        start: [...start],
        end: [...end],
        index,
      });
    }
  }
  return edges;
}

/**
 * Move a projected source face onto the parallel target face along its normal.
 * Parallel in plan is mandatory; arbitrary angled edges must not be 'aligned'
 * by projecting onto an unrelated plane.
 */
export function planCadFaceAlignment(source, target, { angleToleranceDeg = 0.001 } = {}) {
  if (!source || !target) throw new Error('移動元と基準側の辺を選択してください。');
  if (!source.elementKey || !target.elementKey || source.elementKey === target.elementKey)
    throw new Error('移動元とは別の部材の辺を選択してください。');
  if (![source.start, source.end, target.start, target.end].every(point2d))
    throw new TypeError('辺のモデル座標が不正です。');
  const sx = source.end[0] - source.start[0];
  const sy = source.end[1] - source.start[1];
  const tx = target.end[0] - target.start[0];
  const ty = target.end[1] - target.start[1];
  const sl = Math.hypot(sx, sy);
  const tl = Math.hypot(tx, ty);
  if (sl <= 1e-7 || tl <= 1e-7) throw new Error('長さのない辺は使用できません。');
  const parallel = Math.abs((sx * tx + sy * ty) / (sl * tl));
  if (!Number.isFinite(angleToleranceDeg) || angleToleranceDeg < 0 || angleToleranceDeg >= 90)
    throw new RangeError('平行判定角度が不正です。');
  if (parallel < Math.cos((angleToleranceDeg * Math.PI) / 180) - 1e-12)
    throw new Error('選択した2辺が平行ではありません。別の辺を指定してください。');
  const nx = -sy / sl;
  const ny = sx / sl;
  const distance =
    (target.start[0] - source.start[0]) * nx + (target.start[1] - source.start[1]) * ny;
  const delta = { x: distance * nx + 0, y: distance * ny + 0, z: 0 };
  return {
    delta,
    distanceMm: Math.abs(distance),
    changed: Math.abs(distance) > 1e-7,
    // Exact edge-edge coincidence requires truly parallel edges. The small
    // tolerance is a pick aid, not a rotation or deformation command.
    parallelErrorDeg: (Math.acos(Math.min(1, parallel)) * 180) / Math.PI,
  };
}

export function cadTwoPointVector(source, target) {
  if (!point2d(source) || !point2d(target))
    throw new TypeError('2点移動には有効な平面上の始点・終点が必要です。');
  const delta = { x: target[0] - source[0], y: target[1] - source[1], z: 0 };
  return { delta, changed: Math.hypot(delta.x, delta.y) > 1e-7 };
}
