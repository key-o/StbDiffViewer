/**
 * @fileoverview アプリ共通のフォント解決ユーティリティ。
 *
 * フォントファミリの実体は style/variables.css の
 * --font-family-base / --font-family-monospace のみで定義する。
 * Canvas / Three.js Sprite など CSS を直接継承できない描画コードは、
 * このモジュール経由で同じ CSS 変数を参照する。
 */

const FONT_VARIABLES = Object.freeze({
  base: '--font-family-base',
  monospace: '--font-family-monospace',
});

const GENERIC_FALLBACKS = Object.freeze({
  base: 'sans-serif',
  monospace: 'monospace',
});

/**
 * CSSカスタムプロパティからフォントファミリを取得する。
 * DOMのないテスト環境では generic family にフォールバックする。
 * @param {'base'|'monospace'} [kind='base']
 * @returns {string}
 */
export function getFontFamily(kind = 'base') {
  const normalizedKind = kind === 'monospace' ? 'monospace' : 'base';
  const variableName = FONT_VARIABLES[normalizedKind];
  const fallback = GENERIC_FALLBACKS[normalizedKind];

  if (
    typeof document === 'undefined' ||
    typeof document.documentElement === 'undefined' ||
    typeof getComputedStyle !== 'function'
  ) {
    return fallback;
  }

  const value = getComputedStyle(document.documentElement).getPropertyValue(variableName).trim();
  return value || fallback;
}

/** @returns {string} */
export function getBaseFontFamily() {
  return getFontFamily('base');
}

/** @returns {string} */
export function getMonospaceFontFamily() {
  return getFontFamily('monospace');
}

/**
 * CanvasRenderingContext2D.font 用の font shorthand を組み立てる。
 * @param {number} sizePx
 * @param {Object} [options]
 * @param {string|number} [options.weight]
 * @param {'base'|'monospace'} [options.family='base']
 * @param {string} [options.style]
 * @returns {string}
 */
export function buildCanvasFont(sizePx, options = {}) {
  const { weight = '', family = 'base', style = '' } = options;
  const prefix = [style, weight].filter(Boolean).join(' ');
  const familyValue = getFontFamily(family);
  return `${prefix ? `${prefix} ` : ''}${sizePx}px ${familyValue}`;
}

export { FONT_VARIABLES };
