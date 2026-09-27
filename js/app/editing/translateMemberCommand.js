/**
 * @fileoverview Node を固定したまま ST-Bridge 部材を offset で平行移動する Command。
 *
 * MOVE の「関連節点を追従しない」モードで使用する。
 * 線材は始終端（または柱脚・柱頭）offset、床・壁は節点別 offset list を更新する。
 * panel offset list が元データに存在しない場合も apply 時に生成し、Undo では未定義状態へ戻す。
 */

import {
  applyNullableAttributeValue,
  findElementByTagAndId,
  resolveElementTagName,
  toFiniteNumber,
  viewerElementTypeFromElement,
} from './attributeCommandUtils.js';

const AXES = Object.freeze([
  ['X', 'x'],
  ['Y', 'y'],
  ['Z', 'z'],
]);

const LINE_CONFIG = Object.freeze({
  Column: Object.freeze([
    Object.freeze({ nodeAttribute: 'id_node_bottom', offsetPrefix: 'offset_bottom' }),
    Object.freeze({ nodeAttribute: 'id_node_top', offsetPrefix: 'offset_top' }),
  ]),
  Post: Object.freeze([
    Object.freeze({ nodeAttribute: 'id_node_bottom', offsetPrefix: 'offset_bottom' }),
    Object.freeze({ nodeAttribute: 'id_node_top', offsetPrefix: 'offset_top' }),
  ]),
  Girder: Object.freeze([
    Object.freeze({ nodeAttribute: 'id_node_start', offsetPrefix: 'offset_start' }),
    Object.freeze({ nodeAttribute: 'id_node_end', offsetPrefix: 'offset_end' }),
  ]),
  Beam: Object.freeze([
    Object.freeze({ nodeAttribute: 'id_node_start', offsetPrefix: 'offset_start' }),
    Object.freeze({ nodeAttribute: 'id_node_end', offsetPrefix: 'offset_end' }),
  ]),
  Brace: Object.freeze([
    Object.freeze({ nodeAttribute: 'id_node_start', offsetPrefix: 'offset_start' }),
    Object.freeze({ nodeAttribute: 'id_node_end', offsetPrefix: 'offset_end' }),
  ]),
});

const PANEL_CONFIG = Object.freeze({
  Slab: Object.freeze({ listTag: 'StbSlabOffsetList', itemTag: 'StbSlabOffset' }),
  Wall: Object.freeze({ listTag: 'StbWallOffsetList', itemTag: 'StbWallOffset' }),
  ShearWall: Object.freeze({ listTag: 'StbWallOffsetList', itemTag: 'StbWallOffset' }),
});

function normalizeElementType(elementType) {
  const normalized = String(elementType || '').trim();
  if (!normalized) throw new Error('部材 MOVE には elementType が必要です。');
  return normalized;
}

function normalizeDelta(delta) {
  if (!delta || typeof delta !== 'object') throw new Error('部材 MOVE には移動量が必要です。');
  const result = {};
  for (const [axis, key] of AXES) {
    const value = toFiniteNumber(delta[key], `MOVE Δ${axis}`);
    if (value === null) throw new Error(`MOVE Δ${axis}は有限値で指定してください。`);
    result[key] = value;
  }
  return result;
}

function deltaIsZero(delta) {
  return delta.x === 0 && delta.y === 0 && delta.z === 0;
}

function normalizeNodeIdSet(nodeIds) {
  return new Set(
    (Array.isArray(nodeIds) ? nodeIds : [])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean),
  );
}

function directChild(parent, tagName) {
  return [...(parent?.children || [])].find((child) => child.tagName === tagName) || null;
}

function createElement(document, tagName, namespaceURI = null) {
  return namespaceURI
    ? document.createElementNS(namespaceURI, tagName)
    : document.createElement(tagName);
}

function snapshotNode(node) {
  if (!node) return null;
  if (node.nodeType === 1) {
    return { type: 'element', snapshot: snapshotElement(node) };
  }
  if (node.nodeType === 3) {
    return { type: 'text', value: String(node.nodeValue || '') };
  }
  if (node.nodeType === 4) {
    return { type: 'cdata', value: String(node.nodeValue || '') };
  }
  if (node.nodeType === 8) {
    return { type: 'comment', value: String(node.nodeValue || '') };
  }
  return null;
}

function snapshotElement(element) {
  if (!element) return null;
  const attributes = {};
  for (const attr of Array.from(element.attributes || [])) attributes[attr.name] = attr.value;
  const children = Array.from(element.childNodes || [])
    .map(snapshotNode)
    .filter(Boolean);
  return {
    tagName: element.tagName,
    namespaceURI: element.namespaceURI || null,
    attributes,
    children,
  };
}

function restoreNode(document, snapshot) {
  if (!snapshot) return null;
  if (snapshot.type === 'text') return document.createTextNode(snapshot.value || '');
  if (snapshot.type === 'cdata') return document.createCDATASection(snapshot.value || '');
  if (snapshot.type === 'comment') return document.createComment(snapshot.value || '');
  if (snapshot.type === 'element') return restoreElement(document, snapshot.snapshot);

  // In-memory history from an older command instance used element-only child snapshots.
  return restoreElement(document, snapshot);
}

function restoreElement(document, snapshot) {
  const element = createElement(document, snapshot.tagName, snapshot.namespaceURI);
  for (const [name, value] of Object.entries(snapshot.attributes || {})) {
    element.setAttribute(name, String(value));
  }
  if (Array.isArray(snapshot.children) && snapshot.children.length > 0) {
    for (const child of snapshot.children) {
      const restored = restoreNode(document, child);
      if (restored) element.appendChild(restored);
    }
  } else if (snapshot.text) {
    // Backward-compatible fallback for the original element-only snapshot shape.
    element.textContent = snapshot.text;
  }
  return element;
}

function snapshotEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function readOffsetValue(element, attributeName, label) {
  if (!element?.hasAttribute(attributeName)) return 0;
  const value = toFiniteNumber(element.getAttribute(attributeName), label);
  return value === null ? 0 : value;
}

function setTranslatedAxis(element, attributeName, increment, label) {
  if (increment === 0) return;
  const current = readOffsetValue(element, attributeName, label);
  element.setAttribute(attributeName, String(current + increment));
}

function orderedPanelNodeIds(member) {
  const order = directChild(member, 'StbNodeIdOrder');
  return String(order?.textContent || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function createPanelAfterSnapshot(document, member, config, delta, movingNodeIds) {
  const existing = directChild(member, config.listTag);
  if (deltaIsZero(delta)) return snapshotElement(existing);

  const targetNodeIds = orderedPanelNodeIds(member).filter((nodeId) => !movingNodeIds.has(nodeId));
  if (targetNodeIds.length === 0) return snapshotElement(existing);

  const list = existing
    ? restoreElement(document, snapshotElement(existing))
    : createElement(document, config.listTag, member.namespaceURI || null);

  for (const nodeId of targetNodeIds) {
    let item = [...list.children].find(
      (child) =>
        child.tagName === config.itemTag && String(child.getAttribute('id_node')) === nodeId,
    );
    if (!item) {
      item = createElement(
        document,
        config.itemTag,
        list.namespaceURI || member.namespaceURI || null,
      );
      item.setAttribute('id_node', nodeId);
      for (const [axis, key] of AXES) {
        item.setAttribute(`offset_${axis}`, String(delta[key]));
      }
      list.appendChild(item);
      continue;
    }

    for (const [axis, key] of AXES) {
      setTranslatedAxis(
        item,
        `offset_${axis}`,
        delta[key],
        `${config.itemTag}#${nodeId}.offset_${axis}`,
      );
    }
  }

  return snapshotElement(list);
}

function insertPanelOffsetList(member, list) {
  const order = directChild(member, 'StbNodeIdOrder');
  if (!order) {
    member.appendChild(list);
    return;
  }
  member.insertBefore(list, order.nextSibling);
}

function applyPanelSnapshot(document, member, config, snapshot) {
  const current = directChild(member, config.listTag);
  if (!snapshot) {
    current?.remove();
    return;
  }
  const restored = restoreElement(document, snapshot);
  if (current) current.replaceWith(restored);
  else insertPanelOffsetList(member, restored);
}

function createLineCommand(member, elementType, elementId, delta, movingNodeIds, options) {
  const endpointConfig = LINE_CONFIG[elementType];
  const attributes = [];
  const before = {};
  const after = {};

  if (!deltaIsZero(delta)) {
    for (const endpoint of endpointConfig) {
      const nodeId = String(member.getAttribute(endpoint.nodeAttribute) || '').trim();
      if (nodeId && movingNodeIds.has(nodeId)) continue;

      for (const [axis, key] of AXES) {
        if (delta[key] === 0) continue;
        const attributeName = `${endpoint.offsetPrefix}_${axis}`;
        const rawBefore = member.hasAttribute(attributeName)
          ? member.getAttribute(attributeName)
          : null;
        const base = readOffsetValue(member, attributeName, `${member.tagName}.${attributeName}`);
        attributes.push(attributeName);
        before[attributeName] = rawBefore;
        after[attributeName] = String(base + delta[key]);
      }
    }
  }

  const viewerElementType = viewerElementTypeFromElement(member) || elementType;
  return {
    type: 'translateMember',
    mode: 'line',
    label: options.label || `${member.tagName} ${elementId} を節点固定で移動`,
    target: { elementType: viewerElementType, elementId: String(elementId) },
    locator: { tagName: member.tagName, elementId: String(elementId) },
    attributes,
    before,
    after,
    delta,
    affectedElements: [{ elementType: viewerElementType, elementId: String(elementId) }],
    isNoop: attributes.length === 0,
  };
}

function createPanelCommand(
  document,
  member,
  elementType,
  elementId,
  delta,
  movingNodeIds,
  options,
) {
  const config = PANEL_CONFIG[elementType];
  const before = snapshotElement(directChild(member, config.listTag));
  const after = createPanelAfterSnapshot(document, member, config, delta, movingNodeIds);
  const viewerElementType = viewerElementTypeFromElement(member) || elementType;
  return {
    type: 'translateMember',
    mode: 'panel',
    label: options.label || `${member.tagName} ${elementId} を節点固定で移動`,
    target: { elementType: viewerElementType, elementId: String(elementId) },
    locator: { tagName: member.tagName, elementId: String(elementId) },
    panelConfig: config,
    before,
    after,
    delta,
    affectedElements: [{ elementType: viewerElementType, elementId: String(elementId) }],
    isNoop: snapshotEqual(before, after),
  };
}

/**
 * 選択部材を節点固定で平行移動する可逆 Command を生成する。
 * movingNodeIds は同一 transaction で明示的に移動する Node。該当端点には offset を加えず、
 * Node MOVE と member offset の二重移動を防止する。
 */
export function createTranslateMemberCommand(
  document,
  elementType,
  elementId,
  delta,
  options = {},
) {
  const normalizedType = normalizeElementType(elementType);
  const normalizedDelta = normalizeDelta(delta);
  const lineConfig = LINE_CONFIG[normalizedType];
  const panelConfig = PANEL_CONFIG[normalizedType];
  if (!lineConfig && !panelConfig) {
    throw new Error(`${normalizedType} は節点固定 MOVE の対象ではありません。`);
  }

  const tagName = resolveElementTagName(normalizedType);
  const member = findElementByTagAndId(document, tagName, elementId);
  if (!member) throw new Error(`${tagName}#${elementId} が Working Document に見つかりません。`);
  const movingNodeIds = normalizeNodeIdSet(options.movingNodeIds);

  if (lineConfig) {
    return createLineCommand(
      member,
      normalizedType,
      elementId,
      normalizedDelta,
      movingNodeIds,
      options,
    );
  }
  return createPanelCommand(
    document,
    member,
    normalizedType,
    elementId,
    normalizedDelta,
    movingNodeIds,
    options,
  );
}

export function applyTranslateMemberCommand(document, _nodeMap, command, direction = 'after') {
  if (!command || command.type !== 'translateMember') {
    throw new Error('translateMember Command が指定されていません。');
  }
  if (direction !== 'after' && direction !== 'before') {
    throw new Error(`未対応の Command 適用方向です: ${direction}`);
  }

  const member = findElementByTagAndId(
    document,
    command.locator?.tagName,
    command.locator?.elementId,
  );
  if (!member) {
    throw new Error(
      `${command.locator?.tagName}#${command.locator?.elementId} が Working Document に見つかりません。`,
    );
  }

  if (command.mode === 'line') {
    const values = direction === 'before' ? command.before : command.after;
    for (const attributeName of command.attributes || []) {
      applyNullableAttributeValue(member, attributeName, values?.[attributeName] ?? null);
    }
    return command.affectedElements || [];
  }

  if (command.mode === 'panel') {
    const snapshot = direction === 'before' ? command.before : command.after;
    applyPanelSnapshot(document, member, command.panelConfig, snapshot);
    return command.affectedElements || [];
  }

  throw new Error(`未対応の translateMember mode です: ${command.mode}`);
}
