/**
 * @fileoverview Element Info の複数選択サマリーへ batch property editor を追加する。
 *
 * 選択の正本は Object3D ではなく semantic selection identity に変換し、Working Session 中だけ
 * 全選択要素に共通する安全な属性を1 transactionで編集する。
 */

import { getSelectedObjects } from '../../../../app/controllers/interactionController.js';
import { createSemanticSelectionIdentity } from '../../../../app/controllers/interaction/semanticSelection.js';
import editingSession from '../../../../app/editing/editingSession.js';
import { showError, showSuccess } from '../../../common/toast.js';
import { applyBatchPropertyEdit, inspectBatchPropertyTargets } from './batchPropertyEdit.js';

function collectSemanticSelections(objects = getSelectedObjects()) {
  return (Array.isArray(objects) ? objects : [])
    .map((object) => createSemanticSelectionIdentity(object?.userData || {}))
    .filter(Boolean);
}

function uniqueValues(values) {
  return [...new Set((values || []).map((value) => (value === null ? '' : String(value))))];
}

function createRow(labelText) {
  const row = document.createElement('div');
  row.className = 'add-member-row';
  const label = document.createElement('label');
  label.className = 'add-member-label';
  label.textContent = labelText;
  row.appendChild(label);
  return row;
}

function appendUnavailableMessage(content, message) {
  const note = document.createElement('div');
  note.className = 'add-member-summary batch-property-edit-note';
  note.textContent = message;
  content.appendChild(note);
}

/**
 * 現在の複数選択を Element Info 上の一括属性編集UIへ接続する。
 * @param {{objects?:Array}} [options]
 * @returns {boolean} editorを表示した場合 true
 */
export function mountBatchPropertyEditor(options = {}) {
  const content = document.getElementById('element-info-content');
  if (!content) return false;
  content.querySelector('.batch-property-editor')?.remove();

  if (editingSession.getState()?.active !== true) return false;

  const selections = collectSemanticSelections(options.objects);
  if (selections.length < 2) return false;

  let inspection;
  try {
    inspection = inspectBatchPropertyTargets(selections);
  } catch (error) {
    appendUnavailableMessage(
      content,
      `一括属性編集を利用できません: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }

  if (inspection.commonAttributes.length === 0) {
    appendUnavailableMessage(content, '選択要素すべてに共通する一括編集可能属性がありません。');
    return false;
  }

  const editor = document.createElement('div');
  editor.className = 'batch-property-editor';
  editor.style.marginTop = '12px';
  editor.style.paddingTop = '8px';
  editor.style.borderTop = '1px solid var(--border-color, #666)';

  const title = document.createElement('div');
  title.style.fontWeight = 'var(--font-weight-bold)';
  title.style.marginBottom = '6px';
  title.textContent = `一括属性編集 (${inspection.targets.length}要素)`;
  editor.appendChild(title);

  const attributeRow = createRow('属性');
  const attributeSelect = document.createElement('select');
  attributeSelect.className = 'parameter-dropdown';
  for (const name of inspection.commonAttributes) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    attributeSelect.appendChild(option);
  }
  attributeRow.appendChild(attributeSelect);
  editor.appendChild(attributeRow);

  const valueRow = createRow('新しい値');
  const valueInput = document.createElement('input');
  valueInput.className = 'parameter-input';
  valueInput.type = 'text';
  valueRow.appendChild(valueInput);
  editor.appendChild(valueRow);

  const currentValueNote = document.createElement('div');
  currentValueNote.className = 'add-member-summary';
  editor.appendChild(currentValueNote);

  const applyButton = document.createElement('button');
  applyButton.type = 'button';
  applyButton.className = 'parameter-editor-ok';
  applyButton.textContent = '選択要素へ一括適用';
  editor.appendChild(applyButton);

  const refreshCurrentValues = () => {
    try {
      inspection = inspectBatchPropertyTargets(selections);
      const name = attributeSelect.value;
      const values = inspection.valuesByAttribute.get(name) || [];
      const unique = uniqueValues(values);
      if (unique.length === 1) {
        valueInput.value = unique[0];
        valueInput.placeholder = '';
        currentValueNote.textContent = `現在値: ${unique[0] === '' ? '（未設定）' : unique[0]}`;
      } else {
        valueInput.value = '';
        valueInput.placeholder = '複数の現在値';
        currentValueNote.textContent = `現在値: ${unique.length}種類`;
      }
    } catch (error) {
      applyButton.disabled = true;
      currentValueNote.textContent =
        error instanceof Error ? error.message : '選択要素を再解決できません。';
    }
  };

  attributeSelect.addEventListener('change', refreshCurrentValues);
  applyButton.addEventListener('click', () => {
    try {
      const result = applyBatchPropertyEdit(selections, attributeSelect.value, valueInput.value);
      if (result.changed === false) {
        showSuccess('選択要素は既に同じ値です');
      } else {
        showSuccess(
          `${result.targetCount}要素の ${result.attributeName} を1 transactionで更新しました`,
        );
      }
      refreshCurrentValues();
    } catch (error) {
      showError(
        `一括属性編集を確定できませんでした: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  refreshCurrentValues();
  content.appendChild(editor);
  return true;
}

export { collectSemanticSelections };
