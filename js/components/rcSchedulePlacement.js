/**
 * @fileoverview RC柱・梁断面リスト共通の配筋位置解決ヘルパー
 *
 * 柱・梁で「面からの作図距離」と「主筋重心位置」の扱いを揃えるため、
 * 0を許容するかぶり系の距離と、正値のみを有効とするcenter系の距離を
 * ここで一元的に解決する。
 */

function finiteDistance(value, allowZero) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (allowZero ? parsed >= 0 : parsed > 0) return parsed;
  return null;
}

/**
 * 断面4面の距離を正規化する。
 * @param {number|Object|null} value - スカラーまたは面別値
 * @param {string[]} keys - 面キー
 * @param {Object} fallbackFaces - 面別既定値
 * @returns {Object}
 */
export function normalizeRcScheduleFaces(value, keys, fallbackFaces) {
  const scalar = finiteDistance(value, true);
  const source =
    scalar !== null ? Object.fromEntries(keys.map((key) => [key, scalar])) : value || {};

  return Object.fromEntries(
    keys.map((key) => [
      key,
      finiteDistance(source[key], true) ?? finiteDistance(fallbackFaces?.[key], true) ?? 0,
    ]),
  );
}

/**
 * 主筋重心位置を面別に解決する。
 * center_* の正値を優先し、欠損/0の場合だけ面距離+共通オフセットで補う。
 * @param {Object|null} centers - 面別center値
 * @param {Object} coverFaces - 面別かぶり/HOOP芯距離
 * @param {string[]} keys - 面キー
 * @param {number|Object} offset - スカラーまたは面別オフセット
 * @returns {Object}
 */
export function resolveRcScheduleMainFaces(centers, coverFaces, keys, offset) {
  const source = centers || {};
  const scalarOffset = finiteDistance(offset, true);

  return Object.fromEntries(
    keys.map((key) => {
      const explicit = finiteDistance(source[key], false);
      const faceOffset = scalarOffset ?? finiteDistance(offset?.[key], true) ?? 0;
      return [key, explicit ?? Number(coverFaces?.[key] || 0) + faceOffset];
    }),
  );
}

/**
 * 4面のいずれかに有限値があるか判定する。
 * @param {number|Object|null} value
 * @param {string[]} keys
 */
export function hasRcScheduleFaceValue(value, keys) {
  if (finiteDistance(value, true) !== null) return true;
  return keys.some((key) => finiteDistance(value?.[key], true) !== null);
}
