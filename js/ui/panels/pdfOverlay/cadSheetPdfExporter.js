/**
 * A3 multi-view PDF export for the persistent CAD sheet.
 *
 * The SVG is regenerated from the same preflighted DrawingRenderPlans used by
 * sheet preview / DXF, not from the screen or a 3D camera. The existing vector
 * PDF path performs resource/font validation and preserves native geometry.
 */
import {
  createDrawingSheetRenderPlans,
  renderDrawingSheetCompositeSvg,
} from '../../../viewer/drawing/drawingSheetCompositeSvg.js';
import { prepareDrawingSheetSvgForPdf } from './PdfOverlayPdfExporter.js';
import { renderSvgToVectorPdf } from './PdfOverlayVectorPdf.js';

const PDF_DPI = 200;

/**
 * Build the actual multi-view A3 paper SVG, without edit selections. This
 * function has no download or screen-capture side effects.
 */
export function prepareCompositeCadSheetPdf({
  project,
  sheetId,
  drawingsById,
  sourceDocument = null,
  document,
  printOptions = {},
  listReferencesByPlacementId = {},
} = {}) {
  const sheet = createDrawingSheetRenderPlans({
    project,
    sheetId,
    drawingsById,
    sourceDocument,
    listReferencesByPlacementId,
  });
  if (sheet.views.length === 0 && sheet.listViews.length === 0)
    throw new Error('PDF出力するシートビューがありません。');
  const svg = renderDrawingSheetCompositeSvg({
    project,
    sheetId,
    drawingsById,
    sourceDocument,
    document,
    selectedPlacementId: null,
    listReferencesByPlacementId,
    clipToPaper: true,
  });
  const prepared = prepareDrawingSheetSvgForPdf(svg, sheet, printOptions);
  return Object.freeze({ sheet, svg: prepared });
}

/**
 * Export the paper sheet as editable vector PDF, or raster fallback if the
 * selected print mode explicitly requests compatibility output.
 *
 * The caller must preflight the current STB revision and supply
 * assertBeforeSave to recheck identity/revision after async rendering.
 */
export async function exportCompositeCadSheetPdf({
  project,
  sheetId,
  drawingsById,
  sourceDocument = null,
  document,
  filename,
  output = 'save',
  mode = 'vector',
  fontFile = null,
  printOptions = {},
  listReferencesByPlacementId = {},
  JsPdf: pdfOverride = null,
  renderVectorOverride = null,
  captureOverride = null,
  assertBeforeSave = null,
} = {}) {
  if (mode !== 'vector' && mode !== 'raster') throw new RangeError('PDF出力モードが不正です。');
  if (output !== 'save' && output !== 'bytes') throw new RangeError('PDF出力先が不正です。');
  if (typeof filename !== 'string' || !filename.toLowerCase().endsWith('.pdf'))
    throw new TypeError('PDF保存ファイル名が不正です。');
  if (typeof assertBeforeSave !== 'function')
    throw new TypeError('PDF出力にはSTB改訂・DrawingProjectの最終照合関数が必要です。');
  const { sheet, svg } = prepareCompositeCadSheetPdf({
    project,
    sheetId,
    drawingsById,
    sourceDocument,
    document,
    printOptions,
    listReferencesByPlacementId,
  });
  const ownerDocument = svg.ownerDocument;
  if (!ownerDocument?.body) throw new Error('PDF生成用Documentが必要です。');
  const holder = ownerDocument.createElement('div');
  holder.className = 'pdf-overlay-svg-layer';
  Object.assign(holder.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    zIndex: '-1',
    width: sheet.widthMm + 'px',
    height: sheet.heightMm + 'px',
    pointerEvents: 'none',
    overflow: 'hidden',
    opacity: '1',
  });
  holder.append(svg);
  ownerDocument.body.append(holder);
  try {
    const JsPdf = pdfOverride || (await import('jspdf')).jsPDF;
    let pdf;
    if (mode === 'vector') {
      pdf = await renderSvgToVectorPdf(svg, sheet, {
        JsPdf,
        fontFile,
        ...(renderVectorOverride ? { render: renderVectorOverride } : {}),
      });
    } else {
      const capture = captureOverride || (await import('html2canvas')).default;
      const canvas = await capture(holder, {
        scale: PDF_DPI / 25.4,
        backgroundColor: '#ffffff',
        logging: false,
        useCORS: true,
        allowTaint: false,
      });
      // eslint-disable-next-line new-cap
      pdf = new JsPdf({
        orientation: sheet.orientation,
        unit: 'mm',
        format: [sheet.widthMm, sheet.heightMm],
        compress: true,
      });
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, sheet.widthMm, sheet.heightMm);
    }
    if (assertBeforeSave) await assertBeforeSave();
    const bytes = output === 'bytes' ? new Uint8Array(pdf.output('arraybuffer')) : null;
    if (output === 'save') await pdf.save(filename);
    return Object.freeze({
      ...(bytes ? { bytes } : {}),
      filename,
      mode,
      views: sheet.views.length,
      paper: sheet.paper,
      orientation: sheet.orientation,
      widthMm: sheet.widthMm,
      heightMm: sheet.heightMm,
    });
  } finally {
    holder.remove();
  }
}
