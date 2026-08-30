/**
 * @fileoverview 既存の階・通り芯への節点後追い紐づけ
 *
 * 既存の StbStory / StbParallelAxis / StbArcAxis / StbRadialAxis へ節点を後から紐づける。
 * Undo（追加した StbNodeId の除去）は `editAppliers.unlinkNodesFromDocument` が担当する。
 */

import { eventBus, EditEvents } from '../../../../data/events/index.js';
import { getState } from '../../../../data/state/globalState.js';
import { showSuccess } from '../../../common/toast.js';
import { normalizeNodeIds, findDirectChild } from './domHelpers.js';
import { updateEditingSummary } from './editHistory.js';
import { getModifications } from './editState.js';

/** 節点紐づけ対象タイプ → XML タグ名（既存の階・通り芯への後追い紐づけで使用） */
const NODE_LINK_TAGS = {
  Story: 'StbStory',
  Axis: 'StbParallelAxis',
  ArcAxis: 'StbArcAxis',
  RadialAxis: 'StbRadialAxis',
};

/**
 * 後追い紐づけの対象になる既存要素（階・各種通り芯）の一覧を取得する（UI のセレクト用）。
 * 通り芯は所属グループ名を併記してラベル化する。
 * @param {string} elementType - 'Story' | 'Axis' | 'ArcAxis' | 'RadialAxis'
 * @returns {Array<{id: string, label: string}>}
 */
export function getNodeLinkTargets(elementType) {
  const tagName = NODE_LINK_TAGS[elementType];
  const doc = getState('models.documentA');
  if (!tagName || !doc) return [];
  const result = [];
  for (const el of doc.querySelectorAll(tagName)) {
    const id = el.getAttribute('id');
    if (!id) continue;
    const name = el.getAttribute('name') || '';
    const groupName =
      elementType === 'Story' ? '' : el.parentNode?.getAttribute?.('group_name') || '';
    const parts = [name, groupName ? `(${groupName})` : ''].filter(Boolean).join(' ');
    result.push({ id, label: parts ? `#${id} ${parts}` : `#${id}` });
  }
  return result.sort((a, b) => Number(a.id) - Number(b.id));
}

/**
 * 既存の階・通り芯（StbStory/StbParallelAxis/StbArcAxis/StbRadialAxis）へ節点を後追いで紐づける。
 * 対象要素の StbNodeIdList（無ければ生成）へ未登録の節点のみ StbNodeId を追加する（xs:key の重複を防ぐ）。
 * 履歴には {op:'linkNodes', addedNodeIds} を記録し、Undo で追加分のみ取り消す。
 * @param {string} elementType - 'Story' | 'Axis' | 'ArcAxis' | 'RadialAxis'
 * @param {string} elementId - 対象要素の id
 * @param {string[]|string} nodeIdsInput - 紐づける節点ID（配列またはスペース区切り）
 * @returns {{success: boolean, added: number, error?: string}}
 */
export function linkNodesToExisting(elementType, elementId, nodeIdsInput) {
  const tagName = NODE_LINK_TAGS[elementType];
  if (!tagName) {
    return { success: false, added: 0, error: `未対応の紐づけ対象: ${elementType}` };
  }
  const doc = getState('models.documentA');
  if (!doc) {
    return { success: false, added: 0, error: 'モデルAが読み込まれていません' };
  }
  const target = doc.querySelector(`${tagName}[id="${String(elementId).replace(/"/g, '\\"')}"]`);
  if (!target) {
    return { success: false, added: 0, error: `対象要素が見つかりません: ${tagName}#${elementId}` };
  }

  const requested = normalizeNodeIds(nodeIdsInput);
  if (requested.length === 0) {
    return { success: false, added: 0, error: '紐づける節点を指定してください' };
  }
  // 存在しない節点は拒否する
  const missing = requested.filter(
    (nid) => !doc.querySelector(`StbNode[id="${nid.replace(/"/g, '\\"')}"]`),
  );
  if (missing.length > 0) {
    return { success: false, added: 0, error: `節点 #${missing.join(', #')} が存在しません` };
  }

  const ns = target.namespaceURI;
  let listEl = findDirectChild(target, 'StbNodeIdList');
  if (!listEl) {
    listEl = ns ? doc.createElementNS(ns, 'StbNodeIdList') : doc.createElement('StbNodeIdList');
    target.appendChild(listEl);
  }
  const existing = new Set(
    Array.from(listEl.getElementsByTagName('StbNodeId'))
      .map((el) => el.getAttribute('id'))
      .filter(Boolean),
  );
  const toAdd = requested.filter((nid) => !existing.has(nid));
  if (toAdd.length === 0) {
    return { success: false, added: 0, error: '指定した節点はすべて既に紐づけ済みです' };
  }
  for (const nid of toAdd) {
    const idEl = ns ? doc.createElementNS(ns, 'StbNodeId') : doc.createElement('StbNodeId');
    idEl.setAttribute('id', nid);
    listEl.appendChild(idEl);
  }

  getModifications().push({
    op: 'linkNodes',
    elementType,
    id: String(elementId),
    tagName,
    addedNodeIds: toAdd,
  });

  eventBus.emit(EditEvents.ATTRIBUTE_CHANGED, {
    elementType,
    elementId: String(elementId),
    attributeName: null,
    oldValue: null,
    newValue: null,
    modelSource: 'modelA',
    timestamp: Date.now(),
  });

  updateEditingSummary();
  showSuccess(`${tagName} #${elementId} に節点 ${toAdd.length}件を紐づけました`);
  return { success: true, added: toAdd.length };
}
