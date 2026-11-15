/** @fileoverview RCスラブの頂点別STB offsetを可逆に編集するCommand。 */

import { child, descendants, tag } from './memberJoinGeometry.js';

function createElement(document, owner, name) {
  return owner.namespaceURI
    ? document.createElementNS(owner.namespaceURI, name)
    : document.createElement(name);
}

function resolveSlab(document, slabId) {
  const matches = descendants(document, 'StbSlab').filter(
    (item) => item.getAttribute('id') === String(slabId),
  );
  if (matches.length !== 1) throw new Error(`StbSlab:${slabId} が一意に見つかりません`);
  return matches[0];
}

function buildAfterSnapshot(document, slab, offsets) {
  const order = child(slab, 'StbNodeIdOrder');
  const nodeIds = (order?.textContent || '').trim().split(/\s+/).filter(Boolean);
  if (nodeIds.length < 3 || new Set(nodeIds).size !== nodeIds.length) {
    throw new Error('スラブ節点列が不正です');
  }
  const known = new Set(nodeIds);
  const prior = child(slab, 'StbSlabOffsetList');
  const list = prior ? prior.cloneNode(true) : createElement(document, slab, 'StbSlabOffsetList');
  const items = new Map();
  for (const item of Array.from(list.children || [])) {
    if (tag(item) !== 'StbSlabOffset') throw new Error('未対応のスラブoffset子要素があります');
    const id = item.getAttribute('id_node');
    if (!known.has(id) || items.has(id))
      throw new Error('スラブoffset節点が不正または重複しています');
    items.set(id, item);
  }
  for (const [id, values] of Object.entries(offsets)) {
    if (!known.has(id))
      throw new Error(`スラブ${slab.getAttribute('id')}に節点${id}は存在しません`);
    let item = items.get(id);
    if (!item) {
      item = createElement(document, list, 'StbSlabOffset');
      item.setAttribute('id_node', id);
      list.appendChild(item);
      items.set(id, item);
    }
    for (const axis of ['X', 'Y', 'Z']) {
      const key = `offset_${axis}`;
      const value = values?.[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`StbSlabOffset.${key} は有限数が必要です`);
      }
      item.setAttribute(key, String(value));
    }
  }
  return list;
}

export function createSetSlabNodeOffsetsCommand(document, slabId, offsets) {
  if (!offsets || Object.keys(offsets).length === 0) throw new Error('スラブoffset指定が空です');
  const slab = resolveSlab(document, slabId);
  const before = child(slab, 'StbSlabOffsetList')?.cloneNode(true) || null;
  const after = buildAfterSnapshot(document, slab, offsets);
  return {
    type: 'setSlabNodeOffsets',
    label: `スラブ ${slabId} のRC梁取り合いoffsetを変更`,
    slabId: String(slabId),
    before,
    after,
    isNoop: before?.outerHTML === after.outerHTML,
    affectedElements: [{ elementType: 'Slab', elementId: String(slabId) }],
  };
}

export function applySetSlabNodeOffsetsCommand(document, _nodeMap, command, direction = 'after') {
  if (command?.type !== 'setSlabNodeOffsets' || !['before', 'after'].includes(direction)) {
    throw new Error('スラブoffset Commandが不正です');
  }
  const slab = resolveSlab(document, command.slabId);
  const current = child(slab, 'StbSlabOffsetList');
  const snapshot = command[direction];
  if (!snapshot) {
    if (current) slab.removeChild(current);
    return command.affectedElements;
  }
  const copy = document.importNode ? document.importNode(snapshot, true) : snapshot.cloneNode(true);
  if (current) slab.replaceChild(copy, current);
  else {
    const order = child(slab, 'StbNodeIdOrder');
    if (order?.nextSibling) slab.insertBefore(copy, order.nextSibling);
    else slab.appendChild(copy);
  }
  return command.affectedElements;
}
