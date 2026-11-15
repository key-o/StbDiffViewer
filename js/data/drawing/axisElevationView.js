/** @fileoverview 通り芯立面のview contract。通り芯を含む鉛直面を見る範囲を、scene/cameraに依存せず定義するpure helper。 */

export const DEFAULT_AXIS_ELEVATION_DEPTH = 2000;

// X通り芯(X=distance)は面がYZ、Y通り芯(Y=distance)は面がXZ。
const AXIS_ELEVATION_PLANES = Object.freeze({
  X: Object.freeze({
    planeAxes: Object.freeze(['Y', 'Z']),
    depthAxis: 'X',
    viewDirection: Object.freeze([-1, 0, 0]),
  }),
  Y: Object.freeze({
    planeAxes: Object.freeze(['X', 'Z']),
    depthAxis: 'Y',
    viewDirection: Object.freeze([0, 1, 0]),
  }),
});

export function createAxisElevationView(axesData, axisDirection, axisId, depth) {
  const plane = AXIS_ELEVATION_PLANES[axisDirection];
  if (!plane) throw new TypeError('通り芯方向はXまたはYで指定してください。');
  const axes = axisDirection === 'X' ? axesData?.xAxes : axesData?.yAxes;
  if (!Array.isArray(axes)) throw new TypeError('通り芯データが必要です。');
  if (axisId == null || !String(axisId).trim())
    throw new TypeError('対象通り芯を明示してください。');
  const axis = axes.find((candidate) => String(candidate?.id) === String(axisId));
  if (!axis) throw new Error('対象通り芯が見つかりません。');
  if (axis.axisKind !== 'parallel') throw new Error('円弧軸・放射軸の立面は未対応です。');
  // parseAxes provides world coordinates after the STB group origin and angle.
  // Raw 'distance' alone is not necessarily world X or Y.
  const rawAngle = axis.angle;
  if (rawAngle != null) {
    const angle = Number(rawAngle);
    const rotation = ((angle % 180) + 180) % 180;
    const aligned =
      Number.isFinite(angle) && Math.abs(rotation - (axisDirection === 'X' ? 90 : 0)) < 1e-6;
    if (!aligned) throw new Error('斜めの平行通り芯立面は未対応です。');
  }
  const actual = axisDirection === 'X' ? axis.x : axis.y;
  const position =
    actual == null
      ? axis.distance == null || axis.distance === ''
        ? NaN
        : Number(axis.distance)
      : Number(actual);
  if (!Number.isFinite(position)) throw new TypeError('通り芯位置が不正です。');
  const halfDepth = depth == null ? DEFAULT_AXIS_ELEVATION_DEPTH : Number(depth);
  if (!Number.isFinite(halfDepth) || halfDepth <= 0)
    throw new RangeError('立面の奥行範囲は正の数で指定してください。');

  return Object.freeze({
    type: 'elevation',
    axisDirection,
    axisId: String(axis.id),
    axisName: axis.name == null ? null : String(axis.name),
    position,
    lowerBound: position - halfDepth,
    upperBound: position + halfDepth,
    depthAxis: plane.depthAxis,
    planeAxes: plane.planeAxes,
    viewDirection: plane.viewDirection,
    cutPolicyKey: 'sdv-axis-elevation-v1',
    units: 'mm',
  });
}
