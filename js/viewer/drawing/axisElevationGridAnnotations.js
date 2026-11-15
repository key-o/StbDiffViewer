/**
 * @fileoverview #510: orthogonal axis-elevation grid annotations.
 * Bubbles are always BELOW the lowest story, in model mm; never camera-derived.
 */
export const AXIS_ELEVATION_GRID_BUBBLE_RADIUS_MM = 650;
export const AXIS_ELEVATION_GRID_BUBBLE_BELOW_MM = 2400;
export const AXIS_ELEVATION_GRID_TOP_EXTEND_MM = 1200;

const EPSILON_MM = 1e-6;

function alignedWithCardinalAxis(angle, direction) {
  if (angle == null) return true;
  const numeric = Number(angle);
  if (!Number.isFinite(numeric)) return false;
  const actual = ((numeric % 180) + 180) % 180;
  const expected = direction === 'X' ? 90 : 0;
  const delta = Math.abs(actual - expected);
  return Math.min(delta, 180 - delta) < 1e-6;
}

function requireBounds(bounds) {
  if (
    !bounds ||
    ![bounds.minX, bounds.maxX, bounds.minY, bounds.maxY].every(Number.isFinite) ||
    bounds.minX >= bounds.maxX ||
    bounds.minY > bounds.maxY
  ) {
    throw new TypeError('立面ビューの図面範囲が不正です。');
  }
}

/**
 * X grid elevation (YZ) shows intersecting Y grids.
 * Y grid elevation (XZ) shows intersecting X grids.
 * @returns {{annotations: object[], bounds: object, axisCount: number}}
 */
export function buildAxisElevationGridAnnotations({
  axesData,
  view,
  bounds,
  axisGuidById = new Map(),
} = {}) {
  if (!(axisGuidById instanceof Map)) throw new TypeError('通り芯GUID対応表が不正です。');
  requireBounds(bounds);
  if (view?.type !== 'elevation' || !['X', 'Y'].includes(view?.axisDirection))
    throw new TypeError('通り芯立面ビューが必要です。');
  if (view.axisDirection === 'X' && view.planeAxes?.join(',') !== 'Y,Z')
    throw new TypeError('X通りの立面投影面が不正です。');
  if (view.axisDirection === 'Y' && view.planeAxes?.join(',') !== 'X,Z')
    throw new TypeError('Y通りの立面投影面が不正です。');

  const perpendicular = view.axisDirection === 'X' ? 'Y' : 'X';
  const axes = perpendicular === 'X' ? axesData?.xAxes : axesData?.yAxes;
  if (!Array.isArray(axes)) throw new TypeError('交差通り芯データがありません。');
  const coordinate = perpendicular.toLowerCase();
  const radius = AXIS_ELEVATION_GRID_BUBBLE_RADIUS_MM;
  const bubbleY = bounds.minY - AXIS_ELEVATION_GRID_BUBBLE_BELOW_MM;
  const topY = bounds.maxY + AXIS_ELEVATION_GRID_TOP_EXTEND_MM;
  const gridBottomY = bubbleY + radius;
  const visibleAxes = [];
  const seenIds = new Set();

  for (const axis of axes) {
    if (axis?.axisKind !== 'parallel' || !alignedWithCardinalAxis(axis.angle, perpendicular)) {
      throw new Error('交差通り芯に斜め・円弧・放射軸があり、正立面への投影に未対応です。');
    }
    const id = String(axis.id ?? '').trim();
    const name = String(axis.name ?? '').trim();
    const x = axis[coordinate] == null || axis[coordinate] === '' ? NaN : Number(axis[coordinate]); // world coordinate, not group-relative distance
    if (!id || !name || !Number.isFinite(x) || seenIds.has(id))
      throw new TypeError('交差通り芯のID・名称・世界座標に欠落または重複があります。');
    seenIds.add(id);
    if (x < bounds.minX - EPSILON_MM || x > bounds.maxX + EPSILON_MM) continue;
    visibleAxes.push({ id, name, x });
  }

  visibleAxes.sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));
  const annotations = [];
  for (const { id, name, x } of visibleAxes) {
    const key = `elevation-grid-${perpendicular}-${id}`;
    annotations.push(
      Object.freeze({
        id: `${key}-line`,
        kind: 'line',
        role: 'grid',
        axisName: name,
        points: Object.freeze([
          [x, gridBottomY],
          [x, topY],
        ]),
      }),
      Object.freeze({
        id: `${key}-bubble-bottom`,
        kind: 'circle',
        role: 'grid-bubble',
        axisName: name,
        center: Object.freeze([x, bubbleY]),
        radius,
      }),
      Object.freeze({
        id: `${key}-label-bottom`,
        kind: 'text',
        role: 'grid-label',
        axisName: name,
        point: Object.freeze([x, bubbleY]),
        anchor: 'middle',
        text: name,
      }),
    );
  }

  // #423: expose exactly the crossing, visible STB axes that generated the
  // grid lines. Saved dimension bindings must resolve against source identity,
  // never against screen geometry or a guessed closest line.
  const dimensionReferences = visibleAxes.map(({ id, name, x }) =>
    Object.freeze({
      id: `parallel:${id}`,
      kind: 'axis',
      axisKind: 'parallel',
      name,
      sourceRef: Object.freeze({
        elementType: 'ParallelAxis',
        elementId: id,
        guid: axisGuidById.get(id) ?? null,
      }),
      coordinateKey: 'x',
      coordinateValue: x,
    }),
  );

  return Object.freeze({
    annotations: Object.freeze(annotations),
    dimensionReferences: Object.freeze(dimensionReferences),
    bounds: Object.freeze({
      ...bounds,
      minY: visibleAxes.length ? Math.min(bounds.minY, bubbleY - radius) : bounds.minY,
      maxY: visibleAxes.length ? Math.max(bounds.maxY, topY) : bounds.maxY,
    }),
    axisCount: visibleAxes.length,
  });
}
