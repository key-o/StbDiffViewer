/**
 * フローティングウィンドウの初期化と制御
 *
 * このファイルは、FloatingWindowManagerを使用して各フローティングウィンドウを初期化します。
 * ウィンドウ定義は config/windowConfig.js で一元管理されています。
 */

import { floatingWindowManager } from './floatingWindowManager.js';
import {
  getDynamicWindows,
  getStaticWindows,
  getWindowTemplate,
  getRegisterConfig,
} from '../../config/windowConfig.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('ui:panels:floatingWindow');

/**
 * 全てのフローティングウィンドウを初期化
 *
 * config/windowConfig.js から設定を読み込み、動的/静的ウィンドウを初期化します。
 */
export function initializeFloatingWindow() {
  // 動的にウィンドウを生成（config から取得）
  const dynamicWindows = getDynamicWindows();
  for (const windowDef of dynamicWindows) {
    const template = getWindowTemplate(windowDef.template);
    if (template) {
      floatingWindowManager.createWindow({
        windowId: windowDef.windowId,
        title: windowDef.title,
        icon: windowDef.icon,
        content: template.content,
        headerExtra: template.headerExtra || '',
        toggleButtonId: windowDef.toggleButtonId,
      });
    }

    // 生成したウィンドウを登録
    const registerConfig = getRegisterConfig(windowDef.windowId);
    if (registerConfig) {
      floatingWindowManager.registerWindow(registerConfig);
    }
  }

  // ツリービューのタブ切り替え機能を初期化
  initializeTreeViewTabs();

  // 静的HTMLウィンドウを登録（config から取得）
  const staticWindows = getStaticWindows();
  for (const windowDef of staticWindows) {
    const registerConfig = getRegisterConfig(windowDef.windowId);
    if (registerConfig) {
      floatingWindowManager.registerWindow(registerConfig);
    }
  }

  log.info('フローティングウィンドウの初期化が完了しました');
}

/**
 * ツリービューのタブ切り替え機能を初期化
 */
function initializeTreeViewTabs() {
  const tabButtons = document.querySelectorAll('.tree-tab-btn');
  const tabPanels = document.querySelectorAll('.tree-tab-panel');
  const groupingModeSelect = document.getElementById('section-grouping-mode');

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;

      // タブボタンのアクティブ状態を切り替え
      tabButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      // パネルの表示を切り替え
      tabPanels.forEach((panel) => {
        if (panel.id === `${targetTab}-tree-container`) {
          panel.style.display = '';
          panel.classList.add('active');
        } else {
          panel.style.display = 'none';
          panel.classList.remove('active');
        }
      });

      // 断面タブの場合はグループ化モードを表示
      if (groupingModeSelect) {
        groupingModeSelect.style.display = targetTab === 'section' ? '' : 'none';
      }
    });
  });
}

/**
 * FloatingWindowManagerのインスタンスをエクスポート（他のモジュールから使用可能）
 */
export { floatingWindowManager };
