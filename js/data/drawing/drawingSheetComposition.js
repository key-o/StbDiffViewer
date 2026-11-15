/**
 * #516 multi-view sheet preflight. Only paper-mm similarity transforms are produced.
 * Keep the user-selected scale even when view geometry exceeds its viewport.
 * The viewport and printable paper perform clipping at render/export time.
 * Preview/PDF/DXF may all use these same matrices in subsequent render adapters.
 */
import { createModelToPaperMatrix } from './drawingRenderPlan.js';
import { transformPoint } from './affine2d.js';
import { assertDrawingSheetPublishable } from './drawingSheetCollection.js';
import { getSheetPaperSize } from './drawingSheetPaper.js';
import { resolveSheetDrawingSources } from './drawingSheetViewCatalog.js';

const EPS = 1e-6;
function checkBounds(bounds, viewId) {
  if (
    !bounds ||
    !['minX', 'minY', 'maxX', 'maxY'].every((key) => Number.isFinite(bounds[key])) ||
    bounds.maxX <= bounds.minX ||
    bounds.maxY <= bounds.minY
  )
    throw new Error('描画範囲が不正です: ' + viewId);
  return bounds;
}

/**
 * @returns {Object} exact A3 paper-mm placements and model->paper affine matrices.
 * The caller MUST render each view with its returned matrix, never recompute it.
 */
export function createDrawingSheetComposition({
  project,
  sheetId,
  drawingsById,
  listReferencesByPlacementId = {},
} = {}) {
  const sheet = project?.drawingSheets?.find((item) => item.id === sheetId);
  if (!sheet || sheet.kind === 'section-list') throw new Error('CADシートがありません: ' + sheetId);
  assertDrawingSheetPublishable(sheet);
  const sources = resolveSheetDrawingSources({ project, sheetId, drawingsById });
  const { heightMm: paperHeightMm } = getSheetPaperSize(sheet.paper, sheet.orientation);
  const views = sources.map(({ placement, drawingDocument, drawing }) => {
    const bounds = checkBounds(drawing.bounds, drawingDocument.id);
    // Stored placements use sheet top-left; paper output uses mathematical Y-up.
    const modelOrigin = [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2];
    const targetOrigin = [
      placement.xMm + placement.widthMm / 2 + (placement.viewOffsetXMm ?? 0),
      paperHeightMm - placement.yMm - placement.heightMm / 2 - (placement.viewOffsetYMm ?? 0),
    ];
    const matrix = createModelToPaperMatrix({
      modelOrigin,
      paperOriginMm: targetOrigin,
      modelToPaperScale: 1 / placement.scaleDenominator,
      rotationDeg: placement.rotationDeg,
    });
    const points = [
      [bounds.minX, bounds.minY],
      [bounds.maxX, bounds.minY],
      [bounds.maxX, bounds.maxY],
      [bounds.minX, bounds.maxY],
    ].map((point) => transformPoint(matrix, point));
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const rect = {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
    // The fixed-scale view may be larger than its viewport. Do not autoscale
    // or reject; SVG/PDF render the intersection with that viewport.
    return Object.freeze({
      placementId: placement.id,
      drawingDocumentId: drawingDocument.id,
      view: drawingDocument.view,
      modelToPaper: Object.freeze([...matrix]),
      boundsPaperMm: Object.freeze(rect),
      scaleDenominator: placement.scaleDenominator,
      rotationDeg: placement.rotationDeg,
    });
  });
  const listViews = (sheet.listPlacements ?? []).map((placement) =>
    composeListPlacement({ project, placement, paperHeightMm, listReferencesByPlacementId }),
  );
  return Object.freeze({
    sheetId,
    paper: sheet.paper,
    orientation: sheet.orientation,
    units: 'paper-mm',
    views: Object.freeze(views),
    listViews: Object.freeze(listViews),
  });
}

/**
 * 断面リスト領域は、リストの左上を配置枠の左上に合わせ、配置の縮尺で紙面へ変換する。
 * 図形は呼出し側が現行STB-Aから再生成したReferenceDrawingで、改訂不一致・枠超過は拒否する。
 */
function composeListPlacement({ project, placement, paperHeightMm, listReferencesByPlacementId }) {
  const reference = listReferencesByPlacementId?.[placement.id];
  if (reference?.kind !== 'ReferenceDrawing')
    throw new Error('断面リスト領域の図形がありません: ' + placement.id);
  const slot = project.modelSlots?.find((s) => s.id === placement.modelSlotId);
  if (
    !slot ||
    placement.sourceRevisionId !== slot.currentRevisionId ||
    reference.source.revision !== placement.sourceRevisionId
  )
    throw new Error('STB改訂が一致しません: ' + placement.id);
  const bounds = checkBounds(
    reference.bounds && {
      minX: reference.bounds.minX,
      minY: reference.bounds.minY,
      maxX: reference.bounds.maxX,
      maxY: reference.bounds.maxY,
    },
    placement.id,
  );
  const scale = 1 / placement.scaleDenominator;
  const matrix = [
    scale,
    0,
    0,
    scale,
    placement.xMm - bounds.minX * scale,
    paperHeightMm - placement.yMm - bounds.maxY * scale,
  ];
  const widthMm = (bounds.maxX - bounds.minX) * scale;
  const heightMm = (bounds.maxY - bounds.minY) * scale;
  if (widthMm > placement.widthMm + EPS || heightMm > placement.heightMm + EPS)
    throw new Error('指定縮尺ではリスト領域が配置枠に収まりません: ' + placement.id);
  return Object.freeze({
    placementId: placement.id,
    listType: placement.listType,
    reference,
    modelToPaper: Object.freeze(matrix),
    scaleDenominator: placement.scaleDenominator,
  });
}
