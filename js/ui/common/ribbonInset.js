/**
 * 画面上部リボンの占有領域を共有する基盤。
 * 編集モードリボン・簡易CADリボンなどが register し、要素情報パネル等のfixed要素は
 * body の CSS 変数だけを参照する。
 *   --top-ribbon-bottom : リボン下端(px)。フローティング要素の上端オフセット
 *   --top-ribbon-docked-offset : 左ドッキング要素の上端オフセット。
 *     全幅リボンの下へ置く。ドッキング幅の右側に配置されるリボンでは 0。
 */

const entries = new Map();
let observer = null;

function publish() {
  let bottom = 0;
  let docked = 0;
  for (const [element, { fullWidth }] of entries) {
    if (element.hidden || !element.isConnected) continue;
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0) continue;
    const value = Math.ceil(rect.bottom);
    bottom = Math.max(bottom, value);
    if (fullWidth) docked = Math.max(docked, value);
  }
  const style = document.body.style;
  style.setProperty('--top-ribbon-bottom', `${bottom}px`);
  style.setProperty('--top-ribbon-docked-offset', `${docked}px`);
}

/**
 * @param {HTMLElement} element リボン要素
 * @param {{fullWidth?: boolean}} [options] 画面幅全体を占めるか
 * @returns {() => void} 解除関数
 */
export function registerTopRibbon(element, { fullWidth = false } = {}) {
  if (!element) return () => {};
  entries.set(element, { fullWidth });
  if (!observer && typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(publish);
  }
  observer?.observe(element);
  publish();
  return () => {
    entries.delete(element);
    observer?.unobserve(element);
    publish();
  };
}

/** 表示状態(hidden等)の変更後に再計算する。 */
export function refreshTopRibbonInset() {
  publish();
}
