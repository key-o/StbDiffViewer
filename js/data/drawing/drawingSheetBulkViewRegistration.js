/**
 * #510: Atomically register every STB-A story plan / X,Y orthogonal axis view.
 * Only persistent ViewSpecs are added: no drawing geometry or UI-state caches.
 */
import { normalizeDrawingProject } from './drawingProjectSchema.js';
import { seedEmptyDrawingSheetProjectView } from './drawingSheetEmptyProject.js';
import { registerSheetDrawingView } from './drawingSheetViewCatalog.js';

function sameCandidate(document, view) {
  if (document.view.type !== view.type || document.view.cutBoundsMm) return false;
  if (view.type === 'plan') return document.view.storyId === view.storyId;
  return (
    document.view.axisDirection === view.axisDirection &&
    document.view.axisId === view.axisId &&
    Math.abs(document.view.depth - view.depth) < 1e-6
  );
}

export function registerAllCadSheetViews({
  project: input,
  drawing,
  candidates,
  depth = 1500,
  scaleDenominator = 200,
  display = {},
  idFactory,
} = {}) {
  if (
    drawing?.source?.modelKey !== 'A' ||
    !/^[a-f0-9]{64}$/i.test(drawing?.source?.modelRevision || '')
  )
    throw new Error('STB-Aの現行改訂付きDrawingModelが必要です。');
  if (!Number.isFinite(depth) || depth <= 0)
    throw new Error('軸組図奥行は正の数値で指定してください。');
  if (!Number.isFinite(scaleDenominator) || scaleDenominator < 1)
    throw new Error('図面縮尺は1以上で指定してください。');
  if (typeof idFactory !== 'function') throw new TypeError('ビューID生成関数が必要です。');
  if (!Array.isArray(candidates) || candidates.length === 0)
    throw new Error('STB-Aの伏図・軸組図候補がありません。');

  const project = normalizeDrawingProject(input);
  const sha = drawing.source.modelRevision.toLowerCase();
  const slots = project.modelSlots.filter((slot) =>
    slot.revisions?.some(
      (rev) =>
        rev.id === slot.currentRevisionId &&
        (rev.id.toLowerCase() === sha || rev.sha256.toLowerCase() === sha),
    ),
  );
  const paperOnly = !project.modelSlots.length && !project.drawingDocuments.length;
  if (!paperOnly && slots.length !== 1) throw new Error('STB-Aの現在改訂が一意に一致しません。');
  let slot = slots[0] || null;
  let next = project;
  const seen = new Set();
  const addedIds = [];
  let reused = 0;

  for (const candidate of candidates) {
    let view;
    if (candidate?.type === 'plan') {
      const storyId = String(candidate.storyId || '').trim();
      if (!storyId) throw new Error('伏図の階IDが不正です。');
      view = { type: 'plan', storyId };
    } else if (candidate?.type === 'elevation') {
      const direction = candidate.axisDirection;
      const axisId = String(candidate.axisId || '').trim();
      if (!['X', 'Y'].includes(direction) || !axisId)
        throw new Error('軸組図の方向・通り芯IDが不正です。');
      view = { type: 'elevation', axisDirection: direction, axisId, depth };
    } else {
      throw new Error('一括登録に未対応のビュー候補があります。');
    }
    const identity = JSON.stringify(view);
    if (seen.has(identity)) throw new Error('一括登録ビュー候補が重複しています: ' + identity);
    seen.add(identity);

    if (paperOnly && !slot) {
      // Bootstrap the first ViewSpec and the model revision together while
      // retaining the paper-only project's ID and pre-existing sheets.
      const newId = idFactory();
      next = seedEmptyDrawingSheetProjectView({
        project: next,
        drawing,
        view,
        drawingDocumentId: newId,
        name: String(candidate.label || (view.type === 'plan' ? view.storyId : view.axisId)),
        scaleDenominator,
        display,
      });
      slot = next.modelSlots[0];
      addedIds.push(newId);
      continue;
    }

    const existing = next.drawingDocuments.some(
      (item) =>
        item.modelSlotId === slot.id &&
        item.sourceRevisionId === slot.currentRevisionId &&
        sameCandidate(item, view),
    );
    if (existing) {
      reused++;
      continue;
    }
    const newId = idFactory();
    next = registerSheetDrawingView(next, {
      id: newId,
      name: String(candidate.label || (view.type === 'plan' ? view.storyId : view.axisId)),
      modelSlotId: slot.id,
      sourceRevisionId: slot.currentRevisionId,
      view,
      scaleDenominator,
      display,
    });
    addedIds.push(newId);
  }
  return Object.freeze({ project: next, addedIds: Object.freeze(addedIds), reused });
}
