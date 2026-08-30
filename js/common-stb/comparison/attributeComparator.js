/**
 * @fileoverview 要素属性比較モジュール
 *
 * 2つの要素の構造属性（断面、材質、回転、オフセット等）を比較し、
 * 一致/不一致を判定します。XML DOM要素とJSオブジェクト両方に対応。
 */

import { NUMERIC_TOLERANCE } from '../../config/geometryConfig.js';
import { getToleranceConfig } from '../../config/toleranceConfig.js';
import { isIdentityAttribute } from './identityAttributes.js';

/**
 * 要素からプロパティ値を取得する（XML DOM/JSオブジェクト両対応）
 * @param {Element|Object} element - 要素
 * @param {string} attrName - 属性名
 * @returns {*} 属性値
 */
function getProperty(element, attrName) {
  let val;
  if (element && typeof element.getAttribute === 'function') {
    // XML DOM要素
    val = element.getAttribute(attrName);
    if (val === null) return undefined;
  } else {
    // JSオブジェクト
    val = element?.[attrName];
    if (val === undefined) return undefined;
  }
  // 文字列の場合は数値変換を試みる（"0" と "0.0" が不一致にならないよう統一）
  if (typeof val === 'string') {
    const num = Number(val);
    return isNaN(num) ? val : num;
  }
  return val;
}

/**
 * 比較対象の構造属性リスト
 * @type {string[]}
 */
const STRUCTURAL_ATTRIBUTES = [
  'kind',
  'kind_structure',
  'kind_layout',
  'kind_wall',
  'rotate',
  'offset_X',
  'offset_Y',
  'offset_Z',
  'offset_bottom_X',
  'offset_bottom_Y',
  'offset_bottom_Z',
  'offset_top_X',
  'offset_top_Y',
  'offset_top_Z',
  'level_top',
  'level_bottom',
  'condition_bottom',
  'condition_top',
  'joint_bottom',
  'joint_top',
  'haunch_H',
  'haunch_start',
  'haunch_end',
  'kind_haunch_start',
  'kind_haunch_end',
];

/**
 * STB仕様上の既定値が0で、欠落を0と同値に扱う属性。
 * 柱・間柱の偏心はツールにより「offsetで符号化」「節点座標に織り込み（offset無し）」と
 * 表現が分かれるため、欠落と明示的な0を区別すると偽差分になる。
 * @type {Set<string>}
 */
const ZERO_DEFAULT_ATTRIBUTES = new Set([
  'offset_bottom_X',
  'offset_bottom_Y',
  'offset_bottom_Z',
  'offset_top_X',
  'offset_top_Y',
  'offset_top_Z',
]);

/**
 * 2つの要素の構造属性を比較する
 * @param {Element|Object} elementA - モデルAの要素
 * @param {Element|Object} elementB - モデルBの要素
 * @param {number} [tolerance] - 数値属性の許容差（省略時は toleranceConfig から取得）
 * @returns {boolean} 属性が一致すればtrue
 */
export function compareStructuralAttributes(elementA, elementB, tolerance) {
  return compareStructuralAttributeDetails(elementA, elementB, tolerance).matches;
}

/**
 * 2つの要素の構造属性を比較し、差分属性名も返す
 * @param {Element|Object} elementA - モデルAの要素
 * @param {Element|Object} elementB - モデルBの要素
 * @param {number} [tolerance] - 数値属性の許容差（省略時は toleranceConfig から取得）
 * @returns {{matches: boolean, differences: Array<{attribute: string, valueA: *, valueB: *}>}}
 */
export function compareStructuralAttributeDetails(elementA, elementB, tolerance) {
  const numTolerance =
    tolerance !== undefined
      ? tolerance
      : (getToleranceConfig().attributeNumericTolerance ?? NUMERIC_TOLERANCE);
  const differences = [];

  for (const attr of STRUCTURAL_ATTRIBUTES) {
    if (isIdentityAttribute(attr)) {
      continue;
    }

    let valueA = getProperty(elementA, attr);
    let valueB = getProperty(elementB, attr);

    // 既定値0の属性は欠落を0として比較する
    if (ZERO_DEFAULT_ATTRIBUTES.has(attr)) {
      if (valueA === undefined && valueB === undefined) continue;
      valueA = valueA ?? 0;
      valueB = valueB ?? 0;
    }

    // 両方とも未定義なら一致とみなす
    if (valueA === undefined && valueB === undefined) {
      continue;
    }

    // 片方だけ定義されている場合は不一致
    if (valueA === undefined || valueB === undefined) {
      differences.push({ attribute: attr, valueA, valueB });
      continue;
    }

    // 数値の場合はしきい値で比較
    if (typeof valueA === 'number' && typeof valueB === 'number') {
      if (Math.abs(valueA - valueB) > numTolerance) {
        differences.push({ attribute: attr, valueA, valueB });
      }
    } else {
      // その他の型は厳密比較
      if (String(valueA) !== String(valueB)) {
        differences.push({ attribute: attr, valueA, valueB });
      }
    }
  }

  return {
    matches: differences.length === 0,
    differences,
  };
}

/**
 * BasicStrategy用の属性比較コールバックを作成する
 *
 * keyExtractorが返すdataオブジェクトから元の要素を取得し、
 * 構造属性を比較するコールバック関数を返す。
 *
 * @param {function(any): Element|Object} [elementExtractor] - dataから要素を取り出す関数
 * @returns {function(any, any): boolean} 属性比較コールバック
 */
export function createAttributeComparator(elementExtractor) {
  const getElement = elementExtractor || ((data) => data.element || data);
  return (dataA, dataB) => {
    const elementA = getElement(dataA);
    const elementB = getElement(dataB);
    return compareStructuralAttributes(elementA, elementB);
  };
}

/**
 * 要素自身の構造属性と、参照断面の内容シグネチャをまとめて比較する。
 * 断面解決は呼び出し側から注入し、比較モジュールのレイヤー依存を増やさない。
 *
 * @param {Object} options
 * @param {Function} options.resolveSectionContentSignature
 * @param {Map|Object} options.nodeMapA
 * @param {Map|Object} options.nodeMapB
 * @param {Function} [options.elementExtractor]
 * @returns {Function}
 */
export function createSectionAwareAttributeComparator({
  resolveSectionContentSignature,
  nodeMapA,
  nodeMapB,
  elementExtractor = (data) => data?.rawElement || data?.element || data,
}) {
  return (dataA, dataB) => {
    const elementA = elementExtractor(dataA);
    const elementB = elementExtractor(dataB);
    const instanceComparison = compareStructuralAttributeDetails(elementA, elementB);
    const signatureA = resolveSectionContentSignature(elementA, nodeMapA);
    const signatureB = resolveSectionContentSignature(elementB, nodeMapB);
    const hasInstanceDiff = !instanceComparison.matches;
    const hasTypeDiff = signatureA !== signatureB;

    if (!hasInstanceDiff && !hasTypeDiff) {
      return { matches: true };
    }

    return {
      matches: false,
      attributeMismatchKind:
        hasInstanceDiff && hasTypeDiff ? 'both' : hasTypeDiff ? 'type' : 'instance',
      attributeDiffScope: {
        instance: hasInstanceDiff,
        type: hasTypeDiff,
      },
      attributeDiffDetails: {
        instance: instanceComparison.differences,
        type: hasTypeDiff ? { sectionSignatureA: signatureA, sectionSignatureB: signatureB } : null,
      },
    };
  };
}
