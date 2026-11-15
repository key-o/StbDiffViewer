/** STB-origin-only provenance for beam foundation flags and physical-end offsets. */
const PREFIX = 'STBBEAM_META:';
const AXES = ['x', 'y', 'z'];
const SIDES = ['start', 'end'];

function validOffsets(offsets) {
  if (!offsets || typeof offsets !== 'object' || Array.isArray(offsets)) return null;
  const result = {};
  for (const side of SIDES) {
    const value = offsets[side];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const coordinates = {};
    for (const axis of AXES) {
      const coordinate = value[axis];
      if (
        typeof coordinate !== 'number' ||
        !Number.isFinite(coordinate) ||
        Math.abs(coordinate) > 1e9
      )
        return null;
      coordinates[axis] = coordinate;
    }
    result[side] = coordinates;
  }
  return result;
}

export function encodeBeamMetadata(beam) {
  const data = {};
  if (typeof beam?.isFoundation === 'boolean') data.isFoundation = beam.isFoundation;
  const offsets = validOffsets(beam?.sourceBeamOffsets);
  if (offsets && SIDES.some((side) => AXES.some((axis) => offsets[side][axis] !== 0)))
    data.offsets = offsets;
  return Object.keys(data).length ? PREFIX + JSON.stringify(data) : null;
}

export function decodeBeamMetadata(description) {
  if (
    typeof description !== 'string' ||
    !description.startsWith(PREFIX) ||
    description.length > 512
  )
    return null;
  try {
    const data = JSON.parse(description.slice(PREFIX.length));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (data.isFoundation !== undefined && typeof data.isFoundation !== 'boolean') return null;
    const offsets = data.offsets === undefined ? null : validOffsets(data.offsets);
    if (data.offsets !== undefined && !offsets) return null;
    return typeof data.isFoundation === 'boolean' || offsets
      ? {
          ...(typeof data.isFoundation === 'boolean' ? { isFoundation: data.isFoundation } : {}),
          ...(offsets ? { offsets } : {}),
        }
      : null;
  } catch {
    return null;
  }
}
