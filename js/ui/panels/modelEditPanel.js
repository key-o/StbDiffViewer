/**
 * @fileoverview モデル編集専用の上部リボンUI。
 *
 * Revit系の操作感に寄せて、履歴・新規作成・配置基準・CAD操作を
 * 編集モード中だけ画面上端の横並びコマンド群へ集約する。
 * 編集モードへの入口自体は従来どおり「出力・変換」内に残す。
 * semantic mutation は従来どおり EditingSession / cadOperationService / Working Command を正本とする。
 */

import { getSelectedObjects } from '../../app/controllers/interactionController.js';
import { createSemanticSelectionIdentity } from '../../app/controllers/interaction/semanticSelection.js';
import editingSession from '../../app/editing/editingSession.js';
import { eventBus, EditEvents } from '../../data/events/index.js';
import { showError } from '../common/toast.js';
import { isEditMode } from './element-info/editMode/editState.js';
import {
  PLACEMENT_TYPES,
  ensurePlacementContext,
  getPlacementContext,
  getPlacementTargets,
  placementContextFromSelection,
  setPlacementContext,
} from './modelEditPlacementContext.js';

const RIBBON_ID = 'model-edit-ribbon';
const STYLE_ID = 'model-edit-ribbon-styles';
const COLLAPSED_BODY_CLASS = 'model-edit-ribbon-collapsed';
let initialized = false;
let createObserver = null;

const CREATE_COMMANDS = [
  ['Node', '節点', '•'],
  ['Column', '柱', '▯'],
  ['Post', '間柱', '┃'],
  ['Girder', '大梁', '━'],
  ['Beam', '小梁', '─'],
  ['Brace', 'ブレース', '╱'],
  ['Slab', '床', '▱'],
  ['Wall', '壁', '▥'],
  ['Pile', '杭', '↓'],
  ['Footing', '基礎', '▰'],
  ['FoundationColumn', '基礎柱', '⌗'],
  ['Parapet', 'パラペット', '▤'],
  ['Story', '階', '≡'],
  ['Axis', '通り芯', '│'],
  ['ArcAxis', '円弧軸', '⌒'],
  ['RadialAxis', '放射軸', '✳'],
];

const EXTENSION_COMMANDS = {
  'add-joint-button': { label: '継手', icon: '⛓' },
  'add-open-button': { label: '開口', icon: '□' },
  'manage-joint-arrangement-button': { label: '継手配置', icon: '☷' },
};

function ensureRibbonStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const link = document.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = './style/components/model-edit-ribbon.css';
  document.head.appendChild(link);
}

function createIconCommand({ id, icon, label, title = label, className = '' }) {
  const button = document.createElement('button');
  button.type = 'button';
  if (id) button.id = id;
  button.className = `model-edit-ribbon-command ${className}`.trim();
  button.title = title;
  button.setAttribute('aria-label', label);

  const iconEl = document.createElement('span');
  iconEl.className = 'model-edit-ribbon-command-icon';
  iconEl.setAttribute('aria-hidden', 'true');
  iconEl.textContent = icon;

  const labelEl = document.createElement('span');
  labelEl.className = 'model-edit-ribbon-command-label';
  labelEl.textContent = label;

  button.replaceChildren(iconEl, labelEl);
  return button;
}

function createRibbon() {
  if (document.getElementById(RIBBON_ID)) return;

  const ribbon = document.createElement('div');
  ribbon.id = RIBBON_ID;
  ribbon.className = 'model-edit-ribbon';
  ribbon.hidden = true;
  ribbon.setAttribute('aria-hidden', 'true');
  ribbon.setAttribute('role', 'region');
  ribbon.setAttribute('aria-label', 'モデル編集リボン');
  ribbon.innerHTML = `
    <div class="model-edit-ribbon-tabbar">
      <button type="button" class="model-edit-ribbon-tab active" aria-current="page">✎ 編集</button>
      <div class="model-edit-ribbon-status" aria-live="polite">
        <span id="model-edit-session-active" class="model-edit-session-badge">Inactive</span>
        <span id="model-edit-session-dirty">clean</span>
        <span>rev.<span id="model-edit-session-revision">0</span></span>
        <span id="model-edit-summary-slot"></span>
      </div>
      <button type="button" id="model-edit-ribbon-collapse" class="model-edit-ribbon-collapse"
        aria-expanded="true" title="編集リボンを折りたたむ">⌃</button>
    </div>

    <div class="model-edit-ribbon-body">
      <section class="model-edit-ribbon-group model-edit-ribbon-group-core" aria-label="編集履歴">
        <div class="model-edit-ribbon-group-content model-edit-ribbon-core-actions">
          <button type="button" id="model-edit-undo-button" class="model-edit-ribbon-command" disabled>
            <span class="model-edit-ribbon-command-icon" aria-hidden="true">↶</span>
            <span class="model-edit-ribbon-command-label">元に戻す</span>
          </button>
          <button type="button" id="model-edit-redo-button" class="model-edit-ribbon-command" disabled>
            <span class="model-edit-ribbon-command-icon" aria-hidden="true">↷</span>
            <span class="model-edit-ribbon-command-label">やり直し</span>
          </button>
        </div>
        <div class="model-edit-ribbon-group-label">編集</div>
      </section>

      <section class="model-edit-ribbon-group model-edit-ribbon-group-create" aria-label="新規作成">
        <div class="model-edit-ribbon-group-content model-edit-ribbon-create-wrap">
          <div id="model-edit-explicit-create-actions" class="model-edit-ribbon-create-actions"></div>
          <div id="model-edit-create-extension-actions" class="model-edit-ribbon-create-actions"></div>
        </div>
        <div class="model-edit-ribbon-group-label">新規作成</div>
      </section>

      <section class="model-edit-ribbon-group model-edit-ribbon-group-placement" aria-label="配置基準">
        <div class="model-edit-ribbon-group-content model-edit-placement-controls">
          <select id="model-edit-placement-type" class="model-edit-placement-select" aria-label="配置基準種別"></select>
          <select id="model-edit-placement-target" class="model-edit-placement-select" aria-label="配置基準対象"></select>
          <button type="button" id="model-edit-placement-from-selection" class="model-edit-ribbon-command model-edit-placement-pick"
            title="現在選択している大梁・小梁・床を配置基準にする">
            <span class="model-edit-ribbon-command-icon" aria-hidden="true">⌖</span>
            <span class="model-edit-ribbon-command-label">選択要素</span>
          </button>
        </div>
        <div class="model-edit-ribbon-group-label">配置基準</div>
      </section>

      <section class="model-edit-ribbon-group model-edit-ribbon-group-cad" aria-label="修正">
        <div class="model-edit-ribbon-group-content">
          <div id="model-edit-cad-operations" class="model-edit-ribbon-cad-operations">
            <div class="add-member-summary">要素を選択すると MOVE / ALIGN / COPY を利用できます。</div>
          </div>
        </div>
        <div class="model-edit-ribbon-group-label">修正</div>
      </section>
    </div>
  `;

  document.body.appendChild(ribbon);
}

function setupCollapseButton() {
  const button = document.getElementById('model-edit-ribbon-collapse');
  const ribbon = document.getElementById(RIBBON_ID);
  if (!button || !ribbon) return;

  button.addEventListener('click', () => {
    const collapsed = !document.body.classList.contains(COLLAPSED_BODY_CLASS);
    document.body.classList.toggle(COLLAPSED_BODY_CLASS, collapsed);
    ribbon.classList.toggle('collapsed', collapsed);
    button.textContent = collapsed ? '⌄' : '⌃';
    button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    button.title = collapsed ? '編集リボンを展開する' : '編集リボンを折りたたむ';
  });
}

function moveExistingEditControls() {
  const editButton = document.getElementById('edit-mode-button');
  const memberButton = document.getElementById('add-member-button');
  const summary = document.getElementById('editing-summary');

  const extensionSlot = document.getElementById('model-edit-create-extension-actions');
  const summarySlot = document.getElementById('model-edit-summary-slot');

  // 編集モードへの入口は「出力・変換」内の元位置を維持する。
  // editModeToggle.js は id で配線するため、場所を変えなくても既存契約をそのまま使える。
  if (editButton) {
    editButton.title = editButton.title || '編集モードをON/OFFします';
  }

  // 既存 initializer が継手/開口ボタンの挿入基準として参照するためDOMには残す。
  // ただし編集モード中だけ表示する作成コマンド群のアンカーとしてリボン側へ移す。
  if (memberButton && extensionSlot) {
    memberButton.classList.add('model-edit-ribbon-legacy-anchor');
    memberButton.hidden = true;
    memberButton.setAttribute('aria-hidden', 'true');
    extensionSlot.appendChild(memberButton);
  }

  if (summary && summarySlot) summarySlot.appendChild(summary);
}

function renderPlacementTargets() {
  const typeSelect = document.getElementById('model-edit-placement-type');
  const targetSelect = document.getElementById('model-edit-placement-target');
  if (!(typeSelect instanceof HTMLSelectElement) || !(targetSelect instanceof HTMLSelectElement))
    return;

  const current = ensurePlacementContext();
  typeSelect.value = current.type;
  const targets = getPlacementTargets(current.type);
  targetSelect.replaceChildren();

  if (targets.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = current.type === 'free' ? '座標指定' : '対象なし';
    targetSelect.appendChild(option);
    targetSelect.disabled = true;
    return;
  }

  targetSelect.disabled = false;
  for (const target of targets) {
    const option = document.createElement('option');
    option.value = String(target.id);
    option.textContent = target.label;
    option.selected = String(target.id) === String(current.targetId);
    targetSelect.appendChild(option);
  }
}

function setupPlacementControls() {
  const typeSelect = document.getElementById('model-edit-placement-type');
  const targetSelect = document.getElementById('model-edit-placement-target');
  const selectedButton = document.getElementById('model-edit-placement-from-selection');
  if (!(typeSelect instanceof HTMLSelectElement) || !(targetSelect instanceof HTMLSelectElement))
    return;

  for (const entry of PLACEMENT_TYPES) {
    const option = document.createElement('option');
    option.value = entry.value;
    option.textContent = entry.label;
    typeSelect.appendChild(option);
  }

  ensurePlacementContext();
  renderPlacementTargets();

  typeSelect.addEventListener('change', () => {
    setPlacementContext(typeSelect.value, null);
    renderPlacementTargets();
  });
  targetSelect.addEventListener('change', () => {
    setPlacementContext(typeSelect.value, targetSelect.value || null);
    renderPlacementTargets();
  });

  selectedButton?.addEventListener('click', () => {
    const identities = (getSelectedObjects?.() || [])
      .map((object) => createSemanticSelectionIdentity(object?.userData || {}))
      .filter(Boolean)
      .filter((identity) => !['B', 'onlyB'].includes(identity.modelSource));
    const adopted = identities.map(placementContextFromSelection).find(Boolean);
    if (!adopted) {
      showError('配置基準にできる Model A の大梁・小梁・床を選択してください。');
      return;
    }
    renderPlacementTargets();
  });
}

async function openCreateCommand(type, label, icon) {
  try {
    const { openAddMemberForm } = await import('./element-info/AddMemberForm.js');
    openAddMemberForm({
      initialType: type,
      lockType: true,
      placementContext: type === 'Node' ? getPlacementContext() : null,
      title: `${icon} ${label}を作成`,
    });
  } catch (error) {
    showError(
      `${label}作成フォームを開けませんでした: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function renderExplicitCreateCommands() {
  const container = document.getElementById('model-edit-explicit-create-actions');
  if (!container || container.childElementCount > 0) return;

  try {
    const { getNewMemberDefinitions } = await import('./element-info/editMode/index.js');
    const definitions = getNewMemberDefinitions?.() || {};
    for (const [type, label, icon] of CREATE_COMMANDS) {
      if (!definitions[type]) continue;
      const button = createIconCommand({
        id: `model-edit-create-${type}`,
        icon,
        label,
        title: `${label}を新規作成`,
        className: 'model-edit-ribbon-create-command',
      });
      button.dataset.createType = type;
      button.addEventListener('click', () => void openCreateCommand(type, label, icon));
      container.appendChild(button);
    }
  } catch (error) {
    showError(
      `新規作成コマンドを初期化できませんでした: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function decorateExtensionCommands() {
  const container = document.getElementById('model-edit-create-extension-actions');
  if (!container) return;
  for (const [id, config] of Object.entries(EXTENSION_COMMANDS)) {
    const button = document.getElementById(id);
    if (!button || button.dataset.ribbonDecorated === 'true') continue;
    button.dataset.ribbonDecorated = 'true';
    button.classList.add('model-edit-ribbon-command', 'model-edit-ribbon-create-command');
    button.title = button.title || config.label;
    const iconEl = document.createElement('span');
    iconEl.className = 'model-edit-ribbon-command-icon';
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.textContent = config.icon;
    const labelEl = document.createElement('span');
    labelEl.className = 'model-edit-ribbon-command-label';
    labelEl.textContent = config.label;
    button.replaceChildren(iconEl, labelEl);
  }
}

function observeExtensionCommands() {
  const container = document.getElementById('model-edit-create-extension-actions');
  if (!container || createObserver) return;
  decorateExtensionCommands();
  createObserver = new MutationObserver(() => decorateExtensionCommands());
  createObserver.observe(container, { childList: true });
}

function syncSessionStatus() {
  const state = editingSession.getState();
  const active = state?.active === true;
  const editModeActive = isEditMode();
  const historyCount = state?.history?.length || 0;
  const redoCount = state?.redoStack?.length || 0;
  const ribbon = document.getElementById(RIBBON_ID);
  const activeText = document.getElementById('model-edit-session-active');
  const dirtyText = document.getElementById('model-edit-session-dirty');
  const revisionText = document.getElementById('model-edit-session-revision');
  const undoButton = document.getElementById('model-edit-undo-button');
  const redoButton = document.getElementById('model-edit-redo-button');

  if (ribbon) {
    ribbon.hidden = !editModeActive;
    ribbon.setAttribute('aria-hidden', editModeActive ? 'false' : 'true');
  }
  document.body.classList.toggle('model-edit-ribbon-mounted', editModeActive);

  if (activeText) {
    activeText.textContent = active ? 'Editing' : 'Inactive';
    activeText.classList.toggle('active', active);
  }
  if (dirtyText) dirtyText.textContent = state?.dirty === true ? 'dirty' : 'clean';
  if (revisionText) revisionText.textContent = String(state?.workingRevision ?? 0);
  if (undoButton) {
    undoButton.disabled = !active || historyCount === 0;
    undoButton.title = `元に戻す (${historyCount}件)`;
  }
  if (redoButton) {
    redoButton.disabled = !active || redoCount === 0;
    redoButton.title = `やり直し (${redoCount}件)`;
  }
}

async function refreshCadOperationPanel() {
  if (!isEditMode()) return;
  try {
    const module = await import('./element-info/editMode/cadOperationPanel.js');
    module.mountCadOperationPanel?.({ containerId: 'model-edit-cad-operations' });
  } catch (error) {
    showError(
      `CAD操作リボンを更新できませんでした: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function initializeHistoryButtons() {
  document.getElementById('model-edit-undo-button')?.addEventListener('click', () => {
    try {
      editingSession.undo();
      syncSessionStatus();
      void refreshCadOperationPanel();
    } catch (error) {
      showError(`Undoできませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  document.getElementById('model-edit-redo-button')?.addEventListener('click', () => {
    try {
      editingSession.redo();
      syncSessionStatus();
      void refreshCadOperationPanel();
    } catch (error) {
      showError(`Redoできませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/**
 * 「出力・変換」にある編集モード入口は維持し、編集モード中だけ上部リボンを表示する。
 */
export function initializeModelEditPanel() {
  if (initialized) return;
  initialized = true;
  ensureRibbonStyles();
  createRibbon();
  setupCollapseButton();
  moveExistingEditControls();
  setupPlacementControls();
  observeExtensionCommands();
  void renderExplicitCreateCommands();
  initializeHistoryButtons();
  syncSessionStatus();

  eventBus.on(EditEvents.WORKING_DOCUMENT_CHANGED, () => {
    syncSessionStatus();
    renderPlacementTargets();
  });
  eventBus.on(EditEvents.MODE_TOGGLED, () => {
    syncSessionStatus();
    void refreshCadOperationPanel();
  });
}

export { syncSessionStatus };
