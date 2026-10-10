/**
 * @fileoverview 表示モード状態管理コントローラー
 *
 * モデルデータの保持と表示モード状態の初期化を管理します。
 * このモジュールは、モデルデータの参照を保持し、UIの表示モード設定を
 * displayModeManagerに同期する責務を持ちます。
 */

import { setState } from '../../data/state/globalState.js';
import { VIEW_MODE_CHECKBOX_IDS } from '../../config/uiElementConfig.js';
import { SOLID_ONLY_ELEMENTS } from '../../constants/elementTypes.js';
import { createLogger } from '../../utils/logger.js';
import { clearParseCache, setStateProvider, displayModeManager } from '../../viewer/index.js';
import {
  redrawElementByType,
  redrawBeamsForViewMode,
  redrawJointsForViewMode,
  redrawUndefinedElementsForViewMode,
} from './elementRedrawer.js';
import { registerElementsToRegistry } from '../../modelLoader/renderingOrchestrator.js';
import { setModelContext, clearModelContext } from './modelContext.js';

// ロガー
const log = createLogger('displayModeController');

// stbStructureReaderに状態プロバイダーを設定（依存性注入）
setStateProvider({ setState });

let initialDisplayModeRunId = 0;

/**
 * 状態管理モジュールを初期化
 * @param {Object} modelData - モデルデータ参照
 * @param {Function} scheduleRender - 再描画要求関数
 * @returns {Promise<{completed: boolean, aborted: boolean, errors: Array}>}
 */
export function initViewModes(modelData, scheduleRender) {
  // compareModels 側でキャッシュをクリアし、必要データをプリウォームした後に到達する。
  // ここで再度クリアすると初回ソリッド描画の高速化が失われる。

  setModelContext(modelData);

  log.info('[initViewModes] Initializing view modes with new model data');

  // UIのチェックボックスの状態を読み取り、displayModeManagerに反映
  syncDisplayModeFromUI();

  // 立体表示モードの要素を非同期で再描画
  return scheduleInitialDisplayModes(scheduleRender);
}

/**
 * 表示設定の変更（トグル等）に伴い、現在のモデルデータで全要素を再描画する。
 * モデルコンテキストは既に設定済みである前提（比較後に呼ばれる）。
 * @param {Function} scheduleRender - 再描画要求関数
 * @returns {Promise<{completed: boolean, aborted: boolean, errors: Array}>}
 */
export function redrawAllElementsForViewMode(scheduleRender) {
  log.info('[redrawAllElementsForViewMode] Redrawing all elements after display setting change');
  return scheduleInitialDisplayModes(scheduleRender);
}

/**
 * 表示モード管理をリセット
 */
export function resetViewModes() {
  log.info('[resetViewModes] Resetting view modes');
  initialDisplayModeRunId += 1;
  clearParseCache();
  clearModelContext();
}

/**
 * UIのチェックボックスの状態をdisplayModeManagerに同期
 */
export function syncDisplayModeFromUI() {
  // 設定ファイルから要素タイプとチェックボックスIDのマッピングを使用
  Object.entries(VIEW_MODE_CHECKBOX_IDS).forEach(([type, id]) => {
    const checkbox = document.getElementById(id);
    if (checkbox) {
      // チェックされていれば'solid'、そうでなければ'line'
      const mode = checkbox.checked ? 'solid' : 'line';
      displayModeManager.setDisplayMode(type, mode);
      log.debug(`Synced ${type} display mode from UI: ${mode}`);
    }
  });
}

/**
 * 初期表示モード適用をUIブロックしないように分割実行する
 * @param {Function} scheduleRender - 再描画要求関数
 */
function scheduleInitialDisplayModes(scheduleRender) {
  const runId = ++initialDisplayModeRunId;

  // オーケストレーターで常にスキップされる要素タイプ（モードに関係なく再描画）
  const alwaysRedrawTypes = new Set(['Slab', 'Wall', 'FrameDampingDevice']);

  const typesToRedraw = Object.keys(VIEW_MODE_CHECKBOX_IDS).filter(
    (type) => alwaysRedrawTypes.has(type) || displayModeManager.isSolidMode(type),
  );

  for (const solidOnlyType of SOLID_ONLY_ELEMENTS) {
    if (!typesToRedraw.includes(solidOnlyType)) {
      typesToRedraw.push(solidOnlyType);
    }
  }

  const beamOrGirderNeedsRedraw =
    typesToRedraw.includes('Beam') || typesToRedraw.includes('Girder');
  const jointNeedsRedraw = typesToRedraw.includes('Joint');
  const specialTypes = new Set(['Beam', 'Girder', 'Joint']);
  const queue = typesToRedraw.filter((type) => !specialTypes.has(type));

  if (beamOrGirderNeedsRedraw) {
    queue.push('__BeamGirder__');
  }
  if (jointNeedsRedraw) {
    queue.push('__Joint__');
  }
  queue.push('__Undefined__');

  log.info(`[scheduleInitialDisplayModes] Scheduling ${queue.length} redraw task(s)`);

  return new Promise((resolve) => {
    const errors = [];
    let settled = false;

    const settle = (result = {}) => {
      if (settled) return;
      settled = true;
      resolve({
        completed: true,
        aborted: false,
        errors,
        ...result,
      });
    };

    const yieldToEventLoop = () => new Promise((innerResolve) => setTimeout(innerResolve, 0));

    const processBatch = async () => {
      let processedTotal = 0;

      while (queue.length > 0) {
        if (runId !== initialDisplayModeRunId) {
          log.debug('[scheduleInitialDisplayModes] Aborted stale redraw run');
          settle({ completed: false, aborted: true });
          return;
        }

        const next = queue.shift();

        try {
          if (next === '__BeamGirder__') {
            log.debug('[scheduleInitialDisplayModes] Redrawing: Beam/Girder');
            redrawBeamsForViewMode(null, false);
          } else if (next === '__Joint__') {
            log.debug('[scheduleInitialDisplayModes] Redrawing: Joint');
            redrawJointsForViewMode(null);
          } else if (next === '__Undefined__') {
            log.debug('[scheduleInitialDisplayModes] Redrawing: Undefined');
            redrawUndefinedElementsForViewMode(null);
          } else {
            log.debug(`[scheduleInitialDisplayModes] Redrawing: ${next}`);
            redrawElementByType(next, null, false, false);
          }
        } catch (error) {
          const elementType =
            next === '__BeamGirder__'
              ? 'Beam/Girder'
              : next === '__Joint__'
                ? 'Joint'
                : next === '__Undefined__'
                  ? 'Undefined'
                  : next;
          errors.push({ elementType, message: error.message });
          log.error(`[scheduleInitialDisplayModes] Failed to redraw ${elementType}:`, error);
        }

        processedTotal++;

        if (scheduleRender) {
          scheduleRender();
        }
        await yieldToEventLoop();
      }

      registerElementsToRegistry();

      import('../../colorModes/index.js')
        .then(({ updateElementsForColorMode }) => {
          updateElementsForColorMode();
        })
        .catch((err) => {
          log.error('[scheduleInitialDisplayModes] Failed to apply color mode after redraw:', err);
        });

      if (scheduleRender) {
        scheduleRender();
      }
      log.info(
        `[scheduleInitialDisplayModes] Initial redraw completed: ${processedTotal} types, ${errors.length} error(s)`,
      );
      settle();
    };

    processBatch();
  });
}
