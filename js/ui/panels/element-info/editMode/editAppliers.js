/**
 * @fileoverview 低レベルな documentA 文書適用（Undo が呼ぶ逆操作の実体）
 *
 * 属性更新・id リナンバー・節点紐づけ解除・要素削除を、修正履歴やサマリーUIに依存せず
 * documentA に対して適用する。high-level 操作（属性編集・リナンバー・追加）と undo の双方から
 * 共有されるため、`editHistory` に依存しない葉モジュールとして切り出している。
 */

import { createLogger } from '../../../../utils/logger.js';
import { eventBus, EditEvents } from '../../../../data/events/index.js';
import { getState } from '../../../../data/state/globalState.js';
import { resolveElementEditPath, getEditPathAnchor } from '../editPath.js';
import {
  collectIdReferences,
  applyIdReferenceUpdate,
} from '../../../../common-stb/edit/idReferenceUpdater.js';
import { findDirectChild, emitStructuralChange } from './domHelpers.js';

const log = createLogger('viewer:edit-mode');

/**
 * XMLドキュメントの属性を更新し、ATTRIBUTE_CHANGED イベントを発行する。
 * キャッシュ反映・再比較・3D再描画・ラベル更新は購読側のコントローラーが行う。
 * @param {string} elementType - 要素タイプ
 * @param {string} elementId - 要素ID
 * @param {string} attributeName - 属性名
 * @param {string} newValue - 新しい値
 * @param {string|null} [editPath] - 編集パス（id属性を持たない子要素用）
 * @returns {boolean} 更新成功可否
 */
export function applyAttributeEditToDocument(
  elementType,
  elementId,
  attributeName,
  newValue,
  editPath,
) {
  try {
    // モデルAのXMLドキュメントを取得
    const doc = getState('models.documentA');
    if (!doc) {
      log.error('docA not found');
      return false;
    }

    // XMLから要素を検索（id無し子要素はパスで解決）
    let element;
    if (editPath) {
      element = resolveElementEditPath(doc, editPath);
    } else {
      const tagName = elementType === 'Node' ? 'StbNode' : `Stb${elementType}`;
      element = doc.querySelector(`${tagName}[id="${elementId}"]`);
    }

    if (!element) {
      log.error(`編集対象要素が見つかりません: ${editPath || `${elementType}#${elementId}`}`);
      return false;
    }

    // 更新前の値を保存
    const oldValue = element.getAttribute(attributeName);

    // 属性を更新
    if (newValue === null || newValue === undefined || newValue === '') {
      element.removeAttribute(attributeName);
    } else {
      element.setAttribute(attributeName, newValue);
    }

    // 属性変更イベントの発行対象を決定。
    // パス編集（id無し子要素）の場合は、idを持つアンカー要素（断面ルート等）として通知し、
    // editComparisonSyncController が断面キャッシュ更新と影響部材の解決を行えるようにする。
    let emitElementType = elementType;
    let emitElementId = elementId;
    if (editPath) {
      const anchor = getEditPathAnchor(editPath);
      if (anchor?.tagName?.startsWith('Stb')) {
        emitElementType = anchor.tagName.slice(3);
        emitElementId = anchor.id;
      }
    }

    eventBus.emit(EditEvents.ATTRIBUTE_CHANGED, {
      elementType: emitElementType,
      elementId: emitElementId,
      attributeName,
      oldValue,
      newValue,
      modelSource: 'modelA',
      timestamp: Date.now(),
    });

    return true;
  } catch (error) {
    log.error('Error updating XML document:', error);
    return false;
  }
}

/**
 * id とその参照を oldId → newId へ書き換え、再比較・再描画パイプラインを起動する。
 * Undo では new→old を渡して逆方向に適用する（処理は対称）。
 * @param {string} elementType - 要素タイプ
 * @param {string} oldId - 変更前の id
 * @param {string} newId - 変更後の id
 * @returns {{success: boolean, refCount: number, category?: string}}
 */
export function applyIdRenumber(elementType, oldId, newId) {
  const doc = getState('models.documentA');
  if (!doc) return { success: false, refCount: 0 };

  const tagName = elementType === 'Node' ? 'StbNode' : `Stb${elementType}`;
  const owner = doc.querySelector(`${tagName}[id="${String(oldId).replace(/"/g, '\\"')}"]`);
  if (!owner) {
    log.error(`リナンバー対象が見つかりません: ${tagName}#${oldId}`);
    return { success: false, refCount: 0 };
  }

  const { category, refs } = collectIdReferences(doc, tagName, oldId);
  applyIdReferenceUpdate(refs, oldId, newId);
  owner.setAttribute('id', String(newId));

  emitRenumberEvents(category, elementType, oldId, newId);
  return { success: true, refCount: refs.length, category };
}

/**
 * リナンバー後の再比較・再描画イベントを発行する。
 * 節点は「旧IDの除去」→「新IDの反映（影響部材の再抽出）」の2段で通知し、
 * 既存の節点編集パイプライン（キャッシュ・nodeMap 同期）を再利用する。
 * @param {'node'|'section'|'other'} category
 * @param {string} elementType
 * @param {string} oldId
 * @param {string} newId
 */
function emitRenumberEvents(category, elementType, oldId, newId) {
  const base = {
    attributeName: 'id',
    oldValue: oldId,
    newValue: newId,
    modelSource: 'modelA',
  };
  if (category === 'node') {
    eventBus.emit(EditEvents.ATTRIBUTE_CHANGED, {
      ...base,
      elementType: 'Node',
      elementId: oldId,
      timestamp: Date.now(),
    });
    eventBus.emit(EditEvents.ATTRIBUTE_CHANGED, {
      ...base,
      elementType: 'Node',
      elementId: newId,
      timestamp: Date.now(),
    });
  } else {
    eventBus.emit(EditEvents.ATTRIBUTE_CHANGED, {
      ...base,
      elementType,
      elementId: newId,
      timestamp: Date.now(),
    });
  }
}

/**
 * 後追い紐づけ（op:'linkNodes'）の Undo。追加した StbNodeId のみ削除し、リストが空になれば
 * StbNodeIdList も除去する。
 * @param {{elementType: string, id: string, tagName: string, addedNodeIds: string[]}} mod
 * @returns {boolean}
 */
export function unlinkNodesFromDocument(mod) {
  const doc = getState('models.documentA');
  if (!doc) return false;
  const target = doc.querySelector(`${mod.tagName}[id="${String(mod.id).replace(/"/g, '\\"')}"]`);
  const listEl = target && findDirectChild(target, 'StbNodeIdList');
  if (!listEl) return false;

  const toRemove = new Set(mod.addedNodeIds.map(String));
  for (const idEl of Array.from(listEl.getElementsByTagName('StbNodeId'))) {
    if (toRemove.has(idEl.getAttribute('id'))) idEl.remove();
  }
  if (listEl.getElementsByTagName('StbNodeId').length === 0) listEl.remove();

  eventBus.emit(EditEvents.ATTRIBUTE_CHANGED, {
    elementType: mod.elementType,
    elementId: mod.id,
    attributeName: null,
    oldValue: null,
    newValue: null,
    modelSource: 'modelA',
    timestamp: Date.now(),
  });
  return true;
}

/**
 * 子要素が空になったコンテナを祖先方向へ辿って除去する（StbModel は対象外）。
 * 新規追加の Undo で、追加時に生成された空コンテナ（StbStories・StbAxes・各軸グループ・
 * StbColumns 等の型コンテナ）が残り XSD 違反になるのを防ぐ。属性のみで子を持たない
 * 要素（StbNode 等）は対象にならない（リーフはこの関数に渡さない）。
 * @param {Element|null} startParent - 削除したリーフの親要素
 */
function removeEmptyAncestors(startParent) {
  let node = startParent;
  while (node && node.tagName !== 'StbModel' && node.children.length === 0) {
    const parent = node.parentNode;
    node.remove();
    node = parent;
  }
}

/**
 * documentA から要素を削除し、ATTRIBUTE_CHANGED で再描画パイプラインを起動する。
 * 新規追加（op:'add'）の Undo に使用する。
 * @param {string} elementType
 * @param {string} elementId
 * @param {string} [explicitTagName] - 明示タグ名（断面要素など elementType から復元できない場合）
 * @returns {boolean}
 */
export function removeElementFromDocument(elementType, elementId, explicitTagName) {
  try {
    const doc = getState('models.documentA');
    if (!doc) {
      log.error('docA not found');
      return false;
    }

    const tagName = explicitTagName || (elementType === 'Node' ? 'StbNode' : `Stb${elementType}`);
    const element = doc.querySelector(`${tagName}[id="${String(elementId).replace(/"/g, '\\"')}"]`);
    if (!element) {
      log.warn(`削除対象要素が見つかりません: ${elementType}#${elementId}`);
      return false;
    }

    const parent = element.parentNode;
    element.remove();

    // 追加時に副作用で生成されたコンテナ（StbStories・各軸グループ・StbAxes・型コンテナ等）が
    // 空のまま残ると XSD（コンテナは子要素 1 以上必須）違反になるため、空になった祖先を除去する。
    removeEmptyAncestors(parent);

    // 既存パイプラインを起動（節点削除は applyNodeEdit が removeCachedNode を呼ぶ）
    emitStructuralChange(elementType, elementId);

    return true;
  } catch (error) {
    log.error('要素削除中にエラーが発生しました:', error);
    return false;
  }
}
