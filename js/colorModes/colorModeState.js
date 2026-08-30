/**
 * @fileoverview 色付けモード状態管理モジュール
 *
 * COLOR_MODES定数と現在のカラーモード状態を管理します。
 * viewer層やUI層への依存を持たない純粋な状態モジュールです。
 * colorModes/colorModeManager.js と viewer/rendering/materials.js の
 * 循環依存を解消するために分離されています。
 *
 * @module colorModes/colorModeState
 */

// 色付けモードの定数
export const COLOR_MODES = {
  DIFF: 'diff',
  ELEMENT: 'element',
  SCHEMA: 'schema',
  IMPORTANCE: 'importance',
};

// 現在の色付けモード
let currentColorMode = COLOR_MODES.DIFF;

// ユーザーが色付けモードセレクターから明示的に選択したか。
// モデルの再読み込みでは維持し、ページの再読み込み時だけ初期化される。
let hasExplicitUserSelection = false;
let lastUserSelectedColorMode = null;

/**
 * 現在の色付けモードを取得
 * @returns {string} 現在の色付けモード
 */
export function getCurrentColorMode() {
  return currentColorMode;
}

/**
 * 現在の色付けモードを内部的に設定（colorModeManagerから呼ばれる）
 * @param {string} mode 設定する色付けモード
 */
export function setCurrentColorModeInternal(mode) {
  currentColorMode = mode;
}

/** ユーザーによる明示的な色付けモード選択を記録する */
export function markColorModeSelectedByUser(mode) {
  hasExplicitUserSelection = true;
  lastUserSelectedColorMode = mode;
}

/** @returns {boolean} ユーザーが色付けモードを明示選択済みか */
export function hasUserSelectedColorMode() {
  return hasExplicitUserSelection;
}

/** @returns {string|null} ユーザーが最後に要求した色付けモード */
export function getLastUserSelectedColorMode() {
  return lastUserSelectedColorMode;
}
