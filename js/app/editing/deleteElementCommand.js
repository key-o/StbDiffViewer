/**
 * @fileoverview Working Document から要素を可逆削除する DeleteElementCommand。
 *
 * Node / Section / Member の既知 typed reference を静的に判定し、参照中要素の削除は
 * dangling reference を作るため拒否する。参照種別を解決できない id_member が存在する場合も
 * 部分判定せず fail-closed とする。
 */

import {
  collectIdReferences,
  resolveIdReferenceCategory,
} from '../../common-stb/edit/idReferenceUpdater.js';
import { resolveSectionReferenceLocations } from '../../modelLoader/editImpactResolver.js';
import {
  findElementByTagAndId,
  resolveAffectedElementsForAnchor,
  resolveElementTagName,
} from './attributeCommandUtils.js';
import { collectMemberIdReferences, isMemberIdOwnerTag } from './memberReferenceResolver.js';

const SAFE_SECTION_TAGS = new Set([
  'StbSecColumn_RC',
  'StbSecColumn_S',
  'StbSecColumn_SRC',
  'StbSecColumn_CFT',
  'StbSecGirder_RC',
  'StbSecGirder_S',
  'StbSecGirder_SRC',
  'StbSecBeam_RC',
  'StbSecBeam_S',
  'StbSecBeam_SRC',
  'StbSecBrace_S',
  'StbSecSlab_RC',
  'StbSecSlabDeck',
  'StbSecSlabPrecast',
  'StbSecWall_RC',
  'StbSecFoundation_RC',
  'StbSecPile_RC',
  'StbSecPile_S',
  'StbSecPileProduct',
  'StbSecParapet_RC',
  'StbSecUndefined',
]);

// 2.1.x の配置要素は自身の id を他要素から参照される定義ではなく、
// kind_member + id_member で host を参照する leaf record として扱う。
// generic bypass を公開せず、意味論を確認済みのタグだけ delete を許可する。
const SAFE_LEAF_DELETE_TAGS = new Set(['StbOpenArrangement', 'StbJointArrangement']);

function snapshotElement(element) {
  const attributes = {};
  for (const attr of Array.from(element.attributes || [])) attributes[attr.name] = attr.value;
  const children = Array.from(element.children || []).map(snapshotElement);
  return {
    tagName: element.tagName,
    namespaceURI: element.namespaceURI || null,
    attributes,
    text: children.length === 0 ? String(element.textContent || '') : null,
    children,
  };
}

function restoreElement(document, snapshot) {
  const element = snapshot.namespaceURI
    ? document.createElementNS(snapshot.namespaceURI, snapshot.tagName)
    : document.createElement(snapshot.tagName);
  for (const [name, value] of Object.entries(snapshot.attributes || {})) {
    element.setAttribute(name, String(value));
  }
  if (snapshot.children?.length) {
    for (const child of snapshot.children) element.appendChild(restoreElement(document, child));
  } else if (snapshot.text) {
    element.textContent = snapshot.text;
  }
  return element;
}

function getParentTag(element) {
  const tagName = element?.parentElement?.tagName || element?.parentNode?.tagName || null;
  if (!tagName) throw new Error('DeleteElementCommand の親要素を特定できません。');
  return tagName;
}

function findParent(document, parentTagName) {
  const matches = [...document.getElementsByTagName(parentTagName)];
  if (matches.length !== 1) {
    throw new Error(
      `DeleteElementCommand の親 ${parentTagName} を一意に再解決できません: ${matches.length}件`,
    );
  }
  return matches[0];
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

function removeNodeMapEntry(nodeMap, nodeId) {
  if (!(nodeMap instanceof Map)) return null;
  const key = resolveNodeMapKey(nodeMap, nodeId);
  if (key === null) return null;
  const value = nodeMap.get(key);
  nodeMap.delete(key);
  return value && typeof value === 'object' ? { ...value } : value;
}

function restoreNodeMapEntry(nodeMap, nodeId, value) {
  if (!(nodeMap instanceof Map)) return;
  if (resolveNodeMapKey(nodeMap, nodeId) !== null) {
    throw new Error(`workingNodeMap の Node ID ${nodeId} は既に使用されています。`);
  }
  if (value !== null && value !== undefined) nodeMap.set(String(nodeId), value);
}

function resolveTypedReferenceCategory(tagName) {
  const category = resolveIdReferenceCategory(tagName);
  if (category !== 'other') return category;
  if (isMemberIdOwnerTag(tagName)) return 'member';
  return SAFE_LEAF_DELETE_TAGS.has(tagName) ? 'leaf' : category;
}

function collectTrackedReferences(document, tagName, elementId, category) {
  if (category === 'node') return collectIdReferences(document, tagName, elementId).refs.length;
  if (category === 'section') {
    if (!SAFE_SECTION_TAGS.has(tagName)) {
      throw new Error(`${tagName} は typed delete reference resolver の対象外です。`);
    }
    return resolveSectionReferenceLocations(document, elementId, tagName).length;
  }
  if (category === 'member') {
    return collectMemberIdReferences(document, tagName, elementId).refs.length;
  }
  if (category === 'leaf' && SAFE_LEAF_DELETE_TAGS.has(tagName)) return 0;
  throw new Error(`${tagName} の削除参照意味論は typed reference resolver の対象外です。`);
}

/**
 * @param {Document} document
 * @param {string} elementType
 * @param {string|number} elementId
 * @param {{tagName?:string,label?:string,affectedElements?:Array,structuralChange?:boolean}} options
 */
export function createDeleteElementCommand(document, elementType, elementId, options = {}) {
  const id = String(elementId ?? '').trim();
  if (!id) throw new Error('DeleteElementCommand には elementId が必要です。');
  const tagName = options.tagName || resolveElementTagName(elementType);
  if (!tagName) throw new Error('DeleteElementCommand の elementType が不正です。');

  const element = findElementByTagAndId(document, tagName, id);
  if (!element) throw new Error(`${tagName}#${id} が Working Document に見つかりません。`);

  const category = resolveTypedReferenceCategory(tagName);
  const referenceCount = collectTrackedReferences(document, tagName, id, category);
  if (referenceCount > 0) {
    throw new Error(
      `${tagName}#${id} は ${referenceCount}件から参照されているため削除できません。`,
    );
  }

  const parentTagName = getParentTag(element);
  const parent = element.parentElement || element.parentNode;
  const childIndex = Array.from(parent.children || []).indexOf(element);
  const nodeMapValue = null;
  const affectedElements = Array.isArray(options.affectedElements)
    ? options.affectedElements.map((item) => ({
        elementType: String(item.elementType),
        elementId: String(item.elementId),
      }))
    : resolveAffectedElementsForAnchor(document, tagName, id);
  const structuralChange =
    options.structuralChange === false
      ? null
      : {
          operation: 'delete',
          elementType: String(elementType),
          elementId: id,
          tagName,
        };

  return {
    type: 'deleteElement',
    label: options.label || `${tagName} #${id} を削除`,
    target: { elementType: String(elementType), elementId: id },
    tagName,
    category,
    elementId: id,
    parentTagName,
    childIndex,
    elementSnapshot: snapshotElement(element),
    nodeMapValue,
    referenceCount,
    affectedElements,
    structuralChange,
    isNoop: false,
  };
}

function applyDelete(document, nodeMap, command) {
  const element = findElementByTagAndId(document, command.tagName, command.elementId);
  if (!element) {
    throw new Error(`${command.tagName}#${command.elementId} が削除対象として見つかりません。`);
  }

  const currentReferenceCount = collectTrackedReferences(
    document,
    command.tagName,
    command.elementId,
    command.category,
  );
  if (currentReferenceCount > 0) {
    throw new Error(
      `${command.tagName}#${command.elementId} は現在 ${currentReferenceCount}件から参照されているため削除できません。`,
    );
  }

  if (command.category === 'node') {
    command.nodeMapValue = removeNodeMapEntry(nodeMap, command.elementId);
  }
  element.remove();
  return command.affectedElements || [];
}

function revertDelete(document, nodeMap, command) {
  if (findElementByTagAndId(document, command.tagName, command.elementId)) {
    throw new Error(`${command.tagName}#${command.elementId} は既に存在するため Undo できません。`);
  }
  if (command.category === 'node' && resolveNodeMapKey(nodeMap, command.elementId) !== null) {
    throw new Error(`workingNodeMap の Node ID ${command.elementId} は既に使用されています。`);
  }

  const parent = findParent(document, command.parentTagName);
  const restored = restoreElement(document, command.elementSnapshot);
  const children = Array.from(parent.children || []);
  const before = children[command.childIndex] || null;
  if (before) parent.insertBefore(restored, before);
  else parent.appendChild(restored);

  if (command.category === 'node') {
    restoreNodeMapEntry(nodeMap, command.elementId, command.nodeMapValue);
  }
  return command.affectedElements || [];
}

export function applyDeleteElementCommand(document, nodeMap, command, direction = 'after') {
  if (command?.type !== 'deleteElement') throw new Error('DeleteElementCommand ではありません。');
  if (direction === 'after') return applyDelete(document, nodeMap, command);
  if (direction === 'before') return revertDelete(document, nodeMap, command);
  throw new Error(`未対応の Command 適用方向です: ${direction}`);
}
