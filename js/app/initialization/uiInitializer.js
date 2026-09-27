/**
 * @fileoverview UIコンポーネントとボタンイベントリスナーの初期化
 */

import { createLogger } from '../../utils/logger.js';
import { getState } from '../../data/state/globalState.js';
import {
  toggleOriginAxesVisibility,
  togglePlacementLinesVisibility,
  toggleGridVisibility,
} from './eventHandlers.js';
import { getLoadDisplayManager, LOAD_DISPLAY_MODE } from '../../viewer/index.js';
import {
  initializeRebarDisplaySync,
  setRebarMemberVisible,
} from '../viewModes/rebarMeshRetentionController.js';
import { setRebarSelectionModeActive } from '../controllers/interaction/rebarSelectionMode.js';
import {
  initializeThemeSystem,
  initializeSharedPanels,
  initializeTreePanels,
  initializeComparisonControls,
  initializeSectionListPanels,
} from './uiInitializationHelpers.js';

const log = createLogger('uiInitializer');

export function initializeUIComponents(scheduleRender, elementGroups) {
  initializeThemeSystem();
  initializeSharedPanels();
  initializeTreePanels(scheduleRender, elementGroups);
  initializeComparisonControls();
  initializeSectionListPanels();
}

export function setupButtonEventListeners() {
  const compareBtn = document.getElementById('compareButton');
  if (compareBtn) compareBtn.addEventListener('click', window.handleCompareModelsClick);
  else log.error('比較ボタンが見つかりません。');

  const originAxesToggle = document.getElementById('toggleOriginAxes');
  if (originAxesToggle) {
    originAxesToggle.addEventListener('change', (event) => {
      const isVisible = event.target.checked;
      toggleOriginAxesVisibility(isVisible);
      log.info(`原点軸の表示状態を設定しました: ${isVisible}`);
    });
  } else log.warn('原点軸切り替えボタンが見つかりません。');

  const placementLinesToggle = document.getElementById('togglePlacementLines');
  if (placementLinesToggle) {
    placementLinesToggle.addEventListener('change', (event) => {
      const isVisible = event.target.checked;
      togglePlacementLinesVisibility(isVisible);
      log.info(`配置基準線の表示状態を設定しました: ${isVisible}`);
    });
  } else log.warn('配置基準線切り替えボタンが見つかりません。');

  const gridToggle = document.getElementById('toggleViewerGrid');
  if (gridToggle) {
    gridToggle.addEventListener('change', (event) => {
      const isVisible = event.target.checked;
      toggleGridVisibility(isVisible);
      log.info(`グリッドの表示状態を設定しました: ${isVisible}`);
    });
  } else log.warn('グリッド切替用のチェックボックスが見つかりません');

  const loadDisplayToggle = document.getElementById('toggleLoadDisplay');
  const loadCaseSelector = document.getElementById('loadCaseSelector');

  if (loadDisplayToggle) {
    loadDisplayToggle.addEventListener('change', (event) => {
      const isVisible = event.target.checked;
      const loadManager = getLoadDisplayManager();
      if (loadManager) {
        if (isVisible) {
          const calDataA = getState('models.calDataA');
          const calDataB = getState('models.calDataB');
          if (!calDataA && !calDataB) {
            import('../../ui/common/toast.js')
              .then(({ showWarning }) => {
                showWarning(
                  '荷重データがありません。StbCalDataを含むSTBファイルを読み込んでください。',
                );
              })
              .catch(() => {
                alert('荷重データがありません。StbCalDataを含むSTBファイルを読み込んでください。');
              });
            event.target.checked = false;
            log.warn('荷重データが見つからないため、表示を無効にしました');
            return;
          }
          loadManager.setDisplayMode(LOAD_DISPLAY_MODE.ARROW);
        } else {
          loadManager.setDisplayMode(LOAD_DISPLAY_MODE.NONE);
        }
        log.info(`荷重表示を${isVisible ? '有効化' : '無効化'}しました`);
        if (loadCaseSelector) loadCaseSelector.style.display = isVisible ? 'inline-block' : 'none';
        if (typeof window.requestRender === 'function') window.requestRender();
      } else log.warn('LoadDisplayManagerが初期化されていません');
    });
  } else log.warn('荷重表示切り替えボタンが見つかりません。');

  if (loadCaseSelector) {
    loadCaseSelector.addEventListener('change', (event) => {
      const loadCaseId = event.target.value || null;
      const loadManager = getLoadDisplayManager();
      if (loadManager) {
        loadManager.selectLoadCase(loadCaseId);
        log.info(`荷重ケースを選択しました: ${loadCaseId || '全て'}`);
        if (typeof window.requestRender === 'function') window.requestRender();
      }
    });
  }

  setupRebarDisplayListeners();
  log.info('ボタンイベントリスナーをセットアップしました');
}

function setupRebarDisplayListeners() {
  const coverInput = document.getElementById('rebarCoverInput');
  const selectionModeToggle = document.getElementById('toggleRebarSelectionMode');

  if (selectionModeToggle) {
    selectionModeToggle.addEventListener('change', (event) => {
      const active = setRebarSelectionModeActive(event.target.checked);
      log.info(`鉄筋選択モードを${active ? '有効化' : '無効化'}しました`);
    });
  }

  // project detailingはrebarDisplay側で各rebuild時にruntime sourceから再取得する。
  // ここではsnapshotをoptionsへ保持せず、モデル切替後に古いworld座標を再利用しない。
  const readOptions = () => {
    const value = coverInput ? Number.parseFloat(coverInput.value) : NaN;
    return Number.isFinite(value) && value >= 0 ? { coverMm: value } : {};
  };

  const toggles = [
    {
      key: 'column',
      element: document.getElementById('toggleColumnRebarDisplay'),
      label: '柱の鉄筋表示',
    },
    {
      key: 'girder',
      element: document.getElementById('toggleGirderRebarDisplay'),
      label: '大梁の鉄筋表示',
    },
    {
      key: 'beam',
      element: document.getElementById('toggleBeamRebarDisplay'),
      label: '小梁の鉄筋表示',
    },
    {
      key: 'pile',
      element: document.getElementById('togglePileRebarDisplay'),
      label: '杭の鉄筋表示',
    },
    {
      key: 'slab',
      element: document.getElementById('toggleSlabRebarDisplay'),
      label: 'スラブの鉄筋表示',
    },
    {
      key: 'wall',
      element: document.getElementById('toggleWallRebarDisplay'),
      label: '壁の鉄筋表示',
    },
    {
      key: 'footing',
      element: document.getElementById('toggleFootingRebarDisplay'),
      label: '基礎の鉄筋表示',
    },
    {
      key: 'stripFooting',
      element: document.getElementById('toggleStripFootingRebarDisplay'),
      label: '布基礎の鉄筋表示',
    },
  ].filter((toggle) => {
    if (toggle.element) return true;
    log.warn(`${toggle.label}の切り替えボタンが見つかりません。`);
    return false;
  });

  if (toggles.length === 0) return;

  for (const toggle of toggles) {
    toggle.element.addEventListener('change', (event) => {
      const requested = event.target.checked;
      setRebarMemberVisible(requested, readOptions(), toggle.key);
      log.info(`${toggle.label}を${requested ? '有効化' : '無効化'}しました`);
    });
  }

  if (coverInput) {
    coverInput.addEventListener('change', () => {
      for (const toggle of toggles) {
        if (!toggle.element.checked) continue;
        setRebarMemberVisible(true, readOptions(), toggle.key);
      }
      log.info('かぶり厚さの変更を鉄筋表示へ反映しました');
    });
  }

  initializeRebarDisplaySync((memberKey) => {
    const toggle = toggles.find((item) => item.key === memberKey);
    if (!toggle) return;
    log.warn(
      `新しいモデルに表示できる配筋情報が無いため、${toggle.label}はチェック状態を維持したまま非表示です`,
    );
  });
}
