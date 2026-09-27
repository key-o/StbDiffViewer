/**
 * @fileoverview 3D配筋の断面内配置に共通するヘルパー
 *
 * 柱・梁それぞれの配置算定モジュールから使う、等間隔配置と
 * dt（部材面から主筋芯までの距離）の決定ロジックをまとめる。
 *
 * @module data/extractors/rebar3d/rebarSectionUtils
 */

import { REBAR_CUTOFF_RULES } from '../../../constants/rebarCutoffRules.js';

/** 梁断面の位置キーを材軸方向の並び順で並べたもの */
const POSITION_ORDER = ['LEFT', 'CENTER', 'RIGHT'];

/**
 * R12で大梁・小梁の差を閉じ込めるための薄いstrategy。
 *
 * 現段階では既存の断面分類契約をそのまま保持し、geometryや標準図type選択は変更しない。
 * 後続R12では memberTag を起点に L3/L3h・大梁内定着など小梁固有規則だけを分岐させる。
 */
function resolveBeamSectionMemberStrategy(element) {
  const tagName = element?.tagName || element?.localName || '';
  if (tagName === 'StbSecGirder_RC') {
    return { memberType: 'girder', memberTag: 'StbGirder', source: 'legacy-section-tag' };
  }
  if (element?.getAttribute('isFoundation') === 'true') {
    return { memberType: 'girder', memberTag: 'StbGirder', source: 'foundation-section' };
  }
  if (element?.getAttribute('kind_beam') === 'BEAM') {
    return { memberType: 'beam', memberTag: 'StbBeam', source: 'kind-beam' };
  }
  return { memberType: 'girder', memberTag: 'StbGirder', source: 'default-girder' };
}

/**
 * 区間 [start, end] を count 個の等間隔値に分ける
 * @param {number} start - 始点
 * @param {number} end - 終点
 * @param {number} count - 個数
 * @returns {number[]} 等間隔値の配列
 */
export function evenlySpaced(start, end, count) {
  if (count <= 0) return [];
  if (count === 1) return [(start + end) / 2];
  const step = (end - start) / (count - 1);
  return Array.from({ length: count }, (_, index) => start + step * index);
}

/**
 * dt（部材面から主筋芯までの距離）を決める。
 *
 * STBに主筋中心位置があればそれを採用し、無ければ
 * 「かぶり ＋ 帯筋/あばら筋の最大外径 ＋ 主筋の最大外径/2」で構成する。
 * これは梁貫通孔（開口補強筋）検討と共通の考え方である。
 *
 * @param {number|null} stbCenter - STBの主筋中心位置 [mm]
 * @param {number} coverMm - かぶり厚さ [mm]
 * @param {number} hoopOuterMm - 帯筋/あばら筋の最大外径 [mm]
 * @param {number} mainOuterMm - 主筋の最大外径 [mm]
 * @returns {{value:number, estimated:boolean}} dt [mm] と、構成値かどうか
 */
export function resolveDt(stbCenter, coverMm, hoopOuterMm, mainOuterMm) {
  if (Number.isFinite(stbCenter) && stbCenter > 0) {
    return { value: stbCenter, estimated: false };
  }
  return { value: coverMm + hoopOuterMm + mainOuterMm / 2, estimated: true };
}

/**
 * 材軸方向の区間（セグメント）を1つ作る
 * @param {number} startRatio - 始点比率（0〜1）
 * @param {number} endRatio - 終点比率（0〜1）
 * @param {Array<{u:number, v:number, dia:number}>} bars - 断面内の鉄筋芯
 * @returns {{startRatio:number, endRatio:number, bars:Array}} セグメント
 */
export function createSegment(startRatio, endRatio, bars) {
  return { startRatio, endRatio, bars };
}

/**
 * 基準となる鉄筋群に対応づかない「余分な」鉄筋を取り出す
 *
 * 基準1本につき断面内で最も近い1本を順に取り除き、残りを返す。
 * 本数差ぶんだけが必ず残るため、本数の異なる配筋どうしを突き合わせて
 * 「カットオフされる鉄筋」を取り出すのに使う（位置は近似）。
 * @param {Array<{u:number, v:number}>} bars - 本数の多い側の鉄筋
 * @param {Array<{u:number, v:number}>} baseBars - 基準（通し筋）
 * @returns {Array<Object>} 余分な鉄筋
 */
export function pickExtraBars(bars, baseBars) {
  const remaining = bars.slice();
  for (const base of baseBars) {
    if (remaining.length === 0) break;
    let nearest = 0;
    let nearestDistance = Infinity;
    for (const [index, candidate] of remaining.entries()) {
      const distance = (candidate.u - base.u) ** 2 + (candidate.v - base.v) ** 2;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = index;
      }
    }
    remaining.splice(nearest, 1);
  }
  return remaining;
}

/**
 * 梁断面詳細から材軸方向に並んだ位置キーを取り出す
 * @param {Object} detail - extractRcBeamSectionDetail の結果
 * @returns {string[]} 位置キー配列
 */
export function orderedPositionKeys(detail) {
  const positions = detail?.positions || {};
  const ordered = POSITION_ORDER.filter((key) => positions[key]);
  if (ordered.length > 0) return ordered;
  // SAME や POS_n のみの断面
  return Object.keys(positions);
}

/**
 * 位置キーの一覧から、材軸方向の区間比率を決める。
 *
 * 3位置なら端部を L/4 ずつ、2位置なら半分ずつ、1位置なら全長とする。
 * @param {string[]} keys - 材軸方向に並んだ位置キー
 * @returns {Array<{key:string, startRatio:number, endRatio:number}>} 区間
 */
export function resolveSpanRanges(keys) {
  if (keys.length <= 1) {
    return keys.map((key) => ({ key, startRatio: 0, endRatio: 1 }));
  }
  if (keys.length === 2) {
    // START_END（テーパー）等の2位置は中央で等分する。位置パターンごとに
    // 区切り比率を変えたい場合は positionPattern を見て分岐する余地がある。
    return [
      { key: keys[0], startRatio: 0, endRatio: 0.5 },
      { key: keys[1], startRatio: 0.5, endRatio: 1 },
    ];
  }
  // 3位置: 端部をカットオフ位置（L/4）で区切る
  const end = REBAR_CUTOFF_RULES.cutoffSpanRatio;
  return [
    { key: keys[0], startRatio: 0, endRatio: end },
    { key: keys[1], startRatio: end, endRatio: 1 - end },
    { key: keys[2], startRatio: 1 - end, endRatio: 1 },
  ];
}

/**
 * 梁断面要素が大梁（Girder）扱いかどうかを判定する。
 *
 * `common-stb/import/config/sectionConfig.js` の Girder / Beam の振り分けに合わせる:
 * - `StbSecGirder_RC` は常に大梁
 * - `StbSecBeam_RC` は `kind_beam="BEAM"` のときだけ小梁で、
 *   属性が無い場合と `isFoundation="true"` の基礎梁は大梁として扱う
 *
 * R12以降の小梁固有処理は、この関数の内部strategyと同じ分類契約を使用する。
 * @param {Element} element - 断面要素
 * @returns {boolean} 大梁なら true
 */
export function isGirderSection(element) {
  return resolveBeamSectionMemberStrategy(element).memberType === 'girder';
}
