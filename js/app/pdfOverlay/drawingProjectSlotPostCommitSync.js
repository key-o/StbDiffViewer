/**
 * #650: UI-only synchronization after model, DrawingProject and Document Control
 * have been committed together. This must never run in the reversible publish
 * phase, nor reopen a failed registration as though it had succeeded.
 */
export function synchronizeDrawingProjectSlotAfterModelLoad({ session, prepared } = {}) {
  const panel = session?.panel;
  const { staged, committed, selected, active } = prepared ?? {};
  const { document, restored, imported } = active ?? {};
  const revision = staged?.inspection?.revision;
  const descriptor = session?.getOpenDrawingProjectDescriptor?.() ?? null;
  const currentModel = session?.currentModelDocument?.();
  const destinationSlot = committed?.modelSlots?.find((item) => item.id === selected?.modelSlotId);
  const targetViews = committed?.drawingDocuments?.filter(
    (item) => item.modelSlotId === selected?.modelSlotId,
  );
  const staleSheetLists = (committed?.drawingSheets ?? []).some((sheet) =>
    (sheet.listPlacements ?? []).some(
      (item) =>
        item.modelSlotId === selected?.modelSlotId && item.sourceRevisionId !== revision?.id,
    ),
  );

  // Validate all identity, revision and authorization conditions BEFORE the
  // first UI mutation. A prior 'rebound' result is not sufficient on its own.
  if (
    !panel ||
    !staged?.slotMode ||
    !revision?.id ||
    !committed ||
    !selected ||
    !document ||
    !restored?.display ||
    !restored?.sheet ||
    !imported?.drawing ||
    session.loadedDrawingProject !== committed ||
    session.activeDrawingDocumentId !== document.id ||
    panel.drawing !== imported.drawing ||
    session.openDrawingIdentity !== panel.drawing ||
    !currentModel ||
    session.openModelDocument !== currentModel ||
    descriptor?.projectId !== committed.projectId ||
    descriptor?.modelSlotId !== selected.modelSlotId ||
    descriptor?.drawingDocumentId !== document.id ||
    descriptor?.sourceRevisionId !== revision.id ||
    document.sourceRevisionId !== revision.id ||
    destinationSlot?.currentRevisionId !== revision.id ||
    !targetViews?.length ||
    targetViews.some((view) => view.sourceRevisionId !== revision.id) ||
    staleSheetLists
  ) {
    throw new Error('正式STB改訂後の図面登録・ビュー・シートの整合性を確認できません。');
  }

  // Do not call panel.invalidateDrawing(): that revokes the successfully
  // rebound DrawingProject and destroys the new drawing identity.
  panel.measurementUi?.invalidateDrawing?.();
  // The participant has already published normalized tagFamilyState. Do not
  // call setTagFamilyState(): it revises Document Control while repainting.
  session.refreshPublishedTagFamilyUi?.();
  session.applyDrawingProjectDisplaySettings(restored.display);
  panel.setScaleDenominator(restored.sheet.scaleDenominator);
  panel.setDrawingRotationDeg(restored.sheet.rotationDeg, {
    invalidatePlacement: false,
    render: false,
    notify: false,
    skipRegistrationRevision: true,
  });
  panel.setTagOrientationMode(restored.sheet.tagOrientationMode, {
    render: false,
    skipRegistrationRevision: true,
  });
  panel.clearSelection?.();
  panel.resetPlacementState?.('STB改訂差替え: PDF配置未設定', 'STB_CHANGED', {
    invalidateReviews: false,
  });
  panel.clearAnchorInputs?.('model');
  panel.regionUi?.invalidateDrawing?.();
  panel.alignmentCandidates = [];
  panel.gizmoOrigin = null;

  // All view and list previews built against the retired STB-A must be
  // discarded, including an asynchronous normal-sheet/slab-list generator.
  panel.sheetBrowser?.invalidatePublishedModelSources?.();
  panel.refreshModelAndStories?.();
  panel.sheetBrowser?.render?.();
  session.renderDrawingMemoList?.();
  session.refreshSelectedTagControls?.();
  session.renderOrphanedIntentList?.();
  panel.renderOverlay?.();
  panel.updatePdfFeatureAvailability?.();
  panel.renderDiagnostics?.();

  const shortRevision = revision.sha256?.slice(0, 12) || revision.id.slice(0, 12);
  session.clearDrawingProjectReplacement?.({
    status: `STB-A改訂を確定しました / ${targetViews.length}ビュー / ${shortRevision}…`,
  });
  session.setDrawingProjectStatus?.(
    `改訂済み / ${targetViews.length}ビュー / revision ${shortRevision}… / 履歴を保持`,
  );
  return Object.freeze({
    status: 'synchronized',
    drawingDocumentId: document.id,
    modelSlotId: selected.modelSlotId,
    viewCount: targetViews.length,
  });
}
