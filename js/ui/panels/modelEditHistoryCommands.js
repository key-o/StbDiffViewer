/**
 * @fileoverview モデル編集リボン「ホーム」の編集履歴・STB出力コマンド。
 *
 * 状態表示の修正サマリー（editHistory.js の editing-summary）が持つ元に戻す・出力ボタンは
 * リボン内では隠し、同じ操作をここのリボンコマンドへ一本化する。
 */

import editingSession from '../../app/editing/editingSession.js';
import { ribbonCommandHtml, ribbonGroupHtml } from '../common/ribbon.js';
import { showError } from '../common/toast.js';

export function historyGroupsHtml() {
  return (
    ribbonGroupHtml(
      '編集履歴',
      ribbonCommandHtml({
        id: 'model-edit-undo-button',
        icon: 'undo',
        label: '元に戻す',
        disabled: true,
      }) +
        ribbonCommandHtml({
          id: 'model-edit-redo-button',
          icon: 'redo',
          label: 'やり直し',
          disabled: true,
        }),
    ) +
    ribbonGroupHtml(
      'ファイル出力',
      ribbonCommandHtml({
        id: 'model-edit-export-stb',
        icon: 'stbExport',
        label: 'STB出力',
        title: '編集中のモデルを検証し、STBファイルとして保存します',
        disabled: true,
      }),
    )
  );
}

/** 編集セッションの履歴件数をコマンドの有効/無効と title へ反映する。 */
export function syncHistoryCommands(state) {
  const active = state?.active === true;
  const historyCount = state?.history?.length || 0;
  const redoCount = state?.redoStack?.length || 0;
  const undoButton = document.getElementById('model-edit-undo-button');
  const redoButton = document.getElementById('model-edit-redo-button');
  const exportButton = document.getElementById('model-edit-export-stb');
  if (undoButton) {
    undoButton.disabled = !active || historyCount === 0;
    undoButton.title = `元に戻す (${historyCount}件)`;
  }
  if (redoButton) {
    redoButton.disabled = !active || redoCount === 0;
    redoButton.title = `やり直し (${redoCount}件)`;
  }
  if (exportButton) exportButton.disabled = !active || historyCount === 0;
}

/** @param {{onChanged: () => void}} options 履歴操作後にリボン・CAD操作欄を更新する */
export function initializeHistoryCommands({ onChanged }) {
  document.getElementById('model-edit-undo-button')?.addEventListener('click', () => {
    try {
      editingSession.undo();
      onChanged();
    } catch (error) {
      showError(`Undoできませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  document.getElementById('model-edit-redo-button')?.addEventListener('click', () => {
    try {
      editingSession.redo();
      onChanged();
    } catch (error) {
      showError(`Redoできませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  document.getElementById('model-edit-export-stb')?.addEventListener('click', async () => {
    try {
      const { exportModifications } = await import('./element-info/editMode/editHistory.js');
      exportModifications();
    } catch (error) {
      showError(
        `STB出力を開始できませんでした: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}
