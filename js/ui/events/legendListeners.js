/**
 * @fileoverview 凡例関連イベントリスナー
 *
 * 凡例パネルの表示/非表示と内容更新を処理するイベントリスナー。
 *
 * @module ui/events/legendListeners
 */

// --- UI Element Reference ---

import { createLogger } from '../../utils/logger.js';

const log = createLogger('ui:events:legendListeners');
const legendPanel = document.getElementById('legendPanel');

/** 全凡例に共通の操作方法セクション */
const CONTROLS_LEGEND_HTML = `
      <hr />
      <div class="legend-item">
        <span><b>操作方法:</b></span>
      </div>
      <div class="legend-item">
        <span>回転: 左ドラッグ</span>
      </div>
      <div class="legend-item">
        <span>平行移動: 右ドラッグ</span>
      </div>
      <div class="legend-item">
        <span>ズーム: ホイール</span>
      </div>
    `;

/**
 * 色見本付きの凡例項目を生成する
 * @param {string} color - 見本の色
 * @param {string} label - 項目名
 * @returns {string} 凡例項目のHTML
 */
function legendItem(color, label) {
  return `
      <div class="legend-item">
        <span class="legend-color" style="background-color: ${color};"></span>
        <span>${label}</span>
      </div>`;
}

/**
 * Toggle legend visibility
 */
export function toggleLegend() {
  if (!legendPanel) {
    log.warn('[UI] 凡例: パネル要素が見つかりません');
    return;
  }

  const isCurrentlyVisible = !legendPanel.classList.contains('hidden');

  if (isCurrentlyVisible) {
    legendPanel.classList.add('hidden');
    log.info('[Event] 凡例: 非表示');
  } else {
    legendPanel.classList.remove('hidden');
    updateLegendContent(); // 凡例内容を更新
    log.info('[Event] 凡例: 表示');
  }

  // Update toggle button text if it exists
  const toggleBtn = document.getElementById('toggleLegendBtn');
  if (toggleBtn) {
    toggleBtn.textContent = isCurrentlyVisible ? '凡例を表示' : '凡例を非表示';
  }
}

/**
 * 色分けモードに応じて凡例内容を更新
 */
export function updateLegendContent() {
  if (!legendPanel) return;

  // 現在の色分けモードを取得
  import('../../colorModes/index.js').then(({ getCurrentColorMode, COLOR_MODES }) => {
    const currentMode = getCurrentColorMode();
    const legendContent = legendPanel.querySelector('.legend-content');

    if (!legendContent) return;

    switch (currentMode) {
      case COLOR_MODES.IMPORTANCE:
        updateImportanceLegend(legendContent);
        break;
      case COLOR_MODES.ELEMENT:
        updateElementLegend(legendContent);
        break;
      case COLOR_MODES.SCHEMA:
        updateSchemaLegend(legendContent);
        break;
      case COLOR_MODES.DIFF:
      default:
        updateDiffLegend(legendContent);
        break;
    }
  });
}

/**
 * 重要度別凡例を生成
 */
function updateImportanceLegend(container) {
  import('../../constants/importanceLevels.js').then(
    ({ IMPORTANCE_LEVELS, IMPORTANCE_COLOR_CATEGORY_NAMES }) => {
      // ColorManager経由で色を取得（単一データソース）
      import('../../viewer/rendering/colorManager.js').then(({ colorManager }) => {
        // 違反/対象外の2カテゴリで凡例を表示
        const categories = [
          { name: IMPORTANCE_COLOR_CATEGORY_NAMES.violation, level: IMPORTANCE_LEVELS.REQUIRED },
          {
            name: IMPORTANCE_COLOR_CATEGORY_NAMES.notApplicable,
            level: IMPORTANCE_LEVELS.NOT_APPLICABLE,
          },
        ];
        const html = `
        <div class="panel-header">重要度別凡例</div>
        ${categories
          .map(({ name, level }) => legendItem(colorManager.getImportanceColor(level), name))
          .join('')}
        ${CONTROLS_LEGEND_HTML}
      `;
        container.innerHTML = html;
      });
    },
  );
}

/**
 * 部材別凡例を生成
 */
function updateElementLegend(container) {
  import('../../colorModes/index.js').then(({ getElementColors }) => {
    const elementColors = getElementColors();
    const html = `
      <div class="panel-header">部材別凡例</div>
      ${Object.entries(elementColors)
        .map(([type, color]) => legendItem(color, type))
        .join('')}
      ${CONTROLS_LEGEND_HTML}
    `;
    container.innerHTML = html;
  });
}

/**
 * スキーマエラー凡例を生成
 */
function updateSchemaLegend(container) {
  import('../../colorModes/index.js').then(({ getSchemaColors }) => {
    const schemaColors = getSchemaColors();
    const html = `
      <div class="panel-header">スキーマ検証凡例</div>
      ${legendItem(schemaColors.valid, '正常要素')}
      ${legendItem(schemaColors.error, 'エラー要素')}
      ${CONTROLS_LEGEND_HTML}
    `;
    container.innerHTML = html;
  });
}

/**
 * 差分表示凡例を生成（デフォルト）
 */
function updateDiffLegend(container) {
  // ColorManager経由で色を取得（単一データソース）
  import('../../viewer/rendering/colorManager.js').then(({ colorManager }) => {
    const html = `
      <div class="panel-header">凡例</div>
      ${legendItem(colorManager.getDiffColor('matched'), '一致要素')}
      ${legendItem(colorManager.getDiffColor('onlyA'), 'モデルAのみ')}
      ${legendItem(colorManager.getDiffColor('onlyB'), 'モデルBのみ')}
      ${CONTROLS_LEGEND_HTML}
    `;
    container.innerHTML = html;
  });
}

/**
 * Get legend panel status
 * @returns {boolean} Whether legend panel exists
 */
export function hasLegendPanel() {
  return !!legendPanel;
}
