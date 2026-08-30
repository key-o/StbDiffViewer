/**
 * @fileoverview XML DOM要素とplain objectに共通する属性アクセサ
 */

/**
 * XML DOM要素またはplain objectから属性値を取得する。
 * 欠損値は常に `missingValue` へ正規化する。
 *
 * @param {Element|Object|null|undefined} target
 * @param {string} attributeName
 * @param {Object} [options]
 * @param {*} [options.missingValue=null]
 * @param {boolean} [options.coerceToString=true]
 * @returns {*}
 */
export function readElementAttribute(target, attributeName, options = {}) {
  const missingValue = Object.hasOwn(options, 'missingValue') ? options.missingValue : null;
  const coerceToString = options.coerceToString ?? true;

  if (!target) return missingValue;

  const value =
    typeof target.getAttribute === 'function'
      ? target.getAttribute(attributeName)
      : target[attributeName];

  if (value === undefined || value === null) return missingValue;
  return coerceToString ? String(value) : value;
}
