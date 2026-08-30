/**
 * @fileoverview ViewerEventBridge
 *
 * UI層からのイベントを受け取り、Viewer層の処理を実行するブリッジサービス。
 * UI層がViewer層の内部構造に直接依存することを防ぎ、層の分離を実現します。
 *
 * @module viewer/services/viewerEventBridge
 */

import { eventBus } from '../../data/events/eventBus.js';
import { AxisEvents, RenderEvents } from '../../constants/eventTypes.js';
import { drawAxes, elementGroups, finalizeRenderableBatch } from '../index.js';
import { getCameraContext, getCameraMode } from '../camera/cameraManagerImpl.js';
import { CAMERA_CONTEXTS, CAMERA_MODES } from '../../constants/displayModes.js';
import { scheduleRender } from '../../utils/renderScheduler.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('viewer:services:viewerEventBridge');

/**
 * ViewerEventBridge - UI層とViewer層の間のイベントブリッジ
 */
class ViewerEventBridge {
  constructor() {
    this.initialized = false;
  }

  /**
   * ブリッジを初期化し、イベントリスナーを登録
   */
  initialize() {
    if (this.initialized) {
      log.warn('[ViewerEventBridge] Already initialized');
      return;
    }

    // 軸再描画リクエストのハンドリング
    eventBus.on(AxisEvents.REDRAW_REQUESTED, (data) => {
      this.handleAxisRedraw(data);
    });

    // 描画リクエストのハンドリング
    eventBus.on(RenderEvents.REQUEST_RENDER, () => {
      this.requestRender();
    });

    this.initialized = true;
  }

  /**
   * 軸再描画リクエストを処理
   * @param {Object} data - 再描画パラメータ
   * @param {Object} data.axesData - 軸データ
   * @param {Array} data.stories - 階データ
   * @param {Object} data.modelBounds - モデル境界
   * @param {boolean} data.labelToggle - ラベル表示フラグ
   * @param {string} data.targetStoryId - 対象階ID
   * @param {boolean} [data.is2DMode] - 2Dモードフラグ（省略時はカメラモードから判定）
   */
  handleAxisRedraw({
    axesData,
    stories,
    modelBounds,
    labelToggle,
    targetStoryId,
    is2DMode: providedIs2DMode,
    showDimensions,
  }) {
    const axisGroup = elementGroups['Axis'];
    if (!axisGroup) {
      log.warn('[ViewerEventBridge] Axis group not found');
      return;
    }

    if (!axesData || (!axesData.xAxes?.length && !axesData.yAxes?.length)) {
      return;
    }

    // 2Dモードフラグが提供されていない場合はカメラモードから判定
    const is2DMode =
      providedIs2DMode !== undefined
        ? providedIs2DMode
        : getCameraMode() === CAMERA_MODES.ORTHOGRAPHIC &&
          getCameraContext() === CAMERA_CONTEXTS.DRAWING;

    drawAxes(axesData, stories, axisGroup, modelBounds, labelToggle, null, {
      targetStoryId: targetStoryId === 'all' ? null : targetStoryId,
      is2DMode,
      showDimensions: showDimensions === true,
    });

    // 階選択時のAxis再描画も通常のgeometry再生成と同じbatch lifecycleへ載せる。
    // SectionBox有効中にlayout materialが作り直されても、通知前に現在の6面を同期する。
    finalizeRenderableBatch({ elementType: 'Axis', group: axisGroup });

    eventBus.emit(AxisEvents.REDRAW_COMPLETED);
  }

  /**
   * 描画フレームをリクエスト
   */
  requestRender() {
    scheduleRender();
  }

  /**
   * 現在のカメラモード情報を取得
   * @returns {{ mode: string, is2D: boolean }} カメラモード情報
   */
  getCameraModeInfo() {
    const mode = getCameraMode();
    const context = getCameraContext();
    return {
      mode,
      context,
      is2D: mode === CAMERA_MODES.ORTHOGRAPHIC && context === CAMERA_CONTEXTS.DRAWING,
    };
  }

  /**
   * ブリッジを破棄し、イベントリスナーを解除
   */
  dispose() {
    if (!this.initialized) return;

    eventBus.off(AxisEvents.REDRAW_REQUESTED);
    eventBus.off(RenderEvents.REQUEST_RENDER);

    this.initialized = false;
  }
}

// シングルトンインスタンス
export const viewerEventBridge = new ViewerEventBridge();
export default viewerEventBridge;
