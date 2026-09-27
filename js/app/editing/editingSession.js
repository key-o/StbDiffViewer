/**
 * @fileoverview Working Document を所有する編集セッション
 *
 * source / working 分離を維持しつつ、編集操作を共通 Command 契約へ載せる。
 * 単一 Command と composite transaction は同じ履歴・Undo/Redo・Geometry 更新通知を使う。
 * 既存編集UIの自動切替はまだ行わず、新旧編集経路を混在させない。
 */

import { getState, setState } from '../../data/state/globalState.js';
import { createInitialEditingState } from '../../data/state/modelStateFactory.js';
import { eventBus, EditEvents } from '../../data/events/index.js';
import editDocumentProvider from './editDocumentProvider.js';
import { createMoveNodeCommand } from './moveNodeCommand.js';
import { createSetAttributeCommand } from './setAttributeCommand.js';
import { createSetMemberOffsetCommand } from './setMemberOffsetCommand.js';
import { createChangeSectionCommand } from './changeSectionCommand.js';
import { createRenumberIdCommand } from './renumberIdCommand.js';
import {
  applyEditCommand,
  collectAffectedElements,
  collectIdentityChanges,
  collectNodeChanges,
  collectNodeIds,
  collectStructuralChanges,
  createCompositeCommand,
} from './editCommand.js';

let sessionSequence = 0;

function createSessionId() {
  sessionSequence += 1;
  return `edit-${Date.now().toString(36)}-${sessionSequence.toString(36)}`;
}

function cloneDocument(document) {
  if (!document || typeof document.cloneNode !== 'function') {
    throw new Error('編集セッションを開始できる XML Document がありません。');
  }
  return document.cloneNode(true);
}

function cloneNodeMap(nodeMap) {
  const result = new Map();
  if (!(nodeMap instanceof Map)) return result;

  for (const [id, value] of nodeMap.entries()) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result.set(id, { ...value });
    } else if (Array.isArray(value)) {
      result.set(id, [...value]);
    } else {
      result.set(id, value);
    }
  }
  return result;
}

function requireActiveSession() {
  const state = getState('models.editing');
  if (!state?.active || !state.workingDocument) {
    throw new Error('編集セッションが開始されていません。');
  }
  return state;
}

function positionsEqual(a, b) {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function findNodeElement(document, nodeId) {
  if (!document) return null;
  const targetId = String(nodeId);
  return [...document.getElementsByTagName('StbNode')].find(
    (node) => String(node.getAttribute('id')) === targetId,
  );
}

function readNodePosition(document, nodeId) {
  const node = findNodeElement(document, nodeId);
  if (!node) return null;

  const position = {
    x: Number(node.getAttribute('X')),
    y: Number(node.getAttribute('Y')),
    z: Number(node.getAttribute('Z')),
  };
  return Object.values(position).every(Number.isFinite) ? position : null;
}

function collectDiscardChanges(state) {
  const appliedCommands = state.history || [];
  const commands = [...appliedCommands, ...(state.redoStack || [])];
  const nodeIds = [...new Set(commands.flatMap((command) => collectNodeIds(command)))];
  const nodeChanges = [];

  for (const nodeId of nodeIds) {
    const previousPosition = readNodePosition(state.workingDocument, nodeId);
    const position = readNodePosition(state.sourceDocumentA, nodeId);
    if (!previousPosition || !position || positionsEqual(previousPosition, position)) continue;
    nodeChanges.push({ nodeId, previousPosition, position });
  }

  const affectedElements = new Map();
  for (const command of commands) {
    for (const element of collectAffectedElements(command)) {
      const key = `${element.elementType}:${element.elementId}`;
      if (!affectedElements.has(key)) affectedElements.set(key, element);
    }
  }

  const identityChanges = [];
  const structuralChanges = [];
  for (const command of [...appliedCommands].reverse()) {
    identityChanges.push(...collectIdentityChanges(command, 'before'));
    structuralChanges.push(...collectStructuralChanges(command, 'before'));
  }

  return {
    nodeChanges,
    identityChanges,
    structuralChanges,
    affectedElements: [...affectedElements.values()],
  };
}

function emitWorkingDocumentChanged(payload) {
  eventBus.emit(EditEvents.WORKING_DOCUMENT_CHANGED, payload);
}

function commitCommandState(current, history, redoStack) {
  const nextRevision = current.workingRevision + 1;
  const dirty = current.untrackedDirty === true || history.length > 0;
  setState('models.editing', {
    ...current,
    history,
    redoStack,
    workingRevision: nextRevision,
    dirty,
  });
  return nextRevision;
}

function rollbackAfterValidationFailure(current, command, originalError) {
  try {
    applyEditCommand(current.workingDocument, current.workingNodeMap, command, 'before');
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      '編集 Command の validation に失敗し、rollback にも失敗しました。',
    );
  }
  throw originalError;
}

function unchangedCommandResult(current, command) {
  return {
    changed: false,
    command,
    revision: current.workingRevision,
    affectedElements: collectAffectedElements(command),
    structuralChanges: [],
  };
}

function executePreparedCommand(current, command, options = {}) {
  if (command?.isNoop === true) return unchangedCommandResult(current, command);

  applyEditCommand(current.workingDocument, current.workingNodeMap, command, 'after');

  if (typeof options.validate === 'function') {
    try {
      const validationResult = options.validate({
        command,
        workingDocument: current.workingDocument,
        workingNodeMap: current.workingNodeMap,
      });
      if (validationResult === false) {
        throw new Error('編集 Command の validation に失敗しました。');
      }
    } catch (error) {
      rollbackAfterValidationFailure(current, command, error);
    }
  }

  const history = [...(current.history || []), command];
  const revision = commitCommandState(current, history, []);
  const affectedElements = collectAffectedElements(command);
  const structuralChanges = collectStructuralChanges(command, 'after');

  emitWorkingDocumentChanged({
    reason: options.reason || command.type,
    sessionId: current.sessionId,
    workingRevision: revision,
    targetDocument: current.workingDocument,
    targetNodeMap: current.workingNodeMap,
    nodeChanges: collectNodeChanges(command, 'after'),
    identityChanges: collectIdentityChanges(command, 'after'),
    structuralChanges,
    affectedElements,
  });

  return {
    changed: true,
    command,
    revision,
    affectedElements,
    structuralChanges,
  };
}

function assertUniqueMoveNodeTargets(moves) {
  const seen = new Set();
  for (const move of moves) {
    const nodeId = String(move?.nodeId ?? '');
    if (!nodeId) throw new Error('複数 Node 移動には nodeId が必要です。');
    if (seen.has(nodeId)) {
      throw new Error(`同一 transaction 内で Node ${nodeId} を複数回移動できません。`);
    }
    seen.add(nodeId);
  }
}

const editingSession = {
  start(options = {}) {
    const current = getState('models.editing');
    if (current?.active) {
      throw new Error('編集セッションは既に開始されています。先に破棄してください。');
    }

    const sourceDocument = options.sourceDocument || getState('models.documentA');
    const sourceNodeMap = options.sourceNodeMap || getState('models.nodeMapA');

    // source snapshot と working copy を別々の DOM として保持する。
    // models.documentA 自体は既存表示・比較経路の source として維持する。
    const sourceDocumentA = cloneDocument(sourceDocument);
    const workingDocument = cloneDocument(sourceDocumentA);
    const sourceNodeMapA = cloneNodeMap(sourceNodeMap);
    const workingNodeMap = cloneNodeMap(sourceNodeMapA);

    const nextState = {
      active: true,
      sessionId: createSessionId(),
      sourceDocumentA,
      workingDocument,
      sourceNodeMapA,
      workingNodeMap,
      workingRevision: 0,
      moveFollowRelatedNodes: options.moveFollowRelatedNodes !== false,
      dirty: false,
      untrackedDirty: false,
      history: [],
      redoStack: [],
    };

    setState('models.editing', nextState);
    return nextState.sessionId;
  },

  discard() {
    const current = getState('models.editing');
    if (!current?.active) return false;

    const { nodeChanges, identityChanges, structuralChanges, affectedElements } =
      collectDiscardChanges(current);
    setState('models.editing', createInitialEditingState());

    if (
      nodeChanges.length > 0 ||
      identityChanges.length > 0 ||
      structuralChanges.length > 0 ||
      affectedElements.length > 0
    ) {
      emitWorkingDocumentChanged({
        reason: 'discarded',
        reset: true,
        sessionId: current.sessionId,
        workingRevision: current.workingRevision,
        targetDocument: current.sourceDocumentA,
        targetNodeMap: current.sourceNodeMapA,
        nodeChanges,
        identityChanges,
        structuralChanges,
        affectedElements,
      });
    }
    return true;
  },

  setMoveFollowRelatedNodes(enabled) {
    const current = requireActiveSession();
    const nextValue = enabled !== false;
    if (current.moveFollowRelatedNodes === nextValue) return nextValue;
    setState('models.editing', {
      ...current,
      moveFollowRelatedNodes: nextValue,
    });
    return nextValue;
  },

  getMoveFollowRelatedNodes() {
    const current = getState('models.editing') || createInitialEditingState();
    return current.moveFollowRelatedNodes !== false;
  },

  markChanged() {
    const current = requireActiveSession();
    const nextRevision = current.workingRevision + 1;
    setState('models.editing', {
      ...current,
      workingRevision: nextRevision,
      dirty: true,
      untrackedDirty: true,
    });
    return nextRevision;
  },

  executeCommand(command, options = {}) {
    const current = requireActiveSession();
    return executePreparedCommand(current, command, options);
  },

  runTransaction(commands, options = {}) {
    const current = requireActiveSession();
    const command = createCompositeCommand(commands, { label: options.label });
    return executePreparedCommand(current, command, {
      reason: options.reason || 'transaction',
      validate: options.validate,
    });
  },

  moveNode(nodeId, nextPosition) {
    const current = requireActiveSession();
    const command = createMoveNodeCommand(current.workingDocument, nodeId, nextPosition);
    if (positionsEqual(command.before, command.after)) {
      return {
        changed: false,
        revision: current.workingRevision,
        affectedElements: command.affectedElements,
      };
    }

    return executePreparedCommand(current, command, { reason: 'moveNode' });
  },

  moveNodes(moves, options = {}) {
    const current = requireActiveSession();
    if (!Array.isArray(moves) || moves.length === 0) {
      throw new Error('複数 Node 移動には1件以上の移動指定が必要です。');
    }
    assertUniqueMoveNodeTargets(moves);

    const commands = moves
      .map((move) => createMoveNodeCommand(current.workingDocument, move.nodeId, move.position))
      .filter((command) => !positionsEqual(command.before, command.after));

    if (commands.length === 0) {
      return {
        changed: false,
        revision: current.workingRevision,
        affectedElements: [],
      };
    }

    const composite = createCompositeCommand(commands, {
      label: options.label || `Node ${commands.length}件を移動`,
    });
    return executePreparedCommand(current, composite, {
      reason: options.reason || 'moveNodes',
      validate: options.validate,
    });
  },

  setAttribute(elementType, elementId, attributeName, nextValue, options = {}) {
    const current = requireActiveSession();
    const command = createSetAttributeCommand(
      current.workingDocument,
      elementType,
      elementId,
      attributeName,
      nextValue,
      options,
    );
    return executePreparedCommand(current, command, {
      reason: options.reason || 'setAttribute',
      validate: options.validate,
    });
  },

  setMemberOffset(elementType, elementId, nextOffsets, options = {}) {
    const current = requireActiveSession();
    const command = createSetMemberOffsetCommand(
      current.workingDocument,
      elementType,
      elementId,
      nextOffsets,
      options,
    );
    return executePreparedCommand(current, command, {
      reason: options.reason || 'setMemberOffset',
      validate: options.validate,
    });
  },

  changeSection(elementType, elementId, nextSectionId, options = {}) {
    const current = requireActiveSession();
    const command = createChangeSectionCommand(
      current.workingDocument,
      elementType,
      elementId,
      nextSectionId,
      options,
    );
    return executePreparedCommand(current, command, {
      reason: options.reason || 'changeSection',
      validate: options.validate,
    });
  },

  renumberId(elementType, elementId, nextId, options = {}) {
    const current = requireActiveSession();
    const command = createRenumberIdCommand(
      current.workingDocument,
      elementType,
      elementId,
      nextId,
    );
    return executePreparedCommand(current, command, {
      reason: options.reason || 'renumberId',
      validate: options.validate,
    });
  },

  undo() {
    const current = requireActiveSession();
    const history = current.history || [];
    if (history.length === 0) return null;

    const command = history[history.length - 1];
    applyEditCommand(current.workingDocument, current.workingNodeMap, command, 'before');
    const nextHistory = history.slice(0, -1);
    const nextRedoStack = [...(current.redoStack || []), command];
    const revision = commitCommandState(current, nextHistory, nextRedoStack);
    const affectedElements = collectAffectedElements(command);
    const structuralChanges = collectStructuralChanges(command, 'before');

    emitWorkingDocumentChanged({
      reason: 'undo',
      sessionId: current.sessionId,
      workingRevision: revision,
      targetDocument: current.workingDocument,
      targetNodeMap: current.workingNodeMap,
      nodeChanges: collectNodeChanges(command, 'before'),
      identityChanges: collectIdentityChanges(command, 'before'),
      structuralChanges,
      affectedElements,
    });

    return { command, revision, affectedElements, structuralChanges };
  },

  redo() {
    const current = requireActiveSession();
    const redoStack = current.redoStack || [];
    if (redoStack.length === 0) return null;

    const command = redoStack[redoStack.length - 1];
    applyEditCommand(current.workingDocument, current.workingNodeMap, command, 'after');
    const nextHistory = [...(current.history || []), command];
    const nextRedoStack = redoStack.slice(0, -1);
    const revision = commitCommandState(current, nextHistory, nextRedoStack);
    const affectedElements = collectAffectedElements(command);
    const structuralChanges = collectStructuralChanges(command, 'after');

    emitWorkingDocumentChanged({
      reason: 'redo',
      sessionId: current.sessionId,
      workingRevision: revision,
      targetDocument: current.workingDocument,
      targetNodeMap: current.workingNodeMap,
      nodeChanges: collectNodeChanges(command, 'after'),
      identityChanges: collectIdentityChanges(command, 'after'),
      structuralChanges,
      affectedElements,
    });

    return { command, revision, affectedElements, structuralChanges };
  },

  getState() {
    return getState('models.editing') || createInitialEditingState();
  },

  getSourceDocument() {
    return editDocumentProvider.getSourceDocument();
  },

  getWorkingDocument() {
    return editDocumentProvider.getWorkingDocument();
  },

  getActiveEditDocument() {
    return editDocumentProvider.getActiveEditDocument();
  },

  getSourceNodeMap() {
    return editDocumentProvider.getSourceNodeMap();
  },

  getWorkingNodeMap() {
    return editDocumentProvider.getWorkingNodeMap();
  },

  getActiveEditNodeMap() {
    return editDocumentProvider.getActiveEditNodeMap();
  },
};

export default editingSession;
