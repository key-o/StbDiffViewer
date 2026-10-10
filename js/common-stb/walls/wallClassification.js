/**
 * @fileoverview STB wall classification helpers
 *
 * StbWall の Viewer identity は常に Wall とし、kind_wall は同一要素の耐力区分属性として比較・表示する。
 */

import { readElementAttribute } from '../../data/accessors/elementAttributeAccessor.js';

export const STB_WALL_KIND = Object.freeze({
  NORMAL: 'WALL_NORMAL',
  SHEAR: 'WALL_SHEAR',
});

const LEGACY_WALL_ELEMENT_TYPES = new Set(['ShearWall', 'StbShearWall']);

const readWallAttribute = (element, attributeName) =>
  readElementAttribute(element, attributeName, { missingValue: '' });

export function getStbWallKind(element) {
  return readWallAttribute(element, 'kind_wall').trim();
}

export function getEffectiveStbWallKind(element) {
  return getStbWallKind(element) === STB_WALL_KIND.SHEAR
    ? STB_WALL_KIND.SHEAR
    : STB_WALL_KIND.NORMAL;
}

export function isStbShearWall(element) {
  return getEffectiveStbWallKind(element) === STB_WALL_KIND.SHEAR;
}

/** legacy外部入力のShearWallをcanonical Wallへ写像する。 */
export function normalizeWallViewerElementType(elementType) {
  const normalized = String(elementType || '').trim();
  return LEGACY_WALL_ELEMENT_TYPES.has(normalized) ? 'Wall' : normalized;
}

/** @deprecated StbWallのViewer identityは常にWall。 */
export function getViewerWallElementType() {
  return 'Wall';
}

/**
 * STB仕様の省略値だけを補完する比較用の耐力区分。
 * 明示された不正値は保持する。表示上の「非耐力壁」への分類と、属性の同値性は別契約。
 * xmldomは欠落属性も空文字で返すため、hasAttributeで省略を区別する。
 */
export function getComparableStbWallKind(element) {
  if (typeof element?.hasAttribute === 'function' && !element.hasAttribute('kind_wall')) {
    return STB_WALL_KIND.NORMAL;
  }
  return readElementAttribute(element, 'kind_wall') ?? STB_WALL_KIND.NORMAL;
}
