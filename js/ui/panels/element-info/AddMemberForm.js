/**
 * @fileoverview 新規部材追加フォーム（フローティング版）
 *
 * 節点・柱などの新規部材を、3Dビューと連動しながら直接作成するフローティングUI。
 * モーダルではなくドラッグ可能なフローティングパネルとし、開いたまま3Dビューを操作できる。
 * 編集モードのON/OFFとは独立して利用できる（モデルAが読込済みであればよい）。
 *
 * 主な機能:
 * - 3D節点ピック: 柱の上下端節点を3Dビューのクリックで指定（nodePickService 経由）。
 * - 既存節点スナップ: 新規節点作成時、既存節点をクリックして座標をコピー。
 * - 確認サマリ＋ライブ検証: 入力のたびに addMemberValidation を実行し、
 *   エラーがあれば「作成」を無効化（警告は許可）。選択中の節点は3Dでハイライト。
 * - 断面選択に応じて kind_structure を自動整合（StbSecColumn_RC → RC など）。
 *
 * XML変更ロジックは持たず、EditMode.addNewMember を呼ぶだけに徹する
 * （XML変更の唯一の責務は EditMode に集約する）。
 *
 * フィールド定義・入力行の生成・確認サマリは addMemberForm/ 配下へ分割している。
 *
 * @module ui/panels/element-info/AddMemberForm
 */

import { createLogger } from '../../../utils/logger.js';
import { getState } from '../../../data/state/globalState.js';
import { showError } from '../../common/toast.js';
import { addNewMember, getNewMemberDefinitions, linkNodesToExisting } from './editMode/index.js';
import { floatingWindowManager } from '../floatingWindowManager.js';
import * as nodePick from './nodePickService.js';
import { validateNewMember, validateNodeLink } from './addMemberValidation.js';
import { PANEL_MEMBER_TYPES } from './memberCategories.js';
import { NODELIST_TYPES, TYPE_LABELS } from './addMemberForm/fieldDefs.js';
import { formState, refreshModelData, structureForSection } from './addMemberForm/formState.js';
import { clearPickingButtons, ensureOption, setFieldValue } from './addMemberForm/formControls.js';
import { refreshNodeListUI, renderFields } from './addMemberForm/formFields.js';
import {
  buildValidationContext,
  collectAttrs,
  getLinkedNodeIds,
  nodeRefValues,
  renderLinkSummary,
  renderSummary,
} from './addMemberForm/formSummary.js';

const log = createLogger('ui:panels:add-member-form');

const WINDOW_ID = 'add-member-window';

/** @type {HTMLElement|null} */
let windowEl = null;
/** @type {Function|null} ドラッグ機能のクリーンアップ */
let dragCleanup = null;
/** @type {Function|null} Escape キーで閉じるためのハンドラ参照 */
let onKeydown = null;

/** フォームを閉じる（ピックモード解除・ハイライト解除を必ず行う） */
function closeForm() {
  nodePick.cancelPick();
  nodePick.clearHighlights();
  if (onKeydown) {
    document.removeEventListener('keydown', onKeydown);
    onKeydown = null;
  }
  if (dragCleanup) {
    dragCleanup();
    dragCleanup = null;
  }
  if (windowEl) {
    windowEl.remove();
    windowEl = null;
  }
}

/**
 * 新規部材追加フローティングウィンドウを開く。
 */
export function openAddMemberForm() {
  // 編集モードとは独立して直接作成できる（編集モードのON/OFFに依存しない）
  if (!getState('models.documentA')) {
    showError('モデルAが読み込まれていません');
    return;
  }
  if (windowEl) return; // 二重表示防止

  const definitions = getNewMemberDefinitions();
  const types = Object.keys(definitions);

  // 面材の輪郭節点列をリセット（前回のフォーム残骸を持ち越さない）
  formState.panelNodeIds = [];

  // 節点ID・断面をキャッシュ（以降の入力検証・候補生成はキャッシュを参照する）
  refreshModelData(types[0]);

  // ---- ウィンドウDOM（floating-window 構造を再利用）----
  windowEl = document.createElement('div');
  windowEl.id = WINDOW_ID;
  windowEl.className = 'floating-window add-member-window visible';
  windowEl.setAttribute('role', 'dialog');
  windowEl.setAttribute('aria-labelledby', 'add-member-title');

  const header = document.createElement('div');
  header.className = 'float-window-header';
  header.id = `${WINDOW_ID}-header`;
  header.innerHTML = `
    <span class="float-window-title" id="add-member-title">➕ 新規部材の追加</span>
    <div class="float-window-controls">
      <button type="button" class="float-window-btn" id="close-${WINDOW_ID}-btn" aria-label="閉じる">✕</button>
    </div>
  `;

  const content = document.createElement('div');
  content.className = 'float-window-content';

  // タイプ選択
  const typeRow = document.createElement('div');
  typeRow.className = 'add-member-row';
  const typeLabel = document.createElement('label');
  typeLabel.className = 'add-member-label';
  typeLabel.textContent = '部材タイプ';
  typeLabel.htmlFor = 'add-member-type';
  const typeSelect = document.createElement('select');
  typeSelect.id = 'add-member-type';
  typeSelect.className = 'parameter-dropdown';
  for (const type of types) {
    const opt = document.createElement('option');
    opt.value = type;
    opt.textContent = TYPE_LABELS[type] || type;
    typeSelect.appendChild(opt);
  }
  typeRow.appendChild(typeLabel);
  typeRow.appendChild(typeSelect);
  content.appendChild(typeRow);

  // モード選択（階・各種通り芯のみ表示）: 新規作成 / 既存に節点を追加
  const modeRow = document.createElement('div');
  modeRow.className = 'add-member-row';
  modeRow.style.display = 'none';
  const modeLabel = document.createElement('label');
  modeLabel.className = 'add-member-label';
  modeLabel.textContent = '操作';
  modeLabel.htmlFor = 'add-member-mode';
  const modeSelect = document.createElement('select');
  modeSelect.id = 'add-member-mode';
  modeSelect.className = 'parameter-dropdown';
  for (const [value, text] of [
    ['create', '新規作成'],
    ['link', '既存に節点を追加'],
  ]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    modeSelect.appendChild(opt);
  }
  modeRow.appendChild(modeLabel);
  modeRow.appendChild(modeSelect);
  content.appendChild(modeRow);

  /** 現在の操作モードを返す（NODELIST タイプ以外は常に新規作成）。 */
  const getMode = () =>
    NODELIST_TYPES.has(typeSelect.value) && modeSelect.value === 'link' ? 'link' : 'create';

  // 動的フィールド・サマリ・ボタン領域
  const fieldsContainer = document.createElement('div');
  fieldsContainer.className = 'add-member-fields';
  content.appendChild(fieldsContainer);

  const summaryEl = document.createElement('div');
  summaryEl.className = 'add-member-summary';
  content.appendChild(summaryEl);

  const buttonArea = document.createElement('div');
  buttonArea.className = 'parameter-editor-buttons';
  buttonArea.innerHTML = `
    <button type="button" class="parameter-editor-cancel">キャンセル</button>
    <button type="button" class="parameter-editor-ok add-member-submit">追加</button>
  `;
  content.appendChild(buttonArea);

  windowEl.appendChild(header);
  windowEl.appendChild(content);
  document.body.appendChild(windowEl);

  const submitBtn = buttonArea.querySelector('.add-member-submit');

  // ---- フォームコントローラ（フィールド行から参照する）----
  const ctrl = {
    onChange() {
      const elementType = typeSelect.value;
      if (getMode() === 'link') {
        // 既存への紐づけ: 紐づけ先＋追加節点を検証し、3Dハイライト
        const targetId = fieldsContainer.querySelector('[data-role="link-target"]')?.value || '';
        const { errors } = renderLinkSummary(summaryEl, elementType, targetId);
        submitBtn.disabled = errors.length > 0;
        const refs = formState.panelNodeIds.filter(Boolean);
        if (refs.length > 0) nodePick.highlightNodes(refs);
        else nodePick.clearHighlights();
        return;
      }
      const attrs = collectAttrs(fieldsContainer, elementType);
      const { errors } = renderSummary(summaryEl, elementType, attrs);
      submitBtn.disabled = errors.length > 0;
      // 面材・階・通り芯は節点リスト、線材は端部節点を3Dハイライト（節点タイプはハイライト対象なし）
      const refs =
        PANEL_MEMBER_TYPES.has(elementType) || NODELIST_TYPES.has(elementType)
          ? formState.panelNodeIds.filter(Boolean)
          : nodeRefValues(attrs).filter(Boolean);
      if (refs.length > 0) {
        nodePick.highlightNodes(refs);
      } else {
        nodePick.clearHighlights();
      }
    },
    /**
     * 3D節点ピックを開始する。targetInput が null の場合はスナップ（X/Y/Z へ座標反映）。
     * @param {HTMLButtonElement} btn
     * @param {HTMLSelectElement|null} targetInput
     * @param {boolean} isSnap
     */
    startNodePick(btn, targetInput, isSnap) {
      // 同じボタンの再クリックでピック解除（トグル）
      if (btn.classList.contains('picking')) {
        nodePick.cancelPick();
        btn.classList.remove('picking');
        return;
      }
      clearPickingButtons(fieldsContainer);
      btn.classList.add('picking');
      nodePick.beginPick(({ nodeId }) => {
        if (isSnap) {
          const coords = nodePick.getNodeCoords(nodeId);
          if (coords) {
            setFieldValue(fieldsContainer, 'X', coords.X);
            setFieldValue(fieldsContainer, 'Y', coords.Y);
            setFieldValue(fieldsContainer, 'Z', coords.Z);
          }
        } else if (targetInput) {
          ensureOption(targetInput, nodeId);
          targetInput.value = nodeId;
        }
        nodePick.cancelPick();
        btn.classList.remove('picking');
        ctrl.onChange();
      });
    },
    /**
     * 面材の輪郭節点を連続ピックする。クリックのたびに末尾へ追加し、リストUIを更新する。
     * もう一度ボタンを押すとピック終了（トグル）。
     * @param {HTMLButtonElement} btn
     */
    startNodeListPick(btn) {
      if (btn.classList.contains('picking')) {
        nodePick.cancelPick();
        btn.classList.remove('picking');
        return;
      }
      clearPickingButtons(fieldsContainer);
      btn.classList.add('picking');
      const listEl = fieldsContainer.querySelector('.add-member-nodelist-items');
      // 連続ピック: cancelPick せず、クリックのたびに追加し続ける
      nodePick.beginPick(({ nodeId }) => {
        // 直前と同一節点の連続クリックは無視（縮退辺を防ぐ）
        if (formState.panelNodeIds[formState.panelNodeIds.length - 1] !== String(nodeId)) {
          formState.panelNodeIds.push(String(nodeId));
          if (listEl) refreshNodeListUI(listEl, ctrl);
          ctrl.onChange();
        }
      });
    },
  };

  renderFields(fieldsContainer, typeSelect.value, ctrl, getMode());
  ctrl.onChange();

  // タイプ変更でフィールド再構築（タイプにより参照する断面種別が変わるため再キャッシュ）
  typeSelect.addEventListener('change', () => {
    nodePick.cancelPick();
    clearPickingButtons(fieldsContainer);
    // タイプを跨ぐと節点列の意味が変わるためクリアする
    formState.panelNodeIds = [];
    // モード選択は階・各種通り芯でのみ意味を持つ。タイプ変更時は新規作成へ戻す。
    modeRow.style.display = NODELIST_TYPES.has(typeSelect.value) ? '' : 'none';
    modeSelect.value = 'create';
    refreshModelData(typeSelect.value);
    renderFields(fieldsContainer, typeSelect.value, ctrl, getMode());
    ctrl.onChange();
  });

  // モード変更（新規作成 ⇄ 既存に追加）でフィールド再構築。節点列はクリアする。
  modeSelect.addEventListener('change', () => {
    nodePick.cancelPick();
    clearPickingButtons(fieldsContainer);
    formState.panelNodeIds = [];
    renderFields(fieldsContainer, typeSelect.value, ctrl, getMode());
    ctrl.onChange();
  });

  // フィールド変更でライブ検証＋ハイライト更新。断面選択時は kind_structure を自動整合
  fieldsContainer.addEventListener('input', () => ctrl.onChange());
  fieldsContainer.addEventListener('change', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target?.dataset?.attr === 'id_section') {
      const structure = structureForSection(target.value);
      if (structure) setFieldValue(fieldsContainer, 'kind_structure', structure);
    }
    ctrl.onChange();
  });

  // ---- イベント配線 ----
  const onSubmit = () => {
    const elementType = typeSelect.value;
    if (getMode() === 'link') {
      const targetId = fieldsContainer.querySelector('[data-role="link-target"]')?.value || '';
      const { errors } = validateNodeLink(targetId, formState.panelNodeIds, {
        nodeIds: formState.cachedNodeIds,
        linkedNodeIds: getLinkedNodeIds(elementType, targetId),
      });
      if (errors.length > 0) {
        showError(errors[0]);
        return;
      }
      const result = linkNodesToExisting(elementType, targetId, formState.panelNodeIds);
      if (result.success) {
        closeForm();
      } else {
        showError(result.error || '紐づけに失敗しました');
        log.warn('節点紐づけに失敗:', result.error);
      }
      return;
    }
    const attrs = collectAttrs(fieldsContainer, elementType);
    const { errors } = validateNewMember(elementType, attrs, buildValidationContext(elementType));
    if (errors.length > 0) {
      showError(errors[0]);
      return;
    }
    const result = addNewMember(elementType, attrs);
    if (result.success) {
      closeForm();
    } else {
      showError(result.error || '追加に失敗しました');
      log.warn('新規部材追加に失敗:', result.error);
    }
  };

  header.querySelector(`#close-${WINDOW_ID}-btn`)?.addEventListener('click', closeForm);
  buttonArea.querySelector('.parameter-editor-cancel')?.addEventListener('click', closeForm);
  submitBtn?.addEventListener('click', onSubmit);

  onKeydown = (e) => {
    if (e.key === 'Escape') closeForm();
  };
  document.addEventListener('keydown', onKeydown);

  // ドラッグ機能を付与（floatingWindowManager のドラッグ実装を再利用）
  dragCleanup = floatingWindowManager.makeDraggable(windowEl, header);
}

/**
 * 「＋部材追加」ボタンを配線する。
 */
export function initAddMemberForm() {
  const btn = document.getElementById('add-member-button');
  if (btn) {
    btn.addEventListener('click', openAddMemberForm);
  }
}
