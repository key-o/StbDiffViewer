/**
 * @fileoverview Working Document の ID リナンバー Command。
 *
 * Node は id_node 系・StbNodeId・StbNodeIdOrder を追従更新する。
 * Section は断面タグと部材種別/kind_structureを照合した typed reference のみを更新する。
 * Member は kind_member / StbNode.kind / connection child tag 等の typed reference を
 * 追従更新し、参照種別を解決できない id_member は fail-closed とする。
 */

import {
  applyIdReferenceUpdate,
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

function normalizeId(value, label) {
  const id = String(value ?? '').trim();
  if (!id) throw new Error(`${label}を指定してください。`);
  return id;
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

function assertNodeMapRenameAvailable(nodeMap, fromId, toId) {
  if (!(nodeMap instanceof Map)) return;
  const fromKey = resolveNodeMapKey(nodeMap, fromId);
  const toKey = resolveNodeMapKey(nodeMap, toId);
  if (toKey !== null && toKey !== fromKey) {
    throw new Error(`NodeMap の ID ${toId} は既に使用されています。`);
  }
}

function renameNodeMapKey(nodeMap, fromId, toId) {
  if (!(nodeMap instanceof Map)) return;
  const fromKey = resolveNodeMapKey(nodeMap, fromId);
  if (fromKey === null) return;
  const value = nodeMap.get(fromKey);
  nodeMap.delete(fromKey);
  nodeMap.set(String(toId), value);
}

function collectSectionReferences(document, tagName, sectionId) {
  return resolveSectionReferenceLocations(document, sectionId, tagName)
    .map((location) => {
      const element = findElementByTagAndId(document, location.tagName, location.elementId);
      return element ? { kind: 'attr', element, name: location.attributeName } : null;
    })
    .filter(Boolean);
}

function resolveTypedReferenceCategory(tagName) {
  const category = resolveIdReferenceCategory(tagName);
  if (category !== 'other') return category;
  return isMemberIdOwnerTag(tagName) ? 'member' : category;
}

function collectTypedReferences(document, tagName, id, category) {
  if (category === 'node') return collectIdReferences(document, tagName, id).refs;
  if (category === 'section') return collectSectionReferences(document, tagName, id);
  if (category === 'member') return collectMemberIdReferences(document, tagName, id).refs;
  return [];
}

function assertSupportedCategory(category, tagName) {
  if (category === 'node' || category === 'section' || category === 'member') return;
  throw new Error(`${tagName} のID参照意味論は typed reference resolver の対象外です。`);
}

/**
 * ID リナンバー Command を生成する。
 * @param {Document} document
 * @param {string} elementType
 * @param {string|number} elementId
 * @param {string|number} nextId
 * @returns {Object}
 */
export function createRenumberIdCommand(document, elementType, elementId, nextId) {
  const beforeId = normalizeId(elementId, '変更前ID');
  const afterId = normalizeId(nextId, '変更後ID');
  const tagName = resolveElementTagName(elementType);
  if (!tagName) throw new Error('ID変更対象の elementType が不正です。');

  const owner = findElementByTagAndId(document, tagName, beforeId);
  if (!owner) {
    throw new Error(`${tagName}#${beforeId} が Working Document に見つかりません。`);
  }

  const category = resolveTypedReferenceCategory(tagName);
  assertSupportedCategory(category, tagName);

  if (beforeId !== afterId) {
    const duplicate = findElementByTagAndId(document, tagName, afterId);
    if (duplicate) {
      throw new Error(`ID ${afterId} は既に ${tagName} で使用されています。`);
    }
  }

  const refs = collectTypedReferences(document, tagName, beforeId, category);
  return {
    type: 'renumberId',
    label: `${tagName} #${beforeId} → #${afterId}`,
    target: { elementType: String(elementType), elementId: beforeId },
    tagName,
    category,
    beforeId,
    afterId,
    referenceCount: refs.length,
    affectedElements: resolveAffectedElementsForAnchor(document, tagName, beforeId),
    identityChange: {
      elementType: String(elementType),
      tagName,
      category,
      beforeId,
      afterId,
    },
    isNoop: beforeId === afterId,
  };
}

/**
 * RenumberIdCommand を Working Document へ適用する。
 * @param {Document} document
 * @param {Map} nodeMap
 * @param {Object} command
 * @param {'after'|'before'} direction
 * @returns {Array<{elementType:string,elementId:string}>}
 */
export function applyRenumberIdCommand(document, nodeMap, command, direction = 'after') {
  if (command?.type !== 'renumberId') {
    throw new Error('RenumberIdCommand ではありません。');
  }
  if (direction !== 'after' && direction !== 'before') {
    throw new Error(`未対応の Command 適用方向です: ${direction}`);
  }
  assertSupportedCategory(command.category, command.tagName);

  const fromId = direction === 'after' ? command.beforeId : command.afterId;
  const toId = direction === 'after' ? command.afterId : command.beforeId;
  if (fromId === toId) return command.affectedElements || [];

  const owner = findElementByTagAndId(document, command.tagName, fromId);
  if (!owner) {
    throw new Error(`${command.tagName}#${fromId} が Working Document に見つかりません。`);
  }
  const duplicate = findElementByTagAndId(document, command.tagName, toId);
  if (duplicate && duplicate !== owner) {
    throw new Error(`ID ${toId} は既に ${command.tagName} で使用されています。`);
  }

  if (command.category === 'node') {
    assertNodeMapRenameAvailable(nodeMap, fromId, toId);
  }

  const refs = collectTypedReferences(document, command.tagName, fromId, command.category);
  applyIdReferenceUpdate(refs, fromId, toId);
  owner.setAttribute('id', String(toId));
  if (command.category === 'node') {
    renameNodeMapKey(nodeMap, fromId, toId);
  }

  return command.affectedElements || [];
}
