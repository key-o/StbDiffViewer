/**
 * @fileoverview 梁貫通孔配置可能範囲図パネル
 *
 * 選択された大梁/小梁を含む連続梁について、柱・梁サイズ・通り芯名・主筋の
 * カットオフ位置・柱内定着（のみこみ）・貫通孔（ダイヤレンNS等）の配置可能範囲を
 * 立面SVGで表示する。かぶり・あき係数・孔径/孔位置を変更すると、鉄筋どうしや
 * 貫通孔との干渉判定を再計算して図と判定表に反映する。
 *
 * 3Dビューのコンテキストメニューから OPEN_BEAM_OPENING_DIAGRAM で開き、
 * 表示中は要素選択に追従する。
 *
 * @module ui/panels/beamOpeningDiagram/BeamOpeningDiagramPanel
 */

import { floatingWindowManager } from '../floatingWindowManager.js';
import { getState } from '../../../data/state/globalState.js';
import { eventBus, InteractionEvents, SelectionEvents } from '../../../data/events/index.js';
import {
  extractBeamElevationData,
  computeRebarLayout,
  createDefaultRebarSettings,
} from '../../../data/extractors/beamElevation/index.js';
import {
  renderBeamElevationSvg,
  serializeBeamElevationSvg,
} from '../../../components/beamElevationVisual/BeamElevationRenderer.js';
import { REBAR_SPACING_RULES } from '../../../constants/beamOpeningRules.js';
import { downloadBlob } from '../../../utils/downloadHelper.js';
import { showWarning } from '../../common/toast.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('BeamOpeningDiagramPanel');

const WINDOW_ID = 'beam-opening-diagram-float';
const STYLE_ID = 'beam-opening-diagram-styles';

/** レンダラーが図の左右に確保するマージン合計 [px] */
const SVG_SIDE_MARGIN_PX = 180;
/** 描画領域幅の下限 [px] */
const MIN_DRAW_WIDTH_PX = 360;

/** 現在表示中の対象（SVG保存・再描画用） */
let currentTarget = null;
let currentData = null;
let currentSvg = null;
let currentLayouts = [];
let rebarSettings = createDefaultRebarSettings();
let showContinuous = true;
/** null のとき全体表示、数値のときそのスパンにフォーカス */
let focusSpanIndex = null;
let isInitialized = false;

/**
 * パネル本文のスタイルを注入（初回のみ）
 */
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${WINDOW_ID} { width: 980px; max-width: 96vw; }
    #${WINDOW_ID} .beam-opening-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px 16px;
      margin-bottom: 8px;
      font-size: var(--font-size-sm);
    }
    #${WINDOW_ID} .beam-opening-toolbar label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
    }
    #${WINDOW_ID} .beam-opening-toolbar input[type='number'] {
      width: 68px;
      padding: 2px 4px;
      font-size: var(--font-size-sm);
    }
    #${WINDOW_ID} .beam-opening-toolbar select {
      padding: 2px 4px;
      font-size: var(--font-size-sm);
    }
    #${WINDOW_ID} .beam-opening-focus-bar { gap: 8px; }
    #${WINDOW_ID} .beam-opening-focus-bar input[type='range'] {
      flex: 1;
      min-width: 160px;
      accent-color: var(--color-primary, #1c7ed6);
    }
    #${WINDOW_ID} .beam-opening-step-btn {
      padding: 1px 8px;
      font-size: var(--font-size-sm);
      cursor: pointer;
    }
    #${WINDOW_ID} .beam-opening-step-btn:disabled { opacity: 0.4; cursor: default; }
    #${WINDOW_ID} .beam-opening-span-label {
      min-width: 96px;
      font-size: var(--font-size-xs);
      color: var(--color-text-muted, #6c757d);
    }
    #${WINDOW_ID} .beam-opening-info {
      color: var(--color-text-muted, #6c757d);
      font-size: var(--font-size-xs);
      flex-basis: 100%;
    }
    /*
     * SVGは等倍で表示する（width/height属性のまま）。
     * width:100% で縮小すると図中の文字だけが小さくなり、
     * 他ウィンドウとの文字サイズが揃わなくなるため。
     */
    #${WINDOW_ID} .beam-opening-svg-container {
      overflow: auto;
      max-height: 55vh;
      border: 1px solid var(--color-border, #dee2e6);
      background: #fff;
    }
    #${WINDOW_ID} .beam-opening-svg-container svg {
      display: block;
      max-width: none;
    }
    #${WINDOW_ID} .beam-opening-empty,
    #${WINDOW_ID} .beam-opening-error {
      padding: 24px;
      text-align: center;
      color: var(--color-text-muted, #6c757d);
    }
    #${WINDOW_ID} .beam-opening-error { color: var(--color-danger, #c92a2a); }
    #${WINDOW_ID} .beam-opening-checks {
      margin-top: 8px;
      max-height: 22vh;
      overflow: auto;
    }
    #${WINDOW_ID} .beam-opening-checks table {
      width: 100%;
      border-collapse: collapse;
      font-size: var(--font-size-xs);
    }
    #${WINDOW_ID} .beam-opening-checks th,
    #${WINDOW_ID} .beam-opening-checks td {
      border: 1px solid var(--color-border, #dee2e6);
      padding: 3px 6px;
      text-align: left;
    }
    #${WINDOW_ID} .beam-opening-checks th {
      background: var(--color-surface-alt, #f8f9fa);
    }
    #${WINDOW_ID} .beam-opening-checks td.num { text-align: right; }
    #${WINDOW_ID} .beam-opening-checks tr.ng { background: rgba(201, 42, 42, 0.08); }
    #${WINDOW_ID} .beam-opening-checks .judge-ok { color: #2b8a3e; font-weight: 600; }
    #${WINDOW_ID} .beam-opening-checks .judge-ng { color: #c92a2a; font-weight: 600; }
    #${WINDOW_ID} .beam-opening-notes {
      margin: 8px 0 0;
      font-size: var(--font-size-xs);
      color: var(--color-text-muted, #6c757d);
      line-height: 1.5;
    }
    #${WINDOW_ID} .beam-opening-notes .warning { color: var(--color-warning, #e8590c); }
  `;
  document.head.appendChild(style);
}

/**
 * ウィンドウDOMを生成
 */
function createWindowElement() {
  const factorOptions = REBAR_SPACING_RULES.clearanceDiaFactorOptions
    .map(
      (factor) =>
        `<option value="${factor}"${factor === rebarSettings.clearanceDiaFactor ? ' selected' : ''}>${factor}d</option>`,
    )
    .join('');

  const windowEl = document.createElement('div');
  windowEl.id = WINDOW_ID;
  windowEl.className = 'floating-window hidden';
  windowEl.innerHTML = `
    <div class="float-window-header" id="${WINDOW_ID}-header">
      <span class="float-window-title">⭕ 梁貫通孔 配置可能範囲図</span>
      <div class="float-window-controls">
        <button class="float-window-btn" id="${WINDOW_ID}-save-svg-btn" title="SVGファイルとして保存">SVG</button>
        <button class="float-window-btn" id="close-${WINDOW_ID}-btn">✕</button>
      </div>
    </div>
    <div class="float-window-content">
      <div class="beam-opening-toolbar">
        <label title="連続する同一直線上の梁をまとめて表示します">
          <input type="checkbox" id="${WINDOW_ID}-continuous" checked>
          連続梁を表示
        </label>
        <label title="あばら筋外面までの設計かぶり厚さ">
          かぶり
          <input type="number" id="${WINDOW_ID}-cover" min="0" max="200" step="5" value="${rebarSettings.coverMm}">
          mm
        </label>
        <label title="主筋のあきの最小値（呼び径倍率）。25mmと粗骨材1.25倍のうち大きい方を採用します">
          あき
          <select id="${WINDOW_ID}-clearance">${factorOptions}</select>
        </label>
        <label title="粗骨材の最大寸法">
          粗骨材
          <input type="number" id="${WINDOW_ID}-aggregate" min="5" max="40" step="5" value="${rebarSettings.maxAggregateSizeMm}">
          mm
        </label>
        <label title="検討する貫通孔の直径。空欄で上限値 min(D/3,750) を使用します">
          孔径 φ
          <input type="number" id="${WINDOW_ID}-hole-dia" min="0" max="1500" step="25" placeholder="上限">
          mm
        </label>
        <label title="孔中心の高さ（梁天端からの比率）">
          孔中心
          <input type="number" id="${WINDOW_ID}-hole-ratio" min="0.1" max="0.9" step="0.05" value="${rebarSettings.holeCenterRatio}">
          ×D
        </label>
        <label title="スラブ天端＝梁天端として扱います。空欄でモデルの値を使用（基礎の耐圧版など過大な値は手入力で調整）">
          スラブ厚
          <input type="number" id="${WINDOW_ID}-slab-depth" min="0" max="2000" step="10" placeholder="自動">
          mm
        </label>
        <label title="腹筋の必要段数は梁種別と梁せいで決まります。自動は STB の isFoundation 属性を優先し、無い場合は梁名で補完します">
          梁種別
          <select id="${WINDOW_ID}-beam-kind">
            <option value="auto" selected>自動（isFoundation/梁名）</option>
            <option value="general">一般梁</option>
            <option value="foundation">基礎梁</option>
          </select>
        </label>
        <label title="交差部ではX方向梁とY方向梁の主筋が重なります。内側（直交方向）の梁は主筋の最大外径ぶんかぶりが大きくなります">
          主筋位置
          <select id="${WINDOW_ID}-bar-direction">
            <option value="outer" selected>外側</option>
            <option value="inner">内側（直交方向）</option>
          </select>
        </label>
        <div class="beam-opening-info" id="${WINDOW_ID}-info"></div>
      </div>
      <div class="beam-opening-toolbar beam-opening-focus-bar">
        <label title="全体表示と単一スパンのフォーカス表示を切り替えます">
          表示
          <select id="${WINDOW_ID}-view-mode">
            <option value="all" selected>全体</option>
            <option value="single">単一スパン</option>
          </select>
        </label>
        <button type="button" class="beam-opening-step-btn" id="${WINDOW_ID}-prev-span" title="前のスパン">◀</button>
        <input type="range" id="${WINDOW_ID}-span-slider" min="1" max="1" step="1" value="1" disabled>
        <button type="button" class="beam-opening-step-btn" id="${WINDOW_ID}-next-span" title="次のスパン">▶</button>
        <span class="beam-opening-span-label" id="${WINDOW_ID}-span-label">-</span>
      </div>
      <div class="beam-opening-svg-container" id="${WINDOW_ID}-svg-container">
        <div class="beam-opening-empty">3Dビューで大梁/小梁を選択し、右クリックメニューから開いてください</div>
      </div>
      <div class="beam-opening-checks" id="${WINDOW_ID}-checks"></div>
      <div class="beam-opening-notes" id="${WINDOW_ID}-notes"></div>
    </div>
  `;
  document.body.appendChild(windowEl);
}

/**
 * modelSource から対象XMLドキュメントを解決
 * @param {string|null} modelSource - 'matched' | 'onlyA' | 'onlyB' | 'A' | 'B'
 * @returns {{doc: Document|null, label: string}}
 */
function resolveDocument(modelSource) {
  const preferB = modelSource === 'onlyB' || modelSource === 'B';
  const docA = getState('models.documentA');
  const docB = getState('models.documentB');
  if (preferB) {
    return { doc: docB || docA, label: docB ? 'モデルB' : 'モデルA' };
  }
  return { doc: docA || docB, label: docA ? 'モデルA' : 'モデルB' };
}

/**
 * エラー/警告文には要素ID等のXML由来文字列が含まれ得るため、必ずtextContentで挿入する
 * @param {HTMLElement} parent - 追加先
 * @param {string} className - CSSクラス
 * @param {string} text - 表示文字列
 */
function appendMessage(parent, className, text) {
  const div = document.createElement('div');
  div.className = className;
  div.textContent = text;
  parent.appendChild(div);
}

/**
 * 抽出済みデータからSVGを生成して貼り替える。
 * SVGは等倍表示のため、描画幅はコンテナの実寸に合わせて決める。
 */
function paintDiagram() {
  const container = document.getElementById(`${WINDOW_ID}-svg-container`);
  if (!container || !currentData) return;

  currentLayouts = currentData.spans.map((span) => computeRebarLayout(span, rebarSettings));

  const available = container.clientWidth - SVG_SIDE_MARGIN_PX - 16;
  const drawWidth = Math.max(available, MIN_DRAW_WIDTH_PX);

  const { svg } = renderBeamElevationSvg(currentData, {
    drawWidth,
    layouts: currentLayouts,
    focusSpanIndex,
  });
  container.innerHTML = '';
  container.appendChild(svg);
  currentSvg = svg;

  renderChecks();
}

/**
 * 干渉・あきの判定表を描画する（選択スパンの結果）
 */
function renderChecks() {
  const checksEl = document.getElementById(`${WINDOW_ID}-checks`);
  if (!checksEl) return;
  checksEl.innerHTML = '';
  if (!currentData || currentLayouts.length === 0) return;

  const index = focusSpanIndex ?? currentData.selectedSpanIndex ?? 0;
  const layout = currentLayouts[index];
  const span = currentData.spans[index];
  if (!layout) return;

  const table = document.createElement('table');
  const caption = document.createElement('caption');
  caption.style.cssText = 'text-align:left;padding:2px 0;font-size:var(--font-size-xs);';
  caption.textContent =
    `配筋チェック（${span.name || `スパン${index + 1}`}／かぶり${layout.coverMm}mm・` +
    `あき${layout.settings.clearanceDiaFactor}d・粗骨材${layout.settings.maxAggregateSizeMm}mm）`;
  table.appendChild(caption);

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const text of ['項目', '算定値', '判定基準', '判定', '備考']) {
    const th = document.createElement('th');
    th.textContent = text;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const check of layout.checks) {
    const tr = document.createElement('tr');
    if (!check.ok) tr.className = 'ng';

    const cells = [
      { text: check.label },
      {
        text: check.comparison === 'info' ? `${check.actual}段` : `${check.actual.toFixed(1)} mm`,
        className: 'num',
      },
      {
        text:
          check.comparison === 'info'
            ? '-'
            : `${check.comparison === 'max' ? '≤' : '≥'} ${check.required.toFixed(1)} mm`,
        className: 'num',
      },
      {
        text: check.comparison === 'info' ? '参考' : check.ok ? 'OK' : 'NG',
        className: check.comparison === 'info' ? '' : check.ok ? 'judge-ok' : 'judge-ng',
      },
      { text: check.note || '' },
    ];
    for (const cell of cells) {
      const td = document.createElement('td');
      td.textContent = cell.text;
      if (cell.className) td.className = cell.className;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  checksEl.appendChild(table);
}

/**
 * 図を描画する
 * @param {{elementType: string, elementId: string, modelSource?: string}} target - 対象要素
 */
function renderDiagram(target) {
  const container = document.getElementById(`${WINDOW_ID}-svg-container`);
  const infoEl = document.getElementById(`${WINDOW_ID}-info`);
  const notesEl = document.getElementById(`${WINDOW_ID}-notes`);
  const checksEl = document.getElementById(`${WINDOW_ID}-checks`);
  if (!container) return;

  const { doc, label } = resolveDocument(target.modelSource);
  container.innerHTML = '';
  if (notesEl) notesEl.innerHTML = '';
  if (checksEl) checksEl.innerHTML = '';
  currentSvg = null;
  currentData = null;
  currentLayouts = [];

  if (!doc) {
    appendMessage(container, 'beam-opening-error', 'モデルが読み込まれていません');
    return;
  }

  const data = extractBeamElevationData(doc, target.elementType, target.elementId, {
    continuous: showContinuous,
  });

  if (data.error) {
    appendMessage(container, 'beam-opening-error', data.error);
    if (infoEl) {
      infoEl.textContent = `${label} / ${target.elementType} id=${target.elementId}`;
    }
    return;
  }

  currentData = data;
  currentTarget = target;
  // 単一スパン表示中に別の梁を選び直した場合は、選択スパンへ合わせる
  if (focusSpanIndex !== null) {
    focusSpanIndex = Math.min(data.selectedSpanIndex ?? 0, data.spans.length - 1);
  }
  updateFocusControls();
  paintDiagram();

  if (infoEl) {
    const axisLabel = data.axisLine ? `${data.axisLine}通り / ` : '';
    const spanLabel = data.isContinuous ? ` / ${data.spans.length}スパン` : '';
    infoEl.textContent =
      `${label} / ${axisLabel}${data.beam.elementType} id=${data.beam.id}` +
      (data.beam.name ? ` (${data.beam.name})` : '') +
      spanLabel;
  }

  if (notesEl) {
    for (const warning of data.warnings || []) {
      appendMessage(notesEl, 'warning', `⚠ ${warning}`);
    }
    appendMessage(notesEl, '', `※ ${data.disclaimer}`);
  }

  log.info(
    `貫通孔配置図を描画: ${data.beam.elementType} id=${data.beam.id} spans=${data.spans.length}`,
  );
}

/**
 * 表示モード・スパン送りUIの状態を現在のデータに合わせて更新する
 */
function updateFocusControls() {
  const slider = document.getElementById(`${WINDOW_ID}-span-slider`);
  const label = document.getElementById(`${WINDOW_ID}-span-label`);
  const prevBtn = document.getElementById(`${WINDOW_ID}-prev-span`);
  const nextBtn = document.getElementById(`${WINDOW_ID}-next-span`);
  const spanCount = currentData?.spans.length || 0;
  const isSingle = focusSpanIndex !== null;

  if (slider) {
    slider.min = '1';
    slider.max = String(Math.max(spanCount, 1));
    slider.disabled = !isSingle || spanCount < 2;
    if (isSingle) slider.value = String(focusSpanIndex + 1);
  }
  if (prevBtn) prevBtn.disabled = !isSingle || focusSpanIndex <= 0;
  if (nextBtn) nextBtn.disabled = !isSingle || focusSpanIndex >= spanCount - 1;
  if (label) {
    if (!spanCount) {
      label.textContent = '-';
    } else if (isSingle) {
      const span = currentData.spans[focusSpanIndex];
      label.textContent = `${focusSpanIndex + 1}/${spanCount}: ${span?.name || `スパン${focusSpanIndex + 1}`}`;
    } else {
      label.textContent = `全${spanCount}スパン`;
    }
  }
}

/**
 * フォーカスするスパンを変更して再描画する
 * @param {number|null} index - スパン番号（0始まり）。null で全体表示
 */
function setFocusSpan(index) {
  const spanCount = currentData?.spans.length || 0;
  focusSpanIndex =
    index === null || spanCount === 0 ? null : Math.min(Math.max(index, 0), spanCount - 1);
  updateFocusControls();
  paintDiagram();
}

/**
 * 現在の対象で再抽出・再描画する（連続梁の切替時など）
 */
function reloadDiagram() {
  if (currentTarget) renderDiagram(currentTarget);
}

/**
 * 設定UIの値を rebarSettings に取り込む
 */
function readSettingsFromControls() {
  // 入力欄のmin/maxへ丸める（IME経由等でHTML制約を外れた値が届くため）
  const numberValue = (id, fallback, min, max) => {
    const el = document.getElementById(id);
    if (!el || el.value === '') return fallback;
    const value = Number(el.value);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(Math.max(value, min), max);
  };

  const holeInput = document.getElementById(`${WINDOW_ID}-hole-dia`);
  const clearanceSelect = document.getElementById(`${WINDOW_ID}-clearance`);
  const slabInput = document.getElementById(`${WINDOW_ID}-slab-depth`);
  const beamKindSelect = document.getElementById(`${WINDOW_ID}-beam-kind`);
  const barDirectionSelect = document.getElementById(`${WINDOW_ID}-bar-direction`);

  rebarSettings = {
    ...rebarSettings,
    coverMm: numberValue(`${WINDOW_ID}-cover`, rebarSettings.coverMm, 0, 200),
    maxAggregateSizeMm: numberValue(
      `${WINDOW_ID}-aggregate`,
      rebarSettings.maxAggregateSizeMm,
      5,
      40,
    ),
    holeCenterRatio: numberValue(
      `${WINDOW_ID}-hole-ratio`,
      rebarSettings.holeCenterRatio,
      0.1,
      0.9,
    ),
    clearanceDiaFactor: Number.isFinite(Number(clearanceSelect?.value))
      ? Number(clearanceSelect.value)
      : rebarSettings.clearanceDiaFactor,
    holeDiameterMm:
      holeInput && holeInput.value !== ''
        ? numberValue(`${WINDOW_ID}-hole-dia`, null, 0, 1500)
        : null,
    slabDepthMm:
      slabInput && slabInput.value !== ''
        ? numberValue(`${WINDOW_ID}-slab-depth`, null, 0, 2000)
        : null,
    // 'auto' のときは STBの isFoundation 属性を優先し、無い場合は梁名で補完した値を使う
    isFoundationBeam:
      !beamKindSelect || beamKindSelect.value === 'auto'
        ? null
        : beamKindSelect.value === 'foundation',
    isOrthogonalDirection: barDirectionSelect?.value === 'inner',
  };
}

/**
 * SVGファイルとして保存
 */
function handleSaveSvg() {
  if (!currentSvg) {
    showWarning('保存する図がありません。');
    return;
  }
  const name = currentTarget
    ? `beam-opening-${currentTarget.elementType}-${currentTarget.elementId}`
    : 'beam-opening-diagram';
  const source = serializeBeamElevationSvg(currentSvg);
  downloadBlob(new Blob([source], { type: 'image/svg+xml' }), `${name}.svg`);
}

/**
 * ウィンドウリサイズに追従して等倍SVGを描き直す。
 * @param {HTMLElement} container - SVGコンテナ
 */
function observeContainerResize(container) {
  if (typeof ResizeObserver !== 'function') return;

  let scheduled = false;
  let lastWidth = 0;
  const observer = new ResizeObserver(() => {
    if (!currentData || scheduled) return;
    if (Math.abs(container.clientWidth - lastWidth) < 1) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      lastWidth = container.clientWidth;
      paintDiagram();
    });
  });
  observer.observe(container);
}

/**
 * 設定UIのイベントを登録する
 */
function setupSettingsListeners() {
  const settingIds = [
    `${WINDOW_ID}-cover`,
    `${WINDOW_ID}-aggregate`,
    `${WINDOW_ID}-hole-dia`,
    `${WINDOW_ID}-hole-ratio`,
    `${WINDOW_ID}-clearance`,
    `${WINDOW_ID}-slab-depth`,
    `${WINDOW_ID}-beam-kind`,
    `${WINDOW_ID}-bar-direction`,
  ];
  for (const id of settingIds) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('change', () => {
      readSettingsFromControls();
      paintDiagram();
    });
  }

  const continuousEl = document.getElementById(`${WINDOW_ID}-continuous`);
  if (continuousEl) {
    continuousEl.addEventListener('change', () => {
      showContinuous = continuousEl.checked;
      reloadDiagram();
    });
  }

  const viewModeEl = document.getElementById(`${WINDOW_ID}-view-mode`);
  if (viewModeEl) {
    viewModeEl.addEventListener('change', () => {
      setFocusSpan(viewModeEl.value === 'single' ? (currentData?.selectedSpanIndex ?? 0) : null);
    });
  }

  const slider = document.getElementById(`${WINDOW_ID}-span-slider`);
  if (slider) {
    slider.addEventListener('input', () => setFocusSpan(Number(slider.value) - 1));
  }

  const prevBtn = document.getElementById(`${WINDOW_ID}-prev-span`);
  if (prevBtn) {
    prevBtn.addEventListener('click', () => setFocusSpan((focusSpanIndex ?? 0) - 1));
  }
  const nextBtn = document.getElementById(`${WINDOW_ID}-next-span`);
  if (nextBtn) {
    nextBtn.addEventListener('click', () => setFocusSpan((focusSpanIndex ?? 0) + 1));
  }
}

/**
 * パネルを初期化する（アプリ起動時に1回呼ぶ）
 */
export function initializeBeamOpeningDiagramPanel() {
  if (isInitialized) return;

  injectStyles();
  createWindowElement();

  floatingWindowManager.registerWindow({
    windowId: WINDOW_ID,
    closeButtonId: `close-${WINDOW_ID}-btn`,
    headerId: `${WINDOW_ID}-header`,
    draggable: true,
    resizable: true,
    autoShow: false,
  });

  const saveBtn = document.getElementById(`${WINDOW_ID}-save-svg-btn`);
  if (saveBtn) {
    saveBtn.addEventListener('click', handleSaveSvg);
  }

  setupSettingsListeners();

  const container = document.getElementById(`${WINDOW_ID}-svg-container`);
  if (container) {
    observeContainerResize(container);
  }

  // コンテキストメニュー等からの表示要求
  eventBus.on(InteractionEvents.OPEN_BEAM_OPENING_DIAGRAM, (payload = {}) => {
    const { elementType, elementId, elementIdA, elementIdB, modelSource } = payload;
    const id = elementId ?? elementIdA ?? elementIdB;
    if (!elementType || !id) return;
    floatingWindowManager.showWindow(WINDOW_ID);
    renderDiagram({ elementType, elementId: String(id), modelSource });
  });

  // 表示中は梁の選択に追従して更新
  eventBus.on(SelectionEvents.ELEMENT_SELECTED, (payload = {}) => {
    if (!floatingWindowManager.isWindowVisible(WINDOW_ID)) return;
    const { elementType, elementId, elementIdA, elementIdB, modelSource } = payload;
    if (elementType !== 'Girder' && elementType !== 'Beam') return;
    const id = elementId ?? elementIdA ?? elementIdB;
    if (!id) return;
    renderDiagram({ elementType, elementId: String(id), modelSource });
  });

  isInitialized = true;
  log.info('BeamOpeningDiagramPanel initialized');
}
