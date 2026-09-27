/**
 * @fileoverview 新規部材追加フォーム（フローティング版）
 *
 * 節点・柱などの新規部材を、3Dビューと連動しながら直接作成するフローティングUI。
 * モーダルではなくドラッグ可能なフローティングパネルとし、開いたまま3Dビューを操作できる。
 * 編集モードのON/OFFとは独立して利用できる（モデルAが読込済みであればよい）。
 *
 * XML変更ロジックは持たず、EditMode.addNewMember を呼ぶだけに徹する。
 */

import { createLogger } from '../../../utils/logger.js';
import { getState } from '../../../data/state/globalState.js';
import { showError } from '../../common/toast.js';
import { resolveNodePlacement } from '../modelEditPlacementContext.js';
import { floatingWindowManager } from '../floatingWindowManager.js';
import { addNewMember, getNewMemberDefinitions, linkNodesToExisting } from './editMode/index.js';
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
/** @type {Function|null} */
let dragCleanup = null;
/** @type {Function|null} */
let onKeydown = null;

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

function nodePlacementFor(elementType, placementContext) {
  return elementType === 'Node' && placementContext ? resolveNodePlacement(placementContext) : null;
}

function applyNodePlacementToFields(fieldsContainer, elementType, placementContext) {
  const placement = nodePlacementFor(elementType, placementContext);
  const coordinateKeys = ['X', 'Y', 'Z'];

  for (const key of coordinateKeys) {
    const input = fieldsContainer.querySelector(`[data-attr="${key}"]`);
    if (!(input instanceof HTMLInputElement)) continue;
    input.readOnly = false;
    input.classList.remove('placement-coordinate-locked');
    input.removeAttribute('title');
  }

  if (!placement) return;
  for (const [key, value] of Object.entries(placement.lockedCoordinates || {})) {
    setFieldValue(fieldsContainer, key, String(value));
    const input = fieldsContainer.querySelector(`[data-attr="${key}"]`);
    if (input instanceof HTMLInputElement) {
      input.readOnly = true;
      input.classList.add('placement-coordinate-locked');
      input.title = '配置基準により固定されています';
    }
  }
}

function mergeNodePlacementAttrs(elementType, attrs, placementContext) {
  const placement = nodePlacementFor(elementType, placementContext);
  return placement ? { ...attrs, ...(placement.attributes || {}) } : attrs;
}

function createPlacementSummaryRow(placementContext) {
  const row = document.createElement('div');
  row.className = 'add-member-row add-member-placement-summary';
  row.hidden = true;

  const label = document.createElement('label');
  label.className = 'add-member-label';
  label.textContent = '配置基準';

  const value = document.createElement('div');
  value.className = 'add-member-summary';
  value.dataset.role = 'placement-summary';
  value.textContent = placementContext?.targetLabel || '自由配置';

  row.append(label, value);
  return row;
}

/**
 * 新規部材追加フローティングウィンドウを開く。
 * @param {{initialType?:string,lockType?:boolean,placementContext?:Object|null,title?:string}} [options]
 */
export function openAddMemberForm(options = {}) {
  if (!getState('models.documentA')) {
    showError('モデルAが読み込まれていません');
    return;
  }
  if (windowEl) return;

  const definitions = getNewMemberDefinitions();
  const types = Object.keys(definitions);
  const initialType = definitions[options.initialType] ? options.initialType : types[0];
  const placementContext = options.placementContext || null;

  formState.panelNodeIds = [];
  refreshModelData(initialType);

  windowEl = document.createElement('div');
  windowEl.id = WINDOW_ID;
  windowEl.className = 'floating-window add-member-window visible';
  windowEl.setAttribute('role', 'dialog');
  windowEl.setAttribute('aria-labelledby', 'add-member-title');

  const header = document.createElement('div');
  header.className = 'float-window-header';
  header.id = `${WINDOW_ID}-header`;
  header.innerHTML = `
    <span class="float-window-title" id="add-member-title"></span>
    <div class="float-window-controls">
      <button type="button" class="float-window-btn" id="close-${WINDOW_ID}-btn" aria-label="閉じる">✕</button>
    </div>
  `;
  header.querySelector('#add-member-title').textContent = options.title || '➕ 新規部材の追加';

  const content = document.createElement('div');
  content.className = 'float-window-content';

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
  typeSelect.value = initialType;
  typeRow.hidden = options.lockType === true;
  typeRow.append(typeLabel, typeSelect);
  content.appendChild(typeRow);

  const placementRow = createPlacementSummaryRow(placementContext);
  content.appendChild(placementRow);

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
  modeRow.append(modeLabel, modeSelect);
  content.appendChild(modeRow);

  const getMode = () =>
    NODELIST_TYPES.has(typeSelect.value) && modeSelect.value === 'link' ? 'link' : 'create';

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

  windowEl.append(header, content);
  document.body.appendChild(windowEl);

  const submitBtn = buttonArea.querySelector('.add-member-submit');

  function refreshPlacementPresentation() {
    const isNode = typeSelect.value === 'Node' && placementContext;
    placementRow.hidden = !isNode;
    applyNodePlacementToFields(fieldsContainer, typeSelect.value, placementContext);
  }

  const ctrl = {
    onChange() {
      const elementType = typeSelect.value;
      refreshPlacementPresentation();

      if (getMode() === 'link') {
        const targetId = fieldsContainer.querySelector('[data-role="link-target"]')?.value || '';
        const { errors } = renderLinkSummary(summaryEl, elementType, targetId);
        submitBtn.disabled = errors.length > 0;
        const refs = formState.panelNodeIds.filter(Boolean);
        if (refs.length > 0) nodePick.highlightNodes(refs);
        else nodePick.clearHighlights();
        return;
      }

      const rawAttrs = collectAttrs(fieldsContainer, elementType);
      const attrs = mergeNodePlacementAttrs(elementType, rawAttrs, placementContext);
      const { errors } = renderSummary(summaryEl, elementType, attrs);
      submitBtn.disabled = errors.length > 0;
      const refs =
        PANEL_MEMBER_TYPES.has(elementType) || NODELIST_TYPES.has(elementType)
          ? formState.panelNodeIds.filter(Boolean)
          : nodeRefValues(attrs).filter(Boolean);
      if (refs.length > 0) nodePick.highlightNodes(refs);
      else nodePick.clearHighlights();
    },

    startNodePick(btn, targetInput, isSnap) {
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
            applyNodePlacementToFields(fieldsContainer, typeSelect.value, placementContext);
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

    startNodeListPick(btn) {
      if (btn.classList.contains('picking')) {
        nodePick.cancelPick();
        btn.classList.remove('picking');
        return;
      }
      clearPickingButtons(fieldsContainer);
      btn.classList.add('picking');
      const listEl = fieldsContainer.querySelector('.add-member-nodelist-items');
      nodePick.beginPick(({ nodeId }) => {
        if (formState.panelNodeIds[formState.panelNodeIds.length - 1] !== String(nodeId)) {
          formState.panelNodeIds.push(String(nodeId));
          if (listEl) refreshNodeListUI(listEl, ctrl);
          ctrl.onChange();
        }
      });
    },
  };

  renderFields(fieldsContainer, typeSelect.value, ctrl, getMode());
  refreshPlacementPresentation();
  ctrl.onChange();

  typeSelect.addEventListener('change', () => {
    nodePick.cancelPick();
    clearPickingButtons(fieldsContainer);
    formState.panelNodeIds = [];
    modeRow.style.display = NODELIST_TYPES.has(typeSelect.value) ? '' : 'none';
    modeSelect.value = 'create';
    refreshModelData(typeSelect.value);
    renderFields(fieldsContainer, typeSelect.value, ctrl, getMode());
    refreshPlacementPresentation();
    ctrl.onChange();
  });

  modeSelect.addEventListener('change', () => {
    nodePick.cancelPick();
    clearPickingButtons(fieldsContainer);
    formState.panelNodeIds = [];
    renderFields(fieldsContainer, typeSelect.value, ctrl, getMode());
    refreshPlacementPresentation();
    ctrl.onChange();
  });

  fieldsContainer.addEventListener('input', () => ctrl.onChange());
  fieldsContainer.addEventListener('change', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target?.dataset?.attr === 'id_section') {
      const structure = structureForSection(target.value);
      if (structure) setFieldValue(fieldsContainer, 'kind_structure', structure);
    }
    ctrl.onChange();
  });

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
      if (result.success) closeForm();
      else {
        showError(result.error || '紐づけに失敗しました');
        log.warn('節点紐づけに失敗:', result.error);
      }
      return;
    }

    applyNodePlacementToFields(fieldsContainer, elementType, placementContext);
    const rawAttrs = collectAttrs(fieldsContainer, elementType);
    const attrs = mergeNodePlacementAttrs(elementType, rawAttrs, placementContext);
    const { errors } = validateNewMember(elementType, attrs, buildValidationContext(elementType));
    if (errors.length > 0) {
      showError(errors[0]);
      return;
    }
    const result = addNewMember(elementType, attrs);
    if (result.success) closeForm();
    else {
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

  dragCleanup = floatingWindowManager.makeDraggable(windowEl, header);
}

export function initAddMemberForm() {
  const btn = document.getElementById('add-member-button');
  if (btn) btn.addEventListener('click', openAddMemberForm);
}
