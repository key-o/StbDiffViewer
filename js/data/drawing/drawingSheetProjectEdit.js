/**
 * Metadata-only project editor for the CAD sheet browser (#516).
 *
 * Unlike the legacy Drawing Workspace snapshot editor, this transaction does not
 * rebuild a DrawingProject from one active plan view. Inactive DrawingDocuments,
 * revision history, annotations and binding IDs remain intact. The caller must
 * use the schema normalizer as the last validation boundary.
 */

function reject(message) {
  throw new Error('シート編集: ' + message);
}

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Project fields that the sheet/output editors may change. */
const OUTPUT_METADATA_KEYS = new Set(['drawingSheets', 'dxfLayerSettings', 'printSettings']);

function sameCurrentView(expected, actual) {
  if (!expected || expected.type !== actual?.type) return false;
  if (expected.type === 'plan') return String(expected.storyId) === String(actual.storyId);
  if (expected.type !== 'elevation') return false;
  if (
    expected.axisDirection !== actual.axisDirection ||
    String(expected.axisId) !== String(actual.axisId)
  )
    return false;
  const low = actual.lowerBound,
    high = actual.upperBound;
  return (
    Number.isFinite(low) &&
    Number.isFinite(high) &&
    low < high &&
    Number.isFinite(actual.position) &&
    Math.abs((low + high) / 2 - actual.position) < 1e-6 &&
    Math.abs((high - low) / 2 - expected.depth) < 1e-6
  );
}

/**
 * Fail closed unless the current STB-A DrawingModel resolves to exactly one
 * *current* DrawingDocument by view and full source SHA-256.
 */
export function resolveCurrentSheetDrawingDocument(
  project,
  drawing,
  selectedView = null,
  drawingId = null,
) {
  if (drawing?.source?.modelKey !== 'A') reject('STB-Aの作図モデルのみ編集できます。');
  if (
    selectedView &&
    (drawing?.view?.type !== selectedView.type ||
      (selectedView.type === 'plan'
        ? String(drawing.view.storyId) !== String(selectedView.storyId)
        : selectedView.type !== 'elevation' ||
          drawing.view.axisDirection !== selectedView.axisDirection ||
          String(drawing.view.axisId) !== String(selectedView.axisId)))
  )
    reject('選択ビューと現在の作図モデルが一致しません。');
  const sha = drawing?.source?.modelRevision;
  if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/i.test(sha))
    reject('作図モデルのSHA-256がありません。再生成してください。');
  if (!Array.isArray(project?.modelSlots) || !Array.isArray(project?.drawingDocuments))
    reject('DrawingProjectがありません。');
  const matches = project.drawingDocuments.filter((document) => {
    // An explicit ZIP-selected drawingId disambiguates identical view copies
    // without weakening source revision, SHA or selected-view validation.
    if (drawingId != null && document.id !== drawingId) return false;
    if (!sameCurrentView(document.view, drawing.view)) return false;
    const slot = project.modelSlots.find((item) => item.id === document.modelSlotId);
    const revision = slot?.revisions?.find((item) => item.id === document.sourceRevisionId);
    return Boolean(
      slot &&
      revision &&
      slot.currentRevisionId === document.sourceRevisionId &&
      (String(revision.id).toLowerCase() === sha.toLowerCase() ||
        String(revision.sha256).toLowerCase() === sha.toLowerCase()),
    );
  });
  if (matches.length !== 1)
    reject(
      matches.length
        ? '同じ図面を参照するビューが複数あります。'
        : '現行改訂に一致するビューがありません。',
    );
  return matches[0];
}

/**
 * Apply only sheet metadata mutations. Every other persistent field must remain
 * exactly the same; a failed edit leaves the original project untouched.
 * normalizeProject must be the production DrawingProject schema normalizer.
 */
export function editDrawingSheetProject({
  project,
  drawing,
  selectedView,
  edit,
  normalizeProject,
}) {
  if (typeof edit !== 'function' || typeof normalizeProject !== 'function')
    throw new TypeError('editとnormalizeProjectが必要です。');
  resolveCurrentSheetDrawingDocument(project, drawing, selectedView);
  return editDrawingSheetMetadata({ project, edit, normalizeProject });
}

/**
 * Edit only the print-sheet collection. Registered views, source revisions,
 * annotations and other persistent content stay immutable. A previously opened
 * DrawingProject is sufficient; no current viewport DrawingModel is required.
 */
export function editDrawingSheetMetadata({ project, edit, normalizeProject }) {
  if (!project || !Array.isArray(project.drawingDocuments)) reject('DrawingProjectが必要です。');
  if (typeof edit !== 'function' || typeof normalizeProject !== 'function')
    throw new TypeError('editとnormalizeProjectが必要です。');
  const snapshot = globalThis.structuredClone(project);
  const updated = normalizeProject(edit(snapshot));
  if (
    !updated ||
    !equal(updated.projectId, project.projectId) ||
    !equal(updated.modelSlots, project.modelSlots) ||
    !equal(updated.bindings, project.bindings) ||
    !equal(updated.drawingDocuments, project.drawingDocuments) ||
    !equal(updated.definitions, project.definitions)
  )
    reject('シート編集ではモデル改訂・ビュー・作図意図・定義を変更できません。');
  // Fail closed for any newly introduced top-level persistent fields, too.
  const keys = new Set([...Object.keys(project), ...Object.keys(updated)]);
  for (const key of keys) {
    // 出力メタデータ(シート・DXFレイヤー・印刷設定)はシート編集と同じ操作で編集できる。
    if (!OUTPUT_METADATA_KEYS.has(key) && !equal(updated[key], project[key]))
      reject('シート以外のプロジェクト情報が変更されました: ' + key);
  }
  return updated;
}

/**
 * Stage a persisted multi-view sheet project for metadata-only import.
 * The active runtime DrawingModel is not replaced or reconstructed. Only one
 * current STB-A source revision may own the imported DrawingDocuments; inactive
 * historical source revisions may remain in the slot registry.
 */
export function stageDrawingSheetProjectImport({
  project,
  drawing,
  selectedView = null,
  drawingId = null,
} = {}) {
  if (
    !Array.isArray(project?.drawingDocuments) ||
    !project.drawingDocuments.length ||
    (project.drawingDocuments.length === 1 &&
      project.drawingDocuments[0].view?.type !== 'elevation' &&
      !project.drawingDocuments[0].view?.cutBoundsMm)
  )
    reject('複数ビュー・単独軸組図・範囲指定ビューのDrawingProjectが必要です。');
  if (!Array.isArray(project.modelSlots) || project.modelSlots.length !== 1)
    reject('シートJSON再読込は単一のSTB-Aモデルスロットのみ対応しています。');
  const slot = project.modelSlots[0];
  const currentRevision = slot.revisions?.find((rev) => rev.id === slot.currentRevisionId);
  if (!currentRevision || !/^[0-9a-f]{64}$/i.test(currentRevision.sha256 ?? ''))
    reject('現行STB-A改訂のSHA-256を確認できません。');
  if (
    project.drawingDocuments.some(
      (document) =>
        document.modelSlotId !== slot.id ||
        document.sourceRevisionId !== slot.currentRevisionId ||
        !['plan', 'elevation'].includes(document.view?.type),
    )
  )
    reject('異なるモデル・古い改訂・未対応ビューを含むため再読込できません。');
  const currentDocument = resolveCurrentSheetDrawingDocument(
    project,
    drawing,
    selectedView,
    drawingId,
  );
  return Object.freeze({
    project,
    currentDrawingDocumentId: currentDocument.id,
    drawingDocumentCount: project.drawingDocuments.length,
    drawingSheetCount: project.drawingSheets?.length ?? 0,
  });
}
