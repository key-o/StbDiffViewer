/** @fileoverview STB単独図面の用紙・縮尺レイアウト。PDF座標系には依存しない。 */
import { renderDrawingSvg } from './svgDrawingRenderer.js';

export const PAPER_PRESETS = Object.freeze({
  A3: Object.freeze({ name: 'A3', widthMm: 420, heightMm: 297 }),
});

export const DEFAULT_DRAWING_SHEET = Object.freeze({
  paper: 'A3',
  orientation: 'landscape',
  scaleDenominator: 200,
  previewPxPerMm: 2.5,
});

function finitePositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label}は正の有限値にしてください。`);
  return value;
}

function resolvePaper(paper, orientation) {
  const preset = PAPER_PRESETS[paper];
  if (!preset) throw new RangeError(`未対応の用紙です: ${paper}`);
  if (orientation !== 'landscape' && orientation !== 'portrait')
    throw new RangeError('用紙方向はlandscapeまたはportraitを指定してください。');
  const landscape = orientation === 'landscape';
  return {
    paper,
    orientation,
    widthMm: landscape ? Math.max(preset.widthMm, preset.heightMm) : Math.min(preset.widthMm, preset.heightMm),
    heightMm: landscape ? Math.min(preset.widthMm, preset.heightMm) : Math.max(preset.widthMm, preset.heightMm),
  };
}

export function createDrawingSheetLayout({
  drawing,
  paper = DEFAULT_DRAWING_SHEET.paper,
  orientation = DEFAULT_DRAWING_SHEET.orientation,
  scaleDenominator = DEFAULT_DRAWING_SHEET.scaleDenominator,
  center = null,
  previewPxPerMm = DEFAULT_DRAWING_SHEET.previewPxPerMm,
} = {}) {
  if (drawing?.schemaVersion !== 1 || drawing.units !== 'mm')
    throw new TypeError('DrawingModel v1 (mm)が必要です。');
  if (!drawing.bounds) throw new Error('描画可能なSTB図形がありません。');
  const sheet = resolvePaper(paper, orientation);
  const scale = finitePositive(Number(scaleDenominator), '縮尺分母');
  const preview = finitePositive(Number(previewPxPerMm), 'プレビュー倍率');
  const bounds = drawing.bounds;
  if (![bounds.minX,bounds.minY,bounds.maxX,bounds.maxY].every(Number.isFinite))
    throw new TypeError('DrawingModelのboundsが不正です。');
  const cx = center == null ? (bounds.minX + bounds.maxX) / 2 : Number(center[0]);
  const cy = center == null ? (bounds.minY + bounds.maxY) / 2 : Number(center[1]);
  if (![cx,cy].every(Number.isFinite)) throw new TypeError('図面中心座標が不正です。');
  const modelWidthMm = sheet.widthMm * scale;
  const modelHeightMm = sheet.heightMm * scale;
  const modelToPaper = [
    1 / scale, 0, 0, 1 / scale,
    sheet.widthMm / 2 - cx / scale,
    sheet.heightMm / 2 - cy / scale,
  ];
  const paperToCss = [1, 0, 0, -1, 0, sheet.heightMm];
  return Object.freeze({
    ...sheet,
    scaleDenominator: scale,
    center: Object.freeze([cx, cy]),
    modelWidthMm,
    modelHeightMm,
    worldWindow: Object.freeze({
      minX: cx - modelWidthMm / 2,
      maxX: cx + modelWidthMm / 2,
      minY: cy - modelHeightMm / 2,
      maxY: cy + modelHeightMm / 2,
    }),
    modelToPaper: Object.freeze(modelToPaper),
    paperToCss: Object.freeze(paperToCss),
    previewPxPerMm: preview,
    previewWidthPx: sheet.widthMm * preview,
    previewHeightPx: sheet.heightMm * preview,
  });
}


/** A3用紙(mm)を現在のPDF表示viewport(CSS px)へ縦横比を保って収める。 */
export function createSheetToViewportTransform(layout, width, height) {
  if (!layout || layout.paper !== 'A3') throw new TypeError('A3用紙レイアウトが必要です。');
  const w = finitePositive(Number(width), 'PDF表示幅');
  const h = finitePositive(Number(height), 'PDF表示高さ');
  // PDFのCropBox/回転後viewportがA3と異なる縦横比でも、STB図形を異方拡縮しない。
  const scale = Math.min(w / layout.widthMm, h / layout.heightMm);
  const offsetX = (w - layout.widthMm * scale) / 2;
  const offsetY = (h - layout.heightMm * scale) / 2;
  return Object.freeze([
    scale,
    0,
    0,
    -scale,
    offsetX,
    offsetY + layout.heightMm * scale,
  ]);
}

export function renderDrawingSheetSvg({
  drawing,
  layout,
  document: domDocument = globalThis.document,
  onSelect = null,
  showLabels = true,
} = {}) {
  if (!layout || layout.paper !== 'A3') throw new TypeError('A3用紙レイアウトが必要です。');
  const svg = renderDrawingSvg({
    drawing,
    registration: [...layout.modelToPaper],
    pdfToCss: [...layout.paperToCss],
    width: layout.widthMm,
    height: layout.heightMm,
    document: domDocument,
    onSelect,
    showLabels,
    labelFontSize: 3.5,
    labelStrokeWidth: 0.8,
  });
  svg.setAttribute('width', String(layout.previewWidthPx));
  svg.setAttribute('height', String(layout.previewHeightPx));
  svg.setAttribute('viewBox', `0 0 ${layout.widthMm} ${layout.heightMm}`);
  svg.setAttribute('data-paper', layout.paper);
  svg.setAttribute('data-orientation', layout.orientation);
  svg.setAttribute('data-scale', `1:${layout.scaleDenominator}`);
  svg.setAttribute('aria-label', `STB図面 A3 ${layout.orientation === 'landscape' ? '横' : '縦'} 1:${layout.scaleDenominator}`);
  const frame = domDocument.createElementNS('http://www.w3.org/2000/svg', 'rect');
  frame.setAttribute('x', '0.25');
  frame.setAttribute('y', '0.25');
  frame.setAttribute('width', String(layout.widthMm - 0.5));
  frame.setAttribute('height', String(layout.heightMm - 0.5));
  frame.setAttribute('fill', 'white');
  frame.setAttribute('stroke', '#777');
  frame.setAttribute('stroke-width', '0.5');
  svg.insertBefore(frame, svg.firstChild);
  return svg;
}
