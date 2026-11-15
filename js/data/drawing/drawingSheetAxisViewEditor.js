/**
 * #516: Add one explicit elevation ViewSpec without regenerating the legacy
 * single-plan DrawingProject from the active workspace.
 */
import { registerSheetDrawingView } from './drawingSheetViewCatalog.js';
import { resolveCurrentSheetDrawingDocument } from './drawingSheetProjectEdit.js';

const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function addSheetAxisDrawingView({
  project,
  drawing,
  selectedView,
  id,
  name,
  axisDirection,
  axisId,
  depth,
  scaleDenominator = 200,
} = {}) {
  const current = resolveCurrentSheetDrawingDocument(project, drawing, selectedView);
  if (current.view.type !== 'plan')
    throw new Error('軸組図登録は現在のSTB-A伏図を照合してから実施してください。');
  if (!['X', 'Y'].includes(axisDirection)) throw new Error('軸方向はXまたはYです。');
  if (typeof axisId !== 'string' || !axisId.trim()) throw new Error('通り芯IDを入力してください。');
  if (!Number.isFinite(depth) || depth <= 0) throw new Error('奥行(mm)は正の数値です。');
  const normalized = registerSheetDrawingView(project, {
    id,
    name,
    modelSlotId: current.modelSlotId,
    sourceRevisionId: current.sourceRevisionId,
    view: { type: 'elevation', axisDirection, axisId: axisId.trim(), depth },
    scaleDenominator,
  });
  const sourceDocs = normalized.drawingDocuments.slice(0, -1);
  if (
    !equal(sourceDocs, project.drawingDocuments) ||
    !equal(normalized.modelSlots, project.modelSlots) ||
    !equal(normalized.bindings, project.bindings) ||
    !equal(normalized.drawingSheets, project.drawingSheets) ||
    !equal(normalized.definitions, project.definitions) ||
    normalized.projectId !== project.projectId
  )
    throw new Error('既存ビューやSTB改訂が変更されたため、軸組ビュー登録を中止しました。');
  return normalized;
}
