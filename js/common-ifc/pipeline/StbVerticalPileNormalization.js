/**
 * Convert only independently measured, vertical IFC pile endpoints into the
 * ST-Bridge 2.1 one-node representation. Neither an inclined pile nor the
 * identity of a legacy two-node pile can be preserved by this encoding.
 */
const HORIZONTAL_TOLERANCE_MM = 1e-6;
const LENGTH_TOLERANCE_MM = 1e-3;

export function normalizeVerticalIfcPile(start, end, startId, endId, profileLength, source = null) {
  if (source?.format === '2node') {
    throw new Error('StbPile: source two-node topology cannot be preserved in ST-Bridge 2.1');
  }
  if (source?.format != null && source.format !== '1node') {
    throw new Error(`StbPile: unsupported source node format ${source.format}`);
  }
  const finitePoint = (point) =>
    point != null && ['x', 'y', 'z'].every((axis) => Number.isFinite(point[axis]));
  if (!finitePoint(start) || !finitePoint(end)) {
    throw new Error('StbPile: both measured IFC endpoints must have finite XYZ coordinates');
  }
  if (
    Math.abs(start.x - end.x) > HORIZONTAL_TOLERANCE_MM ||
    Math.abs(start.y - end.y) > HORIZONTAL_TOLERANCE_MM
  ) {
    throw new Error(
      'StbPile: inclined IFC pile cannot be represented by a ST-Bridge 2.1 single node',
    );
  }
  if (profileLength != null && (!Number.isFinite(profileLength) || profileLength < 0)) {
    throw new Error('StbPile: invalid measured IFC profile length');
  }
  const height = Math.abs(start.z - end.z);
  if (!Number.isFinite(height) || height <= 0) {
    throw new Error('StbPile: zero-length or invalid measured IFC pile');
  }
  if (
    Number.isFinite(profileLength) &&
    profileLength > 0 &&
    Math.abs(profileLength - height) > LENGTH_TOLERANCE_MM
  ) {
    throw new Error('StbPile: measured IFC profile length disagrees with endpoint distance');
  }
  const isStartTop = start.z >= end.z;
  const nodeSingle = isStartTop ? startId : endId;
  if (nodeSingle === undefined || nodeSingle === null || nodeSingle === '') {
    throw new Error('StbPile: top structural node ID is unavailable');
  }
  return {
    pileFormat: '1node',
    nodeSingle,
    levelTop: isStartTop ? start.z : end.z,
    lengthAll: height,
  };
}
