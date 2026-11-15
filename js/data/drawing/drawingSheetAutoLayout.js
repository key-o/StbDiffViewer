/**
 * #510: Convert independently generated plan/elevation DrawingModels into
 * persisted A3 sheets. The current drawing and revision are validated by
 * the caller before executing this deterministic, atomic layout transaction.
 */
import { normalizeDrawingProject } from './drawingProjectSchema.js';
import { getSheetPaperSize, isSheetPaperName } from './drawingSheetPaper.js';

const MARGIN_MM = 10;
const GAP_MM = 6;
const FRAME_PADDING_MM = 8;
const EPS = 1e-6;

function matchesDrawingView(spec, drawing) {
  if (spec.type !== drawing.view?.type) return false;
  if (spec.type === 'plan') return String(drawing.view.storyId) === spec.storyId;
  return (
    drawing.view.axisDirection === spec.axisDirection &&
    String(drawing.view.axisId) === spec.axisId &&
    [drawing.view.lowerBound, drawing.view.upperBound, drawing.view.position].every(
      Number.isFinite,
    ) &&
    Math.abs((drawing.view.upperBound + drawing.view.lowerBound) / 2 - drawing.view.position) <
      EPS &&
    Math.abs((drawing.view.upperBound - drawing.view.lowerBound) / 2 - spec.depth) < EPS
  );
}

export function autoPlaceUnplacedCadViews({
  project: input,
  drawingsById,
  idFactory,
  orientation = 'landscape',
  paper = 'A3',
  sheetNumberPrefix = 'AUTO-',
} = {}) {
  const project = normalizeDrawingProject(input);
  if (typeof idFactory !== 'function')
    throw new TypeError('一括シート配置にID生成関数が必要です。');
  if (!['landscape', 'portrait'].includes(orientation)) throw new Error('用紙方向が不正です。');
  if (!isSheetPaperName(paper)) throw new Error('用紙サイズが不正です。');
  const { widthMm: paperWidth, heightMm: paperHeight } = getSheetPaperSize(paper, orientation);
  const unplaced = project.drawingDocuments.filter(
    (document) =>
      !project.drawingSheets?.some(
        (sheet) =>
          sheet.kind !== 'section-list' &&
          sheet.placements.some((placement) => placement.drawingDocumentId === document.id),
      ),
  );
  if (!unplaced.length)
    return Object.freeze({ project, addedSheets: Object.freeze([]), addedPlacements: 0 });

  // Validate all future geometries before touching the DrawingProject.
  const items = unplaced.map((document) => {
    const drawing = drawingsById?.[document.id];
    const slot = project.modelSlots.find((entry) => entry.id === document.modelSlotId);
    const revision = slot?.revisions.find((entry) => entry.id === document.sourceRevisionId);
    if (
      !drawing ||
      drawing.schemaVersion !== 1 ||
      drawing.units !== 'mm' ||
      drawing.source?.modelKey !== 'A' ||
      document.sourceRevisionId !== slot?.currentRevisionId ||
      !revision ||
      ![revision.id.toLowerCase(), revision.sha256.toLowerCase()].includes(
        String(drawing.source?.modelRevision || '').toLowerCase(),
      ) ||
      !matchesDrawingView(document.view, drawing)
    )
      throw new Error('未配置ビューのDrawingModel/改訂が一致しません: ' + document.id);
    const b = drawing.bounds;
    if (
      !b ||
      ![b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite) ||
      b.maxX <= b.minX ||
      b.maxY <= b.minY
    )
      throw new Error('ビューの描画範囲が不正です: ' + document.id);
    const scaleDenominator = document.sheet.scaleDenominator;
    const w = (b.maxX - b.minX) / scaleDenominator;
    const h = (b.maxY - b.minY) / scaleDenominator;
    const fits = (width, height) =>
      width + FRAME_PADDING_MM <= paperWidth - 2 * MARGIN_MM + EPS &&
      height + FRAME_PADDING_MM <= paperHeight - 2 * MARGIN_MM + EPS;
    let rotationDeg = 0;
    let widthMm = w + FRAME_PADDING_MM;
    let heightMm = h + FRAME_PADDING_MM;
    if (!fits(w, h) && fits(h, w)) {
      rotationDeg = 90;
      widthMm = h + FRAME_PADDING_MM;
      heightMm = w + FRAME_PADDING_MM;
    }
    // Oversize viewports remain at their chosen scale. The sheet is only
    // the print window, so automatic placement may extend beyond its paper.
    return { document, widthMm, heightMm, rotationDeg, scaleDenominator };
  });

  const pages = [];
  let page = null;
  let x = MARGIN_MM;
  let y = MARGIN_MM;
  let rowHeight = 0;
  for (const item of items) {
    if (page && x + item.widthMm > paperWidth - MARGIN_MM + EPS) {
      x = MARGIN_MM;
      y += rowHeight + GAP_MM;
      rowHeight = 0;
    }
    if (!page || y + item.heightMm > paperHeight - MARGIN_MM + EPS) {
      page = { items: [] };
      pages.push(page);
      x = MARGIN_MM;
      y = MARGIN_MM;
      rowHeight = 0;
    }
    page.items.push({ ...item, xMm: x, yMm: y });
    x += item.widthMm + GAP_MM;
    rowHeight = Math.max(rowHeight, item.heightMm);
  }

  const usedNumbers = new Set((project.drawingSheets || []).map((sheet) => sheet.number));
  const addedSheets = [];
  let next = project;
  let seq = 1;
  for (const pageData of pages) {
    let number;
    do {
      number = sheetNumberPrefix + String(seq++).padStart(3, '0');
    } while (usedNumbers.has(number));
    usedNumbers.add(number);
    const sheetId = idFactory('sheet');
    addedSheets.push(sheetId);
    next = {
      ...next,
      drawingSheets: [
        ...(next.drawingSheets || []),
        {
          id: sheetId,
          number,
          name: '自動配置シート ' + number,
          paper,
          orientation,
          placements: pageData.items.map((item) => ({
            id: idFactory('placement'),
            drawingDocumentId: item.document.id,
            xMm: item.xMm,
            yMm: item.yMm,
            widthMm: item.widthMm,
            heightMm: item.heightMm,
            scaleDenominator: item.scaleDenominator,
            rotationDeg: item.rotationDeg,
          })),
        },
      ],
    };
  }
  return Object.freeze({
    project: normalizeDrawingProject(next),
    addedSheets: Object.freeze(addedSheets),
    addedPlacements: items.length,
  });
}
