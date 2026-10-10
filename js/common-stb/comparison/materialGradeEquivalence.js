/**
 * @fileoverview 材料・鉄筋強度記号の等価比較用正規化
 *
 * ST-Bridge 比較では、同じ強度グレード群の末尾区分 A/B/C を
 * 表記差として吸収する。元XMLの値は変更せず、比較時だけ正規化する。
 */

const SUFFIX_EQUIVALENCE_PATTERN = /^(SD|SN|SM|SNR)(\d{3})(Y?)[ABC]$/;

/**
 * 比較用の材料グレード記号へ正規化する。
 *
 * 例:
 * - SD295 / SD295A / SD295B -> SD295
 * - SN400 / SN400A / SN400B / SN400C -> SN400
 * - SN490B / SN490C -> SN490
 * - SM490YA / SM490YB -> SM490Y
 *
 * 上記以外の記号は大文字化・trimのみ行い、そのまま比較する。
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeMaterialGradeForEquivalence(value) {
  if (value === null || value === undefined) return null;
  const token = String(value).trim().toUpperCase();
  if (!token) return null;

  const match = token.match(SUFFIX_EQUIVALENCE_PATTERN);
  if (!match) return token;

  const [, prefix, strength, variant] = match;
  return `${prefix}${strength}${variant}`;
}

/**
 * 2つの材料記号が比較上等価か判定する。
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function areMaterialGradesEquivalent(a, b) {
  const normalizedA = normalizeMaterialGradeForEquivalence(a);
  const normalizedB = normalizeMaterialGradeForEquivalence(b);
  return Boolean(normalizedA && normalizedB && normalizedA === normalizedB);
}
