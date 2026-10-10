/** @fileoverview RequiredConcreteEnvelopeと既存コンクリートboundsの不足facts。 */

const FACE_ORDER = ['LEFT', 'RIGHT', 'BOTTOM', 'TOP', 'START', 'END'];

function finiteBounds(bounds) {
  return ['x', 'y', 'z'].every(
    (axis) =>
      Number.isFinite(Number(bounds?.min?.[axis])) &&
      Number.isFinite(Number(bounds?.max?.[axis])) &&
      Number(bounds.min[axis]) <= Number(bounds.max[axis]),
  );
}

function missingByFace(required, existing) {
  return {
    LEFT: Math.max(0, Number(existing.min.x) - Number(required.min.x)),
    RIGHT: Math.max(0, Number(required.max.x) - Number(existing.max.x)),
    BOTTOM: Math.max(0, Number(existing.min.y) - Number(required.min.y)),
    TOP: Math.max(0, Number(required.max.y) - Number(existing.max.y)),
    START: Math.max(0, Number(existing.min.z) - Number(required.min.z)),
    END: Math.max(0, Number(required.max.z) - Number(existing.max.z)),
  };
}

function blocked(reason, extra = {}) {
  return {
    resolved: true,
    satisfied: false,
    reason,
    missingByFace: {},
    missingFaces: [],
    rawRequiredMm: null,
    ...extra,
  };
}

export function evaluateConcreteDeficiency({
  requiredBounds,
  existingBounds,
  sourceType = 'REBAR_ENVELOPE',
  openingConflict = false,
  rebarCollision = false,
  supportTopologyResolved = true,
} = {}) {
  if (!supportTopologyResolved) return blocked('SUPPORT_TOPOLOGY_MISSING');
  if (openingConflict) return blocked('OPENING_CONFLICT');
  if (rebarCollision) return blocked('REBAR_COLLISION');
  if (!finiteBounds(requiredBounds) || !finiteBounds(existingBounds)) {
    return blocked('SPECIAL_DETAIL_REQUIRED', { resolved: false });
  }

  const missing = missingByFace(requiredBounds, existingBounds);
  const missingFaces = FACE_ORDER.filter((face) => missing[face] > 1e-9);
  if (missingFaces.length === 0) {
    return {
      resolved: true,
      satisfied: true,
      reason: null,
      missingByFace: missing,
      missingFaces,
      rawRequiredMm: 0,
    };
  }

  let reason = 'CONCRETE_ENVELOPE_MISSING';
  if (sourceType === 'REBAR_ANCHORAGE') reason = 'ANCHORAGE_CONCRETE_MISSING';
  if (sourceType === 'REBAR_BEND') reason = 'BEND_CONCRETE_MISSING';
  return {
    resolved: true,
    satisfied: false,
    reason,
    missingByFace: missing,
    missingFaces,
    rawRequiredMm: Math.max(...missingFaces.map((face) => missing[face])),
  };
}
