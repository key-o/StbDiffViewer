/**
 * @fileoverview RC梁（大梁・小梁）主筋の断面内配置算定（3D配筋用）
 *
 * 梁断面の配筋情報（本数・呼び径・かぶり）から、上端筋・下端筋・腹筋の
 * 断面内座標を求める。かぶり・dt の考え方は梁貫通孔（開口補強筋）検討と共通で、
 * 「主筋芯 = かぶり ＋ あばら筋の最大外径 ＋ 主筋の最大外径/2」を基本とする。
 *
 * 梁は LEFT / CENTER / RIGHT で本数が変わるため、材軸方向を位置ごとの区間に
 * 分けて配置する。区間の割り方は主筋カットオフと同じ L/4 を用いる。
 *
 * 座標系は断面ローカルで、断面中心が原点。
 * u は断面幅方向、v は梁せい方向（上が正）で、viewer の矩形プロファイル
 * （原点中心）および top-aligned 配置とそのまま一致する。
 *
 * @module data/extractors/rebar3d/beamRebarPlacement
 */

import {
  barDiameterMm,
  barOuterDiameterMm,
  minBarClearanceMm,
} from '../../../constants/beamOpeningRules.js';
import { BEAM_REBAR_PLACEMENT_RULES } from '../../../constants/rebarPlacementRules.js';
import { extractRcBeamSectionDetail } from '../beamSectionList/sectionDetail.js';
import { querySelectorAll } from '../sectionListUtils.js';
import {
  createSegment,
  evenlySpaced,
  isGirderSection,
  orderedPositionKeys,
  resolveDt,
  resolveSpanRanges,
} from './rebarSectionUtils.js';

/**
 * 1段分の主筋を断面内へ並べる
 *
 * @param {Object} params - 配置パラメータ
 * @param {number} params.width - 断面幅 [mm]
 * @param {number} params.depth - 梁せい [mm]
 * @param {number} params.count - 本数
 * @param {number} params.diaMm - 呼び径 [mm]
 * @param {number} params.dtSide - 側面からのdt [mm]
 * @param {number} params.centerFromEdge - 天端（下端）からの主筋芯距離 [mm]
 * @param {boolean} params.isTop - 上端筋か
 * @param {string|null} params.grade - 鉄筋種別（定着長さの判定に使う）
 * @returns {Array<{u:number, v:number, dia:number, role:string, grade:string|null}>} 主筋芯の配列
 */
function buildLayerBars({ width, depth, count, diaMm, dtSide, centerFromEdge, isTop, grade }) {
  const halfSpan = width / 2 - dtSide;
  if (count <= 0 || halfSpan < 0) return [];
  const v = isTop ? depth / 2 - centerFromEdge : -depth / 2 + centerFromEdge;
  const role = isTop ? 'top' : 'bottom';
  return evenlySpaced(-halfSpan, halfSpan, count).map((u) => ({
    u,
    v,
    dia: diaMm,
    role,
    grade: grade || null,
  }));
}

/**
 * 上端筋または下端筋の全段を組み立てる
 *
 * 2段目は「1段目の芯 ＋ 主筋の最大外径 ＋ 必要あき」だけ内側へ入る
 * （段間のあきは水平あきと同じ基準を流用する簡略化）。
 * @param {Object} bar - topBar / bottomBar
 * @param {Object} context - 断面コンテキスト
 * @returns {Array<{u:number, v:number, dia:number}>} 主筋芯の配列
 */
function buildSideBars(bar, context) {
  if (!bar) return [];
  const { width, depth, coverMm, coverSide, stirrupOuter, isTop, defaultDia } = context;

  const layers = bar.layers?.length
    ? bar.layers
    : [{ step: 1, count: bar.count1st ?? bar.count ?? 0, dia: bar.dia }];

  const bars = [];
  for (const layer of layers) {
    const count = layer.count || 0;
    if (count <= 0) continue;

    const diaName = layer.dia || bar.dia || defaultDia;
    const diaMm = barDiameterMm(diaName, barDiameterMm(defaultDia));
    const outerMm = barOuterDiameterMm(diaName, diaMm);
    const firstCenter = coverMm + stirrupOuter + outerMm / 2;
    const step = layer.step || 1;
    const centerFromEdge =
      step === 1 ? firstCenter : firstCenter + (step - 1) * (outerMm + minBarClearanceMm(diaMm));

    bars.push(
      ...buildLayerBars({
        width,
        depth,
        count,
        diaMm,
        // 側面のdtも段ごとの呼び径で構成する
        dtSide: resolveDt(null, coverSide, stirrupOuter, outerMm).value,
        centerFromEdge,
        isTop,
        grade: layer.grade || bar.grade || null,
      }),
    );
  }
  return bars;
}

/**
 * 腹筋を組み立てる
 *
 * STBの本数は左右合計のため、段数 = 本数/2 として上端筋〜下端筋の間へ
 * 等間隔に配置し、各段の左右（側面のdt位置）に1本ずつ置く。
 * 本数が奇数の場合は段数を四捨五入するため、生成本数がSTBの値と1本ずれる
 * （想定配置なので許容する）。
 * @param {Object} webBar - {count, dia}
 * @param {Object} context - 断面コンテキスト
 * @returns {Array<{u:number, v:number, dia:number}>} 腹筋芯の配列
 */
function buildWebBars(webBar, context) {
  const count = webBar?.count || 0;
  if (count <= 0) return [];

  const { width, topV, bottomV, stirrupOuter, coverMm, defaultWebDia } = context;
  const diaMm = barDiameterMm(webBar.dia || defaultWebDia, barDiameterMm(defaultWebDia));
  const outerMm = barOuterDiameterMm(webBar.dia || defaultWebDia, diaMm);
  const halfSpan = width / 2 - (coverMm + stirrupOuter + outerMm / 2);
  if (halfSpan < 0) return [];

  const layerCount = Math.max(1, Math.round(count / 2));
  const bars = [];
  for (let i = 1; i <= layerCount; i++) {
    const v = topV + ((bottomV - topV) * i) / (layerCount + 1);
    bars.push(
      { u: -halfSpan, v, dia: diaMm, role: 'web', grade: webBar.grade || null },
      { u: halfSpan, v, dia: diaMm, role: 'web', grade: webBar.grade || null },
    );
  }
  return bars;
}

/**
 * 断面の1位置分の鉄筋を組み立てる
 * @param {Object} position - positions[key]
 * @param {Object} fallbackCover - 断面共通のかぶり
 * @param {Object} options - {coverMm} 上書き設定
 * @param {number} depth - 代表梁せい [mm]（メッシュの天端基準と揃えるため断面共通）
 * @returns {{bars:Array, estimated:boolean, coverMm:number}|null} 位置ごとの配置
 */
function buildPositionBars(position, fallbackCover, options, depth) {
  const width = position?.width || 0;
  if (width <= 0 || depth <= 0) return null;

  const rules = BEAM_REBAR_PLACEMENT_RULES;
  const cover = position.cover || fallbackCover || {};
  const resolveCover = (value) => options.coverMm ?? value ?? rules.defaultCoverMm;
  const coverTop = resolveCover(cover.top);
  const coverBottom = resolveCover(cover.bottom);
  const coverSide = resolveCover(cover.left ?? cover.right);

  const stirrupDiaName = position.stirrup?.dia || rules.defaultStirrupDia;
  const stirrupOuter = barOuterDiameterMm(stirrupDiaName, barDiameterMm(rules.defaultStirrupDia));

  const topDiaName = position.topBar?.dia || rules.defaultMainBarDia;
  const bottomDiaName = position.bottomBar?.dia || rules.defaultMainBarDia;
  const topOuter = barOuterDiameterMm(topDiaName, barDiameterMm(rules.defaultMainBarDia));

  const shared = {
    width,
    depth,
    stirrupOuter,
    coverSide,
    defaultDia: rules.defaultMainBarDia,
  };

  const topBars = buildSideBars(position.topBar, {
    ...shared,
    coverMm: coverTop,
    isTop: true,
  });
  const bottomBars = buildSideBars(position.bottomBar, {
    ...shared,
    coverMm: coverBottom,
    isTop: false,
  });

  const bars = [...topBars, ...bottomBars];

  // 腹筋は上端筋1段目〜下端筋1段目の間へ入れる
  const topV = topBars.length
    ? Math.max(...topBars.map((bar) => bar.v))
    : depth / 2 - (coverTop + stirrupOuter);
  const bottomV = bottomBars.length
    ? Math.min(...bottomBars.map((bar) => bar.v))
    : -depth / 2 + (coverBottom + stirrupOuter);
  bars.push(
    ...buildWebBars(position.webBar, {
      width,
      topV,
      bottomV,
      stirrupOuter,
      coverMm: coverSide,
      defaultWebDia: rules.defaultWebBarDia,
    }),
  );

  if (bars.length === 0) return null;

  return {
    bars,
    estimated: true,
    coverMm: coverTop,
    dt: {
      top: coverTop + stirrupOuter + topOuter / 2,
      side: resolveDt(null, coverSide, stirrupOuter, topOuter).value,
    },
    mainDia: topDiaName,
    bottomDia: bottomDiaName,
    stirrupDia: stirrupDiaName,
  };
}

/**
 * RC梁断面1つ分の主筋配置を算定する
 *
 * @param {Object} sectionDetail - extractRcBeamSectionDetail の結果
 * @param {Object} [options] - 上書き設定
 * @param {number} [options.coverMm] - かぶり厚さの上書き [mm]
 * @returns {Object|null} 配置結果。算定できない場合は null
 *   {kind, shape, segments, positionPattern, coverMm, mainDia, stirrupDia, estimated}
 */
export function computeBeamRebarSectionLayout(sectionDetail, options = {}) {
  const keys = orderedPositionKeys(sectionDetail);
  if (keys.length === 0) return null;

  // 梁は天端基準で1つの押し出し断面として描かれるため、鉛直位置の基準となる
  // 梁せいは断面共通の代表値（先頭位置）を使う。
  // RC梁のメッシュ生成側（viewer/geometry/generators/ProfileBasedBeamGenerator.js）が
  // 単一断面の押し出しで描いていることが前提。ビューアがせい変化に対応した際は
  // ここも区間ごとのせいへ追従させる必要がある。
  const depth = sectionDetail.positions[keys[0]]?.depth || 0;
  if (depth <= 0) return null;

  const ranges = resolveSpanRanges(keys);
  const segments = [];
  let meta = null;

  for (const { key, startRatio, endRatio } of ranges) {
    const built = buildPositionBars(
      sectionDetail.positions[key],
      sectionDetail.cover,
      options,
      depth,
    );
    if (!built) continue;
    segments.push(createSegment(startRatio, endRatio, built.bars));
    meta = meta || built;
  }

  if (segments.length === 0) return null;

  return {
    kind: 'beamMain',
    shape: 'RECTANGLE',
    depth,
    segments,
    sectionName: sectionDetail.name || null,
    concreteStrength: sectionDetail.concrete?.strength || null,
    positionPattern: sectionDetail.positionPattern || 'SAME',
    coverMm: meta.coverMm,
    dt: meta.dt,
    mainDia: meta.mainDia,
    stirrupDia: meta.stirrupDia,
    estimated: true,
  };
}

/**
 * STB文書からRC梁断面ID → 主筋配置のマップを作る
 *
 * 大梁と小梁は断面IDの採番空間が独立しているため、既存の
 * `girderSections` / `beamSections` と同様にマップを分けて返す。
 * @param {Document} xmlDoc - STB XMLドキュメント
 * @param {Object} [options] - computeBeamRebarSectionLayout に渡す設定
 * @returns {{girder: Map<string, Object>, beam: Map<string, Object>}} 断面ID → 配置結果
 */
export function buildBeamRebarLayoutMaps(xmlDoc, options = {}) {
  const girder = new Map();
  const beam = new Map();
  if (!xmlDoc) return { girder, beam };

  for (const tagName of ['StbSecGirder_RC', 'StbSecBeam_RC']) {
    for (const element of querySelectorAll(xmlDoc, tagName)) {
      const detail = extractRcBeamSectionDetail(element);
      if (!detail?.id) continue;
      const layout = computeBeamRebarSectionLayout(detail, options);
      if (!layout) continue;
      (isGirderSection(element) ? girder : beam).set(detail.id, layout);
    }
  }
  return { girder, beam };
}
