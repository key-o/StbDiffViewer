/**
 * @fileoverview accepted LOCAL_PRISMのStbExtensionをWorking Documentへ可逆upsertするCommand。
 */

import {
  CONCRETE_ACCOMMODATION_LOCAL_PRISM_EXTENSION_DESCRIPTION,
  CONCRETE_ACCOMMODATION_LOCAL_PRISM_EXTENSION_IDENTIFIER,
  createStbLocalPrismExtObjectElement,
  stbElementsByLocalName,
  stbLocalName,
} from '../../data/extractors/rebar3d/concreteAccommodationStbExtension.js';

function directChildren(parent, tagName) {
  return Array.from(parent?.children || []).filter((child) => stbLocalName(child) === tagName);
}

function extensionContainer(document) {
  const matches = stbElementsByLocalName(document, 'StbExtension').filter(
    (element) =>
      element.getAttribute('identifier') ===
      CONCRETE_ACCOMMODATION_LOCAL_PRISM_EXTENSION_IDENTIFIER,
  );
  if (matches.length > 1) {
    throw new Error(
      `LOCAL_PRISM StbExtensionが複数存在するため一意に更新できません: ${matches.length}件`,
    );
  }
  return matches[0] || null;
}

function objectCandidateId(object) {
  for (const child of Array.from(object?.children || [])) {
    if (stbLocalName(child) === 'StbExtProperty' && child.getAttribute('key') === 'candidate_id') {
      return child.getAttribute('value') || '';
    }
  }
  return '';
}

function findCandidateObject(extension, candidateId) {
  const matches = directChildren(extension, 'StbExtObject').filter(
    (object) => objectCandidateId(object) === String(candidateId),
  );
  if (matches.length > 1) {
    throw new Error(
      `LOCAL_PRISM candidate ${candidateId} のStbExtObjectが重複しています: ${matches.length}件`,
    );
  }
  return matches[0] || null;
}

function snapshotElement(element) {
  if (!element?.tagName) return null;
  const attributes = {};
  for (const attr of Array.from(element.attributes || [])) attributes[attr.name] = attr.value;
  return {
    tagName: element.tagName,
    namespaceURI: element.namespaceURI || null,
    attributes,
    text: element.children?.length ? null : String(element.textContent || ''),
    children: Array.from(element.children || []).map(snapshotElement),
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

function snapshotsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function rootElement(document) {
  const root = document?.documentElement || null;
  if (!root || stbLocalName(root) !== 'ST_BRIDGE') {
    throw new Error('Working DocumentにST_BRIDGEルートがありません。');
  }
  return root;
}

function createElement(document, tagName) {
  const namespace = document.documentElement?.namespaceURI || null;
  return namespace ? document.createElementNS(namespace, tagName) : document.createElement(tagName);
}

function ensureStbExtensions(document) {
  const root = rootElement(document);
  const existing = directChildren(root, 'StbExtensions');
  if (existing.length > 1) {
    throw new Error(`StbExtensionsが複数存在します: ${existing.length}件`);
  }
  if (existing.length === 1) return { element: existing[0], created: false };

  const created = createElement(document, 'StbExtensions');
  const order = [
    'StbCommon',
    'StbModel',
    'StbExtensions',
    'StbExportInformation',
    'StbCalData',
    'StbAnaModels',
  ];
  const targetIndex = order.indexOf('StbExtensions');
  const before = Array.from(root.children || []).find((child) => {
    const index = order.indexOf(stbLocalName(child));
    return index > targetIndex;
  });
  if (before) root.insertBefore(created, before);
  else root.appendChild(created);
  return { element: created, created: true };
}

function ensureExtension(document) {
  const current = extensionContainer(document);
  if (current) return { element: current, created: false };
  const { element: extensions } = ensureStbExtensions(document);
  const extension = createElement(document, 'StbExtension');
  extension.setAttribute('identifier', CONCRETE_ACCOMMODATION_LOCAL_PRISM_EXTENSION_IDENTIFIER);
  extension.setAttribute('description', CONCRETE_ACCOMMODATION_LOCAL_PRISM_EXTENSION_DESCRIPTION);
  extensions.appendChild(extension);
  return { element: extension, created: true };
}

function cleanupEmptyContainers(document) {
  const extension = extensionContainer(document);
  if (extension && directChildren(extension, 'StbExtObject').length === 0) {
    extension.remove();
  }
  const root = rootElement(document);
  const extensions = directChildren(root, 'StbExtensions')[0] || null;
  if (extensions && extensions.children.length === 0) extensions.remove();
}

function validateEntry(entry) {
  if (
    !entry ||
    entry.identifier !== CONCRETE_ACCOMMODATION_LOCAL_PRISM_EXTENSION_IDENTIFIER ||
    !entry.objectName ||
    !entry.idObject ||
    !entry.candidateId ||
    !Array.isArray(entry.properties) ||
    entry.properties.length === 0
  ) {
    throw new Error('LOCAL_PRISM StbExtension entryが不正です。');
  }
}

/**
 * @param {Document} document
 * @param {Object} entry buildStbLocalPrismExtensionEntry().entry
 */
export function createConcreteAccommodationExtensionCommand(document, entry, options = {}) {
  validateEntry(entry);
  const existingExtension = extensionContainer(document);
  const existingObject = existingExtension
    ? findCandidateObject(existingExtension, entry.candidateId)
    : null;
  const beforeSnapshot = snapshotElement(existingObject);
  const afterElement = createStbLocalPrismExtObjectElement(document, entry);
  if (!afterElement) throw new Error('LOCAL_PRISM StbExtObjectを生成できません。');
  const afterSnapshot = snapshotElement(afterElement);
  const isNoop = beforeSnapshot ? snapshotsEqual(beforeSnapshot, afterSnapshot) : false;

  return {
    type: 'upsertConcreteAccommodationExtension',
    label: options.label || `LOCAL_PRISM ${entry.candidateId} をStbExtensionへ保存`,
    candidateId: String(entry.candidateId),
    hostMemberTag: String(entry.objectName),
    hostMemberId: String(entry.idObject),
    beforeSnapshot,
    afterSnapshot,
    affectedElements: [
      {
        elementType: entry.objectName === 'StbGirder' ? 'Girder' : 'Beam',
        elementId: String(entry.idObject),
      },
    ],
    isNoop,
  };
}

function applySnapshot(document, command, snapshot) {
  const existingExtension = extensionContainer(document);
  const existingObject = existingExtension
    ? findCandidateObject(existingExtension, command.candidateId)
    : null;

  if (!snapshot) {
    if (existingObject) existingObject.remove();
    cleanupEmptyContainers(document);
    return command.affectedElements || [];
  }

  const { element: extension } = ensureExtension(document);
  const replacement = restoreElement(document, snapshot);
  const current = findCandidateObject(extension, command.candidateId);
  if (current) extension.replaceChild(replacement, current);
  else extension.appendChild(replacement);
  return command.affectedElements || [];
}

export function applyConcreteAccommodationExtensionCommand(
  document,
  _nodeMap,
  command,
  direction = 'after',
) {
  if (command?.type !== 'upsertConcreteAccommodationExtension') {
    throw new Error('ConcreteAccommodationExtensionCommandではありません。');
  }
  if (direction === 'after') return applySnapshot(document, command, command.afterSnapshot);
  if (direction === 'before') return applySnapshot(document, command, command.beforeSnapshot);
  throw new Error(`未対応のCommand適用方向です: ${direction}`);
}

export const _concreteAccommodationExtensionCommandInternals = Object.freeze({
  extensionContainer,
  findCandidateObject,
  snapshotElement,
});
