/**
 * @fileoverview viewer canvas の表示寸法とaspect計算を一元管理する。
 */

/**
 * キャンバスのCSS表示サイズを取得する。
 * WebGLの描画バッファサイズではなく、実際に表示されるcanvas boxを基準にする。
 * @param {HTMLCanvasElement} canvas
 * @returns {{width: number, height: number}}
 */
export function getCanvasDisplaySize(canvas) {
  const rect = canvas.getBoundingClientRect?.();
  const fallbackWidth = typeof window !== 'undefined' ? window.innerWidth : 1;
  const fallbackHeight = typeof window !== 'undefined' ? window.innerHeight : 1;
  const width = canvas.clientWidth || rect?.width || fallbackWidth || 1;
  const height = canvas.clientHeight || rect?.height || fallbackHeight || 1;

  return {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
}

/**
 * 実canvas表示サイズからviewport aspectを取得する。
 * @param {HTMLCanvasElement|null|undefined} canvas
 * @returns {number}
 */
export function getCanvasAspect(canvas) {
  if (!canvas) {
    const width = typeof window !== 'undefined' ? window.innerWidth : 1;
    const height = typeof window !== 'undefined' ? window.innerHeight : 1;
    return width > 0 && height > 0 ? width / height : 1;
  }

  const { width, height } = getCanvasDisplaySize(canvas);
  return width / height;
}
