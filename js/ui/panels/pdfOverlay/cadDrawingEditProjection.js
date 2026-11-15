/**
 * Map the selected STB DrawingModel's 2D millimetre coordinates onto 3D world axes.
 * The producer emits elevation UV as Y/Z on an X-grid, or X/Z on a Y-grid.
 * A 2D gesture must never move the hidden (depth) model axis.
 */
const PROJECTIONS = Object.freeze({
  plan: Object.freeze({ horizontal: 'X', vertical: 'Y', depth: 'Z' }),
  X: Object.freeze({ horizontal: 'Y', vertical: 'Z', depth: 'X' }),
  Y: Object.freeze({ horizontal: 'X', vertical: 'Z', depth: 'Y' }),
});

export function cadDrawingEditProjection(view) {
  if (view?.type === 'plan') return PROJECTIONS.plan;
  if (view?.type !== 'elevation') return null;
  const projection = PROJECTIONS[view.axisDirection];
  if (
    !projection ||
    !Array.isArray(view.planeAxes) ||
    view.planeAxes.length !== 2 ||
    view.planeAxes[0] !== projection.horizontal ||
    view.planeAxes[1] !== projection.vertical ||
    view.depthAxis !== projection.depth ||
    ![view.lowerBound, view.upperBound].every(Number.isFinite) ||
    view.lowerBound >= view.upperBound
  )
    return null;
  return projection;
}

export function cadProjectEditPoint(projection, point) {
  if (!projection || !point) throw new TypeError('CAD投影またはモデル座標が不正です。');
  const u = Number(point[projection.horizontal.toLowerCase()]);
  const v = Number(point[projection.vertical.toLowerCase()]);
  if (![u, v].every(Number.isFinite)) throw new TypeError('CADモデル座標が不正です。');
  return [u, v];
}

export function cadLiftEditVector(projection, vector) {
  if (
    !projection ||
    !Array.isArray(vector) ||
    vector.length !== 2 ||
    !vector.every(Number.isFinite)
  )
    throw new TypeError('CAD平面移動量が不正です。');
  const delta = { x: 0, y: 0, z: 0 };
  delta[projection.horizontal.toLowerCase()] = vector[0];
  delta[projection.vertical.toLowerCase()] = vector[1];
  return delta;
}

export function cadEditDepthVisible(view, point, toleranceMm = 1e-7) {
  const projection = cadDrawingEditProjection(view);
  if (!projection || !point) return false;
  if (view.type !== 'elevation') return true;
  const depth = Number(point[projection.depth.toLowerCase()]);
  return (
    Number.isFinite(depth) &&
    depth >= view.lowerBound - toleranceMm &&
    depth <= view.upperBound + toleranceMm
  );
}

/** Same projection, axis ID and cut depth; not merely the same 'elevation' type. */
export function cadSameEditView(left, right) {
  const a = cadDrawingEditProjection(left);
  const b = cadDrawingEditProjection(right);
  if (!a || !b || left.type !== right.type) return false;
  if (left.type === 'plan') return String(left.storyId) === String(right.storyId);
  return (
    left.axisDirection === right.axisDirection &&
    String(left.axisId) === String(right.axisId) &&
    left.lowerBound === right.lowerBound &&
    left.upperBound === right.upperBound
  );
}
