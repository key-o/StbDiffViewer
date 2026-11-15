/**
 * @fileoverview Phase 6 の数値 MOVE / ALIGN / COPY を要素情報パネルから共通 CAD operation service へ接続する。
 *
 * 選択要素ごとの数値入力はここ（要素情報パネル）に置き、モデル編集リボンの「修正」タブは
 * 各操作の欄を開くコマンドと、関連節点追従・ギズモ位置の設定だけを持つ。
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

function createEditor(titleText) {
  const editor = document.createElement('div');
  editor.className = 'cad-operation-editor';
  editor.style.marginTop = '12px';
  editor.style.paddingTop = '8px';
  editor.style.borderTop = '1px solid var(--border-color, #666)';

  const title = document.createElement('div');
  title.style.fontWeight = 'var(--font-weight-bold)';
  title.style.marginBottom = '4px';
  title.textContent = titleText;
  editor.appendChild(title);
  return editor;
}

function mountUnavailablePanel(content, message) {
  const editor = createEditor('CAD操作');

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

/** リボンの「修正」コマンドが data-cad-operation で探してフォーカスする操作単位の欄。 */
function createOperationSection(editor, kind) {
  const section = document.createElement('div');
  section.className = 'cad-operation-section';
  section.dataset.cadOperation = kind;
  editor.appendChild(section);
  return section;
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
  const content = document.getElementById(options.containerId || 'element-info-content');
  if (!content) return false;
  content.querySelector('.cad-operation-editor')?.remove();

  // 未選択・編集モード外では要素情報の表示を優先し、CAD操作欄を出さない。
  if (editingSession.getState()?.active !== true) return false;
  const selections = collectSemanticSelections(options.objects);
  if (selections.length === 0) return false;
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

  const editor = createEditor(`CAD操作 (${nodeIds.length} Node)`);
  const followRelatedNodes = () => editingSession.getMoveFollowRelatedNodes();

  const note = document.createElement('div');
  note.className = 'add-member-summary';
  note.textContent = followRelatedNodes()
    ? '節点追従ON: 共有節点を参照する部材も追従します（リボン「修正」で切替）。'
    : '節点追従OFF: 節点を固定し、選択部材の offset だけを更新します（リボン「修正」で切替）。';
  editor.appendChild(note);

  const moveSection = createOperationSection(editor, 'move');
  const moveRow = createRow('移動 ΔX / ΔY / ΔZ');
  const move = createCoordinateInputs(['x', 'y', 'z']);
  moveRow.appendChild(move.wrapper);
  moveSection.appendChild(moveRow);
  appendOperationButton(moveSection, '移動', () => {
    try {
      const follow = followRelatedNodes();
      const result = cadOperationService.moveSelectionsByVector(
        selections,
        pointFromInputs(move.inputs),
        { followRelatedNodes: follow },
      );
      notifyResult(
        result,
        follow
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

  const copySection = createOperationSection(editor, 'copy');
  const copyRow = createRow('複写 ΔX / ΔY / ΔZ');
  const copy = createCoordinateInputs(['x', 'y', 'z']);
  copyRow.appendChild(copy.wrapper);
  copySection.appendChild(copyRow);
  appendOperationButton(copySection, '複写', () => {
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

  const axisSection = createOperationSection(editor, 'align-axis');
  const axisRow = createRow('軸揃え 軸 / 座標');
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
  axisSection.appendChild(axisRow);
  appendOperationButton(axisSection, '軸揃え', () => {
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

  const pointsSection = createOperationSection(editor, 'align-points');
  const sourceRow = createRow('2点揃え 始点');
  const source = createCoordinateInputs(['x', 'y', 'z']);
  sourceRow.appendChild(source.wrapper);
  pointsSection.appendChild(sourceRow);

  const targetRow = createRow('2点揃え 終点');
  const target = createCoordinateInputs(['x', 'y', 'z']);
  targetRow.appendChild(target.wrapper);
  pointsSection.appendChild(targetRow);
  appendOperationButton(pointsSection, '2点揃え', () => {
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
