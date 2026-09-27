/**
 * @fileoverview Working Document 上の Node 座標を可逆に変更する Command
 */

import { resolveAffectedElementsForNode } from '../../modelLoader/editImpactResolver.js';

function findNodeElement(doc, nodeId) {
  if (!doc) return null;
  const targetId = String(nodeId);
  const nodes = doc.getElementsByTagName('StbNode');
  for (const node of nodes) {
    if (String(node.getAttribute('id')) === targetId) return node;
  }
  return null;
}

function toFiniteCoordinate(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readNodePosition(node) {
  const position = {
    x: toFiniteCoordinate(node.getAttribute('X')),
    y: toFiniteCoordinate(node.getAttribute('Y')),
    z: toFiniteCoordinate(node.getAttribute('Z')),
  };
  if (
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    !Number.isFinite(position.z)
  ) {
    throw new Error(`Node ${node.getAttribute('id')} の座標が有限値ではありません。`);
  }
  return position;
}

function normalizePosition(position) {
  if (!position || typeof position !== 'object') {
    throw new Error('移動先座標が指定されていません。');
  }

  const normalized = {
    x: toFiniteCoordinate(position.x),
    y: toFiniteCoordinate(position.y),
    z: toFiniteCoordinate(position.z),
  };
  if (
    !Number.isFinite(normalized.x) ||
    !Number.isFinite(normalized.y) ||
    !Number.isFinite(normalized.z)
  ) {
    throw new Error('Node 座標は有限値で指定してください。');
  }
  return normalized;
}

function resolveNodeMapKey(nodeMap, nodeId) {
  if (!(nodeMap instanceof Map)) return null;
  const targetId = String(nodeId);
  if (nodeMap.has(targetId)) return targetId;
  for (const key of nodeMap.keys()) {
    if (String(key) === targetId) return key;
  }
  return targetId;
}

function applyPosition(doc, nodeMap, nodeId, position) {
  const node = findNodeElement(doc, nodeId);
  if (!node) throw new Error(`Node ${nodeId} が Working Document に見つかりません。`);

  const normalized = normalizePosition(position);
  node.setAttribute('X', String(normalized.x));
  node.setAttribute('Y', String(normalized.y));
  node.setAttribute('Z', String(normalized.z));

  if (nodeMap instanceof Map) {
    const key = resolveNodeMapKey(nodeMap, nodeId);
    const current = nodeMap.get(key);
    const next = current && typeof current === 'object' ? { ...current } : {};
    next.x = normalized.x;
    next.y = normalized.y;
    next.z = normalized.z;
    nodeMap.set(key, next);
  }
}

export function createMoveNodeCommand(doc, nodeId, nextPosition) {
  const node = findNodeElement(doc, nodeId);
  if (!node) throw new Error(`Node ${nodeId} が Working Document に見つかりません。`);

  const before = readNodePosition(node);
  const after = normalizePosition(nextPosition);

  return {
    type: 'moveNode',
    label: `Node ${String(nodeId)} を移動`,
    target: { elementType: 'StbNode', elementId: String(nodeId) },
    nodeId: String(nodeId),
    before,
    after,
    affectedElements: resolveAffectedElementsForNode(doc, nodeId),
  };
}

export function applyMoveNodeCommand(doc, nodeMap, command, direction = 'after') {
  if (!command || command.type !== 'moveNode') {
    throw new Error('moveNode Command が指定されていません。');
  }
  const position = direction === 'before' ? command.before : command.after;
  applyPosition(doc, nodeMap, command.nodeId, position);
  return command.affectedElements || [];
}
