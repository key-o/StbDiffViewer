/**
 * @fileoverview StbNodeIdList membership を可逆に複製する Command。
 *
 * StbNode の COPY では座標だけでなく、StbStory / 軸が持つ明示的な StbNodeIdList membership も
 * Working Document の semantic state として扱う。座標から story / axis を再推定せず、source Node の
 * 明示 membership を新 Node ID へ複製する。
 */

const MEMBERSHIP_OWNER_TAGS = Object.freeze([
  'StbStory',
  'StbParallelAxis',
  'StbArcAxis',
  'StbRadialAxis',
]);

function findById(document, tagName, elementId) {
  const targetId = String(elementId);
  for (const element of document?.getElementsByTagName?.(tagName) || []) {
    if (String(element.getAttribute('id')) === targetId) return element;
  }
  return null;
}

function findDirectChild(parent, tagName) {
  for (const child of Array.from(parent?.children || [])) {
    if (child.tagName === tagName) return child;
  }
  return null;
}

function findNodeMembership(list, nodeId) {
  const targetId = String(nodeId);
  for (const child of Array.from(list?.children || [])) {
    if (child.tagName === 'StbNodeId' && String(child.getAttribute('id')) === targetId) {
      return child;
    }
  }
  return null;
}

function normalizeNodeId(nodeId, label) {
  const normalized = String(nodeId ?? '').trim();
  if (!normalized) throw new Error(`${label} が空です。`);
  return normalized;
}

/**
 * source Node が明示的に所属する Story / Axis list を収集する。
 * @returns {Array<{ownerTagName:string,ownerId:string}>}
 */
export function collectNodeMemberships(document, sourceNodeId) {
  const nodeId = normalizeNodeId(sourceNodeId, 'source Node ID');
  const result = [];

  for (const ownerTagName of MEMBERSHIP_OWNER_TAGS) {
    for (const owner of document?.getElementsByTagName?.(ownerTagName) || []) {
      const ownerId = String(owner.getAttribute('id') || '').trim();
      if (!ownerId) continue;
      const list = findDirectChild(owner, 'StbNodeIdList');
      if (!list || !findNodeMembership(list, nodeId)) continue;
      result.push({ ownerTagName, ownerId });
    }
  }

  return result;
}

export function createCopyNodeMembershipCommand(document, sourceNodeId, targetNodeId) {
  const sourceId = normalizeNodeId(sourceNodeId, 'source Node ID');
  const targetId = normalizeNodeId(targetNodeId, 'target Node ID');
  if (sourceId === targetId)
    throw new Error('Node membership COPY の source / target ID が同一です。');

  const memberships = collectNodeMemberships(document, sourceId);
  return {
    type: 'copyNodeMembership',
    label: `Node ${sourceId} の Story/Axis membership を ${targetId} へ複製`,
    sourceNodeId: sourceId,
    targetNodeId: targetId,
    memberships,
    affectedElements: [],
    isNoop: memberships.length === 0,
  };
}

function resolveMembershipList(document, membership) {
  const owner = findById(document, membership.ownerTagName, membership.ownerId);
  if (!owner) {
    throw new Error(
      `Node membership owner ${membership.ownerTagName}#${membership.ownerId} が Working Document に見つかりません。`,
    );
  }
  const list = findDirectChild(owner, 'StbNodeIdList');
  if (!list) {
    throw new Error(
      `Node membership owner ${membership.ownerTagName}#${membership.ownerId} に StbNodeIdList がありません。`,
    );
  }
  return list;
}

function createNodeIdElement(document, list, nodeId) {
  const namespaceURI = list.namespaceURI || list.parentElement?.namespaceURI || null;
  const element = namespaceURI
    ? document.createElementNS(namespaceURI, 'StbNodeId')
    : document.createElement('StbNodeId');
  element.setAttribute('id', String(nodeId));
  return element;
}

function applyMembershipAdd(document, command) {
  const added = [];
  try {
    for (const membership of command.memberships || []) {
      const list = resolveMembershipList(document, membership);
      if (findNodeMembership(list, command.targetNodeId)) {
        throw new Error(
          `${membership.ownerTagName}#${membership.ownerId} の StbNodeIdList に Node ${command.targetNodeId} が既にあります。`,
        );
      }
      const element = createNodeIdElement(document, list, command.targetNodeId);
      list.appendChild(element);
      added.push(element);
    }
  } catch (error) {
    for (const element of added.reverse()) element.remove();
    throw error;
  }
}

function applyMembershipRemove(document, command) {
  const removed = [];
  try {
    for (const membership of command.memberships || []) {
      const list = resolveMembershipList(document, membership);
      const element = findNodeMembership(list, command.targetNodeId);
      if (!element) {
        throw new Error(
          `${membership.ownerTagName}#${membership.ownerId} の StbNodeIdList に Undo 対象 Node ${command.targetNodeId} がありません。`,
        );
      }
      const nextSibling = element.nextSibling;
      element.remove();
      removed.push({ list, element, nextSibling });
    }
  } catch (error) {
    for (const { list, element, nextSibling } of removed.reverse()) {
      if (nextSibling?.parentNode === list) list.insertBefore(element, nextSibling);
      else list.appendChild(element);
    }
    throw error;
  }
}

export function applyCopyNodeMembershipCommand(document, _nodeMap, command, direction = 'after') {
  if (!command || command.type !== 'copyNodeMembership') {
    throw new Error('copyNodeMembership Command が指定されていません。');
  }
  if (command.isNoop === true) return [];
  if (direction === 'after') {
    applyMembershipAdd(document, command);
    return [];
  }
  if (direction === 'before') {
    applyMembershipRemove(document, command);
    return [];
  }
  throw new Error(`未対応の Command 適用方向です: ${direction}`);
}
