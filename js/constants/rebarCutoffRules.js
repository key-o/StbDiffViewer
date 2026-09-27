/**
 * @fileoverview 柱・梁主筋のカットオフ筋長さのルール
 *
 * 出典: 日本建設業連合会「鉄筋コンクリート造配筋標準図」(2013.03.27 改訂)
 * §7-1 柱の定着・カットオフ筋長さおよび継手位置 / §8-1 大梁カットオフ筋長さ /
 * §9-1 小梁の定着・カットオフ筋長さ。
 *
 * ST-Bridgeにはカットオフ位置の情報が含まれないため、標準図の一般値から
 * 機械的に算定した目安である。実際の値は構造図による。
 *
 * @module constants/rebarCutoffRules
 */

import { REBAR_STANDARD_RULES } from './rebarStandardRules.js';

/**
 * 梁主筋のカットオフ基準（梁貫通孔検討・区間割りと共用する一般値）
 * @constant {Object}
 */
export const REBAR_CUTOFF_RULES = {
  /** P0-A以降の既定値の基準標準図 */
  sourceStandardId: REBAR_STANDARD_RULES.standardId,
  /** カットオフ基準位置: 内法スパンLoに対する比率（Lo/4） */
  cutoffSpanRatio: 0.25,
  /** カットオフ余長: 主筋径dに対する倍率（15d以上） */
  cutoffExtensionDiaFactor: 15,
};

/**
 * 柱頭・柱脚カットオフ筋のルール（§7-1 4.）
 *
 * 柱頭カットオフ筋長さ: 柱に取り付く最も低い梁下端から Ho/2+15d 以上
 * 柱脚カットオフ筋長さ: 柱に取り付く最も高い梁天端から Ho/2+15d 以上
 * Ho は柱の最大内法高さ。
 * @constant {Object}
 */
const COLUMN_CUTOFF_RULES = {
  /** 内法高さHoに対する比率（Ho/2） */
  clearHeightRatio: 0.5,
  /** 余長: 呼び径dに対する倍率（+15d） */
  extensionDiaFactor: 15,
};

/**
 * 大梁・小梁のカットオフ筋のルール（§8-1 / §9-1）
 *
 * 端部カットオフ筋は内法スパンの Lo/4 位置＋15d、中央カットオフ筋は
 * 端から Lo/4 位置＋20d を基準とする。小梁の下端筋は Lo/6 を基準とする。
 * @constant {Object}
 */
const BEAM_CUTOFF_RULES = {
  /** 端部カットオフ筋の基準位置: 内法スパンLoに対する比率（Lo/4） */
  endSpanRatio: 1 / 4,
  /** 端部カットオフ筋の余長: 呼び径dに対する倍率（15d） */
  endExtensionDiaFactor: 15,
  /** 中央カットオフ筋の基準位置: 柱面からの内法スパン比率（Lo/4） */
  centerSpanRatio: 1 / 4,
  /** 中央カットオフ筋の余長: 呼び径dに対する倍率（20d） */
  centerExtensionDiaFactor: 20,
  /** 小梁下端筋のカットオフ基準位置: 内法スパンLoに対する比率（Lo/6） */
  smallBeamBottomSpanRatio: 1 / 6,
};

/**
 * 柱頭・柱脚カットオフ筋の必要長さを算定する（§7-1 4.）
 * @param {number} clearHeightMm - 柱の最大内法高さ Ho [mm]
 * @param {number} barDiaMm - 主筋の呼び径 [mm]
 * @returns {number} 基準面からの必要長さ [mm]
 */
export function columnCutoffLengthMm(clearHeightMm, barDiaMm) {
  const rules = COLUMN_CUTOFF_RULES;
  return Math.max(0, clearHeightMm) * rules.clearHeightRatio + rules.extensionDiaFactor * barDiaMm;
}

/**
 * 梁カットオフ筋の基準位置と余長を求める（§8-1 / §9-1）
 *
 * 端部（柱面側）で止まる筋は Lo/4＋15d、中央側で止まる筋は Lo/4＋20d とし、
 * 小梁の下端筋だけ基準位置を Lo/6 に置き換える。
 * @param {Object} params - 算定パラメータ
 * @param {number} params.clearSpanMm - 内法スパン Lo [mm]
 * @param {number} params.barDiaMm - 主筋の呼び径 [mm]
 * @param {boolean} params.atEnd - 端部カットオフ筋か（false は中央カットオフ筋）
 * @param {boolean} [params.isSmallBeam] - 小梁か
 * @param {string} [params.role] - 主筋の役割（'top' | 'bottom'）
 * @returns {{spanMm:number, extensionMm:number, totalMm:number}} 柱面からの基準位置と余長
 */
export function beamCutoffLengthMm({ clearSpanMm, barDiaMm, atEnd, isSmallBeam, role }) {
  const rules = BEAM_CUTOFF_RULES;
  const useSmallBeamBottom = Boolean(isSmallBeam) && role === 'bottom';
  const ratio = useSmallBeamBottom
    ? rules.smallBeamBottomSpanRatio
    : atEnd
      ? rules.endSpanRatio
      : rules.centerSpanRatio;
  const factor = atEnd ? rules.endExtensionDiaFactor : rules.centerExtensionDiaFactor;

  const spanMm = Math.max(0, clearSpanMm) * ratio;
  const extensionMm = factor * barDiaMm;
  return { spanMm, extensionMm, totalMm: spanMm + extensionMm };
}
