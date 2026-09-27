/**
 * @fileoverview 編集影響範囲リゾルバー
 *
 * 編集された要素（節点・断面・部材）から、再比較・3D再描画が必要な
 * 部材タイプまたは具体要素をXMLドキュメントの逆引きで解決します。
 * - 節点編集 → その節点を参照する全部材
 * - 断面編集 → その断面を使用する全部材
 *
 * @module modelLoader/editImpactResolver
 */

import { STB_TAG_NAMES } from '../constants/elementTypes.js';
import { getViewerWallElementType } from '../common-stb/walls/wallClassification.js';

/** 部材XMLタグ名 → ビューア要素タイプ */
const MEMBER_TAG_TO_ELEMENT_TYPE = {
  [STB_TAG_NAMES.COLUMN]: 'Column',
  [STB_TAG_NAMES.POST]: 'Post',
  [STB_TAG_NAMES.GIRDER]: 'Girder',
  [STB_TAG_NAMES.BEAM]: 'Beam',
  [STB_TAG_NAMES.BRACE]: 'Brace',
  [STB_TAG_NAMES.SLAB]: 'Slab',
  [STB_TAG_NAMES.WALL]: 'Wall',
  [STB_TAG_NAMES.PARAPET]: 'Parapet',
  [STB_TAG_NAMES.JOINT]: 'Joint',
  // 開口は壁の描画に反映されるため Wall を再描画する
  [STB_TAG_NAMES.OPEN]: 'Wall',
  [STB_TAG_NAMES.PILE]: 'Pile',
  [STB_TAG_NAMES.FOOTING]: 'Footing',
  [STB_TAG_NAMES.STRIP_FOOTING]: 'StripFooting',
  [STB_TAG_NAMES.FOUNDATION_COLUMN]: 'FoundationColumn',
  [STB_TAG_NAMES.ISOLATING_DEVICE]: 'IsolatingDevice',
  [STB_TAG_NAMES.DAMPING_DEVICE]: 'DampingDevice',
  [STB_TAG_NAMES.FRAME_DAMPING_DEVICE]: 'FrameDampingDevice',
};

/** 部材が節点を参照する属性名（線状・点状要素） */
const NODE_REF_ATTRIBUTES = [
  'id_node_start',
  'id_node_end',
  'id_node_bottom',
  'id_node_top',
  'id_node',
];

/** 部材が断面を参照する属性名（FoundationColumn は FD/WR の2断面を持つ） */
const SECTION_REF_ATTRIBUTES = ['id_section', 'id_section_FD', 'id_section_WR'];

/**
 * 断面タグ → 参照可能な部材タグ / kind_structure。
 * ST-Bridge の断面 id は断面タグ種別ごとに一意であり、同じ数値 id が RC/S や柱/梁で
 * 同時に使われ得るため、断面編集の影響解決では tag と kind の双方を照合する。
 */
const SECTION_TAG_RULES = Object.freeze({
  StbSecColumn_RC: [
    { tagName: STB_TAG_NAMES.COLUMN, kinds: ['RC'] },
    { tagName: STB_TAG_NAMES.POST, kinds: ['RC'] },
    { tagName: STB_TAG_NAMES.FOUNDATION_COLUMN, kinds: null },
  ],
  StbSecColumn_S: [
    { tagName: STB_TAG_NAMES.COLUMN, kinds: ['S'] },
    { tagName: STB_TAG_NAMES.POST, kinds: ['S'] },
  ],
  StbSecColumn_SRC: [
    { tagName: STB_TAG_NAMES.COLUMN, kinds: ['SRC'] },
    { tagName: STB_TAG_NAMES.POST, kinds: ['SRC'] },
  ],
  StbSecColumn_CFT: [
    { tagName: STB_TAG_NAMES.COLUMN, kinds: ['CFT'] },
    { tagName: STB_TAG_NAMES.POST, kinds: ['CFT'] },
  ],
  StbSecGirder_RC: [{ tagName: STB_TAG_NAMES.GIRDER, kinds: ['RC'] }],
  StbSecGirder_S: [{ tagName: STB_TAG_NAMES.GIRDER, kinds: ['S'] }],
  StbSecGirder_SRC: [{ tagName: STB_TAG_NAMES.GIRDER, kinds: ['SRC'] }],
  StbSecBeam_RC: [
    { tagName: STB_TAG_NAMES.GIRDER, kinds: ['RC'] },
    { tagName: STB_TAG_NAMES.BEAM, kinds: ['RC'] },
  ],
  StbSecBeam_S: [
    { tagName: STB_TAG_NAMES.GIRDER, kinds: ['S'] },
    { tagName: STB_TAG_NAMES.BEAM, kinds: ['S'] },
  ],
  StbSecBeam_SRC: [
    { tagName: STB_TAG_NAMES.GIRDER, kinds: ['SRC'] },
    { tagName: STB_TAG_NAMES.BEAM, kinds: ['SRC'] },
  ],
  StbSecBrace_S: [{ tagName: STB_TAG_NAMES.BRACE, kinds: ['S'] }],
  StbSecSlab_RC: [{ tagName: STB_TAG_NAMES.SLAB, kinds: ['RC'] }],
  StbSecSlabDeck: [{ tagName: STB_TAG_NAMES.SLAB, kinds: ['DECK'] }],
  StbSecSlabPrecast: [{ tagName: STB_TAG_NAMES.SLAB, kinds: ['PRECAST'] }],
  StbSecWall_RC: [{ tagName: STB_TAG_NAMES.WALL, kinds: ['RC'] }],
  StbSecFoundation_RC: [
    { tagName: STB_TAG_NAMES.FOOTING, kinds: null },
    { tagName: STB_TAG_NAMES.STRIP_FOOTING, kinds: ['RC'] },
  ],
  StbSecPile_RC: [{ tagName: STB_TAG_NAMES.PILE, kinds: ['RC'] }],
  StbSecPile_S: [{ tagName: STB_TAG_NAMES.PILE, kinds: ['S'] }],
  StbSecPileProduct: [{ tagName: STB_TAG_NAMES.PILE, kinds: ['PC'] }],
  StbSecOpen_RC: [{ tagName: STB_TAG_NAMES.OPEN, kinds: null }],
  StbSecParapet_RC: [{ tagName: STB_TAG_NAMES.PARAPET, kinds: ['RC'] }],
  StbSecUndefined: Object.keys(MEMBER_TAG_TO_ELEMENT_TYPE).map((tagName) => ({
    tagName,
    kinds: ['UNDEFINED'],
  })),
});

/**
 * 属性セレクター用にIDをエスケープする（STBのidは通常数値だが防御的に処理）
 * @param {string} id
 * @returns {string}
 */
function escapeAttributeValue(id) {
  return String(id).replace(/["\\]/g, '\\$&');
}

/**
 * 要素から祖先方向に部材要素を探す。
 * StbWall は XML tag だけでは Viewer 上の Wall / ShearWall を決められないため、
 * kind_wall を canonical classifier で解決して返す。
 * @param {Element} element - 起点要素
 * @returns {{element: Element, elementType: string}|null}
 */
function findAncestorMember(element) {
  let current = element;
  while (current) {
    const mappedType = MEMBER_TAG_TO_ELEMENT_TYPE[current.tagName];
    if (mappedType) {
      const elementType =
        current.tagName === STB_TAG_NAMES.WALL ? getViewerWallElementType(current) : mappedType;
      return { element: current, elementType };
    }
    current = current.parentElement;
  }
  return null;
}

/**
 * 具体部材を一意な集合へ追加する。
 * @param {Element} element
 * @param {Map<string, {elementType: string, elementId: string}>} elements
 */
function collectAncestorMemberElement(element, elements) {
  const member = findAncestorMember(element);
  if (!member) return;

  const elementId = member.element.getAttribute('id');
  if (elementId === null || String(elementId).trim() === '') return;

  const normalizedId = String(elementId);
  const key = `${member.elementType}:${normalizedId}`;
  if (!elements.has(key)) {
    elements.set(key, { elementType: member.elementType, elementId: normalizedId });
  }
}

/**
 * セレクターに一致する要素の祖先部材を具体ID単位で収集する。
 * @param {Document} doc
 * @param {string} selector
 * @param {Map<string, {elementType: string, elementId: string}>} elements
 */
function collectElementsFromQuery(doc, selector, elements) {
  let matches = [];
  try {
    matches = doc.querySelectorAll(selector);
  } catch {
    return;
  }
  for (const el of matches) collectAncestorMemberElement(el, elements);
}

function sectionTagMatchesMember(sectionTagName, memberElement) {
  if (!sectionTagName) return true;
  const rules = SECTION_TAG_RULES[String(sectionTagName)];
  if (!rules) return true;

  const kind = memberElement.getAttribute('kind_structure');
  return rules.some(
    (rule) =>
      rule.tagName === memberElement.tagName &&
      (rule.kinds === null || rule.kinds.includes(String(kind || ''))),
  );
}

/**
 * EditMode の elementType が断面要素か判定する（'SecColumn_RC' 等）
 * @param {string} elementType
 * @returns {boolean}
 */
export function isSectionElementType(elementType) {
  return typeof elementType === 'string' && elementType.startsWith('Sec');
}

/**
 * 指定節点を参照する全部材を具体ID単位で逆引きする。
 *
 * StbNodeIdOrder を持つスラブ・壁だけでなく、ColumnViaNode / GirderViaNode のように
 * 子要素から参照される場合も祖先の部材IDへ正規化する。
 * @param {Document} doc - XMLドキュメント
 * @param {string} nodeId - 節点ID
 * @returns {Array<{elementType: string, elementId: string}>}
 */
export function resolveAffectedElementsForNode(doc, nodeId) {
  const elements = new Map();
  if (!doc || nodeId === null || nodeId === undefined || String(nodeId) === '') return [];

  const rawId = String(nodeId);
  const id = escapeAttributeValue(rawId);
  const selector = NODE_REF_ATTRIBUTES.map((attr) => `[${attr}="${id}"]`).join(', ');
  collectElementsFromQuery(doc, selector, elements);

  const orderElements = doc.getElementsByTagName('StbNodeIdOrder');
  for (const orderEl of orderElements) {
    const idList = (orderEl.textContent || '').trim().split(/\s+/).filter(Boolean);
    if (!idList.includes(rawId)) continue;
    collectAncestorMemberElement(orderEl, elements);
  }

  return [...elements.values()];
}

/**
 * 指定節点を参照する全部材のビューア要素タイプ集合を逆引きする
 * @param {Document} doc - XMLドキュメント
 * @param {string} nodeId - 節点ID
 * @returns {Set<string>} 影響を受ける要素タイプ集合（'Column' 等）
 */
export function resolveAffectedTypesForNode(doc, nodeId) {
  return new Set(resolveAffectedElementsForNode(doc, nodeId).map(({ elementType }) => elementType));
}

/**
 * 指定断面を参照する serializable な参照位置を返す。
 * Section ID は断面タグ種別ごとに一意なため、sectionTagName と member kind を照合して
 * 同じ数値 ID を持つ異種断面への参照を除外する。
 *
 * @param {Document} doc - XMLドキュメント
 * @param {string} sectionId - 断面ID
 * @param {string|null} [sectionTagName=null] - 断面XMLタグ名
 * @returns {Array<{tagName:string, elementId:string, attributeName:string}>}
 */
export function resolveSectionReferenceLocations(doc, sectionId, sectionTagName = null) {
  if (!doc || sectionId === null || sectionId === undefined || String(sectionId) === '') return [];

  const rawId = String(sectionId);
  const id = escapeAttributeValue(rawId);
  const selector = SECTION_REF_ATTRIBUTES.map((attr) => `[${attr}="${id}"]`).join(', ');
  let matches = [];
  try {
    matches = doc.querySelectorAll(selector);
  } catch {
    return [];
  }

  const result = [];
  const seen = new Set();
  for (const element of matches) {
    const member = findAncestorMember(element);
    if (!member) continue;
    if (!sectionTagMatchesMember(sectionTagName, member.element)) continue;
    const elementId = member.element.getAttribute('id');
    if (elementId === null || String(elementId).trim() === '') continue;

    for (const attributeName of SECTION_REF_ATTRIBUTES) {
      if (member.element.getAttribute(attributeName) !== rawId) continue;
      const location = {
        tagName: member.element.tagName,
        elementId: String(elementId),
        attributeName,
      };
      const key = `${location.tagName}:${location.elementId}:${location.attributeName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(location);
    }
  }
  return result;
}

/**
 * 指定断面を参照する全部材を具体ID単位で逆引きする。
 *
 * sectionTagName を指定した場合は、断面タグ・部材タグ・kind_structure の整合まで確認する。
 * これにより `StbSecColumn_RC id="1"` / `StbSecColumn_S id="1"` や
 * `StbSecColumn_RC id="1"` / `StbSecBeam_RC id="1"` の合法な ID 重複を分離する。
 *
 * @param {Document} doc - XMLドキュメント
 * @param {string} sectionId - 断面ID
 * @param {string|null} [sectionTagName=null] - 断面XMLタグ名
 * @returns {Array<{elementType: string, elementId: string}>}
 */
export function resolveAffectedElementsForSection(doc, sectionId, sectionTagName = null) {
  const elements = new Map();
  if (!doc || sectionId === null || sectionId === undefined || String(sectionId) === '') return [];

  const rawId = String(sectionId);
  const id = escapeAttributeValue(rawId);
  const selector = SECTION_REF_ATTRIBUTES.map((attr) => `[${attr}="${id}"]`).join(', ');
  let matches = [];
  try {
    matches = doc.querySelectorAll(selector);
  } catch {
    return [];
  }

  for (const element of matches) {
    const member = findAncestorMember(element);
    if (!member) continue;
    if (!sectionTagMatchesMember(sectionTagName, member.element)) continue;
    collectAncestorMemberElement(member.element, elements);
  }

  return [...elements.values()];
}

/**
 * 指定断面を使用する全部材のビューア要素タイプ集合を逆引きする
 * @param {Document} doc - XMLドキュメント
 * @param {string} sectionId - 断面ID
 * @param {string|null} [sectionTagName=null] - 断面XMLタグ名
 * @returns {Set<string>} 影響を受ける要素タイプ集合（'Column' 等）
 */
export function resolveAffectedTypesForSection(doc, sectionId, sectionTagName = null) {
  return new Set(
    resolveAffectedElementsForSection(doc, sectionId, sectionTagName).map(
      ({ elementType }) => elementType,
    ),
  );
}
