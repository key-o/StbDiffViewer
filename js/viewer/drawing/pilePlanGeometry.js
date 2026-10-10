/** @fileoverview ST-Bridge StbPile の構造平面図外形(杭頭円)を原本DOMから解決する。 */

const PILE_SECTION_TAGS = Object.freeze([
  'StbSecPile_RC',
  'StbSecPile_S',
  'StbSecPileProduct',
  'StbSecPilePrecast',
]);
// 杭頭外形が軸径で確定しない断面(頭部拡大・節付き・回転杭)は図面化しない。
// 拡底(ExtendedFoot)は杭先端側なので、杭頭径は軸径(D_axial)で確定する。
const HEAD_UNRESOLVED_SHAPE = /ExtendedTop|Nodular|Rotational/;
const CIRCLE_SEGMENTS = 48;

function localName(element) {
  const name = element?.localName || element?.nodeName || '';
  const separator = name.indexOf(':');
  return separator >= 0 ? name.slice(separator + 1) : name;
}

function descendants(root) {
  return Array.from(root?.getElementsByTagName?.('*') || []);
}

function numberAttr(element, name) {
  const raw = element?.getAttribute?.(name);
  if (raw == null || raw === '') return 0;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`PILE_ATTRIBUTE_INVALID:${name}=${raw}`);
  return value;
}

function nodeXY(nodes, id) {
  const node =
    nodes instanceof Map ? nodes.get(id) || nodes.get(String(id)) || nodes.get(Number(id)) : null;
  const x = Number(node?.x);
  const y = Number(node?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`PILE_NODE_NOT_FOUND:${id}`);
  return [x, y];
}

const sectionIndexCache = new WeakMap();

function pileSectionsById(document) {
  let index = sectionIndexCache.get(document);
  if (!index) {
    index = new Map();
    for (const el of descendants(document)) {
      if (!PILE_SECTION_TAGS.includes(localName(el))) continue;
      const id = el.getAttribute('id');
      if (!index.has(id)) index.set(id, []);
      index.get(id).push(el);
    }
    sectionIndexCache.set(document, index);
  }
  return index;
}

/**
 * 杭頭の径を返す。
 * - 継杭(id_order)がある場合、仕様上 第1杭(最小id_order)が杭頭側のため、その径を採用する。
 * - id_orderが無い場合は径が一様であることを要求する。
 * - 頭部拡大・節付き・回転杭、径を持たない断面(矩形等)はfail-closed。
 */
export function resolvePileDiameter(document, sectionId) {
  const sections = pileSectionsById(document).get(sectionId) || [];
  if (sections.length !== 1) {
    throw new Error(
      sections.length === 0
        ? `PILE_SECTION_NOT_FOUND:${sectionId}`
        : `PILE_SECTION_AMBIGUOUS:${sectionId}`,
    );
  }
  const candidates = [];
  for (const el of descendants(sections[0])) {
    const name = localName(el);
    if (HEAD_UNRESOLVED_SHAPE.test(name)) {
      throw new Error(`PILE_SECTION_SHAPE_UNSUPPORTED:${name}`);
    }
    const attr = el.hasAttribute('D') ? 'D' : el.hasAttribute('D_axial') ? 'D_axial' : null;
    if (!attr) continue;
    const d = Number(el.getAttribute(attr));
    if (!(d > 0) || !Number.isFinite(d)) throw new Error(`PILE_DIAMETER_INVALID:${name}`);
    const orderRaw = el.getAttribute('id_order');
    const order = orderRaw == null || orderRaw === '' ? null : Number(orderRaw);
    if (order != null && !Number.isFinite(order)) throw new Error(`PILE_ORDER_INVALID:${name}`);
    candidates.push({ d, order });
  }
  if (candidates.length === 0) throw new Error('PILE_DIAMETER_UNRESOLVED');
  if (candidates.every((c) => c.order != null)) {
    const min = Math.min(...candidates.map((c) => c.order));
    const heads = candidates.filter((c) => c.order === min);
    if (heads.length !== 1) throw new Error('PILE_HEAD_SEGMENT_AMBIGUOUS');
    return heads[0].d;
  }
  if (candidates.some((c) => Math.abs(c.d - candidates[0].d) > 1e-9)) {
    throw new Error('PILE_DIAMETER_NON_UNIFORM');
  }
  return candidates[0].d;
}

/** 杭頭位置(節点 + offset)を中心とする円の多角形近似を返す。 */
export function resolvePilePlanGeometry({ document, member, nodes } = {}) {
  if (!document || !member || !(nodes instanceof Map)) {
    throw new TypeError('Pile plan geometryにはdocument/member/nodesが必要です。');
  }
  const sectionId = String(member.getAttribute('id_section') || '').trim();
  if (!sectionId) throw new Error('PILE_SECTION_ID_REQUIRED');
  const diameter = resolvePileDiameter(document, sectionId);

  const nodeId = String(member.getAttribute('id_node') || '').trim();
  if (!nodeId) throw new Error('PILE_NODE_REQUIRED');
  const [nx, ny] = nodeXY(nodes, nodeId);
  const center = [nx + numberAttr(member, 'offset_X'), ny + numberAttr(member, 'offset_Y')];

  const r = diameter / 2;
  const points = [];
  for (let i = 0; i < CIRCLE_SEGMENTS; i += 1) {
    const a = (2 * Math.PI * i) / CIRCLE_SEGMENTS;
    points.push(Object.freeze([center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)]));
  }
  return Object.freeze({ points: Object.freeze(points), diameter, center: Object.freeze(center) });
}
