/** #423 app-layer preflight: keep data/drawing independent of UI and session migration. */
import { restoreDrawingWorkspaceReviewState } from './pdfOverlayDrawingProjectMigration.js';
import { compilePersistedDrawingDimensions } from '../../data/drawing/drawingProjectDimensionAdapter.js';
import { createCadSheetPersistedTagOptions } from '../../data/drawing/drawingProjectTagAdapter.js';
import { resolvePersistedElevationReviews } from '../../data/drawing/drawingProjectElevationReviews.js';
import { compileDrawingRenderPlan } from '../../data/drawing/drawingRenderPlan.js';
import { stageDrawingProjectArchiveBootstrap } from '../../data/drawing/drawingProjectArchiveBootstrap.js';

function fail(code, message) {
  const error = new Error(message);
  error.name = 'DrawingProjectArchiveWorkspaceError';
  error.code = code;
  throw error;
}

/** Validate a full ZIP and prepare a restorable DrawingProject without committing runtime state. */
export async function stageDrawingProjectZipColdStart({
  zipBytes,
  drawingId,
  createDrawingFromStbFile,
  createElevationFromStbFile,
  signal,
} = {}) {
  if (signal?.aborted) fail('BOOTSTRAP_CANCELLED', 'ZIP図面の復元が取り消されました。');
  const { readDrawingProjectArchive } = await import('../../data/drawing/drawingProjectArchive.js');
  const { project, sourceRevisions } = await readDrawingProjectArchive(zipBytes);
  if (signal?.aborted) fail('BOOTSTRAP_CANCELLED', 'ZIP図面の復元が取り消されました。');
  const staged = await stageDrawingProjectArchiveWithIntents({
    project,
    sourceRevisions,
    drawingId,
    createDrawingFromStbFile,
    createElevationFromStbFile,
    signal,
  });
  return { ...staged, sourceRevisions };
}

/** Build isolated STB-A drawing, then validate persisted intents before any UI commit. */
export async function stageDrawingProjectArchiveWithIntents(options = {}) {
  const staged = await stageDrawingProjectArchiveBootstrap(options);
  const {
    document,
    restored,
    elevationReviews = null,
  } = stageDrawingProjectArchiveWorkspace({
    plan: staged.plan,
    drawing: staged.drawing,
    tagFactsResolver: staged.tagFactsResolver,
  });
  if (options.signal?.aborted) fail('BOOTSTRAP_CANCELLED', 'STB図面の復元が取り消されました。');
  return { ...staged, document, restored, elevationReviews };
}

/**
 * Validate the selected DrawingDocument's persisted intent against the isolated
 * STB DrawingModel, without modifying the open workspace. This must complete
 * before any model lifecycle or UI commit is attempted.
 */
export function stageDrawingProjectArchiveWorkspace({
  plan,
  drawing,
  tagFactsResolver = null,
} = {}) {
  if (!plan?.project || !plan.drawingId)
    fail('INVALID_BOOTSTRAP_PLAN', '復元予定のDrawingDocumentがありません。');
  const document = plan.project.drawingDocuments.find((item) => item.id === plan.drawingId);
  // Single-plan projects enter the legacy Drawing Workspace, which only
  // supports A3 landscape. Bounded/elevation/multi-view projects use metadata-only
  // sheet restoration; that path already supports both A3 orientations.
  const metadataOnly =
    document?.view.type === 'elevation' ||
    Boolean(document?.view.cutBoundsMm) ||
    plan.project.drawingDocuments.length > 1;
  if (
    !document ||
    document.sheet?.paper !== 'A3' ||
    (!metadataOnly && document.sheet.orientation !== 'landscape')
  )
    fail('UNSUPPORTED_BOOTSTRAP_SHEET', '復元先が対応していないA3用紙設定です。');
  // A registered sheet owns its persistent tag placements. Validate the
  // semantic binding against the isolated DrawingModel through the same
  // project-native compiler used for SVG/DXF, before any runtime mutation.
  if (metadataOnly && document.tagIntents?.length) {
    try {
      const modelToPaper = [1, 0, 0, 1, 0, 0];
      const tagOptions = createCadSheetPersistedTagOptions({
        project: plan.project,
        document,
        drawing,
        modelToPaper,
        resolveTagFacts: tagFactsResolver,
      });
      const rendered = tagOptions.showLabels
        ? compileDrawingRenderPlan({
            drawing,
            profile: { id: 'sdv-zip-native-tag-preflight', modelToPaper },
            // Hidden layers must not bypass semantic anchor validation. This is
            // a preflight of persisted intents, not the actual sheet visibility.
            displaySettings: { ...document.display, visibility: {} },
            tagOptions,
          })
        : null;
      // A drawable record can have no primitives or bounds. The tag compiler
      // skips such records, so successful compilation alone does not prove
      // every active persisted tag can actually be reconstructed.
      const renderedIds = new Set((rendered?.tags || []).map((tag) => tag.instanceId));
      for (const intent of document.tagIntents) {
        const binding = plan.project.bindings.find(
          (entry) =>
            entry.modelSlotId === document.modelSlotId &&
            entry.entityId === intent.binding.entityId,
        );
        const revision = binding?.revisions.find(
          (entry) => entry.sourceRevisionId === document.sourceRevisionId,
        );
        // Explicit orphans remain historical intents, not active drawing tags.
        if (revision?.orphaned) continue;
        if (!renderedIds.has(intent.id))
          throw new Error('保存タグの描画実体を生成できません: ' + intent.id);
      }
    } catch (error) {
      fail(
        'UNRESOLVED_DRAWING_INTENTS',
        'ZIPの保存タグを現在の部材・アンカーへ復元できません: ' + error.message,
      );
    }
  }
  // All current views can carry persisted axis dimensions, including plans.
  // Preflight against the isolated DrawingModel before the regular model loader
  // changes the active session; do not silently restore broken dimensions.
  if (document.dimensionIntents?.length) {
    try {
      compilePersistedDrawingDimensions({ project: plan.project, document, drawing });
    } catch (error) {
      fail(
        'UNRESOLVED_DRAWING_INTENTS',
        '保存寸法を現在の通り芯へ復元できません: ' + error.message,
      );
    }
  }
  if (document.view.type === 'elevation') {
    // Elevation reviews remain project metadata. Resolve current STB bindings
    // before modelLoader may change UI; history/orphans stay inactive.
    let elevationReviews = null;
    if (document.memberReviews?.length) {
      try {
        elevationReviews = resolvePersistedElevationReviews({
          project: plan.project,
          document,
          drawing,
        });
      } catch (error) {
        fail(
          'UNRESOLVED_DRAWING_INTENTS',
          '軸組図の保存レビューを現在の部材へ復元できません: ' + error.message,
        );
      }
    }
    const sameView = (view) =>
      view?.type === 'elevation' &&
      view.axisDirection === document.view.axisDirection &&
      String(view.axisId) === String(document.view.axisId) &&
      view.depth === document.view.depth;
    for (const annotation of document.annotations || []) {
      if (annotation.context.sourceRevisionId !== document.sourceRevisionId) continue;
      if (!sameView(annotation.context.view))
        fail(
          'UNRESOLVED_DRAWING_INTENTS',
          '軸組図の現行注記の保存ビューが一致しません: ' + annotation.id,
        );
    }
    return { document, restored: null, elevationReviews };
  }
  const restored = restoreDrawingWorkspaceReviewState({
    project: plan.project,
    drawingId: plan.drawingId,
    drawingModel: drawing,
    projectNativePlacements: metadataOnly,
  });
  const activeRevisionId = document.sourceRevisionId;
  const inactive = [
    ...restored.reviewStatuses.filter(
      (status) =>
        document.memberReviews.find((item) => item.id === status.id)?.context.sourceRevisionId ===
        activeRevisionId,
    ),
    ...restored.annotationStatuses.filter(
      (status) =>
        document.annotations.find((item) => item.id === status.id)?.context.sourceRevisionId ===
        activeRevisionId,
    ),
    ...restored.tagStatuses.filter((status) => status.invalidationCode !== 'BINDING_ORPHANED'),
  ].filter((status) => !status.active);
  if (inactive.length) {
    const detail = inactive
      .slice(0, 5)
      .map((status) => `${status.id}:${status.invalidationCode}`)
      .join(', ');
    fail(
      'UNRESOLVED_DRAWING_INTENTS',
      `ZIPから作図意図を完全復元できません: ${detail}${inactive.length > 5 ? ' …' : ''}`,
    );
  }
  return { document, restored };
}
