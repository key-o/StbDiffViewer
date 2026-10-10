/**
 * @fileoverview 要素情報パネルの左ドッキング制御
 *
 * 要素情報パネル(#component-info)を画面左端にドッキング／フローティングで
 * 切り替える。ドッキング時はパネルを左端に固定し、パネル幅ぶん body に余白を
 * 作ることで 3D キャンバスを縮める（要素を隠さない）。
 *
 * @module ui/panels/element-info/dockController
 */

import { createLogger } from '../../../utils/logger.js';
import { storageHelper } from '../../../utils/storageHelper.js';
import { updateViewportSize } from '../../../viewer/core/core.js';

const log = createLogger('ui:element-info:dock');

const STORAGE_KEY = 'elementInfoDocked';
const PANEL_ID = 'component-info';
const DOCK_BTN_ID = 'dock-component-info-btn';

let isDocked = false;
let savedCssText = '';
let resizeObserver = null;
let resizeFrame = null;
let classObserver = null;

/**
 * ドッキング中かつパネル表示中のときだけ body に余白クラスを付与する。
 * （パネルを閉じている間は余白を作らずキャンバスを全幅に保つ）
 * @param {HTMLElement} panel
 */
function syncBodyPadding(panel) {
  const visible = panel.classList.contains('visible');
  document.body.classList.toggle('has-docked-element-info', isDocked && visible);
  requestAnimationFrame(updateViewportSize);
}

/**
 * ドッキング幅を body のCSS変数へ反映し、キャンバスの縮小量を同期する。
 * @param {HTMLElement} panel
 */
function syncDockWidth(panel) {
  const width = panel.offsetWidth;
  if (width > 0) {
    document.body.style.setProperty('--docked-element-info-width', `${width}px`);
    updateViewportSize();
  }
}

/**
 * パネルをドッキング状態にする。
 * @param {HTMLElement} panel
 */
function dock(panel) {
  if (isDocked) return;
  isDocked = true;

  // フローティング時のインラインスタイル（ドラッグ/リサイズで設定済み）を保存し、
  // 位置系のインラインを除去してドッキング用CSSに委ねる
  savedCssText = panel.style.cssText;
  panel.style.transform = '';
  panel.style.right = '';
  panel.style.bottom = '';
  panel.style.top = '';
  panel.style.left = '';

  panel.classList.add('docked-left');
  syncDockWidth(panel);
  syncBodyPadding(panel);

  // 横幅リサイズに追従して余白を更新
  resizeObserver = new ResizeObserver(() => {
    if (resizeFrame != null) return;
    // 通知中にbody余白とcanvasサイズを変えず、次の描画frameでまとめて反映する。
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      if (isDocked) syncDockWidth(panel);
    });
  });
  resizeObserver.observe(panel);

  // 表示/非表示の切替に追従して余白を付け外し
  classObserver = new MutationObserver(() => syncBodyPadding(panel));
  classObserver.observe(panel, { attributes: true, attributeFilter: ['class'] });

  storageHelper.set(STORAGE_KEY, true);
  log.info('[UI] 要素情報パネルを左ドッキングしました');
}

/**
 * パネルをフローティング状態に戻す。
 * @param {HTMLElement} panel
 */
function undock(panel) {
  if (!isDocked) return;
  isDocked = false;

  resizeObserver?.disconnect();
  resizeObserver = null;
  if (resizeFrame != null) cancelAnimationFrame(resizeFrame);
  resizeFrame = null;
  classObserver?.disconnect();
  classObserver = null;

  panel.classList.remove('docked-left');
  document.body.classList.remove('has-docked-element-info');
  document.body.style.removeProperty('--docked-element-info-width');

  // フローティング時のスタイルを復元
  panel.style.cssText = savedCssText;
  savedCssText = '';

  updateViewportSize();
  storageHelper.set(STORAGE_KEY, false);
  log.info('[UI] 要素情報パネルをフローティングに戻しました');
}

/**
 * ドックボタンの初期化。
 */
export function initializeDockButton() {
  const panel = document.getElementById(PANEL_ID);
  const dockBtn = document.getElementById(DOCK_BTN_ID);
  if (!panel || !dockBtn) {
    log.warn('要素情報パネルまたはドックボタンが見つかりません');
    return;
  }

  const updateButtonState = () => {
    dockBtn.setAttribute('aria-pressed', String(isDocked));
    dockBtn.classList.toggle('active', isDocked);
  };

  dockBtn.addEventListener('click', (e) => {
    // ヘッダーのドラッグ/前面表示ハンドラへの伝播を防ぐ
    e.stopPropagation();
    if (isDocked) {
      undock(panel);
    } else {
      dock(panel);
    }
    updateButtonState();
  });

  // 既定は左ドッキング。明示的にフローティングを選択した場合(false)のみ解除する
  if (storageHelper.get(STORAGE_KEY) !== false) {
    dock(panel);
    updateButtonState();
  }
}
