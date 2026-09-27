/**
 * @fileoverview STB→DXFエクスポートUI
 *
 * STBモデルからDXFファイルへのエクスポートに関するUI操作を管理します。
 */

import { createLogger } from '../utils/logger.js';
import {
  canExportStbToDxf,
  exportStbToDxf,
  getStbExportStats,
} from '../export/dxf/stb-to-dxf/index.js';
import { DEFAULT_ELEMENT_COLORS } from '../config/colorConfig.js';
import { ELEMENT_LABELS } from '../config/elementLabels.js';
import {
  getElementColorPreference,
  subscribeElementColorPreferences,
} from './elementColorPreferences.js';
import { showWarning } from './dxfLoaderHelpers.js';
import {
  initBatchExportButtons,
  updateBatchExportButtons,
  setSelectedStbExportTypesGetter,
} from './batchExportUI.js';

const log = createLogger('DXFLoader');

const selectedStbExportTypes = new Set();
let unsubscribeElementColorPreferences = null;

const DXF_ONLY_TYPE_INFO = {
  Open: { name: '開口', color: '#ffff00' },
};

const ELEMENT_TYPE_INFO = Object.fromEntries(
  Object.keys(DEFAULT_ELEMENT_COLORS).map((type) => [type, { name: ELEMENT_LABELS[type] || type }]),
);

function getTypeInfo(type) {
  return (
    ELEMENT_TYPE_INFO[type] || DXF_ONLY_TYPE_INFO[type] || { name: ELEMENT_LABELS[type] || type }
  );
}

function getTypeColor(type) {
  return (
    getElementColorPreference(type) ||
    DEFAULT_ELEMENT_COLORS[type] ||
    DXF_ONLY_TYPE_INFO[type]?.color ||
    '#ffffff'
  );
}

function updateStbExportColorSwatches(colors, changedType, changedColor) {
  const colorBoxes = document.querySelectorAll(
    '#stb-export-type-list .type-color[data-element-type]',
  );

  colorBoxes.forEach((colorBox) => {
    const elementType = colorBox.dataset.elementType;
    if (!elementType || (changedType && elementType !== changedType)) return;

    const color = changedType ? changedColor : colors?.[elementType] || getTypeColor(elementType);
    if (color) colorBox.style.backgroundColor = color;
  });
}

function ensureElementColorPreferenceSubscription() {
  if (unsubscribeElementColorPreferences) return;
  unsubscribeElementColorPreferences = subscribeElementColorPreferences(
    updateStbExportColorSwatches,
  );
}

/**
 * 選択されたSTBエクスポート要素タイプの配列を取得
 * @returns {Array<string>} 選択された要素タイプの配列
 */
export function getSelectedStbExportTypes() {
  return Array.from(selectedStbExportTypes);
}

/**
 * STBエクスポートの状態を更新
 */
export function updateStbExportStatus() {
  const statusEl = document.getElementById('stb-export-status');
  const statusTextEl = document.getElementById('stb-export-status-text');
  const elementSelectEl = document.getElementById('stb-export-element-select');
  const statsEl = document.getElementById('stb-export-stats');
  const filenameGroupEl = document.getElementById('stb-export-filename-group');
  const exportBtn = document.getElementById('exportStbDxfButton');

  if (!statusEl || !statusTextEl) return;

  const { canExport, reason, solidElementTypes } = canExportStbToDxf();

  if (canExport) {
    statusEl.className = 'stb-export-status status-ready';
    statusTextEl.textContent = `エクスポート可能: ${solidElementTypes.length}種類の要素`;

    if (elementSelectEl) elementSelectEl.classList.remove('hidden');
    if (statsEl) statsEl.classList.remove('hidden');
    if (filenameGroupEl) filenameGroupEl.classList.remove('hidden');

    updateStbExportTypeList(solidElementTypes);
    if (exportBtn) exportBtn.disabled = false;
  } else {
    statusEl.className = 'stb-export-status status-not-ready';
    statusTextEl.textContent = reason;

    if (elementSelectEl) elementSelectEl.classList.add('hidden');
    if (statsEl) statsEl.classList.add('hidden');
    if (filenameGroupEl) filenameGroupEl.classList.add('hidden');
    if (exportBtn) exportBtn.disabled = true;
  }

  updateBatchExportButtons();
}

/**
 * STBエクスポート要素タイプリストを更新
 * @param {Array<string>} availableTypes - 利用可能な要素タイプ
 */
export function updateStbExportTypeList(availableTypes) {
  const listContainer = document.getElementById('stb-export-type-list');
  if (!listContainer) return;

  listContainer.innerHTML = '';
  selectedStbExportTypes.clear();

  const stats = getStbExportStats(availableTypes);
  ensureElementColorPreferenceSubscription();

  for (const type of availableTypes) {
    const info = getTypeInfo(type);
    const color = getTypeColor(type);
    const elementCount = stats.byElementType[type] || 0;

    const item = document.createElement('label');
    item.className = 'stb-export-type-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.elementType = type;
    selectedStbExportTypes.add(type);

    checkbox.addEventListener('change', (event) => {
      if (event.target.checked) {
        selectedStbExportTypes.add(type);
      } else {
        selectedStbExportTypes.delete(type);
      }
      updateStbExportStats();
    });

    const colorBox = document.createElement('span');
    colorBox.className = 'type-color';
    colorBox.dataset.elementType = type;
    colorBox.style.backgroundColor = color;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'type-name';
    nameSpan.textContent = info.name;

    const countSpan = document.createElement('span');
    countSpan.className = 'type-count';
    countSpan.textContent = `(${elementCount}要素)`;

    item.appendChild(checkbox);
    item.appendChild(colorBox);
    item.appendChild(nameSpan);
    item.appendChild(countSpan);
    listContainer.appendChild(item);
  }

  updateStbExportStats();
}

/**
 * STBエクスポート統計を更新
 */
function updateStbExportStats() {
  const statsEl = document.getElementById('stb-export-mesh-count');
  const exportBtn = document.getElementById('exportStbDxfButton');
  if (!statsEl) return;

  const selectedTypes = Array.from(selectedStbExportTypes);
  const stats = getStbExportStats(selectedTypes);
  const openCount = stats.byElementType.Open || 0;
  const totalElementCount = stats.totalMeshes + openCount;

  statsEl.textContent = `選択: ${totalElementCount} 要素`;

  if (exportBtn) {
    exportBtn.disabled = totalElementCount === 0;
  }
}

/**
 * STB→DXFエクスポートを実行
 */
async function handleExportStbDxf() {
  const selectedTypes = Array.from(selectedStbExportTypes);
  if (selectedTypes.length === 0) {
    showWarning('エクスポートする部材を選択してください');
    return;
  }

  const filenameInput = document.getElementById('stbDxfExportFilename');
  const filename = filenameInput?.value?.trim() || 'stb_export';

  const success = await exportStbToDxf(selectedTypes, filename);
  if (success) {
    log.info('STB→DXFエクスポート成功:', filename);
  }
}

/**
 * STBエクスポートUIを初期化
 */
export function initStbExportUI() {
  const selectAllBtn = document.getElementById('selectAllStbExportTypes');
  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', () => {
      const checkboxes = document.querySelectorAll('#stb-export-type-list input[type="checkbox"]');
      checkboxes.forEach((checkbox) => {
        checkbox.checked = true;
        selectedStbExportTypes.add(checkbox.dataset.elementType);
      });
      updateStbExportStats();
    });
  }

  const deselectAllBtn = document.getElementById('deselectAllStbExportTypes');
  if (deselectAllBtn) {
    deselectAllBtn.addEventListener('click', () => {
      const checkboxes = document.querySelectorAll('#stb-export-type-list input[type="checkbox"]');
      checkboxes.forEach((checkbox) => {
        checkbox.checked = false;
        selectedStbExportTypes.delete(checkbox.dataset.elementType);
      });
      updateStbExportStats();
    });
  }

  const exportBtn = document.getElementById('exportStbDxfButton');
  if (exportBtn) {
    exportBtn.addEventListener('click', handleExportStbDxf);
  }

  setSelectedStbExportTypesGetter(getSelectedStbExportTypes);
  initBatchExportButtons();
  updateStbExportStatus();

  log.info('STBエクスポートUI初期化完了');
}

/**
 * STBエクスポートパネルの表示/非表示を切り替え
 * @param {boolean} show - 表示するかどうか
 */
export function setStbExportPanelVisibility(show) {
  const panel = document.getElementById('stb-dxf-export-panel');
  if (panel) {
    if (show) {
      panel.classList.remove('hidden');
      updateStbExportStatus();
    } else {
      panel.classList.add('hidden');
    }
  }
}
