/**
 * @fileoverview ビュー方向管理モジュール
 *
 * カメラのビュー方向（Top, Front, Right, Left, Isometric）を管理します。
 * 2Dモード時の平面図・立面図の切り替えに使用します。
 */

import * as THREE from 'three';
import { controls, renderer, getActiveCamera } from '../core/core.js';
import { getCanvasAspect } from '../core/viewportMetrics.js';
import {
  fitOrthographicToBounds,
  setOrthographicViewHeight,
} from '../core/orthographicProjection.js';
import { reaffirmControlsForCurrentMode } from './cameraManagerImpl.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('viewer:camera:viewManagerImpl');

/**
 * ビュー方向定数
 */
export const VIEW_DIRECTIONS = {
  // 面ビュー (6個)
  TOP: 'top', // 平面図（上から見る、Z+方向から）
  BOTTOM: 'bottom', // 下から見る（Z-方向から）
  FRONT: 'front', // 正面図（Y-方向から見る）
  BACK: 'back', // 背面図（Y+方向から見る）
  RIGHT: 'right', // 右側面図（X+方向から見る）
  LEFT: 'left', // 左側面図（X-方向から見る）
  ISOMETRIC: 'iso', // 等角投影（斜め上から）

  // 辺ビュー (12個) - 2面の境界から45度で見る
  TOP_FRONT: 'top-front',
  TOP_BACK: 'top-back',
  TOP_RIGHT: 'top-right',
  TOP_LEFT: 'top-left',
  BOTTOM_FRONT: 'bottom-front',
  BOTTOM_BACK: 'bottom-back',
  BOTTOM_RIGHT: 'bottom-right',
  BOTTOM_LEFT: 'bottom-left',
  FRONT_RIGHT: 'front-right',
  FRONT_LEFT: 'front-left',
  BACK_RIGHT: 'back-right',
  BACK_LEFT: 'back-left',

  // 角ビュー (8個) - 3面の頂点から~35.26度で見る
  TOP_FRONT_RIGHT: 'top-front-right',
  TOP_FRONT_LEFT: 'top-front-left',
  TOP_BACK_RIGHT: 'top-back-right',
  TOP_BACK_LEFT: 'top-back-left',
  BOTTOM_FRONT_RIGHT: 'bottom-front-right',
  BOTTOM_FRONT_LEFT: 'bottom-front-left',
  BOTTOM_BACK_RIGHT: 'bottom-back-right',
  BOTTOM_BACK_LEFT: 'bottom-back-left',
};

// 現在のビュー方向
let currentView = VIEW_DIRECTIONS.ISOMETRIC;

/**
 * 現在のビュー方向を取得
 * @returns {string} 現在のビュー方向
 */
export function getCurrentView() {
  return currentView;
}

/**
 * ビュー方向を設定
 * @param {string} viewType - ビュー方向（VIEW_DIRECTIONS の値）
 * @param {Object} [modelBounds=null] - モデルの境界ボックス
 * @param {boolean} [enableTransition=false] - スムーズなカメラ移動を有効にするか
 * @returns {boolean} 設定が成功したかどうか
 */
export function setView(viewType, modelBounds = null, enableTransition = false) {
  const camera = getActiveCamera();
  if (!camera) {
    log.warn('[ViewManager] No active camera');
    return false;
  }

  // モデルの中心と距離を計算。
  // PerspectiveCamera側の既存位置決定ロジックは変更しない。
  const center = new THREE.Vector3(0, 0, 0);
  let distance = 20000; // デフォルト20m

  // Box3オブジェクトかチェック（min/maxプロパティを持つ）
  if (modelBounds && modelBounds.min && modelBounds.max) {
    // Box3の中心を計算
    modelBounds.getCenter(center);

    // モデルサイズを計算
    const size = new THREE.Vector3();
    modelBounds.getSize(size);
    const maxDimension = Math.max(size.x, size.y, size.z);
    distance = maxDimension * 1.5; // 既存3Dビューと同じカメラ距離
  } else {
    log.warn('[ViewManager] Model bounds not available, using defaults');
  }

  let position;
  let up;

  switch (viewType) {
    case VIEW_DIRECTIONS.TOP:
      // 平面図: 上から見下ろす（Z+方向から）
      position = new THREE.Vector3(center.x, center.y, center.z + distance);
      up = new THREE.Vector3(0, 1, 0); // Y軸が上
      break;

    case VIEW_DIRECTIONS.FRONT:
      // 正面図: Y-方向から見る
      position = new THREE.Vector3(center.x, center.y - distance, center.z);
      up = new THREE.Vector3(0, 0, 1); // Z軸が上
      break;

    case VIEW_DIRECTIONS.RIGHT:
      // 右側面図: X+方向から見る
      position = new THREE.Vector3(center.x + distance, center.y, center.z);
      up = new THREE.Vector3(0, 0, 1); // Z軸が上
      break;

    case VIEW_DIRECTIONS.LEFT:
      // 左側面図: X-方向から見る
      position = new THREE.Vector3(center.x - distance, center.y, center.z);
      up = new THREE.Vector3(0, 0, 1); // Z軸が上
      break;

    case VIEW_DIRECTIONS.ISOMETRIC: {
      // 等角投影: 斜め上から
      const iso = distance / Math.sqrt(3);
      position = new THREE.Vector3(center.x + iso, center.y - iso, center.z + iso);
      up = new THREE.Vector3(0, 0, 1); // Z軸が上
      break;
    }

    case VIEW_DIRECTIONS.BACK:
      // 背面図: Y+方向から見る
      position = new THREE.Vector3(center.x, center.y + distance, center.z);
      up = new THREE.Vector3(0, 0, 1); // Z軸が上
      break;

    case VIEW_DIRECTIONS.BOTTOM:
      // 下から見る: Z-方向から見る
      position = new THREE.Vector3(center.x, center.y, center.z - distance);
      up = new THREE.Vector3(0, 1, 0); // Y軸が上（TOPビューと同じ向き）
      break;

    // ============================================
    // 辺ビュー (12個) - 2面の境界から45度で見る
    // ============================================
    case VIEW_DIRECTIONS.TOP_FRONT: {
      const d = distance / Math.SQRT2;
      position = new THREE.Vector3(center.x, center.y - d, center.z + d);
      up = new THREE.Vector3(0, 0, 1);
      break;
    }
    case VIEW_DIRECTIONS.TOP_BACK: {
      const d = distance / Math.SQRT2;
      position = new THREE.Vector3(center.x, center.y + d, center.z + d);
      up = new THREE.Vector3(0, 0, 1);
      break;
    }
    case VIEW_DIRECTIONS.TOP_RIGHT: {
      const d = distance / Math.SQRT2;
      position = new THREE.Vector3(center.x + d, center.y, center.z + d);
      up = new THREE.Vector3(0, 0, 1);
      break;
    }
    case VIEW_DIRECTIONS.TOP_LEFT: {
      const d = distance / Math.SQRT2;
      position = new THREE.Vector3(center.x - d, center.y, center.z + d);
      up = new THREE.Vector3(0, 0, 1);
      break;
    }
    case VIEW_DIRECTIONS.BOTTOM_FRONT: {
      const d = distance / Math.SQRT2;
      position = new THREE.Vector3(center.x, center.y - d, center.z - d);
      up = new THREE.Vector3(0, 0, 1);
      break;
    }
    case VIEW_DIRECTIONS.BOTTOM_BACK: {
      const d = distance / Math.SQRT2;
      position = new THREE.Vector3(center.x, center.y + d, center.z - d);
      up = new THREE.Vector3(0, 0, 1);
      break;
    }
    case VIEW_DIRECTIONS.BOTTOM_RIGHT: {
      const d = distance / Math.SQRT2;
      position = new THREE.Vector3(center.x + d, center.y, center.z - d);
      up = new THREE.Vector3(0, 0, 1);
      break;
    }
    case VIEW_DIRECTIONS.BOTTOM_LEFT: {
      const d = distance / Math.SQRT2;
      position = new THREE.Vector3(center.x - d, center.y, center.z - d);
      up = new THREE.Vector3(0, 0, 1);
      break;
    }
    case VIEW_DIRECTIONS.FRONT_RIGHT: {
      const d = distance / Math.SQRT2;
      position = new THREE.Vector3(center.x + d, center.y - d, center.z);
      up = new THREE.Vector3(0, 0, 1);
      break;
    }
    case VIEW_DIRECTIONS.FRONT_LEFT: {
      const d = distance / Math.SQRT2;
      position = new THREE.Vector3(center.x - d, center.y - d, center.z);
      up = new THREE.Vector3(0, 0, 1);
      break;
    }
    case VIEW_DIRECTIONS.BACK_RIGHT: {
      const d = distance / Math.SQRT2;
      position = new THREE.Vector3(center.x + d, center.y + d, center.z);
      up = new THREE.Vector3(0, 0, 1);
      break;
    }
    case VIEW_DIRECTIONS.BACK_LEFT: {
      const d = distance / Math.SQRT2;
      position = new THREE.Vector3(center.x - d, center.y + d, center.z);
      up = new THREE.Vector3(0, 0, 1);
      break;
    }

    // ============================================
    // 角ビュー (8個) - 3面の頂点から~35.26度で見る
    // ============================================
    case VIEW_DIRECTIONS.TOP_FRONT_RIGHT: {
      const d = distance / Math.sqrt(3);
      position = new THREE.Vector3(center.x + d, center.y - d, center.z + d);
      up = new THREE.Vector3(0, 0, 1);
      break;
    }
    case VIEW_DIRECTIONS.TOP_FRONT_LEFT: {
      const d = distance / Math.sqrt(3);
      position = new THREE.Vector3(center.x - d, center.y - d, center.z + d);
      up = new THREE.Vector3(0, 0, 1);
      break;
    }
    case VIEW_DIRECTIONS.TOP_BACK_RIGHT: {
      const d = distance / Math.sqrt(3);
      position = new THREE.Vector3(center.x + d, center.y + d, center.z + d);
      up = new THREE.Vector3(0, 0, 1);
      break;
    }
    case VIEW_DIRECTIONS.TOP_BACK_LEFT: {
      const d = distance / Math.sqrt(3);
      position = new THREE.Vector3(center.x - d, center.y + d, center.z + d);
      up = new THREE.Vector3(0, 0, 1);
      break;
    }
    case VIEW_DIRECTIONS.BOTTOM_FRONT_RIGHT: {
      const d = distance / Math.sqrt(3);
      position = new THREE.Vector3(center.x + d, center.y - d, center.z - d);
      up = new THREE.Vector3(0, 0, 1);
      break;
    }
    case VIEW_DIRECTIONS.BOTTOM_FRONT_LEFT: {
      const d = distance / Math.sqrt(3);
      position = new THREE.Vector3(center.x - d, center.y - d, center.z - d);
      up = new THREE.Vector3(0, 0, 1);
      break;
    }
    case VIEW_DIRECTIONS.BOTTOM_BACK_RIGHT: {
      const d = distance / Math.sqrt(3);
      position = new THREE.Vector3(center.x + d, center.y + d, center.z - d);
      up = new THREE.Vector3(0, 0, 1);
      break;
    }
    case VIEW_DIRECTIONS.BOTTOM_BACK_LEFT: {
      const d = distance / Math.sqrt(3);
      position = new THREE.Vector3(center.x - d, center.y + d, center.z - d);
      up = new THREE.Vector3(0, 0, 1);
      break;
    }

    default:
      log.warn('[ViewManager] Unknown view type:', viewType);
      return false;
  }

  // 正投影の表示範囲は共通Projectionだけが決定する。
  // カメラ位置は既存3Dビューと同じdistanceを使うが、図面の縮尺は
  // 非表示軸を含む3D最大寸法ではなく、ビュー面への投影範囲から算定する。
  if (camera.isOrthographicCamera) {
    const aspect = getCanvasAspect(renderer?.domElement);
    const fittedHeight = modelBounds
      ? fitOrthographicToBounds(camera, modelBounds, position, center, up, aspect)
      : null;

    if (!fittedHeight) {
      setOrthographicViewHeight(camera, distance, aspect, { resetZoom: true });
    }
  }

  // upベクトルを設定
  camera.up.copy(up);
  camera.updateProjectionMatrix();

  // CameraControlsを使用してカメラとターゲットを設定
  if (controls && controls._cc) {
    // CameraControlsのupベクトルを更新（重要：これがないとマウス操作の方向がおかしくなる）
    if (typeof controls._cc.updateCameraUp === 'function') {
      controls._cc.updateCameraUp();
    }

    // setLookAt(posX, posY, posZ, targetX, targetY, targetZ, enableTransition)
    controls._cc.setLookAt(
      position.x,
      position.y,
      position.z,
      center.x,
      center.y,
      center.z,
      enableTransition, // トランジション有効時はスムーズに移動
    );
  } else {
    // CameraControlsがない場合は直接設定
    camera.position.copy(position);
    camera.lookAt(center);
  }

  // ビュー変更後: 現在のカメラモードに適したコントロール設定を再適用
  // ViewCubeクリックやビュー方向ボタンによるカメラ移動後の整合性を保証
  reaffirmControlsForCurrentMode();

  currentView = viewType;
  return true;
}

/**
 * ビュー方向名を取得（表示用）
 * @param {string} viewType - ビュー方向
 * @returns {string} 日本語名
 */
export function getViewName(viewType) {
  const names = {
    [VIEW_DIRECTIONS.TOP]: '平面図（Top）',
    [VIEW_DIRECTIONS.BOTTOM]: '下面図（Bottom）',
    [VIEW_DIRECTIONS.FRONT]: '正面図（Front）',
    [VIEW_DIRECTIONS.BACK]: '背面図（Back）',
    [VIEW_DIRECTIONS.RIGHT]: '右側面図（Right）',
    [VIEW_DIRECTIONS.LEFT]: '左側面図（Left）',
    [VIEW_DIRECTIONS.ISOMETRIC]: '等角投影（Iso）',
  };
  return names[viewType] || viewType;
}

/**
 * ビューマネージャーの状態をデバッグ出力
 * @returns {Object} デバッグ情報
 */
export function getDebugInfo() {
  const camera = getActiveCamera();
  return {
    currentView,
    currentViewName: getViewName(currentView),
    cameraPosition: camera
      ? {
          x: camera.position.x,
          y: camera.position.y,
          z: camera.position.z,
        }
      : null,
    cameraUp: camera
      ? {
          x: camera.up.x,
          y: camera.up.y,
          z: camera.up.z,
        }
      : null,
  };
}
