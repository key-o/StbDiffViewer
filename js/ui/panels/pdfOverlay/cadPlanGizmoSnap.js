/** 2D CAD gizmo drag adapter: screen delta -> Working Document mm -> semantic Snap/Ortho. */
import { cadScreenDeltaToModelVector } from './cadGeometryGizmoMath.js';
import { cadPlanSnapToleranceMm, resolveCadPlanPointerPoint } from './cadPlanPointerSnap.js';
import { cadLiftEditVector } from './cadDrawingEditProjection.js';

/** SVG screen CTM can include zoom, rotation and mirroring. Translation is irrelevant to a delta. */
function screenDeltaToSvg(screenDelta, screenCtm) {
  const dx = Number(screenDelta?.dx);
  const dy = Number(screenDelta?.dy);
  if (![dx, dy].every(Number.isFinite)) throw new TypeError('ギズモの移動量が不正です。');
  if (!screenCtm) return { dx, dy };
  const { a, b, c, d } = screenCtm;
  if (![a, b, c, d].every(Number.isFinite)) throw new TypeError('SVGの画面変換が不正です。');
  const det = a * d - b * c;
  const size = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
  if (size === 0 || Math.abs(det) <= size * size * 1e-12)
    throw new RangeError('SVGの画面変換を逆算できません。');
  return { dx: (d * dx - c * dy) / det, dy: (-b * dx + a * dy) / det };
}

/**
 * Resolve the destination of the gizmo's model-space anchor (not the pointer location).
 * Restrict x/y handles to their explicit model axis, and use Ortho for a free-XY handle.
 * No geometry is mutated here; callers commit the returned delta once on pointerup.
 */
export function resolveCadPlanGizmoDrag({
  modelToSvg,
  originModel,
  projection = null,
  screenDelta,
  screenCtm = null,
  axis = 'xy',
  snapEngine = null,
  snap = false,
  ortho = false,
  excludeNodeIds = [],
  tolerancePx = 10,
} = {}) {
  if (
    !Array.isArray(originModel) ||
    originModel.length !== 2 ||
    !originModel.every(Number.isFinite)
  )
    throw new TypeError('ギズモの基準点が不正です。');
  if (!['x', 'y', 'xy'].includes(axis)) throw new TypeError('ギズモの軸が不正です。');
  const local = screenDeltaToSvg(screenDelta, screenCtm);
  const rawDelta = cadScreenDeltaToModelVector(modelToSvg, local);
  const rawPoint = [originModel[0] + rawDelta.x, originModel[1] + rawDelta.y];
  const resolved = resolveCadPlanPointerPoint(rawPoint, {
    snapEngine,
    startPoint: originModel,
    snap,
    ortho: ortho && axis === 'xy',
    axis: axis === 'x' ? 'X' : axis === 'y' ? 'Y' : null,
    excludeNodeIds,
    toleranceMm: cadPlanSnapToleranceMm(modelToSvg, screenCtm, tolerancePx),
  });
  const dx = Math.round((resolved.point[0] - originModel[0]) * 1e6) / 1e6;
  const dy = Math.round((resolved.point[1] - originModel[1]) * 1e6) / 1e6;
  const [a, b, c, d] = modelToSvg;
  return {
    delta: projection ? cadLiftEditVector(projection, [dx, dy]) : { x: dx, y: dy, z: 0 },
    offsetSvg: [a * dx + c * dy, b * dx + d * dy],
    snap: resolved.snap,
    orthoAxis: resolved.orthoAxis,
  };
}
