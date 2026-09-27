/**
 * @fileoverview Working Document から semantic edit grip を解決する Provider
 *
 * Grip は表示座標と編集意味だけを返し、DOM / Object3D を直接変更しない。
 * drag commit は behavior/target を EditingSession Command へ解決する責務を別層に残す。
 */

import { STB_TAG_NAMES } from '../../constants/elementTypes.js';

const ELEMENT_TAG_BY_TYPE = Object.freeze({
  Node: STB_TAG_NAMES.NODE,
  Column: STB_TAG_NAMES.COLUMN,
  Post: STB_TAG_NAMES.POST,
  Girder: STB_TAG_NAMES.GIRDER,
  Beam: STB_TAG_NAMES.BEAM,
  Brace: STB_TAG_NAMES.BRACE,
  Slab: STB_TAG_NAMES.SLAB,
  Wall: STB_TAG_NAMES.WALL,
  ShearWall: STB_TAG_NAMES.WALL,
});

const LINE_NODE_ATTRIBUTES = Object.freeze({
  Column: [
    ['bottom', 'id_node_bottom'],
    ['top', 'id_node_top'],
  ],
  Post: [
    ['bottom', 'id_node_bottom'],
    ['top', 'id_node_top'],
  ],
  Girder: [
    ['start', 'id_node_start'],
    ['end', 'id_node_end'],
  ],
  Beam: [
    ['start', 'id_node_start'],
    ['end', 'id_node_end'],
  ],
  Brace: [
    ['start', 'id_node_start'],
    ['end', 'id_node_end'],
  ],
});

function findById(document, tagName, id) {
  if (!document || !tagName || id === null || id === undefined) return null;
  const targetId = String(id);
  return [...document.getElementsByTagName(tagName)].find(
    (element) => String(element.getAttribute('id')) === targetId,
  );
}

function finitePosition(value) {
  if (!value || typeof value !== 'object') return null;
  const position = { x: Number(value.x), y: Number(value.y), z: Number(value.z) };
  return Object.values(position).every(Number.isFinite) ? position : null;
}

function getNodeMapPosition(nodeMap, nodeId) {
  if (!(nodeMap instanceof Map)) return null;
  const targetId = String(nodeId);
  if (nodeMap.has(targetId)) return finitePosition(nodeMap.get(targetId));
  for (const [key, value] of nodeMap.entries()) {
    if (String(key) === targetId) return finitePosition(value);
  }
  return null;
}

function getNodePosition(document, nodeMap, nodeId) {
  const mapped = getNodeMapPosition(nodeMap, nodeId);
  if (mapped) return mapped;
  const node = findById(document, STB_TAG_NAMES.NODE, nodeId);
  if (!node) return null;
  return finitePosition({
    x: node.getAttribute('X'),
    y: node.getAttribute('Y'),
    z: node.getAttribute('Z'),
  });
}

function createNodeGrip(document, nodeMap, ownerIdentity, nodeId, role) {
  const position = getNodePosition(document, nodeMap, nodeId);
  if (!position) return null;
  const normalizedNodeId = String(nodeId);
  const ownerType = String(ownerIdentity.elementType);
  const ownerId = String(ownerIdentity.elementId);
  return Object.freeze({
    id: `${ownerType}:${ownerId}:node:${role}:${normalizedNodeId}`,
    position,
    target: Object.freeze({
      elementType: 'Node',
      elementId: normalizedNodeId,
      modelSource: 'A',
      subType: null,
      subId: null,
    }),
    owner: Object.freeze({ elementType: ownerType, elementId: ownerId }),
    role,
    behavior: 'moveNode',
  });
}

function orderedPanelNodeIds(element) {
  const order = element?.getElementsByTagName('StbNodeIdOrder')?.[0];
  if (!order?.textContent) return [];
  return order.textContent.trim().split(/\s+/).filter(Boolean);
}

function gripsForNode(document, nodeMap, identity) {
  const grip = createNodeGrip(document, nodeMap, identity, identity.elementId, 'node');
  return grip ? [grip] : [];
}

function gripsForLineElement(document, nodeMap, identity, element) {
  const attrs = LINE_NODE_ATTRIBUTES[identity.elementType] || [];
  const result = [];
  for (const [role, attr] of attrs) {
    const nodeId = element.getAttribute(attr);
    if (!nodeId) continue;
    const grip = createNodeGrip(document, nodeMap, identity, nodeId, role);
    if (grip) result.push(grip);
  }
  return result;
}

function gripsForPanel(document, nodeMap, identity, element) {
  return orderedPanelNodeIds(element)
    .map((nodeId, index) =>
      createNodeGrip(document, nodeMap, identity, nodeId, `vertex-${index + 1}`),
    )
    .filter(Boolean);
}

export function getSemanticGrips(document, identity, options = {}) {
  if (!identity?.elementType || identity.elementId === undefined || identity.elementId === null) {
    return [];
  }
  const nodeMap = options.nodeMap || null;
  if (identity.elementType === 'Node') return gripsForNode(document, nodeMap, identity);

  const tagName = ELEMENT_TAG_BY_TYPE[identity.elementType];
  const element = findById(document, tagName, identity.elementId);
  if (!element) return [];

  if (LINE_NODE_ATTRIBUTES[identity.elementType]) {
    return gripsForLineElement(document, nodeMap, identity, element);
  }
  if (identity.elementType === 'Slab' || ['Wall', 'ShearWall'].includes(identity.elementType)) {
    return gripsForPanel(document, nodeMap, identity, element);
  }
  return [];
}

export function getSemanticGripsForSelections(document, identities, options = {}) {
  const result = new Map();
  for (const identity of Array.isArray(identities) ? identities : []) {
    for (const grip of getSemanticGrips(document, identity, options)) {
      // 同一節点を複数部材が共有する場合、drag target は同じ Node なので1つに集約する。
      const key = `${grip.behavior}:${grip.target.elementType}:${grip.target.elementId}`;
      if (!result.has(key)) result.set(key, grip);
    }
  }
  return [...result.values()];
}
