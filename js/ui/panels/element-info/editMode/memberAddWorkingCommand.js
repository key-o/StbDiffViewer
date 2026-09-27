/**
 * @fileoverview 新規部材追加UIを Working Document Command へ接続する Phase 5 adapter。
 *
 * Working Session 未開始時は従来の documentA mutation を維持する。
 * Working Session 中は source documentA を一切変更せず、detached XML 要素から
 * AddElementCommand を生成して EditingSession の共通履歴・Undo/Redoへ載せる。
 */

import { detectStbVersion } from '../../../../common-stb/import/parser/utils/stbVersionDetection.js';
import { getViewerWallElementType } from '../../../../common-stb/walls/wallClassification.js';
import { createAddElementCommand } from '../../../../app/editing/addElementCommand.js';
import editingSession from '../../../../app/editing/editingSession.js';
import { showSuccess } from '../../../common/toast.js';
import { generateNextId, normalizeNodeIds } from './domHelpers.js';
import { addNewMember as addLegacyNewMember, getNewMemberDefinitions } from './memberAdd.js';

function workingUnsupportedReason(def) {
  if (def?.axisGroup === true || def?.nodeIdList === true) {
    return `Working Session 中の ${def?.tagName || '要素'} 追加は Working structural lifecycle 未接続のため実行できません。`;
  }
  if (!Array.isArray(def?.container) || def.container.length === 0) {
    return `Working Session 中の ${def?.tagName || '要素'} 追加先を解決できません。`;
  }
  return null;
}

function assertPolygonNodes(document, nodeIds) {
  if (nodeIds.length < 3 || new Set(nodeIds).size < 3) {
    throw new Error('面材には重複しない3点以上の節点が必要です');
  }
  for (const nodeId of nodeIds) {
    const exists = [...document.getElementsByTagName('StbNode')].some(
      (node) => String(node.getAttribute('id')) === String(nodeId),
    );
    if (!exists) throw new Error(`面材の節点 StbNode #${nodeId} が Working Document にありません`);
  }
}

function createDetachedElement(document, def, attrs) {
  const model = document?.querySelector?.('StbModel');
  if (!model) {
    throw new Error('StbModel が見つかりません');
  }

  const missing = def.required.filter((key) => {
    const value = attrs[key];
    return value === undefined || value === null || String(value).trim() === '';
  });
  if (missing.length > 0) {
    throw new Error(`必須項目が未入力です: ${missing.join(', ')}`);
  }

  const namespaceURI = model.namespaceURI;
  const element = namespaceURI
    ? document.createElementNS(namespaceURI, def.tagName)
    : document.createElement(def.tagName);
  const id = generateNextId(document, def.tagName);
  element.setAttribute('id', id);

  const merged = { ...def.defaults, ...attrs };
  const version = detectStbVersion(document);
  const is21x = version === '2.1.0' || version === '2.1.1';
  if (def.hasName && !is21x && !String(merged.name ?? '').trim()) {
    merged.name = `${def.tagName.replace(/^Stb/, '')}${id}`;
  }

  const groupFieldKeys = new Set((def.groupAttrFields || []).map((field) => field.field));
  for (const [key, value] of Object.entries(merged)) {
    if (key === 'node_ids' || key === 'group' || groupFieldKeys.has(key)) continue;
    if (value === undefined || value === null || String(value).trim() === '') continue;
    element.setAttribute(key, String(value));
  }

  if (def.nodeList === true) {
    const nodeIds = normalizeNodeIds(attrs.node_ids);
    assertPolygonNodes(document, nodeIds);
    const order = namespaceURI
      ? document.createElementNS(namespaceURI, 'StbNodeIdOrder')
      : document.createElement('StbNodeIdOrder');
    order.textContent = nodeIds.join(' ');
    element.appendChild(order);
  }

  return { element, id };
}

function resolveWorkingElementType(elementType, element) {
  return element?.tagName === 'StbWall' ? getViewerWallElementType(element) : elementType;
}

/**
 * AddMemberForm の public entry point。
 *
 * @param {string} elementType NEW_MEMBER_DEFINITIONS key
 * @param {Object<string,string|string[]>} attrs
 * @returns {{success:boolean,id:string|null,error?:string}}
 */
export function addNewMember(elementType, attrs = {}) {
  if (editingSession.getState()?.active !== true) {
    return addLegacyNewMember(elementType, attrs);
  }

  const def = getNewMemberDefinitions()[elementType];
  if (!def) {
    return { success: false, id: null, error: `未対応の部材タイプ: ${elementType}` };
  }

  const unsupported = workingUnsupportedReason(def);
  if (unsupported) {
    return { success: false, id: null, error: unsupported };
  }

  const workingDocument = editingSession.getWorkingDocument();
  if (!workingDocument) {
    return { success: false, id: null, error: 'Working Document がありません' };
  }

  try {
    const { element, id } = createDetachedElement(workingDocument, def, attrs);
    const workingElementType = resolveWorkingElementType(elementType, element);
    const command = createAddElementCommand(workingDocument, element, {
      parentPath: def.container,
      elementType: workingElementType,
      affectedElements: [{ elementType: workingElementType, elementId: String(id) }],
      label: `${def.tagName} #${id} を追加`,
    });
    editingSession.executeCommand(command, { reason: 'addMember' });
    showSuccess(`${def.tagName} #${id} を追加しました`);
    return { success: true, id };
  } catch (error) {
    return {
      success: false,
      id: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export { getNewMemberDefinitions };
