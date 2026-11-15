/**
 * 比較対象ファイル入力の初期化
 */

import { createLogger } from '../../utils/logger.js';
import { t } from '../../config/i18n.js';
import { getAcceptAttribute, getEnabledFileTypes } from '../../config/fileTypeConfig.js';
import { eventBus } from '../../data/events/eventBus.js';
import { ToastEvents } from '../../constants/eventTypes.js';
import { SceneEvents } from '../../data/events/index.js';
import { assertNoOpenDrawingProjectForModelLoad } from '../controllers/modelLoadDrawingProjectGuard.js';

const log = createLogger('app:initialization:fileInputInitializer');
let clearInProgress = false;

/** ドロップ案内に表示するファイルタイプ別ラベル（有効なタイプのみ列挙） */
const DROP_HINT_LABELS = {
  stb: 'STB',
  ifc: 'IFC',
};

/**
 * iOS / iPadOS のファイルピッカーかどうかを判定する。
 * iPadOS はデスクトップ向けサイトで Macintosh を名乗るため、
 * タッチ点数も併用して判定する。
 *
 * @param {Navigator|Object|undefined} navigatorLike - 判定対象の Navigator 互換オブジェクト
 * @returns {boolean}
 */
export function usesIosFilePicker(navigatorLike = globalThis.navigator) {
  if (!navigatorLike) {
    return false;
  }

  const userAgent = navigatorLike.userAgent ?? '';
  const platform = navigatorLike.platform ?? '';
  const maxTouchPoints = navigatorLike.maxTouchPoints ?? 0;

  return /iPad|iPhone|iPod/i.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
}

/**
 * OS のファイルピッカーに渡す accept 属性値を取得する。
 *
 * iOS / iPadOS は未知の拡張子を選択不可にすることがあるため、
 * STB の選択時はフィルターを解除し、選択後の既存バリデーションに委ねる。
 *
 * @param {Navigator|Object|undefined} navigatorLike - 判定対象の Navigator 互換オブジェクト
 * @returns {string}
 */
export function getFilePickerAcceptAttribute(navigatorLike = globalThis.navigator) {
  return usesIosFilePicker(navigatorLike) ? '' : getAcceptAttribute();
}

/**
 * 有効なファイルタイプに応じて accept 属性・ドロップ案内を同期する。
 *
 * @param {Navigator|Object|undefined} navigatorLike - 判定対象の Navigator 互換オブジェクト
 * @param {Document|Object} documentLike - 更新対象の Document 互換オブジェクト
 */
export function applyEnabledFileTypesUi(
  navigatorLike = globalThis.navigator,
  documentLike = globalThis.document,
) {
  const accept = getFilePickerAcceptAttribute(navigatorLike);
  for (const id of ['fileA', 'fileB']) {
    const input = documentLike.getElementById(id);
    if (input) {
      input.accept = accept;
    }
  }

  const dropHint = documentLike.querySelector('#canvas-drop-hint .canvas-drop-hint-sub');
  if (dropHint) {
    const labels = getEnabledFileTypes()
      .map((ft) => DROP_HINT_LABELS[ft.id])
      .filter(Boolean)
      .join(' / ');
    dropHint.textContent = `${labels} をここにドロップ。2ファイルならモデルA/Bとして比較します。`;
  }
}

function updateCompareButtonLabel() {
  const compareButton = document.getElementById('compareButton');
  const inputA = document.getElementById('fileA');
  const inputB = document.getElementById('fileB');

  if (!compareButton || !inputA || !inputB) {
    return;
  }

  const hasA = inputA.files && inputA.files.length > 0;
  const hasB = inputB.files && inputB.files.length > 0;

  if (hasA && hasB) {
    compareButton.textContent = t('app.compare.execute');
    return;
  }

  if (hasA || hasB) {
    compareButton.textContent = t('app.compare.loadModel');
    return;
  }

  compareButton.textContent = t('app.compare.loadOrCompare');
}

/**
 * ファイル入力の現在値をカード表示へ反映する。
 * @param {HTMLInputElement} input
 * @param {string} suffix
 */
export function updateFileInputUi(input, suffix) {
  const file = input.files && input.files[0];
  const nameEl = document.getElementById(`fileName${suffix}`);
  const wrapper = document.getElementById(`wrapper${suffix}`);
  const selectButton = document.querySelector(`.custom-file-btn[data-target="${input.id}"]`);
  const clearButton = document.querySelector(`.clear-file-btn[data-target="${input.id}"]`);

  if (file) {
    if (nameEl) {
      nameEl.textContent = file.name;
      nameEl.title = file.name;
    }
    selectButton?.classList.add('has-file');
    wrapper?.classList.add('has-file');
  } else {
    if (nameEl) {
      nameEl.textContent = t('file.unselected');
      nameEl.title = '';
    }
    selectButton?.classList.remove('has-file');
    wrapper?.classList.remove('has-file');
  }

  if (clearButton) {
    clearButton.hidden = !file;
    clearButton.disabled = !file;
  }
  updateCompareButtonLabel();
}

/**
 * 指定したファイル選択を解除し、change イベントで既存の同期処理へ通知する。
 * @param {string} targetId
 * @returns {boolean} 選択を解除した場合 true
 */
export function clearFileSelection(targetId) {
  const input = document.getElementById(targetId);
  if (!input || !input.files?.length) return false;

  input.value = '';
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function setFileActionsLocked(locked) {
  const compareButton = document.getElementById('compareButton');
  if (compareButton) compareButton.disabled = locked;

  for (const inputId of ['fileA', 'fileB']) {
    const input = document.getElementById(inputId);
    const selectButton = document.querySelector(`.custom-file-btn[data-target="${inputId}"]`);
    if (input) input.disabled = locked;
    if (selectButton) selectButton.disabled = locked;
  }

  document.querySelectorAll('.clear-file-btn').forEach((clearButton) => {
    clearButton.disabled =
      locked || !document.getElementById(clearButton.dataset.target)?.files?.length;
  });
}

/**
 * Complete the model-side portion of an input-clear transaction.
 * Keep the old model recoverable when the remaining-file loader is not ready.
 * The caller restores its input selection if this function rejects.
 */
export async function reconcileModelAfterFileClear({
  hasRemainingFile,
  reloadRemainingModel,
  clearAllModels,
} = {}) {
  if (hasRemainingFile) {
    if (typeof reloadRemainingModel !== 'function')
      throw new Error('残りのモデルを再読込する処理が初期化されていません。解除を取り消します。');
    if ((await reloadRemainingModel()) !== true)
      throw new Error('残りのモデルの再読込に失敗したため、ファイル解除を取り消します。');
    return;
  }
  if (typeof clearAllModels !== 'function')
    throw new TypeError('モデル解除処理が初期化されていません。');
  clearAllModels();
}

async function handleClear(targetId, button) {
  if (clearInProgress || document.getElementById('compareButton')?.disabled) return;
  clearInProgress = true;
  // Prevent a simultaneous input change while the loader and drawing ownership
  // are checked. A rejected clear must preserve both the model and file input.
  setFileActionsLocked(true);
  const originalFile = document.getElementById(targetId)?.files?.[0] ?? null;
  let selectionRemoved = false;

  try {
    // Reject immediately when a drawing is already registered. The second
    // check after dynamic import also closes the async ownership race.
    assertNoOpenDrawingProjectForModelLoad();
    // Avoid a startup circular dependency with the model loader.
    const { clearLoadedModels, isModelLoaded } =
      await import('../controllers/modelLoaderController.js');
    // Guard after the asynchronous import and immediately before mutation.
    assertNoOpenDrawingProjectForModelLoad();
    const hadLoadedModel = isModelLoaded();
    if (!clearFileSelection(targetId)) return;
    selectionRemoved = true;

    if (!hadLoadedModel) return;

    button.disabled = true;
    const inputA = document.getElementById('fileA');
    const inputB = document.getElementById('fileB');
    const hasRemainingFile = Boolean(inputA?.files?.length || inputB?.files?.length);

    await reconcileModelAfterFileClear({
      hasRemainingFile,
      reloadRemainingModel: window.handleCompareModelsClick,
      clearAllModels: clearLoadedModels,
    });
  } catch (error) {
    // Do not call clearLoadedModels() on an error: that would discard a still
    // valid scene (and DrawingProject) precisely when the guard rejects.
    log.error('モデルの解除後処理に失敗しました:', error);
    if (selectionRemoved && originalFile) {
      const input = document.getElementById(targetId);
      if (input && !input.files?.length) {
        try {
          const transfer = new DataTransfer();
          transfer.items.add(originalFile);
          input.files = transfer.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (restoreError) {
          log.error('元ファイル選択の復元に失敗しました:', restoreError);
        }
      }
    }
    eventBus.emit(ToastEvents.SHOW_ERROR, { message: error.message });
  } finally {
    clearInProgress = false;
    for (const inputId of ['fileA', 'fileB']) {
      const input = document.getElementById(inputId);
      if (input) updateFileInputUi(input, inputId.replace(/^file/i, ''));
    }
    setFileActionsLocked(false);
  }
}

function wire(targetId, suffix) {
  const btn = document.querySelector(`.custom-file-btn[data-target="${targetId}"]`);
  const clearBtn = document.querySelector(`.clear-file-btn[data-target="${targetId}"]`);
  const input = document.getElementById(targetId);
  const fileSuffix = suffix || targetId.replace(/^file/i, '');

  if (!btn || !input) {
    return;
  }

  btn.addEventListener('click', () => {
    input.click();
  });

  input.addEventListener('change', () => {
    updateFileInputUi(input, fileSuffix);
  });

  clearBtn?.addEventListener('click', () => handleClear(targetId, clearBtn));
  if (clearBtn) {
    const label = t('file.clearModel', { slot: fileSuffix });
    clearBtn.textContent = t('file.clear');
    clearBtn.setAttribute('aria-label', label);
    clearBtn.title = label;
  }
  updateFileInputUi(input, fileSuffix);
}

function wireGlbModelInput() {
  const input = document.getElementById('glbFile');
  const clearButton = document.getElementById('clearGlbModel');
  const visibleToggle = document.getElementById('glbModelVisible');
  const fileName = document.getElementById('glbFileName');
  const controls = document.getElementById('glbModelControls');
  if (!input || !clearButton || !visibleToggle || !fileName || !controls) return;

  let hasGlbModel = false;
  const syncControls = () => controls.classList.toggle('hidden', !hasGlbModel);

  // ロード完了時だけ操作欄を公開し、外部処理からの解除でも必ず隠す。
  eventBus.on(SceneEvents.GLB_LOADED, () => {
    hasGlbModel = true;
    syncControls();
  });
  eventBus.on(SceneEvents.GLB_CLEARED, () => {
    hasGlbModel = false;
    input.value = '';
    fileName.textContent = t('file.unselected');
    fileName.title = '';
    visibleToggle.checked = true;
    visibleToggle.disabled = true;
    clearButton.disabled = true;
    syncControls();
  });
  syncControls();
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    const glbFiles = files.filter((item) => item.name?.toLowerCase().endsWith('.glb'));
    const metadataFiles = files.filter((item) => item.name?.toLowerCase().endsWith('.json'));
    if (glbFiles.length !== 1 || metadataFiles.length > 1) {
      input.value = '';
      fileName.textContent = 'GLB 1件と対応JSON 1件までを選択してください';
      fileName.title = '';
      eventBus.emit(ToastEvents.SHOW_ERROR, {
        message:
          'GLBファイルを1件選択してください。JSON情報を使う場合は対応するJSONファイルを1件だけ追加してください。',
      });
      return;
    }
    const [file] = glbFiles;
    const [metadataFile] = metadataFiles;

    input.disabled = true;
    clearButton.disabled = true;
    fileName.textContent = `${file.name} を読み込み中...`;
    try {
      const { loadGlbModel } = await import('../../viewer/index.js');
      const result = await loadGlbModel(file, metadataFile);
      if (!result) return;
      hasGlbModel = true;
      const metadataStatus = metadataFile
        ? `, JSON ${result.matchedElementCount}/${result.metadataElementCount}`
        : '';
      fileName.textContent = `${file.name} (${result.meshCount} meshes${metadataStatus})`;
      fileName.title = [file.name, metadataFile?.name].filter(Boolean).join('\n');
      visibleToggle.disabled = false;
      visibleToggle.checked = true;
      clearButton.disabled = false;
    } catch (error) {
      log.error('GLBモデルの読み込みに失敗しました:', error);
      input.value = '';
      fileName.textContent = hasGlbModel
        ? '新しいGLBの読み込みに失敗しました'
        : '読み込みに失敗しました';
      fileName.title = error.message || '';
      clearButton.disabled = !hasGlbModel;
      eventBus.emit(ToastEvents.SHOW_ERROR, {
        message: `GLBモデルの読み込みに失敗しました: ${error.message}`,
      });
    } finally {
      input.disabled = false;
    }
  });

  visibleToggle.addEventListener('change', async () => {
    const { setGlbModelVisible } = await import('../../viewer/index.js');
    setGlbModelVisible(visibleToggle.checked);
  });

  clearButton.addEventListener('click', async () => {
    const { clearGlbModel } = await import('../../viewer/index.js');
    clearGlbModel();
  });
}

/**
 * 比較用ファイル入力の初期化を実行します。
 */
export function initializeCompareFileInputs() {
  log.info('比較用ファイル入力の初期化を開始します');

  applyEnabledFileTypesUi();
  wire('fileA', 'A');
  wire('fileB', 'B');
  wireGlbModelInput();

  // 歴史的に呼び出し元が前提としていたため暫定互換として残す
  window.updateCompareButtonLabel = updateCompareButtonLabel;

  updateCompareButtonLabel();
}

export { updateCompareButtonLabel };
