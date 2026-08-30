/**
 * @fileoverview STB wall classification helpers
 */

import { readElementAttribute } from '../../data/accessors/elementAttributeAccessor.js';

/**
 * @typedef {'ShearWall'|'Wall'} ViewerWallElementType
 */

/**
 * Safely reads an attribute from either an XML element or a plain object.
 * @param {Element|Object|null|undefined} element
 * @param {string} attributeName
 * @returns {string}
 */
const readWallAttribute = (element, attributeName) =>
  readElementAttribute(element, attributeName, { missingValue: '' });

/**
 * Returns the STB wall kind.
 * @param {Element|Object|null|undefined} element
 * @returns {string}
 */
export function getStbWallKind(element) {
  return readWallAttribute(element, 'kind_wall').trim();
}

/**
 * Returns true when the wall is a shear wall in STB.
 * @param {Element|Object|null|undefined} element
 * @returns {boolean}
 */
export function isStbShearWall(element) {
  return getStbWallKind(element) === 'WALL_SHEAR';
}

/**
 * Maps an STB wall to the viewer wall element type.
 * @param {Element|Object|null|undefined} element
 * @returns {ViewerWallElementType}
 */
export function getViewerWallElementType(element) {
  return isStbShearWall(element) ? 'ShearWall' : 'Wall';
}

/**
 * Filters StbWall collections for the requested viewer element type.
 * @param {ViewerWallElementType} elementType
 * @param {Array<Element|Object>} elements
 * @returns {Array<Element|Object>}
 */
export function filterWallsByViewerElementType(elementType, elements) {
  if (!Array.isArray(elements) || (elementType !== 'ShearWall' && elementType !== 'Wall')) {
    return Array.isArray(elements) ? elements : [];
  }
  return elements.filter((element) => getViewerWallElementType(element) === elementType);
}
