/**
 * @fileoverview SectionBox handle visibility helpers for drawing views.
 *
 * In an axis-aligned orthographic drawing view, the handle whose movement axis
 * is parallel to the camera depth direction cannot be dragged meaningfully.
 * Hide that pair while keeping all handles available in 3D/isometric views.
 */

const DEPTH_AXIS_BY_VIEW = Object.freeze({
  top: 'z',
  bottom: 'z',
  front: 'y',
  back: 'y',
  right: 'x',
  left: 'x',
});

const AXES = Object.freeze(['x', 'y', 'z']);
const AXIS_ALIGNMENT_THRESHOLD = 0.999;

/**
 * Axis-aligned view nameから画面奥行き方向のworld axisを返す。
 * 斜め/等角投影では単一world axisが奥行きにならないためnull。
 * @param {string|null|undefined} viewType
 * @returns {'x'|'y'|'z'|null}
 */
export function getDepthAxisForView(viewType) {
  return DEPTH_AXIS_BY_VIEW[viewType] ?? null;
}

/**
 * Camera world directionから、ほぼ完全に平行なworld axisだけを返す。
 * viewTypeを取得できない初期化経路のfallbackとして使用する。
 * @param {{x:number,y:number,z:number}|null|undefined} direction
 * @returns {'x'|'y'|'z'|null}
 */
export function getDepthAxisForDirection(direction) {
  if (!direction) return null;

  let bestAxis = null;
  let bestAlignment = 0;
  for (const axis of AXES) {
    const alignment = Math.abs(Number(direction[axis]) || 0);
    if (alignment > bestAlignment) {
      bestAlignment = alignment;
      bestAxis = axis;
    }
  }

  return bestAlignment >= AXIS_ALIGNMENT_THRESHOLD ? bestAxis : null;
}

/**
 * @param {string|null|undefined} viewType
 * @param {{x:number,y:number,z:number}|null|undefined} cameraDirection
 * @returns {'x'|'y'|'z'|null}
 */
export function resolveDrawingDepthAxis(viewType, cameraDirection = null) {
  return getDepthAxisForView(viewType) ?? getDepthAxisForDirection(cameraDirection);
}
