/**
 * @fileoverview 修正履歴のサマリーUIと Undo / Export / Clear
 *
 * Working Session 有効時は EditingSession.history を履歴正本とし、legacy modifications と
 * 混在させない。未開始時のみ従来の editMode 履歴を利用する。
 */

import editingSession from '../../../../app/editing/editingSession.js';
import {
  exportStbDocument,
  validateDocumentForExport,
  generateModificationReport,
} from '../../../../export/stb/stbExporter.js';
import { showSuccess, showError, showWarning } from '../../../common/toast.js';
import {
  getModifications,
  resetModifications,
  getCurrentEditingElement,
  redisplayCurrentEditingElement,
} from './editState.js';
import {
  applyIdRenumber,
  applyAttributeEditToDocument,
  unlinkNodesFromDocument,
  removeElementFromDocument,
} from './editAppliers.js';
import {
  undoAddedOpen,
  undoAddedJointArrangement,
  undoJointAssignment202,
} from './compoundEditAppliers.js';

function getWorkingSessionState() {
  const state = editingSession.getState();
  return state?.active ? state : null;
}

function getActiveModificationCount() {
  const working = getWorkingSessionState();
  return working ? working.history?.length || 0 : getModifications().length;
}

/**
 * 修正済みドキュメントをエクスポート
 * Working Document セッションが有効な場合は workingDocument、未開始の場合は
 * 従来どおり Model A を対象とする。
 */
export function exportModifications() {
  const working = getWorkingSessionState();
  const count = getActiveModificationCount();
  if (count === 0) {
    showWarning('修正がありません。');
    return;
  }

  const targetDoc = editingSession.getActiveEditDocument();
  if (!targetDoc) {
    showWarning('エクスポート対象のドキュメントがありません。');
    return;
  }

  const validation = validateDocumentForExport(targetDoc);
  const proceed = confirm(
    `${count}件の修正をエクスポートしますか？\n\n` + `バリデーション: ${validation.message}`,
  );

  if (proceed) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `modified_stb_${timestamp}.stb`;

    exportStbDocument(targetDoc, { filename })
      .then(() => {
        showSuccess(`STBファイルが正常にエクスポートされました。ファイル名: ${filename}`);
        // Working Command は legacy modification report と構造が異なるため混在させない。
        // Phase 5 で共通履歴レポート形式を定義するまでは legacy 経路のみ生成する。
        if (!working) {
          generateModificationReport(getModifications());
        }
      })
      .catch((error) => {
        showError(`エクスポートに失敗しました: ${error.message}`);
      });
  }
}

/** 編集サマリーを更新 */
export function updateEditingSummary() {
  const summaryElement = document.getElementById('editing-summary');
  if (!summaryElement) return;

  const working = getWorkingSessionState();
  const count = getActiveModificationCount();
  summaryElement.innerHTML = `
    修正: ${count}件
    ${count > 0 ? '<button id="undo-modification-btn" class="edit-summary-btn edit-summary-btn-undo">元に戻す</button>' : ''}
    ${count > 0 ? '<button id="export-btn" class="edit-summary-btn edit-summary-btn-export">出力</button>' : ''}
    ${count > 0 && !working ? '<button id="clear-modifications-btn" class="edit-summary-btn edit-summary-btn-clear">削除</button>' : ''}
  `;
  const undoBtn = summaryElement.querySelector('#undo-modification-btn');
  if (undoBtn) undoBtn.onclick = undoLastModification;
  const exportBtn = summaryElement.querySelector('#export-btn');
  if (exportBtn) exportBtn.onclick = exportModifications;
  const clearBtn = summaryElement.querySelector('#clear-modifications-btn');
  if (clearBtn) clearBtn.onclick = clearModifications;
}

/** 直前の修正を元に戻す（Undo）。 */
export function undoLastModification() {
  const working = getWorkingSessionState();
  if (working) {
    if ((working.history?.length || 0) === 0) return;
    const result = editingSession.undo();
    if (result) {
      updateEditingSummary();
      redisplayCurrentEditingElement();
    }
    return;
  }

  const modifications = getModifications();
  if (modifications.length === 0) return;

  const last = modifications[modifications.length - 1];
  const currentEditingElement = getCurrentEditingElement();

  let success;
  if (last.op === 'addOpen') {
    success = undoAddedOpen(last);
  } else if (last.op === 'addJointArrangement') {
    success = undoAddedJointArrangement(last);
  } else if (last.op === 'assignJoint202') {
    success = undoJointAssignment202(last);
  } else if (last.op === 'add') {
    success = removeElementFromDocument(last.elementType, last.id, last.tagName);
  } else if (last.op === 'linkNodes') {
    success = unlinkNodesFromDocument(last);
  } else if (last.op === 'renumberId') {
    success = applyIdRenumber(last.elementType, last.newId, last.oldId).success;
    if (
      success &&
      currentEditingElement &&
      String(currentEditingElement.idA) === String(last.newId)
    ) {
      currentEditingElement.idA = String(last.oldId);
    }
  } else {
    success = applyAttributeEditToDocument(
      last.elementType,
      last.id,
      last.attribute,
      last.oldValue,
      last.path,
    );
  }

  if (success) {
    modifications.pop();
    updateEditingSummary();
    redisplayCurrentEditingElement();
  }
}

/** 修正履歴をクリア */
export function clearModifications() {
  if (getWorkingSessionState()) {
    showWarning(
      'Working Session 中は履歴を直接削除できません。Undo または編集セッション破棄を使用してください。',
    );
    return;
  }

  if (getModifications().length === 0) return;

  const proceed = confirm(`${getModifications().length}件の修正履歴をクリアしますか？`);
  if (proceed) {
    resetModifications();
    updateEditingSummary();
  }
}
