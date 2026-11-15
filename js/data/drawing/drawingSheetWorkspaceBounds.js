/**
 * CAD sheet workspace extent. Paper is a print boundary, never a limit on
 * viewport placement. Include overshooting viewports for editor pan/zoom.
 * In-paper layouts retain the historic exact-paper SVG viewBox.
 */
import { getSheetPaperSize } from './drawingSheetPaper.js';

export function getDrawingSheetWorkspaceBounds(sheet, marginMm = 10) {
  const { widthMm, heightMm } = getSheetPaperSize(sheet.paper, sheet.orientation);
  const placements = [...(sheet.placements ?? []), ...(sheet.listPlacements ?? [])];
  const minX = Math.min(0, ...placements.map((p) => p.xMm));
  const minY = Math.min(0, ...placements.map((p) => p.yMm));
  const maxX = Math.max(widthMm, ...placements.map((p) => p.xMm + p.widthMm));
  const maxY = Math.max(heightMm, ...placements.map((p) => p.yMm + p.heightMm));
  const x = minX < 0 ? minX - marginMm : 0;
  const y = minY < 0 ? minY - marginMm : 0;
  const maxExtentX = maxX > widthMm ? maxX + marginMm : widthMm;
  const maxExtentY = maxY > heightMm ? maxY + marginMm : heightMm;
  return Object.freeze({
    minX: x,
    minY: y,
    widthMm: maxExtentX - x,
    heightMm: maxExtentY - y,
  });
}
