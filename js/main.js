/**
 * @fileoverview 構造モデルビューワーのメインモジュール（エントリーポイント）
 *
 * このファイルは、アプリケーションのエントリーポイントとして機能し、
 * 各種初期化モジュールを調整します。
 *
 * 初期化フェーズ:
 * 1. レンダラーコアの初期化
 * 2. 必要なモジュールの非同期初期化
 * 3. アプリケーションコアの起動
 * 4. UIコンポーネントの初期化
 * 5. ボタンイベントリスナーの設定
 * 6. 統合システムの初期化
 * 7. 開発ツールのセットアップ
 */

// STB読み込み共通カーネルへのDI注入（副作用import）。
// ESMの評価順は依存グラフ順のため最初に実行される保証はないが、
// createKernelLogger がログ出力時に遅延解決するため注入後のロガーが使われる

import './app/initialization/stbKernelSetup.js';
import { createLogger } from './utils/logger.js';
import {
  camera,
  controls,
  elementGroups,
  requestRender,
  displayModeManager,
  labelDisplayManager,
} from './viewer/index.js';
import { setState } from './data/state/globalState.js';
import { showError } from './ui/common/toast.js';
import { handleCompareModelsClick } from './app/initialization/eventHandlers.js';
import { initializeRenderer, exposeManagers } from './app/initialization/rendererInitializer.js';
import { initializeRequiredModules } from './app/initialization/moduleInitializer.js';
import { initializeApp } from './app/initialization/appInitializer.js';
import {
  initializeUIComponents,
  setupButtonEventListeners,
} from './app/initialization/uiInitializer.js';
import {
  initializeIntegratedSystems,
  setupLoadDisplayEventListeners,
} from './app/initialization/systemInitializer.js';
import { initializeEnvironment } from './app/initialization/environmentInitializer.js';
import { initializeCompareFileInputs } from './app/initialization/fileInputInitializer.js';
import { initializeGlobalErrorHandling } from './app/initialization/globalErrorHandler.js';
import { setupDevelopmentTools } from './app/initialization/devToolsInitializer.js';
import { initArButton } from './ui/ar/arButton.js';
import { setRebarMemberVisible } from './app/viewModes/rebarMeshRetentionController.js';
import { getModelContext } from './app/viewModes/modelContext.js';

// --- 初期化フラグ ---
let rendererInitialized = false;
const log = createLogger('app');

// E2E・診断ツールが、canvasの存在ではなくUIイベント登録まで完了した状態を
// 待機できるようにする。初期化途中のファイル投入はchangeイベントを取りこぼす。
window.__appInitializationComplete = false;

initializeGlobalErrorHandling();

// --- 再描画をリクエストする関数 ---
function scheduleRender() {
  if (rendererInitialized) {
    requestRender();
  } else {
    log.warn('レンダリングをリクエストできません: レンダラーが初期化されていません');
  }
}

// --- グローバル関数の登録 ---
// モデル比較ハンドラーをグローバルに登録
window.handleCompareModelsClick = async function () {
  await handleCompareModelsClick(scheduleRender, {
    rendererInitialized,
    camera,
    controls,
  });
};

// --- マネージャーをグローバルに公開（デバッグ用） ---
exposeManagers({
  displayModeManager,
  labelDisplayManager,
});

// E2E・診断用に、アプリ本体と同じモジュールインスタンスの配筋表示APIを公開する。
// ソースURLをpage.evaluate()から再importするとviewer/sceneが別インスタンスになり、
// 実画面とは異なる配筋グループを操作してしまうためである。
window.__rebarDisplayApi = Object.freeze({
  setRebarMemberVisible,
  isModelContextReady: () => Boolean(getModelContext().modelADocument),
});

// --- DOMContentLoaded イベントリスナー ---
document.addEventListener('DOMContentLoaded', async () => {
  await initializeEnvironment();
  log.info('アプリケーションを起動しています...');
  initializeCompareFileInputs();
  log.info('✓ Phase 0: 比較対象ファイル入力の初期化が完了しました');

  // Phase 1: レンダラーコアの初期化
  if (await initializeRenderer()) {
    rendererInitialized = true;
    setState('rendering.rendererInitialized', true);
    log.info('✓ Phase 1: レンダラーコアの初期化が完了しました');

    // Phase 2: 必要なモジュールの非同期初期化
    await initializeRequiredModules(elementGroups);
    log.info('✓ Phase 2: 必要なモジュールの初期化が完了しました');

    // Phase 3: アプリケーションコアの起動
    initializeApp(scheduleRender, rendererInitialized);
    log.info('✓ Phase 3: アプリケーションコアの起動が完了しました');

    // Phase 4: UIコンポーネントの初期化
    initializeUIComponents(scheduleRender, elementGroups);
    log.info('✓ Phase 4: UIコンポーネントの初期化が完了しました');

    // Phase 5: ボタンイベントリスナーの設定
    setupButtonEventListeners();
    log.info('✓ Phase 5: ボタンイベントリスナーの設定が完了しました');

    // Phase 6: 統合システムの初期化
    initializeIntegratedSystems();
    setupLoadDisplayEventListeners();
    log.info('✓ Phase 6: 統合システムの初期化が完了しました');

    // Phase 7: 開発ツールのセットアップ
    setupDevelopmentTools();
    log.info('✓ Phase 7: 開発ツールのセットアップが完了しました');

    // Phase 8: AR機能の初期化（対応デバイスのみ）
    initArButton().catch((e) => log.warn('AR機能の初期化をスキップ:', e));
    log.info('✓ Phase 8: AR機能の初期化が完了しました');

    window.__appInitializationComplete = true;
    log.info('🎉 アプリケーションの起動が完了しました');
  } else {
    window.__appInitializationComplete = false;
    log.error('レンダラーの初期化に失敗しました。アプリケーションを開始できません。');
    showError('3Dビューアの初期化に失敗しました。');
  }
});
