/**
 * @fileoverview 部材別色付けモード
 *
 * 要素タイプごとに異なる色を設定する色付けモードを提供します。
 * 色ボックスは表示要素設定テーブル内に配置されています。
 *
 * @module colorModes/elementColorMode
 */

import { DEFAULT_ELEMENT_COLORS } from '../config/colorConfig.js';
import { colorManager } from '../viewer/index.js';
import { scheduleRender } from '../utils/renderScheduler.js';
import { getCurrentColorMode, COLOR_MODES } from './colorModeState.js';
import { eventBus, ViewEvents } from '../data/events/index.js';

// `.element-color-input` は表示要素設定内で共通の色picker外観にも利用する。
// 部材別色付けモードが制御するのは element type を持つ入力だけに限定し、
// 鉄筋径など別の表示設定をモード切替で誤ってdisabledにしない。
const ELEMENT_COLOR_INPUT_SELECTOR = '.element-color-input[data-element-type]';

/**
 * 部材別色設定UIを初期化（表示要素テーブル内の色ボックス）
 */
export function initializeElementColorControls() {
  const colorInputs = document.querySelectorAll(ELEMENT_COLOR_INPUT_SELECTOR);

  colorInputs.forEach((input) => {
    const elementType = input.dataset.elementType;
    if (!elementType) return;

    // 初期値設定
    input.value = colorManager.getElementColor(elementType);

    // 既存のイベントリスナーを削除して再設定（cloneNodeで新しい要素に置換）
    const newInput = input.cloneNode(true);
    input.parentNode.replaceChild(newInput, input);

    newInput.addEventListener('change', (e) => {
      colorManager.setElementColor(elementType, e.target.value);
      updateElementMaterials();
      // 部材別モードが有効な場合は全要素に色を再適用（eventBus経由で循環依存解消）
      if (getCurrentColorMode() === COLOR_MODES.ELEMENT) {
        eventBus.emit(ViewEvents.COLOR_MODE_REFRESH_REQUESTED);
      }
      scheduleRender();
    });
  });

  // リセットボタンのイベント設定
  const resetButton = document.getElementById('resetElementColors');
  if (resetButton) {
    // 既存のイベントリスナーを削除して再設定
    const newResetButton = resetButton.cloneNode(true);
    resetButton.parentNode.replaceChild(newResetButton, resetButton);

    newResetButton.addEventListener('click', () => resetElementColors());
  }
}

/**
 * 色ボックスの有効/無効を切り替え
 * @param {boolean} enabled - trueで有効、falseでグレーアウト
 */
export function setElementColorInputsEnabled(enabled) {
  const colorInputs = document.querySelectorAll(ELEMENT_COLOR_INPUT_SELECTOR);
  colorInputs.forEach((input) => {
    input.disabled = !enabled;
  });

  const resetButton = document.getElementById('resetElementColors');
  if (resetButton) {
    resetButton.disabled = !enabled;
  }
}

/**
 * 部材別マテリアルを更新
 */
function updateElementMaterials() {
  // ColorManagerのキャッシュをクリアして再生成を促す
  colorManager.clearMaterialCache();
}

/**
 * 部材別色設定をデフォルトにリセット
 */
export function resetElementColors() {
  // 一括リセットにより、変更通知と設定保存を1回にまとめる
  colorManager.resetElementColors();

  // UIの色設定コントロールを更新（色ボックスの値を更新）
  const colorInputs = document.querySelectorAll(ELEMENT_COLOR_INPUT_SELECTOR);
  colorInputs.forEach((input) => {
    const elementType = input.dataset.elementType;
    if (elementType && DEFAULT_ELEMENT_COLORS[elementType]) {
      input.value = DEFAULT_ELEMENT_COLORS[elementType];
    }
  });

  // 部材別モードが有効な場合は即座に適用（eventBus経由で循環依存解消）
  if (getCurrentColorMode() === COLOR_MODES.ELEMENT) {
    updateElementMaterials();
    eventBus.emit(ViewEvents.COLOR_MODE_REFRESH_REQUESTED);
  }
}

/**
 * 部材色設定の取得
 * @returns {Object} 部材タイプと色のマッピング
 */
export function getElementColors() {
  const colors = {};
  Object.keys(DEFAULT_ELEMENT_COLORS).forEach((type) => {
    colors[type] = colorManager.getElementColor(type);
  });
  return colors;
}
