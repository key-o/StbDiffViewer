/**
 * @fileoverview Working Document 上の部材 offset 属性群を可逆に変更する Command。
 *
 * offset は Node 座標変更とは別の ST-Bridge semantic edit として扱う。
 * 複数 offset 属性は1 Command にまとめ、Undo / Redo でも同じ属性集合を原子的に戻す。
 */

import {
  applyNullableAttributeValue,
  resolveAttributeTarget,
  toFiniteNumber,
  viewerElementTypeFromTagName,
} from './attributeCommandUtils.js';

function normalizeOffsetValue(value, attributeName) {
  if (value === null || value === undefined || value === '') return null;
  const number = toFiniteNumber(value, attributeName);
  if (number === null) return null;
  return typeof value === 'string' ? value.trim() : String(number);
}

export function createSetMemberOffsetCommand(
  document,
  elementType,
  elementId,
  nextOffsets,
  options = {},
) {
  const target = resolveAttributeTarget(document, { elementType, elementId });
  const viewerElementType = viewerElementTypeFromTagName(target.anchorTagName);
  if (!viewerElementType) {
    throw new Error(`${target.anchorTagName} は部材 offset 編集の対象ではありません。`);
  }
  if (!nextOffsets || typeof nextOffsets !== 'object' || Array.isArray(nextOffsets)) {
    throw new Error('部材 offset 編集には属性値のオブジェクトが必要です。');
  }

  const attributes = Object.keys(nextOffsets);
  if (attributes.length === 0) {
    throw new Error('部材 offset 編集には1件以上の属性が必要です。');
  }

  const before = {};
  const after = {};
  for (const attributeName of attributes) {
    if (!/^offset(?:_|$)/.test(attributeName)) {
      throw new Error(`offset 属性ではありません: ${attributeName}`);
    }
    before[attributeName] = target.element.hasAttribute(attributeName)
      ? target.element.getAttribute(attributeName)
      : null;
    after[attributeName] = normalizeOffsetValue(
      nextOffsets[attributeName],
      `${target.anchorTagName}.${attributeName}`,
    );
  }

  return {
    type: 'setMemberOffset',
    label: options.label || `${target.anchorTagName} ${target.anchorId} の offset を変更`,
    target: { elementType: target.anchorTagName, elementId: String(target.anchorId) },
    locator: { elementType, elementId: String(elementId) },
    attributes,
    before,
    after,
    isNoop: attributes.every((attributeName) => before[attributeName] === after[attributeName]),
    affectedElements: [{ elementType: viewerElementType, elementId: String(target.anchorId) }],
  };
}

export function applySetMemberOffsetCommand(document, _nodeMap, command, direction = 'after') {
  if (!command || command.type !== 'setMemberOffset') {
    throw new Error('setMemberOffset Command が指定されていません。');
  }

  const target = resolveAttributeTarget(document, command.locator || {});
  const values = direction === 'before' ? command.before : command.after;
  for (const attributeName of command.attributes || []) {
    applyNullableAttributeValue(target.element, attributeName, values?.[attributeName] ?? null);
  }
  return command.affectedElements || [];
}
