/**
 * @fileoverview 必要なモジュールの非同期初期化
 */

import { createLogger } from '../../utils/logger.js';
import {
  orthographicCamera,
  setElementsLabelProvider,
  setElementInfoProviders,
  setClippingStateProvider,
  setLabelVisibilityCullingProvider,
  setViewerStateProvider,
} from '../../viewer/index.js';
import { setDxfExporterProviders } from '../../export/dxf/stb-to-dxf/index.js';
import { getActiveCamera } from '../../viewer/index.js';

const log = createLogger('moduleInitializer');

/**
 * 必要なモジュールの初期化（ラベル管理、XSDスキーマ、プロバイダー注入）
 * @param {Object} elementGroups - 要素グループ
 * @returns {Promise<void>}
 */
export async function initializeRequiredModules(elementGroups) {
  // 統合ラベル管理システムを初期化
  try {
    const [
      { initializeLabelManager, generateLabelText },
      { attachElementDataToLabel, regenerateAllLabels },
      { createLabelSprite },
    ] = await Promise.all([
      import('../../ui/viewer3d/unifiedLabelManager.js'),
      import('../../ui/viewer3d/labelRegeneration.js'),
      import('../../viewer/annotations/labels.js'),
    ]);
    initializeLabelManager({ regenerateAllLabels });
    log.info('統合ラベル管理システムが初期化されました');

    // viewer層へのラベルプロバイダー注入（逆依存解消）
    const labelProvider = {
      generateLabelText,
      attachElementDataToLabel,
      createLabelSprite,
    };
    // 通常描画・Batch描画で共通のProviderを1回だけ注入する。
    setElementsLabelProvider(labelProvider);
    log.info('ラベルプロバイダーがviewer層に注入されました');
  } catch (error) {
    log.warn('ラベル管理系モジュールの初期化に失敗しました:', error);
  }

  try {
    const { getAllLabels } = await import('../../ui/state.js');
    setLabelVisibilityCullingProvider({ getLabels: getAllLabels });
    log.info('ラベルカリングプロバイダーがviewer層に注入されました');
  } catch (error) {
    log.warn('ラベルカリングプロバイダーの初期化に失敗しました:', error);
  }

  let globalStateModule;
  try {
    globalStateModule = await import('../../data/state/globalState.js');
    setClippingStateProvider({ getState: globalStateModule.getState });
    log.info('clippingManager状態プロバイダーが注入されました');

    // viewer層全体への状態プロバイダー注入（レイヤー依存違反解消）
    setViewerStateProvider({
      getState: globalStateModule.getState,
      setState: globalStateModule.setState,
    });
    log.info('viewer状態プロバイダーが注入されました');
  } catch (error) {
    log.warn('グローバル状態プロバイダーの初期化に失敗しました:', error);
  }

  // elementInfoDisplayへの依存プロバイダー注入（逆依存解消）
  try {
    const [
      { ParameterEditor },
      { SuggestionEngine },
      { floatingWindowManager },
      { getImportanceManager },
      { evaluateSectionEquivalence },
      { updateLabelsForElement },
    ] = await Promise.all([
      import('../../ui/panels/parameterEditor.js'),
      import('../suggestionEngine.js'),
      import('../../ui/panels/floatingWindow.js'),
      import('../importanceManager.js'),
      import('../sectionEquivalenceEngine.js'),
      import('../../ui/viewer3d/labelRegeneration.js'),
    ]);
    setElementInfoProviders({
      parameterEditor: ParameterEditor,
      suggestionEngine: SuggestionEngine,
      floatingWindowManager,
      getImportanceManager,
      evaluateSectionEquivalence,
      updateLabelsForElement,
    });
    log.info('elementInfoDisplayプロバイダーが注入されました');
  } catch (error) {
    log.warn('elementInfoDisplayプロバイダーの初期化に失敗しました:', error);
  }

  // DxfExporterへの依存プロバイダー注入（逆依存解消）
  // awaitで待機することで、フローティングウィンドウ表示時にプロバイダーが確実に設定されている
  try {
    const [
      { getCurrentClippingState, applyStoryClip, applyAxisClip, clearAllClippingPlanes },
      { getCurrentStories, getCurrentAxesData },
      { generateLabelText },
    ] = await Promise.all([
      import('../../ui/viewer3d/clipping.js'),
      import('../../ui/state.js'),
      import('../../ui/viewer3d/unifiedLabelManager.js'),
    ]);
    const stateModule = globalStateModule ?? (await import('../../data/state/globalState.js'));
    const getStateForDxf = stateModule.getState;

    setDxfExporterProviders({
      getState: getStateForDxf,
      generateLabelText,
      getCurrentClippingState,
      applyStoryClip,
      applyAxisClip,
      clearAllClippingPlanes,
      getCurrentStories,
      getCurrentAxesData,

      // Viewer関連のプロバイダーを注入（モデル・カメラ・ファイル名）
      getElementGroups: () => elementGroups,
      getActiveCamera: getActiveCamera,
      getOrthographicCamera: () => orthographicCamera,
      getLoadedFilename: () => {
        const fileA = getStateForDxf('files.originalFileA');
        const fileB = getStateForDxf('files.originalFileB');
        return (fileA && fileA.name) || (fileB && fileB.name) || 'stb_export';
      },
    });
    log.info('DxfExporterプロバイダーが注入されました');
  } catch (error) {
    log.warn('DxfExporterプロバイダーの初期化に失敗しました:', error);
  }

  // PDF照合は遅延読込。通常の3D表示・既存DXFの状態は変更しない。
  try {
    const { initializePdfOverlayServices } = await import('./pdfOverlayInitializer.js');
    initializePdfOverlayServices();
  } catch (error) {
    log.warn('PDF照合サービスの初期化に失敗しました:', error);
  }
}
