/**
 * Start a DrawingProject directly from a generated STB-A axis-elevation view.
 * The legacy workspace snapshot requires a plan view; elevation registration
 * must not create a fake plan or persist preview geometry.
 */
import {
  DRAWING_PROJECT_KIND,
  DRAWING_PROJECT_SCHEMA_VERSION,
  normalizeDrawingProject,
} from '../../../data/drawing/drawingProjectSchema.js';
import { registerCurrentSheetView } from '../../../data/drawing/drawingSheetViewRegistration.js';

export function createInitialCadElevationProject({
  drawing,
  selectedView,
  projectId,
  drawingDocumentId,
  name,
  scaleDenominator,
} = {}) {
  if (drawing?.view?.type !== 'elevation' || selectedView?.type !== 'elevation')
    throw new Error('軸組図の初期登録には生成済み軸組図が必要です。');
  const sha = drawing.source?.modelRevision;
  if (drawing.source?.modelKey !== 'A' || !/^[a-f0-9]{64}$/i.test(sha || ''))
    throw new Error('STB-AのSHA-256付きDrawingModelが必要です。');
  const depth = (drawing.view.upperBound - drawing.view.lowerBound) / 2;
  if (
    drawing.view.axisDirection !== selectedView.axisDirection ||
    String(drawing.view.axisId) !== String(selectedView.axisId) ||
    !Number.isFinite(depth) ||
    depth <= 0 ||
    !Number.isFinite(drawing.view.position) ||
    Math.abs((drawing.view.lowerBound + drawing.view.upperBound) / 2 - drawing.view.position) > 1e-6
  )
    throw new Error('選択ビューと切り出した軸組図が一致しません。');

  const initial = normalizeDrawingProject({
    kind: DRAWING_PROJECT_KIND,
    schemaVersion: DRAWING_PROJECT_SCHEMA_VERSION,
    units: { model: 'mm', paper: 'mm' },
    projectId,
    modelSlots: [
      {
        id: 'structure',
        currentRevisionId: sha,
        revisions: [{ id: sha, sha256: sha }],
      },
    ],
    bindings: [],
    drawingDocuments: [
      {
        id: drawingDocumentId,
        name,
        modelSlotId: 'structure',
        sourceRevisionId: sha,
        view: {
          type: 'elevation',
          axisDirection: drawing.view.axisDirection,
          axisId: String(drawing.view.axisId),
          depth,
        },
        sheet: { paper: 'A3', orientation: 'landscape', scaleDenominator },
        display: {},
        tagIntents: [],
        dimensionIntents: [],
        memberReviews: [],
        annotations: [],
      },
    ],
  });
  // Reuse the standard ViewSpec registration guard, including source/view identity.
  registerCurrentSheetView({
    project: initial,
    drawing,
    selectedView,
    id: drawingDocumentId,
    name,
    scaleDenominator,
  });
  return initial;
}
