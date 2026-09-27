/**
 * @fileoverview Working Document 上の単一属性を可逆に変更する Command。
 *
 * id 属性は参照追従を伴うため対象外とし、専用 Renumber Command へ委譲する。
 * Node.X/Y/Z は XML と workingNodeMap を同時に更新し、既存 Node geometry sync が
 * 利用できる full-position change metadata を保持する。
 */

import { getViewerWallElementType } from '../../common-stb/walls/wallClassification.js';
import {
  applyNullableAttributeValue,
  normalizeNullableAttributeValue,
  readFiniteNodePosition,
  resolveAffectedElementsForAnchor,
  resolveAttributeTarget,
  toFiniteNumber,
  writeNodeMapPosition,
} from './attributeCommandUtils.js';

const NODE_COORDINATE_KEYS = Object.freeze({ X: 'x', Y: 'y', Z: 'z' });

function positionsEqual(a, b) {
  return a?.x === b?.x && a?.y === b?.y && a?.z === b?.z;
}

function assertViewerIdentityTransitionSupported(target, attributeName, before, after) {
  if (target.anchorTagName !== 'StbWall' || attributeName !== 'kind_wall' || before === after) {
    return;
  }

  const beforeType = getViewerWallElementType({ kind_wall: before });
  const afterType = getViewerWallElementType({ kind_wall: after });
  if (beforeType !== afterType) {
    throw new Error(
      `StbWall.kind_wall の変更で Viewer identity が ${beforeType} → ${afterType} に変わります。` +
        'Wall / ShearWall 間の scene group 移送は専用 reclassification Command が必要なため、現在は変更できません。',
    );
  }
}

function createNodeChange(target, attributeName, afterValue) {
  if (target.anchorTagName !== 'StbNode' || !(attributeName in NODE_COORDINATE_KEYS)) return null;
  if (afterValue === null) {
    throw new Error(`StbNode.${attributeName} は必須座標のため削除できません。`);
  }

  const coordinate = toFiniteNumber(afterValue, `StbNode.${attributeName}`);
  if (coordinate === null) {
    throw new Error(`StbNode.${attributeName} は有限値で指定してください。`);
  }

  const before = readFiniteNodePosition(target.element);
  const after = { ...before, [NODE_COORDINATE_KEYS[attributeName]]: coordinate };
  return {
    nodeId: String(target.anchorId),
    before,
    after,
  };
}

export function createSetAttributeCommand(
  document,
  elementType,
  elementId,
  attributeName,
  nextValue,
  options = {},
) {
  const normalizedAttributeName = String(attributeName || '').trim();
  if (!normalizedAttributeName) throw new Error('属性名が指定されていません。');
  if (normalizedAttributeName === 'id') {
    throw new Error('id 属性は参照追従を伴うため SetAttributeCommand では変更できません。');
  }

  const locator = {
    elementType,
    elementId: String(elementId ?? ''),
    editPath: options.editPath || options.path || null,
  };
  const target = resolveAttributeTarget(document, locator);
  const before = target.element.hasAttribute(normalizedAttributeName)
    ? target.element.getAttribute(normalizedAttributeName)
    : null;
  const after = normalizeNullableAttributeValue(nextValue);
  assertViewerIdentityTransitionSupported(target, normalizedAttributeName, before, after);
  const nodeChange = createNodeChange(target, normalizedAttributeName, after);

  return {
    type: 'setAttribute',
    label:
      options.label ||
      `${target.anchorTagName} ${target.anchorId} の ${normalizedAttributeName} を変更`,
    target: {
      elementType: target.anchorTagName,
      elementId: String(target.anchorId),
      path: target.editPath,
    },
    locator,
    attributeName: normalizedAttributeName,
    before,
    after,
    nodeChange,
    isNoop: nodeChange ? positionsEqual(nodeChange.before, nodeChange.after) : before === after,
    affectedElements: resolveAffectedElementsForAnchor(
      document,
      target.anchorTagName,
      target.anchorId,
    ),
  };
}

export function applySetAttributeCommand(document, nodeMap, command, direction = 'after') {
  if (!command || command.type !== 'setAttribute') {
    throw new Error('setAttribute Command が指定されていません。');
  }

  const target = resolveAttributeTarget(document, command.locator || {});
  const value = direction === 'before' ? command.before : command.after;
  applyNullableAttributeValue(target.element, command.attributeName, value);

  if (command.nodeChange) {
    const position = direction === 'before' ? command.nodeChange.before : command.nodeChange.after;
    writeNodeMapPosition(nodeMap, command.nodeChange.nodeId, position);
  }

  return command.affectedElements || [];
}
