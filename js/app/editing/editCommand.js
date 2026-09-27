/**
 * @fileoverview Working Document 編集 Command の共通実行契約
 *
 * Command は Working Document を正本として apply / revert できる差分を保持する。
 * composite Command は複数 Command を1回のユーザー操作として atomic に扱い、
 * 子 Command の適用途中で失敗した場合は、適用済み分を逆順に rollback する。
 */

import { applyMoveNodeCommand } from './moveNodeCommand.js';
import { applySetAttributeCommand } from './setAttributeCommand.js';
import { applySetMemberOffsetCommand } from './setMemberOffsetCommand.js';
import { applyTranslateMemberCommand } from './translateMemberCommand.js';
import { applyChangeSectionCommand } from './changeSectionCommand.js';
import { applyRenumberIdCommand } from './renumberIdCommand.js';
import { applyAddElementCommand } from './addElementCommand.js';
import { applyDeleteElementCommand } from './deleteElementCommand.js';
import { applyCopyNodeMembershipCommand } from './nodeMembershipCommand.js';

const COMPOSITE_COMMAND_TYPE = 'composite';

function normalizeDirection(direction) {
  if (direction !== 'after' && direction !== 'before') {
    throw new Error(`未対応の Command 適用方向です: ${direction}`);
  }
  return direction;
}

function commandChildren(command) {
  if (command?.type !== COMPOSITE_COMMAND_TYPE) return [];
  if (!Array.isArray(command.commands) || command.commands.length === 0) {
    throw new Error('composite Command には1件以上の子 Command が必要です。');
  }
  return command.commands;
}

function applyLeafCommand(document, nodeMap, command, direction) {
  switch (command?.type) {
    case 'moveNode':
      return applyMoveNodeCommand(document, nodeMap, command, direction);
    case 'setAttribute':
      return applySetAttributeCommand(document, nodeMap, command, direction);
    case 'setMemberOffset':
      return applySetMemberOffsetCommand(document, nodeMap, command, direction);
    case 'translateMember':
      return applyTranslateMemberCommand(document, nodeMap, command, direction);
    case 'changeSection':
      return applyChangeSectionCommand(document, nodeMap, command, direction);
    case 'renumberId':
      return applyRenumberIdCommand(document, nodeMap, command, direction);
    case 'addElement':
      return applyAddElementCommand(document, nodeMap, command, direction);
    case 'deleteElement':
      return applyDeleteElementCommand(document, nodeMap, command, direction);
    case 'copyNodeMembership':
      return applyCopyNodeMembershipCommand(document, nodeMap, command, direction);
    default:
      throw new Error(`未対応の編集 Command です: ${command?.type ?? '(unknown)'}`);
  }
}

function applyCompositeCommand(document, nodeMap, command, direction) {
  const children = commandChildren(command);
  const ordered = direction === 'before' ? [...children].reverse() : children;
  const applied = [];

  try {
    for (const child of ordered) {
      applyEditCommand(document, nodeMap, child, direction);
      applied.push(child);
    }
  } catch (error) {
    const rollbackDirection = direction === 'after' ? 'before' : 'after';
    const rollbackErrors = [];

    for (const child of [...applied].reverse()) {
      try {
        applyEditCommand(document, nodeMap, child, rollbackDirection);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'composite Command の適用に失敗し、rollback にも失敗しました。',
      );
    }
    throw error;
  }

  return command.affectedElements || collectAffectedElements(command);
}

function appendAffectedElement(map, element) {
  if (!element?.elementType || element.elementId === undefined || element.elementId === null)
    return;
  const normalized = {
    elementType: String(element.elementType),
    elementId: String(element.elementId),
  };
  const key = `${normalized.elementType}:${normalized.elementId}`;
  if (!map.has(key)) map.set(key, normalized);
}

function collectAffectedElementsInto(command, result) {
  if (!command) return;

  if (command.type === COMPOSITE_COMMAND_TYPE) {
    for (const child of commandChildren(command)) {
      collectAffectedElementsInto(child, result);
    }
    return;
  }

  for (const element of command.affectedElements || []) {
    appendAffectedElement(result, element);
  }
}

function appendNodeChange(command, direction, result) {
  const change = command?.nodeChange;
  if (!change?.nodeId || !change.before || !change.after) return false;

  const previousPosition = direction === 'before' ? change.after : change.before;
  const position = direction === 'before' ? change.before : change.after;
  result.push({
    nodeId: String(change.nodeId),
    previousPosition,
    position,
  });
  return true;
}

function collectNodeChangesInto(command, direction, result) {
  if (!command) return;

  if (command.type === COMPOSITE_COMMAND_TYPE) {
    const children = commandChildren(command);
    const ordered = direction === 'before' ? [...children].reverse() : children;
    for (const child of ordered) {
      collectNodeChangesInto(child, direction, result);
    }
    return;
  }

  if (command.type === 'moveNode') {
    const previousPosition = direction === 'before' ? command.after : command.before;
    const position = direction === 'before' ? command.before : command.after;
    result.push({
      nodeId: String(command.nodeId),
      previousPosition,
      position,
    });
    return;
  }

  appendNodeChange(command, direction, result);
}

function collectNodeIdsInto(command, result) {
  if (!command) return;
  if (command.type === COMPOSITE_COMMAND_TYPE) {
    for (const child of commandChildren(command)) {
      collectNodeIdsInto(child, result);
    }
    return;
  }
  if (command.type === 'moveNode' && command.nodeId !== undefined && command.nodeId !== null) {
    result.add(String(command.nodeId));
    return;
  }
  if (command.type === 'renumberId' && command.category === 'node') {
    if (command.beforeId !== undefined && command.beforeId !== null)
      result.add(String(command.beforeId));
    if (command.afterId !== undefined && command.afterId !== null)
      result.add(String(command.afterId));
    return;
  }
  if (
    (command.type === 'addElement' || command.type === 'deleteElement') &&
    command.elementSnapshot?.tagName === 'StbNode'
  ) {
    result.add(String(command.elementId));
    return;
  }
  if (command.type === 'copyNodeMembership' && command.targetNodeId !== undefined) {
    result.add(String(command.targetNodeId));
    return;
  }
  if (command.nodeChange?.nodeId !== undefined && command.nodeChange?.nodeId !== null) {
    result.add(String(command.nodeChange.nodeId));
  }
}

function collectIdentityChangesInto(command, direction, result) {
  if (!command) return;
  if (command.type === COMPOSITE_COMMAND_TYPE) {
    const children = commandChildren(command);
    const ordered = direction === 'before' ? [...children].reverse() : children;
    for (const child of ordered) {
      collectIdentityChangesInto(child, direction, result);
    }
    return;
  }

  const change = command.identityChange;
  if (!change?.tagName || change.beforeId === undefined || change.afterId === undefined) return;
  const previousElementId = direction === 'before' ? change.afterId : change.beforeId;
  const elementId = direction === 'before' ? change.beforeId : change.afterId;
  result.push({
    elementType: String(change.elementType || ''),
    tagName: String(change.tagName),
    category: String(change.category || 'other'),
    previousElementId: String(previousElementId),
    elementId: String(elementId),
  });
}

function invertStructuralOperation(operation) {
  if (operation === 'add') return 'delete';
  if (operation === 'delete') return 'add';
  return operation;
}

function collectStructuralChangesInto(command, direction, result) {
  if (!command) return;
  if (command.type === COMPOSITE_COMMAND_TYPE) {
    const children = commandChildren(command);
    const ordered = direction === 'before' ? [...children].reverse() : children;
    for (const child of ordered) {
      collectStructuralChangesInto(child, direction, result);
    }
    return;
  }

  const change = command.structuralChange;
  if (!change?.operation || !change.elementType || change.elementId === undefined) return;
  result.push({
    operation:
      direction === 'before'
        ? invertStructuralOperation(String(change.operation))
        : String(change.operation),
    elementType: String(change.elementType),
    elementId: String(change.elementId),
    tagName: change.tagName ? String(change.tagName) : null,
  });
}

export function createCompositeCommand(commands, options = {}) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error('composite Command には1件以上の子 Command が必要です。');
  }

  const command = {
    type: COMPOSITE_COMMAND_TYPE,
    label: options.label || '複合編集',
    commands: [...commands],
  };
  command.affectedElements = collectAffectedElements(command);
  command.isNoop = command.commands.every((child) => child?.isNoop === true);
  return command;
}

export function applyEditCommand(document, nodeMap, command, direction = 'after') {
  const normalizedDirection = normalizeDirection(direction);
  if (!command || typeof command !== 'object') {
    throw new Error('編集 Command が指定されていません。');
  }

  if (command.type === COMPOSITE_COMMAND_TYPE) {
    return applyCompositeCommand(document, nodeMap, command, normalizedDirection);
  }
  return applyLeafCommand(document, nodeMap, command, normalizedDirection);
}

export function collectAffectedElements(command) {
  const result = new Map();
  collectAffectedElementsInto(command, result);
  return [...result.values()];
}

export function collectNodeChanges(command, direction = 'after') {
  const normalizedDirection = normalizeDirection(direction);
  const result = [];
  collectNodeChangesInto(command, normalizedDirection, result);
  return result;
}

export function collectNodeIds(command) {
  const result = new Set();
  collectNodeIdsInto(command, result);
  return [...result];
}

export function collectIdentityChanges(command, direction = 'after') {
  const normalizedDirection = normalizeDirection(direction);
  const result = [];
  collectIdentityChangesInto(command, normalizedDirection, result);
  return result;
}

export function collectStructuralChanges(command, direction = 'after') {
  const normalizedDirection = normalizeDirection(direction);
  const result = [];
  collectStructuralChangesInto(command, normalizedDirection, result);
  return result;
}
