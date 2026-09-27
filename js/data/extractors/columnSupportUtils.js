/**
 * @fileoverview 節点に取り付く柱（支点）の解決ヘルパー
 *
 * 梁立面図（貫通孔配置図）と3D配筋の柱内定着で共通に使う、
 * 「節点に取り付く柱を探して、その平面寸法を梁軸方向へ投影する」処理をまとめる。
 *
 * 柱・梁とも通り芯に平行な配置を想定した近似で、柱の rotate や
 * 斜め梁の厳密な投影は行わない。
 *
 * @module data/extractors/columnSupportUtils
 */

import { incrementRebarPerformanceCounter } from '../../utils/rebarPerformanceMetrics.js';
import { lookupRebarModelIndex } from './rebar3d/rebarModelIndex.js';
import { querySelector, querySelectorAll } from './sectionListUtils.js';

/** 柱断面として探索するタグ（先に見つかったものを採用する） */
const COLUMN_SECTION_TAGS = [
  'StbSecColumn_RC',
  'StbSecColumn_SRC',
  'StbSecColumn_CFT',
  'StbSecColumn_S',
  'StbSecPost_RC',
];

/**
 * タグ走査の呼び出し内キャッシュを生成する。
 * 1回の抽出で同一タグの全文書スキャンが重複しないようにする
 * （ドキュメント編集で結果が変わり得るため、呼び出しをまたぐキャッシュは持たない）。
 * @param {Document} xmlDoc - STB XMLドキュメント
 * @returns {function(string): Element[]} タグ走査関数
 */
export function createTagScanner(xmlDoc) {
  incrementRebarPerformanceCounter('scanner.create.count');
  const cache = new Map();
  return (tagName) => {
    if (!cache.has(tagName)) {
      cache.set(tagName, querySelectorAll(xmlDoc, tagName));
    }
    return cache.get(tagName);
  };
}

/**
 * id属性で要素を検索する
 * @param {function(string): Element[]} scanTag - タグ走査関数
 * @param {string} tagName - タグ名
 * @param {string} id - id属性値
 * @param {Object|null} [index=null] - RebarModelIndex
 * @returns {Element|null} 該当要素
 */
export function findElementById(scanTag, tagName, id, index = null) {
  if (!id) return null;
  const indexed = lookupRebarModelIndex(index, tagName, id);
  if (indexed !== undefined) return indexed;
  return scanTag(tagName).find((el) => el.getAttribute('id') === id) || null;
}

/**
 * StbNode座標を取得する
 * @param {function(string): Element[]} scanTag - タグ走査関数
 * @param {string} nodeId - 節点ID
 * @param {Object|null} [index=null] - RebarModelIndex
 * @returns {{x:number, y:number, z:number}|null} 節点座標
 */
export function getNodeCoord(scanTag, nodeId, index = null) {
  const node = findElementById(scanTag, 'StbNode', nodeId, index);
  if (!node) return null;
  const x = parseFloat(node.getAttribute('X') ?? node.getAttribute('x'));
  const y = parseFloat(node.getAttribute('Y') ?? node.getAttribute('y'));
  const z = parseFloat(node.getAttribute('Z') ?? node.getAttribute('z'));
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
}

/**
 * 節点に取り付く柱（StbColumn/StbPost）を検索する
 * @param {function(string): Element[]} scanTag - タグ走査関数
 * @param {string} nodeId - 節点ID
 * @param {Object|null} [index=null] - RebarModelIndex
 * @returns {Element|null} 柱要素（柱頭が一致する柱を優先）
 */
export function findColumnAtNode(scanTag, nodeId, index = null) {
  if (index?.columnsByNodeId instanceof Map) {
    const entry = index.columnsByNodeId.get(String(nodeId));
    // 既存実装は id_node_top 一致（below）を先に採用する。
    return entry?.below || entry?.above || null;
  }

  const candidates = [...scanTag('StbColumn'), ...scanTag('StbPost')];
  return (
    candidates.find((el) => el.getAttribute('id_node_top') === nodeId) ||
    candidates.find((el) => el.getAttribute('id_node_bottom') === nodeId) ||
    null
  );
}

/**
 * 節点を柱脚／柱頭とする柱を探す
 *
 * 「上に柱があるか（最上階か）」「下に柱があるか（最下階か）」の判定に使う。
 * @param {function(string): Element[]} scanTag - タグ走査関数
 * @param {string} nodeId - 節点ID
 * @param {Object|null} [index=null] - RebarModelIndex
 * @returns {{above:Element|null, below:Element|null}} 節点の上下に伸びる柱
 */
export function findColumnsAtNode(scanTag, nodeId, index = null) {
  if (!nodeId) return { above: null, below: null };
  if (index?.columnsByNodeId instanceof Map) {
    const entry = index.columnsByNodeId.get(String(nodeId));
    return { above: entry?.above || null, below: entry?.below || null };
  }

  const candidates = [...scanTag('StbColumn'), ...scanTag('StbPost')];
  return {
    above: candidates.find((el) => el.getAttribute('id_node_bottom') === nodeId) || null,
    below: candidates.find((el) => el.getAttribute('id_node_top') === nodeId) || null,
  };
}

/** 梁部材タグと、断面IDを引くタグの優先順 */
const BEAM_MEMBER_TAGS = [
  { member: 'StbGirder', sections: ['StbSecGirder_RC', 'StbSecBeam_RC'] },
  { member: 'StbBeam', sections: ['StbSecBeam_RC', 'StbSecGirder_RC'] },
];

function beamSectionsForTag(tagName) {
  return BEAM_MEMBER_TAGS.find((entry) => entry.member === tagName)?.sections || [];
}

/**
 * 接続端における梁せいを取り出す。
 *
 * ST-Bridge の RC 梁テーパー／ハンチは、START/CENTER/END の各子要素が
 * それぞれ width/depth を持つ。仕口範囲では接続節点側の START/END を使い、
 * pos が無いストレート断面は両端共通として扱う。
 * @param {Element} sectionEl - 梁断面要素
 * @param {'start'|'end'} endpoint - 接続端
 * @returns {number} 接続端の梁せい [mm]。読めない場合は 0
 */
function readBeamDepth(sectionEl, endpoint) {
  const targetPos = endpoint === 'end' ? 'END' : 'START';
  let endpointDepth = 0;
  let fallbackDepth = 0;

  const walk = (el) => {
    const value = parseFloat(el.getAttribute?.('depth'));
    if (Number.isFinite(value) && value > 0) {
      fallbackDepth = Math.max(fallbackDepth, value);
      const pos = String(el.getAttribute?.('pos') || '').toUpperCase();
      if (!pos || pos === targetPos) endpointDepth = Math.max(endpointDepth, value);
    }
    const children = el.childNodes || [];
    for (let i = 0; i < children.length; i++) {
      if (children[i].nodeType === 1) walk(children[i]);
    }
  };
  walk(sectionEl);
  return endpointDepth || fallbackDepth;
}

/**
 * 節点に取り付くRC梁の天端・下端レベルを集める
 *
 * 梁は天端基準で配置されるため、天端＝節点Z＋端部のZオフセット、
 * 下端＝天端−接続端の梁せいとする。
 * @param {function(string): Element[]} scanTag - タグ走査関数
 * @param {string} nodeId - 節点ID
 * @param {Object|null} [index=null] - RebarModelIndex
 * @returns {{count:number, highestTopZ:number, lowestTopZ:number,
 *   highestBottomZ:number, lowestBottomZ:number, maxDepthMm:number}|null}
 *   梁レベル。取り付くRC梁が無い場合は null
 */
export function collectBeamLevelsAtNode(scanTag, nodeId, index = null) {
  const node = getNodeCoord(scanTag, nodeId, index);
  if (!node) return null;

  const topZs = [];
  const bottomZs = [];

  const processBeam = (beamEl, memberTag, endpoint = null) => {
    const kindStructure = String(beamEl.getAttribute('kind_structure') || '').toUpperCase();
    // ST-Bridge の断面IDは断面種別をまたいで一意とは限らないため、
    // S/SRC梁を同じ数値IDのRC断面へ誤解決しない。kind欠損は既存互換のため許容する。
    if (kindStructure && kindStructure !== 'RC') return;

    const isStart = endpoint
      ? endpoint === 'start'
      : beamEl.getAttribute('id_node_start') === nodeId;
    const isEnd = endpoint ? endpoint === 'end' : beamEl.getAttribute('id_node_end') === nodeId;
    if (!isStart && !isEnd) return;

    const sectionId = beamEl.getAttribute('id_section');
    let depth = 0;
    for (const tag of beamSectionsForTag(memberTag)) {
      const sectionEl = findElementById(scanTag, tag, sectionId, index);
      if (sectionEl) {
        depth = readBeamDepth(sectionEl, isStart ? 'start' : 'end');
        break;
      }
    }
    if (!(depth > 0)) return;

    const offsetZ =
      parseFloat(beamEl.getAttribute(isStart ? 'offset_start_Z' : 'offset_end_Z')) || 0;
    const topZ = node.z + offsetZ;
    topZs.push(topZ);
    bottomZs.push(topZ - depth);
  };

  if (index?.beamsByNodeId instanceof Map) {
    for (const connection of index.beamsByNodeId.get(String(nodeId)) || []) {
      processBeam(connection.element, connection.tagName, connection.endpoint);
    }
  } else {
    for (const { member } of BEAM_MEMBER_TAGS) {
      for (const beamEl of scanTag(member)) {
        processBeam(beamEl, member);
      }
    }
  }

  if (topZs.length === 0) return null;

  return {
    count: topZs.length,
    highestTopZ: Math.max(...topZs),
    lowestTopZ: Math.min(...topZs),
    highestBottomZ: Math.max(...bottomZs),
    lowestBottomZ: Math.min(...bottomZs),
    maxDepthMm: Math.max(...topZs.map((topZ, i) => topZ - bottomZs[i])),
  };
}

/**
 * 柱断面の平面寸法を抽出する（矩形/円形のみ。取得できない場合は 0）
 * @param {function(string): Element[]} scanTag - タグ走査関数
 * @param {string} sectionId - 断面ID
 * @param {Object|null} [index=null] - RebarModelIndex
 * @returns {{shape:'RECT'|'CIRCLE', widthX:number, widthY:number, name:string|null,
 *   strengthConcrete:string|null}|null} 柱平面寸法
 */
export function extractColumnPlanDimensions(scanTag, sectionId, index = null) {
  let sectionEl = null;
  for (const tag of COLUMN_SECTION_TAGS) {
    sectionEl = findElementById(scanTag, tag, sectionId, index);
    if (sectionEl) break;
  }
  if (!sectionEl) return null;

  const name = sectionEl.getAttribute('name') || null;
  const strengthConcrete = sectionEl.getAttribute('strength_concrete') || null;

  const rect =
    querySelector(sectionEl, 'StbSecColumnRect') ||
    querySelector(sectionEl, 'StbSecColumn_RC_Rect') ||
    querySelector(sectionEl, 'StbSecColumn_SRC_Rect');
  if (rect) {
    const widthX = parseFloat(rect.getAttribute('width_X') || rect.getAttribute('depth_X')) || 0;
    const widthY = parseFloat(rect.getAttribute('width_Y') || rect.getAttribute('depth_Y')) || 0;
    if (widthX > 0 && widthY > 0) {
      return { shape: 'RECT', widthX, widthY, name, strengthConcrete };
    }
  }

  const circle =
    querySelector(sectionEl, 'StbSecColumnCircle') ||
    querySelector(sectionEl, 'StbSecColumn_RC_Circle');
  if (circle) {
    const d = parseFloat(circle.getAttribute('D')) || 0;
    if (d > 0) return { shape: 'CIRCLE', widthX: d, widthY: d, name, strengthConcrete };
  }

  return { shape: 'RECT', widthX: 0, widthY: 0, name, strengthConcrete };
}

/**
 * 柱の平面寸法を梁軸方向へ投影したせいを算定する
 * @param {{shape:string, widthX:number, widthY:number}|null} dims - 柱平面寸法
 * @param {{x:number, y:number}} beamDir - 梁軸の平面単位ベクトル
 * @returns {number} 梁軸方向の柱せい [mm]
 */
export function projectColumnDepth(dims, beamDir) {
  if (!dims) return 0;
  if (dims.shape === 'CIRCLE') return dims.widthX;
  return Math.abs(beamDir.x) * dims.widthX + Math.abs(beamDir.y) * dims.widthY;
}
