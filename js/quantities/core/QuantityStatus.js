/**
 * @fileoverview 派生数量計算の状態定義。
 *
 * 数量計算では「計算不能」と「0」を混同しない。計算結果を返せない場合は
 * 必ず status と null 値で理由を保持する。
 */

export const QuantityStatus = Object.freeze({
  CALCULATED: 'CALCULATED',
  PARTIAL: 'PARTIAL',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
  UNSUPPORTED: 'UNSUPPORTED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  INVALID_GEOMETRY: 'INVALID_GEOMETRY',
});

const QUANTITY_STATUS_VALUES = new Set(Object.values(QuantityStatus));

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isQuantityStatus(value) {
  return QUANTITY_STATUS_VALUES.has(value);
}
