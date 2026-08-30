/**
 * @fileoverview 部材色のユーザー設定と永続化
 *
 * Viewerに依存せず、検証済みの現在色、保存、変更購読を提供する。
 */

import { DEFAULT_ELEMENT_COLORS } from '../config/colorConfig.js';
import { storageHelper } from '../utils/storageHelper.js';

const STORAGE_KEY = 'element-colors';
const VALID_COLOR_PATTERN = /^#([0-9A-Fa-f]{3}){1,2}$/;
const ELEMENT_TYPES = Object.keys(DEFAULT_ELEMENT_COLORS);
const listeners = new Set();

function isValidColor(color) {
  return typeof color === 'string' && VALID_COLOR_PATTERN.test(color);
}

function sanitizeColors(colors, baseColors = DEFAULT_ELEMENT_COLORS) {
  const sanitized = { ...baseColors };
  if (!colors || typeof colors !== 'object' || Array.isArray(colors)) {
    return sanitized;
  }

  for (const type of ELEMENT_TYPES) {
    if (isValidColor(colors[type])) {
      sanitized[type] = colors[type];
    }
  }
  return sanitized;
}

let currentColors = sanitizeColors(storageHelper.get(STORAGE_KEY, null));

function notifyListeners(elementType, color) {
  const snapshot = { ...currentColors };
  for (const listener of listeners) {
    listener(snapshot, elementType, color);
  }
}

/** @returns {Object<string, string>} 検証済みの現在色 */
export function getElementColorPreferences() {
  return { ...currentColors };
}

/**
 * @param {string} elementType - 要素タイプ
 * @returns {string|undefined} 現在色
 */
export function getElementColorPreference(elementType) {
  return currentColors[elementType];
}

/**
 * 1要素の現在色を更新して保存する。
 * @returns {boolean} 更新可能な値ならtrue
 */
export function setElementColorPreference(elementType, color) {
  if (!Object.hasOwn(DEFAULT_ELEMENT_COLORS, elementType) || !isValidColor(color)) {
    return false;
  }
  if (currentColors[elementType] === color) {
    return true;
  }

  currentColors = { ...currentColors, [elementType]: color };
  storageHelper.set(STORAGE_KEY, currentColors);
  notifyListeners(elementType, color);
  return true;
}

/**
 * 全要素の現在色を検証・置換し、1回だけ保存する。
 * @param {Object<string, string>} colors - 要素タイプ別の色
 */
export function setElementColorPreferences(colors) {
  currentColors = sanitizeColors(colors);
  storageHelper.set(STORAGE_KEY, currentColors);
  notifyListeners(null, null);
}

/**
 * 部材色設定の変更を購読する。
 * @param {Function} listener - (colors, elementType, color) => void
 * @returns {Function} 購読解除関数
 */
export function subscribeElementColorPreferences(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
