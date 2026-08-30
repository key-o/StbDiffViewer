/**
 * @fileoverview DXFファイル読み込み統合モジュール（オーケストレーター）
 *
 * DXFファイルの読み込みからビューアへの表示までを統合的に管理します。
 * 実装は各サブモジュールに分離されており、このファイルはUIの初期化と
 * 公開APIの再エクスポートを担当します。
 *
 * サブモジュール構成:
 * - dxfLoaderHelpers.js: 共有ヘルパー関数
 * - dxfFileLoader.js: ファイル読み込みコアロジック
 * - dxfExportUI.js: DXFエクスポートUI
 * - stbExportUI.js: STB→DXFエクスポートUI
 * - batchExportUI.js: バッチエクスポートUI
 */

import { createLogger } from '../../utils/logger.js';
import { toggleDxfEditMode } from '../../viewer/index.js';
import { eventBus, ExportEvents, ModelEvents } from '../../data/events/index.js';
import {
  loadDxfFile,
  clearDxfData,
  getDxfPlacementOptions,
  getPlacementInfoText,
  getCurrentEntities,
  getCurrentLayers,
} from './dxfFileLoader.js';
import { showWarning } from '../dxfLoaderHelpers.js';
import { updateExportLayerUI, clearSelectedExportLayers, initExportUI } from '../dxfExportUI.js';
import {
  updateStbExportStatus,
  setStbExportPanelVisibility,
  initStbExportUI,
} from '../stbExportUI.js';
import { getCurrentStories, getCurrentAxesData } from '../dxfLoaderHelpers.js';

const log = createLogger('DXFLoader');

/**
 * DXFローダーUIを初期化
 */
export function initDxfLoaderUI() {
  // 配置オプションUIを初期化
  initPlacementOptionsUI();

  // DXFファイル入力のイベントリスナー
  const dxfFileInput = document.getElementById('dxfFile');
  if (dxfFileInput) {
    dxfFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) {
        const loadBtn = document.getElementById('loadDxfButton');
        if (loadBtn) {
          loadBtn.disabled = true;
          loadBtn.textContent = '読み込み中...';
        }

        const success = await loadDxfFile(file);

        if (loadBtn) {
          loadBtn.disabled = false;
          loadBtn.textContent = 'DXF読込';
        }

        if (success) {
          // DXFセクションのサマリーを表示
          const summaryEl = document.getElementById('dxf-summary');
          const currentEntities = getCurrentEntities();
          const currentLayers = getCurrentLayers();
          if (summaryEl) {
            summaryEl.classList.remove('hidden');
            const placementOptions = getDxfPlacementOptions();
            const placementInfo = getPlacementInfoText(placementOptions);
            summaryEl.innerHTML = `
              <div class="dxf-summary-title">DXF読み込み完了</div>
              <div class="dxf-summary-content">
                <div>線分: ${currentEntities.lines.length}</div>
                <div>ポリライン: ${currentEntities.lwpolylines.length}</div>
                <div>円: ${currentEntities.circles.length}</div>
                <div>円弧: ${currentEntities.arcs.length}</div>
                <div>寸法: ${currentEntities.dimensions.length}</div>
                <div>テキスト: ${currentEntities.texts.length}</div>
                <div>レイヤー: ${currentLayers.length}</div>
                <div style="grid-column: span 2; margin-top: 4px; color: var(--info-text, #0c5460);">配置: ${placementInfo}</div>
              </div>
            `;
          }

          // レイヤーパネルを表示
          const layerPanel = document.getElementById('dxf-layer-panel');
          if (layerPanel) {
            layerPanel.classList.remove('hidden');
          }

          // エクスポートパネルを表示
          const exportPanel = document.getElementById('dxf-export-panel');
          if (exportPanel) {
            exportPanel.classList.remove('hidden');
          }

          // エクスポートレイヤーUIを更新
          updateExportLayerUI();
        }
      }
    });
  }

  // DXF読み込みボタンのイベントリスナー
  const loadDxfBtn = document.getElementById('loadDxfButton');
  if (loadDxfBtn) {
    loadDxfBtn.addEventListener('click', () => {
      const dxfFileInput = document.getElementById('dxfFile');
      if (dxfFileInput && dxfFileInput.files[0]) {
        loadDxfFile(dxfFileInput.files[0]);
      } else {
        showWarning('DXFファイルを選択してください');
      }
    });
  }

  // DXFクリアボタンのイベントリスナー
  const clearDxfBtn = document.getElementById('clearDxfButton');
  if (clearDxfBtn) {
    clearDxfBtn.addEventListener('click', () => {
      clearDxfData();

      // UIをリセット
      const dxfFileInput = document.getElementById('dxfFile');
      if (dxfFileInput) {
        dxfFileInput.value = '';
      }
      const fileNameEl = document.getElementById('dxfFile-name');
      if (fileNameEl) {
        fileNameEl.textContent = '選択されていません';
      }
      const summaryEl = document.getElementById('dxf-summary');
      if (summaryEl) {
        summaryEl.classList.add('hidden');
      }
      const layerPanel = document.getElementById('dxf-layer-panel');
      if (layerPanel) {
        layerPanel.classList.add('hidden');
      }
      // エクスポートパネルを非表示
      const exportPanel = document.getElementById('dxf-export-panel');
      if (exportPanel) {
        exportPanel.classList.add('hidden');
      }
      // エクスポート用選択レイヤーをクリア
      clearSelectedExportLayers();
    });
  }

  // エクスポートUIを初期化
  initExportUI();

  // STBエクスポートUIを初期化
  initStbExportUI();

  // 位置調整モードトグルボタン
  const toggleEditModeBtn = document.getElementById('toggleDxfEditMode');
  if (toggleEditModeBtn) {
    toggleEditModeBtn.addEventListener('click', (e) => {
      const isActive = e.target.classList.toggle('active');
      toggleDxfEditMode(isActive);
      e.target.textContent = isActive ? '位置調整モード終了' : '位置調整モード開始';
    });
  }

  log.info('DXFローダーUI初期化完了');
}

/**
 * 配置オプションUIを初期化
 */
function initPlacementOptionsUI() {
  const planeSelect = document.getElementById('dxfPlacementPlane');
  const positionSelect = document.getElementById('dxfPlacementPosition');
  const manualOffsetCheckbox = document.getElementById('dxfManualOffset');
  const manualOffsetInputs = document.getElementById('dxf-manual-offset-inputs');

  // 配置面の変更イベント
  if (planeSelect) {
    planeSelect.addEventListener('change', () => {
      updatePlacementPositionOptions();
    });
  }

  // 手動オフセットチェックボックスの変更イベント
  if (manualOffsetCheckbox && manualOffsetInputs) {
    manualOffsetCheckbox.addEventListener('change', () => {
      if (manualOffsetCheckbox.checked) {
        manualOffsetInputs.classList.remove('hidden');
        // 位置選択を無効化
        if (positionSelect) {
          positionSelect.disabled = true;
        }
      } else {
        manualOffsetInputs.classList.add('hidden');
        // 位置選択を有効化
        if (positionSelect) {
          positionSelect.disabled = false;
        }
      }
    });
  }

  // 初期配置位置オプションを設定
  updatePlacementPositionOptions();

  // STBモデル読み込み時に配置位置選択肢を自動更新
  eventBus.on(ModelEvents.LOADED, () => {
    updatePlacementPositionOptions();
  });

  log.info('配置オプションUI初期化完了');
}

/**
 * 配置面に応じて配置位置のオプションを更新
 */
export function updatePlacementPositionOptions() {
  const planeSelect = document.getElementById('dxfPlacementPlane');
  const positionSelect = document.getElementById('dxfPlacementPosition');

  if (!planeSelect || !positionSelect) return;

  const plane = planeSelect.value;

  // 既存のオプションをクリア（原点以外）
  positionSelect.innerHTML = '<option value="origin">原点 (0)</option>';

  // STBモデルの階・通り情報を取得
  const stories = getCurrentStories();
  const axesData = getCurrentAxesData();

  if (plane === 'xy') {
    // XY平面 - 階を追加
    if (stories && stories.length > 0) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = '階';

      // 高さ順にソート（昇順）
      const sortedStories = [...stories].sort((a, b) => a.height - b.height);
      for (const story of sortedStories) {
        const option = document.createElement('option');
        option.value = story.id;
        option.textContent = `${story.name} (${story.height}mm)`;
        optgroup.appendChild(option);
      }
      positionSelect.appendChild(optgroup);
    }
  } else if (plane === 'xz') {
    // XZ平面 - Y通りを追加
    if (axesData?.yAxes && axesData.yAxes.length > 0) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = 'Y通り';

      // 距離順にソート
      const sortedAxes = [...axesData.yAxes].sort((a, b) => a.distance - b.distance);
      for (const axis of sortedAxes) {
        const option = document.createElement('option');
        option.value = axis.id;
        option.textContent = `${axis.name} (${axis.distance}mm)`;
        optgroup.appendChild(option);
      }
      positionSelect.appendChild(optgroup);
    }
  } else if (plane === 'yz') {
    // YZ平面 - X通りを追加
    if (axesData?.xAxes && axesData.xAxes.length > 0) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = 'X通り';

      // 距離順にソート
      const sortedAxes = [...axesData.xAxes].sort((a, b) => a.distance - b.distance);
      for (const axis of sortedAxes) {
        const option = document.createElement('option');
        option.value = axis.id;
        option.textContent = `${axis.name} (${axis.distance}mm)`;
        optgroup.appendChild(option);
      }
      positionSelect.appendChild(optgroup);
    }
  }
}

/**
 * イベントリスナーを初期化
 *
 * STBエクスポート状態更新イベントを監視します。
 */
export function initDxfLoaderEventListeners() {
  eventBus.on(ExportEvents.STB_STATUS_UPDATE_REQUESTED, () => {
    updateStbExportStatus();
  });
}

// 公開APIの再エクスポート
export { loadDxfFile, updateStbExportStatus, setStbExportPanelVisibility };

// Note: window.* グローバルエクスポートは廃止（ESM import を使用）
