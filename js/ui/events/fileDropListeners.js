/**
 * @fileoverview ファイルドラッグ&ドロップイベントリスナー
 *
 * モデルA/Bのファイル入力欄および3Dキャンバスへのファイルドロップを処理する。
 * ドロップされたファイルは既存のfile input（#fileA/#fileB）に設定され、
 * changeイベント経由で既存の読み込みフローに乗る。
 *
 * @module ui/events/fileDropListeners
 */

import { createLogger } from '../../utils/logger.js';
import { eventBus, ModelEvents, ToastEvents } from '../../data/events/index.js';
import { getAcceptAttribute } from '../../config/fileTypeConfig.js';

const log = createLogger('ui:events:fileDropListeners');

/**
 * 受け付ける拡張子（#fileA/#fileB の accept 属性と同一・fileTypeConfig が単一の情報源）。
 * SS7 等の無効な形式は featureFlags 経由で除外されるため、ここでも自動的に外れる。
 * @returns {string[]}
 */
function getAcceptedExtensions() {
  return getAcceptAttribute().split(',');
}

/**
 * ファイルが受け付け可能な拡張子かどうか判定する
 * @param {File} file - 判定対象ファイル
 * @returns {boolean}
 */
function isAcceptedFile(file) {
  const name = file.name.toLowerCase();
  return getAcceptedExtensions().some((ext) => name.endsWith(ext));
}

/**
 * DataTransferからファイル種別チェック済みのファイル配列を取り出す
 * @param {DataTransfer} dataTransfer - ドロップイベントのdataTransfer
 * @returns {File[]} 受け付け可能なファイルの配列
 */
function extractAcceptedFiles(dataTransfer) {
  const files = Array.from(dataTransfer?.files ?? []);
  const accepted = files.filter(isAcceptedFile);
  const rejected = files.filter((f) => !isAcceptedFile(f));

  if (rejected.length > 0) {
    eventBus.emit(ToastEvents.SHOW_WARNING, {
      message: `対応していないファイル形式です: ${rejected.map((f) => f.name).join(', ')}`,
    });
  }
  return accepted;
}

/**
 * file inputにファイルを設定し、changeイベントを発火する
 * @param {string} inputId - 'fileA' または 'fileB'
 * @param {File} file - 設定するファイル
 * @returns {boolean} 設定に成功したか
 */
function assignFileToInput(inputId, file) {
  const input = document.getElementById(inputId);
  if (!input || input.disabled) {
    return false;
  }

  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  log.info(`[Load] ドロップされたファイルを ${inputId} に設定: ${file.name}`);
  return true;
}

/**
 * ドロップ対象要素にドラッグ中のハイライトを設定する
 * @param {HTMLElement} element - 対象要素
 * @param {(files: File[]) => void} onDrop - 受理ファイルのドロップ時コールバック
 */
function setupDropTarget(element, onDrop) {
  element.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    element.classList.add('drag-over');
  });

  element.addEventListener('dragleave', (event) => {
    // 子要素への移動では解除しない
    if (element.contains(event.relatedTarget)) return;
    element.classList.remove('drag-over');
  });

  element.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    element.classList.remove('drag-over');

    const files = extractAcceptedFiles(event.dataTransfer);
    if (files.length > 0) {
      onDrop(files);
    }
  });
}

/**
 * キャンバスへのドロップ: ファイルを空きスロット優先でモデルA/Bに割り当てる
 * @param {File[]} files - 受理済みファイル
 */
function assignFilesToSlots(files) {
  if (files.length >= 2) {
    assignFileToInput('fileA', files[0]);
    assignFileToInput('fileB', files[1]);
    return;
  }

  const inputA = document.getElementById('fileA');
  const inputB = document.getElementById('fileB');
  const hasA = inputA?.files?.length > 0;
  const hasB = inputB?.files?.length > 0;

  // 空きスロット優先、両方埋まっている場合はモデルAを置き換える
  const targetId = !hasA || hasB ? 'fileA' : 'fileB';
  assignFileToInput(targetId, files[0]);
}

/**
 * キャンバス上の空状態ヒントの表示制御を設定する
 */
function setupCanvasDropHint() {
  const hint = document.getElementById('canvas-drop-hint');
  if (!hint) return;

  const loadBtn = document.getElementById('canvas-load-btn');
  const inputA = document.getElementById('fileA');
  const inputB = document.getElementById('fileB');

  // ステージ済みファイルの有無に応じて中央の読込ボタンの表示を更新する
  const updateLoadButton = () => {
    if (!loadBtn) return;
    const hasA = inputA?.files?.length > 0;
    const hasB = inputB?.files?.length > 0;
    const staged = hasA || hasB;
    loadBtn.classList.toggle('hidden', !staged);
    loadBtn.textContent = hasA && hasB ? '📥 モデルを比較' : '📥 モデル読込';
  };

  // 中央の読込ボタン: 既存の比較フロー（compareButton）に委譲する
  loadBtn?.addEventListener('click', () => {
    if (document.getElementById('compareButton')?.disabled) return;
    if (typeof window.handleCompareModelsClick === 'function') {
      window.handleCompareModelsClick();
    } else {
      document.getElementById('compareButton')?.click();
    }
  });

  inputA?.addEventListener('change', updateLoadButton);
  inputB?.addEventListener('change', updateLoadButton);

  eventBus.on(ModelEvents.LOADED, () => hint.classList.add('hidden'));
  eventBus.on(ModelEvents.CLEARED, () => {
    hint.classList.remove('hidden');
    updateLoadButton();
  });

  // 読み込み開始時点で非表示にする（ロード中にヒントが残らないように）
  const compareButton = document.getElementById('compareButton');
  compareButton?.addEventListener('click', () => {
    if (inputA?.files?.length > 0 || inputB?.files?.length > 0) {
      hint.classList.add('hidden');
    }
  });

  updateLoadButton();
}

/**
 * ファイルドロップリスナーを設定する
 */
export function setupFileDropListeners() {
  // ドロップ失敗時にブラウザがファイルを開いてしまうのを防ぐ
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());

  for (const [wrapperId, inputId] of [
    ['wrapperA', 'fileA'],
    ['wrapperB', 'fileB'],
  ]) {
    const wrapper = document.getElementById(wrapperId);
    if (wrapper) {
      setupDropTarget(wrapper, (files) => assignFileToInput(inputId, files[0]));
    }
  }

  const canvas = document.getElementById('three-canvas');
  if (canvas) {
    setupDropTarget(canvas, assignFilesToSlots);
  }

  setupCanvasDropHint();
  log.info('ファイルドロップリスナーを設定しました');
}
