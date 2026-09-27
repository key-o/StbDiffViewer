/**
 * @fileoverview ST-Bridge RC連続基礎のMAIN_BASE / MAIN_TIP切替区間を解決する純粋関数。
 *
 * 仕様根拠:
 * - length は、StbStripFooting の始終端基準点を結ぶ部材軸（local Y=0）から
 *   元端主筋(MAIN_BASE)端部までの距離。
 * - REVERSE_T で主筋切替がある場合、main_type は SYMMETRICAL / ASYMMETRICAL。
 * - RIGHT_L / LEFT_L では main_type を記述しない。
 *
 * このモジュールは区間契約だけを扱い、RebarPath生成への接続はplacement層の責務とする。
 */

const EPS = 1e-6;
const MAIN_BASE_POSITIONS = new Set(['MAIN_BASE_TOP', 'MAIN_BASE_BOTTOM']);
const MAIN_TIP_POSITIONS = new Set(['MAIN_TIP_TOP', 'MAIN_TIP_BOTTOM']);
const MAIN_POSITIONS = new Set([...MAIN_BASE_POSITIONS, ...MAIN_TIP_POSITIONS]);
const REVERSE_T_MAIN_TYPES = new Set(['SYMMETRICAL', 'ASYMMETRICAL']);

function unresolved(reason, extra = {}) {
  return {
    status: 'UNRESOLVED',
    reason,
    intervals: [],
    ...extra,
  };
}

function cleanIntervals(intervals) {
  return intervals.filter(
    ([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end - start > EPS,
  );
}

/**
 * REVERSE_T の主筋切替区間を布基礎local Yで返す。
 *
 * page 25 の main_type 図を区間として正規化する:
 * - SYMMETRICAL
 *   - MAIN_BASE: 中央区間 [-length, +length]
 *   - MAIN_TIP : 左右外側区間 [minY, -length], [+length, maxY]
 * - ASYMMETRICAL
 *   - MAIN_BASE: 下端側(minY)から +length まで
 *   - MAIN_TIP : -length から上端側(maxY)まで
 *
 * @param {Object} input
 * @param {string} input.position MAIN_BASE_TOP/BOTTOM or MAIN_TIP_TOP/BOTTOM
 * @param {string} input.mainType SYMMETRICAL or ASYMMETRICAL
 * @param {number} input.lengthMm 部材軸からMAIN_BASE端部までの距離
 * @param {number} input.halfWidthMm 布基礎幅の1/2
 * @param {number} [input.sideInsetMm=0] 側面かぶり+鉄筋半径など、外端からの中心線控え
 * @returns {{status:string,reason?:string,intervals:Array<Array<number>>,basis?:string}}
 */
export function resolveReverseTMainSwitchIntervals({
  position,
  mainType,
  lengthMm,
  halfWidthMm,
  sideInsetMm = 0,
} = {}) {
  const normalizedPosition = String(position || '').toUpperCase();
  const normalizedMainType = String(mainType || '').toUpperCase();

  if (!MAIN_POSITIONS.has(normalizedPosition)) {
    return unresolved('MAIN_POSITION_UNSUPPORTED', { position: normalizedPosition || null });
  }
  if (!REVERSE_T_MAIN_TYPES.has(normalizedMainType)) {
    return unresolved('MAIN_TYPE_UNRESOLVED', { mainType: normalizedMainType || null });
  }
  if (!(Number.isFinite(halfWidthMm) && halfWidthMm > 0)) {
    return unresolved('HALF_WIDTH_INVALID');
  }
  if (!(Number.isFinite(sideInsetMm) && sideInsetMm >= 0 && sideInsetMm < halfWidthMm)) {
    return unresolved('SIDE_INSET_INVALID');
  }
  if (!(Number.isFinite(lengthMm) && lengthMm > 0)) {
    return unresolved('SWITCH_LENGTH_UNRESOLVED');
  }

  const minY = -halfWidthMm + sideInsetMm;
  const maxY = halfWidthMm - sideInsetMm;
  const negativeSwitchY = -lengthMm;
  const positiveSwitchY = lengthMm;

  if (!(negativeSwitchY > minY + EPS && positiveSwitchY < maxY - EPS)) {
    return unresolved('SWITCH_LENGTH_OUTSIDE_REBAR_SPAN', {
      minY,
      maxY,
      negativeSwitchY,
      positiveSwitchY,
    });
  }

  const isBase = MAIN_BASE_POSITIONS.has(normalizedPosition);
  let intervals;
  if (normalizedMainType === 'SYMMETRICAL') {
    intervals = isBase
      ? [[negativeSwitchY, positiveSwitchY]]
      : [
          [minY, negativeSwitchY],
          [positiveSwitchY, maxY],
        ];
  } else {
    intervals = isBase ? [[minY, positiveSwitchY]] : [[negativeSwitchY, maxY]];
  }

  return {
    status: 'READY',
    intervals: cleanIntervals(intervals),
    basis: `STB_REVERSE_T_MAIN_SWITCH_${normalizedMainType}`,
    position: normalizedPosition,
    mainType: normalizedMainType,
    lengthMm,
    minY,
    maxY,
    negativeSwitchY,
    positiveSwitchY,
  };
}

/**
 * main_type の記述可否を仕様通りに判定する。
 * RIGHT_L / LEFT_L は main_type を持たず、REVERSE_T の主筋切替時だけ使用する。
 */
export function validateContinuousMainType({ shapeType, position, mainType, hasSwitch } = {}) {
  const shape = String(shapeType || '').toUpperCase();
  const pos = String(position || '').toUpperCase();
  const type = mainType == null || mainType === '' ? null : String(mainType).toUpperCase();
  const isMain = MAIN_POSITIONS.has(pos);

  if (!isMain) {
    return type == null
      ? { status: 'READY', mainType: null }
      : unresolved('MAIN_TYPE_NOT_ALLOWED_FOR_NON_MAIN', { mainType: type });
  }
  if (shape === 'RIGHT_L' || shape === 'LEFT_L') {
    return type == null
      ? { status: 'READY', mainType: null }
      : unresolved('MAIN_TYPE_NOT_ALLOWED_FOR_ONE_SIDED_SHAPE', { mainType: type });
  }
  if (shape !== 'REVERSE_T') {
    return unresolved('SHAPE_TYPE_UNSUPPORTED', { shapeType: shape || null });
  }
  if (!hasSwitch) {
    return type == null
      ? { status: 'READY', mainType: null }
      : unresolved('MAIN_TYPE_NOT_ALLOWED_WITHOUT_SWITCH', { mainType: type });
  }
  if (!REVERSE_T_MAIN_TYPES.has(type)) {
    return unresolved('MAIN_TYPE_UNRESOLVED', { mainType: type });
  }
  return { status: 'READY', mainType: type };
}

export const _stripFootingMainSwitchInternals = Object.freeze({
  MAIN_BASE_POSITIONS,
  MAIN_TIP_POSITIONS,
  MAIN_POSITIONS,
  REVERSE_T_MAIN_TYPES,
  cleanIntervals,
});
