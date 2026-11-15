/**
 * #516: Multi-view metadata for a DrawingProject sheet collection.
 * Views are DrawingDocuments, never SVG/RenderPlans or implicit 3D camera snapshots.
 * This module is UI-independent so the legacy single-plan workspace remains untouched.
 */
import { normalizeDrawingProject } from './drawingProjectSchema.js';

function fail(message) {
  throw new Error(message);
}
function readDocument(project, id) {
  const document = project.drawingDocuments.find((candidate) => candidate.id === id);
  if (!document) fail('指定したDrawingDocumentがありません: ' + id);
  return document;
}

/** Register an explicit plan/elevation ViewSpec against the active revision. */
export function registerSheetDrawingView(
  input,
  { id, name, view, modelSlotId, sourceRevisionId, scaleDenominator = 200, display = {} } = {},
) {
  const project = normalizeDrawingProject(input);
  if (typeof id !== 'string' || !id.trim()) fail('ビューIDが必要です。');
  if (project.drawingDocuments.some((document) => document.id === id))
    fail('ビューIDが重複しています: ' + id);
  if (!['plan', 'elevation'].includes(view?.type)) fail('対応していないViewSpecです。');
  const slot = project.modelSlots.find((candidate) => candidate.id === modelSlotId);
  if (!slot || sourceRevisionId !== slot.currentRevisionId)
    fail('モデルスロットまたは現行改訂が一致しません。');
  if (!Number.isFinite(scaleDenominator) || scaleDenominator < 1)
    fail('図面縮尺は1以上の有限値で指定してください。');
  if (typeof name !== 'string' || !name.trim() || name.length > 100)
    fail('ビュー名は1～100文字で指定してください。');
  // Schema normalisation validates axis, depth, Story/Axis bindings and unknown fields.
  return normalizeDrawingProject({
    ...project,
    drawingDocuments: [
      ...project.drawingDocuments,
      {
        id,
        name,
        modelSlotId,
        sourceRevisionId,
        view,
        sheet: { paper: 'A3', orientation: 'landscape', scaleDenominator },
        display,
        tagIntents: [],
      },
    ],
  });
}

export function renameSheetDrawingView(input, drawingId, name) {
  const project = normalizeDrawingProject(input);
  readDocument(project, drawingId);
  if (typeof name !== 'string' || !name.trim() || name.length > 100)
    fail('ビュー名は1～100文字で指定してください。');
  return normalizeDrawingProject({
    ...project,
    drawingDocuments: project.drawingDocuments.map((document) =>
      document.id === drawingId ? { ...document, name } : document,
    ),
  });
}

/** Referenced views must be unplaced explicitly before deletion. */
export function removeSheetDrawingView(input, drawingId) {
  const project = normalizeDrawingProject(input);
  readDocument(project, drawingId);
  if (project.drawingDocuments.length < 2) fail('最後のDrawingDocumentは削除できません。');
  if (
    (project.drawingSheets ?? []).some(
      (sheet) =>
        sheet.kind !== 'section-list' &&
        sheet.placements.some((p) => p.drawingDocumentId === drawingId),
    )
  )
    fail('シートに配置済みのビューは削除できません。先に配置解除してください。');
  return normalizeDrawingProject({
    ...project,
    drawingDocuments: project.drawingDocuments.filter((document) => document.id !== drawingId),
  });
}

function sameView(expected, actual, drawing) {
  if (expected.type !== actual?.type) return false;
  const cut = expected.cutBoundsMm ?? null;
  if (JSON.stringify(cut) !== JSON.stringify(drawing.cutBoundsMm ?? null)) return false;
  if (expected.type === 'plan') return expected.storyId === String(actual.storyId);
  return (
    expected.axisDirection === actual.axisDirection &&
    expected.axisId === String(actual.axisId) &&
    Number.isFinite(actual.lowerBound) &&
    Number.isFinite(actual.upperBound) &&
    actual.lowerBound < actual.upperBound &&
    Number.isFinite(actual.position) &&
    Math.abs((actual.lowerBound + actual.upperBound) / 2 - actual.position) < 1e-6 &&
    Math.abs((actual.upperBound - actual.lowerBound) / 2 - expected.depth) < 1e-6
  );
}

/** Preflight a sheet's pre-rendered source drawings, with no camera fallback. */
export function resolveSheetDrawingSources({ project: input, sheetId, drawingsById } = {}) {
  const project = normalizeDrawingProject(input);
  const sheet = (project.drawingSheets ?? []).find((candidate) => candidate.id === sheetId);
  if (!sheet || sheet.kind === 'section-list') fail('CADシートがありません: ' + sheetId);
  if (!drawingsById || typeof drawingsById !== 'object' || Array.isArray(drawingsById))
    fail('ビューごとのDrawingModelが必要です。');
  const resolved = sheet.placements.map((placement) => {
    const document = readDocument(project, placement.drawingDocumentId);
    const drawing = drawingsById[document.id];
    if (drawing?.schemaVersion !== 1 || drawing.units !== 'mm')
      fail('DrawingModel v1(mm)がありません: ' + document.id);
    const slot = project.modelSlots.find((s) => s.id === document.modelSlotId);
    const revision = slot?.revisions.find((r) => r.id === document.sourceRevisionId);
    if (
      !revision ||
      document.sourceRevisionId !== slot.currentRevisionId ||
      ![revision.id.toLowerCase(), revision.sha256.toLowerCase()].includes(
        String(drawing.source?.modelRevision ?? '').toLowerCase(),
      )
    )
      fail('STB改訂が一致しません: ' + document.id);
    if (!sameView(document.view, drawing.view, drawing))
      fail('ViewSpecがDrawingModelと一致しません: ' + document.id);
    if (drawing.source?.modelKey !== 'A')
      fail('図面の正本はSTB-Aのみ対応しています: ' + document.id);
    return Object.freeze({ placement, drawingDocument: document, drawing });
  });
  return Object.freeze(resolved);
}
