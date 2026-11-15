/**
 * #516: Build sheet sources using the existing STB-A plan and elevation
 * producers. This is ephemeral runtime data, never persisted in DrawingProject.
 * Reject stale revisions, missing axes/stories, partial results and source drift.
 */
import { resolveSheetDrawingSources } from './drawingSheetViewCatalog.js';
import { createDrawingSheetComposition } from './drawingSheetComposition.js';
import { cutDrawingModelToBounds } from './drawingSheetCutRegion.js';

function requireNotAborted(signal) {
  if (signal?.aborted) throw new Error('シートビュー生成が中止されました。');
}

/**
 * @param {object} args
 * @param {object} args.services existing pdfOverlay services, not camera capture
 * @param {(storyId:string)=>object} args.planViewForStory createStoryPlanView callback
 * @returns {Promise<object>} map of DrawingDocument ID -> DrawingModel
 */
export async function collectDrawingSheetModels({
  project,
  sheetId,
  services,
  planViewForStory,
  signal,
  drawingCache = null,
  listReferencesByPlacementId = {},
  onProgress = null,
} = {}) {
  const sheet = project?.drawingSheets?.find((s) => s.id === sheetId);
  if (!sheet || sheet.kind === 'section-list') throw new Error('CADシートがありません: ' + sheetId);
  if (!sheet.placements?.length && !sheet.listPlacements?.length)
    throw new Error('シートに配置されたビューがありません。');
  if (drawingCache !== null && !(drawingCache instanceof Map))
    throw new TypeError('一括生成キャッシュはMapで指定してください。');
  if (
    typeof services?.createDrawing !== 'function' ||
    typeof services?.createAxisElevationDrawing !== 'function' ||
    typeof services?.assertDrawingSourceCurrent !== 'function' ||
    typeof planViewForStory !== 'function'
  )
    throw new Error('STB-Aのビュー生成・改訂照合サービスが不足しています。');

  // Generate each shared DrawingDocument only once; a sheet can place it repeatedly.
  // Optional diagnostics must never change whether sheet generation succeeds.
  const progress = (phase, drawingDocumentId = null) => {
    try {
      onProgress?.({ phase, drawingDocumentId });
    } catch {
      // Progress listeners are observational only.
    }
  };
  progress('collect-start');
  const drawingsById = Object.create(null);
  for (const placement of sheet.placements) {
    requireNotAborted(signal);
    const document = project.drawingDocuments?.find((d) => d.id === placement.drawingDocumentId);
    if (!document)
      throw new Error('DrawingDocumentが見つかりません: ' + placement.drawingDocumentId);
    if (Object.hasOwn(drawingsById, document.id)) continue;
    const slot = project.modelSlots?.find((s) => s.id === document.modelSlotId);
    if (!slot || document.sourceRevisionId !== slot.currentRevisionId)
      throw new Error('STB-Aの現在改訂と一致しません: ' + document.id);

    // A cache is scoped to one batch export. Cached geometry is never trusted
    // without rechecking the source and the final ViewSpec/layout gates.
    const cached = drawingCache?.get(document.id);
    let drawing = cached?.drawing ?? null;
    if (
      cached &&
      cached.signature !==
        JSON.stringify([document.modelSlotId, document.sourceRevisionId, document.view])
    )
      throw new Error('一括出力中にビュー定義が変更されました: ' + document.id);
    if (!drawing && document.view?.type === 'plan') {
      progress('plan-producer', document.id);
      const view = planViewForStory(document.view.storyId);
      if (view?.type !== 'plan' || String(view.storyId) !== String(document.view.storyId))
        throw new Error('対象階のViewSpecが一致しません: ' + document.id);
      drawing = await services.createDrawing({ modelKey: 'A', view, signal });
    } else if (!drawing && document.view?.type === 'elevation') {
      progress('elevation-producer', document.id);
      const { axisDirection, axisId, depth } = document.view;
      drawing = await services.createAxisElevationDrawing({
        modelKey: 'A',
        axisDirection,
        axisId,
        depth,
        signal,
      });
    } else if (!drawing) {
      throw new Error('未対応のシートビューです: ' + document.id);
    }
    requireNotAborted(signal);
    // The same materialized model cut is consumed by SVG, DXF and PDF.
    // Cached cuts may be reused only when the complete ViewSpec signature matches.
    if (document.view.cutBoundsMm && !drawing.cutBoundsMm)
      drawing = cutDrawingModelToBounds(drawing, document.view.cutBoundsMm);
    requireNotAborted(signal);
    // Explicit source revalidation closes the interval between individual producers.
    progress('source-revision-check', document.id);
    await services.assertDrawingSourceCurrent({ source: drawing?.source });
    requireNotAborted(signal);
    drawingsById[document.id] = drawing;
  }
  // One final complete check before exposing anything to the UI.
  progress('final-revision-check');
  for (const drawing of Object.values(drawingsById)) {
    await services.assertDrawingSourceCurrent({ source: drawing?.source });
    requireNotAborted(signal);
  }
  progress('sheet-composition-check');
  resolveSheetDrawingSources({ project, sheetId, drawingsById });
  createDrawingSheetComposition({ project, sheetId, drawingsById, listReferencesByPlacementId });
  // Do not expose any newly generated drawing to later sheets until this
  // entire sheet passed revision, ViewSpec and paper-boundary preflight.
  if (drawingCache) {
    requireNotAborted(signal);
    for (const documentId of Object.keys(drawingsById)) {
      const document = project.drawingDocuments.find((item) => item.id === documentId);
      drawingCache.set(documentId, {
        signature: JSON.stringify([document.modelSlotId, document.sourceRevisionId, document.view]),
        drawing: drawingsById[documentId],
      });
    }
  }
  progress('collect-complete');
  return Object.freeze(drawingsById);
}
