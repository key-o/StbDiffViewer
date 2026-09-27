/**
 * @fileoverview 編集モードの切替とインライン編集/ダイアログ編集の配線
 *
 * 通常の自由入力属性は要素情報テーブル上で直接編集する。
 * 列挙値・固定値・参照ID・識別子などルールを伴う属性だけは従来の
 * ParameterEditor ダイアログを使用する。
 *
 * Phase 6 では、Phase 5 までに主要 mutation 入口が Working Command 化されたことを前提に、
 * 編集モード ON を Working Session の production 起動点とする。OFF 時は dirty な Working
 * Session を確認なしで破棄せず、ユーザー確認後に source snapshot へ戻す。
 */

import {
  getAttributeInfo,
  isSchemaLoaded,
  validateAttributeValue,
} from '../../../../common-stb/import/parser/jsonSchemaLoader.js';
import { eventBus, EditEvents } from '../../../../data/events/index.js';
import editingSession from '../../../../app/editing/editingSession.js';
import { resolveElementTagName } from '../../../../app/editing/attributeCommandUtils.js';
import { showError } from '../../../common/toast.js';
import {
  getModifications,
  isEditMode,
  redisplayCurrentEditingElement,
  setEditMode,
} from './editState.js';
import { commitWorkingAttributeEdit, editAttributeValue } from './attributeEdit.js';
import { applyAttributeEditToDocument } from './editAppliers.js';
import { updateEditingSummary } from './editHistory.js';

/**
 * STB要素タイプからXSD/JSON Schema上のタグ名を得る。
 * @param {string} elementType
 * @returns {string}
 */
function getSchemaTagName(elementType) {
  return resolveElementTagName(elementType) || `Stb${elementType}`;
}

function isWorkingSessionActive() {
  return editingSession.getState()?.active === true;
}

function syncEditModeButton(active = isEditMode()) {
  const editButton = document.getElementById('edit-mode-button');
  if (editButton) {
    editButton.textContent = active ? '✏️ 編集モード（ON）' : '✏️ 編集モード';
    editButton.classList.toggle('edit-mode-active', active);
  }

  const editingControls = document.getElementById('editing-controls');
  if (editingControls) {
    editingControls.hidden = !active;
    editingControls.setAttribute('aria-hidden', active ? 'false' : 'true');
  }
}

function startWorkingSessionIfNeeded() {
  if (isWorkingSessionActive()) return true;
  try {
    editingSession.start();
    return true;
  } catch (error) {
    showError(
      `編集セッションを開始できませんでした: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

function confirmWorkingSessionDiscard() {
  const state = editingSession.getState();
  if (!state?.active || state.dirty !== true) return true;
  const count = state.history?.length || 0;
  if (typeof globalThis.confirm !== 'function') return false;
  return globalThis.confirm(
    `${count}件の Working Document 編集があります。\n` +
      '編集モードを終了すると現在の Working Document 編集を破棄します。よろしいですか？',
  );
}

function stopWorkingSessionIfActive() {
  if (!isWorkingSessionActive()) return true;
  if (!confirmWorkingSessionDiscard()) return false;
  editingSession.discard();
  return true;
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

  if (lower === 'id' || lower === 'guid' || lower.startsWith('id_') || /_id(?:_|$)/.test(lower)) {
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

function copyEditDataset(source, target) {
  for (const key of ['editType', 'editId', 'editAttr', 'editValue', 'editPath']) {
    if (source.dataset[key] !== undefined) {
      target.dataset[key] = source.dataset[key];
    }
  }
}

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

function commitInlineAttribute(input) {
  const { editType, editId, editAttr, editValue, editPath } = input.dataset;
  if (!editType || !editAttr) return;

  const oldValue = editValue || '';
  const newValue = input.value;
  if (newValue === oldValue) return;

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

  if (isWorkingSessionActive()) {
    try {
      commitWorkingAttributeEdit(editType, editId || '', editAttr, newValue, editPath || null);
    } catch (error) {
      input.value = oldValue;
      showError(
        `編集を確定できませんでした: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    updateEditingSummary();
    redisplayCurrentEditingElement();
    queueEditableDecoration();
    return;
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
  globalThis.queueMicrotask(() => {
    decorationQueued = false;
    decorateEditableAttributeCells(document);
  });
}

export function toggleEditMode() {
  const next = !isEditMode();

  if (next) {
    if (!startWorkingSessionIfNeeded()) return false;
    setEditMode(true);
  } else {
    if (!stopWorkingSessionIfActive()) return false;
    setEditMode(false);
  }

  syncEditModeButton(next);
  updateEditingSummary();
  redisplayCurrentEditingElement();
  if (next) queueEditableDecoration();
  eventBus.emit(EditEvents.MODE_TOGGLED, { active: next });
  return true;
}

let isEditButtonDelegationInitialized = false;
let workingSummaryListenerInitialized = false;
let editMutationObserver = null;

export function initializeEditModeButton() {
  const editModeBtn = document.getElementById('edit-mode-button');
  if (editModeBtn) {
    editModeBtn.addEventListener('click', toggleEditMode);
  }

  if (!workingSummaryListenerInitialized) {
    eventBus.on(EditEvents.WORKING_DOCUMENT_CHANGED, () => {
      updateEditingSummary();
      syncEditModeButton(isEditMode());
    });
    workingSummaryListenerInitialized = true;
  }

  if (!isEditButtonDelegationInitialized) {
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

    document.addEventListener('click', (event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      const cell = target?.closest?.('.rule-edit-cell[data-edit-attr]');
      if (cell) {
        openRuleEditor(cell);
        return;
      }

      const button = target?.closest?.('.edit-btn[data-edit-attr]');
      if (!button) return;
      const { editType, editId, editAttr, editValue, editPath } = button.dataset;
      editAttributeValue(editType, editId || '', editAttr, editValue || '', {
        path: editPath || null,
      });
    });

    editMutationObserver = new MutationObserver(() => {
      if (isEditMode()) queueEditableDecoration();
    });
    editMutationObserver.observe(document.body, { childList: true, subtree: true });

    isEditButtonDelegationInitialized = true;
  }

  syncEditModeButton(isEditMode());
  if (isEditMode()) queueEditableDecoration();

  window.__editBridge = {
    applyEdit: (elementType, elementId, attrName, newValue, editPath = null) =>
      isWorkingSessionActive()
        ? commitWorkingAttributeEdit(elementType, elementId, attrName, newValue, editPath)
        : applyAttributeEditToDocument(elementType, elementId, attrName, newValue, editPath),
    decorateEditableAttributeCells,
    requiresParameterDialog,
  };
}
