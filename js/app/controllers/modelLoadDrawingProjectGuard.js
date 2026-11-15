/**
 * #650 fail-closed boundary until STB model load and DrawingProject revision
 * replacement share an atomic commit/rollback. Model replacement emits
 * ModelEvents.CLEARED/LOADED, which otherwise invalidates an open drawing.
 */
import { drawingProjectReadBridge } from '../documentControl/drawingProjectBridge.js';

/**
 * Check *before* any provisional 3D/quantity reset. Do not expose raw
 * DrawingProject content across the document-control boundary.
 * @param {Object} options
 * @param {Function} [options.readOpenDrawingProject] metadata-only reader
 */
export function assertNoOpenDrawingProjectForModelLoad({
  readOpenDrawingProject = () => drawingProjectReadBridge.getOpenDrawingProjectDescriptor(),
  hasLoadedDrawingProject = () => drawingProjectReadBridge.hasLoadedDrawingProject(),
} = {}) {
  if (typeof readOpenDrawingProject !== 'function' || typeof hasLoadedDrawingProject !== 'function')
    throw new TypeError('図面プロジェクトの確認サービスがありません。');
  if (!hasLoadedDrawingProject() && !readOpenDrawingProject()) return;
  // Do not assume that a model reload can keep or restore member-tag/review
  // semantics merely because the STB filename or File object is unchanged.
  throw new Error(
    '図面プロジェクトを開いている間はSTBモデルを再読込できません。' +
      '先に図面プロジェクトZIPを保存し、簡易CADのプロジェクト画面で登録を解除してください。' +
      '複数ビューの改訂は、STB差替えの全ビュー事前検証と一体確定が必要です。',
  );
}
