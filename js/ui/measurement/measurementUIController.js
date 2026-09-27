/**
 * @fileoverview 寸法測定UIコントローラー（Layer 5: ui）
 *
 * ツールバーボタンと測定パネルを管理する。
 * viewer/measurement/ とは直接 import せず、依存性注入と EventBus 経由で通信する。
 * canvas への CSS クラス付与（cursor変更）もここで担う。
 */

import { eventBus, MeasurementEvents } from '../../data/events/index.js';

/** @type {{enter:Function, exit:Function, deleteById:Function}|null} */
let _deps = null;
let _isActive = false;
/** @type {Function[]} イベント解除関数リスト */
let _unsubscribers = [];
/** @type {(event: MouseEvent) => void | null} カーソルツールチップ用mousemoveハンドラ */
let _tooltipMouseMoveRef = null;
let _isPointerOnMeasurementSurface = false;

/**
 * 測定UIを破棄する（テスト・再初期化時のクリーンアップ用）
 */
export function destroyMeasurementUI() {
  _unsubscribers.forEach((fn) => fn());
  _unsubscribers = [];
  _deps = null;
  _isActive = false;
  _removeCursorTooltipListener();
}

/**
 * 測定UIを初期化する（1度だけ呼ぶこと）
 * @param {{ enter: Function, exit: Function, deleteById: Function }} deps
 */
export function initMeasurementUI(deps) {
  if (_deps !== null) return; // 多重初期化防止
  _deps = deps;
  _setupButton();
  _setupEventListeners();
}

function _setupButton() {
  const btn = document.getElementById('toggle-measurement-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!_isActive) {
      _deps?.enter();
    } else {
      _deps?.exit();
    }
  });

  const closeBtn = document.getElementById('close-measurement-panel-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      _deps?.exit();
    });
  }
}

function _setupEventListeners() {
  const on = (event, handler) => {
    eventBus.on(event, handler);
    _unsubscribers.push(() => eventBus.off(event, handler));
  };

  on(MeasurementEvents.MODE_ENTERED, _onModeEntered);
  on(MeasurementEvents.MODE_EXITED, _onModeExited);
  on(MeasurementEvents.FIRST_POINT_PICKED, _onFirstPointPicked);
  on(MeasurementEvents.MEASUREMENT_COMPLETED, _onMeasurementCompleted);
  on(MeasurementEvents.MEASUREMENT_DELETED, _onMeasurementDeleted);
  on(MeasurementEvents.SEQUENCE_RESET, _onSequenceReset);
  on(MeasurementEvents.ALL_CLEARED, _onAllCleared);
}

function _onModeEntered() {
  _isActive = true;
  const btn = document.getElementById('toggle-measurement-btn');
  if (btn) {
    btn.classList.add('active');
    btn.setAttribute('aria-expanded', 'true');
  }
  const panel = document.getElementById('measurement-panel');
  if (panel) {
    panel.classList.remove('hidden');
    panel.classList.add('visible');
  }
  const canvas = document.getElementById('three-canvas');
  if (canvas) canvas.classList.add('measurement-mode');
  _setHint('面・点またはSTB図面の線をクリックして1点目を選択');
  _showStepIndicator();
  _setStep(1);
  _addCursorTooltipListener();
  _setCursorTooltip('1点目をクリック');
}

function _onModeExited() {
  // MODE_EXITED が ALL_CLEARED より先に来るため、ここで isActive を false にしてから list をクリア
  _isActive = false;
  const btn = document.getElementById('toggle-measurement-btn');
  if (btn) {
    btn.classList.remove('active');
    btn.setAttribute('aria-expanded', 'false');
  }
  const panel = document.getElementById('measurement-panel');
  if (panel) {
    panel.classList.add('hidden');
    panel.classList.remove('visible');
  }
  const canvas = document.getElementById('three-canvas');
  if (canvas) canvas.classList.remove('measurement-mode');
  _hideStepIndicator();
  _hideCursorTooltip();
  _removeCursorTooltipListener();
  _clearStep1Info();
}

function _onFirstPointPicked({ elementInfo } = {}) {
  _setHint('2点目をクリックして距離を測定（面の法線方向に投影）');
  _setStep(2);
  _setCursorTooltip('2点目をクリック');
  _setStep1Info(elementInfo);
}

function _onMeasurementCompleted({ id, distance }) {
  _setHint('面・点またはSTB図面の線をクリックして次の測定を開始');
  _setStep(1);
  _setCursorTooltip('1点目をクリック');
  _clearStep1Info();
  _addListItem(id, distance);
}

function _onMeasurementDeleted({ id }) {
  const item = document.querySelector(`#measurement-list [data-id="${id}"]`);
  if (item) item.remove();
}

function _onSequenceReset() {
  if (!_isActive) return;
  _setHint('面・点またはSTB図面の線をクリックして1点目を選択');
  _setStep(1);
  _setCursorTooltip('1点目をクリック');
  _clearStep1Info();
}

function _onAllCleared() {
  _clearList();
}

function _setHint(text) {
  const el = document.getElementById('measurement-hint');
  if (el) el.textContent = text;
}

// -------------------------------------------------------
// ステップインジケーター
// -------------------------------------------------------

function _showStepIndicator() {
  const el = document.getElementById('measurement-step-indicator');
  if (el) el.classList.remove('hidden');
}

function _hideStepIndicator() {
  const el = document.getElementById('measurement-step-indicator');
  if (el) el.classList.add('hidden');
}

/**
 * アクティブなステップを切り替える
 * @param {1|2} step
 */
function _setStep(step) {
  const s1 = document.getElementById('msi-step1');
  const s2 = document.getElementById('msi-step2');
  if (!s1 || !s2) return;

  if (step === 1) {
    s1.classList.add('active');
    s1.classList.remove('done');
    s2.classList.remove('active', 'done');
  } else {
    s1.classList.remove('active');
    s1.classList.add('done');
    s2.classList.add('active');
    s2.classList.remove('done');
  }
}

/**
 * ステップ1の選択要素情報を表示する
 * @param {{ elementLabel: string|null, elementName: string|null, modelSide: string|null }|null|undefined} elementInfo
 */
function _setStep1Info(elementInfo) {
  const el = document.getElementById('msi-step1-info');
  if (!el) return;
  if (!elementInfo?.elementLabel) {
    el.textContent = '';
    el.classList.add('hidden');
    return;
  }
  let text = elementInfo.elementLabel;
  if (elementInfo.elementName) text += ` "${elementInfo.elementName}"`;
  if (elementInfo.modelSide) text += ` [${elementInfo.modelSide}]`;
  el.textContent = text;
  el.classList.remove('hidden');
}

function _clearStep1Info() {
  const el = document.getElementById('msi-step1-info');
  if (!el) return;
  el.textContent = '';
  el.classList.add('hidden');
}

// -------------------------------------------------------
// カーソル追従ツールチップ
// -------------------------------------------------------

function _isMeasurementSurface(target) {
  const canvas = document.getElementById('three-canvas');
  if (target === canvas) return true;
  return Boolean(target?.closest?.('#pdf-overlay-stage'));
}

function _addCursorTooltipListener() {
  _removeCursorTooltipListener();
  _tooltipMouseMoveRef = (e) => {
    const tooltip = document.getElementById('measurement-cursor-tooltip');
    if (!tooltip) return;
    _isPointerOnMeasurementSurface = _isMeasurementSurface(e.target);
    if (_isPointerOnMeasurementSurface && _isActive) {
      tooltip.style.left = `${e.clientX}px`;
      tooltip.style.top = `${e.clientY}px`;
      tooltip.classList.remove('hidden');
    } else {
      tooltip.classList.add('hidden');
    }
  };
  document.addEventListener('pointermove', _tooltipMouseMoveRef, { passive: true });
}

function _removeCursorTooltipListener() {
  if (_tooltipMouseMoveRef) document.removeEventListener('pointermove', _tooltipMouseMoveRef);
  _tooltipMouseMoveRef = null;
  _isPointerOnMeasurementSurface = false;
}

function _setCursorTooltip(text) {
  const tooltip = document.getElementById('measurement-cursor-tooltip');
  if (!tooltip) return;
  tooltip.textContent = text;
  tooltip.classList.toggle('hidden', !_isPointerOnMeasurementSurface);
}

function _hideCursorTooltip() {
  _isPointerOnMeasurementSurface = false;
  const tooltip = document.getElementById('measurement-cursor-tooltip');
  if (tooltip) tooltip.classList.add('hidden');
}

function _addListItem(id, distance) {
  const list = document.getElementById('measurement-list');
  if (!list) return;
  const item = document.createElement('div');
  item.className = 'measurement-item';
  item.dataset.id = String(id);

  const span = document.createElement('span');
  span.className = 'measurement-distance';
  span.textContent = `📏 ${Math.round(distance).toLocaleString()} mm`;

  const btn = document.createElement('button');
  btn.className = 'measurement-delete-btn';
  btn.type = 'button';
  btn.title = '削除';
  btn.textContent = '✕';
  btn.addEventListener('click', () => eventBus.emit(MeasurementEvents.DELETE_REQUESTED, { id }));

  item.appendChild(span);
  item.appendChild(btn);
  list.appendChild(item);
}

function _clearList() {
  const list = document.getElementById('measurement-list');
  if (list) list.replaceChildren();
}
