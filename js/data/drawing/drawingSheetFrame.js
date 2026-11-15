/**
 * #565: Sheet frame (図枠) and title block (表題欄) owned by the sheet, not by a view.
 *
 * `sheet.frame` is optional; a sheet without it keeps its previous JSON and output.
 * The plan below is the single source for the SVG preview/PDF and the DXF writer, so
 * every output draws the same lines and text. All plan coordinates are paper mm,
 * mathematical Y-up from the sheet's bottom-left corner. Stored placements and the
 * keep-out rectangles use the sheet's top-left, Y-down convention instead.
 */

import { getSheetPaperSize } from './drawingSheetPaper.js';

export const SHEET_FRAME_LAYER = 'SDV_SHEET_FRAME';
export const SHEET_TITLE_LAYER = 'SDV_SHEET_TITLE';

export const SHEET_FRAME_DEFAULT_MARGIN_MM = 10;
const MIN_MARGIN_MM = 5;
const MAX_MARGIN_MM = 30;
const MAX_TEXT_LENGTH = 80;
const TITLE_BLOCK_WIDTH_MM = 180;
const TITLE_BLOCK_HEIGHT_MM = 30;
const TITLE_FIELDS = ['projectName', 'drawnBy', 'date'];

function invalid(path, message) {
  const error = new Error(`DrawingProject schema error at ${path}: ${message}`);
  error.code = 'INVALID_SHEET_FRAME';
  error.path = path;
  throw error;
}

function text(value, path) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH || /[\r\n]/.test(value))
    invalid(path, `single-line text of ${MAX_TEXT_LENGTH} characters or fewer required`);
  return value;
}

/** Returns undefined when the sheet has no frame, so older projects round-trip unchanged. */
export function normalizeSheetFrame(value, path = 'frame') {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'object required');
  for (const key of Object.keys(value))
    if (key !== 'marginMm' && key !== 'titleBlock') invalid(`${path}.${key}`, 'unknown field');
  const marginMm = value.marginMm ?? SHEET_FRAME_DEFAULT_MARGIN_MM;
  if (!Number.isFinite(marginMm) || marginMm < MIN_MARGIN_MM || marginMm > MAX_MARGIN_MM)
    invalid(`${path}.marginMm`, `${MIN_MARGIN_MM}-${MAX_MARGIN_MM} mm required`);
  const block = value.titleBlock ?? {};
  if (typeof block !== 'object' || Array.isArray(block) || block === null)
    invalid(`${path}.titleBlock`, 'object required');
  for (const key of Object.keys(block))
    if (!TITLE_FIELDS.includes(key)) invalid(`${path}.titleBlock.${key}`, 'unknown field');
  return {
    marginMm,
    titleBlock: Object.fromEntries(
      TITLE_FIELDS.map((key) => [key, text(block[key], `${path}.titleBlock.${key}`)]),
    ),
  };
}

/** Geometry shared by the plan, the keep-out test and the placement helpers. Y-down from top-left. */
function frameGeometry(sheet) {
  const { widthMm, heightMm } = getSheetPaperSize(sheet.paper, sheet.orientation);
  const margin = sheet.frame.marginMm;
  const inner = { minX: margin, minY: margin, maxX: widthMm - margin, maxY: heightMm - margin };
  const blockWidth = Math.min(TITLE_BLOCK_WIDTH_MM, inner.maxX - inner.minX);
  const blockHeight = Math.min(TITLE_BLOCK_HEIGHT_MM, inner.maxY - inner.minY);
  const block = {
    minX: inner.maxX - blockWidth,
    minY: inner.maxY - blockHeight,
    maxX: inner.maxX,
    maxY: inner.maxY,
  };
  return { widthMm, heightMm, inner, block };
}

/** Areas of the sheet (top-left, Y-down) placements must stay inside (inner) and outside of (titleBlock). */
export function getSheetFrameLayout(sheet) {
  if (!sheet?.frame) return null;
  const { inner, block } = frameGeometry(sheet);
  return Object.freeze({ inner: Object.freeze(inner), titleBlock: Object.freeze(block) });
}

/**
 * Lines and text for the frame and title block, Y-up paper mm. Returns null without a frame.
 * Polylines are closed outlines; lines are the title block's inner dividers.
 */
export function buildSheetFramePlan(sheet) {
  if (!sheet?.frame) return null;
  const { heightMm, inner, block } = frameGeometry(sheet);
  const up = (y) => heightMm - y;
  const rect = (r) => [
    { x: r.minX, y: up(r.maxY) },
    { x: r.maxX, y: up(r.maxY) },
    { x: r.maxX, y: up(r.minY) },
    { x: r.minX, y: up(r.minY) },
  ];
  const midY = (block.minY + block.maxY) / 2;
  const splitA = block.minX + (block.maxX - block.minX) * 0.5;
  const splitB = block.minX + (block.maxX - block.minX) * 0.75;
  const fields = sheet.frame.titleBlock;
  const label = (id, x, yTop, height, value, anchor = 'left') => ({
    id: `sheet:frame:${id}`,
    layer: SHEET_TITLE_LAYER,
    x,
    // Baseline sits one text height below the cell's top edge.
    y: up(yTop + height),
    height,
    text: value,
    anchor,
  });
  const texts = [
    label('project', block.minX + 3, block.minY + 4, 5, fields.projectName),
    label('name', block.minX + 3, midY + 4, 5, sheet.name),
    label('number', splitA + 3, midY + 4, 4, `図番 ${sheet.number}`),
    label('date', splitB + 3, midY + 2, 3.5, fields.date),
    label('drawn-by', splitB + 3, midY + 8, 3.5, fields.drawnBy),
  ].filter((entry) => entry.text !== '');
  return Object.freeze({
    polylines: Object.freeze([
      Object.freeze({
        id: 'sheet:frame:inner',
        layer: SHEET_FRAME_LAYER,
        closed: true,
        points: Object.freeze(rect(inner)),
      }),
      Object.freeze({
        id: 'sheet:frame:title-block',
        layer: SHEET_TITLE_LAYER,
        closed: true,
        points: Object.freeze(rect(block)),
      }),
    ]),
    lines: Object.freeze([
      Object.freeze({
        id: 'sheet:frame:divider-row',
        layer: SHEET_TITLE_LAYER,
        start: { x: block.minX, y: up(midY) },
        end: { x: block.maxX, y: up(midY) },
      }),
      Object.freeze({
        id: 'sheet:frame:divider-a',
        layer: SHEET_TITLE_LAYER,
        start: { x: splitA, y: up(midY) },
        end: { x: splitA, y: up(block.maxY) },
      }),
      Object.freeze({
        id: 'sheet:frame:divider-b',
        layer: SHEET_TITLE_LAYER,
        start: { x: splitB, y: up(midY) },
        end: { x: splitB, y: up(block.maxY) },
      }),
    ]),
    texts: Object.freeze(texts.map((entry) => Object.freeze(entry))),
  });
}
