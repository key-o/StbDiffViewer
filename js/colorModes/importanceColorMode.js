/**
 * @fileoverview 驥崎ｦ∝ｺｦ蛻･濶ｲ莉倥￠繝｢繝ｼ繝・
 *
 * 螻樊ｧ縺ｮ驥崎ｦ∝ｺｦ繝ｬ繝吶Ν縺ｫ蝓ｺ縺･縺・※隕∫ｴ繧定牡蛻・￠縺吶ｋ繝｢繝ｼ繝峨ｒ謠蝉ｾ帙＠縺ｾ縺吶・
 *
 * @module colorModes/importanceColorMode
 */

import { getState } from '../data/state/globalState.js';
import { UI_TIMING } from '../config/uiTimingConfig.js';
import { IMPORTANCE_LEVELS } from '../constants/importanceLevels.js';
import { eventBus, ImportanceEvents, ComparisonEvents } from '../data/events/index.js';
import {
  colorManager,
  applyImportanceColorMode,
  elementGroups as viewerElementGroups,
  getEffectiveImportanceLevelForObject,
  clearImportanceMaterialCache,
  applyImportanceColorModeBatch,
  getImportanceRenderingStats,
} from '../viewer/index.js';
import { scheduleRender } from '../utils/renderScheduler.js';
import { createLogger } from '../utils/logger.js';
import { ViewEvents } from '../data/events/index.js';
import { getCurrentColorMode, COLOR_MODES } from './colorModeState.js';
import { collectElementGroupObjects } from '../utils/elementGroupBatchRunner.js';

const log = createLogger('colorModes:importanceColorMode');
const IMPORTANCE_DISPLAY_FILTERS = {
  violation: true,
  notApplicable: true,
};

function getImportanceCategoryForObject(object) {
  const effectiveLevel = getEffectiveImportanceLevelForObject(object);
  return effectiveLevel === IMPORTANCE_LEVELS.REQUIRED ? 'violation' : 'notApplicable';
}

function shouldImportanceCategoryBeVisible(category) {
  return category === 'violation'
    ? IMPORTANCE_DISPLAY_FILTERS.violation
    : IMPORTANCE_DISPLAY_FILTERS.notApplicable;
}

function updateImportanceVisibilitySummary(total, visible) {
  const visibleCount = document.getElementById('importance-visible-count');
  const totalCount = document.getElementById('importance-total-count');
  if (visibleCount) visibleCount.textContent = visible;
  if (totalCount) totalCount.textContent = total;
}

export function applyImportanceVisibilityFilterToAll() {
  const elementGroups = getState('elementGroups') || viewerElementGroups;
  if (!elementGroups || typeof elementGroups !== 'object') {
    return;
  }

  let totalElements = 0;
  let visibleElements = 0;
  const meshes = collectElementGroupObjects(elementGroups, (object) => object.isMesh);

  meshes.forEach((object) => {
    totalElements++;
    const category = getImportanceCategoryForObject(object);
    const shouldBeVisible = shouldImportanceCategoryBeVisible(category);
    object.visible = shouldBeVisible;
    if (shouldBeVisible) {
      visibleElements++;
    }
  });

  updateImportanceVisibilitySummary(totalElements, visibleElements);
  scheduleRender();
}

/**
 * 驥崎ｦ∝ｺｦ濶ｲ險ｭ螳啅I繧貞・譛溷喧
 */
export function initializeImportanceColorControls() {
  const container = document.getElementById('importance-color-controls');
  if (!container) return;

  // 驥崎ｦ∝ｺｦ險ｭ螳壹ｒ繧､繝ｳ繝昴・繝医＠縺ｦ濶ｲ險ｭ螳壹さ繝ｳ繝医Ο繝ｼ繝ｫ繧堤函謌・
  Promise.all([
    // eslint-disable-next-line import/no-restricted-paths
    import('../app/importanceManager.js'),
    import('../config/importanceConfigLoader.js'),
    import('../config/colorConfig.js'),
  ]).then(
    ([
      { getImportanceManager },
      { AVAILABLE_CONFIGS },
      { IMPORTANCE_COLORS: _IMPORTANCE_COLORS },
    ]) => {
      container.innerHTML = '';

      // === MVD險ｭ螳壹そ繝ｬ繧ｯ繧ｿ繝ｼ ===
      const configSelectorContainer = document.createElement('div');
      configSelectorContainer.className = 'config-selector-container';
      configSelectorContainer.style.cssText =
        'margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid #ddd;';

      const configLabel = document.createElement('label');
      configLabel.textContent = 'MVD險ｭ螳・';
      configLabel.style.cssText =
        'display: block; font-size: var(--font-size-sm); margin-bottom: 5px; color: #666;';
      configSelectorContainer.appendChild(configLabel);

      const configSelect = document.createElement('select');
      configSelect.id = 'mvd-config-selector';
      configSelect.style.cssText =
        'width: 100%; padding: 6px 8px; border: 1px solid #ccc; border-radius: 4px; font-size: var(--font-size-sm);';

      // 繧ｪ繝励す繝ｧ繝ｳ繧定ｿｽ蜉
      const defaultOption = document.createElement('option');
      defaultOption.value = '';
      defaultOption.textContent = '---';
      configSelect.appendChild(defaultOption);

      AVAILABLE_CONFIGS.forEach((config) => {
        const option = document.createElement('option');
        option.value = config.id;
        option.textContent = config.name;
        option.title = config.description;
        configSelect.appendChild(option);
      });

      // 險ｭ螳壼､画峩繧､繝吶Φ繝・
      configSelect.addEventListener('change', async (e) => {
        const configId = e.target.value;
        const manager = getImportanceManager();

        if (configId) {
          const success = await manager.loadExternalConfig(configId);
          if (success) {
            window.dispatchEvent(new CustomEvent('importanceConfigChanged'));
          }
        } else {
          manager.resetToDefaults();
          await manager.initialize();
          window.dispatchEvent(new CustomEvent('importanceConfigChanged'));
        }
      });

      configSelectorContainer.appendChild(configSelect);
      container.appendChild(configSelectorContainer);

      // 驕募渚/蟇ｾ雎｡螟悶・2繧ｫ繝・ざ繝ｪ縺ｧ濶ｲ險ｭ螳壹ｒ陦ｨ遉ｺ・磯ｫ・荳ｭ/菴弱・蛹ｺ蛻・↑縺暦ｼ・
      const colorCategories = [
        {
          id: 'violation',
          name: '驕募渚',
          level: IMPORTANCE_LEVELS.REQUIRED,
          linkedLevels: [
            IMPORTANCE_LEVELS.REQUIRED,
            IMPORTANCE_LEVELS.OPTIONAL,
            IMPORTANCE_LEVELS.UNNECESSARY,
          ],
        },
        {
          id: 'notApplicable',
          name: 'Not applicable',
          level: IMPORTANCE_LEVELS.NOT_APPLICABLE,
          linkedLevels: [IMPORTANCE_LEVELS.NOT_APPLICABLE],
        },
      ];

      colorCategories.forEach(({ id, name, level, linkedLevels }) => {
        const color = colorManager.getImportanceColor(level);
        const filterKey = id === 'violation' ? 'violation' : 'notApplicable';

        const item = document.createElement('div');
        item.className = 'legend-item diff-filter-item';
        item.innerHTML = `
          <input
            type="checkbox"
            id="importance-filter-${id}"
            class="diff-filter-checkbox"
            ${IMPORTANCE_DISPLAY_FILTERS[filterKey] ? 'checked' : ''}
            title="${name}繧定｡ｨ遉ｺ"
          />
          <input
            type="color"
            id="importance-${id}-color"
            value="${color}"
            class="legend-color-box"
            title="${name}縺ｮ濶ｲ繧貞､画峩"
          />
          <span class="legend-label">${name}</span>
        `;

        container.appendChild(item);

        const colorInput = item.querySelector(`#importance-${id}-color`);
        const visibilityCheckbox = item.querySelector(`#importance-filter-${id}`);

        // 濶ｲ螟画峩譎ゅ√Μ繝ｳ繧ｯ縺輔ｌ縺溷・繝ｬ繝吶Ν繧剃ｸ諡ｬ譖ｴ譁ｰ
        const handleColorChange = (e) => {
          const newColor = e.target.value;
          linkedLevels.forEach((l) => updateImportanceColor(l, newColor));
        };

        colorInput.addEventListener('change', handleColorChange);
        colorInput.addEventListener('input', handleColorChange);

        visibilityCheckbox?.addEventListener('change', (e) => {
          IMPORTANCE_DISPLAY_FILTERS[filterKey] = e.target.checked;
          if (getCurrentColorMode() === COLOR_MODES.IMPORTANCE) {
            applyImportanceVisibilityFilterToAll();
          }
        });

        item.addEventListener('click', (e) => {
          if (e.target.type === 'checkbox' || e.target.type === 'color') return;
          if (!visibilityCheckbox) return;
          visibilityCheckbox.checked = !visibilityCheckbox.checked;
          visibilityCheckbox.dispatchEvent(new Event('change'));
        });
      });

      // 繝ｪ繧ｻ繝・ヨ繝懊ち繝ｳ繧定ｿｽ蜉
      const resetButton = document.createElement('button');
      resetButton.type = 'button';
      resetButton.className = 'btn-reset';
      resetButton.textContent = 'Reset';
      resetButton.setAttribute('aria-label', 'Reset importance colors');
      resetButton.title = 'Reset importance colors to defaults';
      resetButton.style.marginTop = '10px';
      resetButton.style.width = '100%';
      resetButton.addEventListener('click', () => resetImportanceColors());
      container.appendChild(resetButton);

      const summary = document.createElement('div');
      summary.className = 'diff-filter-summary';
      summary.style.marginTop = '10px';
      summary.innerHTML =
        '陦ｨ遉ｺ荳ｭ: <strong id="importance-visible-count">0</strong> / <span id="importance-total-count">0</span>';
      container.appendChild(summary);

      if (getCurrentColorMode() === COLOR_MODES.IMPORTANCE) {
        applyImportanceVisibilityFilterToAll();
      } else {
        updateImportanceVisibilitySummary(0, 0);
      }
    },
  );
}

/**
 * 驥崎ｦ∝ｺｦ濶ｲ繧呈峩譁ｰ
 * @param {string} importanceLevel - 驥崎ｦ∝ｺｦ繝ｬ繝吶Ν
 * @param {string} color - 譁ｰ縺励＞濶ｲ
 */
function updateImportanceColor(importanceLevel, color) {
  // ColorManager繧剃ｽｿ逕ｨ縺励※濶ｲ繧呈峩譁ｰ
  colorManager.setImportanceColor(importanceLevel, color);

  // 驥崎ｦ∝ｺｦ繝｢繝ｼ繝峨′譛牙柑縺ｪ蝣ｴ蜷医・蜊ｳ蠎ｧ縺ｫ驕ｩ逕ｨ
  if (getCurrentColorMode() === COLOR_MODES.IMPORTANCE) {
    clearImportanceMaterialCache();
    eventBus.emit(ViewEvents.COLOR_MODE_REFRESH_REQUESTED);
  }
}

/**
 * 驥崎ｦ∝ｺｦ濶ｲ險ｭ螳壹ｒ繝・ヵ繧ｩ繝ｫ繝医↓繝ｪ繧ｻ繝・ヨ
 */
export function resetImportanceColors() {
  import('../config/colorConfig.js').then(({ IMPORTANCE_COLORS }) => {
    // ColorManager繧剃ｽｿ逕ｨ縺励※濶ｲ繧偵Μ繧ｻ繝・ヨ・亥腰荳繝・・繧ｿ繧ｽ繝ｼ繧ｹ・・
    Object.entries(IMPORTANCE_COLORS).forEach(([level, color]) => {
      colorManager.setImportanceColor(level, color);
    });

    // UI縺ｮ濶ｲ險ｭ螳壹さ繝ｳ繝医Ο繝ｼ繝ｫ繧呈峩譁ｰ
    initializeImportanceColorControls();

    // 驥崎ｦ∝ｺｦ繝｢繝ｼ繝峨′譛牙柑縺ｪ蝣ｴ蜷医・蜊ｳ蠎ｧ縺ｫ驕ｩ逕ｨ
    if (getCurrentColorMode() === COLOR_MODES.IMPORTANCE) {
      clearImportanceMaterialCache();
      eventBus.emit(ViewEvents.COLOR_MODE_REFRESH_REQUESTED);
    }
  });
}

/**
 * 驥崎ｦ∝ｺｦ螟画峩繧､繝吶Φ繝医Μ繧ｹ繝翫・繧定ｨｭ螳・
 */
export function setupImportanceChangeListeners() {
  // 驥崎ｦ∝ｺｦ險ｭ螳壼､画峩譎ゅ・繧ｰ繝ｭ繝ｼ繝舌Ν繧､繝吶Φ繝医Μ繧ｹ繝翫・・・ventBus邨檎罰・・
  eventBus.on(ImportanceEvents.SETTINGS_CHANGED, (_data) => {
    if (getCurrentColorMode() === COLOR_MODES.IMPORTANCE) {
      // 蟆代＠驕・ｻｶ縺輔○縺ｦ螳溯｡鯉ｼ郁ｦ∫ｴ縺ｮ驥崎ｦ∝ｺｦ繝・・繧ｿ譖ｴ譁ｰ繧貞ｾ・▽・・
      setTimeout(() => {
        applyImportanceColorModeToAll();

        // UI螻､縺ｫ螟画峩繧帝夂衍・・ventBus邨檎罰縺ｧ繝ｬ繧､繝､繝ｼ驕募渚隗｣豸茨ｼ・
        eventBus.emit(ViewEvents.COLOR_MODE_CHANGED, {
          mode: 'importance',
          trigger: 'settingsChanged',
        });

        // 蜀肴緒逕ｻ繧偵Μ繧ｯ繧ｨ繧ｹ繝・
        scheduleRender();
      }, UI_TIMING.COLOR_MODE_APPLY_DELAY_MS);
    }
  });

  // 驥崎ｦ∝ｺｦ繝輔ぅ繝ｫ繧ｿ螟画峩譎ゅ・繧､繝吶Φ繝医Μ繧ｹ繝翫・
  eventBus.on(ImportanceEvents.FILTER_CHANGED, (_data) => {
    // 繝輔ぅ繝ｫ繧ｿ螟画峩縺ｯ陦ｨ遉ｺ繝ｻ髱櫁｡ｨ遉ｺ縺ｮ蛻・ｊ譖ｿ縺医↑縺ｮ縺ｧ縲∬牡蛻・￠縺ｮ蜀埼←逕ｨ縺ｯ荳崎ｦ・
  });

  // 繝｢繝・Ν豈碑ｼ・ｮ御ｺ・凾縺ｮ繧､繝吶Φ繝医Μ繧ｹ繝翫・
  eventBus.on(ComparisonEvents.UPDATE_STATISTICS, (_data) => {
    if (getCurrentColorMode() === COLOR_MODES.IMPORTANCE) {
      setTimeout(() => {
        applyImportanceColorModeToAll();

        scheduleRender();
      }, UI_TIMING.IMPORTANCE_COLOR_APPLY_DELAY_MS);
    }
  });
}

/**
 * 蜈ｨ隕∫ｴ縺ｫ驥崎ｦ∝ｺｦ濶ｲ蛻・￠繧帝←逕ｨ
 */
export function applyImportanceColorModeToAll() {
  const elementGroups = getState('elementGroups') || viewerElementGroups;
  if (!elementGroups || typeof elementGroups !== 'object') {
    log.warn('[ImportanceColorMode] elementGroups not found in global state');
    return;
  }

  // 蜈ｨ繧ｪ繝悶ず繧ｧ繧ｯ繝医ｒ蜿朱寔
  const groups = Array.isArray(elementGroups) ? elementGroups : Object.values(elementGroups);

  // 繧ｰ繝ｫ繝ｼ繝励′遨ｺ縺ｮ蝣ｴ蜷医・隴ｦ蜻翫ｒ蜃ｺ縺励※邨ゆｺ・
  if (groups.length === 0 || groups.every((g) => !g || (g.children && g.children.length === 0))) {
    log.warn(
      '[ImportanceColorMode] No element groups or empty groups - model may not be loaded yet',
    );
    return;
  }

  const allObjects = collectElementGroupObjects(elementGroups, (object) => object.isMesh);

  // 繧ｪ繝悶ず繧ｧ繧ｯ繝域焚縺ｫ蠢懊§縺ｦ蜃ｦ逅・婿豕輔ｒ驕ｸ謚・
  const objectCount = allObjects.length;

  if (objectCount === 0) {
    log.warn(
      '[ImportanceColorMode] No meshes found in elementGroups - model may not be loaded yet',
    );
    return;
  }

  log.info(`[ImportanceColorMode] Applying importance colors to ${objectCount} objects`);
  const useBatchProcessing = objectCount > 200;

  if (useBatchProcessing) {
    // 繝舌ャ繝∝・逅・ｒ菴ｿ逕ｨ
    const batchOptions = {
      batchSize: Math.max(50, Math.min(200, Math.floor(objectCount / 10))),
      delay: 5,
    };

    applyImportanceVisibilityFilterToAll();
    applyImportanceColorModeBatch(allObjects, batchOptions);
  } else {
    // 騾壼ｸｸ蜃ｦ逅・
    allObjects.forEach((object) => {
      applyImportanceColorMode(object);
    });

    applyImportanceVisibilityFilterToAll();
  }
}

/**
 * 繝代ヵ繧ｩ繝ｼ繝槭Φ繧ｹ邨ｱ險医ｒ陦ｨ遉ｺ
 */
export function showImportancePerformanceStats() {
  const stats = getImportanceRenderingStats();
  const elementGroups = getState('elementGroups');

  const totalObjects = collectElementGroupObjects(elementGroups, (object) => object.isMesh).length;

  const perfInfo = {
    totalObjects,
    ...stats,
    currentColorMode: getCurrentColorMode(),
    isImportanceMode: getCurrentColorMode() === COLOR_MODES.IMPORTANCE,
  };

  return perfInfo;
}
