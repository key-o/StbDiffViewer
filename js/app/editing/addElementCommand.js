/**
 * @fileoverview Working Document へ要素を可逆追加する AddElementCommand。
 *
 * 履歴へ live DOM Element を保持せず、要素 subtree と parent path を serializable snapshot として
 * 保存する。親コンテナが追加前に存在しなかった場合は apply 時に生成し、Undo 時にそのコンテナが
 * 空である場合だけ元の不存在状態へ戻す。
 *
 * Phase 5 core では DOM / workingNodeMap / Command history の原子性を固定する。新規要素を scene に
 * 追加する structural render lifecycle は別 checkpoint で接続する。
 */

import { findElementByTagAndId, viewerElementTypeFromTagName } from './attributeCommandUtils.js';

const CHILD_ORDER_BY_PARENT = Object.freeze({
  StbModel: Object.freeze([
    'StbNodes',
    'StbAxes',
    'StbStories',
    'StbMembers',
    'StbSections',
    'StbJoints',
    'StbConnections',
    'StbWeld',
  ]),
  StbMembers: Object.freeze([
    'StbColumns',
    'StbPosts',
    'StbGirders',
    'StbBeams',
    'StbBraces',
    'StbSlabs',
    'StbWalls',
    'StbIsolatingDevices',
    'StbDampingDevices',
    'StbFrameDampingDevices',
    'StbFootings',
    'StbStripFootings',
    'StbPiles',
    'StbFoundationColumns',
    'StbParapets',
    // 2.0.2 は StbOpens、2.1.x は StbOpenArrangements を使用する。
    'StbOpens',
    'StbOpenArrangements',
    'StbPenetrationArrangements',
    'StbJointArrangements',
    'StbPanelZoneArrangements',
    'StbConnectionArrangements',
  ]),
  StbAxes: Object.freeze(['StbParallelAxes', 'StbArcAxes', 'StbRadialAxes', 'StbDrawingAxes']),
});

function normalizePathSegment(segment) {
  if (typeof segment === 'string') {
    const tagName = segment.trim();
    if (!tagName) throw new Error('AddElementCommand の parentPath に空のタグ名があります。');
    return { tagName, attributes: {} };
  }
  if (!segment || typeof segment !== 'object') {
    throw new Error('AddElementCommand の parentPath が不正です。');
  }
  const tagName = String(segment.tagName || '').trim();
  if (!tagName) throw new Error('AddElementCommand の parentPath に tagName が必要です。');
  const attributes = {};
  for (const [name, value] of Object.entries(segment.attributes || {})) {
    if (value === null || value === undefined) continue;
    attributes[String(name)] = String(value);
  }
  return { tagName, attributes };
}

function normalizeParentPath(parentPath) {
  if (!Array.isArray(parentPath) || parentPath.length === 0) {
    throw new Error('AddElementCommand には StbModel からの parentPath が必要です。');
  }
  return parentPath.map(normalizePathSegment);
}

function normalizeSiblingOrder(siblingOrder) {
  if (siblingOrder === undefined || siblingOrder === null) return null;
  if (!Array.isArray(siblingOrder) || siblingOrder.length === 0) {
    throw new Error('AddElementCommand の siblingOrder は1件以上のタグ名配列で指定してください。');
  }
  const normalized = siblingOrder.map((tagName) => String(tagName || '').trim());
  if (normalized.some((tagName) => !tagName)) {
    throw new Error('AddElementCommand の siblingOrder に空のタグ名があります。');
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('AddElementCommand の siblingOrder に重複したタグ名があります。');
  }
  return normalized;
}

function attributesMatch(element, attributes) {
  return Object.entries(attributes).every(([name, value]) => element.getAttribute(name) === value);
}

function findDirectChild(parent, segment) {
  if (!parent?.children) return null;
  for (const child of parent.children) {
    if (child.tagName === segment.tagName && attributesMatch(child, segment.attributes))
      return child;
  }
  return null;
}

function insertChildInOrder(parent, child, explicitOrder = null) {
  const order = explicitOrder || CHILD_ORDER_BY_PARENT[parent?.tagName] || null;
  const targetIndex = order ? order.indexOf(child.tagName) : -1;
  if (targetIndex < 0) {
    if (explicitOrder) {
      throw new Error(
        `AddElementCommand の siblingOrder に追加対象 ${child.tagName} が含まれていません。`,
      );
    }
    parent.appendChild(child);
    return;
  }
  for (const existing of parent.children) {
    const existingIndex = order.indexOf(existing.tagName);
    if (existingIndex > targetIndex) {
      parent.insertBefore(child, existing);
      return;
    }
  }
  parent.appendChild(child);
}

function createElement(document, tagName, namespaceURI) {
  return namespaceURI
    ? document.createElementNS(namespaceURI, tagName)
    : document.createElement(tagName);
}

function snapshotElement(element) {
  if (!element?.tagName) throw new Error('AddElementCommand に追加要素が指定されていません。');
  const attributes = {};
  for (const attr of Array.from(element.attributes || [])) {
    attributes[attr.name] = attr.value;
  }
  const children = Array.from(element.children || []).map(snapshotElement);
  const text = children.length === 0 ? String(element.textContent || '') : null;
  return {
    tagName: element.tagName,
    namespaceURI: element.namespaceURI || null,
    attributes,
    text,
    children,
  };
}

function restoreElement(document, snapshot) {
  const element = createElement(document, snapshot.tagName, snapshot.namespaceURI);
  for (const [name, value] of Object.entries(snapshot.attributes || {})) {
    element.setAttribute(name, String(value));
  }
  if (Array.isArray(snapshot.children) && snapshot.children.length > 0) {
    for (const child of snapshot.children) element.appendChild(restoreElement(document, child));
  } else if (snapshot.text) {
    element.textContent = snapshot.text;
  }
  return element;
}

function getModel(document) {
  return document?.getElementsByTagName?.('StbModel')?.[0] || null;
}

function captureParentExistence(document, parentPath) {
  let parent = getModel(document);
  if (!parent) throw new Error('Working Document に StbModel がありません。');
  const result = [];
  for (const segment of parentPath) {
    const child = findDirectChild(parent, segment);
    result.push(Boolean(child));
    parent = child;
    if (!parent) {
      while (result.length < parentPath.length) result.push(false);
      break;
    }
  }
  return result;
}

function resolveParent(document, parentPath, originalExistence, { create = false } = {}) {
  let parent = getModel(document);
  if (!parent) throw new Error('Working Document に StbModel がありません。');
  const created = [];

  for (let index = 0; index < parentPath.length; index += 1) {
    const segment = parentPath[index];
    let child = findDirectChild(parent, segment);
    if (!child) {
      if (!create) return { parent: null, created };
      if (originalExistence[index] === true) {
        throw new Error(`AddElementCommand の既存 parent が見つかりません: ${segment.tagName}`);
      }
      child = createElement(document, segment.tagName, parent.namespaceURI || null);
      for (const [name, value] of Object.entries(segment.attributes))
        child.setAttribute(name, value);
      insertChildInOrder(parent, child);
      created.push({ element: child, index });
    }
    parent = child;
  }
  return { parent, created };
}

function cleanupOriginallyMissingParents(document, command) {
  const chain = [];
  let parent = getModel(document);
  if (!parent) return;
  for (let index = 0; index < command.parentPath.length; index += 1) {
    const child = findDirectChild(parent, command.parentPath[index]);
    if (!child) break;
    chain.push({ element: child, index });
    parent = child;
  }

  for (const { element, index } of chain.reverse()) {
    if (command.parentExistence[index] === true) continue;
    if (element.children.length === 0 && String(element.textContent || '').trim() === '') {
      element.remove();
    }
  }
}

function normalizeElementId(snapshot) {
  const id = String(snapshot.attributes?.id ?? '').trim();
  if (!id) throw new Error(`${snapshot.tagName} の追加には id 属性が必要です。`);
  return id;
}

function nodePositionFromSnapshot(snapshot) {
  if (snapshot.tagName !== 'StbNode') return null;
  const position = {
    x: Number(snapshot.attributes.X),
    y: Number(snapshot.attributes.Y),
    z: Number(snapshot.attributes.Z),
  };
  if (!Object.values(position).every(Number.isFinite)) {
    throw new Error('StbNode の追加には有限な X / Y / Z が必要です。');
  }
  return position;
}

function resolveNodeMapKey(nodeMap, nodeId) {
  if (!(nodeMap instanceof Map)) return null;
  const targetId = String(nodeId);
  if (nodeMap.has(targetId)) return targetId;
  for (const key of nodeMap.keys()) {
    if (String(key) === targetId) return key;
  }
  return null;
}

function addNodeMapEntry(nodeMap, nodeId, position) {
  if (!(nodeMap instanceof Map) || !position) return;
  if (resolveNodeMapKey(nodeMap, nodeId) !== null) {
    throw new Error(`workingNodeMap の Node ID ${nodeId} は既に使用されています。`);
  }
  nodeMap.set(String(nodeId), { ...position });
}

function removeNodeMapEntry(nodeMap, nodeId) {
  if (!(nodeMap instanceof Map)) return;
  const key = resolveNodeMapKey(nodeMap, nodeId);
  if (key !== null) nodeMap.delete(key);
}

function deriveAffectedElements(snapshot, elementId, options) {
  if (Array.isArray(options.affectedElements)) return [...options.affectedElements];
  const elementType = viewerElementTypeFromTagName(snapshot.tagName);
  return elementType ? [{ elementType, elementId: String(elementId) }] : [];
}

/**
 * detached XML Element から AddElementCommand を生成する。
 *
 * @param {Document} document current Working Document
 * @param {Element} element documentへまだ挿入していない要素
 * @param {{parentPath:Array<string|{tagName:string,attributes?:Object}>,elementType?:string,affectedElements?:Array,siblingOrder?:string[]}} options
 */
export function createAddElementCommand(document, element, options = {}) {
  const parentPath = normalizeParentPath(options.parentPath);
  const snapshot = snapshotElement(element);
  const elementId = normalizeElementId(snapshot);
  const nodePosition = nodePositionFromSnapshot(snapshot);
  const siblingOrder = normalizeSiblingOrder(options.siblingOrder);
  if (siblingOrder && !siblingOrder.includes(snapshot.tagName)) {
    throw new Error(
      `AddElementCommand の siblingOrder に追加対象 ${snapshot.tagName} が含まれていません。`,
    );
  }

  if (findElementByTagAndId(document, snapshot.tagName, elementId)) {
    throw new Error(`${snapshot.tagName}#${elementId} は既に Working Document に存在します。`);
  }

  const parentExistence = captureParentExistence(document, parentPath);
  const elementType = String(
    options.elementType ||
      viewerElementTypeFromTagName(snapshot.tagName) ||
      snapshot.tagName.replace(/^Stb/, ''),
  );

  return {
    type: 'addElement',
    label: options.label || `${snapshot.tagName} #${elementId} を追加`,
    target: { elementType, elementId },
    parentPath,
    parentExistence,
    siblingOrder,
    elementSnapshot: snapshot,
    elementId,
    nodePosition,
    affectedElements: deriveAffectedElements(snapshot, elementId, options),
    structuralChange: {
      operation: 'add',
      elementType,
      elementId,
      tagName: snapshot.tagName,
    },
    isNoop: false,
  };
}

function applyAdd(document, nodeMap, command) {
  if (findElementByTagAndId(document, command.elementSnapshot.tagName, command.elementId)) {
    throw new Error(
      `${command.elementSnapshot.tagName}#${command.elementId} は既に Working Document に存在します。`,
    );
  }
  if (command.nodePosition && resolveNodeMapKey(nodeMap, command.elementId) !== null) {
    throw new Error(`workingNodeMap の Node ID ${command.elementId} は既に使用されています。`);
  }

  let created = [];
  try {
    const resolved = resolveParent(document, command.parentPath, command.parentExistence, {
      create: true,
    });
    created = resolved.created;
    const element = restoreElement(document, command.elementSnapshot);
    insertChildInOrder(resolved.parent, element, command.siblingOrder || null);
    addNodeMapEntry(nodeMap, command.elementId, command.nodePosition);
  } catch (error) {
    for (const item of [...created].reverse()) {
      if (item.element.children.length === 0) item.element.remove();
    }
    throw error;
  }
  return command.affectedElements || [];
}

function revertAdd(document, nodeMap, command) {
  const resolved = resolveParent(document, command.parentPath, command.parentExistence, {
    create: false,
  });
  if (!resolved.parent) {
    throw new Error('AddElementCommand の Undo 対象 parent が見つかりません。');
  }
  const element = Array.from(resolved.parent.children || []).find(
    (child) =>
      child.tagName === command.elementSnapshot.tagName &&
      child.getAttribute('id') === String(command.elementId),
  );
  if (!element) {
    throw new Error(
      `${command.elementSnapshot.tagName}#${command.elementId} が Undo 対象 parent に見つかりません。`,
    );
  }

  element.remove();
  removeNodeMapEntry(nodeMap, command.elementId);
  cleanupOriginallyMissingParents(document, command);
  return command.affectedElements || [];
}

export function applyAddElementCommand(document, nodeMap, command, direction = 'after') {
  if (command?.type !== 'addElement') throw new Error('AddElementCommand ではありません。');
  if (direction === 'after') return applyAdd(document, nodeMap, command);
  if (direction === 'before') return revertAdd(document, nodeMap, command);
  throw new Error(`未対応の Command 適用方向です: ${direction}`);
}
