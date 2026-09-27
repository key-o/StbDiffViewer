/**
 * @fileoverview ST-Bridge の mm 基準数量と表示単位の変換 helper。
 */

const MM2_PER_M2 = 1_000_000;
const MM3_PER_M3 = 1_000_000_000;

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return number;
}

export function mm2ToM2(value) {
  return finiteNumber(value, 'area') / MM2_PER_M2;
}

export function m2ToMm2(value) {
  return finiteNumber(value, 'area') * MM2_PER_M2;
}

export function mm3ToM3(value) {
  return finiteNumber(value, 'volume') / MM3_PER_M3;
}

export function m3ToMm3(value) {
  return finiteNumber(value, 'volume') * MM3_PER_M3;
}
