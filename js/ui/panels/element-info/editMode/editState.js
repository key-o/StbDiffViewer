/**
 * @fileoverview 編集モードの共有可変状態とアクセサ
 *
 * ESM の live-binding は再代入をモジュールをまたいで反映しないため、
 * modifications（clearModifications で再代入）・currentEditingElement 等の
 * 共有状態は本モジュールへ集約し、getter/setter 経由で公開する。
 */

// 編集機能の状態管理
let editMode = false;
// 修正履歴（op 判別子付きコマンド履歴）:
//   { op: 'attr', elementType, id, path, attribute, oldValue, newValue } 属性編集
//   { op: 'add',  elementType, id } 要素追加（Undo で要素を削除）
//   { op: 'linkNodes', elementType, id, tagName, addedNodeIds } 既存の階・通り芯への節点後追い紐づけ（Undo で追加分を削除）
let modifications = [];
let currentEditingElement = null;

// ディスプレイ関数への参照（循環依存回避のため後から設定）
let displayElementInfoFn = null;

/**
 * displayElementInfo関数への参照を設定
 * @param {Function} fn - displayElementInfo関数
 */
export function setDisplayElementInfoFn(fn) {
  displayElementInfoFn = fn;
}

/**
 * 編集モードの状態を取得
 * @returns {boolean} 編集モードの状態
 */
export function isEditMode() {
  return editMode;
}

/**
 * 編集モードの状態を設定
 * @param {boolean} value - 新しい編集モード状態
 */
export function setEditMode(value) {
  editMode = value;
}

/**
 * 現在編集中の要素を取得
 * @returns {Object|null} 現在編集中の要素
 */
export function getCurrentEditingElement() {
  return currentEditingElement;
}

/**
 * 現在編集中の要素を設定
 * @param {Object} element - 要素情報 {idA, idB, elementType, modelSource}
 */
export function setCurrentEditingElement(element) {
  currentEditingElement = element;
}

/**
 * 修正履歴を取得
 * @returns {Array} 修正履歴配列
 */
export function getModifications() {
  return modifications;
}

/**
 * 修正履歴をクリア（再代入）する。clearModifications から使用。
 */
export function resetModifications() {
  modifications = [];
}

/**
 * 現在編集中の要素を再表示して編集UIを反映する。
 * 編集モード切替・属性編集・id リナンバー・Undo の後処理で共通利用する。
 */
export function redisplayCurrentEditingElement() {
  if (currentEditingElement && displayElementInfoFn) {
    const { idA, idB, elementType, modelSource } = currentEditingElement;
    displayElementInfoFn(idA, idB, elementType, modelSource);
  }
}
