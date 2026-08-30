/**
 * @fileoverview 色付けモード管理モジュール
 *
 * このファイルは、色付けモードの管理と統合APIを提供します：
 * 1. 差分表示モード（デフォルト）- モデルA/Bの差分を表示
 * 2. 部材別色付けモード - 要素タイプごとに色を設定
 * 3. スキーマエラー表示モード - スキーマチェックエラーを表示
 * 4. 重要度別色付けモード - 属性の重要度で色分け
 *
 * @module colorModes/colorModeManager
 */

import { UI_TIMING } from '../config/uiTimingConfig.js';
import { colorManager, clearImportanceMaterialCache } from '../viewer/index.js';
import { scheduleRender } from '../utils/renderScheduler.js';
import { eventBus, ViewEvents } from '../data/events/index.js';
import { getState } from '../data/state/globalState.js';

// 色付けモード状態（循環依存解消のため分離）
import {
  COLOR_MODES,
  getCurrentColorMode,
  getLastUserSelectedColorMode,
  hasUserSelectedColorMode,
  markColorModeSelectedByUser,
  setCurrentColorModeInternal,
} from './colorModeState.js';
export { COLOR_MODES, getCurrentColorMode };

// スキーマエラーストア（循環依存解消のため分離）
import { getSchemaError } from '../common-stb/validation/schemaErrorStore.js';

// 一括適用・状況メッセージ（循環依存解消のため分離）
import { applyColorModeToAllObjects } from './applyColorMode.js';
import { showColorModeStatus } from './colorModeStatus.js';

// 各色付けモードのモジュールをインポート
import {
  initializeElementColorControls,
  setElementColorInputsEnabled,
} from './elementColorMode.js';

import { initializeSchemaColorControls, runValidationForSchemaMode } from './schemaColorMode.js';

import {
  initializeImportanceColorControls,
  applyImportanceColorModeToAll,
  setupImportanceChangeListeners,
} from './importanceColorMode.js';

import { createLogger } from '../utils/logger.js';

const log = createLogger('colorModes:colorModeManager');

// 色モード変更のロック機構（非同期競合防止）
let isColorModeChanging = false;
/** @type {{mode: string, userInitiated: boolean}|null} */
let pendingColorMode = null;
// eventBusリスナーの重複登録防止（setupColorModeListenersが複数回呼ばれた場合）
let isRefreshListenerRegistered = false;

/**
 * 色付けモードを設定
 * @param {string} mode 設定する色付けモード
 * @param {{userInitiated?: boolean}} [options] 変更元
 */
export function setColorMode(mode, options = {}) {
  if (!Object.values(COLOR_MODES).includes(mode)) {
    return;
  }

  if (options.userInitiated === true) {
    // ロック中に変更がキューへ入る場合も、ユーザー操作だった事実は失わない。
    markColorModeSelectedByUser(mode);
  }

  // ロック中の場合は待機キューに追加
  if (isColorModeChanging) {
    // ユーザー要求が待機中なら、後続の自動再適用で上書きしない。
    if (options.userInitiated === true || pendingColorMode?.userInitiated !== true) {
      pendingColorMode = { mode, userInitiated: options.userInitiated === true };
    }
    log.info('[ColorMode] Queued mode change:', mode);
    return;
  }

  // ロックを取得
  isColorModeChanging = true;
  setCurrentColorModeInternal(mode);
  updateColorModeUI();

  // モデルが読み込まれているかチェック（data層のglobalState経由）
  const modelsLoaded = !!(getState('models.documentA') || getState('models.documentB'));

  if (!modelsLoaded) {
    // UI要素の表示状態を更新
    updateColorModeUI();
    // 状況メッセージを表示
    showColorModeStatus(
      `表示モードを「${getModeDisplayName(mode)}」に設定しました。モデル読み込み後に適用されます。`,
    );
    // ロック解除と待機キュー処理
    finishColorModeChange();
    return;
  }

  // 色付けモード変更処理
  try {
    updateElementsForColorMode();
    // 変更成功メッセージを表示
    showColorModeStatus(`「${getModeDisplayName(mode)}」モードを適用しました。`, 3000);
  } catch (error) {
    log.error('[ColorMode] Error updating elements for color mode:', error);
    // エラーメッセージを表示
    showColorModeStatus(`色付けモード変更でエラーが発生しました: ${error.message}`, 5000);
  }

  // 色付けモード変更時は確実に再描画を実行
  setTimeout(() => {
    scheduleRender();
    // ロック解除と待機キュー処理
    finishColorModeChange();
  }, UI_TIMING.COLOR_MODE_REDRAW_DELAY_MS);
}

/**
 * 色モード変更完了処理（ロック解除と待機キュー処理）
 * @private
 */
function finishColorModeChange() {
  isColorModeChanging = false;

  // 待機中のモード変更があれば実行
  if (pendingColorMode !== null) {
    const nextRequest = pendingColorMode;
    pendingColorMode = null;
    log.info('[ColorMode] Processing queued mode:', nextRequest.mode);
    setColorMode(nextRequest.mode, { userInitiated: nextRequest.userInitiated });
  }
}

/**
 * 色付けモードUIの更新
 */
function updateColorModeUI() {
  const schemaSettings = document.getElementById('schema-color-settings');
  const importanceSettings = document.getElementById('importance-color-settings');
  const comparisonKeySettings = document.getElementById('comparison-key-settings');
  const toleranceSettingsSection = document.getElementById('tolerance-settings-section');

  const currentMode = getCurrentColorMode();

  // ドロップダウンセレクターの値を同期
  const selector = /** @type {HTMLSelectElement|null} */ (
    document.getElementById('colorModeSelector')
  );
  if (selector && selector.value !== currentMode) {
    selector.value = currentMode;
  }

  // 部材別色付けモードの色ボックスを有効/無効切替
  const isElementMode = currentMode === COLOR_MODES.ELEMENT;
  setElementColorInputsEnabled(isElementMode);

  if (schemaSettings && importanceSettings) {
    // 設定パネルを非表示にする
    schemaSettings.style.display = 'none';
    importanceSettings.style.display = 'none';

    // 現在のモードに応じて適切なパネルを表示
    switch (currentMode) {
      case COLOR_MODES.SCHEMA:
        schemaSettings.style.display = 'block';
        break;
      case COLOR_MODES.IMPORTANCE:
        importanceSettings.style.display = 'block';
        break;
      // DIFF モードと ELEMENT モードはデフォルトなので特別な表示は不要
    }
  }

  const shouldShowDiffSettings = currentMode === COLOR_MODES.DIFF;

  if (comparisonKeySettings) {
    comparisonKeySettings.classList.toggle('hidden', !shouldShowDiffSettings);
  }

  if (toleranceSettingsSection) {
    toleranceSettingsSection.style.display = shouldShowDiffSettings ? 'block' : 'none';
  }
}

/**
 * 色付けモードイベントリスナーを設定
 */
export function setupColorModeListeners() {
  log.info('[ColorModeManager] setupColorModeListeners() called');
  const selector = /** @type {HTMLSelectElement|null} */ (
    document.getElementById('colorModeSelector')
  );
  if (selector) {
    selector.addEventListener('change', (e) => {
      const target = /** @type {HTMLSelectElement|null} */ (e.target);
      if (!target) {
        return;
      }
      setColorMode(target.value, { userInitiated: true });
    });
  } else {
    log.warn('[ColorModeManager] colorModeSelector not found');
  }

  // 重要度設定変更時のイベントリスナーを追加
  setupImportanceChangeListeners();

  // 各モードモジュールからの再適用要求を購読（循環依存解消のためeventBus経由）
  if (!isRefreshListenerRegistered) {
    isRefreshListenerRegistered = true;
    eventBus.on(ViewEvents.COLOR_MODE_REFRESH_REQUESTED, () => {
      updateElementsForColorMode();
    });
  }

  // 初期化
  colorManager.clearMaterialCache();
  initializeElementColorControls();
  initializeSchemaColorControls();
  initializeImportanceColorControls();
  updateColorModeUI();
  log.info('[ColorModeManager] setupColorModeListeners() completed');
}

/**
 * 色付けモード変更時に全ての要素を再描画する
 */
export function updateElementsForColorMode() {
  const currentMode = getCurrentColorMode();

  // モード別の特別な処理
  switch (currentMode) {
    case COLOR_MODES.IMPORTANCE:
      // 重要度モードの場合は全要素に重要度マテリアルを適用
      clearImportanceMaterialCache();
      applyImportanceColorModeToAll();
      break;

    case COLOR_MODES.SCHEMA:
      // スキーマモードの場合は実際のバリデーションを実行
      runValidationForSchemaMode();
      applyColorModeToAllObjects('SchemaColorMode');
      break;

    case COLOR_MODES.ELEMENT:
      // 部材別色付けモードの場合
      applyColorModeToAllObjects('ElementColorMode');
      break;

    case COLOR_MODES.DIFF:
    default:
      // 差分表示モード（デフォルト）
      applyColorModeToAllObjects('DiffColorMode');
      break;
  }

  // Note: Slab/Wallの再描画は不要（viewModes.jsのredrawElementForViewModeで
  // updateElementsForColorModeが呼ばれるため、ここで再度redrawすると循環依存になる）
  // マテリアルの更新は applyColorModeToAllObjects で処理される

  // UI層に色付けモード変更を通知（eventBus経由でレイヤー違反解消）
  // ラベル管理、凡例更新、要素情報パネル更新はUI側のリスナーが処理
  eventBus.emit(ViewEvents.COLOR_MODE_CHANGED, { mode: getCurrentColorMode() });
}

// requestColorModeRedraw / applyColorModeToAllObjects は
// applyColorMode.js に移動（循環依存解消）

/**
 * 要素タイプに基づいてマテリアルを取得
 * @param {string} elementType 要素タイプ
 * @param {boolean} isLine 線要素かどうか
 * @param {string} elementId 要素ID（スキーマエラー判定用）
 * @param {string} [modelSource] モデルソース ('A', 'B', 'matched') A/B混線防止用
 * @returns {import('three').Material|null} マテリアル
 */
export function getMaterialForElement(
  elementType,
  isLine = false,
  elementId = null,
  modelSource = null,
) {
  const colorMode = getCurrentColorMode();

  // ColorManagerを使用してマテリアルを取得
  switch (colorMode) {
    case COLOR_MODES.ELEMENT:
      // 部材別色付けモード
      // 注意: Storyは半透明の面として表示すべきなので、ワイヤーフレームにしない
      // Axisは別途LineBasicMaterialを使用するのでここでは不要
      return colorManager.getMaterial('element', {
        elementType,
        isLine,
        wireframe: false,
      });

    case COLOR_MODES.SCHEMA: {
      // スキーマエラーチェック結果に基づく色付け
      // 注意: Storyは半透明の面として表示すべきなので、ワイヤーフレームにしない
      const errorInfo = elementId
        ? getSchemaError(elementId, modelSource, elementType)
        : { status: 'valid' };

      return colorManager.getMaterial('schema', {
        elementType,
        isLine,
        status: errorInfo.status,
        wireframe: false,
      });
    }

    case COLOR_MODES.IMPORTANCE:
      // 重要度モードは materials.js で処理するため null を返す
      return null;

    case COLOR_MODES.DIFF:
    default:
      // デフォルトの差分表示モードは既存の材料システムを使用
      return null;
  }
}

/**
 * 色付けモードの表示名を取得
 * @param {string} mode - 色付けモード
 * @returns {string} 表示名
 */
function getModeDisplayName(mode) {
  const displayNames = {
    [COLOR_MODES.DIFF]: '差分表示',
    [COLOR_MODES.ELEMENT]: '部材別色付け',
    [COLOR_MODES.SCHEMA]: 'スキーマエラー表示',
    [COLOR_MODES.IMPORTANCE]: '重要度別色付け',
  };
  return displayNames[mode] || mode;
}

// showColorModeStatus は colorModeStatus.js に移動（循環依存解消）

/**
 * モデル読み込み後にデフォルトの色付けモードを適用する
 *
 * @param {boolean} hasBothModels - 両方のモデルが読み込まれているか
 * @param {boolean} hasSingleModel - 片方のモデルのみ読み込まれているか
 * @param {Function} reapplyColorModeFn - 色モード再適用関数
 */
export function applyDefaultColorModeAfterLoad(hasBothModels, hasSingleModel, reapplyColorModeFn) {
  // ユーザーが明示的に選んだモードは、モデル構成にかかわらず維持する。
  // 通常の色モード適用経路を通し、新しく生成された要素にも確実に反映する。
  if (hasUserSelectedColorMode()) {
    const retainedMode = getLastUserSelectedColorMode() || getCurrentColorMode();
    setColorMode(retainedMode);
    const displayName = getModeDisplayName(retainedMode);
    setTimeout(() => {
      if (
        getCurrentColorMode() !== retainedMode ||
        getLastUserSelectedColorMode() !== retainedMode
      ) {
        return;
      }
      showColorModeStatus(
        `ユーザーが選択した「${displayName}」モードを維持しました。`,
        UI_TIMING.STATUS_MESSAGE_SHORT_DURATION_MS,
      );
    }, UI_TIMING.STATUS_MESSAGE_SHOW_DELAY_MS);
    return;
  }

  // デフォルトの色付けモードを決定
  let targetMode;
  if (hasBothModels) {
    targetMode = COLOR_MODES.DIFF;
  } else if (hasSingleModel) {
    targetMode = COLOR_MODES.ELEMENT;
  } else {
    targetMode = COLOR_MODES.DIFF; // フォールバック
  }

  const currentMode = getCurrentColorMode();

  // 現在のモードと異なる場合のみ変更
  if (currentMode !== targetMode) {
    setColorMode(targetMode);

    // 色付けモードが適用されたことをユーザーに通知
    const displayName = getModeDisplayName(targetMode);
    const reason = hasBothModels ? '両モデル読み込み' : '単一モデル読み込み';

    // 状況メッセージを表示（遅延付き）
    setTimeout(() => {
      showColorModeStatus(
        `${reason}のため「${displayName}」モードを自動適用しました。`,
        UI_TIMING.STATUS_MESSAGE_LONG_DURATION_MS,
      );
    }, UI_TIMING.STATUS_MESSAGE_SHOW_DELAY_MS);
  } else if (currentMode !== COLOR_MODES.DIFF) {
    // 現在のモードが維持される場合でも、DIFF以外なら再適用
    if (typeof reapplyColorModeFn === 'function') {
      reapplyColorModeFn();
    }

    const displayName = getModeDisplayName(currentMode);

    // 状況メッセージを表示（遅延付き）
    setTimeout(() => {
      showColorModeStatus(
        `「${displayName}」モードを適用しました。`,
        UI_TIMING.STATUS_MESSAGE_SHORT_DURATION_MS,
      );
    }, UI_TIMING.STATUS_MESSAGE_SHOW_DELAY_MS);
  }
}
