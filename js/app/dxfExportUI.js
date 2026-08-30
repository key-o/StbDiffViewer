/**
 * @fileoverview DXFエクスポートUI
 *
 * DXFファイルのエクスポートに関するUI操作を管理します。
 */

import { createLogger } from '../utils/logger.js';
import { exportDxf, getExportStats } from '../export/dxf/dxfExporter.js';
import { getCurrentEntities, getCurrentLayers } from './controllers/dxfFileLoader.js';
import { showWarning } from './dxfLoaderHelpers.js';
import { getState } from '../data/state/globalState.js';

const log = createLogger('DXFLoader');

// エクスポート用に選択されたレイヤー
const selectedExportLayers = new Set();

/**
 * エクスポート用選択レイヤーをクリア
 */
export function clearSelectedExportLayers() {
  selectedExportLayers.clear();
}

/**
 * エクスポートレイヤーUIを更新
 */
export function updateExportLayerUI() {
  const currentEntities = getCurrentEntities();
  const currentLayers = getCurrentLayers();
  const layerContainer = document.getElementById('dxf-export-layer-list');
  if (!layerContainer) return;

  const filenameInput = document.getElementById('dxfExportFilename');
  if (filenameInput && !filenameInput.value.trim()) {
    const fileA = getState('files.originalFileA');
    if (fileA?.name) filenameInput.value = fileA.name.replace(/\.[^.]+$/, '');
  }

  layerContainer.innerHTML = '';
  selectedExportLayers.clear();

  // 各レイヤーのエンティティ数をカウント
  const layerCounts = {};
  for (const layer of currentLayers) {
    layerCounts[layer.name] = 0;
  }

  // エンティティをカウント
  const countEntities = (entities, layerName) => {
    return entities.filter((e) => e.layer === layerName).length;
  };

  for (const layer of currentLayers) {
    layerCounts[layer.name] =
      countEntities(currentEntities.lines || [], layer.name) +
      countEntities(currentEntities.circles || [], layer.name) +
      countEntities(currentEntities.arcs || [], layer.name) +
      countEntities(currentEntities.lwpolylines || [], layer.name) +
      countEntities(currentEntities.points || [], layer.name) +
      countEntities(currentEntities.texts || [], layer.name) +
      countEntities(currentEntities.dimensions || [], layer.name);
  }

  for (const layer of currentLayers) {
    const layerItem = document.createElement('label');
    layerItem.className = 'dxf-export-layer-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true; // デフォルトで全選択
    checkbox.dataset.layerName = layer.name;
    selectedExportLayers.add(layer.name);

    checkbox.addEventListener('change', (e) => {
      if (e.target.checked) {
        selectedExportLayers.add(layer.name);
      } else {
        selectedExportLayers.delete(layer.name);
      }
      updateExportStats();
    });

    const colorBox = document.createElement('span');
    colorBox.className = 'layer-color';
    colorBox.style.backgroundColor = `#${layer.color.toString(16).padStart(6, '0')}`;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'layer-name';
    nameSpan.textContent = layer.name;

    const countSpan = document.createElement('span');
    countSpan.className = 'layer-count';
    countSpan.textContent = `(${layerCounts[layer.name]})`;

    layerItem.appendChild(checkbox);
    layerItem.appendChild(colorBox);
    layerItem.appendChild(nameSpan);
    layerItem.appendChild(countSpan);
    layerContainer.appendChild(layerItem);
  }

  updateExportStats();
}

/**
 * エクスポート統計を更新
 */
function updateExportStats() {
  const currentEntities = getCurrentEntities();
  const statsEl = document.getElementById('export-entity-count');
  if (!statsEl || !currentEntities) return;

  const selectedLayerArray = Array.from(selectedExportLayers);
  const stats = getExportStats(currentEntities, selectedLayerArray);

  statsEl.textContent = `選択: ${stats.total} 要素 (線分: ${stats.lines}, 円: ${stats.circles}, 円弧: ${stats.arcs}, ポリライン: ${stats.polylines})`;

  // エクスポートボタンの有効/無効
  const exportBtn = document.getElementById('exportDxfButton');
  if (exportBtn) {
    exportBtn.disabled = stats.total === 0;
  }
}

/**
 * 全レイヤーを選択
 */
function selectAllExportLayers() {
  const checkboxes = document.querySelectorAll('#dxf-export-layer-list input[type="checkbox"]');
  checkboxes.forEach((cb) => {
    cb.checked = true;
    selectedExportLayers.add(cb.dataset.layerName);
  });
  updateExportStats();
}

/**
 * 全レイヤーを解除
 */
function deselectAllExportLayers() {
  const checkboxes = document.querySelectorAll('#dxf-export-layer-list input[type="checkbox"]');
  checkboxes.forEach((cb) => {
    cb.checked = false;
    selectedExportLayers.delete(cb.dataset.layerName);
  });
  updateExportStats();
}

/**
 * DXFをエクスポート
 */
export function handleExportDxf() {
  const currentEntities = getCurrentEntities();
  const currentLayers = getCurrentLayers();
  if (!currentEntities || !currentLayers.length) {
    showWarning('エクスポートするDXFデータがありません');
    return;
  }

  const selectedLayerArray = Array.from(selectedExportLayers);
  if (selectedLayerArray.length === 0) {
    showWarning('エクスポートするレイヤーを選択してください');
    return;
  }

  const filenameInput = document.getElementById('dxfExportFilename');
  const defaultName = (() => {
    const fileA = getState('files.originalFileA');
    if (fileA?.name) return fileA.name.replace(/\.[^.]+$/, '');
    return 'export';
  })();
  const filename = filenameInput?.value?.trim() || defaultName;

  const success = exportDxf(currentEntities, currentLayers, selectedLayerArray, filename);

  if (success) {
    log.info('DXFエクスポート成功:', filename);
  }
}

/**
 * エクスポートUIの初期化
 */
export function initExportUI() {
  // 全選択ボタン
  const selectAllBtn = document.getElementById('selectAllExportLayers');
  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', selectAllExportLayers);
  }

  // 全解除ボタン
  const deselectAllBtn = document.getElementById('deselectAllExportLayers');
  if (deselectAllBtn) {
    deselectAllBtn.addEventListener('click', deselectAllExportLayers);
  }

  // エクスポートボタン
  const exportBtn = document.getElementById('exportDxfButton');
  if (exportBtn) {
    exportBtn.addEventListener('click', handleExportDxf);
  }

  log.info('エクスポートUI初期化完了');
}
