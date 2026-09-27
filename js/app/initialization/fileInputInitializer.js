/**
 * 比較対象ファイル入力の初期化
 */

import { createLogger } from '../../utils/logger.js';
import { t } from '../../config/i18n.js';
import { getAcceptAttribute, getEnabledFileTypes } from '../../config/fileTypeConfig.js';

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

async function handleClear(targetId, button) {
  if (clearInProgress || document.getElementById('compareButton')?.disabled) return;
  clearInProgress = true;
  // dynamic importや再読込を含む解除処理の完了まで、入力経路を一括でロックする。
  // これにより旧ファイルを捕捉した比較処理との競合や、再読込中の差し替えを防ぐ。
  setFileActionsLocked(true);

  try {
    // modelLoaderController は初期化モジュール群も参照するため、起動時の循環依存を
    // 避けて解除操作が行われた時だけ読み込む。
    const { clearLoadedModels, isModelLoaded } =
      await import('../controllers/modelLoaderController.js');
    const hadLoadedModel = isModelLoaded();
    if (!clearFileSelection(targetId)) return;

    if (!hadLoadedModel) return;

    button.disabled = true;
    const inputA = document.getElementById('fileA');
    const inputB = document.getElementById('fileB');
    const hasRemainingFile = Boolean(inputA?.files?.length || inputB?.files?.length);

    if (hasRemainingFile && typeof window.handleCompareModelsClick === 'function') {
      await window.handleCompareModelsClick();
    } else {
      clearLoadedModels();
    }
  } catch (error) {
    log.error('モデルの解除後処理に失敗しました:', error);
    const { clearLoadedModels } = await import('../controllers/modelLoaderController.js');
    clearLoadedModels();
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

/**
 * 比較用ファイル入力の初期化を実行します。
 */
export function initializeCompareFileInputs() {
  log.info('比較用ファイル入力の初期化を開始します');

  applyEnabledFileTypesUi();
  wire('fileA', 'A');
  wire('fileB', 'B');

  // 歴史的に呼び出し元が前提としていたため暫定互換として残す
  window.updateCompareButtonLabel = updateCompareButtonLabel;

  updateCompareButtonLabel();
}

export { updateCompareButtonLabel };
