/**
 * @fileoverview RC柱主筋の部材ごとの材軸表示範囲を解決する
 *
 * ST-Bridge の柱端オフセットは躯体形状の端点を表すため、柱主筋の表示下端を
 * そのまま柱端へ一致させると、交差する梁せいが異なる仕口で主筋が梁下端から
 * 飛び出して見えることがある。
 *
 * 柱脚節点に取り付く RC 梁のうち、最も高い梁下端を仕口下端とし、柱ごとに
 * 主筋の表示開始比率を求める。断面配筋は共有したまま、材軸方向の範囲だけを
 * 部材単位で解決する。
 *
 * @module data/extractors/rebar3d/columnMainMemberPlacement
 */

import { collectBeamLevelsAtNode, createTagScanner, getNodeCoord } from '../columnSupportUtils.js';
import { buildRebarModelIndex } from './rebarModelIndex.js';

export { buildColumnJointTransitionFacts } from './columnJointTransitionPlacement.js';

const EPS = 1e-9;

function numericAttribute(element, name) {
  const value = parseFloat(element?.getAttribute(name));
  return Number.isFinite(value) ? value : 0;
}

/**
 * 1本の柱について、主筋表示の開始比率を求める。
 *
 * startRatio=0 は柱の実配置下端、1 は柱の実配置上端を表す。
 * 梁下端が柱の実配置下端より上にある場合だけクリップし、それ以外は 0 とする。
 *
 * @param {function(string): Element[]} scanTag - タグ走査関数
 * @param {Element} columnEl - StbColumn / StbPost
 * @param {Object|null} [index=null] - RebarModelIndex
 * @returns {{startRatio:number,endRatio:number,source:string,beamCount:number,
 *   lowerFaceZ:number|null,memberBottomZ:number|null,memberTopZ:number|null}}
 */
export function resolveColumnMainMemberRange(scanTag, columnEl, index = null) {
  const bottomNodeId = columnEl?.getAttribute('id_node_bottom');
  const topNodeId = columnEl?.getAttribute('id_node_top');
  const bottomNode = getNodeCoord(scanTag, bottomNodeId, index);
  const topNode = getNodeCoord(scanTag, topNodeId, index);
  if (!bottomNode || !topNode) {
    return {
      startRatio: 0,
      endRatio: 1,
      source: 'unresolved-node',
      beamCount: 0,
      lowerFaceZ: null,
      memberBottomZ: null,
      memberTopZ: null,
    };
  }

  const memberBottomZ = bottomNode.z + numericAttribute(columnEl, 'offset_bottom_Z');
  const memberTopZ = topNode.z + numericAttribute(columnEl, 'offset_top_Z');
  const dz = memberTopZ - memberBottomZ;
  const beamLevels = collectBeamLevelsAtNode(scanTag, bottomNodeId, index);

  if (!beamLevels || Math.abs(dz) <= EPS) {
    return {
      startRatio: 0,
      endRatio: 1,
      source: beamLevels ? 'unresolved-axis' : 'member-end',
      beamCount: beamLevels?.count || 0,
      lowerFaceZ: beamLevels?.highestBottomZ ?? null,
      memberBottomZ,
      memberTopZ,
    };
  }

  // 柱梁仕口の下端は、取り付く全ての梁が重なる範囲の下端＝最も高い梁下端とする。
  const lowerFaceZ = beamLevels.highestBottomZ;
  const ratio = (lowerFaceZ - memberBottomZ) / dz;
  const shouldClip = ratio > EPS && ratio < 1 - EPS;

  return {
    startRatio: shouldClip ? ratio : 0,
    endRatio: 1,
    source: shouldClip ? 'connected-beam-lower-face' : 'member-end',
    beamCount: beamLevels.count,
    lowerFaceZ,
    memberBottomZ,
    memberTopZ,
  };
}

/**
 * RC柱・RC間柱の主筋表示範囲を部材IDごとに作る。
 * @param {Document} xmlDoc - STB XMLドキュメント
 * @param {function(string): Element[]} [sharedScanTag] - 呼び出し内で共有するタグ走査関数
 * @param {Object|null} [sharedIndex=null] - 呼び出し内で共有するRebarModelIndex
 * @returns {Map<string, Object>} 部材ID → resolveColumnMainMemberRange の結果
 */
export function buildColumnMainMemberRangeMap(xmlDoc, sharedScanTag = null, sharedIndex = null) {
  if (!xmlDoc) return new Map();
  const scanTag = sharedScanTag || createTagScanner(xmlDoc);
  const modelIndex = sharedIndex || buildRebarModelIndex(xmlDoc, { scanTag });
  const result = new Map();

  for (const columnEl of [...scanTag('StbColumn'), ...scanTag('StbPost')]) {
    if (String(columnEl.getAttribute('kind_structure') || '').toUpperCase() !== 'RC') continue;
    const id = columnEl.getAttribute('id');
    if (!id) continue;
    result.set(id, resolveColumnMainMemberRange(scanTag, columnEl, modelIndex));
  }

  return result;
}
