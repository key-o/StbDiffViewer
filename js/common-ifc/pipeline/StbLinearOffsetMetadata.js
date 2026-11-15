/**
 * STB-origin-only structural-end offsets for columns/posts and braces.
 * IFC geometry represents physical endpoints; these values recover the
 * source analytical nodes without guessing offsets for third-party IFC.
 */
const PREFIX = 'STBLINEAR_OFFSET_META:';
const AXES = ['x', 'y', 'z'];
const SIDE_NAMES = {
  column: ['bottom', 'top'],
  brace: ['start', 'end'],
};

function validatedOffsets(kind, offsets) {
  const sides = SIDE_NAMES[kind];
  if (!sides || !offsets || typeof offsets !== 'object' || Array.isArray(offsets)) return null;
  const result = {};
  for (const side of sides) {
    const point = offsets[side];
    if (!point || typeof point !== 'object' || Array.isArray(point)) return null;
    result[side] = {};
    for (const axis of AXES) {
      const number = point[axis];
      if (typeof number !== 'number' || !Number.isFinite(number) || Math.abs(number) > 1e9)
        return null;
      result[side][axis] = number;
    }
  }
  return result;
}

export function encodeLinearOffsetMetadata(kind, sourceOffsets) {
  const offsets = validatedOffsets(kind, sourceOffsets);
  if (!offsets || !SIDE_NAMES[kind].some((side) => AXES.some((axis) => offsets[side][axis] !== 0)))
    return null;
  const description = PREFIX + JSON.stringify({ kind, offsets });
  return description.length <= 512 ? description : null;
}

export function decodeLinearOffsetMetadata(description, expectedKind) {
  if (
    !SIDE_NAMES[expectedKind] ||
    typeof description !== 'string' ||
    !description.startsWith(PREFIX) ||
    description.length > 512
  )
    return null;
  try {
    const data = JSON.parse(description.slice(PREFIX.length));
    if (!data || Array.isArray(data) || data.kind !== expectedKind) return null;
    const offsets = validatedOffsets(expectedKind, data.offsets);
    return offsets &&
      SIDE_NAMES[expectedKind].some((side) => AXES.some((axis) => offsets[side][axis] !== 0))
      ? offsets
      : null;
  } catch {
    return null;
  }
}
