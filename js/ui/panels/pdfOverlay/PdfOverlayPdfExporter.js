/** @fileoverview PDF照合ワークスペースの注記付きPDF出力。 */
import { multiplyAffine, transformPoint } from '../../../data/drawing/affine2d.js';
import { isSheetPaperName } from '../../../data/drawing/drawingSheetPaper.js';
import { resolveMeasurementOffsetModelMm } from './PdfOverlayMeasurementController.js';

const EXPORT_RENDER_SCALE = 2;

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1]];
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1]];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1];
}

function scale(vector, factor) {
  return [vector[0] * factor, vector[1] * factor];
}

function normalize(vector) {
  const length = Math.hypot(vector[0], vector[1]);
  return length > 1e-9 ? [vector[0] / length, vector[1] / length] : [1, 0];
}

function orientationFor(width, height) {
  return width >= height ? 'landscape' : 'portrait';
}

export function buildAnnotatedPdfFilename(filename) {
  const source = String(filename || 'document.pdf').trim() || 'document.pdf';
  return /\.pdf$/i.test(source) ? source.replace(/\.pdf$/i, '_SDV.pdf') : `${source}_SDV.pdf`;
}

function currentPagePointSize(panel) {
  const zoom = Number(panel?.viewZoom);
  const render = panel?.pageRender;
  if (!render || !Number.isFinite(zoom) || zoom <= 0) return null;
  return [render.width / zoom, render.height / zoom];
}

function ignoredDuringExport(element) {
  if (typeof element?.matches !== 'function') return false;
  return element.matches(
    [
      '.pdf-overlay-gizmo',
      '.pdf-overlay-candidate-markers',
      '.pdf-overlay-region-selection-box',
      '.pdf-overlay-region-outline',
      '.pdf-overlay-measurement-pick',
      '.pdf-overlay-measurement-hit',
      '.pdf-overlay-measurement-source-line',
      '.pdf-overlay-measurement-normal',
    ].join(','),
  );
}

async function captureCurrentPage(panel, html2canvas) {
  const stage = panel?.e?.['pdf-overlay-stage'];
  if (!stage) throw new Error('PDF表示領域を取得できません。');
  const zoom = Number(panel.viewZoom) || 1;
  const captureScale = Math.max(0.5, Math.min(2, EXPORT_RENDER_SCALE / zoom));
  return html2canvas(stage, {
    scale: captureScale,
    backgroundColor: '#ffffff',
    logging: false,
    useCORS: true,
    allowTaint: false,
    ignoreElements: ignoredDuringExport,
  });
}

function drawMemo(ctx, render, memo, exportScale) {
  const [x, y] = transformPoint(render.pdfToCss, memo.pdfPoint);
  const radius = 8 * exportScale;
  const fontSize = 12 * exportScale;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = '#cc3333';
  ctx.fill();
  ctx.lineWidth = 1.5 * exportScale;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  const label = memo.exportLabel || memo.text || '';
  ctx.font = `700 ${fontSize}px "Meiryo", "Yu Gothic", sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3 * exportScale;
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#cc3333';
  ctx.strokeText(label, x + 11 * exportScale, y - 9 * exportScale);
  ctx.fillText(label, x + 11 * exportScale, y - 9 * exportScale);
  ctx.restore();
}

function drawArrow(ctx, tip, inwardDirection, exportScale) {
  const direction = normalize(inwardDirection);
  const perp = [-direction[1], direction[0]];
  const length = 8 * exportScale;
  const width = 4 * exportScale;
  const base = add(tip, scale(direction, length));
  for (const sign of [-1, 1]) {
    const end = add(base, scale(perp, width * sign));
    ctx.beginPath();
    ctx.moveTo(tip[0], tip[1]);
    ctx.lineTo(end[0], end[1]);
    ctx.stroke();
  }
}

function drawMeasurement(ctx, render, measurement, exportScale) {
  if (!Array.isArray(measurement?.modelToPdf)) return;
  const modelToCss = multiplyAffine(render.pdfToCss, measurement.modelToPdf);
  const p1 = transformPoint(modelToCss, measurement.p1);
  const p2 = transformPoint(modelToCss, measurement.p2);
  const dimDirection = normalize(subtract(p2, p1));
  const offsetDirection = [-dimDirection[1], dimDirection[0]];

  let offset;
  if (Number.isFinite(measurement.offsetModelMm)) {
    const modelDirection = normalize(subtract(measurement.p2, measurement.p1));
    const modelOffset = [-modelDirection[1], modelDirection[0]];
    const offsetPoint = transformPoint(
      modelToCss,
      add(measurement.p1, scale(modelOffset, measurement.offsetModelMm)),
    );
    offset = subtract(offsetPoint, p1);
  } else {
    const offsetMm = resolveMeasurementOffsetModelMm(measurement, modelToCss, 18 * exportScale);
    const modelDirection = normalize(subtract(measurement.p2, measurement.p1));
    const modelOffset = [-modelDirection[1], modelDirection[0]];
    const offsetPoint = transformPoint(
      modelToCss,
      add(measurement.p1, scale(modelOffset, offsetMm)),
    );
    offset = subtract(offsetPoint, p1);
  }

  const dimStart = add(p1, offset);
  const dimEnd = add(p2, offset);
  ctx.save();
  ctx.strokeStyle = '#2255cc';
  ctx.fillStyle = '#2255cc';
  ctx.lineWidth = 1.5 * exportScale;
  ctx.setLineDash([4 * exportScale, 3 * exportScale]);
  for (const [from, to] of [
    [p1, dimStart],
    [p2, dimEnd],
  ]) {
    ctx.beginPath();
    ctx.moveTo(from[0], from[1]);
    ctx.lineTo(to[0], to[1]);
    ctx.stroke();
  }

  ctx.setLineDash([]);
  ctx.lineWidth = 2 * exportScale;
  ctx.beginPath();
  ctx.moveTo(dimStart[0], dimStart[1]);
  ctx.lineTo(dimEnd[0], dimEnd[1]);
  ctx.stroke();
  drawArrow(ctx, dimStart, dimDirection, exportScale);
  drawArrow(ctx, dimEnd, scale(dimDirection, -1), exportScale);

  const labelSide = dot(offset, offsetDirection) >= 0 ? 1 : -1;
  const labelPoint = [
    (dimStart[0] + dimEnd[0]) / 2 + offsetDirection[0] * 10 * exportScale * labelSide,
    (dimStart[1] + dimEnd[1]) / 2 + offsetDirection[1] * 10 * exportScale * labelSide,
  ];
  const label = `${Math.round(measurement.distance).toLocaleString()} mm`;
  ctx.font = `700 ${12 * exportScale}px "Meiryo", "Yu Gothic", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4 * exportScale;
  ctx.strokeStyle = '#ffffff';
  ctx.strokeText(label, labelPoint[0], labelPoint[1]);
  ctx.fillStyle = '#2255cc';
  ctx.fillText(label, labelPoint[0], labelPoint[1]);
  ctx.restore();
}

function drawStoredAnnotations(panel, canvas, render, pageNumber) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const outputScale = Number.isFinite(render.outputScale) ? render.outputScale : 1;
  const canvasRender = {
    ...render,
    pdfToCss: multiplyAffine([outputScale, 0, 0, outputScale, 0, 0], render.pdfToCss),
  };
  const annotationScale = EXPORT_RENDER_SCALE * outputScale;
  const memos = (panel.sessionUi?.drawingMemos || []).filter(
    (memo) =>
      memo.active !== false &&
      memo.pageNumber === pageNumber &&
      Array.isArray(memo.pdfPoint) &&
      memo.pdfPoint.length === 2,
  );
  memos.forEach((memo, index) =>
    drawMemo(
      ctx,
      canvasRender,
      { ...memo, exportLabel: `${index + 1}. ${memo.text}` },
      annotationScale,
    ),
  );

  const measurements = (panel.measurementUi?.measurements || []).filter(
    (measurement) => measurement.pageNumber === pageNumber,
  );
  measurements.forEach((measurement) =>
    drawMeasurement(ctx, canvasRender, measurement, annotationScale),
  );
}

/**
 * 印刷用SVGのuser unitは用紙mm。画面px固定線幅を実寸mmへ正規化する。
 * 紙面mmの寸法/タグとテキスト白縁はそれぞれの用途を保つ。
 */
const CSS_PX_TO_MM = 25.4 / 96;
const PDF_LINE_WIDTH_FACTORS = Object.freeze({
  svg: 1,
  thin: 0.6,
  fine: 0.5,
  legacy: null,
});

/** Relative luminance 0-1 of a CSS color, or null when it is not a plain hex/rgb()/named color. */
function cssColorLuminance(value) {
  const text = String(value).trim().toLowerCase();
  if (text === 'white') return 1;
  if (text === 'black') return 0;
  let channels = null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
  if (hex) {
    const digits =
      hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit) : hex[1].match(/../g);
    channels = digits.map((part) => parseInt(part, 16));
  } else {
    const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(text);
    if (rgb) channels = [rgb[1], rgb[2], rgb[3]].map(Number);
  }
  if (!channels) return null;
  return (0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]) / 255;
}

/**
 * Monochrome print: every visible stroke, fill and text color becomes black. Near-white
 * paints (page background, text halos) stay white so contrast and knock-outs survive.
 */
function applyMonochrome(svg) {
  const keep = new Set(['none', 'transparent', 'currentcolor', 'inherit']);
  const convert = (value) => {
    if (value == null || value === '') return null;
    const text = String(value).trim().toLowerCase();
    if (keep.has(text) || text.startsWith('url(')) return null;
    const luminance = cssColorLuminance(text);
    // Light paints (white halo, paper) stay; anything else, including unknown names, prints black.
    return luminance !== null && luminance >= 0.9 ? null : '#000000';
  };
  for (const element of svg.querySelectorAll('*')) {
    for (const property of ['fill', 'stroke']) {
      const attribute = convert(element.getAttribute(property));
      if (attribute) element.setAttribute(property, attribute);
      const inline = convert(element.style?.[property]);
      if (inline) element.style[property] = inline;
    }
  }
}

export function applyDrawingSheetPdfPrintStyle(
  svg,
  { lineWidthPreset = 'thin', linePattern = 'svg', colorMode = 'color' } = {},
) {
  if (!Object.hasOwn(PDF_LINE_WIDTH_FACTORS, lineWidthPreset))
    throw new RangeError('未対応のPDF線幅設定です。');
  if (linePattern !== 'svg' && linePattern !== 'solid')
    throw new RangeError('未対応のPDF線種設定です。');
  if (colorMode !== 'color' && colorMode !== 'monochrome')
    throw new RangeError('未対応のPDF色設定です。');

  const factor = PDF_LINE_WIDTH_FACTORS[lineWidthPreset];
  for (const element of svg.querySelectorAll('[stroke-width]')) {
    // テキストの白縁は線ではなく可読性のための縁取りなので対象外。
    if (element.localName === 'text') continue;
    if (factor != null) {
      const rawWidth = Number(element.getAttribute('stroke-width'));
      if (Number.isFinite(rawWidth) && rawWidth > 0) {
        const isScreenWidth = element.getAttribute('vector-effect') === 'non-scaling-stroke';
        const widthMm = Number((rawWidth * (isScreenWidth ? CSS_PX_TO_MM : 1) * factor).toFixed(4));
        element.setAttribute('stroke-width', String(widthMm));
        if (element.style?.strokeWidth) element.style.strokeWidth = String(widthMm);
        // 非拡大線の破線長も画面px単位。線幅だけ換算すると実線/空白比が崩れる。
        // 紙面mm指定の寸法線の破線長は変更しない。
        if (isScreenWidth && linePattern === 'svg') {
          const rawDash =
            element.style?.strokeDasharray || element.getAttribute('stroke-dasharray');
          const segments = rawDash
            ?.trim()
            .split(/[\s,]+/)
            .map(Number);
          if (segments?.length && segments.every((value) => Number.isFinite(value) && value >= 0)) {
            const dashMm = segments
              .map((value) => Number((value * CSS_PX_TO_MM).toFixed(4)))
              .join(' ');
            element.setAttribute('stroke-dasharray', dashMm);
            if (element.style?.strokeDasharray) element.style.strokeDasharray = dashMm;
          }
        }
        // 印刷SVGは紙面mm座標なのでpx固定指定を除去する。
        if (isScreenWidth) element.removeAttribute('vector-effect');
      }
    }
  }
  if (linePattern === 'solid') {
    for (const element of svg.querySelectorAll('[stroke-dasharray]')) {
      if (element.localName === 'text') continue;
      element.removeAttribute('stroke-dasharray');
      if (element.style?.strokeDasharray) element.style.strokeDasharray = 'none';
    }
  }
  if (colorMode === 'monochrome') applyMonochrome(svg);
  return svg;
}

/** A3図面の出力範囲だけを切り出す。作業ビューの余白や表示ズームは出力しない。 */
export function prepareDrawingSheetSvgForPdf(sourceSvg, layout, printOptions = {}) {
  if (!sourceSvg || !layout || !isSheetPaperName(layout.paper))
    throw new Error('PDF保存には生成済みの図面（A0〜A4）が必要です。');
  const { widthMm, heightMm } = layout;
  if (![widthMm, heightMm].every((value) => Number.isFinite(value) && value > 0))
    throw new RangeError('PDF用紙寸法が不正です。');
  const svg = sourceSvg.cloneNode(true);
  svg.setAttribute('viewBox', `0 0 ${widthMm} ${heightMm}`);
  svg.setAttribute('width', String(widthMm));
  svg.setAttribute('height', String(heightMm));
  svg.style.width = `${widthMm}px`;
  svg.style.height = `${heightMm}px`;
  for (const element of svg.querySelectorAll('*')) {
    if (ignoredDuringExport(element)) element.remove();
    else element.classList?.remove('is-selected', 'is-candidate');
  }
  return applyDrawingSheetPdfPrintStyle(svg, printOptions);
}

/** PDF未読込でも、表示中のSTB/DXF図面・図面メモ・寸法をA3用紙に出力する。 */
export async function exportDrawingSheetPdf(
  panel,
  {
    filename,
    onProgress = null,
    html2canvas: captureOverride = null,
    JsPdf: pdfOverride = null,
    printOptions = {},
    mode = 'vector',
    fontFile = null,
    vectorRenderOverride = null,
  } = {},
) {
  const layout = panel?.sheetLayout;
  const source = panel?.e?.['pdf-overlay-svg-layer']?.querySelector?.('svg');
  if (!source || !layout) throw new Error('図面を生成してからPDF保存してください。');
  if (mode !== 'vector' && mode !== 'raster') throw new RangeError('PDF出力モードが不正です。');
  const JsPdf = pdfOverride || (await import('jspdf')).jsPDF;
  const svg = prepareDrawingSheetSvgForPdf(source, layout, printOptions);
  const ownerDocument = source.ownerDocument;
  const holder = ownerDocument.createElement('div');
  holder.className = 'pdf-overlay-svg-layer';
  Object.assign(holder.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    zIndex: '-1',
    width: `${layout.widthMm}px`,
    height: `${layout.heightMm}px`,
    pointerEvents: 'none',
    overflow: 'hidden',
    opacity: '1',
  });
  holder.append(svg);
  ownerDocument.body.append(holder);
  try {
    onProgress?.({ pageNumber: 1, numPages: 1 });
    if (mode === 'vector') {
      const { renderSvgToVectorPdf } = await import('./PdfOverlayVectorPdf.js');
      const pdf = await renderSvgToVectorPdf(svg, layout, {
        JsPdf,
        fontFile,
        ...(vectorRenderOverride ? { render: vectorRenderOverride } : {}),
      });
      await pdf.save(filename);
      return filename;
    }
    const capture = captureOverride || (await import('html2canvas')).default;
    const canvas = await capture(holder, {
      scale: 200 / 25.4, // A3を約200dpiで保存（表示倍率に依存しない）
      backgroundColor: '#ffffff',
      logging: false,
      useCORS: true,
      allowTaint: false,
    });
    const pointsPerMm = 72 / 25.4;
    const pdf = addCanvasToPdf(
      null,
      canvas,
      layout.widthMm * pointsPerMm,
      layout.heightMm * pointsPerMm,
      true,
      JsPdf,
    );
    pdf.save(filename);
    return filename;
  } finally {
    holder.remove();
  }
}

function addCanvasToPdf(pdf, canvas, widthPt, heightPt, firstPage, JsPdf) {
  const orientation = orientationFor(widthPt, heightPt);
  let target = pdf;
  if (!target) {
    // eslint-disable-next-line new-cap
    target = new JsPdf({
      orientation,
      unit: 'pt',
      format: [widthPt, heightPt],
      compress: true,
    });
  } else if (!firstPage) {
    target.addPage([widthPt, heightPt], orientation);
  }
  const image = canvas.toDataURL('image/jpeg', 0.96);
  target.addImage(image, 'JPEG', 0, 0, widthPt, heightPt, undefined, 'FAST');
  return target;
}

/**
 * 元PDFの全ページを再描画し、現在表示ページには画面上のSTB/寸法/メモを焼き込む。
 * 別ページに保存済みの自由メモ・寸法はPDF座標から再描画する。
 *
 * PDF.js + Canvas由来のラスタPDFとして保存するため、元PDFのベクター/テキスト構造は保持しない。
 */
export async function exportAnnotatedPdf(panel, { onProgress = null } = {}) {
  const adapter = panel?.pdfAdapter;
  const info = adapter?.info;
  const current = panel?.pageRender;
  if (!adapter || !info || !current)
    throw new Error('PDFを読み込み、表示してから保存してください。');

  const [{ default: html2canvas }, { jsPDF: JsPdf }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ]);

  panel.measurementUi?.resetPendingSequence?.();
  const currentPage = current.pageNumber;
  const currentSize = currentPagePointSize(panel);
  if (!currentSize) throw new Error('現在ページの寸法を取得できません。');
  const currentCapture = await captureCurrentPage(panel, html2canvas);
  const rotation = Number(panel.e?.['pdf-overlay-rotation']?.value || 0);

  let pdf = null;
  for (let pageNumber = 1; pageNumber <= info.numPages; pageNumber++) {
    onProgress?.({ pageNumber, numPages: info.numPages });
    let canvas;
    let widthPt;
    let heightPt;

    if (pageNumber === currentPage) {
      canvas = currentCapture;
      [widthPt, heightPt] = currentSize;
    } else {
      const render = await adapter.renderPage(pageNumber, {
        scale: EXPORT_RENDER_SCALE,
        rotation,
        outputScale: 1,
      });
      canvas = render.canvas;
      widthPt = render.width / EXPORT_RENDER_SCALE;
      heightPt = render.height / EXPORT_RENDER_SCALE;
      drawStoredAnnotations(panel, canvas, render, pageNumber);
    }

    pdf = addCanvasToPdf(pdf, canvas, widthPt, heightPt, pageNumber === 1, JsPdf);
  }

  const filename = buildAnnotatedPdfFilename(info.filename);
  pdf.save(filename);
  return filename;
}

export default exportAnnotatedPdf;
