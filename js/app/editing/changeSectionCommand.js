/**
 * @fileoverview Working Document 上の部材断面参照を可逆に変更する Command。
 *
 * ST-Bridge の断面 ID は断面要素種別ごとに一意であり、異なる断面タグ間では同じ数値 ID が
 * 存在し得る。そのため ID だけで断面を選ばず、部材タグと kind_structure から許可される
 * 断面タグを絞り込んでから参照先を確定する。
 */

import {
  applyNullableAttributeValue,
  findElementByTagAndId,
  resolveAttributeTarget,
  viewerElementTypeFromElement,
} from './attributeCommandUtils.js';

const COLUMN_SECTIONS = Object.freeze({
  RC: ['StbSecColumn_RC'],
  S: ['StbSecColumn_S'],
  SRC: ['StbSecColumn_SRC'],
  CFT: ['StbSecColumn_CFT'],
  UNDEFINED: ['StbSecUndefined'],
});

const BEAM_SECTIONS = Object.freeze({
  RC: ['StbSecBeam_RC'],
  S: ['StbSecBeam_S'],
  SRC: ['StbSecBeam_SRC'],
  UNDEFINED: ['StbSecUndefined'],
});

const GIRDER_SECTIONS = Object.freeze({
  RC: ['StbSecBeam_RC', 'StbSecGirder_RC'],
  S: ['StbSecBeam_S', 'StbSecGirder_S'],
  SRC: ['StbSecBeam_SRC', 'StbSecGirder_SRC'],
  UNDEFINED: ['StbSecUndefined'],
});

const MEMBER_SECTION_TAGS = Object.freeze({
  StbColumn: COLUMN_SECTIONS,
  StbPost: COLUMN_SECTIONS,
  StbGirder: GIRDER_SECTIONS,
  StbBeam: BEAM_SECTIONS,
  StbBrace: Object.freeze({ S: ['StbSecBrace_S'], UNDEFINED: ['StbSecUndefined'] }),
  StbSlab: Object.freeze({
    RC: ['StbSecSlab_RC'],
    DECK: ['StbSecSlabDeck'],
    PRECAST: ['StbSecSlabPrecast'],
    UNDEFINED: ['StbSecUndefined'],
  }),
  StbWall: Object.freeze({ RC: ['StbSecWall_RC'], UNDEFINED: ['StbSecUndefined'] }),
  StbFooting: Object.freeze({ '*': ['StbSecFoundation_RC'] }),
  StbStripFooting: Object.freeze({
    RC: ['StbSecFoundation_RC'],
    UNDEFINED: ['StbSecUndefined'],
  }),
  StbPile: Object.freeze({
    RC: ['StbSecPile_RC'],
    S: ['StbSecPile_S'],
    PC: ['StbSecPileProduct'],
    UNDEFINED: ['StbSecUndefined'],
  }),
  StbParapet: Object.freeze({
    RC: ['StbSecParapet_RC'],
    UNDEFINED: ['StbSecUndefined'],
  }),
});

const FOUNDATION_COLUMN_SECTION_ATTRIBUTES = new Set(['id_section_FD', 'id_section_WR']);

function allowedSectionTags(member, attributeName) {
  if (member.tagName === 'StbFoundationColumn') {
    if (!FOUNDATION_COLUMN_SECTION_ATTRIBUTES.has(attributeName)) {
      throw new Error(
        `StbFoundationColumn の断面変更属性は id_section_FD / id_section_WR のみです: ${attributeName}`,
      );
    }
    return ['StbSecColumn_RC'];
  }

  if (attributeName !== 'id_section') {
    throw new Error(`${member.tagName} の断面変更属性は id_section のみです: ${attributeName}`);
  }

  const byKind = MEMBER_SECTION_TAGS[member.tagName];
  if (!byKind) throw new Error(`${member.tagName} は ChangeSectionCommand の対象ではありません。`);

  const kind = member.getAttribute('kind_structure') || '*';
  const tags = byKind[kind] || byKind['*'];
  if (!tags || tags.length === 0) {
    throw new Error(`${member.tagName} kind_structure="${kind}" に対応する断面種別がありません。`);
  }
  return tags;
}

function findCompatibleSections(document, sectionId, tagNames) {
  const matches = [];
  for (const tagName of tagNames) {
    const section = findElementByTagAndId(document, tagName, sectionId);
    if (section) matches.push(section);
  }
  return matches;
}

function findAnySectionTagsById(document, sectionId) {
  const sectionsRoot = document?.getElementsByTagName('StbSections')?.[0] || null;
  if (!sectionsRoot) return [];
  const targetId = String(sectionId);
  return [...sectionsRoot.children]
    .filter((child) => String(child.getAttribute?.('id')) === targetId)
    .map((child) => child.tagName);
}

export function createChangeSectionCommand(
  document,
  elementType,
  elementId,
  nextSectionId,
  options = {},
) {
  const target = resolveAttributeTarget(document, { elementType, elementId });
  const viewerElementType = viewerElementTypeFromElement(target.element);
  if (!viewerElementType) {
    throw new Error(`${target.anchorTagName} は部材断面変更の対象ではありません。`);
  }

  const attributeName = options.attributeName || 'id_section';
  const after = String(nextSectionId ?? '').trim();
  if (!after) throw new Error('変更先の断面 ID が指定されていません。');

  const allowedTags = allowedSectionTags(target.element, attributeName);
  const compatible = findCompatibleSections(document, after, allowedTags);
  if (compatible.length === 0) {
    const existingTags = findAnySectionTagsById(document, after);
    if (existingTags.length > 0) {
      throw new Error(
        `断面 ID ${after} は ${existingTags.join(', ')} に存在しますが、${target.anchorTagName} から参照できません。`,
      );
    }
    throw new Error(`断面 ID ${after} が Working Document に見つかりません。`);
  }
  if (compatible.length > 1) {
    throw new Error(
      `断面 ID ${after} が参照可能な複数断面に一致しました: ${compatible.map((section) => section.tagName).join(', ')}`,
    );
  }

  const before = target.element.hasAttribute(attributeName)
    ? target.element.getAttribute(attributeName)
    : null;

  return {
    type: 'changeSection',
    label: options.label || `${target.anchorTagName} ${target.anchorId} の断面を ${after} に変更`,
    target: { elementType: target.anchorTagName, elementId: String(target.anchorId) },
    locator: { elementType, elementId: String(elementId) },
    attributeName,
    before,
    after,
    sectionTagName: compatible[0].tagName,
    isNoop: before === after,
    affectedElements: [{ elementType: viewerElementType, elementId: String(target.anchorId) }],
  };
}

export function applyChangeSectionCommand(document, _nodeMap, command, direction = 'after') {
  if (!command || command.type !== 'changeSection') {
    throw new Error('changeSection Command が指定されていません。');
  }

  const target = resolveAttributeTarget(document, command.locator || {});
  const value = direction === 'before' ? command.before : command.after;
  applyNullableAttributeValue(target.element, command.attributeName, value);
  return command.affectedElements || [];
}
