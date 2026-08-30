/**
 * @fileoverview ラベル管理モジュール
 *
 * このファイルは、ラベル関連の全ての機能を統合管理します:
 * - ラベル内容の生成と管理
 * - ラベル表示/非表示の制御
 * - 色付けモード変更時の自動更新
 * - パフォーマンス最適化されたバッチ処理
 * - 一元化されたラベル設定API
 *
 * このシステムにより、ラベル関連のコードの重複を排除し、
 * 保守性とパフォーマンスを向上させます。
 */

import { getState } from '../../data/state/globalState.js';
import { getAllLabels, addLabelsToGlobalState, removeLabelsForElementType } from '../state.js';
import { getCurrentStorySelection } from './selectors.js';
import { renderingController } from '../../app/controllers/renderingController.js';
import { LABEL_ELEMENTS } from '../../constants/elementTypes.js';
import { scheduleRender } from '../../utils/renderScheduler.js';
import { createLogger } from '../../utils/logger.js';
import { LABEL_CONTENT_TYPES, LABEL_CONTENT_DESCRIPTIONS } from '../../constants/displayModes.js';
import { eventBus, LabelEvents } from '../../data/events/index.js';

// generateLabelText は viewer/annotations/labelTextGenerator.js に移動済み
// 後方互換のため再エクスポート
export { generateLabelText } from '../../viewer/annotations/labelTextGenerator.js';

const log = createLogger('unifiedLabelManager');

// ラベル更新のバッチ処理用
let labelUpdateScheduled = false;
const pendingLabelUpdates = new Set();

// CONTENT_TYPE_DESCRIPTIONS は LABEL_CONTENT_DESCRIPTIONS のエイリアス
const CONTENT_TYPE_DESCRIPTIONS = LABEL_CONTENT_DESCRIPTIONS;

// ラベル再生成の実装（labelRegeneration.js との循環依存を避けるため初期化時に注入）
/** @type {(() => void)|null} */
let regenerateAllLabelsImpl = null;

/**
 * 統合ラベル管理システムを初期化
 * @param {Object} [options] - オプション
 * @param {Function} [options.regenerateAllLabels] - 全ラベル再生成関数（labelRegeneration.js）
 */
export function initializeLabelManager(options = {}) {
  log.info('[LabelManager] Initializing label management system');

  regenerateAllLabelsImpl = options.regenerateAllLabels || regenerateAllLabelsImpl;

  log.info('[LabelManager] Label management system initialized');
}

/**
 * 注入済みの実装で全ラベルを再生成する
 */
export function regenerateAllLabels() {
  if (regenerateAllLabelsImpl) {
    regenerateAllLabelsImpl();
  } else {
    log.warn('[LabelManager] regenerateAllLabels が未注入のため再生成をスキップ');
  }
}

// generateLabelText, generateIdLabel, generateNameLabel, generateSectionLabel は
// viewer/annotations/labelTextGenerator.js に移動済み（レイヤー違反解消）

/**
 * 全ラベルの表示状態を統合的に更新
 */
export function updateLabelVisibility() {
  if (labelUpdateScheduled) {
    return; // 既にスケジュール済み
  }

  labelUpdateScheduled = true;

  // 次のフレームで実行（パフォーマンス最適化）
  requestAnimationFrame(() => {
    performLabelVisibilityUpdate();
    labelUpdateScheduled = false;
  });
}

/**
 * ラベル表示状態の実際の更新を実行
 */
function performLabelVisibilityUpdate() {
  const allLabels = getAllLabels();

  if (allLabels.length === 0) {
    log.info('[LabelManager] No labels to update');
    return;
  }

  // 頻繁に呼ばれるため詳細ログは抑制
  // log.info(`[LabelManager] Updating visibility for ${allLabels.length} labels`);

  let visibleCount = 0;
  let hiddenCount = 0;

  allLabels.forEach((label) => {
    if (label && label.userData) {
      const shouldBeVisible = calculateLabelVisibility(label);

      if (
        label.userData.labelBaseVisible !== shouldBeVisible ||
        label.visible !== shouldBeVisible
      ) {
        setLabelBaseVisibility(label, shouldBeVisible);
        if (shouldBeVisible) {
          visibleCount++;
        } else {
          hiddenCount++;
        }
      }
    }
  });

  // 実際に変更があった場合のみログを出力
  if (visibleCount > 0 || hiddenCount > 0) {
    log.info(`[LabelManager] Updated: ${visibleCount} shown, ${hiddenCount} hidden`);
  }

  // 再描画をリクエスト
  scheduleRender();
}

function setLabelBaseVisibility(label, visible) {
  if (!label?.userData) return;
  label.userData.labelBaseVisible = visible;
  label.visible = visible;
}

/**
 * ラベルの表示状態を計算
 * @param {Object} label - ラベルオブジェクト
 * @returns {boolean} 表示すべきかどうか
 */
function calculateLabelVisibility(label) {
  const userData = label.userData;
  if (!userData || !userData.elementType) {
    return false;
  }

  // 1. 要素タイプのラベル表示設定をチェック
  if (!isLabelTypeVisible(userData.elementType)) {
    return false;
  }

  // 2. クリッピング条件をチェック
  if (!isLabelWithinClippingBounds(label)) {
    return false;
  }

  // 3. モデル表示状態をチェック
  if (!isLabelModelVisible(label)) {
    return false;
  }

  return true;
}

/**
 * 要素タイプのラベル表示設定をチェック
 * @param {string} elementType - 要素タイプ
 * @returns {boolean} ラベル表示が有効かどうか
 */
function isLabelTypeVisible(elementType) {
  // labelDisplayManagerと同期してから状態を取得
  const labelDisplayManager = renderingController.getLabelDisplayManager();
  labelDisplayManager.syncWithCheckbox(elementType);
  return labelDisplayManager.isLabelVisible(elementType);
}

/**
 * ラベルがクリッピング範囲内にあるかチェック
 * @param {Object} _label - ラベルオブジェクト
 * @returns {boolean} クリッピング範囲内かどうか
 */
function isLabelWithinClippingBounds(_label) {
  // 階クリッピング
  const storySelection = getCurrentStorySelection();
  if (storySelection && storySelection !== 'all') {
    // 階クリッピングのロジック（既存のコードから移植）
    // 実装は省略
  }

  // 簡略化されたクリッピングチェック
  return true; // 実際の実装では詳細なチェックが必要
}

/**
 * ラベルのモデルが表示状態かチェック
 * @param {Object} label - ラベルオブジェクト
 * @returns {boolean} モデルが表示中かどうか
 */
function isLabelModelVisible(label) {
  const userData = label.userData;

  // モデルA/Bの表示状態をチェック
  const showModelA = document.getElementById('toggleModelA')?.checked ?? true;
  const showModelB = document.getElementById('toggleModelB')?.checked ?? true;

  if (userData.modelSource === 'A' && !showModelA) {
    return false;
  }
  if (userData.modelSource === 'B' && !showModelB) {
    return false;
  }

  return true;
}

// regenerateAllLabels の実体は循環依存を避けるため初期化時に注入される

/**
 * ラベル内容タイプの説明を取得
 * @param {string} contentType - 内容タイプ
 * @returns {string} 説明
 */
export function getLabelContentDescription(contentType) {
  return CONTENT_TYPE_DESCRIPTIONS[contentType] || contentType;
}

/**
 * 利用可能なラベル内容タイプを取得
 * @returns {Array} 利用可能なタイプの配列
 */
export function getAvailableLabelContentTypes() {
  return Object.values(LABEL_CONTENT_TYPES);
}

/**
 * 色付けモード変更時のラベル更新
 * この関数は colorModes.js から呼び出される
 */
export function handleColorModeChange() {
  // ラベルの表示状態を再計算（頻繁に呼ばれるためログは抑制）
  updateLabelVisibility();

  // 必要に応じてラベル内容も更新
  // （色付けモードによってはラベル内容も変更される可能性）
}

/**
 * ラベル表示の統計情報を取得
 * @returns {Object} 統計情報
 */
export function getLabelVisibilityStatistics() {
  const allLabels = getAllLabels();
  const visibilityByType = {};

  LABEL_ELEMENTS.forEach((type) => {
    visibilityByType[type] = isLabelTypeVisible(type);
  });

  return {
    contentType: getState('ui.labelContentType') || LABEL_CONTENT_TYPES.ID,
    totalLabels: allLabels.length,
    visibleLabels: allLabels.filter((l) => l.visible).length,
    visibilityByType,
    pendingUpdates: pendingLabelUpdates.size,
  };
}

// ============================================================================
// EventBus リスナー（app→ui 方向違反解消）
// app/viewModes/ からの直接import を eventBus 経由に置き換え
// ============================================================================

eventBus.on(LabelEvents.ADD_LABELS, (labels) => {
  addLabelsToGlobalState(labels);
});

eventBus.on(LabelEvents.REMOVE_BY_TYPE, (elementType) => {
  removeLabelsForElementType(elementType);
});

eventBus.on(LabelEvents.UPDATE_VISIBILITY, () => {
  updateLabelVisibility();
});
