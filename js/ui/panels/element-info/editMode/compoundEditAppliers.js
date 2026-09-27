/**
 * @fileoverview 複合編集操作のUndo適用
 *
 * ST-Bridge 2.0.2 の開口追加は StbOpen 本体と対象面材の StbOpenIdList を同時に変更する。
 * 2.0.2 継手割当は部材/断面図形の複数属性を1操作として変更し、生成直後の割当では
 * 継手定義の追加自体も同じUndoで戻す。
 * 2.1.x の開口・継手配置は単一Arrangement要素だが、参照先部材の再描画通知まで含めて戻す。
 */

import { getState } from '../../../../data/state/globalState.js';
import { findDirectChild, emitStructuralChange } from './domHelpers.js';
import { removeElementFromDocument } from './editAppliers.js';

function selectorById(tagName, id) {
  return `${tagName}[id="${String(id).replace(/"/g, '\\"')}"]`;
}

/** addOpen のUndo。 */
export function undoAddedOpen(mod) {
  const doc = getState('models.documentA');
  if (!doc) return false;

  const panel = doc.querySelector(selectorById(mod.panelTag, mod.panelId));
  const tagName = mod.tagName || 'StbOpen';
  const isArrangement = tagName === 'StbOpenArrangement';

  if (!isArrangement && panel) {
    const list = findDirectChild(panel, 'StbOpenIdList');
    if (list) {
      for (const ref of Array.from(list.children || [])) {
        if (ref.tagName === 'StbOpenId' && ref.getAttribute('id') === String(mod.id)) {
          ref.remove();
        }
      }
      if (list.children.length === 0) list.remove();
    }
  }

  const elementType = isArrangement ? 'OpenArrangement' : 'Open';
  const removed = removeElementFromDocument(elementType, mod.id, tagName);
  if (panel) {
    emitStructuralChange(mod.panelTag === 'StbWall' ? 'Wall' : 'Slab', String(mod.panelId));
  }
  return removed;
}

/** ST-Bridge 2.1.x の StbJointArrangement 追加を戻す。 */
export function undoAddedJointArrangement(mod) {
  const removed = removeElementFromDocument('JointArrangement', mod.id, 'StbJointArrangement');
  if (removed && mod.memberTag && mod.memberId) {
    emitStructuralChange(String(mod.memberTag).replace(/^Stb/, ''), String(mod.memberId));
  }
  return removed;
}

function resolveJointAssignmentTarget202(doc, mod) {
  if (mod.targetKind === 'member') {
    return doc.querySelector(selectorById(mod.targetTag, mod.targetId));
  }
  if (mod.targetKind === 'section') {
    const section = doc.querySelector(selectorById(mod.targetTag, mod.targetId));
    if (!section) return null;
    return (
      Array.from(section.children || []).find((child) => child.tagName === mod.figureTag) || null
    );
  }
  return null;
}

/**
 * ST-Bridge 2.0.2 の継手割当を戻す。
 * `changes` に保存した旧値を復元し、生成直後に割当したケースでは StbJoints の定義も削除する。
 */
export function undoJointAssignment202(mod) {
  const doc = getState('models.documentA');
  if (!doc) return false;

  const target = resolveJointAssignmentTarget202(doc, mod);
  if (!target) return false;

  for (const change of mod.changes || []) {
    if (change.oldValue === null || change.oldValue === undefined) {
      target.removeAttribute(change.name);
    } else {
      target.setAttribute(change.name, String(change.oldValue));
    }
  }
  emitStructuralChange(String(mod.targetTag).replace(/^Stb/, ''), String(mod.targetId));

  if (!mod.removeJointOnUndo) return true;
  const elementType = String(mod.jointTag || '').replace(/^Stb/, '');
  return removeElementFromDocument(elementType, mod.jointId, mod.jointTag);
}
