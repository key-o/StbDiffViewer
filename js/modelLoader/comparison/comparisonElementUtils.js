/**
 * @fileoverview 要素比較で共有する要素アクセスヘルパー
 *
 * 属性読み出し・壁種別の正規化・「第一Node」解決など、
 * 断面キー生成と要素比較の双方から使うステートレスなヘルパーを提供する。
 *
 * @module modelLoader/comparison/comparisonElementUtils
 */

import { readElementAttribute } from '../../data/accessors/elementAttributeAccessor.js';

const WALL_TYPE_ALIASES = new Set(['ShearWall', 'StbShearWall']);

/**
 * 要素種別 → 「第一Node」を指す節点参照属性の候補リスト。
 * 線材は始点/下端、面材は頂点列（StbNodeIdOrder の先頭）を第一Nodeとする。
 * NAME_MEMBER_STORY の所属階キー生成に用いる。
 */
const FIRST_NODE_ATTR_BY_ELEMENT_TYPE = {
  Column: ['id_node_bottom', 'id_node'],
  Post: ['id_node_bottom', 'id_node'],
  FoundationColumn: ['id_node_bottom', 'id_node'],
  Girder: ['id_node_start'],
  Beam: ['id_node_start'],
  Brace: ['id_node_start'],
  Parapet: ['id_node_start'],
  Pile: ['id_node_bottom', 'id_node'],
  Footing: ['id_node_bottom', 'id_node'],
  StripFooting: ['id_node_start'],
  IsolatingDevice: ['id_node_start', 'id_node'],
  DampingDevice: ['id_node_start', 'id_node'],
};

export function getElementAttribute(element, attributeName) {
  return readElementAttribute(element, attributeName);
}

export function getSectionIdFromElement(element) {
  return getElementAttribute(element, 'id_section') || getElementAttribute(element, 'id_sec');
}

export function normalizeComparisonElementType(elementType) {
  return WALL_TYPE_ALIASES.has(elementType) ? 'Wall' : elementType;
}

/**
 * 要素の「第一Node」の節点IDを取得する。
 * 線材は属性候補から、面材(Slab/Wall)は StbNodeIdOrder の先頭 id_node から解決する。
 * @param {Element} element - STB配置要素
 * @param {string} elementType - 正規化済み要素種別
 * @returns {string|null} 第一Nodeの節点ID（取得不可なら null）
 */
export function getFirstNodeId(element, elementType) {
  const attrs = FIRST_NODE_ATTR_BY_ELEMENT_TYPE[elementType];
  if (attrs) {
    for (const attr of attrs) {
      const id = getElementAttribute(element, attr);
      if (id != null && String(id).trim() !== '') {
        return String(id).trim();
      }
    }
    return null;
  }

  // 面材（Slab / Wall / ShearWall）: 頂点列の先頭を第一Nodeとする。
  // querySelector 非対応の XML パーサ（xmldom 等）でも動くよう getElementsByTagName へフォールバック。
  const getFirstChildByTag = (parent, tag) => {
    if (!parent) return null;
    if (typeof parent.querySelector === 'function') {
      return parent.querySelector(tag);
    }
    if (typeof parent.getElementsByTagName === 'function') {
      return parent.getElementsByTagName(tag)[0] || null;
    }
    return null;
  };

  const order = getFirstChildByTag(element, 'StbNodeIdOrder');
  const firstNode = getFirstChildByTag(order, 'StbNodeId');
  const id = getElementAttribute(firstNode, 'id_node') || getElementAttribute(firstNode, 'id');
  if (id != null && String(id).trim() !== '') {
    return String(id).trim();
  }

  // StbNodeIdOrder がテキスト形式（"1 2 3 4"）の場合の先頭ノードID
  const orderText = order && order.textContent ? String(order.textContent).trim() : '';
  const firstToken = orderText.split(/\s+/)[0];
  return firstToken ? firstToken : null;
}
