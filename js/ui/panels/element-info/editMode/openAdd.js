/**
 * @fileoverview 壁・床開口の新規作成と割当
 *
 * ST-Bridge 2.0.2:
 *   StbMembers > StbOpens > StbOpen と、対象 StbWall / StbSlab の
 *   StbOpenIdList > StbOpenId を同時に生成する。
 * ST-Bridge 2.1.x:
 *   StbMembers > StbOpenArrangements > StbOpenArrangement に
 *   kind_member / id_member を直接保持する。
 */

import { detectStbVersion } from '../../../../common-stb/import/parser/utils/stbVersionDetection.js';
import { getState } from '../../../../data/state/globalState.js';
import { showSuccess } from '../../../common/toast.js';
import { generateNextId, findDirectChild, emitStructuralChange } from './domHelpers.js';
import { updateEditingSummary } from './editHistory.js';
import { getModifications } from './editState.js';

const PANEL_TAGS = new Set(['StbWall', 'StbSlab']);
const OPEN_202_ATTRS = [
  'name',
  'id_section',
  'position_X',
  'position_Y',
  'length_X',
  'length_Y',
  'rotate',
];
const OPEN_21_ATTRS = ['name', 'id_section', 'position_X', 'position_Y', 'rotate'];

function selectorById(tagName, id) {
  return `${tagName}[id="${String(id).replace(/"/g, '\\"')}"]`;
}

function is21(version) {
  return String(version || '').startsWith('2.1');
}

function validateReferences(doc, panelTag, panelId, attrs, version) {
  if (!PANEL_TAGS.has(panelTag)) return '開口の割当先は壁または床を指定してください';
  const panel = doc.querySelector(selectorById(panelTag, panelId));
  if (!panel) return `${panelTag} #${panelId} が見つかりません`;

  if (is21(version) && !attrs.id_section) {
    return 'ST-Bridge 2.1.x の開口には StbSecOpen_RC の指定が必要です';
  }
  if (attrs.id_section) {
    const section = doc.querySelector(selectorById('StbSecOpen_RC', attrs.id_section));
    if (!section) return `開口補強断面 StbSecOpen_RC #${attrs.id_section} が見つかりません`;
  }

  const required = is21(version)
    ? ['position_X', 'position_Y', 'rotate']
    : ['position_X', 'position_Y', 'length_X', 'length_Y', 'rotate'];
  for (const attr of required) {
    if (attrs[attr] === undefined || attrs[attr] === null || String(attrs[attr]).trim() === '') {
      return `必須項目が未入力です: ${attr}`;
    }
  }

  const numeric = is21(version)
    ? ['position_X', 'position_Y', 'rotate']
    : ['position_X', 'position_Y', 'length_X', 'length_Y', 'rotate'];
  for (const attr of numeric) {
    if (!Number.isFinite(Number(attrs[attr]))) return `${attr} は数値で入力してください`;
  }
  if (!is21(version) && (Number(attrs.length_X) <= 0 || Number(attrs.length_Y) <= 0)) {
    return '開口寸法 length_X / length_Y は0より大きい値を指定してください';
  }
  return null;
}

function getMembers(doc) {
  return doc.querySelector('StbModel > StbMembers');
}

/** StbMembers直下に開口コンテナをXSD順で確保する。 */
function ensureOpenContainer(doc, containerName) {
  const members = getMembers(doc);
  if (!members) return null;
  let container = findDirectChild(members, containerName);
  if (container) return container;

  const ns = members.namespaceURI;
  container = ns ? doc.createElementNS(ns, containerName) : doc.createElement(containerName);

  if (containerName === 'StbOpenArrangements') {
    const laterTags = new Set([
      'StbPenetrationArrangements',
      'StbJointArrangements',
      'StbPanelZoneArrangements',
      'StbConnectionArrangements',
    ]);
    const before = Array.from(members.children || []).find((child) => laterTags.has(child.tagName));
    if (before) members.insertBefore(container, before);
    else members.appendChild(container);
  } else {
    // 2.0.2 の StbOpens は StbMembers の末尾要素。
    members.appendChild(container);
  }
  return container;
}

function appendOpenReference(doc, panel, openId) {
  const ns = panel.namespaceURI;
  let list = findDirectChild(panel, 'StbOpenIdList');
  if (!list) {
    list = ns ? doc.createElementNS(ns, 'StbOpenIdList') : doc.createElement('StbOpenIdList');
    panel.appendChild(list);
  }

  const duplicate = Array.from(list.children || []).some(
    (child) => child.tagName === 'StbOpenId' && child.getAttribute('id') === String(openId),
  );
  if (duplicate) return false;

  const ref = ns ? doc.createElementNS(ns, 'StbOpenId') : doc.createElement('StbOpenId');
  ref.setAttribute('id', String(openId));
  list.appendChild(ref);
  return true;
}

function createElementWithAttrs(doc, container, tagName, id, attrs, allowedAttrs) {
  const ns = container.namespaceURI;
  const element = ns ? doc.createElementNS(ns, tagName) : doc.createElement(tagName);
  element.setAttribute('id', id);
  for (const attr of allowedAttrs) {
    const value = attrs[attr];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    element.setAttribute(attr, String(value));
  }
  return element;
}

function addOpen202(doc, panel, panelTag, panelId, attrs) {
  const container = ensureOpenContainer(doc, 'StbOpens');
  if (!container) return { success: false, id: null, error: 'StbMembers が見つかりません' };

  const id = generateNextId(doc, 'StbOpen');
  const open = createElementWithAttrs(doc, container, 'StbOpen', id, attrs, OPEN_202_ATTRS);
  container.appendChild(open);
  if (!appendOpenReference(doc, panel, id)) {
    open.remove();
    if (container.children.length === 0) container.remove();
    return { success: false, id: null, error: '開口参照の追加に失敗しました' };
  }

  return { success: true, id, tagName: 'StbOpen' };
}

function addOpen21(doc, panelTag, panelId, attrs) {
  const container = ensureOpenContainer(doc, 'StbOpenArrangements');
  if (!container) return { success: false, id: null, error: 'StbMembers が見つかりません' };

  const id = generateNextId(doc, 'StbOpenArrangement');
  const arrangementAttrs = {
    ...attrs,
    kind_member: panelTag === 'StbWall' ? 'WALL' : 'SLAB',
    id_member: String(panelId),
  };
  const arrangement = createElementWithAttrs(
    doc,
    container,
    'StbOpenArrangement',
    id,
    arrangementAttrs,
    [...OPEN_21_ATTRS, 'kind_member', 'id_member'],
  );
  container.appendChild(arrangement);
  return { success: true, id, tagName: 'StbOpenArrangement' };
}

/**
 * 開口を作成し、指定した壁または床へ同時に割り当てる。
 * モデルAのST-Bridgeバージョンに応じて正規のXML表現を選ぶ。
 * @param {{panelTag:'StbWall'|'StbSlab',panelId:string,attrs:Object<string,string>}} input
 * @returns {{success:boolean,id:string|null,tagName?:string,error?:string}}
 */
export function addOpenWithAssignment({ panelTag, panelId, attrs = {} }) {
  const doc = getState('models.documentA');
  if (!doc) return { success: false, id: null, error: 'モデルAが読み込まれていません' };

  const version = detectStbVersion(doc);
  const refError = validateReferences(doc, panelTag, panelId, attrs, version);
  if (refError) return { success: false, id: null, error: refError };

  const panel = doc.querySelector(selectorById(panelTag, panelId));
  const result = is21(version)
    ? addOpen21(doc, panelTag, panelId, attrs)
    : addOpen202(doc, panel, panelTag, panelId, attrs);
  if (!result.success) return result;

  const elementType = result.tagName === 'StbOpenArrangement' ? 'OpenArrangement' : 'Open';
  getModifications().push({
    op: 'addOpen',
    elementType,
    id: result.id,
    tagName: result.tagName,
    panelTag,
    panelId: String(panelId),
  });

  emitStructuralChange(elementType, result.id);
  emitStructuralChange(panelTag === 'StbWall' ? 'Wall' : 'Slab', String(panelId));
  updateEditingSummary();
  showSuccess(
    `${result.tagName} #${result.id} を${panelTag === 'StbWall' ? '壁' : '床'} #${panelId}へ割り当てました`,
  );
  return result;
}
