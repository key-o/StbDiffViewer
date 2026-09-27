/**
 * @fileoverview STB構造平面図DXF用の要素別切断高さ解決
 *
 * 構造平面図では、柱・壁などの鉛直部材は階上方の切断高さで断面を取り、
 * 梁・床など階レベルに配置される水平部材は階レベル付近で断面を取る。
 * これにより1つのZ平面だけでは同時に取得できない構造平面図要素を、
 * それぞれの完成済みMeshから閉断面として取得する。
 */

export const DEFAULT_PLAN_CUT_OFFSET = 1500;
export const DEFAULT_PLAN_CUT_TOLERANCE = 0.1;

const VERTICAL_PLAN_TYPES = new Set(['Column', 'Post', 'Wall', 'Brace', 'FoundationColumn']);

/**
 * 階クリップ状態から基準階Zを取得する。
 * @param {Object|null} clippingState
 * @returns {number|null}
 */
export function getStoryBaseZ(clippingState) {
  if (clippingState?.type !== 'story') return null;
  const bounds = clippingState.bounds || {};

  if (bounds.height != null && Number.isFinite(Number(bounds.height))) {
    return Number(bounds.height);
  }
  if (
    bounds.lowerBound != null &&
    bounds.upperBound != null &&
    Number.isFinite(Number(bounds.lowerBound)) &&
    Number.isFinite(Number(bounds.upperBound))
  ) {
    return (Number(bounds.lowerBound) + Number(bounds.upperBound)) / 2;
  }
  return null;
}

/**
 * 要素タイプに応じた構造平面図の目標切断Zを返す。
 * @param {string} elementType
 * @param {number} storyBaseZ
 * @param {number} [planCutOffset=1500]
 * @returns {number}
 */
export function getPlanTargetZ(elementType, storyBaseZ, planCutOffset = DEFAULT_PLAN_CUT_OFFSET) {
  return VERTICAL_PLAN_TYPES.has(elementType)
    ? storyBaseZ + Number(planCutOffset || 0)
    : storyBaseZ;
}

function intersectsStoryClipBand(box, clippingState, tolerance) {
  const bounds = clippingState?.bounds || {};
  const lower = Number(bounds.lowerBound);
  const upper = Number(bounds.upperBound);
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return true;
  return Number(box.max.z) >= lower - tolerance && Number(box.min.z) <= upper + tolerance;
}

/**
 * Meshに適用する構造平面図切断Zを返す。
 *
 * 鉛直部材:
 * - FL+planCutOffsetを実際に横切る場合だけ採用する。
 * - 共有階境界へのfallbackを行わず、上下階の二重計上を防ぐ。
 *
 * 水平部材:
 * - 基本は階レベルを切る。
 * - offset_Z等で階レベルから外れた場合も、階クリップ帯内ならMeshの最近傍Zへ
 *   切断高さをスナップし、構造平面図から欠落させない。
 *
 * @param {string} elementType
 * @param {THREE.Box3|Object} box
 * @param {Object|null} clippingState
 * @param {number} [planCutOffset=1500]
 * @param {number} [tolerance=0.1]
 * @returns {number|null}
 */
export function resolveStoryPlanCutZ(
  elementType,
  box,
  clippingState,
  planCutOffset = DEFAULT_PLAN_CUT_OFFSET,
  tolerance = DEFAULT_PLAN_CUT_TOLERANCE,
) {
  const storyBaseZ = getStoryBaseZ(clippingState);
  if (storyBaseZ == null || !box?.min || !box?.max) return null;

  const minZ = Number(box.min.z);
  const maxZ = Number(box.max.z);
  const targetZ = getPlanTargetZ(elementType, storyBaseZ, planCutOffset);

  if (targetZ >= minZ - tolerance && targetZ <= maxZ + tolerance) {
    return Math.min(Math.max(targetZ, minZ), maxZ);
  }

  if (VERTICAL_PLAN_TYPES.has(elementType)) return null;
  if (!intersectsStoryClipBand(box, clippingState, tolerance)) return null;

  if (storyBaseZ < minZ) return minZ;
  if (storyBaseZ > maxZ) return maxZ;
  return storyBaseZ;
}

export { VERTICAL_PLAN_TYPES };
