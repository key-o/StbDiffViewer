/** #565: A paper-only DrawingProject can exist before any STB model or view. */
import {
  DRAWING_PROJECT_KIND,
  DRAWING_PROJECT_SCHEMA_VERSION,
  normalizeDrawingProject,
} from './drawingProjectSchema.js';

/** Start with a real blank sheet, not a fabricated model revision or view. */
export function createEmptyDrawingSheetProject({ projectId, sheet }) {
  return normalizeDrawingProject({
    kind: DRAWING_PROJECT_KIND,
    schemaVersion: DRAWING_PROJECT_SCHEMA_VERSION,
    units: { model: 'mm', paper: 'mm' },
    projectId,
    modelSlots: [],
    bindings: [],
    drawingDocuments: [],
    drawingSheets: [sheet],
  });
}

/** Preserve paper layouts when the first independently generated STB-A view arrives. */
export function seedEmptyDrawingSheetProjectView({
  project: input,
  drawing,
  view,
  drawingDocumentId,
  name,
  scaleDenominator,
  display = {},
  cutBoundsMm = null,
}) {
  const project = normalizeDrawingProject(input);
  if (project.modelSlots.length || project.drawingDocuments.length || project.bindings.length)
    throw new Error('最初のビュー登録は空シートプロジェクトだけに対応します。');
  const sha = drawing?.source?.modelRevision;
  if (drawing?.source?.modelKey !== 'A' || !/^[0-9a-f]{64}$/i.test(sha ?? ''))
    throw new Error('STB-AのSHA-256付き図面が必要です。');
  return normalizeDrawingProject({
    ...project,
    modelSlots: [
      { id: 'structure', currentRevisionId: sha, revisions: [{ id: sha, sha256: sha }] },
    ],
    drawingDocuments: [
      {
        id: drawingDocumentId,
        name,
        modelSlotId: 'structure',
        sourceRevisionId: sha,
        view: cutBoundsMm ? { ...view, cutBoundsMm } : view,
        sheet: { paper: 'A3', orientation: 'landscape', scaleDenominator },
        display,
        tagIntents: [],
        dimensionIntents: [],
        memberReviews: [],
        annotations: [],
      },
    ],
  });
}
