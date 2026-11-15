/**
 * #423: prepare the first DrawingModel from an already verified project ZIP.
 * This stage is deliberately isolated: it never writes model A/B, the current
 * DrawingProject, or the rendered workspace. Callers commit only after their
 * normal project/view/binding restoration gate succeeds.
 */
import { normalizeDrawingProject } from './drawingProjectSchema.js';

export class DrawingProjectArchiveBootstrapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DrawingProjectArchiveBootstrapError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DrawingProjectArchiveBootstrapError(code, message);
}

const sourceKey = (slotId, revisionId) => JSON.stringify([slotId, revisionId]);

/** Select an explicit, unambiguous current-revision plan view and its STB. */
export function planDrawingProjectArchiveBootstrap({ project, sourceRevisions, drawingId } = {}) {
  if (!Array.isArray(project?.modelSlots) || !Array.isArray(project?.drawingDocuments))
    fail('INVALID_PROJECT', 'DrawingProjectが不正です。');
  if (!Array.isArray(sourceRevisions))
    fail('MISSING_ARCHIVE_SOURCES', 'ZIPから検証済みSTB原本が取得できません。');

  const normalized = normalizeDrawingProject(project);
  const currentDocuments = normalized.drawingDocuments.filter((document) => {
    const slot = normalized.modelSlots.find((item) => item.id === document.modelSlotId);
    return slot?.currentRevisionId === document.sourceRevisionId;
  });
  const matches =
    drawingId == null
      ? currentDocuments
      : currentDocuments.filter((document) => document.id === drawingId);
  if (matches.length !== 1)
    fail(
      'DRAWING_SELECTION_REQUIRED',
      matches.length
        ? '復元対象の図面が一意ではありません。'
        : '復元対象の現行図面を一意に指定してください。',
    );
  const document = matches[0];
  if (
    !['plan', 'elevation'].includes(document.view?.type) ||
    (document.view.type === 'plan' && !document.view.storyId)
  )
    fail('UNSUPPORTED_BOOTSTRAP_VIEW', '初期復元に対応しないSTB図面ビューです。');
  const slot = normalized.modelSlots.find((item) => item.id === document.modelSlotId);
  const revision = slot?.revisions.find((item) => item.id === document.sourceRevisionId);
  if (!revision || !/^[a-f0-9]{64}$/.test(revision.sha256))
    fail('MISSING_CURRENT_REVISION', '現行STB改訂が不正です。');

  const matched = sourceRevisions.filter(
    (source) =>
      sourceKey(source.modelSlotId, source.sourceRevisionId) === sourceKey(slot.id, revision.id),
  );
  if (matched.length !== 1 || !(matched[0].bytes instanceof Uint8Array))
    fail('MISSING_CURRENT_SOURCE', '現行STB原本が欠落または重複しています。');
  // Archive reader verifies source SHA-256 and ZIP metadata before calling this
  // helper. Copy its returned bytes so a later mutation cannot change staging.
  return {
    project: normalized,
    drawingId: document.id,
    modelSlotId: slot.id,
    sourceRevisionId: revision.id,
    sourceSha256: revision.sha256,
    originalSha256: revision.originalSha256 || revision.sha256,
    storyId: document.view.type === 'plan' ? document.view.storyId : null,
    view: document.view,
    sourceBytes: new Uint8Array(matched[0].bytes),
  };
}

/**
 * Build a DrawingModel in isolation. The supplied service must not change the
 * global model A/B. The return value is staging only, not a committed project.
 */
export async function stageDrawingProjectArchiveBootstrap({
  project,
  sourceRevisions,
  drawingId,
  createDrawingFromStbFile,
  createElevationFromStbFile,
  signal,
} = {}) {
  const plan = planDrawingProjectArchiveBootstrap({ project, sourceRevisions, drawingId });
  const createDrawing =
    plan.view.type === 'elevation' ? createElevationFromStbFile : createDrawingFromStbFile;
  if (typeof createDrawing !== 'function')
    fail('STB_SERVICE_UNAVAILABLE', 'STB図面の独立復元サービスがありません。');
  if (signal?.aborted) fail('BOOTSTRAP_CANCELLED', 'STB図面の復元が取り消されました。');
  if (!globalThis.crypto?.subtle) fail('CRYPTO_UNAVAILABLE', 'STB原本のSHA-256を検証できません。');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', plan.sourceBytes);
  const rawSha256 = Array.from(new Uint8Array(digest), (item) =>
    item.toString(16).padStart(2, '0'),
  ).join('');
  if (rawSha256 !== plan.originalSha256)
    fail('SOURCE_HASH_MISMATCH', 'ZIP内のSTB原本SHA-256が改訂情報と一致しません。');
  if (signal?.aborted) fail('BOOTSTRAP_CANCELLED', 'STB図面の復元が取り消されました。');
  const file = new Blob([plan.sourceBytes], { type: 'application/xml' });
  const imported = await createDrawing({
    file,
    modelKey: 'A',
    ...(plan.view.type === 'plan'
      ? { storyId: plan.storyId }
      : {
          axisDirection: plan.view.axisDirection,
          axisId: plan.view.axisId,
          depth: plan.view.depth,
        }),
    expectedRevisionSha256: plan.sourceSha256,
    signal,
  });
  if (signal?.aborted) fail('BOOTSTRAP_CANCELLED', 'STB図面の復元が取り消されました。');
  const actual = imported?.drawing?.view;
  const matchingView =
    plan.view.type === 'plan'
      ? actual?.type === 'plan' && String(actual.storyId) === String(plan.storyId)
      : actual?.type === 'elevation' &&
        actual.axisDirection === plan.view.axisDirection &&
        String(actual.axisId) === String(plan.view.axisId) &&
        Number.isFinite(actual.lowerBound) &&
        Number.isFinite(actual.upperBound) &&
        Number.isFinite(actual.position) &&
        actual.upperBound > actual.lowerBound &&
        Math.abs((actual.lowerBound + actual.upperBound) / 2 - actual.position) < 1e-6 &&
        Math.abs((actual.upperBound - actual.lowerBound) / 2 - plan.view.depth) < 1e-6;
  if (
    !imported?.drawing ||
    imported.drawing.source?.modelKey !== 'A' ||
    imported.drawing.source?.modelRevision !== plan.sourceSha256 ||
    !matchingView
  )
    fail(
      'DRAWING_SOURCE_MISMATCH',
      'STB原本から復元した図面の改訂または対象階がZIPの宣言と一致しません。',
    );
  return { plan, drawing: imported.drawing, tagFactsResolver: imported.tagFactsResolver };
}
