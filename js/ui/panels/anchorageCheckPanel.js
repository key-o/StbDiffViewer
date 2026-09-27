/**
 * @fileoverview 定着・カットオフ筋長さのチェック一覧パネル
 *
 * RC造配筋標準図（日建連・JSCA 2023.04.01 改定）に基づく次の判定をまとめて一覧表示する。
 *
 * - 梁定着（§8-2）: 梁主筋の柱内90°折曲げ定着の水平投影長さ
 * - 大梁仕口納まり（§8-3）: 左右大梁主筋の通し／鉛直段差／水平位置差
 * - 大梁特殊納まり（図8-2-3 / 8-2-4）: 吊上げ筋・ハンチ部コーナー主筋
 * - 柱頭特殊納まり（図8-2-5）: 最上階柱頭の柱内拘束筋
 * - 柱定着（§7-3）: 最上階柱頭の180°フック／直線定着、最下階柱脚の90°折曲げ定着
 * - 柱カットオフ（§7-1）: 柱頭・柱脚カットオフ筋長さ Ho/2＋15d と、その定着
 * - 梁カットオフ（§8-1 / §9-1）: 端部・中央カットオフ筋長さと中央での重なり
 *
 * 3D配筋表示のON/OFFとは独立して算定するため、鉄筋を表示していなくても開ける。
 * 特殊納まりはproduction gateの状態・source・blockerも表示し、未生成理由を隠さない。
 *
 * @module ui/panels/anchorageCheckPanel
 */

import { getRebarProjectDetailing } from '../../config/rebarProjectDetailing.js';
import { floatingWindowManager } from './floatingWindowManager.js';
import { collectRebarAnchorageChecks } from '../../app/viewModes/rebarAnchorageCheckCollector.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('AnchorageCheckPanel');

const WINDOW_ID = 'anchorage-check-float';
const STYLE_ID = 'anchorage-check-styles';

/** 役割の表示名（梁主筋。柱は算定側で日本語のまま渡ってくる） */
const ROLE_LABELS = { top: '上端筋', bottom: '下端筋' };

/** 分類の絞り込み（'' は全件） */
let categoryFilter = '';
/** NGのみ表示するか */
let ngOnly = false;
let isInitialized = false;

/**
 * パネル本文のスタイルを注入（初回のみ）
 */
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${WINDOW_ID} { width: 1040px; max-width: 96vw; }
    #${WINDOW_ID} .anchorage-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px 16px;
      margin-bottom: 8px;
      font-size: var(--font-size-sm);
    }
    #${WINDOW_ID} .anchorage-toolbar label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
    }
    #${WINDOW_ID} .anchorage-toolbar input[type='number'] { width: 68px; padding: 2px 4px; }
    #${WINDOW_ID} .anchorage-summary {
      font-size: var(--font-size-sm);
      margin-left: auto;
    }
    #${WINDOW_ID} .anchorage-table-container {
      overflow: auto;
      max-height: 55vh;
      border: 1px solid var(--color-border, #dee2e6);
    }
    #${WINDOW_ID} table { width: 100%; border-collapse: collapse; font-size: var(--font-size-xs); }
    #${WINDOW_ID} th, #${WINDOW_ID} td {
      border: 1px solid var(--color-border, #dee2e6);
      padding: 3px 6px;
      text-align: right;
      white-space: nowrap;
    }
    #${WINDOW_ID} th {
      position: sticky;
      top: 0;
      background: var(--color-surface-alt, #f1f3f5);
      z-index: 1;
    }
    #${WINDOW_ID} td.text, #${WINDOW_ID} th.text { text-align: left; }
    #${WINDOW_ID} .judge-ok { color: #2b8a3e; font-weight: 600; }
    #${WINDOW_ID} .judge-ng { color: #c92a2a; font-weight: 600; }
    #${WINDOW_ID} tr.is-ng { background: rgba(201, 42, 42, 0.07); }
    #${WINDOW_ID} .anchorage-empty {
      padding: 24px;
      text-align: center;
      color: var(--color-text-muted, #6c757d);
      font-size: var(--font-size-sm);
    }
    #${WINDOW_ID} .anchorage-notes {
      margin: 8px 0 0;
      font-size: var(--font-size-xs);
      color: var(--color-text-muted, #6c757d);
      line-height: 1.5;
    }
  `;
  document.head.appendChild(style);
}

/**
 * ウィンドウDOMを生成
 */
function createWindowElement() {
  const windowEl = document.createElement('div');
  windowEl.id = WINDOW_ID;
  windowEl.className = 'floating-window hidden';
  windowEl.innerHTML = `
    <div class="float-window-header" id="${WINDOW_ID}-header">
      <span class="float-window-title">⚓ 定着・カットオフ筋長さチェック</span>
      <div class="float-window-controls">
        <button class="float-window-btn" id="${WINDOW_ID}-csv-btn" title="CSVとして保存">CSV</button>
        <button class="float-window-btn" id="close-${WINDOW_ID}-btn">✕</button>
      </div>
    </div>
    <div class="float-window-content">
      <div class="anchorage-toolbar">
        <label title="梁のあばら筋外面までの設計かぶり厚さ">
          梁かぶり
          <input type="number" id="${WINDOW_ID}-beam-cover" min="0" max="200" step="5" value="40">
          mm
        </label>
        <label title="柱の帯筋外面までの設計かぶり厚さ。定着可能な水平投影長さの控除に使います">
          柱かぶり
          <input type="number" id="${WINDOW_ID}-column-cover" min="0" max="200" step="5" value="40">
          mm
        </label>
        <label title="表示する判定の分類を絞り込みます">
          分類
          <select id="${WINDOW_ID}-category">
            <option value="">すべて</option>
            <option value="梁定着">梁定着</option>
            <option value="大梁仕口納まり">大梁仕口納まり</option>
            <option value="大梁特殊納まり">大梁特殊納まり</option>
            <option value="柱頭特殊納まり">柱頭特殊納まり</option>
            <option value="柱定着">柱定着</option>
            <option value="柱仕口納まり">柱仕口納まり</option>
            <option value="柱カットオフ">柱カットオフ</option>
            <option value="梁カットオフ">梁カットオフ</option>
          </select>
        </label>
        <label title="判定NGの行のみを表示します">
          <input type="checkbox" id="${WINDOW_ID}-ng-only">
          NGのみ
        </label>
        <span class="anchorage-summary" id="${WINDOW_ID}-summary"></span>
      </div>
      <div class="anchorage-table-container" id="${WINDOW_ID}-table-container">
        <div class="anchorage-empty">モデルを読み込むと判定結果を表示します</div>
      </div>
      <div class="anchorage-notes" id="${WINDOW_ID}-notes"></div>
    </div>
  `;
  document.body.appendChild(windowEl);
}

/**
 * 入力欄とproject detailing runtime sourceから算定設定を作る
 * @returns {{coverMm?:number, columnCoverMm?:number, projectDetailing:Object}} 算定設定
 */
function readOptions() {
  const beamCover = Number(document.getElementById(`${WINDOW_ID}-beam-cover`)?.value);
  const columnCover = Number(document.getElementById(`${WINDOW_ID}-column-cover`)?.value);
  const options = { projectDetailing: getRebarProjectDetailing() };
  if (Number.isFinite(beamCover) && beamCover >= 0) options.coverMm = beamCover;
  if (Number.isFinite(columnCover) && columnCover >= 0) options.columnCoverMm = columnCover;
  return options;
}

/**
 * 数値を丸めて表示する（未算定は '-'）
 * @param {number|null|undefined} value - 値 [mm]
 * @returns {string|number} 表示値
 */
function roundOrDash(value) {
  return Number.isFinite(value) ? Math.round(value) : '-';
}

function productionGateLabel(row) {
  if (!row?.specialDetailingRequired) return '-';
  const status = row.productionGateStatus || 'UNRESOLVED';
  const mode = row.productionGateMode ? `/${row.productionGateMode}` : '';
  const source = row.productionGateSource ? `/${row.productionGateSource}` : '';
  const blockers = Array.isArray(row.productionGateBlockers)
    ? row.productionGateBlockers.filter(Boolean).join('|')
    : '';
  return `${status}${mode}${source}${blockers ? `: ${blockers}` : ''}`;
}

function partialCheckLabel(row) {
  switch (row?.requirementKind) {
    case 'L2':
      return 'L2全長のみ判定';
    case 'LB_PROJECTION':
      return '投影のみ判定';
    case 'HOOK_TAIL_90':
      return '90°余長のみ判定';
    default:
      return '部分判定';
  }
}

/** 一覧の列定義（CSVと表で共有する） */
const COLUMNS = [
  { key: 'modelSource', label: 'モデル', text: true, value: (row) => row.modelSource },
  { key: 'category', label: '分類', text: true, value: (row) => row.category },
  { key: 'kind', label: '部材種別', text: true, value: (row) => row.kind },
  { key: 'name', label: '部材', text: true, value: (row) => row.elementName || row.elementId },
  { key: 'section', label: '断面', text: true, value: (row) => row.sectionName || '-' },
  { key: 'position', label: '位置', text: true, value: (row) => row.position || '-' },
  { key: 'role', label: '対象', text: true, value: (row) => ROLE_LABELS[row.role] || row.role },
  {
    key: 'bar',
    label: '呼び径',
    text: true,
    value: (row) => (Number.isFinite(row.diaMm) ? `D${row.diaMm}` : '-'),
  },
  { key: 'grade', label: '鉄筋種別', text: true, value: (row) => row.grade || '-' },
  { key: 'fc', label: 'Fc', value: (row) => row.fc ?? '-' },
  { key: 'count', label: '本数', value: (row) => row.count },
  { key: 'required', label: '必要長さ', value: (row) => roundOrDash(row.requiredMm) },
  { key: 'available', label: '確保長さ', value: (row) => roundOrDash(row.availableMm) },
  {
    key: 'ratio',
    label: '余裕',
    value: (row) =>
      Number.isFinite(row.availableMm) && row.requiredMm > 0
        ? (row.availableMm / row.requiredMm).toFixed(2)
        : '-',
  },
  {
    key: 'generation',
    label: '生成状態',
    text: true,
    value: (row) => {
      // Production Gateを評価した行は、requirementOnlyより実際の生成状態を優先する。
      if (row.productionGateEvaluated === true) {
        if (row.generationStatus === 'CENTERLINE_READY') return '中心線生成対象';
        if (row.productionPathCandidate || row.productionPlacementCandidate)
          return 'production候補';
        if (row.generationStatus === 'UNRESOLVED') return '未生成・要確認';
        if (row.generationStatus === 'NOT_APPLICABLE') return '対象外';
        return '-';
      }
      return row.requirementOnly
        ? row.kind === '基礎小梁（R12対象外）'
          ? 'R12対象外'
          : row.partialCheck
            ? partialCheckLabel(row)
            : '必要長さのみ'
        : row.generationStatus === 'CENTERLINE_READY'
          ? '中心線生成対象'
          : row.productionPathCandidate || row.productionPlacementCandidate
            ? 'production候補'
            : row.generationStatus === 'UNRESOLVED'
              ? '未生成・要確認'
              : '-';
    },
  },
  {
    key: 'productionGate',
    label: 'Production Gate',
    text: true,
    value: productionGateLabel,
  },
  { key: 'note', label: '備考', text: true, value: (row) => row.note || '' },
];

/**
 * 判定の表示文字列を返す
 * @param {boolean|null} ok - 判定
 * @returns {string} 'OK' | 'NG' | '—'
 */
function judgeLabel(ok) {
  if (ok === true) return 'OK';
  if (ok === false) return 'NG';
  return '—';
}

/**
 * 判定行から表を組み立てる
 * @param {Array<Object>} rows - 判定行
 * @returns {HTMLElement} 表要素
 */
function buildTable(rows) {
  const table = document.createElement('table');

  const headerRow = document.createElement('tr');
  for (const column of COLUMNS) {
    const th = document.createElement('th');
    if (column.text) th.className = 'text';
    th.textContent = column.label;
    headerRow.appendChild(th);
  }
  const judgeTh = document.createElement('th');
  judgeTh.textContent = '判定';
  headerRow.appendChild(judgeTh);
  table.appendChild(headerRow);

  for (const row of rows) {
    const tr = document.createElement('tr');
    if (row.ok === false) tr.className = 'is-ng';
    for (const column of COLUMNS) {
      const td = document.createElement('td');
      if (column.text) td.className = 'text';
      // 部材名・断面名・gate blocker等は必ず textContent で挿入する
      td.textContent = String(column.value(row));
      tr.appendChild(td);
    }
    const judgeTd = document.createElement('td');
    if (row.ok !== null) judgeTd.className = row.ok ? 'judge-ok' : 'judge-ng';
    judgeTd.textContent = judgeLabel(row.ok);
    tr.appendChild(judgeTd);
    table.appendChild(tr);
  }
  return table;
}

/** 直近に算定した判定行（CSV保存で使う） */
let currentRows = [];

/**
 * 判定を再計算して表示を更新する
 */
function refresh() {
  const container = document.getElementById(`${WINDOW_ID}-table-container`);
  const summary = document.getElementById(`${WINDOW_ID}-summary`);
  const notes = document.getElementById(`${WINDOW_ID}-notes`);
  if (!container) return;

  const allRows = collectRebarAnchorageChecks(readOptions());
  currentRows = allRows;
  const rows = allRows.filter(
    (row) => (!categoryFilter || row.category === categoryFilter) && (!ngOnly || row.ok === false),
  );

  container.replaceChildren();
  if (allRows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'anchorage-empty';
    empty.textContent =
      '配筋情報を持つRC柱・RC梁が見つかりませんでした（梁の柱内定着には柱も必要です）。';
    container.appendChild(empty);
  } else if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'anchorage-empty';
    empty.textContent = '条件に合う行はありません。';
    container.appendChild(empty);
  } else {
    container.appendChild(buildTable(rows));
  }

  if (summary) {
    const ngCount = allRows.filter((row) => row.ok === false).length;
    const okCount = allRows.filter((row) => row.ok === true).length;
    summary.textContent =
      allRows.length === 0
        ? ''
        : `${allRows.length}件中 NG ${ngCount}件 / OK ${okCount}件 / 参考 ${allRows.length - ngCount - okCount}件`;
  }

  if (notes) {
    const rounded = allRows.some((row) => !row.exact);
    notes.textContent =
      '配筋ルールは日建連・JSCA 2023に基づきます。構造図が優先されます。' +
      '梁定着の確保長さは接続柱の実配筋と実配置から評価します。' +
      '小梁（要件）はR12-N/O/Pで上端筋の投影・90°余長・L2をbar-levelで部分判定し、R12-Q〜VでVERTICAL_90候補・実曲げ・identity・Production Gateを表示します。' +
      '下端L3/L3h・代替mode・main-bar trimは未判定・未生成です。' +
      '大梁仕口は同一直線の通し筋を優先し、水平位置差の自動折曲げは行いません。' +
      '大梁仕口の鉛直折曲げ候補は必要長さ6eと実柱主筋から解いたjtを比較します。' +
      '柱仕口納まりの必要長さ／確保長さは、それぞれ6e／梁主筋間隔jtです。' +
      '特殊納まりはProduction Gateのsource・mode・blockerを表示し、暗黙補完しません。' +
      '中心線生成対象・production候補は適合OKを意味せず、実曲げ半径や閉鎖形状など未生成の詳細があります。' +
      (rounded ? '未解決・標準補完を含む行は個別確認してください。' : '');
  }
}

/**
 * 判定結果をCSVとして保存する
 */
async function handleSaveCsv() {
  if (currentRows.length === 0) {
    const { showWarning } = await import('../common/toast.js');
    showWarning('保存する判定結果がありません。');
    return;
  }

  const escape = (value) => `"${String(value).replace(/"/g, '""')}"`;
  const lines = [
    [...COLUMNS.map((column) => column.label), '判定'].map(escape).join(','),
    ...currentRows.map((row) =>
      [...COLUMNS.map((column) => column.value(row)), judgeLabel(row.ok)].map(escape).join(','),
    ),
  ];
  // Excelでの文字化けを避けるためBOM付きUTF-8で出力する
  const blob = new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const { downloadBlob } = await import('../../utils/downloadHelper.js');
  downloadBlob(blob, '定着チェック一覧.csv');
}

/**
 * パネルを初期化する（アプリ起動時に1回呼ぶ）
 */
export function initializeAnchorageCheckPanel() {
  if (isInitialized) return;

  injectStyles();
  createWindowElement();

  floatingWindowManager.registerWindow({
    windowId: WINDOW_ID,
    toggleButtonId: 'openAnchorageCheckBtn',
    closeButtonId: `close-${WINDOW_ID}-btn`,
    headerId: `${WINDOW_ID}-header`,
    draggable: true,
    resizable: true,
    autoShow: false,
    onShow: refresh,
  });

  for (const id of [`${WINDOW_ID}-beam-cover`, `${WINDOW_ID}-column-cover`]) {
    document.getElementById(id)?.addEventListener('change', refresh);
  }
  document.getElementById(`${WINDOW_ID}-ng-only`)?.addEventListener('change', (event) => {
    ngOnly = event.target.checked;
    refresh();
  });
  document.getElementById(`${WINDOW_ID}-category`)?.addEventListener('change', (event) => {
    categoryFilter = event.target.value;
    refresh();
  });
  document.getElementById(`${WINDOW_ID}-csv-btn`)?.addEventListener('click', handleSaveCsv);

  isInitialized = true;
  log.info('AnchorageCheckPanel initialized');
}
