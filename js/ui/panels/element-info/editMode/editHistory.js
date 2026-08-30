/**
 * @fileoverview 修正履歴のサマリーUIと Undo / Export / Clear
 *
 * 修正件数の表示と、元に戻す・出力・削除の各操作をまとめる。undo は op に応じて
 * `editAppliers` / `compoundEditAppliers` の逆操作を呼ぶ。
 */

import { getState } from '../../../../data/state/globalState.js';
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

/**
 * 修正済みドキュメントをエクスポート
 * 編集はdocumentAへ直接適用済みのため、ドキュメントをそのままシリアライズする
 */
export function exportModifications() {
  if (getModifications().length === 0) {
    showWarning('修正がありません。');
    return;
  }

  const sourceDoc = getState('models.documentA');
  if (!sourceDoc) {
    showWarning('エクスポート対象のドキュメントがありません。');
    return;
  }

  const validation = validateDocumentForExport(sourceDoc);
  const proceed = confirm(
    `${getModifications().length}件の修正をエクスポートしますか？\n\n` +
      `バリデーション: ${validation.message}`,
  );

  if (proceed) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `modified_stb_${timestamp}.stb`;

    exportStbDocument(sourceDoc, { filename })
      .then(() => {
        showSuccess(`STBファイルが正常にエクスポートされました。ファイル名: ${filename}`);
        generateModificationReport(getModifications());
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

  const count = getModifications().length;
  summaryElement.innerHTML = `
    修正: ${count}件
    ${count > 0 ? '<button id="undo-modification-btn" class="edit-summary-btn edit-summary-btn-undo">元に戻す</button>' : ''}
    ${count > 0 ? '<button id="export-btn" class="edit-summary-btn edit-summary-btn-export">出力</button>' : ''}
    ${count > 0 ? '<button id="clear-modifications-btn" class="edit-summary-btn edit-summary-btn-clear">削除</button>' : ''}
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
  if (getModifications().length === 0) return;

  const proceed = confirm(`${getModifications().length}件の修正履歴をクリアしますか？`);
  if (proceed) {
    resetModifications();
    updateEditingSummary();
  }
}
