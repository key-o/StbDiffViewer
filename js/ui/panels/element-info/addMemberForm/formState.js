/**
 * @fileoverview 新規部材追加フォームの共有可変状態とモデル由来データのキャッシュ
 *
 * 断面は ST-Bridge の要素種別ごとに id が一意であり、異なる断面ルート間では同じ id を持てる。
 * そのため UI キャッシュでは id だけでなく tag を必ず保持する。
 *
 * @module ui/panels/element-info/addMemberForm/formState
 */

import editDocumentProvider from '../../../../app/editing/editDocumentProvider.js';
import { MEMBER_SECTION_CONFIG } from './fieldDefs.js';

export const formState = {
  cachedNodeIds: [],
  cachedSections: [],
  panelNodeIds: [],
};

export function refreshModelData(elementType) {
  formState.cachedNodeIds = getNodeIds();
  formState.cachedSections = getMemberSections(elementType);
}

function getNodeIds() {
  const doc = editDocumentProvider.getActiveEditDocument();
  if (!doc) return [];
  const ids = [];
  for (const node of doc.querySelectorAll('StbNode')) {
    const id = node.getAttribute('id');
    if (id) ids.push(id);
  }
  return ids.sort((a, b) => Number(a) - Number(b));
}

/**
 * 断面ルート要素から、部材の kind_structure に対応する値を返す。
 * @param {string} tagName
 * @returns {string|null}
 */
export function structureForSectionTag(tagName) {
  const exact = {
    StbSecSlabDeck: 'DECK',
    StbSecSlabPrecast: 'PRECAST',
    StbSecSlabLoad: 'LOAD',
    StbSecWallLoad: 'LOAD',
    StbSecPileProduct: 'PC',
    StbSecUndefined: 'UNDEFINED',
  };
  if (exact[tagName]) return exact[tagName];

  const match = String(tagName || '').match(
    /^StbSec(?:Column|Beam|Brace|Slab|Wall|Foundation|Pile|Parapet)_([A-Z]+)(?:_|$)/,
  );
  return match ? match[1] : null;
}

/**
 * active edit document から指定部材タイプが参照可能な断面を取得する。
 * @returns {Array<{id:string,tag:string,name:string,structure:string|null}>}
 */
function getMemberSections(elementType) {
  const config = MEMBER_SECTION_CONFIG[elementType];
  const doc = editDocumentProvider.getActiveEditDocument();
  if (!config || !doc) return [];
  const sections = doc.querySelector('StbSections');
  if (!sections) return [];

  const allowedRoots = new Set(config.roots || []);
  const result = [];
  for (const child of sections.children) {
    if (!allowedRoots.has(child.tagName)) continue;
    const id = child.getAttribute('id');
    if (!id) continue;
    result.push({
      id,
      tag: child.tagName,
      name: child.getAttribute('name') || '',
      structure: structureForSectionTag(child.tagName),
    });
  }

  return result.sort((a, b) => {
    const rootDiff = (config.roots || []).indexOf(a.tag) - (config.roots || []).indexOf(b.tag);
    if (rootDiff !== 0) return rootDiff;
    return Number(a.id) - Number(b.id);
  });
}

/**
 * 断面IDから構造種別を引く。
 * tagName を渡した場合は id+tag で一意に特定する。tagName なしで同じ id が複数種別に存在する場合は null。
 */
export function structureForSection(sectionId, tagName = null) {
  const id = String(sectionId);
  const matches = formState.cachedSections.filter(
    (section) => section.id === id && (!tagName || section.tag === tagName),
  );
  if (matches.length !== 1) return null;
  return matches[0].structure || null;
}
