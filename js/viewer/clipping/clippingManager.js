/**
 * @fileoverview クリッピング平面管理モジュール
 *
 * Three.jsレンダラーのクリッピング機能を管理します:
 * - クリッピング平面の生成と適用
 * - 軸に基づくクリッピング
 * - マテリアルへのクリッピング適用
 *
 * active clipping state は ClippingStateManager をSSOTとし、
 * renderer.clippingPlanes を状態判定には使用しない。
 */

import * as THREE from 'three';
import { renderer, elementGroups as viewerElementGroups } from '../core/core.js';
import { createLogger } from '../../utils/logger.js';
import { eventBus } from '../../data/events/eventBus.js';
import { ToastEvents } from '../../constants/eventTypes.js';
import { clippingStateManager } from './ClippingStateManager.js';

const log = createLogger('viewer:clipping');

// ============================================
// 状態プロバイダー（依存性注入）
// ============================================

/**
 * @typedef {Object} ClippingStateProvider
 * @property {function(string): *} getState - 状態取得関数
 */

/** @type {ClippingStateProvider|null} */
let stateProvider = null;

/**
 * 状態プロバイダーを設定（依存性注入）
 * @param {ClippingStateProvider} provider - 状態プロバイダー
 */
export function setClippingStateProvider(provider) {
  stateProvider = provider;
}

/**
 * 状態を取得（プロバイダー経由）
 * @param {string} path - 状態パス
 * @returns {*} 状態値
 */
function getStateInternal(path) {
  return stateProvider?.getState?.(path) || null;
}

function ensureClippingRenderer() {
  if (!renderer) return false;
  clippingStateManager.setRenderer(renderer);
  return true;
}

/**
 * 指定された軸と中心座標に基づいてクリッピング平面を設定する。
 * - X/Y/Z軸ごとに2枚のクリッピング平面を生成
 * - applyClipPlanesで状態管理層に適用
 * @param {'X' | 'Y' | 'Z'} axis - クリッピングする軸。
 * @param {number} centerCoord - クリッピングの中心となる座標 (mm単位)。
 * @param {number} [range=1000] - 中心からのクリッピング範囲（片側、mm単位）。
 */
export function applyClipping(axis, centerCoord, range = 1000) {
  log.debug(
    `applyClipping called for axis ${axis} at ${centerCoord}mm with range ${range}mm. Checking renderer state...`,
  );
  if (!ensureClippingRenderer()) {
    log.error('Renderer is not initialized when applyClipping was called!');
    eventBus.emit(ToastEvents.SHOW_ERROR, {
      message: 'クリッピングエラー: レンダラーが初期化されていません。',
    });
    return;
  }
  log.trace('Renderer found in applyClipping:', renderer);
  try {
    const planeNormal1 = new THREE.Vector3();
    const planeNormal2 = new THREE.Vector3();
    let constant1 = 0;
    let constant2 = 0;

    switch (axis) {
      case 'X':
        planeNormal1.set(1, 0, 0);
        planeNormal2.set(-1, 0, 0);
        constant1 = -(centerCoord - range);
        constant2 = centerCoord + range;
        break;
      case 'Y':
        planeNormal1.set(0, 1, 0);
        planeNormal2.set(0, -1, 0);
        constant1 = -(centerCoord - range);
        constant2 = centerCoord + range;
        break;
      case 'Z':
      default:
        planeNormal1.set(0, 0, 1);
        planeNormal2.set(0, 0, -1);
        constant1 = -(centerCoord - range);
        constant2 = centerCoord + range;
        break;
    }

    const clipPlanes = [
      new THREE.Plane(planeNormal1, constant1),
      new THREE.Plane(planeNormal2, constant2),
    ];

    applyClipPlanes(clipPlanes);

    log.info(
      `Clipping planes set for ${axis}-axis at ${centerCoord.toFixed(0)}mm ± ${range.toFixed(0)}mm.`,
    );
  } catch (error) {
    log.error('Error setting clipping planes:', error);
    eventBus.emit(ToastEvents.SHOW_ERROR, {
      message: 'クリッピング中にエラーが発生しました。',
    });
  }
}

/**
 * 通常クリッピング平面を解除する。
 * SectionBox有効中の場合はSectionBoxを維持し、復帰先の通常クリップだけを空にする。
 */
export function clearClippingPlanes() {
  log.debug('clearClippingPlanes called. Checking renderer state...');
  if (!ensureClippingRenderer()) {
    log.error('Renderer is not initialized when clearClippingPlanes was called!');
    eventBus.emit(ToastEvents.SHOW_ERROR, {
      message: 'クリッピング解除エラー: レンダラーが初期化されていません。',
    });
    return;
  }
  try {
    clippingStateManager.clearNormalPlanes();
    clippingStateManager.applyToRoots(viewerElementGroups);
    log.info('Normal clipping planes cleared.');
  } catch (error) {
    log.error('Error clearing clipping planes:', error);
    eventBus.emit(ToastEvents.SHOW_ERROR, {
      message: 'クリッピング解除中にエラーが発生しました。',
    });
  }
}

/**
 * 指定された通常クリッピング平面を適用する。
 * SectionBox有効中は復帰用状態として保持され、renderer-globalには適用しない。
 * @param {Array<THREE.Plane>} planes - 適用するクリッピング平面の配列
 */
export function applyClipPlanes(planes) {
  if (!ensureClippingRenderer()) {
    log.error('Renderer not available in applyClipPlanes.');
    return;
  }
  if (!planes || planes.length === 0) {
    log.warn('No planes provided to applyClipPlanes.');
    return;
  }

  log.debug(`Applying ${planes.length} clipping planes to clipping state:`);
  planes.forEach((plane, index) => {
    log.trace(
      `  Plane ${index}: Normal=(${plane.normal.x.toFixed(3)}, ${plane.normal.y.toFixed(3)}, ${plane.normal.z.toFixed(3)}), Constant=${plane.constant.toFixed(3)}`,
    );
  });

  clippingStateManager.setNormalPlanes(planes);
  clippingStateManager.applyToRoots(viewerElementGroups);

  log.info(`Applied ${planes.length} normal clipping planes.`);
}

/**
 * すべての要素マテリアルへSSOTのactive clipping stateを同期する。
 * Material再生成後の共通同期入口としても使用する。
 */
export function updateMaterialClippingPlanes() {
  if (!ensureClippingRenderer()) return;

  const updated = clippingStateManager.applyToRoots(viewerElementGroups);
  log.info(`Updated clipping policy for element materials: ${updated} material(s).`);

  const scheduleRender = getStateInternal('rendering.scheduleRender');
  if (scheduleRender) {
    scheduleRender();
  }
}
