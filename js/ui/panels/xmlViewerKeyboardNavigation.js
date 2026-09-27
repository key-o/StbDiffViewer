/**
 * @fileoverview 生XMLビューのキーボードナビゲーション。
 *
 * F3 / Shift+F3 を既存の検証箇所ナビゲーションボタンへ接続する。
 * 実際の移動処理は xmlViewerIssueList.js 側に集約し、このモジュールは
 * キー入力を既存UI操作へ橋渡しするだけにする。
 */

const BOUND_DATASET_KEY = 'xmlViewerKeyboardNavigationBound';

function isEditableTarget(target) {
  const tagName = target?.tagName?.toLowerCase?.();
  return (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    Boolean(target?.isContentEditable)
  );
}

function isXmlViewerVisible() {
  const viewer = document.getElementById('xml-viewer-float');
  return Boolean(viewer && !viewer.classList.contains('hidden'));
}

/**
 * F3 / Shift+F3 を次/前の検証箇所へ割り当てる。
 */
export function initializeXmlViewerKeyboardNavigation() {
  const root = document.documentElement;
  if (!root || root.dataset[BOUND_DATASET_KEY] === 'true') return;
  root.dataset[BOUND_DATASET_KEY] = 'true';

  const prev = document.getElementById('xml-prev-error-btn');
  const next = document.getElementById('xml-next-error-btn');
  if (prev) prev.title = '前の検証箇所 (Shift+F3)';
  if (next) next.title = '次の検証箇所 (F3)';

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'F3' || event.ctrlKey || event.altKey || event.metaKey) return;
      if (!isXmlViewerVisible() || isEditableTarget(event.target)) return;

      // 生XMLビュー表示中はブラウザ標準の検索F3より検証箇所ナビゲーションを優先する。
      event.preventDefault();
      event.stopPropagation();

      const button = document.getElementById(
        event.shiftKey ? 'xml-prev-error-btn' : 'xml-next-error-btn',
      );
      if (button && !button.disabled) button.click();
    },
    true,
  );
}
