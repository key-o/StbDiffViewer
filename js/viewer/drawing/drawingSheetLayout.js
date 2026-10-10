/** @fileoverview 簡易CADの用紙・縮尺・回転レイアウト。PDF座標系には依存しない。 */
import {
  assertDrawingRenderPlan,
  compileDrawingRenderPlan,
} from '../../data/drawing/drawingRenderPlan.js';
import { multiplyAffine, transformPoint } from '../../data/drawing/affine2d.js';
import { renderDrawingSvg } from './svgDrawingRenderer.js';
import { compileDrawingMeasurementDimensions } from '../../data/drawing/drawingMeasurementAnnotations.js';

export const PAPER_PRESETS = Object.freeze({
  A3: Object.freeze({ name: 'A3', widthMm: 420, heightMm: 297 }),
});

const DRAWING_ROTATION_DEGREES = Object.freeze([0, 90, 180, 270]);

export const DEFAULT_DRAWING_VIEW_MARGIN_MM = 20;

export const DEFAULT_DRAWING_SHEET = Object.freeze({
  paper: 'A3',
  orientation: 'landscape',
  scaleDenominator: 200,
  previewPxPerMm: 2.5,
  drawingRotationDeg: 0,
  viewMarginMm: DEFAULT_DRAWING_VIEW_MARGIN_MM,
});

function normalizeDrawingRotationDeg(value) {
  const rotation = Number(value);
  if (!Number.isFinite(rotation)) throw new TypeError('SVG回転角が不正です。');
  const normalized = ((rotation % 360) + 360) % 360;
  if (!DRAWING_ROTATION_DEGREES.includes(normalized))
    throw new RangeError('SVG回転は0°、90°、180°、270°のいずれかにしてください。');
  return normalized;
}

function quarterTurnTrig(degrees) {
  const radians = (-degrees * Math.PI) / 180;
  const clean = (value) => {
    if (Math.abs(value) < 1e-12) return 0;
    if (Math.abs(value - 1) < 1e-12) return 1;
    if (Math.abs(value + 1) < 1e-12) return -1;
    return value;
  };
  return { cos: clean(Math.cos(radians)), sin: clean(Math.sin(radians)) };
}

function finitePositive(value, label) {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(`${label}は正の有限値にしてください。`);
  return value;
}

function finiteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(`${label}は0以上の有限値にしてください。`);
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
    widthMm: landscape
      ? Math.max(preset.widthMm, preset.heightMm)
      : Math.min(preset.widthMm, preset.heightMm),
    heightMm: landscape
      ? Math.min(preset.widthMm, preset.heightMm)
      : Math.max(preset.widthMm, preset.heightMm),
  };
}

function combinedReferenceBounds(referenceDrawings = []) {
  if (!Array.isArray(referenceDrawings)) throw new TypeError('referenceDrawingsは配列が必要です。');
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const referenceDrawing of referenceDrawings) {
    const source = referenceDrawing?.bounds;
    if (!source) continue;
    if (![source.minX, source.minY, source.maxX, source.maxY].every(Number.isFinite))
      throw new TypeError('ReferenceDrawingのboundsが不正です。');
    bounds.minX = Math.min(bounds.minX, source.minX);
    bounds.minY = Math.min(bounds.minY, source.minY);
    bounds.maxX = Math.max(bounds.maxX, source.maxX);
    bounds.maxY = Math.max(bounds.maxY, source.maxY);
  }
  return [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)
    ? bounds
    : null;
}

function combinedContentBounds(drawing, referenceDrawings = []) {
  const drawingBounds = drawing?.bounds || null;
  const referenceBounds = combinedReferenceBounds(referenceDrawings);
  if (!drawingBounds) return referenceBounds;
  if (
    ![drawingBounds.minX, drawingBounds.minY, drawingBounds.maxX, drawingBounds.maxY].every(
      Number.isFinite,
    )
  )
    throw new TypeError('DrawingModelのboundsが不正です。');
  if (!referenceBounds) return drawingBounds;
  return {
    minX: Math.min(drawingBounds.minX, referenceBounds.minX),
    minY: Math.min(drawingBounds.minY, referenceBounds.minY),
    maxX: Math.max(drawingBounds.maxX, referenceBounds.maxX),
    maxY: Math.max(drawingBounds.maxY, referenceBounds.maxY),
  };
}

function transformBounds(matrix, bounds) {
  const points = [
    [bounds.minX, bounds.minY],
    [bounds.maxX, bounds.minY],
    [bounds.maxX, bounds.maxY],
    [bounds.minX, bounds.maxY],
  ].map((point) => transformPoint(matrix, point));
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

export function createDrawingSheetLayout({
  drawing = null,
  referenceDrawings = [],
  paper = DEFAULT_DRAWING_SHEET.paper,
  orientation = DEFAULT_DRAWING_SHEET.orientation,
  scaleDenominator = DEFAULT_DRAWING_SHEET.scaleDenominator,
  center = null,
  previewPxPerMm = DEFAULT_DRAWING_SHEET.previewPxPerMm,
  drawingRotationDeg = DEFAULT_DRAWING_SHEET.drawingRotationDeg,
  viewMarginMm = DEFAULT_DRAWING_SHEET.viewMarginMm,
} = {}) {
  if (drawing != null && (drawing?.schemaVersion !== 1 || drawing.units !== 'mm'))
    throw new TypeError('DrawingModel v1 (mm)が必要です。');
  const referenceBounds = combinedReferenceBounds(referenceDrawings);
  const contentBounds = combinedContentBounds(drawing, referenceDrawings);
  if (!drawing?.bounds && !referenceBounds)
    throw new Error('描画可能なSTBまたは参照図形がありません。');
  const sheet = resolvePaper(paper, orientation);
  const scale = finitePositive(Number(scaleDenominator), '縮尺分母');
  const preview = finitePositive(Number(previewPxPerMm), 'プレビュー倍率');
  const viewMargin = finiteNonNegative(Number(viewMarginMm), 'ビュー余白');
  const rotation = normalizeDrawingRotationDeg(drawingRotationDeg);
  // STBとDXFの重ね表示では既存STB用紙中心を維持し、DXF単独時だけ参照図形boundsを採用する。
  const bounds = drawing?.bounds || referenceBounds;
  if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite))
    throw new TypeError('DrawingModelのboundsが不正です。');
  const cx = center == null ? (bounds.minX + bounds.maxX) / 2 : Number(center[0]);
  const cy = center == null ? (bounds.minY + bounds.maxY) / 2 : Number(center[1]);
  if (![cx, cy].every(Number.isFinite)) throw new TypeError('図面中心座標が不正です。');
  const quarterTurn = rotation % 180 !== 0;
  const modelWidthMm = (quarterTurn ? sheet.heightMm : sheet.widthMm) * scale;
  const modelHeightMm = (quarterTurn ? sheet.widthMm : sheet.heightMm) * scale;
  const modelScale = 1 / scale;
  // model/paperはY上向き、画面はY下向き。画面上の時計回りを正にするため、
  // paper側では負角度の回転をA3用紙中心まわりに適用する。
  const { cos, sin } = quarterTurnTrig(rotation);
  const a = cos * modelScale;
  const b = sin * modelScale;
  const c = -sin * modelScale;
  const d = cos * modelScale;
  const modelToPaper = [
    a,
    b,
    c,
    d,
    sheet.widthMm / 2 - a * cx - c * cy,
    sheet.heightMm / 2 - b * cx - d * cy,
  ];
  const paperToCss = [1, 0, 0, -1, 0, sheet.heightMm];
  const modelToSheetCss = multiplyAffine(paperToCss, modelToPaper);
  const contentSheetBounds = transformBounds(modelToSheetCss, contentBounds);
  // 印刷範囲(A3)は固定しつつ、作業ビューは用紙外の図形と周辺余白まで見えるように分離する。
  const previewViewBox = Object.freeze({
    minX: Math.min(0, contentSheetBounds.minX) - viewMargin,
    minY: Math.min(0, contentSheetBounds.minY) - viewMargin,
    maxX: Math.max(sheet.widthMm, contentSheetBounds.maxX) + viewMargin,
    maxY: Math.max(sheet.heightMm, contentSheetBounds.maxY) + viewMargin,
  });
  const previewViewWidthMm = previewViewBox.maxX - previewViewBox.minX;
  const previewViewHeightMm = previewViewBox.maxY - previewViewBox.minY;
  const sheetCssToPreviewCss = Object.freeze([
    preview,
    0,
    0,
    preview,
    -previewViewBox.minX * preview,
    -previewViewBox.minY * preview,
  ]);
  const modelToPreviewCss = Object.freeze(multiplyAffine(sheetCssToPreviewCss, modelToSheetCss));
  return Object.freeze({
    ...sheet,
    scaleDenominator: scale,
    drawingRotationDeg: rotation,
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
    modelToSheetCss: Object.freeze(modelToSheetCss),
    modelToPreviewCss,
    previewViewBox: Object.freeze({
      ...previewViewBox,
      widthMm: previewViewWidthMm,
      heightMm: previewViewHeightMm,
    }),
    viewMarginMm: viewMargin,
    previewPxPerMm: preview,
    previewWidthPx: previewViewWidthMm * preview,
    previewHeightPx: previewViewHeightMm * preview,
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
  return Object.freeze([scale, 0, 0, -scale, offsetX, offsetY + layout.heightMm * scale]);
}

export function createDrawingSheetRenderPlan({
  drawing = null,
  referenceDrawings = [],
  referenceDisplaySettings = {},
  layout,
  displaySettings = null,
  showLabels = true,
  tagFamilyState = null,
  resolveTagFacts = null,
  resolveTagPlacement = null,
  tagOrientationMode = undefined,
  profileId = 'sdv-drawing-sheet-v1',
  genericTextHeightPaperMm = 3.5,
  genericStrokeWidthPaperMm = 0.8,
  additionalDimensions = [],
  measurements = [],
} = {}) {
  if (!layout || layout.paper !== 'A3') throw new TypeError('A3用紙レイアウトが必要です。');
  if (!Array.isArray(additionalDimensions))
    throw new TypeError('additionalDimensionsは配列で指定してください。');
  const measurementDimensions = compileDrawingMeasurementDimensions(
    measurements,
    layout.modelToPaper,
  );
  return compileDrawingRenderPlan({
    drawing,
    additionalDimensions: [...additionalDimensions, ...measurementDimensions],
    referenceDrawings,
    referenceDisplaySettings,
    profile: {
      id: profileId,
      modelToPaper: [...layout.modelToPaper],
      textStyle: { textHeightMm: genericTextHeightPaperMm },
      output: {
        preferredSpace: 'model',
        editableText: true,
        dimensionRepresentation: 'exploded-line-text',
      },
    },
    displaySettings,
    tagOptions: {
      showLabels,
      tagFamilyState,
      resolveTagFacts,
      resolveTagPlacement,
      tagOrientationMode,
      genericTextHeightPaperMm,
      genericStrokeWidthPaperMm,
    },
  });
}

export function renderDrawingSheetSvg({
  drawing = null,
  referenceDrawings = [],
  referenceDisplaySettings = {},
  layout,
  renderPlan: inputRenderPlan = null,
  document: domDocument = globalThis.document,
  onSelect = null,
  showLabels = true,
  displaySettings = null,
  tagFamilyState = null,
  resolveTagFacts = null,
  resolveTagPlacement = null,
  tagOffsetToCss = null,
  tagOrientationMode = undefined,
  onTagPointerDown = null,
  onReferenceSelect = null,
} = {}) {
  const renderPlan =
    inputRenderPlan == null
      ? createDrawingSheetRenderPlan({
          drawing,
          referenceDrawings,
          referenceDisplaySettings,
          layout,
          displaySettings,
          showLabels,
          tagFamilyState,
          resolveTagFacts,
          resolveTagPlacement,
          tagOrientationMode,
        })
      : assertDrawingRenderPlan(inputRenderPlan);
  const svg = renderDrawingSvg({
    drawing,
    renderPlan,
    registration: [...layout.modelToPaper],
    pdfToCss: [...layout.paperToCss],
    width: layout.widthMm,
    height: layout.heightMm,
    document: domDocument,
    onSelect,
    showLabels,
    labelFontSize: 3.5,
    labelStrokeWidth: 0.8,
    displaySettings,
    tagFamilyState,
    resolveTagFacts,
    resolveTagPlacement,
    tagOffsetToCss,
    tagOrientationMode,
    onTagPointerDown,
    onReferenceSelect,
    paperMmToCss: 1,
  });
  const previewViewBox = layout.previewViewBox || {
    minX: 0,
    minY: 0,
    widthMm: layout.widthMm,
    heightMm: layout.heightMm,
  };
  svg.setAttribute('width', String(layout.previewWidthPx));
  svg.setAttribute('height', String(layout.previewHeightPx));
  svg.setAttribute(
    'viewBox',
    `${previewViewBox.minX} ${previewViewBox.minY} ${previewViewBox.widthMm} ${previewViewBox.heightMm}`,
  );
  svg.setAttribute('data-print-view-box', `0 0 ${layout.widthMm} ${layout.heightMm}`);
  svg.setAttribute('data-paper', layout.paper);
  svg.setAttribute('data-orientation', layout.orientation);
  svg.setAttribute('data-scale', `1:${layout.scaleDenominator}`);
  svg.setAttribute('data-drawing-rotation', String(layout.drawingRotationDeg ?? 0));
  svg.setAttribute('data-render-plan-schema', String(renderPlan.schemaVersion));
  svg.setAttribute('data-render-profile', renderPlan.profile.id);
  svg.setAttribute(
    'aria-label',
    `SVG図面 A3 ${layout.orientation === 'landscape' ? '横' : '縦'} 1:${layout.scaleDenominator} 回転${layout.drawingRotationDeg ?? 0}°`,
  );
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
