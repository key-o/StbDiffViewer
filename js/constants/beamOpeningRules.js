/**
 * @fileoverview 梁貫通孔補強・主筋カットオフの設計ルール定数
 *
 * 貫通孔配置可能範囲の判定条件は、貫通孔補強工法（ダイヤレンNS等）の
 * 設計指針に基づく一般的な条件を採用する。
 * ST-Bridgeデータには貫通孔可否の情報が含まれないため、
 * 梁せいD・スパンL0・主筋径dから機械的に算定する目安値である。
 *
 * @module constants/beamOpeningRules
 */

/**
 * 貫通孔（丸孔）の配置ルール
 * 出典: ダイヤレンNS設計指針（コーリョー建販）等の一般的条件
 * @constant {Object}
 */
export const BEAM_OPENING_RULES = {
  /** 孔径上限: 梁せいDに対する比率（H ≤ D/3） */
  maxDiameterDepthRatio: 1 / 3,
  /** 孔径上限の絶対値 [mm]（H ≤ 750mm） */
  maxDiameterMm: 750,
  /** 孔中心の柱面からの必要距離: 梁せいD に対する倍率（L' ≥ 1.0D） */
  endClearanceDepthRatio: 1.0,
  /** 隣接孔の中心間距離: 孔径に対する倍率（L ≥ 3H。孔径が異なる場合は平均径の3倍） */
  minCenterSpacingDiameterRatio: 3.0,
  /** 孔中心の上下方向の目安: 梁せい中心（0.5D）に配置 */
  verticalCenterDepthRatio: 0.5,
};

export { REBAR_CUTOFF_RULES } from './rebarCutoffRules.js';
export { REBAR_ANCHORAGE_RULES } from './rebarAnchorageRules.js';

/**
 * 主筋のあき（隣接鉄筋の純間隔）ルール
 *
 * あきの最小値は「呼び径の1.5倍」「粗骨材最大寸法の1.25倍」「25mm」の
 * いずれか大きい値とするのが一般的（RC規準）。段間のあきも同様に扱う。
 * @constant {Object}
 */
export const REBAR_SPACING_RULES = {
  /** あきの呼び径倍率の既定値（1.5d） */
  defaultClearanceDiaFactor: 1.5,
  /** UIで選択できる呼び径倍率 */
  clearanceDiaFactorOptions: [1.5, 2.0, 2.5],
  /** あきの絶対最小値 [mm] */
  minClearanceMm: 25,
  /** 粗骨材最大寸法 [mm]（既定20mm） */
  maxAggregateSizeMm: 20,
  /** 粗骨材最大寸法に対する倍率（1.25倍） */
  aggregateFactor: 1.25,
  /** かぶり厚さの既定値 [mm]（屋内梁の設計かぶり） */
  defaultCoverMm: 40,
};

/**
 * 主筋のあき最小値を算定する。
 * @param {number} diaMm - 主筋の呼び径 [mm]
 * @param {Object} [options] - {clearanceDiaFactor, maxAggregateSizeMm}
 * @returns {number} あきの最小値 [mm]
 */
export function minBarClearanceMm(diaMm, options = {}) {
  const factor = options.clearanceDiaFactor ?? REBAR_SPACING_RULES.defaultClearanceDiaFactor;
  const aggregate = options.maxAggregateSizeMm ?? REBAR_SPACING_RULES.maxAggregateSizeMm;
  return Math.max(
    factor * diaMm,
    REBAR_SPACING_RULES.aggregateFactor * aggregate,
    REBAR_SPACING_RULES.minClearanceMm,
  );
}

/**
 * 異形鉄筋の最大外径 [mm]（JIS G 3112 の節を含む外径）。
 * 主筋・あばら筋の実配置位置は呼び径ではなく最大外径で決まる。
 * @constant {Object<string, number>}
 */
const BAR_OUTER_DIAMETERS = {
  D10: 11,
  D13: 14,
  D16: 18,
  D19: 21,
  D22: 25,
  D25: 28,
  D29: 33,
  D32: 36,
  D35: 40,
  D38: 43,
  D41: 46,
};

/** 表にない呼び径から最大外径を推定する倍率 */
const OUTER_DIAMETER_FALLBACK_FACTOR = 1.1;

/**
 * 鉄筋の最大外径 [mm] を取得する。
 * @param {string|number|null} dia - 呼び名（'D25'）または呼び径[mm]
 * @param {number} [fallback=25] - 解析不能時の呼び径
 * @returns {number} 最大外径 [mm]
 */
export function barOuterDiameterMm(dia, fallback = 25) {
  const nominal = barDiameterMm(dia, fallback);
  const key = `D${Math.round(nominal)}`;
  return BAR_OUTER_DIAMETERS[key] ?? nominal * OUTER_DIAMETER_FALLBACK_FACTOR;
}

/**
 * 腹筋（幅止め筋を含む）の必要本数ルール。
 * 出典: RC造配筋標準図「幅止め筋本数、腹筋段数と梁せいの関係」
 * @constant {Object}
 */
export const WEB_BAR_RULES = {
  /** 基礎梁の腹筋（梁せいの下限[mm]・段数・本数・呼び名） */
  foundation: [
    { minDepth: 0, layers: 0, count: 0, dia: null },
    { minDepth: 600, layers: 1, count: 2, dia: 'D10', altDia: 'D13' },
    { minDepth: 1050, layers: 2, count: 4, dia: 'D10', altDia: 'D13' },
    { minDepth: 1500, layers: 3, count: 6, dia: 'D13' },
    { minDepth: 1950, layers: 4, count: 8, dia: 'D13' },
  ],
  /** 一般梁の腹筋 */
  general: [
    { minDepth: 0, layers: 0, count: 0, dia: null },
    { minDepth: 600, layers: 1, count: 2, dia: 'D10' },
    { minDepth: 900, layers: 2, count: 4, dia: 'D10' },
    { minDepth: 1200, layers: 3, count: 6, dia: 'D10' },
  ],
  /** 幅止め筋 */
  widthStopBar: { dia: 'D10', maxPitchMm: 1000 },
  /** 腹筋・幅止め筋のかぶり側からの目安距離: 呼び径dに対する倍率（4d程度） */
  edgeDistanceDiaFactor: 4,
};

/**
 * 梁せいから必要な腹筋を求める。
 * @param {number} depthMm - 梁せい [mm]
 * @param {boolean} [isFoundation=false] - 基礎梁か
 * @returns {{required:boolean, layers:number, count:number, dia:string|null,
 *            altDia:string|null, text:string}}
 */
export function resolveWebBarRequirement(depthMm, isFoundation = false) {
  const table = isFoundation ? WEB_BAR_RULES.foundation : WEB_BAR_RULES.general;
  let matched = table[0];
  for (const row of table) {
    if (depthMm >= row.minDepth) matched = row;
  }

  if (!matched.count) {
    return { required: false, layers: 0, count: 0, dia: null, altDia: null, text: '不要' };
  }
  const alt = matched.altDia ? ` または${matched.count}-${matched.altDia}` : '';
  return {
    required: true,
    layers: matched.layers,
    count: matched.count,
    dia: matched.dia,
    altDia: matched.altDia || null,
    text: `${matched.count}-${matched.dia}（${matched.layers}段）${alt}`,
  };
}

/**
 * 鉄筋呼び名（'D25' 等）から呼び径[mm]を取得する。
 * @param {string|null} dia - 鉄筋呼び名（'D25' / 'T25' 等）
 * @param {number} [fallback=25] - 解析不能時の径
 * @returns {number} 呼び径 [mm]
 */
export function barDiameterMm(dia, fallback = 25) {
  const matched = String(dia || '').match(/(\d+(?:\.\d+)?)/);
  const value = matched ? parseFloat(matched[1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
