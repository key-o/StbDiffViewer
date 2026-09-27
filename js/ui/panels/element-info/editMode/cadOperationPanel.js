/**
 * @fileoverview Phase 6 の数値 MOVE / ALIGN / COPY を独立モデル編集パネルから共通 CAD operation service へ接続する。
 *
 * 選択 Object3D を直接変更せず semantic selection -> Working Document semantic Command の順に解決する。
 * MOVE は Working Session の追従設定に応じて semantic Node または member offset、
 * ALIGN は semantic Node grip、COPY は semantic element identity を正本として1 transaction化する。
 */

import { getSelectedObjects } from '../../../../app/controllers/interactionController.js';
import { createSemanticSelectionIdentity } from '../../../../app/controllers/interaction/semanticSelection.js';
import cadOperationService from '../../../../app/editing/cadOperationService.js';
import editingSession from '../../../../app/editing/editingSession.js';
import { getSemanticGripsForSelections } from '../../../../app/editing/semanticGripProvider.js';
import { showError, showSuccess } from '../../../common/toast.js';

function collectSemanticSelections(objects = getSelectedObjects()) {
  return (Array.isArray(objects) ? objects : [])
    .map((object) => createSemanticSelectionIdentity(object?.userData || {}))
    .filter(Boolean);
}

function isReadOnlySelection(identity) {
  return identity && ['B', 'onlyB'].includes(identity.modelSource);
}

function mountUnavailablePanel(content, message) {
  const editor = document.createElement('div');
  editor.className = 'cad-operation-editor';
  editor.style.marginTop = '12px';
  editor.style.paddingTop = '8px';
  editor.style.borderTop = '1px solid var(--border-color, #666)';

  const title = document.createElement('div');
  title.style.fontWeight = 'var(--font-weight-bold)';
  title.style.marginBottom = '4px';
  title.textContent = 'CAD操作';
  editor.appendChild(title);

  const note = document.createElement('div');
  note.className = 'add-member-summary';
  note.textContent = message;
  editor.appendChild(note);
  content.appendChild(editor);
  return true;
}

export function resolveCadOperationNodeIds(document, nodeMap, selections) {
  const result = [];
  const seen = new Set();
  const grips = getSemanticGripsForSelections(document, selections, { nodeMap });
  for (const grip of grips) {
    if (grip?.behavior !== 'moveNode' || grip?.target?.elementType !== 'Node') continue;
    const nodeId = String(grip.target.elementId ?? '').trim();
    if (!nodeId || seen.has(nodeId)) continue;
    seen.add(nodeId);
    result.push(nodeId);
  }
  return result;
}

function createRow(labelText) {
  const row = document.createElement('div');
  row.className = 'add-member-row';
  const label = document.createElement('label');
  label.className = 'add-member-label';
  label.textContent = labelText;
  row.appendChild(label);
  return row;
}

function createNumberInput(value = '0') {
  const input = document.createElement('input');
  input.className = 'parameter-input';
  input.type = 'number';
  input.step = 'any';
  input.value = value;
  return input;
}

function createCoordinateInputs(labels, defaults = {}) {
  const wrapper = document.createElement('div');
  wrapper.style.display = 'grid';
  wrapper.style.gridTemplateColumns = 'repeat(3, minmax(0, 1fr))';
  wrapper.style.gap = '4px';
  const inputs = {};
  for (const axis of labels) {
    const input = createNumberInput(String(defaults[axis] ?? 0));
    input.placeholder = axis.toUpperCase();
    input.setAttribute('aria-label', axis.toUpperCase());
    wrapper.appendChild(input);
    inputs[axis] = input;
  }
  return { wrapper, inputs };
}

function pointFromInputs(inputs) {
  return { x: inputs.x.value, y: inputs.y.value, z: inputs.z.value };
}

function appendOperationButton(parent, text, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'parameter-editor-ok';
  button.textContent = text;
  button.addEventListener('click', handler);
  parent.appendChild(button);
  return button;
}

function notifyResult(result, successMessage, noChangeMessage) {
  showSuccess(result?.changed === false ? noChangeMessage : successMessage);
}

/**
 * 現在選択を数値 CAD 操作 UI へ接続する。
 * @param {{objects?:Array, containerId?:string}} [options]
 * @returns {boolean} panelを表示した場合 true
 */
export function mountCadOperationPanel(options = {}) {
  const containerId = options.containerId || 'model-edit-cad-operations';
  const content = document.getElementById(containerId);
  if (!content) return false;
  content.querySelector('.cad-operation-editor')?.remove();
  content.querySelector('.add-member-summary')?.remove();

  if (editingSession.getState()?.active !== true) {
    return mountUnavailablePanel(content, '編集モードをONにすると CAD 操作を利用できます。');
  }

  const selections = collectSemanticSelections(options.objects);
  if (selections.length === 0) {
    return mountUnavailablePanel(
      content,
      'Model A の要素を選択すると MOVE / ALIGN / COPY 操作が表示されます。',
    );
  }
  if (selections.some(isReadOnlySelection)) {
    return mountUnavailablePanel(
      content,
      'Model B を含む選択では CAD 編集できません。Model A の編集対象だけを選択してください。',
    );
  }

  const workingDocument = editingSession.getWorkingDocument();
  const workingNodeMap = editingSession.getWorkingNodeMap();
  if (!workingDocument) {
    return mountUnavailablePanel(content, 'Working Document を取得できません。');
  }

  const nodeIds = resolveCadOperationNodeIds(workingDocument, workingNodeMap, selections);
  if (nodeIds.length === 0) {
    return mountUnavailablePanel(content, '選択要素には移動可能な semantic Node がありません。');
  }

  const editor = document.createElement('div');
  editor.className = 'cad-operation-editor';
  editor.style.marginTop = '12px';
  editor.style.paddingTop = '8px';
  editor.style.borderTop = '1px solid var(--border-color, #666)';

  const title = document.createElement('div');
  title.style.fontWeight = 'var(--font-weight-bold)';
  title.style.marginBottom = '4px';
  title.textContent = `CAD操作 (${nodeIds.length} Node)`;
  editor.appendChild(title);

  const note = document.createElement('div');
  note.className = 'add-member-summary';
  note.textContent =
    'MOVE は追従設定に応じて semantic Node / member offset を使い分け、ALIGN は semantic Node、COPY は semantic 要素として編集します。';
  editor.appendChild(note);

  const followRow = createRow('MOVE 設定');
  const followLabel = document.createElement('label');
  followLabel.style.display = 'inline-flex';
  followLabel.style.alignItems = 'center';
  followLabel.style.gap = '6px';
  const followCheckbox = document.createElement('input');
  followCheckbox.type = 'checkbox';
  followCheckbox.id = 'model-edit-move-follow-related-nodes';
  followCheckbox.checked = editingSession.getMoveFollowRelatedNodes();
  followCheckbox.setAttribute('aria-label', 'MOVE時に関連節点を追従');
  const followText = document.createElement('span');
  followText.textContent = '関連節点を追従';
  followLabel.append(followCheckbox, followText);
  followRow.appendChild(followLabel);
  editor.appendChild(followRow);

  const followNote = document.createElement('div');
  followNote.className = 'add-member-summary';
  const updateFollowNote = () => {
    followNote.textContent = followCheckbox.checked
      ? 'ON: 選択要素の semantic Node を移動し、共有節点を参照する部材も追従します。'
      : 'OFF: StbNode は固定し、選択部材の offset を更新して部材本体だけを移動します。';
  };
  followCheckbox.addEventListener('change', () => {
    editingSession.setMoveFollowRelatedNodes(followCheckbox.checked);
    updateFollowNote();
  });
  updateFollowNote();
  editor.appendChild(followNote);

  const moveRow = createRow('MOVE ΔX / ΔY / ΔZ');
  const move = createCoordinateInputs(['x', 'y', 'z']);
  moveRow.appendChild(move.wrapper);
  editor.appendChild(moveRow);
  appendOperationButton(editor, '数値 MOVE', () => {
    try {
      const result = cadOperationService.moveSelectionsByVector(
        selections,
        pointFromInputs(move.inputs),
        { followRelatedNodes: followCheckbox.checked },
      );
      notifyResult(
        result,
        followCheckbox.checked
          ? `${nodeIds.length} Node を移動しました`
          : `${selections.length}要素を節点固定で移動しました`,
        '移動量は0です',
      );
    } catch (error) {
      showError(
        `MOVE を確定できませんでした: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  const copyRow = createRow('COPY ΔX / ΔY / ΔZ');
  const copy = createCoordinateInputs(['x', 'y', 'z']);
  copyRow.appendChild(copy.wrapper);
  editor.appendChild(copyRow);
  appendOperationButton(editor, '数値 COPY', () => {
    try {
      const result = cadOperationService.copySelectionsByVector(
        selections,
        pointFromInputs(copy.inputs),
      );
      showSuccess(
        `${selections.length}要素を COPY しました（新規 Node ${result.copiedNodeCount}件）`,
      );
    } catch (error) {
      showError(
        `COPY を確定できませんでした: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  const axisRow = createRow('軸 ALIGN');
  const axisSelect = document.createElement('select');
  axisSelect.className = 'parameter-dropdown';
  for (const axis of ['X', 'Y', 'Z']) {
    const option = document.createElement('option');
    option.value = axis;
    option.textContent = axis;
    axisSelect.appendChild(option);
  }
  const axisValue = createNumberInput('0');
  axisValue.placeholder = '座標';
  axisRow.appendChild(axisSelect);
  axisRow.appendChild(axisValue);
  editor.appendChild(axisRow);
  appendOperationButton(editor, '軸へ ALIGN', () => {
    try {
      const result = cadOperationService.alignNodesToAxis(
        nodeIds,
        axisSelect.value,
        axisValue.value,
      );
      notifyResult(
        result,
        `${nodeIds.length} Node を ${axisSelect.value}=${axisValue.value} に揃えました`,
        '既に指定軸上です',
      );
    } catch (error) {
      showError(
        `ALIGN を確定できませんでした: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  const sourceRow = createRow('2点 ALIGN 始点');
  const source = createCoordinateInputs(['x', 'y', 'z']);
  sourceRow.appendChild(source.wrapper);
  editor.appendChild(sourceRow);

  const targetRow = createRow('2点 ALIGN 終点');
  const target = createCoordinateInputs(['x', 'y', 'z']);
  targetRow.appendChild(target.wrapper);
  editor.appendChild(targetRow);
  appendOperationButton(editor, '2点 ALIGN', () => {
    try {
      const result = cadOperationService.alignNodesByPoints(
        nodeIds,
        pointFromInputs(source.inputs),
        pointFromInputs(target.inputs),
      );
      notifyResult(result, `${nodeIds.length} Node を2点 ALIGNしました`, '始点と終点が同一です');
    } catch (error) {
      showError(
        `2点 ALIGN を確定できませんでした: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  content.appendChild(editor);
  return true;
}
export { collectSemanticSelections };
