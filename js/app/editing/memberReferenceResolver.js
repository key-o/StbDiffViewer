/**
 * @fileoverview ST-Bridge member ID の typed reference resolver。
 *
 * Member ID はタグごとに独立した参照空間を持つため、数値だけでは参照先を決めない。
 * ST-Bridge 2.1 の kind_member / StbNode.kind / connection child tag 等を使い、
 * 対象 member tag に解決できる参照だけを列挙する。
 *
 * id_member を持ちながら参照種別を確定できない要素がある場合は、部分追従で dangling
 * reference を作らないよう fail-closed とする。
 */

const MEMBER_TAGS = new Set([
  'StbColumn',
  'StbPost',
  'StbGirder',
  'StbBeam',
  'StbBrace',
  'StbSlab',
  'StbWall',
  'StbIsolatingDevice',
  'StbDampingDevice',
  'StbFrameDampingDevice',
  'StbFooting',
  'StbStripFooting',
  'StbPile',
  'StbFoundationColumn',
  'StbParapet',
]);

const MEMBER_KIND_BY_TAG = Object.freeze({
  StbColumn: 'COLUMN',
  StbPost: 'POST',
  StbGirder: 'GIRDER',
  StbBeam: 'BEAM',
  StbBrace: 'BRACE',
  StbSlab: 'SLAB',
  StbWall: 'WALL',
});

const NODE_KIND_TO_MEMBER_KIND = Object.freeze({
  ON_GIRDER: 'GIRDER',
  ON_BEAM: 'BEAM',
  ON_COLUMN: 'COLUMN',
  ON_POST: 'POST',
  ON_CANTI: 'GIRDER',
  ON_SLAB: 'SLAB',
});

const CONNECTION_ID_TAG_TO_MEMBER_KIND = Object.freeze({
  StbConnectedColumn: 'COLUMN',
  StbConnectedPost: 'POST',
  StbConnectedGirder: 'GIRDER',
  StbConnectedBeam: 'BEAM',
  StbConnectedBrace: 'BRACE',
  StbConnectingPost: 'POST',
  StbConnectingGirder: 'GIRDER',
  StbConnectingBeam: 'BEAM',
  StbConnectingBrace: 'BRACE',
});

const KNOWN_MEMBER_KINDS = new Set(Object.values(MEMBER_KIND_BY_TAG));
const FRAME_DAMPING_CONNECTION_KINDS = new Set(['BRACE', 'POST', 'GIRDER']);

function normalizeKind(value) {
  const kind = String(value ?? '')
    .trim()
    .toUpperCase();
  return kind || null;
}

function addAttributeReference(refs, element, name, expectedId) {
  if (!element?.getAttribute || element.getAttribute(name) !== String(expectedId)) return;
  refs.push({ kind: 'attr', element, name });
}

function resolveFrameDampingConnectionKind(element) {
  const candidates = ['kind_member', 'kind_structure', 'kind']
    .map((name) => normalizeKind(element.getAttribute(name)))
    .filter(Boolean);
  const unique = [...new Set(candidates)];
  if (unique.length !== 1 || !FRAME_DAMPING_CONNECTION_KINDS.has(unique[0])) return null;
  return unique[0];
}

function resolveDirectIdMemberKind(element) {
  if (element.tagName === 'StbNode') {
    return NODE_KIND_TO_MEMBER_KIND[normalizeKind(element.getAttribute('kind'))] || null;
  }

  if (element.tagName === 'StbPenetrationArrangement') {
    // ST-Bridge 2.1: kind_member 省略時は GIRDER。
    const kind = normalizeKind(element.getAttribute('kind_member')) || 'GIRDER';
    return KNOWN_MEMBER_KINDS.has(kind) ? kind : null;
  }

  if (element.tagName === 'StbFrameDampingDeviceConnection') {
    // 仕様資料では kind_structure、既存 parser / sample では kind も使われるため双方を扱う。
    return resolveFrameDampingConnectionKind(element);
  }

  const kindMember = normalizeKind(element.getAttribute('kind_member'));
  return KNOWN_MEMBER_KINDS.has(kindMember) ? kindMember : null;
}

function collectDirectIdMemberReferences(document, targetKind, memberId, refs) {
  for (const element of document.querySelectorAll('*')) {
    if (element.getAttribute('id_member') !== String(memberId)) continue;

    const referencedKind = resolveDirectIdMemberKind(element);
    if (!referencedKind) {
      throw new Error(`${element.tagName}[id_member=${memberId}] の部材参照種別を特定できません。`);
    }
    if (referencedKind === targetKind) {
      refs.push({ kind: 'attr', element, name: 'id_member' });
    }
  }
}

function collectConnectionChildReferences(document, targetKind, memberId, refs) {
  for (const [tagName, referencedKind] of Object.entries(CONNECTION_ID_TAG_TO_MEMBER_KIND)) {
    if (referencedKind !== targetKind) continue;
    for (const element of document.getElementsByTagName(tagName)) {
      addAttributeReference(refs, element, 'id', memberId);
    }
  }
}

/**
 * IDを持つ部材要素か判定する。ここには Phase 5 で typed reference を未解決の部材も含む。
 * @param {string} tagName
 * @returns {boolean}
 */
export function isMemberIdOwnerTag(tagName) {
  return MEMBER_TAGS.has(String(tagName || ''));
}

/**
 * kind_member 等で使う member kind を返す。
 * null は、その部材種別の inbound reference 契約を Phase 5 でまだ解決していないことを示す。
 * @param {string} tagName
 * @returns {string|null}
 */
export function resolveMemberKindForTag(tagName) {
  return MEMBER_KIND_BY_TAG[String(tagName || '')] || null;
}

/**
 * 指定 member ID への typed reference を列挙する。
 *
 * Column / Post / Girder / Beam / Brace / Slab / Wall のみを current supported set とする。
 * 免震・制振・基礎・杭・パラペット等は別属性参照の取りこぼしを避けるため、参照が見つからなくても
 * 「未参照」と判定せず fail-closed のまま維持する。
 *
 * @param {Document} document
 * @param {string} tagName member owner tag
 * @param {string|number} memberId
 * @returns {{memberKind:string, refs:Array<{kind:'attr',element:Element,name:string}>}}
 */
export function collectMemberIdReferences(document, tagName, memberId) {
  const normalizedTag = String(tagName || '');
  const id = String(memberId ?? '').trim();
  if (!isMemberIdOwnerTag(normalizedTag)) {
    throw new Error(`${normalizedTag || '(unknown)'} は member ID owner tag ではありません。`);
  }

  const memberKind = resolveMemberKindForTag(normalizedTag);
  if (!memberKind) {
    throw new Error(
      `${normalizedTag} の member ID 参照意味論は typed member resolver の対象外です。`,
    );
  }
  if (!document || !id) return { memberKind, refs: [] };

  const refs = [];
  collectDirectIdMemberReferences(document, memberKind, id, refs);
  collectConnectionChildReferences(document, memberKind, id, refs);
  return { memberKind, refs };
}
