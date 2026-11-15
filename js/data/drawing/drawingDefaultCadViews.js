/**
 * Initialize an unsaved CAD workspace with a full set of STB-A view definitions.
 * Geometry is generated only for the first candidate, outside this pure function.
 * Sheets are intentionally not created: they are independent print layouts.
 */
import {
  DRAWING_PROJECT_KIND,
  DRAWING_PROJECT_SCHEMA_VERSION,
  normalizeDrawingProject,
} from './drawingProjectSchema.js';
import { registerAllCadSheetViews } from './drawingSheetBulkViewRegistration.js';

export function createDefaultCadViewProject({
  drawing,
  candidates,
  projectId,
  idFactory,
  depth = 1500,
  scaleDenominator = 200,
  display = {},
} = {}) {
  if (!Array.isArray(candidates) || !candidates.length)
    throw new Error('STB-Aの伏図・軸組図候補がありません。');
  if (typeof idFactory !== 'function') throw new TypeError('ビューID生成関数が必要です。');
  const first = candidates[0];
  const sha = drawing?.source?.modelRevision;
  if (drawing?.source?.modelKey !== 'A' || !/^[a-f0-9]{64}$/i.test(sha ?? ''))
    throw new Error('STB-Aの現行改訂付きDrawingModelが必要です。');
  const firstView =
    first.type === 'plan'
      ? { type: 'plan', storyId: String(first.storyId) }
      : first.type === 'elevation'
        ? {
            type: 'elevation',
            axisDirection: first.axisDirection,
            axisId: String(first.axisId),
            depth,
          }
        : null;
  if (!firstView || drawing.view?.type !== firstView.type)
    throw new Error('初期ビューと生成済みDrawingModelの種別が一致しません。');
  if (
    (firstView.type === 'plan' && String(drawing.view.storyId) !== firstView.storyId) ||
    (firstView.type === 'elevation' &&
      (drawing.view.axisDirection !== firstView.axisDirection ||
        String(drawing.view.axisId) !== firstView.axisId ||
        Math.abs((drawing.view.upperBound - drawing.view.lowerBound) / 2 - depth) > 1e-6))
  )
    throw new Error('初期ビューと生成済みDrawingModelの対象が一致しません。');

  const firstId = idFactory();
  const initial = normalizeDrawingProject({
    kind: DRAWING_PROJECT_KIND,
    schemaVersion: DRAWING_PROJECT_SCHEMA_VERSION,
    units: { model: 'mm', paper: 'mm' },
    projectId,
    modelSlots: [
      { id: 'structure', currentRevisionId: sha, revisions: [{ id: sha, sha256: sha }] },
    ],
    bindings: [],
    drawingDocuments: [
      {
        id: firstId,
        name: String(
          first.label || (firstView.type === 'plan' ? firstView.storyId : firstView.axisId),
        ),
        modelSlotId: 'structure',
        sourceRevisionId: sha,
        view: firstView,
        sheet: { paper: 'A3', orientation: 'landscape', scaleDenominator },
        display,
        tagIntents: [],
      },
    ],
    drawingSheets: [],
  });
  const result = registerAllCadSheetViews({
    project: initial,
    drawing,
    candidates,
    depth,
    scaleDenominator,
    display,
    idFactory,
  });
  return Object.freeze({
    project: result.project,
    addedIds: Object.freeze([firstId, ...result.addedIds]),
  });
}
