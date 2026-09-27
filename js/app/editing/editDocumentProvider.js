/**
 * @fileoverview 編集セッションの Document / nodeMap 参照を一元化する Provider
 *
 * 通常表示・比較用の source (`models.documentA`) と、編集用 Working Document を
 * 明示的に分離する。編集セッションが未開始の場合のみ、active edit target は
 * 従来どおり Model A を返す。
 */

import { getState } from '../../data/state/globalState.js';

function getEditingState() {
  return getState('models.editing') || null;
}

const editDocumentProvider = {
  isSessionActive() {
    return getEditingState()?.active === true;
  },

  getSourceDocument() {
    const editing = getEditingState();
    return editing?.active ? editing.sourceDocumentA : getState('models.documentA');
  },

  getWorkingDocument() {
    return getEditingState()?.workingDocument || null;
  },

  getActiveEditDocument() {
    const editing = getEditingState();
    if (editing?.active && editing.workingDocument) {
      return editing.workingDocument;
    }
    return getState('models.documentA');
  },

  getSourceNodeMap() {
    const editing = getEditingState();
    return editing?.active ? editing.sourceNodeMapA : getState('models.nodeMapA');
  },

  getWorkingNodeMap() {
    return getEditingState()?.workingNodeMap || null;
  },

  getActiveEditNodeMap() {
    const editing = getEditingState();
    if (editing?.active && editing.workingNodeMap) {
      return editing.workingNodeMap;
    }
    return getState('models.nodeMapA');
  },
};

export default editDocumentProvider;
