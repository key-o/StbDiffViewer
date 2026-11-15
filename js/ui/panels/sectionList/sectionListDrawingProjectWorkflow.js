/**
 * Explicit bridge from RC beam/column section list windows to the CAD session
 * that owns DrawingProject. There is no hidden independent JSON store.
 */
import { getState } from '../../../data/state/globalState.js';
import { currentDrawingSheetSession } from '../../../data/drawing/drawingSheetSessionBridge.js';
import { resolveCurrentSheetDrawingDocument } from '../../../data/drawing/drawingSheetProjectEdit.js';
import {
  findCurrentSectionListLayout,
  saveSectionListLayoutToDrawingProject,
} from '../../../data/drawing/drawingSectionListSheetPersistence.js';

export async function resolveSectionListDrawingProjectContext({ source, xmlDocument } = {}) {
  if (source !== 'A' || getState('models.documentA') !== xmlDocument)
    throw new Error('共通シートは読み込み済みSTB-Aの断面リストのみ保存できます。');
  const panel = currentDrawingSheetSession();
  const session = panel?.sessionUi;
  const project = session?.loadedDrawingProject;
  const drawing = panel?.drawing;
  const services = panel?.services || panel?.getServices?.();
  if (!project)
    throw new Error('簡易CADでDrawingProjectを新規作成・読込してから保存してください。');
  if (
    drawing?.source?.modelKey !== 'A' ||
    !/^[a-f0-9]{64}$/i.test(drawing?.source?.modelRevision || '') ||
    typeof services?.assertDrawingSourceCurrent !== 'function'
  )
    throw new Error('簡易CADで現行STB-Aの伏図または軸組図を生成してください。');
  await services.assertDrawingSourceCurrent({ source: drawing.source });
  if (
    session.loadedDrawingProject !== project ||
    panel.drawing !== drawing ||
    getState('models.documentA') !== xmlDocument
  )
    throw new Error('照合中にDrawingProjectまたはSTB-Aが変更されました。');
  const sha = drawing.source.modelRevision.toLowerCase();
  const slots = project.modelSlots.filter((slot) =>
    slot.revisions.some(
      (rev) =>
        rev.id === slot.currentRevisionId &&
        (rev.id.toLowerCase() === sha || rev.sha256.toLowerCase() === sha),
    ),
  );
  if (slots.length !== 1) throw new Error('DrawingProjectのSTB-A改訂を一意に解決できません。');
  return { panel, session, project, drawing, services, xmlDocument, slot: slots[0] };
}

export async function commitSectionListDrawingProjectLayout({ context, listType, layout } = {}) {
  const { session, panel, project, drawing, xmlDocument, slot, services } = context || {};
  if (!session || !panel || !services || !project)
    throw new Error('共通DrawingProjectの保存セッションがありません。');
  const updated = saveSectionListLayoutToDrawingProject({
    project,
    modelSlotId: slot.id,
    sourceRevisionId: slot.currentRevisionId,
    listType,
    layout,
    idFactory: (prefix) =>
      prefix +
      '-' +
      (globalThis.crypto?.randomUUID?.() ||
        Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)),
  });
  await services.assertDrawingSourceCurrent({ source: drawing.source });
  if (
    session.loadedDrawingProject !== project ||
    panel.drawing !== drawing ||
    getState('models.documentA') !== xmlDocument
  )
    throw new Error('共通シート保存中にSTB-AまたはDrawingProjectが変更されました。');
  // The shared JSON export route validates the active CAD view. Refuse
  // inconsistent active-view metadata before changing the live session owner.
  resolveCurrentSheetDrawingDocument(project, drawing, panel.selectedCadDrawingView?.());
  // Invalidate single-plan workspace ownership before publishing a multi-view
  // project, consistent with the CAD sheet browser's existing transaction.
  session.closeOpenDrawingProject?.();
  session.loadedDrawingProject = updated;
  session.drawingProjectId = updated.projectId;
  panel.sheetBrowser?.invalidatePreviewSources?.();
  panel.sheetBrowser?.render?.();
  session.exportDrawingSheetProject();
  return updated;
}

export async function loadSectionListDrawingProjectLayout({ source, xmlDocument, listType } = {}) {
  const context = await resolveSectionListDrawingProjectContext({ source, xmlDocument });
  const saved = findCurrentSectionListLayout(context.project, {
    listType,
    modelSlotId: context.slot.id,
  });
  if (!saved) throw new Error('現行STB-A改訂の保存済み梁・柱リストシートがありません。');
  return { context, layout: saved };
}
