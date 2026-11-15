/**
 * @fileoverview モデル編集専用の上部リボンUI。
 *
 * Revit系の操作感に寄せて、履歴・新規作成・配置基準・CAD操作のコマンドを
 * 編集モード中だけ画面上端の横並びコマンド群へ集約する。選択要素ごとの数値入力や
 * 説明は要素情報パネル側に置き、リボンにはコマンドと設定だけを置く。
 * 編集モードへの入口自体は従来どおり「出力・変換」内に残す。
 * semantic mutation は従来どおり EditingSession / cadOperationService / Working Command を正本とする。
 */

import { getSelectedObjects } from '../../app/controllers/interactionController.js';
import { createSemanticSelectionIdentity } from '../../app/controllers/interaction/semanticSelection.js';
import editingSession from '../../app/editing/editingSession.js';
import { eventBus, EditEvents, UIEvents } from '../../data/events/index.js';
import {
  createRibbonCommand,
  decorateAsRibbonCommand,
  ribbonCommandHtml,
  ribbonGroupHtml,
  ribbonStackHtml,
  ribbonTabsHtml,
  wireRibbonTabs,
} from '../common/ribbon.js';
import { showError, showSuccess } from '../common/toast.js';
import { registerTopRibbon, refreshTopRibbonInset } from '../common/ribbonInset.js';
import { getState, setState } from '../../data/state/globalState.js';
import {
  collectAffectedElements,
  collectIdentityChanges,
  collectStructuralChanges,
} from '../../app/editing/editCommand.js';
import { isEditMode, setEditMode } from './element-info/editMode/editState.js';
import {
  PLACEMENT_TYPES,
  ensurePlacementContext,
  getPlacementContext,
  getPlacementTargets,
  placementContextFromSelection,
  setPlacementContext,
} from './modelEditPlacementContext.js';
import {
  historyGroupsHtml,
  initializeHistoryCommands,
  syncHistoryCommands,
} from './modelEditHistoryCommands.js';
import { initializeModifyTab, modifyTabBody, syncModifyTab } from './modelEditModifyTab.js';

const RIBBON_ID = 'model-edit-ribbon';
const STYLE_ID = 'model-edit-ribbon-styles';
const COLLAPSED_BODY_CLASS = 'model-edit-ribbon-collapsed';
let initialized = false;
let createObserver = null;
let registrationInProgress = false;

const CREATE_COMMANDS = [
  ['Node', '節点', 'node'],
  ['Column', '柱', 'column'],
  ['Post', '間柱', 'post'],
  ['Girder', '大梁', 'girder'],
  ['Beam', '小梁', 'beam'],
  ['Brace', 'ブレース', 'brace'],
  ['Slab', '床', 'slab'],
  ['Wall', '壁', 'wall'],
  ['Pile', '杭', 'pile'],
  ['Footing', '基礎', 'footing'],
  ['FoundationColumn', '基礎柱', 'foundationColumn'],
  ['Parapet', 'パラペット', 'parapet'],
  ['Story', '階', 'story'],
  ['Axis', '通り芯', 'axis'],
  ['ArcAxis', '円弧軸', 'arcAxis'],
  ['RadialAxis', '放射軸', 'radialAxis'],
];

const EXTENSION_COMMANDS = {
  'add-joint-button': { label: '継手', icon: 'joint' },
  'add-open-button': { label: '開口', icon: 'opening' },
  'manage-joint-arrangement-button': { label: '継手配置', icon: 'jointArrangement' },
};

function ensureRibbonStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const link = document.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = './style/components/model-edit-ribbon.css';
  document.head.appendChild(link);
}

function ribbonTabs() {
  return [
    {
      id: 'home',
      label: 'ホーム',
      body:
        historyGroupsHtml() +
        ribbonGroupHtml(
          'モデル登録',
          ribbonCommandHtml({
            id: 'model-edit-register-a',
            icon: 'modelA',
            label: 'モデルA',
            title:
              'Working Documentを検証し、モデルAとしてメモリ上で登録する（編集セッションは終了）',
          }) +
            ribbonCommandHtml({
              id: 'model-edit-register-b',
              icon: 'modelB',
              label: 'モデルB',
              title:
                'Working Documentを検証し、モデルBとしてメモリ上で登録する（編集セッションは終了）',
            }),
        ) +
        ribbonGroupHtml(
          '配置基準',
          ribbonStackHtml(
            `<select id="model-edit-placement-type" class="form-control" aria-label="配置基準種別"></select>
            <select id="model-edit-placement-target" class="form-control" aria-label="配置基準対象"></select>`,
          ) +
            ribbonCommandHtml({
              id: 'model-edit-placement-from-selection',
              icon: 'pickBasis',
              label: '選択要素',
              title: '現在選択している大梁・小梁・床を配置基準にする',
            }),
        ),
    },
    {
      id: 'create',
      label: '新規作成',
      body: ribbonGroupHtml(
        '新規作成',
        `<div id="model-edit-explicit-create-actions" class="model-edit-ribbon-create-actions"></div>
        <div id="model-edit-create-extension-actions" class="model-edit-ribbon-create-actions"></div>`,
        { className: 'model-edit-ribbon-group-create' },
      ),
    },
    {
      id: 'modify',
      label: '修正',
      body: modifyTabBody(),
    },
  ];
}

function createRibbon() {
  if (document.getElementById(RIBBON_ID)) return;

  const { tabList, bodies } = ribbonTabsHtml('model-edit', ribbonTabs());
  const ribbon = document.createElement('div');
  ribbon.id = RIBBON_ID;
  ribbon.className = 'model-edit-ribbon ribbon';
  ribbon.hidden = true;
  ribbon.setAttribute('aria-hidden', 'true');
  ribbon.setAttribute('role', 'region');
  ribbon.setAttribute('aria-label', 'モデル編集リボン');
  ribbon.innerHTML = `
    <div class="ribbon-tabbar">
      <strong class="model-edit-ribbon-title">✏️ 編集モード</strong>
      ${tabList}
      <div class="ribbon-status model-edit-ribbon-status" aria-live="polite">
        <span id="model-edit-session-active" class="model-edit-session-badge">停止中</span>
        <span id="model-edit-session-dirty">変更なし</span>
        <span>rev.<span id="model-edit-session-revision">0</span></span>
        <span id="model-edit-summary-slot"></span>
        <button type="button" id="model-edit-ribbon-collapse" class="ribbon-iconbtn model-edit-ribbon-collapse"
          aria-expanded="true" title="編集リボンを折りたたむ">⌃</button>
      </div>
    </div>
    ${bodies}
  `;

  wireRibbonTabs(ribbon);
  document.body.appendChild(ribbon);
  registerTopRibbon(ribbon, { fullWidth: true });
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

async function openCreateCommand(type, label) {
  try {
    const { openAddMemberForm } = await import('./element-info/AddMemberForm.js');
    openAddMemberForm({
      initialType: type,
      lockType: true,
      placementContext: type === 'Node' ? getPlacementContext() : null,
      title: `${label}を作成`,
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
      const button = createRibbonCommand({
        id: `model-edit-create-${type}`,
        icon,
        label,
        title: `${label}を新規作成`,
        className: 'model-edit-ribbon-create-command',
      });
      button.dataset.createType = type;
      button.addEventListener('click', () => void openCreateCommand(type, label));
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
    button.title = button.title || config.label;
    // add-member-button の className を複製して作られる拡張ボタンは、アンカー用の非表示クラスも継承してしまう。
    button.classList.remove('model-edit-ribbon-legacy-anchor');
    decorateAsRibbonCommand(button, {
      icon: config.icon,
      label: config.label,
      className: 'model-edit-ribbon-create-command',
    });
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
  // 簡易CADには独立したリボンがあるため、編集中でも同時表示しない。
  const ribbonVisible =
    editModeActive && !document.body.classList.contains('workspace-view-active');
  const ribbon = document.getElementById(RIBBON_ID);
  const activeText = document.getElementById('model-edit-session-active');
  const dirtyText = document.getElementById('model-edit-session-dirty');
  const revisionText = document.getElementById('model-edit-session-revision');
  syncHistoryCommands(state);
  syncModifyTab();

  if (ribbon) {
    ribbon.hidden = !ribbonVisible;
    ribbon.setAttribute('aria-hidden', String(!ribbonVisible));
  }
  document.body.classList.toggle('model-edit-ribbon-mounted', ribbonVisible);
  refreshTopRibbonInset();

  if (activeText) {
    activeText.textContent = active ? '編集中' : '停止中';
    activeText.classList.toggle('active', active);
  }
  if (dirtyText) dirtyText.textContent = state?.dirty === true ? '変更あり' : '変更なし';
  if (revisionText) revisionText.textContent = String(state?.workingRevision ?? 0);
  for (const side of ['a', 'b']) {
    const button = document.getElementById(`model-edit-register-${side}`);
    if (button) button.disabled = !active || registrationInProgress;
  }
}

/** 要素情報パネルの CAD 操作欄を現在の選択・編集状態で描き直す（編集終了時は取り除く）。 */
async function refreshCadOperationPanel() {
  try {
    const module = await import('./element-info/editMode/cadOperationPanel.js');
    module.mountCadOperationPanel?.();
  } catch (error) {
    showError(
      `CAD操作欄を更新できませんでした: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function restoreEditModeUi() {
  setEditMode(true);
  const editButton = document.getElementById('edit-mode-button');
  if (editButton) {
    editButton.textContent = '✏️ 編集モード（ON）';
    editButton.classList.add('edit-mode-active');
  }
  const controls = document.getElementById('editing-controls');
  if (controls) {
    controls.hidden = false;
    controls.setAttribute('aria-hidden', 'false');
  }
  eventBus.emit(EditEvents.MODE_TOGGLED, { active: true });
}

function emitRestoredWorkingChanges(state) {
  const commands = state.history || [];
  const affectedMap = new Map();
  for (const command of commands) {
    for (const element of collectAffectedElements(command)) {
      affectedMap.set(`${element.elementType}:${element.elementId}`, element);
    }
  }
  // Reapply the final Working positions relative to freshly loaded source nodes.
  const nodeChanges = [];
  for (const [nodeId, target] of state.workingNodeMap || []) {
    const source = state.sourceNodeMapA?.get(nodeId);
    if (!source || !target) continue;
    const keys = ['x', 'y', 'z'];
    if (!keys.every((key) => Number(source[key]) === Number(target[key]))) {
      nodeChanges.push({
        nodeId: String(nodeId),
        previousPosition: { x: source.x, y: source.y, z: source.z },
        position: { x: target.x, y: target.y, z: target.z },
      });
    }
  }
  eventBus.emit(EditEvents.WORKING_DOCUMENT_CHANGED, {
    reason: 'registration-failure-recovery',
    sessionId: state.sessionId,
    workingRevision: state.workingRevision,
    targetDocument: state.workingDocument,
    targetNodeMap: state.workingNodeMap,
    nodeChanges,
    structuralChanges: commands.flatMap((command) => collectStructuralChanges(command)),
    identityChanges: commands.flatMap((command) => collectIdentityChanges(command)),
    affectedElements: [...affectedMap.values()],
  });
}

function resetEditModeUiAfterLoad() {
  if (editingSession.getState()?.active === true || !isEditMode()) return;
  setEditMode(false);
  const editButton = document.getElementById('edit-mode-button');
  if (editButton) {
    editButton.textContent = '✏️ 編集モード';
    editButton.classList.remove('edit-mode-active');
  }
  const controls = document.getElementById('editing-controls');
  if (controls) {
    controls.hidden = true;
    controls.setAttribute('aria-hidden', 'true');
  }
  eventBus.emit(EditEvents.MODE_TOGGLED, { active: false });
}

/**
 * Register a validated Working Document to A/B without downloading a file.
 * A successful reload ends the Working session and its Undo history.
 */
async function registerWorkingDocumentAs(side) {
  if (registrationInProgress) return;
  const initial = editingSession.getState();
  const workingDocument = editingSession.getWorkingDocument?.();
  if (!initial?.active || !workingDocument) {
    showError('編集セッションを開始してからモデルを登録してください。');
    return;
  }

  registrationInProgress = true;
  syncSessionStatus();
  let replacement = null;
  let compare = null;
  let previousInputs = null;
  let registration = null;
  const inputLocks = ['fileA', 'fileB'].map((id) => {
    const input = document.getElementById(id);
    const disabled = input?.disabled;
    if (input) input.disabled = true;
    return { input, disabled };
  });
  try {
    registration = await import('../../app/editing/workingModelRegistration.js');
    const {
      assignWorkingSnapshotFile,
      captureModelInputSelection,
      hasModelInputSelectionChanged,
      hasModelInputSelectionChangedAfterAssignment,
      prepareValidatedWorkingSnapshot,
    } = registration;
    const snapshot = await prepareValidatedWorkingSnapshot(workingDocument, {
      revision: initial.workingRevision,
    });
    const unchanged = () => {
      const now = editingSession.getState();
      return (
        now?.active === true &&
        now.workingDocument === workingDocument &&
        now.workingRevision === initial.workingRevision
      );
    };
    if (!unchanged()) {
      throw new Error('バリデーション中に編集内容が変更されました。再度登録してください。');
    }

    const targetInput = document.getElementById(`file${side}`);
    if (!targetInput) throw new Error(`モデル${side}の入力欄がありません。`);
    const existingFile = targetInput.files?.[0] || null;
    const confirmation = existingFile
      ? `モデル${side}「${existingFile.name}」を編集中のモデルで置き換えます。`
      : `編集中のモデルをモデル${side}へ登録します。`;
    if (
      typeof globalThis.confirm !== 'function' ||
      !globalThis.confirm(
        confirmation +
          '\n登録後は編集セッションとUndo履歴が終了します。ディスクへは保存しません。続行しますか？',
      )
    )
      return;

    const compareHandler = globalThis.window?.handleCompareModelsClick;
    if (typeof compareHandler !== 'function') {
      throw new Error('読込・比較ハンドラーが初期化されていません。');
    }
    compare = (requireCompleteRendering = true) => compareHandler({ requireCompleteRendering });

    // Preflight both files before the destructive loader reset.
    const registrationFile = new File([snapshot.xml], snapshot.filename, {
      type: 'application/xml',
    });
    const selectedBeforePreflight = captureModelInputSelection();
    previousInputs = selectedBeforePreflight;
    const candidateA = side === 'A' ? registrationFile : selectedBeforePreflight.fileA;
    const candidateB = side === 'B' ? registrationFile : selectedBeforePreflight.fileB;
    const { processModelDocuments } = await import('../../modelLoader/modelProcessing.js');
    await processModelDocuments(candidateA, candidateB);
    if (!unchanged()) {
      throw new Error('事前検証中に編集内容が変更されました。再度登録してください。');
    }
    if (hasModelInputSelectionChanged(selectedBeforePreflight, captureModelInputSelection())) {
      throw new Error(
        '事前解析中にモデルA/Bのファイル選択が変更されました。再度登録してください。',
      );
    }

    replacement = assignWorkingSnapshotFile(side, snapshot);
    if (
      hasModelInputSelectionChangedAfterAssignment(
        selectedBeforePreflight,
        captureModelInputSelection(),
        side,
        replacement.file,
      )
    ) {
      throw new Error(
        'モデル登録の入力設定中にファイル選択が変更されました。再度登録してください。',
      );
    }
    const succeeded = await compare();
    if (
      hasModelInputSelectionChangedAfterAssignment(
        selectedBeforePreflight,
        captureModelInputSelection(),
        side,
        replacement.file,
      )
    ) {
      throw new Error(
        'モデル読込中にモデルA/Bのファイル選択が変更されました。再度登録してください。',
      );
    }
    if (succeeded !== true || !getState(`models.document${side}`)) {
      throw new Error('モデル読込・比較が完了しなかったため、登録を確定できませんでした。');
    }

    resetEditModeUiAfterLoad();
    const warnings = snapshot.report?.statistics?.warningCount || 0;
    showSuccess(
      `編集中のモデルをモデル${side}へ登録しました（ディスク保存なし、警告${warnings}件）。`,
    );
    replacement = null;
  } catch (error) {
    let recovery = null;
    if (replacement) {
      recovery = await registration.recoverWorkingRegistrationAfterLoadFailure({
        replacement,
        previousInputs,
        compare: () => compare(false),
        workingState: initial,
        getEditingState: () => editingSession.getState(),
        restoreEditingState: (saved) => setState('models.editing', saved),
        restoreEditingUi: restoreEditModeUi,
        onWorkingRebound: emitRestoredWorkingChanges,
      });
    }
    const recoveryNote = recovery?.workingRestored
      ? recovery.sourceViewRestored
        ? '元のモデルを再読み込みし編集セッションを復元しました。編集中の3D表示は再確認してください。'
        : '編集中のデータとUndo履歴は保持しましたが、元の3D表示の復元には失敗しました。'
      : '';
    showError(
      `モデル${side}の登録に失敗しました: ${error instanceof Error ? error.message : String(error)} ${recoveryNote}`,
    );
  } finally {
    for (const { input, disabled } of inputLocks) {
      if (input) input.disabled = disabled;
    }
    registrationInProgress = false;
    resetEditModeUiAfterLoad();
    syncSessionStatus();
  }
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
  initializeHistoryCommands({
    onChanged: () => {
      syncSessionStatus();
      void refreshCadOperationPanel();
    },
  });
  initializeModifyTab();
  for (const side of ['A', 'B']) {
    document
      .getElementById(`model-edit-register-${side.toLowerCase()}`)
      ?.addEventListener('click', () => void registerWorkingDocumentAs(side));
  }
  syncSessionStatus();

  eventBus.on(EditEvents.WORKING_DOCUMENT_CHANGED, () => {
    syncSessionStatus();
    renderPlacementTargets();
  });
  eventBus.on(EditEvents.MODE_TOGGLED, () => {
    syncSessionStatus();
    void refreshCadOperationPanel();
  });
  eventBus.on(UIEvents.WORKSPACE_VISIBILITY_CHANGED, syncSessionStatus);
}

export { syncSessionStatus };
