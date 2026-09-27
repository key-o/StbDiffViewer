/**
 * @fileoverview 統合システムの初期化（重要度、アウトライン、差分）
 */

import { createLogger } from '../../utils/logger.js';
import { setState } from '../../data/state/globalState.js';
import { initializeImportancePanel } from '../../ui/panels/importancePanel.js';
import { initializeQuantitySummaryPanel } from '../../ui/panels/quantitySummary/QuantitySummaryPanel.js';
import { initializeImportanceFilterSystem } from '../../ui/panels/importanceFilter.js';
import { initializeImportanceStatistics } from '../../ui/panels/statistics.js';
import { initializeBulkImportanceOperations } from '../../ui/panels/bulkImportanceOperations.js';
import { initializeDiffListPanel } from '../../ui/panels/diffList.js';
import {
  initializeDiffStatusFilterSystem,
  globalDiffStatusFilter,
} from '../../ui/panels/diffStatusFilter.js';
import { initializeDiffStatusPanel } from '../../ui/panels/diffStatusPanel.js';
import { eventBus } from '../../data/events/eventBus.js';
import { EventTypes, ViewEvents } from '../../constants/eventTypes.js';
import { getState } from '../../data/state/globalState.js';
import { buildMemberDataFromDocument, updateLoadCaseSelector } from './initializationUtils.js';
import {
  initializeOutlineSystem,
  getLoadDisplayManager,
  getModelBounds,
} from '../../viewer/index.js';
import { initEditComparisonSync } from '../controllers/editComparisonSyncController.js';
import { initEditGeometrySync } from '../controllers/editGeometrySyncController.js';
import {
  initSemanticMoveGizmoInteraction,
  refreshSemanticMoveGizmo,
} from '../controllers/interaction/semanticMoveGizmoInteraction.js';
import { initSemanticGripInteraction } from '../controllers/interaction/semanticGripInteraction.js';
import { initSelectionRenderableLifecycle } from '../controllers/selectionRenderableLifecycleController.js';
import { initWorkingComparisonVisualLifecycle } from '../controllers/workingComparisonVisualLifecycleController.js';
import { initWorkingFrameDampingDeviceLifecycle } from '../controllers/workingFrameDampingDeviceLifecycleController.js';
import { initWorkingAddLabelLifecycle } from '../controllers/workingAddLabelLifecycleController.js';
import { initWorkingWallOpeningOutlineLifecycle } from '../controllers/workingWallOpeningOutlineLifecycleController.js';

const log = createLogger('systemInitializer');

/**
 * 統合システムを初期化（重要度、アウトライン、差分）
 */
export function initializeIntegratedSystems() {
  // 重要度統合機能の初期化
  initializeImportancePanel(document.body);

  // 派生数量の単一モデル集計パネル（Issue #287 Phase 2）
  const quantitySummaryPanel = initializeQuantitySummaryPanel(document.body);

  // 重要度関連システムの初期化
  const { filter, indicator } = initializeImportanceFilterSystem(document.body);
  const statistics = initializeImportanceStatistics(document.body);
  const bulkOperations = initializeBulkImportanceOperations(document.body);

  // アウトラインシステム初期化
  initializeOutlineSystem();

  // 差分一覧パネルの初期化
  const diffListPanel = initializeDiffListPanel(document.body);

  // 差分ステータスフィルタシステムの初期化
  const diffStatusFilterSystem = initializeDiffStatusFilterSystem();
  const diffStatusPanel = initializeDiffStatusPanel();

  // グローバル状態に登録
  setState('importanceSystem.filter', filter);
  setState('importanceSystem.statistics', statistics);
  setState('importanceSystem.bulkOperations', bulkOperations);
  setState('importanceSystem.filterIndicator', indicator);
  setState('diffListPanel', diffListPanel);
  setState('diffStatusFilter', diffStatusFilterSystem.filter);
  setState('diffStatusPanel', diffStatusPanel);
  setState('quantitySummaryPanel', quantitySummaryPanel);

  // 編集→再比較同期コントローラーの初期化
  initEditComparisonSync();

  // 編集→3D再描画コントローラーの初期化
  initEditGeometrySync();

  // FrameDampingDevice の非solid polygonは汎用2節点line経路に入れず、
  // StbNodeIdOrder / 専用offsetからID-localに同期する。add-label より先に購読して
  // structural add の microtask で renderable 挿入→label生成の順序を保証する。
  initWorkingFrameDampingDeviceLifecycle();

  // structural add の scene 挿入後、真の Working add は onlyA、Undo/Discard で復元した
  // source 要素は最後の明示比較 snapshot へ visual provenance を戻す。
  initWorkingComparisonVisualLifecycle();

  // structural add の targeted renderable 挿入後、現在ラベル表示中の要素だけラベルを補完する。
  // comparison visual lifecycle より後に microtask 実行されるため、復元要素の modelSource も参照できる。
  initWorkingAddLabelLifecycle();

  // 非solid Wall/ShearWall の開口輪郭も Working Document の最新 wall/opening から局所再生成する。
  // Geometry/comparison visual sync 後の scene を対象にするため、こちらも microtask 後段で実行する。
  initWorkingWallOpeningOutlineLifecycle();

  // Working Document が有効な場合のみ X/Y/Z MOVE gizmo を表示する。
  // TransformControls は proxy への入力と preview に限定し、mouseup で semantic MOVE を確定する。
  // Grip より先に初期化し、gizmo drag 後の mousedown/click を capture phase で先取りする。
  initSemanticMoveGizmoInteraction();

  // Perspective / Orthographic 切替では active camera の Object 自体が入れ替わるため、
  // TransformControls が古い camera を保持しないよう gizmo の camera / anchor を再同期する。
  eventBus.on(ViewEvents.CAMERA_MODE_CHANGED, () => {
    refreshSemanticMoveGizmo({ force: true });
  });

  // Working Document が有効な場合のみ Semantic Grip を表示・操作する。
  // capture phase で Grip drag を先取りし、通常選択・カメラ操作と競合させない。
  initSemanticGripInteraction();

  // structural delete 後に scene から消えた selected Object3D を残さない。
  // replacement は同一task内で semantic selection へ rebind されるため維持する。
  initSelectionRenderableLifecycle();

  log.info('重要度統合システムが初期化されました');
  log.info('差分ステータスフィルタが初期化されました');

  // テスト用グローバル関数
  window.toggleImportanceStatistics = () => statistics.toggle();
  window.toggleBulkOperations = () => bulkOperations.toggle();
  window.toggleImportanceFilter = () => filter.setEnabled(!filter.isEnabled);
  window.toggleDiffList = () => diffListPanel.toggle();
  window.toggleDiffStatusPanel = () => diffStatusPanel.toggle();
  window.toggleQuantitySummary = () => quantitySummaryPanel.toggle();
  window.diffStatusFilter = globalDiffStatusFilter; // デバッグ用
}

/**
 * 荷重表示のイベントリスナーをセットアップ
 */
export function setupLoadDisplayEventListeners() {
  // 比較完了イベントをリスンして荷重データを設定
  eventBus.on(EventTypes.Comparison.COMPLETED, () => {
    updateLoadDisplayData();
  });

  log.info('荷重表示イベントリスナーをセットアップしました');
}

/**
 * 荷重表示データを更新
 * @private
 */
function updateLoadDisplayData() {
  try {
    const loadManager = getLoadDisplayManager();
    if (!loadManager) {
      log.warn('LoadDisplayManagerが初期化されていません');
      return;
    }

    // グローバル状態から荷重データを取得
    const calDataA = getState('models.calDataA');
    const calDataB = getState('models.calDataB');
    const nodeMapA = getState('models.nodeMapA');
    const nodeMapB = getState('models.nodeMapB');
    const documentA = getState('models.documentA');
    const documentB = getState('models.documentB');

    // 荷重データがある方を使用（優先：モデルA）
    const calData = calDataA || calDataB;
    const nodeMap = calDataA ? nodeMapA : nodeMapB;
    const modelDocument = calDataA ? documentA : documentB;

    // デバッグ情報を出力
    log.debug('荷重データ取得:', {
      hasCalDataA: !!calDataA,
      hasCalDataB: !!calDataB,
      loadCasesA: calDataA?.loadCases?.length || 0,
      loadCasesB: calDataB?.loadCases?.length || 0,
      memberLoadsA: calDataA?.memberLoads?.length || 0,
      memberLoadsB: calDataB?.memberLoads?.length || 0,
    });

    if (!calData) {
      log.warn('荷重データ（StbCalData）がSTBファイルに含まれていません');
      log.info('STBファイルに<StbCalData>セクションがあることを確認してください');
      updateLoadCaseSelector([]);
      return;
    }

    const memberData = buildMemberDataFromDocument(modelDocument);
    loadManager.setData(calData, nodeMap, memberData);

    const bounds = getModelBounds();
    if (bounds && !bounds.isEmpty()) {
      loadManager.computeAutoScale(bounds);
      if (loadManager._isVisible) {
        loadManager.updateDisplay();
        if (typeof window.requestRender === 'function') {
          window.requestRender();
        }
      }
    }

    updateLoadCaseSelector(calData.loadCases || []);

    log.info(
      `荷重データを設定しました: ${calData.memberLoads?.length || 0}部材荷重, ${calData.loadCases?.length || 0}荷重ケース`,
    );
  } catch (error) {
    log.error('荷重データの更新でエラーが発生しました:', error);
  }
}
