/**
 * @fileoverview UI初期化ヘルパー
 */

import { createLogger } from '../../utils/logger.js';
import { initializeTheme } from '../../ui/common/theme.js';
import {
  initializeToast,
  showSuccess,
  showError,
  showWarning,
  showInfo,
  initializeToastEventListeners,
} from '../../ui/common/toast.js';
import { initializeFloatingWindow } from '../../ui/panels/floatingWindow.js';
import { initializeOverlayToggle } from '../../ui/panels/overlayPanelToggle.js';
import { initializeTreeView } from '../../ui/panels/elementTreeView.js';
import {
  initializeSectionTreeView,
  buildSectionTree,
  setGroupingMode,
} from '../../ui/panels/sectionTreeView.js';
import { initializeComparisonKeySelector } from '../../ui/panels/comparisonKeySelector.js';
import { initializeToleranceSettings } from '../../ui/panels/toleranceSettings.js';
import { initDxfLoaderUI, initDxfLoaderEventListeners } from '../controllers/dxfLoader.js';
import { setupVersionPanelEventListeners } from '../../ui/panels/versionPanel.js';
import { initClipping2DEventListeners } from '../../ui/viewer3d/clipping2DImpl.js';
import { initSectionBoxEventListeners } from '../../ui/viewer3d/sectionBox.js';
import { injectElementInfoService } from '../../viewer/services/elementInfoAdapter.js';
import { initializeValidationPanel } from '../../ui/panels/validationPanelIntegration.js';
import { initializeXmlViewer } from '../../ui/panels/xmlViewer.js';
import { initializeXmlViewerIssueList } from '../../ui/panels/xmlViewerIssueList.js';
import { initializeXmlViewerKeyboardNavigation } from '../../ui/panels/xmlViewerKeyboardNavigation.js';
import { initializeRawXmlDiffViewer } from '../../ui/panels/rawXmlDiffViewer.js';
import { initializeModelEditPanel } from '../../ui/panels/modelEditPanel.js';
import { getState } from '../../data/state/globalState.js';
import { convertComparisonResultsForTree } from '../../data/converters/comparison-to-tree.js';
import { handleTreeElementSelection } from './eventHandlers.js';
import {
  initColumnSectionListPanel,
  initBeamSectionListPanel,
} from '../../ui/panels/sectionList/index.js';
import { initializeBeamOpeningDiagramPanel } from '../../ui/panels/beamOpeningDiagram/BeamOpeningDiagramPanel.js';
import { initializeAnchorageCheckPanel } from '../../ui/panels/anchorageCheckPanel.js';
import { initializeRebarDecisionTracePanel } from '../../ui/panels/rebarDecisionTracePanel.js';

const log = createLogger('uiInitializationHelpers');

/**
 * テーマ関連UIを初期化
 */
export function initializeThemeSystem() {
  initializeTheme({
    onThemeChange: (theme, setting) => {
      log.info(`テーマが変更されました: ${theme} (設定: ${setting})`);
    },
  });

  log.info('ライトテーマを適用しました');
}

/**
 * 通知・共通パネルを初期化
 */
export function initializeSharedPanels() {
  initializeToast({
    position: 'bottom-right',
    duration: 4000,
    maxToasts: 5,
  });
  initializeToastEventListeners();
  initClipping2DEventListeners();
  initSectionBoxEventListeners();
  initDxfLoaderEventListeners();

  // Issue #277: 編集入口を Element Info / 出力設定から独立させる。
  // 既存ボタンを移動してから各編集フォームを初期化することで、mutation 経路は変更しない。
  initializeModelEditPanel();

  import('../../ui/panels/element-info/index.js').then((elementInfo) => {
    injectElementInfoService(elementInfo);
    if (typeof elementInfo.initializeEditModeButton === 'function') {
      elementInfo.initializeEditModeButton();
    }
    if (typeof elementInfo.initializeExportJsonButton === 'function') {
      elementInfo.initializeExportJsonButton();
    }
    if (typeof elementInfo.initializeDockButton === 'function') {
      elementInfo.initializeDockButton();
    }
    if (typeof elementInfo.initAddMemberForm === 'function') {
      elementInfo.initAddMemberForm();
    }
    if (typeof elementInfo.initOpenBuilderForm === 'function') {
      elementInfo.initOpenBuilderForm();
    }
    if (typeof elementInfo.initJointBuilderForm === 'function') {
      elementInfo.initJointBuilderForm();
    }
    if (typeof elementInfo.initJointArrangementManagerForm === 'function') {
      elementInfo.initJointArrangementManagerForm();
    }
    log.info('要素情報サービスが注入されました');
  });

  window.showToast = { showSuccess, showError, showWarning, showInfo };

  initializeFloatingWindow();
  initializeValidationPanel();
  initializeXmlViewer();
  initializeXmlViewerIssueList();
  initializeXmlViewerKeyboardNavigation();
  initializeRawXmlDiffViewer();
  import('../../ui/panels/pdfOverlay/PdfOverlayPanel.js')
    .then(({ initializePdfOverlayPanel }) => initializePdfOverlayPanel())
    .catch((error) => log.warn('PDF図面照合パネルの初期化に失敗:', error));
  initializeOverlayToggle();

  log.info('共通UIパネルが初期化されました');
}

/**
 * ツリーパネルを初期化
 * @param {Function} scheduleRender - 再描画関数
 * @param {Object} elementGroups - 要素グループ
 */
export function initializeTreePanels(scheduleRender, elementGroups) {
  initializeTreeView('element-tree-container', (selectedElement) => {
    handleTreeSelection(selectedElement, '要素ツリー', true, scheduleRender, elementGroups);
  });

  initializeSectionTreeView('section-tree-container', (selectedElement) => {
    handleTreeSelection(selectedElement, '断面ツリー', false, scheduleRender, elementGroups);
  });

  const groupingModeSelect = document.getElementById('section-grouping-mode');
  if (groupingModeSelect) {
    groupingModeSelect.addEventListener('change', (event) => {
      const newMode = event.target.value;
      log.info(`断面ツリーのグループ化モードを変更: ${newMode}`);
      setGroupingMode(newMode);
      rebuildSectionTreeFromState();
    });
  }
}

/**
 * 比較関連UIを初期化
 */
export function initializeComparisonControls() {
  initializeComparisonKeySelector('#comparison-key-selector-container', (newKeyType) => {
    log.info(`比較キータイプが変更されました: ${newKeyType}`);
  });
  log.info('比較キー選択UIが初期化されました');

  const toleranceContainer = document.getElementById('tolerance-settings-container');
  if (toleranceContainer) {
    initializeToleranceSettings(toleranceContainer);
    log.info('許容差設定パネルを初期化しました');
  } else {
    log.warn('許容差設定コンテナー #tolerance-settings-container が見つかりません');
  }

  initDxfLoaderUI();
  setupVersionPanelEventListeners();
  log.info('補助UIコントロールを初期化しました');
}

/**
 * 断面リスト関連パネルを初期化
 */
export function initializeSectionListPanels() {
  initializeOptionalPanel(initColumnSectionListPanel, 'RC柱断面リストパネル');
  initializeOptionalPanel(initBeamSectionListPanel, 'RC梁断面リストパネル');
  initializeOptionalPanel(initializeBeamOpeningDiagramPanel, '梁貫通孔配置図パネル');
  initializeOptionalPanel(initializeAnchorageCheckPanel, '定着・カットオフチェックパネル');
  initializeOptionalPanel(initializeRebarDecisionTracePanel, '配筋判断トレースパネル');
}

function handleTreeSelection(
  selectedElement,
  sourceName,
  prefersElementTree,
  scheduleRender,
  elementGroups,
) {
  try {
    log.info(`${sourceName}から要素が選択されました:`, selectedElement);
    handleTreeElementSelection(
      selectedElement,
      sourceName,
      prefersElementTree,
      scheduleRender,
      elementGroups,
    );
  } catch (error) {
    log.error(`${sourceName}選択処理でエラーが発生:`, error);
  }
}

function rebuildSectionTreeFromState() {
  const comparisonResult = getState('comparisonResults');
  const sectionsData = getState('sectionsData');
  if (!comparisonResult || !sectionsData) {
    return;
  }

  const treeData = convertComparisonResultsForTree(comparisonResult);
  buildSectionTree(treeData, sectionsData);
}

function initializeOptionalPanel(initializer, label) {
  try {
    initializer();
    log.info(`${label}を初期化しました`);
  } catch (error) {
    log.warn(`${label}の初期化に失敗:`, error);
  }
}
