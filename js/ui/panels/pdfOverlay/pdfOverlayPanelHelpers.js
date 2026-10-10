import { assertMatrix, isDirectSimilarity } from '../../../data/drawing/affine2d.js';
import { createStoryPlanView } from '../../../data/drawing/storyPlanView.js';

/** @fileoverview PDF照合パネルの数値・DOM・階ビューの小さな変換関数。 */

export function num(input, label) {
  const value = Number(input.value);
  if (!Number.isFinite(value)) throw new TypeError(`${label}を数値で入力してください。`);
  return value;
}

export function resolveScaleDenominator(presetValue, customValue) {
  const raw = presetValue === 'custom' ? customValue : presetValue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1)
    throw new RangeError('縮尺分母は1以上の数値で入力してください。');
  return value;
}

export function make(tag, attrs = {}, text = '') {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') element.className = value;
    else if (key === 'for') element.htmlFor = value;
    else element.setAttribute(key, value);
  }
  if (text) element.textContent = text;
  return element;
}

export function storyView(stories, storyId) {
  return createStoryPlanView(stories, storyId);
}

/**
 * PDF.js viewportにおける紙面1mmのCSS座標量。
 * viewport.transformはUserUnitを含むため、UserUnitで戻してから72pt/inをmmへ換算する。
 * DPRはCanvas出力倍率であり、ここには含めない。
 */
export function resolvePdfPaperMmToCss(pageRender) {
  const matrix = pageRender?.pdfToCss;
  const userUnit = Number(pageRender?.userUnit);
  if (!Array.isArray(matrix) || matrix.length !== 6 || !matrix.every(Number.isFinite))
    throw new TypeError('PDF viewport変換が不正です。');
  if (!Number.isFinite(userUnit) || userUnit <= 0) throw new RangeError('PDF UserUnitが不正です。');
  const sx = Math.hypot(matrix[0], matrix[1]);
  const sy = Math.hypot(matrix[2], matrix[3]);
  if (!(sx > 0) || !(sy > 0) || Math.abs(sx - sy) > Math.max(sx, sy) * 1e-9)
    throw new TypeError('PDF viewportは等方スケールである必要があります。');
  return ((sx + sy) / 2 / userUnit) * (72 / 25.4);
}

/**
 * PDF座標系を物理paper-mm座標へ正規化し、寸法compilerとSVG表示で同じ座標系を共有する。
 * registrationはmodel-mm→PDF user space、paperToCssはpaper-mm→CSS px。
 */
export function createPdfDimensionRenderContext(registration, pageRender) {
  const modelToPdf = [...assertMatrix(registration)];
  if (!isDirectSimilarity(modelToPdf))
    throw new TypeError('PDF寸法の位置合わせには反転のない相似変換が必要です。');
  const pdfToCss = [...assertMatrix(pageRender?.pdfToCss)];
  const sx = Math.hypot(pdfToCss[0], pdfToCss[1]);
  const sy = Math.hypot(pdfToCss[2], pdfToCss[3]);
  if (!(sx > 0) || !(sy > 0) || Math.abs(sx - sy) > Math.max(sx, sy) * 1e-9)
    throw new TypeError('PDF viewportは等方スケールである必要があります。');
  const paperMmToCss = resolvePdfPaperMmToCss(pageRender);
  const mmPerPdfUnit = (sx + sy) / 2 / paperMmToCss;
  if (!Number.isFinite(mmPerPdfUnit) || mmPerPdfUnit <= 0)
    throw new TypeError('PDF user space→paper-mm変換が不正です。');

  return Object.freeze({
    modelToPaper: Object.freeze([
      modelToPdf[0] * mmPerPdfUnit,
      modelToPdf[1] * mmPerPdfUnit,
      modelToPdf[2] * mmPerPdfUnit,
      modelToPdf[3] * mmPerPdfUnit,
      modelToPdf[4] * mmPerPdfUnit,
      modelToPdf[5] * mmPerPdfUnit,
    ]),
    paperToCss: Object.freeze([
      pdfToCss[0] / mmPerPdfUnit,
      pdfToCss[1] / mmPerPdfUnit,
      pdfToCss[2] / mmPerPdfUnit,
      pdfToCss[3] / mmPerPdfUnit,
      pdfToCss[4],
      pdfToCss[5],
    ]),
    paperMmToCss,
  });
}
