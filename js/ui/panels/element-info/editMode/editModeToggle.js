/**
 * @fileoverview 編集モードの切替とインライン編集/ダイアログ編集の配線
 *
 * 通常の自由入力属性は要素情報テーブル上で直接編集する。
 * 列挙値・固定値・参照ID・識別子などルールを伴う属性だけは従来の
 * ParameterEditor ダイアログを使用する。
 */

import {
  getAttributeInfo,
  isSchemaLoaded,
  validateAttributeValue,
} from '../../../../common-stb/import/parser/jsonSchemaLoader.js';
import {
  getModifications,
  isEditMode,
  redisplayCurrentEditingElement,
  setEditMode,
} from './editState.js';
import { editAttributeValue } from './attributeEdit.js';
import { applyAttributeEditToDocument } from './editAppliers.js';
import { updateEditingSummary } from './editHistory.js';

/**
 * STB要素タイプからXSD/JSON Schema上のタグ名を得る。
 * @param {string} elementType
 * @returns {string}
 */
function getSchemaTagName(elementType) {
  return elementType === 'Node' ? 'StbNode' : `Stb${elementType}`;
}

/**
 * 属性がダイアログ編集を必要とするか判定する。
 *
 * 直接入力に向くのは、name / 座標 / offset / 寸法など「値をそのまま入力できる」属性。
 * 一方、識別子・参照・列挙・固定値・範囲/パターン制約は誤入力を避けるため
 * ParameterEditor の候補/検証UIを維持する。
 * @param {string} elementType
 * @param {string} attributeName
 * @returns {boolean}
 */
export function requiresParameterDialog(elementType, attributeName) {
  const attr = String(attributeName || '');
  const lower = attr.toLowerCase();

  // 自己識別子と他要素参照は、重複チェック・参照候補・追従更新が必要。
  if (
    lower === 'id' ||
    lower === 'guid' ||
    lower.startsWith('id_') ||
    /_id(?:_|$)/.test(lower)
  ) {
    return true;
  }

  if (!isSchemaLoaded()) return false;

  const info = getAttributeInfo(getSchemaTagName(elementType), attr);
  if (!info) return false;

  if (info.fixed !== null && info.fixed !== undefined) return true;
  if (info.type === 'boolean') return true;

  const c = info.constraints;
  if (!c) return false;

  if ((c.enumerations?.length || 0) > 0) return true;
  if ((c.patterns?.length || 0) > 0) return true;
  if (c.minExclusive !== null && c.minExclusive !== undefined) return true;
  if (c.maxExclusive !== null && c.maxExclusive !== undefined) return true;
  if (c.minInclusive !== null && c.minInclusive !== undefined) return true;
  if (c.maxInclusive !== null && c.maxInclusive !== undefined) return true;

  return false;
}

/**
 * edit-btn のdata属性を別要素へ転記する。
 * @param {HTMLElement} source
 * @param {HTMLElement} target
 */
function copyEditDataset(source, target) {
  for (const key of ['editType', 'editId', 'editAttr', 'editValue', 'editPath']) {
    if (source.dataset[key] !== undefined) {
      target.dataset[key] = source.dataset[key];
    }
  }
}

/**
 * ComparisonRenderer が生成した編集ボタンを、インライン入力またはクリック可能セルへ変換する。
 * 鉛筆アイコンは表示しない。
 * @param {ParentNode} [root=document]
 */
export function decorateEditableAttributeCells(root = document) {
  if (!isEditMode()) return;

  root.querySelectorAll?.('.edit-btn[data-edit-attr]').forEach((button) => {
    const cell = button.closest('td');
    if (!cell || cell.dataset.editDecorated === 'true') return;

    const elementType = button.dataset.editType || '';
    const attributeName = button.dataset.editAttr || '';
    const currentValue = button.dataset.editValue || '';

    cell.dataset.editDecorated = 'true';

    if (requiresParameterDialog(elementType, attributeName)) {
      copyEditDataset(button, cell);
      cell.classList.add('rule-edit-cell');
      cell.setAttribute('role', 'button');
      cell.tabIndex = 0;
      const existingTitle = cell.getAttribute('title');
      cell.setAttribute(
        'title',
        existingTitle ? `${existingTitle}\nクリックして選択・設定` : 'クリックして選択・設定',
      );
      button.remove();
      return;
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-attr-input';
    input.value = currentValue;
    input.setAttribute('aria-label', `${attributeName} を編集`);
    copyEditDataset(button, input);

    const info = isSchemaLoaded()
      ? getAttributeInfo(getSchemaTagName(elementType), attributeName)
      : null;
    if (info?.type === 'number') input.inputMode = 'decimal';
    if (info?.type === 'integer') input.inputMode = 'numeric';
    if (info?.required) input.required = true;

    cell.replaceChildren(input);
    cell.classList.add('inline-edit-cell');
  });
}

/**
 * インライン入力値を確定する。
 * @param {HTMLInputElement} input
 */
function commitInlineAttribute(input) {
  const { editType, editId, editAttr, editValue, editPath } = input.dataset;
  if (!editType || !editAttr) return;

  const oldValue = editValue || '';
  const newValue = input.value;
  if (newValue === oldValue) return;

  // 直接入力でもXSD型チェックは通す。不正値の場合のみ従来ダイアログへ移行する。
  if (isSchemaLoaded()) {
    const validation = validateAttributeValue(getSchemaTagName(editType), editAttr, newValue);
    if (!validation.valid && validation.blocking !== false) {
      input.value = oldValue;
      editAttributeValue(editType, editId || '', editAttr, oldValue, {
        path: editPath || null,
      });
      return;
    }
  }

  getModifications().push({
    op: 'attr',
    elementType: editType,
    id: editId || '',
    path: editPath || null,
    attribute: editAttr,
    oldValue,
    newValue,
  });

  const success = applyAttributeEditToDocument(
    editType,
    editId || '',
    editAttr,
    newValue,
    editPath || null,
  );

  if (!success) {
    getModifications().pop();
    input.value = oldValue;
    return;
  }

  updateEditingSummary();
  redisplayCurrentEditingElement();
  queueEditableDecoration();
}

/**
 * ルール付きセルから従来のParameterEditorを開く。
 * @param {HTMLElement} cell
 */
function openRuleEditor(cell) {
  const { editType, editId, editAttr, editValue, editPath } = cell.dataset;
  if (!editType || !editAttr) return;
  editAttributeValue(editType, editId || '', editAttr, editValue || '', {
    path: editPath || null,
  });
}

let decorationQueued = false;
function queueEditableDecoration() {
  if (decorationQueued) return;
  decorationQueued = true;
  queueMicrotask(() => {
    decorationQueued = false;
    decorateEditableAttributeCells(document);
  });
}

/**
 * 編集モードの切り替え
 */
export function toggleEditMode() {
  const next = !isEditMode();
  setEditMode(next);
  const editButton = document.getElementById('edit-mode-button');
  if (editButton) {
    editButton.textContent = next ? '✏️ 編集モード（ON）' : '✏️ 編集モード';
    editButton.classList.toggle('edit-mode-active', next);
  }

  // 現在表示中の要素を再表示して編集UIを反映
  redisplayCurrentEditingElement();
  if (next) queueEditableDecoration();
}

/** 編集イベントデリゲーションの登録済みフラグ */
let isEditButtonDelegationInitialized = false;
let editMutationObserver = null;

// DOM初期化後にイベントリスナーを設定（window.*グローバル汚染の解消）
export function initializeEditModeButton() {
  const editModeBtn = document.getElementById('edit-mode-button');
  if (editModeBtn) {
    editModeBtn.addEventListener('click', toggleEditMode);
  }

  if (!isEditButtonDelegationInitialized) {
    // 通常属性: セル内inputを直接編集し、changeで確定する。
    document.addEventListener('change', (event) => {
      const input = /** @type {HTMLElement} */ (event.target)?.closest?.('.inline-attr-input');
      if (input instanceof HTMLInputElement) commitInlineAttribute(input);
    });

    document.addEventListener('keydown', (event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      const input = target?.closest?.('.inline-attr-input');
      if (input instanceof HTMLInputElement) {
        if (event.key === 'Enter') {
          event.preventDefault();
          input.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          input.value = input.dataset.editValue || '';
          input.blur();
        }
        return;
      }

      const cell = target?.closest?.('.rule-edit-cell[data-edit-attr]');
      if (cell && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        openRuleEditor(cell);
      }
    });

    // ルール付き属性は値セル自体をクリックすると従来ダイアログを開く。
    document.addEventListener('click', (event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      const cell = target?.closest?.('.rule-edit-cell[data-edit-attr]');
      if (cell) {
        openRuleEditor(cell);
        return;
      }

      // MutationObserverで装飾される前にクリックされた場合のフォールバック。
      const button = target?.closest?.('.edit-btn[data-edit-attr]');
      if (!button) return;
      const { editType, editId, editAttr, editValue, editPath } = button.dataset;
      editAttributeValue(editType, editId || '', editAttr, editValue || '', {
        path: editPath || null,
      });
    });

    // 要素を切り替えた際の再描画でも、自動的に編集セルへ変換する。
    editMutationObserver = new MutationObserver(() => {
      if (isEditMode()) queueEditableDecoration();
    });
    editMutationObserver.observe(document.body, { childList: true, subtree: true });

    isEditButtonDelegationInitialized = true;
  }

  if (isEditMode()) queueEditableDecoration();

  // E2Eテスト用ブリッジ: UIを介さずに属性編集パイプラインを直接起動する
  window.__editBridge = {
    applyEdit: (elementType, elementId, attrName, newValue, editPath = null) =>
      applyAttributeEditToDocument(elementType, elementId, attrName, newValue, editPath),
    decorateEditableAttributeCells,
    requiresParameterDialog,
  };
}