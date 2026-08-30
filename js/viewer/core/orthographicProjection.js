/**
 * @fileoverview OrthographicCamera の投影範囲計算を一元管理する純粋関数群。
 *
 * PerspectiveCamera側の既存ビュー設定を基準とし、正投影側の
 * left/right/top/bottom/zoom 更新をこのモジュールへ集約する。
 */

import * as THREE from 'three';

export const DEFAULT_ORTHOGRAPHIC_FIT_PADDING = 1.5;
const DEFAULT_VIEW_HEIGHT = 20000;
const MIN_VIEW_HEIGHT = 1;

/**
 * OrthographicCameraの現在のfrustum aspectを取得する。
 * @param {THREE.OrthographicCamera} camera
 * @returns {number}
 */
export function getOrthographicAspect(camera) {
  if (!camera?.isOrthographicCamera) return 1;
  const width = camera.right - camera.left;
  const height = camera.top - camera.bottom;
  return Number.isFinite(width) && Number.isFinite(height) && height > 0 ? width / height : 1;
}

/**
 * OrthographicCameraの表示高さを設定する。
 * @param {THREE.OrthographicCamera} camera
 * @param {number} viewHeight - frustum表示高さ（mm）
 * @param {number} aspect
 * @param {{resetZoom?: boolean}} [options]
 * @returns {boolean}
 */
export function setOrthographicViewHeight(camera, viewHeight, aspect, options = {}) {
  if (!camera?.isOrthographicCamera) return false;

  const safeHeight =
    Number.isFinite(viewHeight) && viewHeight > 0
      ? Math.max(viewHeight, MIN_VIEW_HEIGHT)
      : DEFAULT_VIEW_HEIGHT;
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const halfHeight = safeHeight / 2;
  const halfWidth = halfHeight * safeAspect;

  camera.left = -halfWidth;
  camera.right = halfWidth;
  camera.top = halfHeight;
  camera.bottom = -halfHeight;

  if (options.resetZoom) {
    camera.zoom = 1;
  }

  camera.updateProjectionMatrix();
  return true;
}

/**
 * 現在の表示高さとzoomを維持したままaspectだけ更新する。
 * @param {THREE.OrthographicCamera} camera
 * @param {number} aspect
 * @returns {boolean}
 */
export function resizeOrthographicFrustum(camera, aspect) {
  if (!camera?.isOrthographicCamera) return false;
  const currentViewHeight = camera.top - camera.bottom;
  return setOrthographicViewHeight(camera, currentViewHeight, aspect, { resetZoom: false });
}

/**
 * PerspectiveCameraでtarget面に見えている高さを取得する。
 * PerspectiveCameraの既存FOV/zoomをそのまま基準にする。
 * @param {THREE.PerspectiveCamera} perspectiveCamera
 * @param {number} distanceToTarget
 * @returns {number|null}
 */
export function getPerspectiveVisibleHeight(perspectiveCamera, distanceToTarget) {
  if (!perspectiveCamera?.isPerspectiveCamera) return null;
  if (!Number.isFinite(distanceToTarget) || distanceToTarget <= 0) return null;

  const effectiveFov =
    typeof perspectiveCamera.getEffectiveFOV === 'function'
      ? perspectiveCamera.getEffectiveFOV()
      : perspectiveCamera.fov;

  if (!Number.isFinite(effectiveFov) || effectiveFov <= 0) return null;

  return 2 * distanceToTarget * Math.tan(THREE.MathUtils.degToRad(effectiveFov) / 2);
}

/**
 * PerspectiveCameraの現在の見かけスケールをOrthographicCameraへ引き継ぐ。
 * @param {THREE.OrthographicCamera} orthographicCamera
 * @param {THREE.PerspectiveCamera} perspectiveCamera
 * @param {THREE.Vector3} target
 * @param {number} aspect
 * @returns {number|null} 適用した表示高さ
 */
export function matchOrthographicToPerspective(
  orthographicCamera,
  perspectiveCamera,
  target,
  aspect,
) {
  if (
    !orthographicCamera?.isOrthographicCamera ||
    !perspectiveCamera?.isPerspectiveCamera ||
    !target
  ) {
    return null;
  }

  const distance = perspectiveCamera.position.distanceTo(target);
  const viewHeight = getPerspectiveVisibleHeight(perspectiveCamera, distance);
  if (!viewHeight) return null;

  setOrthographicViewHeight(orthographicCamera, viewHeight, aspect, { resetZoom: true });
  return viewHeight;
}

function getBoundsCorners(bounds) {
  const { min, max } = bounds;
  return [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(min.x, max.y, max.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(max.x, max.y, max.z),
  ];
}

/**
 * モデル境界をカメラ面へ投影し、必要なfrustum表示高さを算定する。
 * @param {THREE.Box3|Object} bounds
 * @param {THREE.Vector3} position
 * @param {THREE.Vector3} target
 * @param {THREE.Vector3} up
 * @param {number} aspect
 * @param {number} [padding]
 * @returns {number|null}
 */
export function calculateOrthographicFitHeight(
  bounds,
  position,
  target,
  up,
  aspect,
  padding = DEFAULT_ORTHOGRAPHIC_FIT_PADDING,
) {
  if (!bounds?.min || !bounds?.max || !position || !target || !up) return null;
  if (!Number.isFinite(aspect) || aspect <= 0) return null;

  const forward = new THREE.Vector3().subVectors(target, position);
  if (forward.lengthSq() === 0) return null;
  forward.normalize();

  const right = new THREE.Vector3().crossVectors(forward, up);
  if (right.lengthSq() === 0) return null;
  right.normalize();

  const viewUp = new THREE.Vector3().crossVectors(right, forward).normalize();

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const offset = new THREE.Vector3();

  for (const point of getBoundsCorners(bounds)) {
    offset.subVectors(point, target);
    const x = offset.dot(right);
    const y = offset.dot(viewUp);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  const projectedWidth = Math.max(0, maxX - minX);
  const projectedHeight = Math.max(0, maxY - minY);
  const fitHeight = Math.max(projectedHeight, projectedWidth / aspect, MIN_VIEW_HEIGHT);
  const safePadding = Number.isFinite(padding) && padding > 0 ? padding : 1;

  return fitHeight * safePadding;
}

/**
 * モデル境界を現在のビュー方向へfitさせる。
 * @param {THREE.OrthographicCamera} camera
 * @param {THREE.Box3|Object} bounds
 * @param {THREE.Vector3} position
 * @param {THREE.Vector3} target
 * @param {THREE.Vector3} up
 * @param {number} aspect
 * @param {number} [padding]
 * @returns {number|null} 適用した表示高さ
 */
export function fitOrthographicToBounds(
  camera,
  bounds,
  position,
  target,
  up,
  aspect,
  padding = DEFAULT_ORTHOGRAPHIC_FIT_PADDING,
) {
  if (!camera?.isOrthographicCamera) return null;

  const viewHeight = calculateOrthographicFitHeight(
    bounds,
    position,
    target,
    up,
    aspect,
    padding,
  );
  if (!viewHeight) return null;

  setOrthographicViewHeight(camera, viewHeight, aspect, { resetZoom: true });
  return viewHeight;
}
