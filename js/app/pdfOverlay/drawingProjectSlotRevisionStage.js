/**
 * #650: isolate and preflight a shared model-slot STB replacement before UI commit.
 * No active A/B model, registered view, or DrawingProject is mutated here.
 */
import { planDrawingProjectStoryRevisionRebind } from '../../data/drawing/drawingProjectRevisionRebind.js';

function fail(message) {
  throw new Error(message);
}

function assertNotCancelled(signal) {
  if (signal?.aborted) fail('STB改訂差替えは取り消されました。');
}

/**
 * @param {Object} options
 * @param {Function} options.planSlotRebind - canonical atomic modelSlot planner
 */
export async function stageDrawingProjectSlotRevisionFromStb({
  project,
  modelSlotId,
  file,
  modelKey = 'A',
  services,
  signal,
  approvedMappings = [],
  orphanedEntityIds = [],
  planSlotRebind,
} = {}) {
  if (!project || !Array.isArray(project.modelSlots)) fail('DrawingProjectがありません。');
  if (modelKey !== 'A')
    fail('複数ビューの改訂差替えはSTB-Aだけに対応しています。モデルBは未対応です。');
  const slot = project.modelSlots.find((item) => item.id === modelSlotId);
  if (!slot) fail('改訂対象modelSlotがありません。');
  const documents = project.drawingDocuments.filter((item) => item.modelSlotId === modelSlotId);
  if (documents.length < 2) fail('複数登録ビューのmodelSlotを指定してください。');
  if (documents.some((item) => item.sourceRevisionId !== slot.currentRevisionId))
    fail('旧改訂を参照する登録ビューがあります。先に履歴の整合を確認してください。');
  // No implicit reconstruction of cropped or elevation views from plan geometry.
  if (documents.some((item) => item.view.type !== 'plan' || item.view.cutBoundsMm))
    fail(
      '複数ビューの改訂差替えは切り出しなしの伏図だけに対応しています。軸組図・切り出しビューは未対応です。',
    );
  if (
    typeof services?.inspectStbRevisionFile !== 'function' ||
    typeof services?.createDrawingFromStbFile !== 'function' ||
    typeof planSlotRebind !== 'function'
  )
    fail('複数ビューSTB改訂の事前検査サービスがありません。');
  if (!Array.isArray(approvedMappings) || !Array.isArray(orphanedEntityIds))
    fail('改訂対応の承認情報が不正です。');

  assertNotCancelled(signal);
  const inspection = await services.inspectStbRevisionFile({ file, signal });
  assertNotCancelled(signal);
  if (!inspection?.revision?.sha256 || !Array.isArray(inspection.storyCandidates))
    fail('STB改訂または階情報を取得できません。');
  const storyPlans = documents.map((document) => ({
    drawingId: document.id,
    plan: planDrawingProjectStoryRevisionRebind({
      project,
      drawingId: document.id,
      storyCandidates: inspection.storyCandidates,
      approvedMappings: approvedMappings.filter(
        (entry) => entry.entityId === document.view.storyBinding?.entityId,
      ),
    }),
  }));
  const blockedStories = storyPlans.filter((entry) => entry.plan.status === 'blocked');
  if (blockedStories.length) {
    const mappings = storyPlans.flatMap(({ drawingId, plan }) =>
      plan.mappings.map((mapping) => ({ ...mapping, drawingId })),
    );
    return {
      phase: 'story',
      inspection,
      importedById: {},
      storyPlans,
      plan: {
        status: 'blocked',
        mappings,
        unresolved: mappings.filter((mapping) => mapping.status !== 'resolved'),
        diagnostics: [],
      },
    };
  }

  const importedById = {};
  const drawingModelsById = {};
  for (const { drawingId, plan } of storyPlans) {
    assertNotCancelled(signal);
    const document = documents.find((item) => item.id === drawingId);
    const storyId =
      plan.status === 'legacy' ? document.view.storyId : plan.mappings[0].toSourceRef.elementId;
    if (
      !inspection.storyCandidates.some(
        (story) => String(story.sourceRef?.elementId) === String(storyId),
      )
    )
      fail('STBに登録済みビューの階がありません: ' + drawingId);
    const imported = await services.createDrawingFromStbFile({
      file,
      modelKey,
      storyId,
      signal,
      expectedRevisionSha256: inspection.revision.sha256,
    });
    assertNotCancelled(signal);
    if (
      imported?.revision?.id !== inspection.revision.id ||
      imported?.revision?.sha256 !== inspection.revision.sha256 ||
      (inspection.revision.originalSha256 != null &&
        imported?.revision?.originalSha256 !== inspection.revision.originalSha256) ||
      imported?.drawing?.source?.modelRevision !== inspection.revision.sha256 ||
      imported?.drawing?.source?.modelKey !== modelKey ||
      String(imported.drawing.view?.storyId) !== String(storyId)
    )
      fail('複数ビューの新STB改訂または階が一致しません: ' + drawingId);
    importedById[drawingId] = imported;
    drawingModelsById[drawingId] = imported.drawing;
  }
  const plan = planSlotRebind({
    project,
    modelSlotId,
    newRevision: inspection.revision,
    drawingModelsById,
    approvedMappings,
    orphanedEntityIds,
  });
  return { phase: 'slot', inspection, importedById, storyPlans, plan };
}
