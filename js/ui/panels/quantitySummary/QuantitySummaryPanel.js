/**
 * @fileoverview Issue #287 Phase 3: 数量集計パネルの A/B 比較・drilldown。
 */

import comparisonKeyManager from '../../../app/comparisonKeyManager.js';
import { STORY_AXIS_MATCH_CRITERION } from '../../../config/comparisonKeyConfig.js';
import { getState, setState } from '../../../data/state/globalState.js';
import { eventBus, EditEvents, ModelEvents, RenderEvents } from '../../../data/events/index.js';
import { aggregateQuantityFacts } from '../../../quantities/analytics/QuantityAggregator.js';
import {
  buildQuantityCsvFilename,
  serializeQuantityFactsCsv,
  serializeQuantitySummaryCsv,
} from '../../../quantities/analytics/QuantityCsvExporter.js';
import {
  buildQuantityGroupKey,
  compareQuantityAggregateRows,
  filterQuantityFactsForGroup,
} from '../../../quantities/analytics/QuantityComparison.js';
import { floatingWindowManager } from '../floatingWindowManager.js';
import { downloadQuantityCsv } from './QuantityCsvDownload.js';
import { bindQuantitySummaryInteractions } from './QuantitySummaryInteractions.js';
import {
  buildQuantityAggregationOptions,
  countQuantitySummaryFacts,
  createQuantitySummaryState,
  getQuantityComparisonDimensions,
  getQuantitySummaryDimensions,
  normalizeQuantitySummaryState,
  sortQuantitySummaryRows,
} from './QuantitySummaryState.js';
import {
  renderQuantityDrilldown,
  renderQuantitySummaryControls,
  renderQuantitySummaryTable,
} from './QuantitySummaryRenderer.js';
import { focusQuantityFact } from './QuantitySummarySelection.js';

const WINDOW_ID = 'quantity-summary-panel';
const TOGGLE_BUTTON_ID = 'toggle-quantity-summary-btn';

function withGroupKeys(rows, dimensions) {
  return (rows || []).map((row) => ({
    ...row,
    groupKey: buildQuantityGroupKey(row, dimensions),
  }));
}

function compareFactIdentity(a, b) {
  const side = String(a?.modelSide || '').localeCompare(String(b?.modelSide || ''));
  if (side !== 0) return side;
  const category = String(a?.memberCategory || '').localeCompare(
    String(b?.memberCategory || ''),
    'ja',
  );
  if (category !== 0) return category;
  return String(a?.elementId || '').localeCompare(String(b?.elementId || ''), 'ja', {
    numeric: true,
  });
}

function collectStoryMatchMetadata(facts, statuses = null) {
  const metadata = new Map();
  const acceptedStatuses = Array.isArray(statuses) ? new Set(statuses) : null;
  for (const fact of facts || []) {
    if (acceptedStatuses && !acceptedStatuses.has(fact?.status)) continue;
    const key = fact?.storyHeightMatchKey;
    if (!key) continue;
    if (!metadata.has(key)) {
      metadata.set(key, { names: new Set(), heights: new Set() });
    }
    const entry = metadata.get(key);
    if (fact?.storyName && fact.storyName !== '未分類') entry.names.add(fact.storyName);
    if (Number.isFinite(Number(fact?.storyHeightMm))) {
      entry.heights.add(Number(fact.storyHeightMm));
    }
  }
  return metadata;
}

function summarizeStoryNames(metadata, key) {
  const names = [...(metadata.get(key)?.names || [])];
  return names.length > 0 ? names.join(' / ') : null;
}

function representativeStoryHeight(metadataA, metadataB, key) {
  const candidates = [
    ...(metadataA.get(key)?.heights || []),
    ...(metadataB.get(key)?.heights || []),
  ];
  return candidates.length > 0 ? candidates[0] : null;
}

function decorateHeightMatchedStoryRows(rows, factsA, factsB, statuses = null) {
  const metadataA = collectStoryMatchMetadata(factsA, statuses);
  const metadataB = collectStoryMatchMetadata(factsB, statuses);

  return (rows || []).map((row) => {
    const key = row?.storyHeightMatchKey;
    if (!key) return row;

    const storyNameA = summarizeStoryNames(metadataA, key);
    const storyNameB = summarizeStoryNames(metadataB, key);
    const storyHeightMm = representativeStoryHeight(metadataA, metadataB, key);
    const storyName =
      storyNameA && storyNameB && storyNameA !== storyNameB
        ? `${storyNameA} ↔ ${storyNameB}`
        : storyNameA || storyNameB || '未分類';

    return {
      ...row,
      storyName,
      storyNameA,
      storyNameB,
      storyHeightMm,
    };
  });
}

class QuantitySummaryPanel {
  constructor() {
    this.state = createQuantitySummaryState({
      storyMatchCriterion: comparisonKeyManager.getStoryAxisMatchCriterion(),
    });
    this.root = null;
    this.controls = null;
    this.table = null;
    this.summary = null;
    this.drilldown = null;
    this.selectedGroupKey = null;
    this.drilldownPage = 1;
    this.currentRows = [];
    this.currentDrilldownFacts = [];
    this._unbindInteractions = null;
    this._eventsBound = false;
  }

  initialize(container = document.body) {
    if (document.getElementById(WINDOW_ID)) return this;
    container.insertAdjacentHTML('beforeend', this.createPanelHTML());
    this.root = document.getElementById(WINDOW_ID);
    this.controls = this.root?.querySelector('[data-quantity-summary-controls]') || null;
    this.table = this.root?.querySelector('[data-quantity-summary-table]') || null;
    this.summary = this.root?.querySelector('[data-quantity-summary-summary]') || null;
    this.drilldown = this.root?.querySelector('[data-quantity-summary-drilldown]') || null;

    floatingWindowManager.registerWindow({
      windowId: WINDOW_ID,
      toggleButtonId: TOGGLE_BUTTON_ID,
      closeButtonId: 'quantity-summary-close',
      headerId: 'quantity-summary-header',
      draggable: true,
      resizable: true,
      autoShow: false,
      onShow: () => this.refresh(),
      onHide: () => setState('ui.quantitySummaryVisible', false),
    });

    this._unbindInteractions = bindQuantitySummaryInteractions(this.root, {
      onControlChange: (key, value) => this.handleControlChange(key, value),
      onStatusChange: (status, checked) => this.toggleStatus(status, checked),
      onSort: (key) => this.toggleSort(key),
      onPageChange: (page) => this.updateState({ page }),
      onGroupOpen: (groupKey) => this.openGroup(groupKey),
      onDrilldownClose: () => this.closeDrilldown(),
      onDrilldownPageChange: (page) => this.setDrilldownPage(page),
      onFactSelect: (fact) => focusQuantityFact(fact),
      onExport: (kind) => this.exportCsv(kind),
    });
    this.bindAppEvents();
    this.refresh();
    return this;
  }

  createPanelHTML() {
    return `
      <div id="${WINDOW_ID}" class="floating-window quantity-summary-panel">
        <div class="float-window-header" id="quantity-summary-header">
          <span class="float-window-title">📊 数量集計</span>
          <div class="float-window-controls">
            <button type="button" class="float-window-btn" id="quantity-summary-close" aria-label="閉じる">✕</button>
          </div>
        </div>
        <div class="quantity-summary-body">
          <div data-quantity-summary-controls></div>
          <div class="quantity-summary-summary" data-quantity-summary-summary></div>
          <div class="quantity-summary-table-host" data-quantity-summary-table></div>
          <div class="quantity-summary-drilldown" data-quantity-summary-drilldown></div>
        </div>
      </div>
    `;
  }

  bindAppEvents() {
    if (this._eventsBound) return;
    this._eventsBound = true;
    const refreshIfVisible = () => {
      if (floatingWindowManager.isWindowVisible(WINDOW_ID)) this.refresh();
    };
    // QuantityFact 構築は parse 完了より後なので、可視化完了イベントで更新する。
    eventBus.on(RenderEvents.MODEL_LOADED, refreshIfVisible);
    eventBus.on(ModelEvents.CLEARED, refreshIfVisible);
    eventBus.on(EditEvents.MODE_TOGGLED, refreshIfVisible);
    eventBus.on(EditEvents.WORKING_DOCUMENT_CHANGED, refreshIfVisible);
  }

  handleControlChange(key, value) {
    if (
      key === 'modelSide' ||
      key === 'dimension1' ||
      key === 'dimension2' ||
      key === 'storyMatchCriterion'
    ) {
      this.selectedGroupKey = null;
      this.drilldownPage = 1;
    }

    if (key === 'storyMatchCriterion') {
      comparisonKeyManager.setStoryAxisMatchCriterion(value);
    }
    this.updateState({ [key]: value, page: 1 });
  }

  updateState(patch) {
    this.state = normalizeQuantitySummaryState({ ...this.state, ...patch });
    this.refresh();
  }

  toggleStatus(status, checked) {
    const statuses = new Set(this.state.statuses);
    if (checked) statuses.add(status);
    else statuses.delete(status);
    this.updateState({ statuses: [...statuses], page: 1 });
  }

  toggleSort(key) {
    const same = this.state.sortKey === key;
    this.updateState({
      sortKey: key,
      sortDirection: same && this.state.sortDirection === 'asc' ? 'desc' : 'asc',
      page: 1,
    });
  }

  factsForSide(side) {
    return getState(`models.quantityFacts${side}`);
  }

  canExportQuantities() {
    const editingA = Boolean(getState('models.editing.active'));
    if (editingA && (this.state.modelSide === 'A' || this.state.modelSide === 'AB')) {
      return false;
    }

    if (this.state.modelSide === 'AB') {
      return Array.isArray(this.factsForSide('A')) && Array.isArray(this.factsForSide('B'));
    }
    return Array.isArray(this.factsForSide(this.state.modelSide));
  }

  collectExportFacts() {
    if (!this.canExportQuantities()) return [];

    const sides = this.state.modelSide === 'AB' ? ['A', 'B'] : [this.state.modelSide];
    const facts = [];
    for (const side of sides) {
      facts.push(...this.factsForSide(side));
    }
    return facts.sort(compareFactIdentity);
  }

  exportCsv(kind) {
    if (!this.canExportQuantities()) return false;

    if (kind === 'summary') {
      if (!Array.isArray(this.currentRows) || this.currentRows.length === 0) return false;
      return downloadQuantityCsv(
        serializeQuantitySummaryCsv(this.currentRows, this.state),
        buildQuantityCsvFilename('summary', this.state.modelSide),
      );
    }

    if (kind === 'facts') {
      const facts = this.collectExportFacts();
      if (facts.length === 0) return false;
      return downloadQuantityCsv(
        serializeQuantityFactsCsv(facts, { decimalDigits: this.state.decimalDigits }),
        buildQuantityCsvFilename('facts', this.state.modelSide),
      );
    }

    return false;
  }

  resetDrilldown() {
    this.selectedGroupKey = null;
    this.drilldownPage = 1;
    this.currentDrilldownFacts = [];
    renderQuantityDrilldown(this.drilldown, [], this.state, { group: null });
  }

  openGroup(groupKey) {
    if (!groupKey || !this.currentRows.some((row) => row?.groupKey === groupKey)) return;
    this.selectedGroupKey = groupKey;
    this.drilldownPage = 1;
    this.refresh();
  }

  closeDrilldown() {
    if (!this.selectedGroupKey) return;
    this.resetDrilldown();
    this.refresh();
  }

  setDrilldownPage(page) {
    const requested = Number(page);
    if (!Number.isInteger(requested) || requested < 1 || !this.selectedGroupKey) return;
    this.drilldownPage = requested;
    this.renderCurrentDrilldown();
  }

  collectDrilldownFacts(group) {
    const options = {
      dimensions:
        this.state.modelSide === 'AB'
          ? getQuantityComparisonDimensions(this.state)
          : getQuantitySummaryDimensions(this.state),
      statuses: this.state.statuses,
    };
    const sides = this.state.modelSide === 'AB' ? ['A', 'B'] : [this.state.modelSide];
    const facts = [];

    for (const side of sides) {
      const source = this.factsForSide(side);
      if (!Array.isArray(source)) continue;
      facts.push(...filterQuantityFactsForGroup(source, group, options));
    }
    return facts.sort(compareFactIdentity);
  }

  renderCurrentDrilldown() {
    if (!this.selectedGroupKey) {
      this.resetDrilldown();
      return;
    }
    const group = this.currentRows.find((row) => row?.groupKey === this.selectedGroupKey);
    if (!group) {
      this.resetDrilldown();
      return;
    }

    this.currentDrilldownFacts = this.collectDrilldownFacts(group);
    renderQuantityDrilldown(this.drilldown, this.currentDrilldownFacts, this.state, {
      group,
      page: this.drilldownPage,
    });
  }

  renderUnavailable(summaryText, message) {
    this.summary.textContent = summaryText;
    this.currentRows = [];
    this.resetDrilldown();
    renderQuantitySummaryTable(this.table, [], this.state, { message });
  }

  buildSingleModelRows(facts) {
    const dimensions = getQuantitySummaryDimensions(this.state);
    const rows = aggregateQuantityFacts(facts, buildQuantityAggregationOptions(this.state));
    return withGroupKeys(rows, dimensions);
  }

  buildComparisonRows(factsA, factsB) {
    const dimensions = getQuantityComparisonDimensions(this.state);
    const options = buildQuantityAggregationOptions(this.state, { forComparison: true });
    const rowsA = aggregateQuantityFacts(factsA, options);
    const rowsB = aggregateQuantityFacts(factsB, options);
    const compared = compareQuantityAggregateRows(rowsA, rowsB, {
      dimensions,
      measure: this.state.measure,
    });

    if (
      this.state.storyMatchCriterion === STORY_AXIS_MATCH_CRITERION.GEOMETRY &&
      getQuantitySummaryDimensions(this.state).includes('storyName')
    ) {
      return decorateHeightMatchedStoryRows(compared, factsA, factsB, this.state.statuses);
    }
    return compared;
  }

  refresh() {
    if (!this.root) return;
    this.state = normalizeQuantitySummaryState({
      ...this.state,
      storyMatchCriterion: comparisonKeyManager.getStoryAxisMatchCriterion(),
    });
    renderQuantitySummaryControls(this.controls, this.state);
    setState(
      'ui.quantitySummaryVisible',
      Boolean(floatingWindowManager.isWindowVisible(WINDOW_ID)),
    );

    const editingA = Boolean(getState('models.editing.active'));
    if (editingA && (this.state.modelSide === 'A' || this.state.modelSide === 'AB')) {
      this.renderUnavailable(
        this.state.modelSide === 'AB'
          ? 'A/B比較: モデルAは編集中のため比較を停止しています。'
          : 'モデルAは編集中です。派生数量の増分再計算が未対応のため表示を停止しています。',
        '編集を確定・破棄して再読込した後に数量を確認してください。',
      );
      return;
    }

    if (this.state.statuses.length === 0) {
      const label = this.state.modelSide === 'AB' ? 'A/B比較' : `モデル${this.state.modelSide}`;
      this.renderUnavailable(`${label}: Status未選択`, 'Statusを1つ以上選択してください。');
      return;
    }

    let rows;
    if (this.state.modelSide === 'AB') {
      const factsA = this.factsForSide('A');
      const factsB = this.factsForSide('B');
      if (!Array.isArray(factsA) || !Array.isArray(factsB)) {
        this.renderUnavailable(
          'A/B比較: 数量データ未生成',
          'モデルA/Bの両方を読み込むと数量差を表示します。',
        );
        return;
      }

      rows = this.buildComparisonRows(factsA, factsB);
      const countA = rows.reduce((total, row) => total + Number(row?.countA || 0), 0);
      const countB = rows.reduce((total, row) => total + Number(row?.countB || 0), 0);
      this.summary.textContent = `A/B比較: A ${countA} / ${factsA.length} 要素 / B ${countB} / ${factsB.length} 要素 / ${rows.length} グループ`;
    } else {
      const facts = this.factsForSide(this.state.modelSide);
      if (!Array.isArray(facts)) {
        this.renderUnavailable(
          `モデル${this.state.modelSide}: 数量データ未生成`,
          `モデル${this.state.modelSide}を読み込むと数量集計を表示します。`,
        );
        return;
      }

      rows = this.buildSingleModelRows(facts);
      const filteredFactCount = countQuantitySummaryFacts(rows);
      this.summary.textContent = `モデル${this.state.modelSide}: ${filteredFactCount} / ${facts.length} 要素 / ${rows.length} グループ`;
    }

    const sortedRows = sortQuantitySummaryRows(rows, this.state);
    this.currentRows = sortedRows;

    if (
      this.selectedGroupKey &&
      !sortedRows.some((row) => row?.groupKey === this.selectedGroupKey)
    ) {
      this.selectedGroupKey = null;
      this.drilldownPage = 1;
    }

    renderQuantitySummaryTable(this.table, sortedRows, this.state, {
      selectedGroupKey: this.selectedGroupKey,
    });
    this.renderCurrentDrilldown();
  }

  show() {
    floatingWindowManager.showWindow(WINDOW_ID);
  }

  hide() {
    floatingWindowManager.hideWindow(WINDOW_ID);
  }

  toggle() {
    floatingWindowManager.toggleWindow(WINDOW_ID);
  }
}

let quantitySummaryPanelInstance = null;

function getQuantitySummaryPanel() {
  if (!quantitySummaryPanelInstance) quantitySummaryPanelInstance = new QuantitySummaryPanel();
  return quantitySummaryPanelInstance;
}

export function initializeQuantitySummaryPanel(container = document.body) {
  return getQuantitySummaryPanel().initialize(container);
}
