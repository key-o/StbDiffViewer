/** #510: Persist a single named CAD elevation ViewSpec without serializing the SVG or camera.
 * The legacy plan-only Drawing Workspace editor is intentionally not used here.
 */
import {
  DRAWING_PROJECT_KIND,
  normalizeDrawingProject,
  parseDrawingProject,
  serializeDrawingProject,
} from '../../../data/drawing/drawingProjectSchema.js';

const SHA256 = /^[0-9a-f]{64}$/;

export function createSavedCadElevationProject({
  drawing,
  viewName,
  depth,
  scaleDenominator,
} = {}) {
  const source = drawing?.source;
  const view = drawing?.view;
  if (source?.modelKey !== 'A' || !SHA256.test(source?.modelRevision || ''))
    throw new Error('保存には改訂SHA-256が確定したSTB-A軸組図が必要です。');
  if (
    view?.type !== 'elevation' ||
    !['X', 'Y'].includes(view.axisDirection) ||
    !String(view.axisId || '').trim()
  )
    throw new Error('保存対象はX/Y通りの軸組図ビューに限ります。');
  const name = String(viewName || '').trim();
  if (!name || name.length > 100) throw new Error('ビュー名は1～100文字で指定してください。');
  if (
    !Number.isFinite(depth) ||
    depth <= 0 ||
    !Number.isFinite(scaleDenominator) ||
    scaleDenominator < 1
  )
    throw new Error('軸組図の奥行と縮尺が不正です。');
  if (
    Number.isFinite(view.lowerBound) &&
    Number.isFinite(view.upperBound) &&
    Math.abs((view.upperBound - view.lowerBound) / 2 - depth) > 1e-6
  )
    throw new Error('保存する奥行が現在プレビュー中の軸組図と一致しません。再生成してください。');
  const revision = source.modelRevision;
  const axisId = String(view.axisId);
  const direction = view.axisDirection;
  return normalizeDrawingProject({
    kind: DRAWING_PROJECT_KIND,
    schemaVersion: 1,
    units: { model: 'mm', paper: 'mm' },
    projectId: `cad-elevation:${direction}:${axisId}:${revision}`,
    modelSlots: [
      { id: 'A', currentRevisionId: revision, revisions: [{ id: revision, sha256: revision }] },
    ],
    bindings: [],
    drawingDocuments: [
      {
        id: `elevation:${direction}:${axisId}`,
        name,
        modelSlotId: 'A',
        sourceRevisionId: revision,
        view: { type: 'elevation', axisDirection: direction, axisId, depth },
        sheet: { paper: 'A3', orientation: 'landscape', scaleDenominator },
        tagIntents: [],
      },
    ],
  });
}

export function serializeSavedCadElevationProject(options) {
  return serializeDrawingProject(createSavedCadElevationProject(options));
}

/**
 * Validate before updating any CAD controls. A document with additional data
 * is rejected instead of silently losing it in the view-only UI.
 */
export function inspectSavedCadElevationProject(json, candidates) {
  const project = parseDrawingProject(json);
  if (
    project.modelSlots.length !== 1 ||
    project.drawingDocuments.length !== 1 ||
    project.modelSlots[0].id !== 'A' ||
    project.bindings.length !== 0
  )
    throw new Error('この操作はSTB-A単一軸組図ビューのJSONに限ります。');
  const document = project.drawingDocuments[0];
  const slot = project.modelSlots[0];
  if (
    document.view.type !== 'elevation' ||
    document.modelSlotId !== slot.id ||
    document.sourceRevisionId !== slot.currentRevisionId
  )
    throw new Error('保存ビューのモデル・改訂が不正です。');
  if (
    [
      document.tagIntents,
      document.dimensionIntents,
      document.memberReviews,
      document.annotations,
    ].some((items) => items.length > 0)
  )
    throw new Error('注記・レビューを含むDrawingProjectは簡易ビュー読込では保持できません。');
  const revision = slot.revisions.find((item) => item.id === document.sourceRevisionId)?.sha256;
  if (!revision || !SHA256.test(revision)) throw new Error('軸組図のSTB改訂SHA-256が不正です。');
  // This is a view-only adapter, not a general DrawingProject editor. Round-trip
  // only our exact single-view representation: sheet rotation, display overrides,
  // custom definitions, extra source revisions and axis bindings cannot be restored.
  const viewOnly = createSavedCadElevationProject({
    drawing: {
      source: { modelKey: 'A', modelRevision: revision },
      view: {
        type: 'elevation',
        axisDirection: document.view.axisDirection,
        axisId: document.view.axisId,
      },
    },
    viewName: document.name,
    depth: document.view.depth,
    scaleDenominator: document.sheet.scaleDenominator,
  });
  if (JSON.stringify(project) !== JSON.stringify(viewOnly))
    throw new Error('簡易ビュー読込で保持できない追加設定を含むDrawingProjectです。');
  const view = candidates?.find(
    (item) =>
      item.type === 'elevation' &&
      item.axisDirection === document.view.axisDirection &&
      item.axisId === document.view.axisId,
  );
  if (!view) throw new Error('保存した通り芯が現行STB-Aにありません。');
  return Object.freeze({
    view,
    name: document.name || view.label,
    depth: document.view.depth,
    scaleDenominator: document.sheet.scaleDenominator,
    revision,
  });
}
