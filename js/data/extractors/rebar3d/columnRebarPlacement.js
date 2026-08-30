/**
 * @fileoverview RC柱主筋の断面内配置算定（3D配筋用）
 *
 * 柱断面の配筋情報（本数・呼び径・かぶり・dt）から、主筋芯の断面内座標を求める。
 * ST-Bridgeには鉄筋の3次元位置が含まれないため、ここでの位置は
 * かぶり・dt の設定から構成した想定配置である（梁貫通孔検討と同じ考え方）。
 *
 * 柱頭・柱脚で本数が異なる断面（NotSame）は、本数の少ない側を通し筋として
 * 全長に描き、多い側との差分を「柱頭／柱脚カットオフ筋」として切り出す。
 * カットオフ筋の長さは柱の内法高さに依存するため、ここでは断面内座標だけを
 * 持ち、材軸方向の範囲は columnAnchoragePlacement が部材ごとに決める。
 *
 * 座標系は断面ローカルで、断面中心が原点。
 * u はSTBのX方向（width_X）、v はSTBのY方向（width_Y）に対応する。
 * これは viewer の矩形/円形プロファイル（原点中心）とそのまま一致する。
 *
 * @module data/extractors/rebar3d/columnRebarPlacement
 */

import { barDiameterMm, barOuterDiameterMm } from '../../../constants/beamOpeningRules.js';
import { COLUMN_REBAR_PLACEMENT_RULES } from '../../../constants/rebarPlacementRules.js';
import { extractRcColumnSections } from '../columnSectionListExtractor.js';
import { createSegment, evenlySpaced, pickExtraBars, resolveDt } from './rebarSectionUtils.js';

/**
 * 矩形柱の周囲配筋（1段目）を組み立てる
 * @param {Object} params - 配置パラメータ
 * @param {number} params.width - 断面幅 X [mm]
 * @param {number} params.height - 断面幅 Y [mm]
 * @param {number} params.dtX - X方向のdt [mm]
 * @param {number} params.dtY - Y方向のdt [mm]
 * @param {number} params.countX - X方向の本数（上下辺の本数）
 * @param {number} params.countY - Y方向の本数（左右辺の本数）
 * @param {number} params.diaMm - 主筋の呼び径 [mm]
 * @param {string|null} params.grade - 鉄筋種別
 * @returns {Array<{u:number, v:number, dia:number, corner:boolean, grade:string|null}>} 主筋芯
 */
function buildRectPerimeterBars({ width, height, dtX, dtY, countX, countY, diaMm, grade }) {
  const halfSpanX = width / 2 - dtX;
  const halfSpanY = height / 2 - dtY;
  const { minInnerSpanMm } = COLUMN_REBAR_PLACEMENT_RULES;
  if (halfSpanX * 2 < minInnerSpanMm || halfSpanY * 2 < minInnerSpanMm) return [];

  const xs = evenlySpaced(-halfSpanX, halfSpanX, countX);
  const ys = evenlySpaced(-halfSpanY, halfSpanY, countY);
  if (xs.length === 0 || ys.length === 0) return [];

  const bars = [];
  const push = (u, v, corner) => bars.push({ u, v, dia: diaMm, corner, grade: grade || null });

  // 下辺・上辺（Y方向の両端）にX方向の本数を並べる。両端は四隅
  for (const [index, u] of xs.entries()) {
    const isEdgeX = index === 0 || index === xs.length - 1;
    push(u, ys[0], isEdgeX);
    if (ys.length > 1) push(u, ys[ys.length - 1], isEdgeX);
  }
  // 左辺・右辺（X方向の両端）は角を除いた中間のみ
  for (let i = 1; i < ys.length - 1; i++) {
    push(xs[0], ys[i], false);
    if (xs.length > 1) push(xs[xs.length - 1], ys[i], false);
  }
  return bars;
}

/**
 * 円形柱の周囲配筋（1段目）を組み立てる
 *
 * 円形柱には四隅が無いため、180°フックの対象（corner）は付けない。
 * @param {Object} params - 配置パラメータ
 * @param {number} params.diameter - 断面直径 [mm]
 * @param {number} params.dt - dt [mm]
 * @param {number} params.count - 主筋本数
 * @param {number} params.diaMm - 主筋の呼び径 [mm]
 * @param {string|null} params.grade - 鉄筋種別
 * @returns {Array<{u:number, v:number, dia:number, corner:boolean, grade:string|null}>} 主筋芯
 */
function buildCircleBars({ diameter, dt, count, diaMm, grade }) {
  const radius = diameter / 2 - dt;
  if (radius <= 0 || count <= 0) return [];
  return Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2;
    return {
      u: radius * Math.cos(angle),
      v: radius * Math.sin(angle),
      dia: diaMm,
      corner: false,
      grade: grade || null,
    };
  });
}

/**
 * 配筋1組（SAME / TOP / BOTTOM のいずれか）から主筋芯と dt を組み立てる
 * @param {Object} dimensions - 断面寸法
 * @param {Object} arrangement - {mainBar, hoop, cover}
 * @param {Object} options - {coverMm}
 * @returns {Object|null} {bars, dt, coverMm, hoopDia, mainDia, estimated}
 */
function buildArrangement(dimensions, arrangement, options) {
  const mainBar = arrangement?.mainBar;
  if (!mainBar) return null;

  const rules = COLUMN_REBAR_PLACEMENT_RULES;
  const coverMm = options.coverMm ?? arrangement.cover ?? rules.defaultCoverMm;
  const mainDiaName = mainBar.dia || rules.defaultMainBarDia;
  const hoopDiaName = arrangement.hoop?.dia || rules.defaultHoopDia;
  const mainDiaMm = barDiameterMm(mainDiaName, barDiameterMm(rules.defaultMainBarDia));
  const mainOuterMm = barOuterDiameterMm(mainDiaName, mainDiaMm);
  const hoopOuterMm = barOuterDiameterMm(hoopDiaName, barDiameterMm(rules.defaultHoopDia));
  const grade = mainBar.grade || null;

  if (dimensions.type === 'CIRCLE') {
    const diameter = dimensions.diameter || 0;
    const count = mainBar.countTotal || mainBar.count || 0;
    if (diameter <= 0 || count <= 0) return null;

    const dt = resolveDt(mainBar.dt, coverMm, hoopOuterMm, mainOuterMm);
    const bars = buildCircleBars({ diameter, dt: dt.value, count, diaMm: mainDiaMm, grade });
    if (bars.length === 0) return null;
    return {
      bars,
      dt: { r: dt.value },
      coverMm,
      hoopDia: hoopDiaName,
      mainDia: mainDiaName,
      estimated: dt.estimated,
    };
  }

  const width = dimensions.width || 0;
  const height = dimensions.height || 0;
  const countX = mainBar.countX || 0;
  const countY = mainBar.countY || 0;
  if (width <= 0 || height <= 0 || countX <= 0 || countY <= 0) return null;

  const dtX = resolveDt(mainBar.dtX, coverMm, hoopOuterMm, mainOuterMm);
  const dtY = resolveDt(mainBar.dtY, coverMm, hoopOuterMm, mainOuterMm);
  const bars = buildRectPerimeterBars({
    width,
    height,
    dtX: dtX.value,
    dtY: dtY.value,
    countX,
    countY,
    diaMm: mainDiaMm,
    grade,
  });
  if (bars.length === 0) return null;

  return {
    bars,
    dt: { x: dtX.value, y: dtY.value },
    coverMm,
    hoopDia: hoopDiaName,
    mainDia: mainDiaName,
    estimated: dtX.estimated || dtY.estimated,
  };
}

/**
 * 柱頭・柱脚の配筋差からカットオフ筋を切り出す
 * @param {Object} dimensions - 断面寸法
 * @param {Array<Object>} arrangements - 配筋の一覧（position を持つ）
 * @param {Object} options - {coverMm}
 * @returns {{through:Object, cutoff:{zone:string, bars:Array}|null}|null} 通し筋とカットオフ筋
 */
function splitByPosition(dimensions, arrangements, options) {
  const byPosition = (position) => arrangements.find((item) => item.position === position);
  const top = buildArrangement(dimensions, byPosition('TOP'), options);
  const bottom = buildArrangement(dimensions, byPosition('BOTTOM'), options);
  if (!top || !bottom) return null;

  // 本数が同じなら柱頭・柱脚を作り分ける必要はない（配筋差なし）
  if (top.bars.length === bottom.bars.length) return { through: bottom, cutoff: null };

  const more = top.bars.length > bottom.bars.length ? top : bottom;
  const through = more === top ? bottom : top;
  return {
    through,
    cutoff: {
      zone: more === top ? 'top' : 'bottom',
      bars: pickExtraBars(more.bars, through.bars),
    },
  };
}

/**
 * 柱断面1つ分の主筋配置（1段目のみ）を算定する
 *
 * @param {Object} sectionDetail - columnSectionListExtractor の断面詳細
 * @param {Object} [options] - 上書き設定
 * @param {number} [options.coverMm] - かぶり厚さの上書き [mm]
 * @returns {Object|null} 配置結果。算定できない場合は null
 *   {kind, shape, width, height, diameter, segments, cutoff, dt, coverMm, hoopDia, mainDia, estimated}
 */
export function computeColumnRebarSectionLayout(sectionDetail, options = {}) {
  const dimensions = sectionDetail?.dimensions;
  if (!dimensions?.type) return null;

  const arrangements = sectionDetail.arrangements || [];
  const split = splitByPosition(dimensions, arrangements, options);
  const built =
    split?.through ??
    buildArrangement(
      dimensions,
      { mainBar: sectionDetail.mainBar, hoop: sectionDetail.hoop, cover: sectionDetail.cover },
      options,
    );
  if (!built) return null;

  const shape = dimensions.type === 'CIRCLE' ? 'CIRCLE' : 'RECTANGLE';
  return {
    kind: 'columnMain',
    shape,
    ...(shape === 'CIRCLE'
      ? { diameter: dimensions.diameter || 0 }
      : { width: dimensions.width || 0, height: dimensions.height || 0 }),
    // 通し筋は全長にわたって同じ配筋を描くため、材軸方向は1区間のみ
    segments: [createSegment(0, 1, built.bars)],
    /** 柱頭／柱脚のみに必要な鉄筋。材軸方向の範囲は部材ごとに決める */
    cutoff: split?.cutoff || null,
    sectionName: sectionDetail.name || null,
    dt: built.dt,
    coverMm: built.coverMm,
    hoopDia: built.hoopDia,
    mainDia: built.mainDia,
    estimated: built.estimated,
  };
}

/**
 * STB文書からRC柱断面ID → 主筋配置のマップを作る
 *
 * @param {Document} xmlDoc - STB XMLドキュメント
 * @param {Object} [options] - computeColumnRebarSectionLayout に渡す設定
 * @returns {Map<string, Object>} 断面ID → 配置結果
 */
export function buildColumnRebarLayoutMap(xmlDoc, options = {}) {
  const layouts = new Map();
  if (!xmlDoc) return layouts;

  for (const [sectionId, detail] of extractRcColumnSections(xmlDoc)) {
    const layout = computeColumnRebarSectionLayout(detail, options);
    if (layout) layouts.set(sectionId, layout);
  }
  return layouts;
}
