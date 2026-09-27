/**
 * @fileoverview Issue #273 Phase 4a / Issue #292 Phase 6b: 配筋Decision Trace inspector。
 *
 * Resolverが採用したrule、precedence/maturity/source、e/jt、棄却候補、
 * unresolved reasonを表示する。Issue #292の干渉編集候補を明示的に有効化した場合だけ、
 * pair-local explicit overrideを保存し、既存resolverで再評価する。
 */

import { collectRebarDecisionTraces } from '../../app/viewModes/rebarDecisionTraceCollector.js';
import { refreshVisibleRebarGroups } from '../../app/viewModes/rebarDisplay.js';
import {
  captureRebarPlacementConflictOverrideSnapshot,
  createRebarPlacementConflictOverrideAssignment,
  removeRebarPlacementConflictOverrideAssignment,
  restoreRebarPlacementConflictOverrideSnapshot,
  upsertRebarPlacementConflictOverrideAssignment,
} from '../../config/rebarPlacementConflictOverrideEditor.js';
import { createRebarDecisionTraceAuthoringController } from './rebarDecisionTraceAuthoring.js';
import { floatingWindowManager } from './floatingWindowManager.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('RebarDecisionTracePanel');

const WINDOW_ID = 'rebar-decision-trace-float';
const STYLE_ID = 'rebar-decision-trace-styles';

let modelFilter = '';
let memberFilter = '';
let statusFilter = '';
let searchText = '';
let currentRows = [];
let placementAuthoringEnabled = false;
let selectedDecisionKey = null;
let authoringMessage = '';
let isInitialized = false;

function clearAuthoringSelection() {
  selectedDecisionKey = null;
  authoringMessage = '';
}

function memberType(row) {
  const type = String(row?.subjectType || '').toUpperCase();
  if (type.startsWith('COLUMN')) return 'COLUMN';
  if (type.startsWith('GIRDER')) return 'GIRDER';
  if (type.startsWith('FOUNDATION_')) return 'FOUNDATION';
  if (type === 'REBAR_PAIR_CONFLICT' || type.startsWith('REBAR_PLACEMENT')) return 'CONFLICT';
  return 'OTHER';
}

function formatRule(rule) {
  if (!rule) return '-';
  const contract = [rule.precedence, rule.ruleType, rule.maturity].filter(Boolean).join('/');
  const source = rule.source ? ` <${rule.source}>` : '';
  return `${rule.ruleId || '-'}${contract ? ` [${contract}]` : ''}${source}`;
}

function formatRules(row) {
  const rules = Array.isArray(row?.appliedRules) ? row.appliedRules : [];
  return rules.length ? rules.map(formatRule).join('; ') : '-';
}

function formatCandidateRules(row) {
  const rules = Array.isArray(row?.candidateRules) ? row.candidateRules : [];
  return rules.length ? rules.map(formatRule).join('; ') : '-';
}

function formatCandidateFacts(row) {
  const facts = row?.candidateFacts;
  if (!facts || typeof facts !== 'object') return '-';
  try {
    return JSON.stringify(facts) || '-';
  } catch {
    return '候補事実を表示できません';
  }
}

function formatMetrics(row) {
  const metrics = row?.metrics && typeof row.metrics === 'object' ? row.metrics : {};
  const preferred = ['eMm', 'jtMm', 'ratio', 'horizontalOffsetMm', 'verticalOffsetMm'];
  const keys = [
    ...preferred.filter((key) => Object.prototype.hasOwnProperty.call(metrics, key)),
    ...Object.keys(metrics)
      .filter((key) => !preferred.includes(key))
      .sort(),
  ];
  return keys.length
    ? keys
        .map((key) => {
          const value = metrics[key];
          return `${key}=${typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(6)) : value}`;
        })
        .join(', ')
    : '-';
}

function formatAlternative(value) {
  if (value === null || value === undefined) return '-';
  if (typeof value !== 'object') return String(value);
  return Object.entries(value)
    .map(([key, item]) => `${key}=${String(item)}`)
    .join(', ');
}

function formatRejected(row) {
  const alternatives = Array.isArray(row?.rejectedAlternatives) ? row.rejectedAlternatives : [];
  return alternatives.length ? alternatives.map(formatAlternative).join(' | ') : '-';
}

function formatProvenance(row) {
  const sources = Array.isArray(row?.provenance?.sources) ? row.provenance.sources : [];
  return sources.length ? sources.join('; ') : '-';
}

const COLUMNS = [
  { label: 'Model', value: (row) => row.modelSource || '-' },
  { label: '部材', value: (row) => memberType(row) },
  { label: '対象種別', value: (row) => row.subjectType || '-' },
  { label: '対象キー', value: (row) => row.subjectKey || '-' },
  { label: '状態', value: (row) => row.status || '-' },
  { label: 'Disposition', value: (row) => row.disposition || '-' },
  { label: 'Source', value: (row) => row.sourceRef || '-' },
  { label: 'Target', value: (row) => row.targetRef || '-' },
  { label: '適用ルール', wide: true, value: formatRules },
  { label: '候補ルール', wide: true, value: formatCandidateRules },
  { label: '候補事実', wide: true, value: formatCandidateFacts },
  { label: 'Metrics', wide: true, value: formatMetrics },
  { label: '棄却候補', wide: true, value: formatRejected },
  { label: '未解決理由', wide: true, value: (row) => row.unresolvedReason || '-' },
  { label: '根拠', wide: true, value: formatProvenance },
];

const authoringController = createRebarDecisionTraceAuthoringController({
  windowId: WINDOW_ID,
  getRows: () => currentRows,
  isEnabled: () => placementAuthoringEnabled,
  getSelectedKey: () => selectedDecisionKey,
  setSelectedKey: (value) => {
    selectedDecisionKey = value;
  },
  getMessage: () => authoringMessage,
  setMessage: (value) => {
    authoringMessage = value;
  },
  refreshRows: () => refresh(),
  refreshTable: () => refreshTableOnly(),
  createAssignment: createRebarPlacementConflictOverrideAssignment,
  captureOverrideSnapshot: captureRebarPlacementConflictOverrideSnapshot,
  upsertAssignment: upsertRebarPlacementConflictOverrideAssignment,
  removeAssignment: removeRebarPlacementConflictOverrideAssignment,
  restoreOverrideSnapshot: restoreRebarPlacementConflictOverrideSnapshot,
  refreshVisibleRebarGroups,
  log,
});

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${WINDOW_ID} { width: 1320px; max-width: 98vw; }
    #${WINDOW_ID} .trace-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 14px;
      margin-bottom: 8px;
      font-size: var(--font-size-sm);
    }
    #${WINDOW_ID} .trace-toolbar label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
    }
    #${WINDOW_ID} .trace-toolbar input[type='search'] { width: 220px; }
    #${WINDOW_ID} .trace-summary { margin-left: auto; }
    #${WINDOW_ID} .trace-table-container {
      overflow: auto;
      max-height: 58vh;
      border: 1px solid var(--color-border, #dee2e6);
    }
    #${WINDOW_ID} table {
      width: 100%;
      border-collapse: collapse;
      font-size: var(--font-size-xs);
    }
    #${WINDOW_ID} th, #${WINDOW_ID} td {
      border: 1px solid var(--color-border, #dee2e6);
      padding: 3px 6px;
      text-align: left;
      white-space: nowrap;
      vertical-align: top;
    }
    #${WINDOW_ID} th {
      position: sticky;
      top: 0;
      background: var(--color-surface-alt, #f1f3f5);
      z-index: 1;
    }
    #${WINDOW_ID} td.trace-wide {
      min-width: 230px;
      white-space: normal;
      overflow-wrap: anywhere;
    }
    #${WINDOW_ID} tr.trace-unresolved { background: rgba(201, 42, 42, 0.07); }
    #${WINDOW_ID} .trace-empty {
      padding: 24px;
      text-align: center;
      color: var(--color-text-muted, #6c757d);
    }
    #${WINDOW_ID} .trace-notes {
      margin-top: 8px;
      font-size: var(--font-size-xs);
      color: var(--color-text-muted, #6c757d);
      line-height: 1.5;
    }
    #${WINDOW_ID} .trace-authoring {
      margin-top: 8px;
      padding: 8px;
      border: 1px solid var(--color-border, #dee2e6);
      background: var(--color-surface-alt, #f8f9fa);
      font-size: var(--font-size-xs);
      line-height: 1.5;
    }
    #${WINDOW_ID} .trace-authoring-title {
      font-weight: 600;
      margin-bottom: 4px;
    }
    #${WINDOW_ID} .trace-authoring-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 6px;
    }
    #${WINDOW_ID} .trace-authoring-message {
      margin-top: 6px;
      white-space: pre-wrap;
    }
    #${WINDOW_ID} .trace-edit-btn {
      white-space: nowrap;
    }
    #${WINDOW_ID} tr.trace-selected {
      outline: 2px solid var(--color-accent, #228be6);
      outline-offset: -2px;
    }
  `;
  document.head.appendChild(style);
}

function createWindowElement() {
  if (document.getElementById(WINDOW_ID)) return;
  const windowEl = document.createElement('div');
  windowEl.id = WINDOW_ID;
  windowEl.className = 'floating-window hidden';
  windowEl.innerHTML = `
    <div class="float-window-header" id="${WINDOW_ID}-header">
      <span class="float-window-title">🧭 配筋判断トレース</span>
      <div class="float-window-controls">
        <button class="float-window-btn" id="${WINDOW_ID}-csv-btn" title="CSVとして保存">CSV</button>
        <button class="float-window-btn" id="close-${WINDOW_ID}-btn">✕</button>
      </div>
    </div>
    <div class="float-window-content">
      <div class="trace-toolbar">
        <label>Model
          <select id="${WINDOW_ID}-model">
            <option value="">すべて</option>
            <option value="A">A</option>
            <option value="B">B</option>
          </select>
        </label>
        <label>部材
          <select id="${WINDOW_ID}-member">
            <option value="">すべて</option>
            <option value="COLUMN">柱</option>
            <option value="GIRDER">大梁</option>
            <option value="FOUNDATION">基礎</option>
            <option value="CONFLICT">配筋干渉</option>
          </select>
        </label>
        <label>状態
          <select id="${WINDOW_ID}-status">
            <option value="">すべて</option>
            <option value="RESOLVED">RESOLVED</option>
            <option value="UNRESOLVED">UNRESOLVED</option>
          </select>
        </label>
        <label>検索
          <input type="search" id="${WINDOW_ID}-search" placeholder="ID / rule / reason">
        </label>
        <label>
          <input type="checkbox" id="${WINDOW_ID}-authoring-toggle">
          干渉編集候補
        </label>
        <span class="trace-summary" id="${WINDOW_ID}-summary"></span>
      </div>
      <div class="trace-table-container" id="${WINDOW_ID}-table-container">
        <div class="trace-empty">モデルを読み込むと判断根拠を表示します</div>
      </div>
      <div class="trace-authoring" id="${WINDOW_ID}-authoring"></div>
      <div class="trace-notes" id="${WINDOW_ID}-notes"></div>
    </div>
  `;
  document.body.appendChild(windowEl);
}

function rowSearchText(row) {
  return [
    row.modelSource,
    row.subjectType,
    row.subjectKey,
    row.status,
    row.disposition,
    row.sourceRef,
    row.targetRef,
    formatRules(row),
    formatCandidateRules(row),
    formatCandidateFacts(row),
    formatMetrics(row),
    formatRejected(row),
    row.unresolvedReason,
    formatProvenance(row),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function filteredRows(rows) {
  const query = searchText.trim().toLowerCase();
  return rows.filter((row) => {
    if (modelFilter && row.modelSource !== modelFilter) return false;
    if (memberFilter && memberType(row) !== memberFilter) return false;
    if (statusFilter && row.status !== statusFilter) return false;
    if (query && !rowSearchText(row).includes(query)) return false;
    return true;
  });
}

function buildTable(rows) {
  const table = document.createElement('table');
  const header = document.createElement('tr');
  for (const column of COLUMNS) {
    const th = document.createElement('th');
    th.textContent = column.label;
    header.appendChild(th);
  }
  const editHeader = document.createElement('th');
  editHeader.textContent = '編集';
  header.appendChild(editHeader);
  table.appendChild(header);

  for (const row of rows) {
    const tr = document.createElement('tr');
    if (row.status === 'UNRESOLVED') tr.classList.add('trace-unresolved');
    if (authoringController.isSelected(row)) tr.classList.add('trace-selected');
    for (const column of COLUMNS) {
      const td = document.createElement('td');
      if (column.wide) td.className = 'trace-wide';
      td.textContent = String(column.value(row));
      tr.appendChild(td);
    }

    tr.appendChild(authoringController.createEditCell(row));
    table.appendChild(tr);
  }
  return table;
}

function refreshTableOnly() {
  const container = document.getElementById(`${WINDOW_ID}-table-container`);
  if (!container) return;
  const rows = filteredRows(currentRows);
  container.replaceChildren();
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'trace-empty';
    empty.textContent =
      currentRows.length === 0
        ? '配筋Decision Traceを生成できる対象部材がありません。'
        : '条件に合う判断トレースはありません。';
    container.appendChild(empty);
    return;
  }
  container.appendChild(buildTable(rows));
}

function readOptions() {
  const cover = Number.parseFloat(document.getElementById('rebarCoverInput')?.value || '');
  const options = Number.isFinite(cover) && cover >= 0 ? { coverMm: cover } : {};
  if (placementAuthoringEnabled) options.includePlacementAuthoringCandidates = true;
  return options;
}

function refresh() {
  const container = document.getElementById(`${WINDOW_ID}-table-container`);
  const summary = document.getElementById(`${WINDOW_ID}-summary`);
  const notes = document.getElementById(`${WINDOW_ID}-notes`);
  if (!container) return;

  currentRows = Array.from(collectRebarDecisionTraces(readOptions()));
  const rows = filteredRows(currentRows);

  container.replaceChildren();
  if (currentRows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'trace-empty';
    empty.textContent = '配筋Decision Traceを生成できる対象部材がありません。';
    container.appendChild(empty);
  } else if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'trace-empty';
    empty.textContent = '条件に合う判断トレースはありません。';
    container.appendChild(empty);
  } else {
    container.appendChild(buildTable(rows));
  }

  if (summary) {
    const unresolved = currentRows.filter((row) => row.status === 'UNRESOLVED').length;
    summary.textContent =
      currentRows.length === 0
        ? ''
        : `${currentRows.length}件 / UNRESOLVED ${unresolved}件 / 表示 ${rows.length}件`;
  }

  if (notes) {
    notes.textContent = placementAuthoringEnabled
      ? '干渉編集候補はDecision Trace用にactual collision pairを追加収集します。' +
        'pair-local explicit overrideだけを保存し、Hard Constraint・geometry gateは既存resolverが再評価します。'
      : 'Resolverのread-only Decision Traceです。「干渉編集候補」を有効にした場合だけpair-local override編集を行えます。' +
        'L0/L2の明示・project ruleもHard Constraintを上書きせず、根拠不足はUNRESOLVEDのまま表示します。';
  }

  authoringController.render();
}

async function saveCsv() {
  if (currentRows.length === 0) return;
  const escape = (value) => `"${String(value).replace(/"/g, '""')}"`;
  const lines = [
    COLUMNS.map((column) => escape(column.label)).join(','),
    ...currentRows.map((row) => COLUMNS.map((column) => escape(column.value(row))).join(',')),
  ];
  const blob = new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const { downloadBlob } = await import('../../utils/downloadHelper.js');
  downloadBlob(blob, '配筋判断トレース.csv');
}

export function initializeRebarDecisionTracePanel() {
  if (isInitialized) return;

  injectStyles();
  createWindowElement();

  floatingWindowManager.registerWindow({
    windowId: WINDOW_ID,
    toggleButtonId: 'openRebarDecisionTraceBtn',
    closeButtonId: `close-${WINDOW_ID}-btn`,
    headerId: `${WINDOW_ID}-header`,
    draggable: true,
    resizable: true,
    autoShow: false,
    onShow: () => {
      clearAuthoringSelection();
      refresh();
    },
  });

  document.getElementById(`${WINDOW_ID}-model`)?.addEventListener('change', (event) => {
    modelFilter = event.target.value;
    clearAuthoringSelection();
    refresh();
  });
  document.getElementById(`${WINDOW_ID}-member`)?.addEventListener('change', (event) => {
    memberFilter = event.target.value;
    clearAuthoringSelection();
    refresh();
  });
  document.getElementById(`${WINDOW_ID}-status`)?.addEventListener('change', (event) => {
    statusFilter = event.target.value;
    clearAuthoringSelection();
    refresh();
  });
  document.getElementById(`${WINDOW_ID}-search`)?.addEventListener('input', (event) => {
    searchText = event.target.value;
    clearAuthoringSelection();
    refresh();
  });
  document.getElementById(`${WINDOW_ID}-authoring-toggle`)?.addEventListener('change', (event) => {
    placementAuthoringEnabled = event.target.checked === true;
    clearAuthoringSelection();
    refresh();
  });
  document.getElementById(`${WINDOW_ID}-csv-btn`)?.addEventListener('click', saveCsv);

  isInitialized = true;
  log.info('RebarDecisionTracePanel initialized');
}
