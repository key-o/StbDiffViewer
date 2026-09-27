/**
 * @fileoverview id リナンバー（要素自身の id 変更）と識別子入力設定
 *
 * id / guid の専用入力設定の構築、id の一意性検証、参照追従を伴う id 変更（確認ダイアログ付き）を担当する。
 * Working Session 中の入力候補・重複検証は active Working Document を参照し、legacy 確定処理だけを
 * `editAppliers.applyIdRenumber` に委譲する。
 */

import { eventBus, EditEvents } from '../../../../data/events/index.js';
import { getState } from '../../../../data/state/globalState.js';
import editDocumentProvider from '../../../../app/editing/editDocumentProvider.js';
import { showSuccess, showError, showWarning } from '../../../common/toast.js';
import { generateStbGuid } from '../../../../common-stb/utils/guidUtil.js';
import { countIdReferences } from '../../../../common-stb/edit/idReferenceUpdater.js';
import { generateNextId } from './domHelpers.js';
import { applyIdRenumber } from './editAppliers.js';
import { updateEditingSummary } from './editHistory.js';
import { getLegacyMutationBlockedReason } from './legacyMutationGate.js';
import {
  getModifications,
  getCurrentEditingElement,
  redisplayCurrentEditingElement,
} from './editState.js';

/**
 * 自己同一性属性（id / guid）の専用入力設定を構築する。
 *
 * これらは「既存値から選択する」参照属性（id_section / id_node 等）とは意図が逆で、
 * 「重複しない一意な新規値を入力・生成する」用途。ParameterEditor へ generate（自動生成）
 * と extraValidate（id の一意性検証）を渡し、直接入力＋自動生成ボタンの専用入力を有効化する。
 * Working Session active 中は採番・重複検証とも Working Document を対象とする。
 * @param {string} attributeName - 属性名
 * @param {string} tagName - STB タグ名（例: 'StbColumn'）
 * @param {string} elementId - 編集対象の現在の id（自身との重複を許容するため）
 * @returns {{generate: () => string, generateLabel: string, inputHelp: string,
 *   extraValidate?: (value: string) => (string|null)}|null} 識別子でなければ null
 */
export function buildIdentityEditConfig(attributeName, tagName, elementId) {
  if (attributeName === 'guid') {
    return {
      generate: () => generateStbGuid(),
      generateLabel: '🔄 自動生成',
      inputHelp: 'GUID を直接入力するか、自動生成してください（小文字16進32桁）',
    };
  }

  if (attributeName === 'id') {
    return {
      generate: () => {
        const doc = editDocumentProvider.getActiveEditDocument();
        return doc ? generateNextId(doc, tagName) : '';
      },
      generateLabel: '🔢 空き番号',
      inputHelp: '一意な番号を直接入力するか、空き番号を自動採番してください',
      extraValidate: (value) => validateUniqueId(tagName, elementId, value),
    };
  }

  return null;
}

/**
 * 編集後の id が同種要素（同一タグ名）の中で一意かを検証する。
 * 値が現在の id から変わっておらず、または重複が無ければ null、重複していればメッセージを返す。
 * Working Session active 中は Working Document を対象とする。
 * @param {string} tagName - STB タグ名
 * @param {string} currentId - 編集前の id
 * @param {string} value - 入力された新しい id
 * @returns {string|null} 重複時のエラーメッセージ、問題なければ null
 */
function validateUniqueId(tagName, currentId, value) {
  const v = String(value ?? '').trim();
  if (!v || v === String(currentId ?? '')) return null;
  const doc = editDocumentProvider.getActiveEditDocument();
  if (!doc) return null;
  const dup = doc.querySelector(`${tagName}[id="${v.replace(/"/g, '\\"')}"]`);
  return dup ? `ID ${v} は既に ${tagName} で使用されています` : null;
}

/**
 * id のリナンバー（要素自身の id 変更）を、参照追従更新と確認ダイアログ付きで実行する。
 * 節点・断面の id 変更時は、これを参照する部材等（id_node 系属性・StbNodeId・
 * StbNodeIdOrder・id_section 系属性）を同一ドキュメント内で同時に更新し、整合した STB を保つ。
 * 履歴には {op:'renumberId'} を記録し、Undo で逆方向のリナンバーとして取り消す。
 * Working Session 中は semantic RenumberIdCommand を利用するため、この legacy source mutation は
 * fail-closed とする。
 * @param {string} elementType - 要素タイプ（'Node' / 'Column' / 'SecColumn_RC' 等）
 * @param {string} oldId - 変更前の id
 * @param {string} currentValue - 現在の id（oldId と同じ。比較用）
 * @param {string} newId - 変更後の id
 */
export function handleIdRenumber(elementType, oldId, currentValue, newId) {
  const blocked = getLegacyMutationBlockedReason('ID変更');
  if (blocked) {
    showWarning(blocked);
    eventBus.emit(EditEvents.EDIT_CANCELLED, {
      elementType,
      elementId: String(oldId ?? ''),
      attributeName: 'id',
      timestamp: Date.now(),
    });
    return;
  }

  const old = String(currentValue ?? oldId ?? '');
  const nw = String(newId ?? '');
  if (!nw || old === nw) return; // 変更なし

  const doc = getState('models.documentA');
  if (!doc) {
    showWarning('モデルAが読み込まれていません。');
    return;
  }

  const tagName = elementType === 'Node' ? 'StbNode' : `Stb${elementType}`;
  const refCount = countIdReferences(doc, tagName, old);

  // 警告: id 変更が参照に波及することをユーザーへ確認する
  const proceed = confirm(
    `ID ${old} を ${nw} に変更します。\n\n` +
      (refCount > 0
        ? `このIDを参照している${refCount}件の要素も自動的に更新されます。\n`
        : 'このIDを参照している要素はありません。\n') +
      '続行しますか？',
  );
  if (!proceed) {
    eventBus.emit(EditEvents.EDIT_CANCELLED, {
      elementType,
      elementId: old,
      attributeName: 'id',
      timestamp: Date.now(),
    });
    return;
  }

  const result = applyIdRenumber(elementType, old, nw);
  if (!result.success) {
    showError('ID の変更に失敗しました。');
    return;
  }

  getModifications().push({ op: 'renumberId', elementType, oldId: old, newId: nw });

  // 表示中の要素自身をリナンバーした場合は、再表示用の参照IDも追従させる
  const currentEditingElement = getCurrentEditingElement();
  if (currentEditingElement && String(currentEditingElement.idA) === old) {
    currentEditingElement.idA = nw;
  }
  redisplayCurrentEditingElement();

  updateEditingSummary();
  showSuccess(
    result.refCount > 0
      ? `ID を ${nw} に変更し、参照 ${result.refCount}件を更新しました`
      : `ID を ${nw} に変更しました`,
  );
}
