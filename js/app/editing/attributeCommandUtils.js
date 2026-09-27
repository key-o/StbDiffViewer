/**
 * @fileoverview Working Document 属性系 Command の共通ターゲット解決。
 *
 * UI の Object3D や表示キャッシュを参照せず、ST-Bridge XML の tag/id または
 * editPath から semantic target を解決する。Command の apply / revert で同じ locator を
 * 再解決できることを優先し、DOM Element 自体は履歴へ保持しない。
 */

import {
  resolveAffectedElementsForNode,
  resolveAffectedElementsForSection,
} from '../../modelLoader/editImpactResolver.js';
import { getViewerWallElementType } from '../../common-stb/walls/wallClassification.js';

const ELEMENT_TYPE_TAG_OVERRIDES = Object.freeze({
  Node: 'StbNode',
  ShearWall: 'StbWall',
  Axis: 'StbParallelAxis',
});

const MEMBER_TAG_TO_ELEMENT_TYPE = Object.freeze({
  StbColumn: 'Column',
  StbPost: 'Post',
  StbGirder: 'Girder',
  StbBeam: 'Beam',
  StbBrace: 'Brace',
  StbSlab: 'Slab',
  StbWall: 'Wall',
  StbParapet: 'Parapet',
  StbPile: 'Pile',
  StbFooting: 'Footing',
  StbStripFooting: 'StripFooting',
  StbFoundationColumn: 'FoundationColumn',
  StbIsolatingDevice: 'IsolatingDevice',
  StbDampingDevice: 'DampingDevice',
  StbFrameDampingDevice: 'FrameDampingDevice',
});

export function resolveElementTagName(elementType) {
  const normalized = String(elementType || '').trim();
  if (!normalized) return null;
  if (normalized.startsWith('Stb')) return normalized;
  return ELEMENT_TYPE_TAG_OVERRIDES[normalized] || `Stb${normalized}`;
}

export function viewerElementTypeFromTagName(tagName) {
  return MEMBER_TAG_TO_ELEMENT_TYPE[String(tagName || '')] || null;
}

/**
 * XML element 自体から Viewer element type を解決する。
 * StbWall だけは同一タグ内で通常壁/耐震壁を共有するため kind_wall を参照する。
 */
export function viewerElementTypeFromElement(element) {
  if (!element?.tagName) return null;
  if (element.tagName === 'StbWall') return getViewerWallElementType(element);
  return viewerElementTypeFromTagName(element.tagName);
}

export function findElementByTagAndId(document, tagName, elementId) {
  if (!document || !tagName || elementId === null || elementId === undefined) return null;
  const targetId = String(elementId);
  for (const element of document.getElementsByTagName(tagName)) {
    if (String(element.getAttribute('id')) === targetId) return element;
  }
  return null;
}

export function getEditPathAnchor(path) {
  if (!path) return null;
  const firstSegment = String(path).split('|')[0];
  const separator = firstSegment.lastIndexOf(':');
  if (separator < 0) return null;
  return {
    tagName: firstSegment.slice(0, separator),
    id: firstSegment.slice(separator + 1),
  };
}

export function resolveElementEditPath(document, path) {
  if (!document || !path) return null;

  const segments = String(path).split('|');
  const anchor = getEditPathAnchor(path);
  if (!anchor) return null;

  let current = findElementByTagAndId(document, anchor.tagName, anchor.id);
  for (let index = 1; current && index < segments.length; index += 1) {
    const separator = segments[index].lastIndexOf('@');
    if (separator < 0) return null;
    const tagName = segments[index].slice(0, separator);
    const childIndex = Number.parseInt(segments[index].slice(separator + 1), 10);
    if (!Number.isInteger(childIndex) || childIndex < 0) return null;
    const children = [...current.children].filter((child) => child.tagName === tagName);
    current = children[childIndex] || null;
  }
  return current;
}

export function resolveAttributeTarget(document, locator = {}) {
  const editPath = locator.editPath || null;
  if (editPath) {
    const anchor = getEditPathAnchor(editPath);
    const element = resolveElementEditPath(document, editPath);
    if (!anchor || !element) {
      throw new Error(`編集対象要素が Working Document に見つかりません: ${editPath}`);
    }
    return {
      element,
      tagName: element.tagName,
      anchorTagName: anchor.tagName,
      anchorId: String(anchor.id),
      editPath: String(editPath),
    };
  }

  const tagName = resolveElementTagName(locator.elementType);
  const elementId = String(locator.elementId ?? '');
  if (!tagName || !elementId) {
    throw new Error('属性編集には elementType と elementId が必要です。');
  }

  const element = findElementByTagAndId(document, tagName, elementId);
  if (!element) {
    throw new Error(`${tagName}#${elementId} が Working Document に見つかりません。`);
  }

  return {
    element,
    tagName,
    anchorTagName: tagName,
    anchorId: elementId,
    editPath: null,
  };
}

export function normalizeNullableAttributeValue(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

export function applyNullableAttributeValue(element, attributeName, value) {
  if (!element || !attributeName) throw new Error('属性更新対象が指定されていません。');
  if (value === null || value === undefined || value === '') {
    element.removeAttribute(attributeName);
  } else {
    element.setAttribute(attributeName, String(value));
  }
}

export function toFiniteNumber(value, label = '値') {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label}は有限値で指定してください。`);
  return number;
}

export function readFiniteNodePosition(node) {
  if (!node || node.tagName !== 'StbNode') return null;
  const x = toFiniteNumber(node.getAttribute('X'), 'Node.X');
  const y = toFiniteNumber(node.getAttribute('Y'), 'Node.Y');
  const z = toFiniteNumber(node.getAttribute('Z'), 'Node.Z');
  if (x === null || y === null || z === null) {
    throw new Error(`Node ${node.getAttribute('id')} の座標が有限値ではありません。`);
  }
  return { x, y, z };
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

export function writeNodeMapPosition(nodeMap, nodeId, position) {
  if (!(nodeMap instanceof Map) || !position) return;
  const key = resolveNodeMapKey(nodeMap, nodeId);
  const current = nodeMap.get(key);
  const next = current && typeof current === 'object' ? { ...current } : {};
  next.x = Number(position.x);
  next.y = Number(position.y);
  next.z = Number(position.z);
  nodeMap.set(key, next);
}

export function resolveAffectedElementsForAnchor(document, anchorTagName, anchorId) {
  if (!document || !anchorTagName || anchorId === null || anchorId === undefined) return [];

  if (anchorTagName === 'StbNode') {
    return resolveAffectedElementsForNode(document, anchorId);
  }
  if (anchorTagName.startsWith('StbSec')) {
    return resolveAffectedElementsForSection(document, anchorId, anchorTagName);
  }

  const anchorElement = findElementByTagAndId(document, anchorTagName, anchorId);
  const elementType =
    viewerElementTypeFromElement(anchorElement) || viewerElementTypeFromTagName(anchorTagName);
  if (elementType) {
    return [{ elementType, elementId: String(anchorId) }];
  }
  return [];
}
