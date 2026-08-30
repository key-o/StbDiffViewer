/**
 * @fileoverview 差分サマリーのフィルタ操作とエントリ/イベント配線
 *
 * サマリー内のクリック→差分フィルタ適用の委譲ハンドラ登録、差分結果サマリーの
 * 更新・再描画（ボタン類のイベント配線を含む）、比較結果更新イベント（EventBus経由）の
 * 購読を担い、公開API setupDiffSummaryEventListeners を提供します。
 */

import { eventBus, ComparisonEvents, DiffStatusEvents } from '../../../data/events/index.js';
import { floatingWindowManager } from '../floatingWindowManager.js';
import { globalDiffStatusFilter } from '../diffStatusFilter.js';
import {
  showRawXmlForAllDefinitionDiffs,
  showRawXmlForDefinitionIds,
} from '../rawXmlDiffViewer.js';
import { STB_DEFINITION_ELEMENT_TYPE } from '../../../common-stb/comparison/stbDefinitionComparator.js';
import { showSectionCorrespondenceTable } from '../sectionCorrespondenceTable.js';
import { setShowVersionSpecificDifferences } from '../versionPanel.js';
import { showWarning } from '../../common/toast.js';
import { DIFF_STATUS_VALUES } from '../../../config/diffFilterConfig.js';
import { createLogger } from '../../../utils/logger.js';
import {
  getGroupCollapse,
  toggleGroupCollapse,
  getActiveDefTab,
  setActiveDefTab,
} from './state.js';
import { calculateDiffStatistics } from './statistics.js';
import { buildCrossSoftwareInfo, buildPreconditionWarningMessage } from './crossSoftware.js';
import { generateSummaryHTML } from './summaryHtml.js';

const log = createLogger('ui:panels:diffSummary');

// 差分一覧ボタンのハンドラ参照（重複登録防止用）
let diffListBtnHandler = null;

// サマリー内クリック→フィルタ適用の委譲ハンドラを登録済みか
let summaryFilterClickBound = false;

// 直近の統計データ（列グループの折りたたみ切替時に再描画するため保持）
let lastStats = null;

/** 差分サマリーを表示するフローティングウィンドウのID */
const DIFF_SUMMARY_WINDOW_ID = 'diff-summary-float';

/**
 * サマリー内のクリック→フィルタ適用の委譲ハンドラを登録する（初回のみ）
 * コンテンツは innerHTML で再生成されるため、コンテナに一度だけ委譲登録する
 * @param {HTMLElement} contentElement - #diff-summary-content
 */
function bindSummaryFilterClicks(contentElement) {
  if (summaryFilterClickBound) return;
  summaryFilterClickBound = true;

  contentElement.addEventListener('click', (e) => {
    // 列グループの折りたたみトグルを最優先で処理する
    const toggle = e.target.closest('[data-group-toggle]');
    if (toggle && contentElement.contains(toggle)) {
      toggleGroupCollapse(toggle.dataset.groupToggle);
      if (lastStats) {
        renderSummaryContent(contentElement, lastStats);
      }
      return;
    }

    // 定義タブ（断面/接合/開口/STB定義）の切り替え
    const defTab = e.target.closest('[data-def-tab]');
    if (defTab && contentElement.contains(defTab)) {
      setActiveDefTab(defTab.dataset.defTab);
      if (lastStats) {
        renderSummaryContent(contentElement, lastStats);
      }
      log.info('[Event] サマリークリック: 定義タブ切替', { tab: getActiveDefTab() });
      return;
    }

    // 断面タブの数値セル: 該当断面（断面定義id集合）を参照する配置要素のみを3D表示に絞り込む
    const sectionDefCell = e.target.closest('[data-section-def-ids]');
    if (sectionDefCell && contentElement.contains(sectionDefCell)) {
      const ids = sectionDefCell.dataset.sectionDefIds.split(' ').filter(Boolean);
      const statuses = sectionDefCell.dataset.sectionDefStatuses.split(' ').filter(Boolean);
      const elemTypes = (sectionDefCell.dataset.sectionDefElemTypes || '')
        .split(' ')
        .filter(Boolean);
      const modelSource = sectionDefCell.dataset.sectionDefModelSource || null;
      const category = sectionDefCell.dataset.sectionDefCategory || '';
      const criteria = { sectionIds: ids };
      if (modelSource) criteria.modelSource = modelSource;
      // 参照する配置要素が実在しない未使用断面定義は3Dに何も出ないため、生XML表示へフォールバックする。
      // フィルタ適用前・トグル状態非依存で判定する（applySummaryFilter のトグルで判定が壊れないように）。
      if (!globalDiffStatusFilter.hasElementsReferencingSectionIds(ids, modelSource)) {
        showRawXmlForDefinitionIds(ids, { label: category });
        log.info('[Event] サマリークリック: 未使用断面定義→生XMLフォールバック', {
          idCount: ids.length,
          category,
        });
        return;
      }
      applySummaryFilter(
        statuses,
        elemTypes.length === 0 ? null : elemTypes.length === 1 ? elemTypes[0] : elemTypes,
        criteria,
      );
      log.info('[Event] サマリークリック: 断面定義→配置要素フィルタ', {
        idCount: ids.length,
        statuses,
        elemTypes,
        modelSource,
      });
      return;
    }

    // 断面カテゴリ行: 紐づく配置要素（複数タイプ可）のみを3D表示に絞り込む
    const sectionFilter = e.target.closest('[data-section-element-types]');
    if (sectionFilter && contentElement.contains(sectionFilter)) {
      const types = sectionFilter.dataset.sectionElementTypes.split(' ').filter(Boolean);
      applySummaryFilter(DIFF_STATUS_VALUES, types.length === 1 ? types[0] : types, null);
      log.info('[Event] サマリークリック: 断面カテゴリ→配置要素フィルタ', { types });
      return;
    }

    // 接合/開口/STB定義のカテゴリ行/数値セル: 該当グループの差分を生XML表示する。
    // 数値セルは data-raw-xml-categories で表示カテゴリ（情報不一致/A/Bのみ等）を限定する。
    const rawXmlGroup = e.target.closest('[data-raw-xml-group]');
    if (rawXmlGroup && contentElement.contains(rawXmlGroup)) {
      const categories = (rawXmlGroup.dataset.rawXmlCategories || '').split(' ').filter(Boolean);
      showRawXmlForAllDefinitionDiffs(STB_DEFINITION_ELEMENT_TYPE, {
        group: rawXmlGroup.dataset.rawXmlGroup,
        categories: categories.length > 0 ? categories : null,
      });
      log.info('[Event] サマリークリック: 定義グループの生XML表示', {
        group: rawXmlGroup.dataset.rawXmlGroup,
        categories,
      });
      return;
    }

    // 非ジオメトリ（非描画）タイプは3D絞り込みできないため、生XMLで確認できるようにする
    const rawXmlTarget = e.target.closest('[data-raw-xml-type]');
    if (rawXmlTarget && contentElement.contains(rawXmlTarget)) {
      showRawXmlForAllDefinitionDiffs(rawXmlTarget.dataset.rawXmlType);
      log.info('[Event] サマリークリック: 非ジオメトリ要素の生XML表示');
      return;
    }

    const target = e.target.closest('[data-filter-statuses]');
    if (!target || !contentElement.contains(target)) return;

    const statuses = target.dataset.filterStatuses.split(' ').filter(Boolean);
    const elementType = target.dataset.filterType || null;
    const criteria = parseFilterCriteria(target.dataset);
    applySummaryFilter(statuses, elementType, criteria);
  });
}

function parseFilterCriteria(dataset) {
  const criteria = {};
  if (dataset.filterPositionStates) {
    criteria.positionStates = dataset.filterPositionStates.split(' ').filter(Boolean);
  }
  if (dataset.filterInstanceStates) {
    criteria.instanceStates = dataset.filterInstanceStates.split(' ').filter(Boolean);
  }
  if (dataset.filterSectionStates) {
    criteria.sectionStates = dataset.filterSectionStates.split(' ').filter(Boolean);
  }
  return Object.keys(criteria).length > 0 ? criteria : null;
}

/**
 * クリックされた項目に応じて差分フィルタを適用する。
 * 現在の絞り込みと同一の場合は解除（全表示）としてトグル動作する。
 * @param {Array<string>} statuses - 差分ステータス群
 * @param {string|null} elementType - 要素タイプ（null = 全タイプ）
 */
function applySummaryFilter(statuses, elementType, criteria = null) {
  const filter = globalDiffStatusFilter;
  const isSameSelection =
    isSameElementType(filter.activeElementType, elementType) &&
    filter.activeFilters.size === statuses.length &&
    statuses.every((status) => filter.activeFilters.has(status)) &&
    isSameCriteria(filter.activeCriteria, criteria);

  if (isSameSelection) {
    filter.applyStatusAndTypeFilter(DIFF_STATUS_VALUES, null, null);
    log.info('[Event] サマリークリック: 絞り込み解除');
  } else {
    filter.applyStatusAndTypeFilter(statuses, elementType, criteria);
    log.info('[Event] サマリークリック: フィルタ適用', { statuses, elementType, criteria });
  }
}

/** activeElementType（文字列 / 配列 / null）の同値判定 */
function isSameElementType(a, b) {
  const norm = (v) => (Array.isArray(v) ? [...v].sort() : v == null ? [] : [v]);
  const na = norm(a);
  const nb = norm(b);
  return na.length === nb.length && na.every((t, i) => t === nb[i]);
}

function isSameCriteria(a, b) {
  const normalize = (criteria) =>
    JSON.stringify({
      positionStates: [...(criteria?.positionStates || [])].sort(),
      instanceStates: [...(criteria?.instanceStates || [])].sort(),
      sectionStates: [...(criteria?.sectionStates || [])].sort(),
      sectionIds: [...(criteria?.sectionIds || [])].map(String).sort(),
      modelSource: criteria?.modelSource || null,
    });
  return normalize(a) === normalize(b);
}

/**
 * 差分結果のサマリーを表示する
 * @param {Object} comparisonResults - 比較結果オブジェクト
 * @param {string} [reason] - 統計更新の要因（'modelComparison' 等）
 * @param {boolean} [hasBothModels] - モデルA/Bが両方揃っているか（単一モデルでは自動表示しない）
 */
function updateDiffSummary(comparisonResults, reason, hasBothModels) {
  const contentElement = document.getElementById('diff-summary-content');

  if (!contentElement || !comparisonResults) {
    return;
  }

  // 統計データを集計（列グループ折りたたみの再描画で使い回すため保持）
  const stats = calculateDiffStatistics(comparisonResults);
  // 異ソフト間比較モード時の付加情報（C2プリコンディション・A5スコープ調停）。モードOFF時は null。
  stats.crossSoftware = buildCrossSoftwareInfo(comparisonResults, stats);
  lastStats = stats;

  // グラフ・表クリック→フィルタ適用／列折りたたみの委譲ハンドラを登録（初回のみ）
  bindSummaryFilterClicks(contentElement);

  // 表示を更新（HTML生成 + ボタン類のイベント配線）
  renderSummaryContent(contentElement, stats);

  // C2: 新規比較の完了時、別建物の可能性があればトーストでも警告する
  // （サマリー内の警告ブロックに加えて、見落とし防止の即時通知）
  const precondition = stats.crossSoftware?.precondition;
  if (
    reason === 'modelComparison' &&
    precondition &&
    precondition.judgeable &&
    !precondition.similar
  ) {
    showWarning(buildPreconditionWarningMessage(precondition), { duration: 10000 });
    log.warn('[Data] 異ソフト間比較: 別建物の可能性を検出しました', precondition);
  }

  // 結果が無ければウィンドウを閉じる。
  // 新規比較実行時は、両モデルが揃っている場合のみ結果ウィンドウを自動表示する。
  // 単一モデル時は全要素が「モデルAのみ」となり比較情報を持たないため、
  // 自動表示せず（既に開いていれば閉じて）3Dの要素タイプ別カラーと矛盾しないようにする。
  // 編集中の再比較（editRecomparison）では開いている場合のみ中身を更新し、勝手に開閉しない。
  if (stats.totalElements === 0) {
    floatingWindowManager.hideWindow(DIFF_SUMMARY_WINDOW_ID);
  } else if (reason === 'modelComparison') {
    if (hasBothModels) {
      floatingWindowManager.showWindow(DIFF_SUMMARY_WINDOW_ID);
    } else {
      floatingWindowManager.hideWindow(DIFF_SUMMARY_WINDOW_ID);
    }
  }
}

/**
 * サマリー本体のHTMLを生成し、ボタン類のイベントを配線する。
 * 列グループの折りたたみ切替時にも再利用する（委譲ハンドラは別途一度だけ登録済み）。
 * @param {HTMLElement} contentElement - #diff-summary-content
 * @param {Object} stats - 統計データ
 */
function renderSummaryContent(contentElement, stats) {
  contentElement.innerHTML = generateSummaryHTML(stats, getGroupCollapse());
  eventBus.emit(DiffStatusEvents.FILTER_CHANGED, { action: 'summaryRendered' });

  // 差分一覧ボタンのイベントリスナーを設定（innerHTMLで要素が再作成されるため都度付け直す）
  const diffListBtn = document.getElementById('open-diff-list-from-summary');
  if (diffListBtn) {
    if (!diffListBtnHandler) {
      diffListBtnHandler = () => {
        if (typeof window.toggleDiffList === 'function') {
          window.toggleDiffList();
        }
      };
    }
    diffListBtn.addEventListener('click', diffListBtnHandler);
  }

  // バージョンフィルタチェックボックスのイベントリスナーを設定
  const versionFilterCheckbox = document.getElementById('version-diff-filter');
  if (versionFilterCheckbox) {
    versionFilterCheckbox.addEventListener('change', (e) => {
      setShowVersionSpecificDifferences(e.target.checked);
      log.info('[DiffSummary] バージョン差分フィルタ変更:', e.target.checked);
    });
  }

  // 断面対応表ボタン（異ソフト間比較モード時のみ描画される）
  const sectionCorrespondenceBtn = document.getElementById('open-section-correspondence-btn');
  if (sectionCorrespondenceBtn) {
    sectionCorrespondenceBtn.addEventListener('click', () => {
      showSectionCorrespondenceTable();
    });
  }
}

/**
 * 差分結果が更新された際のイベントリスナーを設定する
 */
export function setupDiffSummaryEventListeners() {
  // 比較結果更新イベントを監視（EventBus経由）
  eventBus.on(ComparisonEvents.UPDATE_STATISTICS, (data) => {
    if (data && data.comparisonResults) {
      updateDiffSummary(data.comparisonResults, data.reason, data.hasBothModels);
    }
  });

  log.info('Diff summary event listeners set up');
}
