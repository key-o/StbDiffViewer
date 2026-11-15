/**
 * #650: reversible metadata-only DrawingProject participant for a staged STB-A slot rebind.
 * A model replacement invokes publish() before it retires old GPU resources. This participant
 * deliberately neither opens/closes the Document Control lifecycle nor renders UI: those
 * effects cannot be rolled back after subscribers observe them.
 */
const SESSION_KEYS = Object.freeze([
  'loadedDrawingProject',
  'drawingProjectId',
  'activeDrawingDocumentId',
  'memberReviews',
  'drawingMemos',
  'drawingMemoIdentity',
  'tagPlacements',
  'tagFamilyState',
  'archiveSourceRevisions',
  'archiveExportSequence',
]);
const PANEL_KEYS = Object.freeze(['drawing', 'tagFactsResolver', 'sheetLayout', 'sheetRenderPlan']);

function snapshot(target, keys) {
  return Object.fromEntries(keys.map((key) => [key, target[key]]));
}

/**
 * Create a synchronous modelLoader drawingParticipant after all STB, source and view preflights.
 * No mutation is allowed before publish(). The caller MUST also complete the lifecycle/UI
 * resynchronization after the combined model transaction succeeds.
 */
export function createDrawingProjectSlotPublicationParticipant({
  session,
  prepared,
  assertCurrent,
  verifyPublishedModelSource,
  previousOriginalFileA = null,
} = {}) {
  const { staged, project, selected, committed, active } = prepared ?? {};
  const { document, restored, imported } = active ?? {};
  const panel = session?.panel;
  const revision = staged?.inspection?.revision;
  const destinationSlot = committed?.modelSlots?.find((slot) => slot.id === selected?.modelSlotId);
  const destinationViews = committed?.drawingDocuments?.filter(
    (view) => view.modelSlotId === selected?.modelSlotId,
  );
  const staleSheetList = (committed?.drawingSheets ?? []).some((sheet) =>
    (sheet.listPlacements ?? []).some(
      (item) =>
        item.modelSlotId === selected?.modelSlotId && item.sourceRevisionId !== revision?.id,
    ),
  );
  if (
    !staged?.slotMode ||
    staged?.phase !== 'slot' ||
    !project ||
    !committed ||
    !selected?.modelSlotId ||
    !document?.id ||
    document.sourceRevisionId !== revision?.id ||
    selected.id !== document.id ||
    destinationSlot?.currentRevisionId !== revision?.id ||
    !destinationViews?.length ||
    destinationViews.some((view) => view.sourceRevisionId !== revision?.id) ||
    staleSheetList ||
    typeof staged.file?.arrayBuffer !== 'function' ||
    imported?.revision?.id !== revision.id ||
    imported?.drawing?.source?.modelKey !== 'A' ||
    imported.drawing.source.modelRevision !== revision.sha256 ||
    staged.modelSlotId !== selected.modelSlotId ||
    typeof assertCurrent !== 'function' ||
    !panel ||
    session.loadedDrawingProject !== project ||
    panel.drawing?.source?.modelKey !== 'A'
  ) {
    throw new Error('モデルと図面を一体公開できるSTB改訂stageがありません。');
  }
  if (
    !Array.isArray(restored?.memberReviews) ||
    !Array.isArray(restored?.drawingMemos) ||
    !Array.isArray(restored?.tagPlacements) ||
    !Array.isArray(session.archiveSourceRevisions) ||
    !Number.isSafeInteger(session.archiveExportSequence)
  ) {
    throw new Error('一体公開に必要な図面レビュー・タグ・原本履歴が不正です。');
  }
  // Once the formal loader replaces files.originalFileA, the previous STB
  // original is no longer available from globalState. Preserve it alongside
  // the new original, without cloning the bytes or modifying saved metadata.
  // Archive creation later verifies both the semantic and byte SHA-256.
  const hasPreviousOriginal = session.archiveSourceRevisions.some(
    (item) =>
      item.modelSlotId === selected.modelSlotId &&
      item.sourceRevisionId === selected.sourceRevisionId,
  );
  if (!hasPreviousOriginal && typeof previousOriginalFileA?.arrayBuffer !== 'function')
    throw new Error('改訂前のSTB-A原本を保持できません。ZIP保存してから再検証してください。');
  const preservedPreviousOriginal = hasPreviousOriginal
    ? []
    : [
        {
          modelSlotId: selected.modelSlotId,
          sourceRevisionId: selected.sourceRevisionId,
          bytes: previousOriginalFileA,
        },
      ];
  const previousSession = snapshot(session, SESSION_KEYS);
  const previousPanel = snapshot(panel, PANEL_KEYS);
  const nextSession = {
    loadedDrawingProject: committed,
    drawingProjectId: committed.projectId,
    activeDrawingDocumentId: document.id,
    memberReviews: restored.memberReviews,
    drawingMemos: restored.drawingMemos,
    drawingMemoIdentity: null,
    tagPlacements: restored.tagPlacements,
    tagFamilyState: restored.tagFamilyState,
    archiveSourceRevisions: [
      ...session.archiveSourceRevisions.filter(
        (entry) =>
          entry.modelSlotId !== selected.modelSlotId || entry.sourceRevisionId !== revision.id,
      ),
      ...preservedPreviousOriginal,
      { modelSlotId: selected.modelSlotId, sourceRevisionId: revision.id, bytes: staged.file },
    ],
    archiveExportSequence: session.archiveExportSequence + 1,
  };
  const nextPanel = {
    drawing: imported.drawing,
    tagFactsResolver: imported.tagFactsResolver || null,
    sheetLayout: null,
    sheetRenderPlan: null,
  };
  let phase = 'prepared';
  return Object.freeze({
    // Only the panel whose DrawingProject was actually published may retain
    // its drawing when the deferred model lifecycle events are delivered.
    ownsDrawingPanel(candidate) {
      return (
        (phase === 'published' || phase === 'finalized') &&
        candidate === panel &&
        candidate.drawing === nextPanel.drawing &&
        session.loadedDrawingProject === committed
      );
    },
    publish() {
      if (phase !== 'prepared') throw new Error('図面改訂stageは既に確定または失効しました。');
      if (
        assertCurrent() !== true ||
        session.loadedDrawingProject !== project ||
        panel.drawing !== previousPanel.drawing
      )
        throw new Error('図面改訂stageの所有状態が変更されました。再検証してください。');
      // The formal loader has already installed its provisional candidate,
      // but the old 3D scene is still rollbackable here. Refuse an unverified
      // STB candidate BEFORE the old scene is irreversibly finalized.
      if (
        typeof verifyPublishedModelSource === 'function' &&
        verifyPublishedModelSource({
          modelDocument: session.currentModelDocument?.(),
          drawingSource: imported.drawing.source,
          revision,
          file: staged.file,
        }) !== true
      )
        throw new Error('新STB-Aの原本SHA・改訂照合が未完了のため一体公開を中止しました。');
      phase = 'published'; // Rollback remains possible even if the assignment partially fails.
      Object.assign(session, nextSession);
      Object.assign(panel, nextPanel);
    },
    /**
     * Irreversible, post-model-publication step. Preserve the registered
     * drawing identity while rotating its Document Control revision and
     * revoking grants for the old STB. No lifecycle event runs during publish().
     *
     * A failed rebind closes the old descriptor instead of authorizing mixed
     * source revisions. The model transaction must still finish committing.
     */
    finalize() {
      if (phase !== 'published')
        throw new Error('図面の一体公開は未完了または既に確定しています。');
      phase = 'finalized';
      const lifecycle = session.drawingLifecycle;
      const previous = lifecycle?.getOpenDrawingProjectDescriptor?.() ?? null;
      if (!previous) return { status: 'not-open' };
      try {
        if (
          previous.projectId !== project.projectId ||
          previous.drawingDocumentId !== selected.id ||
          previous.modelSlotId !== selected.modelSlotId ||
          previous.sourceRevisionId !== selected.sourceRevisionId ||
          previous.sourceRevisionId === revision.id
        )
          throw new Error('旧DrawingProjectの登録ライフサイクルが改訂元と一致しません。');
        const currentModel = session.currentModelDocument?.();
        if (!currentModel || currentModel === session.openModelDocument)
          throw new Error('新STB-Aの正式モデル原本を確認できません。');
        // A changed DOM object alone is not proof that the STB bytes and
        // canonical drawing revision match. The formal loader must explicitly
        // attest its verified candidate before the new grant can be issued.
        if (
          typeof verifyPublishedModelSource !== 'function' ||
          verifyPublishedModelSource({
            modelDocument: currentModel,
            drawingSource: imported.drawing.source,
            revision,
            file: staged.file,
          }) !== true
        )
          throw new Error('新STB-Aの原本SHA・改訂照合が確定していません。');
        const input = session.drawingDescriptorInput?.(committed);
        if (
          input?.project !== committed ||
          input.document?.id !== document.id ||
          input.document?.modelSlotId !== selected.modelSlotId ||
          input.document?.sourceRevisionId !== revision.id
        )
          throw new Error('改訂後のDrawingDocument登録情報が一致しません。');
        // Set ownership before notifying any Document Control subscriber.
        session.openDrawingIdentity = panel.drawing;
        session.openModelDocument = currentModel;
        const rebound = lifecycle.rebindSourceRevision(input);
        if (lifecycle.getOpenDrawingProjectDescriptor() !== rebound)
          throw new Error('Document Controlの改訂通知中に登録状態が変更されました。');
        // Invalidate any outstanding asynchronous archive/view import leases.
        ++session.drawingImportSequence;
        return { status: 'rebound', descriptor: rebound };
      } catch (error) {
        // Irreversible model publication has already succeeded. Never retain
        // a permission referring to an obsolete or unverified source.
        let revokeError = null;
        try {
          session.closeOpenDrawingProject?.();
        } catch (cause) {
          revokeError = cause;
        } finally {
          lifecycle.close();
        }
        return {
          status: 'revoked',
          error: revokeError
            ? new AggregateError([error, revokeError], 'Document Control登録の失効に失敗しました。')
            : error,
        };
      }
    },
    revoke() {
      if (phase !== 'finalized') return;
      try {
        session.closeOpenDrawingProject?.();
      } finally {
        session.drawingLifecycle?.close?.();
      }
    },
    rollback() {
      if (phase !== 'published') return;
      Object.assign(panel, previousPanel);
      Object.assign(session, previousSession);
      phase = 'rolled-back';
    },
  });
}
