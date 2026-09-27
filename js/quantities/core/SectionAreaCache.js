/**
 * @fileoverview 同一断面を参照する多数部材向けの断面積 cache。
 */

function requiredKeyPart(value, label) {
  if (value === null || value === undefined || String(value).trim() === '') {
    throw new TypeError(`${label} is required`);
  }
  return String(value);
}

/**
 * ST-Bridge の section id は要素種別ごとに一意であり、異種断面間では重複し得る。
 * そのため cache identity は sectionType + sectionId の複合キーとする。
 *
 * @param {Object} params
 * @param {string} params.sectionType
 * @param {string|number} params.sectionId
 * @param {string} [params.part='gross']
 * @param {number} [params.calculatorVersion=1]
 * @returns {string}
 */
export function buildSectionAreaCacheKey({
  sectionType,
  sectionId,
  part = 'gross',
  calculatorVersion = 1,
}) {
  const normalizedType = requiredKeyPart(sectionType, 'sectionType');
  const normalizedId = requiredKeyPart(sectionId, 'sectionId');
  const normalizedPart = requiredKeyPart(part, 'part');
  if (!Number.isInteger(calculatorVersion) || calculatorVersion <= 0) {
    throw new TypeError('calculatorVersion must be a positive integer');
  }
  return `${normalizedType}:${normalizedId}::${normalizedPart}::v${calculatorVersion}`;
}

export class SectionAreaCache {
  constructor() {
    this._values = new Map();
  }

  get size() {
    return this._values.size;
  }

  get(key) {
    return this._values.get(String(key));
  }

  has(key) {
    return this._values.has(String(key));
  }

  set(key, value) {
    const area = Number(value);
    if (!Number.isFinite(area) || area < 0) {
      throw new RangeError('cached section area must be a finite non-negative number');
    }
    this._values.set(String(key), area);
    return area;
  }

  clear() {
    this._values.clear();
  }
}
