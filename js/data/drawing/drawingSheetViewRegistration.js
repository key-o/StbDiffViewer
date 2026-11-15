/**
 * Register a produced STB-A CAD ViewSpec without ever persisting DrawingModel
 * geometry, screen state or a camera. The caller checks the live source revision
 * using assertDrawingSourceCurrent before committing this pure transaction.
 */
import { registerSheetDrawingView } from './drawingSheetViewCatalog.js';
import { normalizeCutBoundsMm } from './drawingSheetCutRegion.js';
import { normalizeDrawingProject } from './drawingProjectSchema.js';

export function registerCurrentSheetView({
  project,
  drawing,
  selectedView,
  id,
  name,
  scaleDenominator,
  display = {},
  tagFamilyState = null,
  cutBoundsMm = null,
  createSeparate = false,
} = {}) {
  if (
    drawing?.source?.modelKey !== 'A' ||
    !/^[a-f0-9]{64}$/i.test(drawing?.source?.modelRevision ?? '')
  )
    throw new Error('STB-Aの現行SHA-256付きDrawingModelが必要です。');
  if (drawing.cutBoundsMm)
    throw new Error(
      '切り出し済みの描画結果から別のビューを登録できません。STBから元ビューを再生成してください。',
    );
  const actual = drawing.view;
  if (!actual || !selectedView || actual.type !== selectedView.type)
    throw new Error('選択ビューと生成済み図面が一致しません。');
  let view;
  if (actual.type === 'plan') {
    if (String(actual.storyId) !== String(selectedView.storyId))
      throw new Error('伏図の対象階が一致しません。');
    view = { type: 'plan', storyId: String(actual.storyId) };
  } else if (actual.type === 'elevation') {
    if (
      actual.axisDirection !== selectedView.axisDirection ||
      String(actual.axisId) !== String(selectedView.axisId)
    )
      throw new Error('軸組図の方向・通り芯が一致しません。');
    if (
      ![actual.lowerBound, actual.upperBound, actual.position].every(Number.isFinite) ||
      actual.upperBound <= actual.lowerBound ||
      Math.abs((actual.lowerBound + actual.upperBound) / 2 - actual.position) > 1e-6
    )
      throw new Error('軸組図の奥行・切断中心が不正です。');
    view = {
      type: 'elevation',
      axisDirection: actual.axisDirection,
      axisId: String(actual.axisId),
      depth: (actual.upperBound - actual.lowerBound) / 2,
    };
  } else {
    throw new Error('未対応のViewSpecです。');
  }
  const cut = normalizeCutBoundsMm(cutBoundsMm);
  if (cut) view.cutBoundsMm = cut;
  const sha = drawing.source.modelRevision.toLowerCase();
  const matchingSlots = (project?.modelSlots ?? []).filter((slot) => {
    const revision = slot.revisions?.find((rev) => rev.id === slot.currentRevisionId);
    return revision && (revision.id.toLowerCase() === sha || revision.sha256.toLowerCase() === sha);
  });
  if (matchingSlots.length !== 1) throw new Error('STB-Aの現行改訂を一意に解決できません。');
  const slot = matchingSlots[0];
  const existing =
    !createSeparate &&
    (project.drawingDocuments ?? []).find(
      (document) =>
        document.modelSlotId === slot.id &&
        document.sourceRevisionId === slot.currentRevisionId &&
        document.view.type === view.type &&
        (view.type === 'plan'
          ? document.view.storyId === view.storyId
          : document.view.axisDirection === view.axisDirection &&
            document.view.axisId === view.axisId &&
            Math.abs(document.view.depth - view.depth) < 1e-6) &&
        JSON.stringify(document.view.cutBoundsMm ?? null) === JSON.stringify(cut),
    );
  const withDefinitions =
    tagFamilyState == null
      ? project
      : normalizeDrawingProject({
          ...project,
          definitions: { ...project.definitions, tagFamilyState },
        });
  if (existing) {
    const hasDisplayUpdate = Object.keys(display).length > 0;
    if (!hasDisplayUpdate && withDefinitions === project)
      return { project, drawingDocumentId: existing.id, added: false };
    const updated = normalizeDrawingProject({
      ...withDefinitions,
      drawingDocuments: withDefinitions.drawingDocuments.map((document) =>
        document.id === existing.id && hasDisplayUpdate ? { ...document, display } : document,
      ),
    });
    return { project: updated, drawingDocumentId: existing.id, added: false, updated: true };
  }
  const next = registerSheetDrawingView(withDefinitions, {
    id,
    name,
    view,
    modelSlotId: slot.id,
    sourceRevisionId: slot.currentRevisionId,
    scaleDenominator,
    display,
  });
  return { project: next, drawingDocumentId: id, added: true };
}
