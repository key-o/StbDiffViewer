/**
 * @fileoverview 新規部材追加フォームのフィールド群（入力行・節点リストUI）の生成
 *
 * @module ui/panels/element-info/addMemberForm/formFields
 */

import { getNewMemberDefinitions, getNodeLinkTargets } from '../editMode/index.js';
import { openSectionBuilder } from '../SectionBuilderForm.js';
import { PANEL_MEMBER_TYPES } from '../memberCategories.js';
import {
  FIELD_DEFS,
  FREE_GROUP_TYPES,
  MEMBER_SECTION_CONFIG,
  NODELIST_TYPES,
  STRUCTURE_OPTIONS_BY_TYPE,
  TYPE_FIELDS,
  TYPE_LABELS,
} from './fieldDefs.js';
import {
  formState,
  refreshModelData,
  structureForSection,
  structureForSectionTag,
} from './formState.js';
import {
  makeListButton,
  makePickButton,
  populateSectionOptions,
  populateSelectOptions,
  selectSectionOption,
  setFieldValue,
} from './formControls.js';

/**
 * 選択中の断面タグから kind_structure を決定する。
 * ST-Bridge では構造種別と参照先断面要素が対応しているため、断面が存在する場合は
 * kind_structure をロックして不整合な組合せを作れないようにする。
 */
function syncStructureFromSectionSelect(sectionSelect) {
  const fields = sectionSelect.closest('.add-member-fields');
  if (!fields) return;
  const structureSelect = fields.querySelector('[data-attr="kind_structure"]');
  if (!structureSelect) return;

  const selected = sectionSelect.selectedOptions[0];
  const structure = selected?.dataset.structure || null;
  const hasSection = !!selected?.dataset.sectionTag;
  if (structure) structureSelect.value = structure;
  structureSelect.disabled = hasSection;
}

function createFieldRow(attr, ctrl, elementType) {
  const def = FIELD_DEFS[attr] || { label: attr, kind: 'number' };

  const row = document.createElement('div');
  row.className = 'add-member-row';

  const label = document.createElement('label');
  label.className = 'add-member-label';
  label.textContent = def.label;
  label.htmlFor = `add-member-field-${attr}`;
  row.appendChild(label);

  const kind = attr === 'group' && FREE_GROUP_TYPES.has(elementType) ? 'text' : def.kind;

  let input;
  if (kind === 'node' || kind === 'section' || kind === 'enum') {
    input = document.createElement('select');
    input.className = 'parameter-dropdown';
    const enumOptions =
      attr === 'kind_structure' && STRUCTURE_OPTIONS_BY_TYPE[elementType]
        ? STRUCTURE_OPTIONS_BY_TYPE[elementType]
        : def.options || [];

    if (def.kind === 'section') {
      populateSectionOptions(input, formState.cachedSections, '（断面なし）');
    } else {
      const options = def.kind === 'node' ? formState.cachedNodeIds : enumOptions;
      populateSelectOptions(input, options, '（候補なし）');
      if (def.default && options.includes(def.default)) input.value = def.default;
    }
  } else if (kind === 'text') {
    input = document.createElement('input');
    input.type = 'text';
    input.className = 'parameter-text-input';
    if (def.default !== undefined) input.value = def.default;
  } else {
    input = document.createElement('input');
    input.type = 'number';
    input.className = 'parameter-text-input parameter-number-input';
    if (def.default !== undefined) input.value = def.default;
  }
  input.id = `add-member-field-${attr}`;
  input.dataset.attr = attr;
  row.appendChild(input);

  if (def.kind === 'node') {
    row.appendChild(
      makePickButton('🎯 3Dで選択', '3Dビューで節点をクリックして指定', (btn) =>
        ctrl.startNodePick(btn, input, false),
      ),
    );
  }

  if (def.kind === 'section') {
    input.addEventListener('change', () => syncStructureFromSectionSelect(input));

    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'parameter-editor-ok add-member-new-section-btn';
    newBtn.textContent = '＋新規';
    newBtn.addEventListener('click', async () => {
      const config = MEMBER_SECTION_CONFIG[elementType];
      const roots = config?.roots || [];
      if (roots.length === 0) return;

      const fields = input.closest('.add-member-fields');
      const currentStructure = fields?.querySelector('[data-attr="kind_structure"]')?.value || null;
      const preferredRoot =
        roots.find((root) => structureForSectionTag(root) === currentStructure) || roots[0];

      const result = await openSectionBuilder({
        rootElementNames: roots,
        initialRootElementName: preferredRoot,
      });
      if (result?.id) {
        refreshModelData(elementType);
        populateSectionOptions(input, formState.cachedSections, '（断面なし）');
        selectSectionOption(input, result.id, result.tagName);

        const selectedTag = input.selectedOptions[0]?.dataset.sectionTag || result.tagName;
        const structure = structureForSection(result.id, selectedTag);
        if (structure && fields) setFieldValue(fields, 'kind_structure', structure);
        syncStructureFromSectionSelect(input);
        ctrl.onChange();
      }
    });
    row.appendChild(newBtn);
  }

  return row;
}

export function renderFields(fieldsContainer, elementType, ctrl, mode = 'create') {
  fieldsContainer.innerHTML = '';

  if (mode === 'link' && NODELIST_TYPES.has(elementType)) {
    renderLinkFields(fieldsContainer, elementType, ctrl);
    return;
  }

  if (PANEL_MEMBER_TYPES.has(elementType)) {
    fieldsContainer.appendChild(createNodeListBlock(ctrl));
  }

  for (const attr of TYPE_FIELDS[elementType] || []) {
    fieldsContainer.appendChild(createFieldRow(attr, ctrl, elementType));
  }

  if (NODELIST_TYPES.has(elementType)) {
    const label =
      elementType === 'Story'
        ? '紐づける節点（この階に属する節点・任意）'
        : '紐づける節点（この通り芯上の節点・任意）';
    fieldsContainer.appendChild(createNodeListBlock(ctrl, label));
  }

  if (PANEL_MEMBER_TYPES.has(elementType)) {
    setFieldValue(fieldsContainer, 'kind_structure', 'RC');
  }

  if (FREE_GROUP_TYPES.has(elementType)) {
    const def = getNewMemberDefinitions()[elementType];
    if (def?.defaults?.group) setFieldValue(fieldsContainer, 'group', def.defaults.group);
  }

  if (elementType === 'Node') {
    const snapRow = document.createElement('div');
    snapRow.className = 'add-member-row add-member-snap-row';
    snapRow.appendChild(
      makePickButton(
        '🎯 既存節点からスナップ',
        '3Dビューで既存節点をクリックして座標をコピー',
        (btn) => ctrl.startNodePick(btn, null, true),
      ),
    );
    fieldsContainer.appendChild(snapRow);
  }

  // 初期表示でも既存断面のタグと kind_structure を一致させる。
  const firstSectionSelect = fieldsContainer.querySelector('select[data-attr^="id_section"]');
  if (firstSectionSelect) syncStructureFromSectionSelect(firstSectionSelect);
}

function renderLinkFields(fieldsContainer, elementType, ctrl) {
  const row = document.createElement('div');
  row.className = 'add-member-row';
  const label = document.createElement('label');
  label.className = 'add-member-label';
  label.textContent = '紐づけ先';
  label.htmlFor = 'add-member-link-target';
  const select = document.createElement('select');
  select.id = 'add-member-link-target';
  select.className = 'parameter-dropdown';
  select.dataset.role = 'link-target';
  const targets = getNodeLinkTargets(elementType);
  if (targets.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = `（${TYPE_LABELS[elementType] || elementType}が存在しません）`;
    select.appendChild(opt);
  }
  for (const t of targets) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.label;
    select.appendChild(opt);
  }
  row.appendChild(label);
  row.appendChild(select);
  fieldsContainer.appendChild(row);

  fieldsContainer.appendChild(createNodeListBlock(ctrl, '追加する節点（既存リストへ追記）'));
}

function createNodeListBlock(ctrl, labelText = '輪郭節点（3点以上・順序が外周）') {
  const block = document.createElement('div');
  block.className = 'add-member-nodelist';

  const label = document.createElement('div');
  label.className = 'add-member-label add-member-nodelist-label';
  label.textContent = labelText;
  block.appendChild(label);

  const listEl = document.createElement('ol');
  listEl.className = 'add-member-nodelist-items';
  block.appendChild(listEl);

  const addBtn = makePickButton(
    '🎯 3Dで節点を追加',
    '3Dビューで節点を順にクリックして輪郭を作成（もう一度押すと終了）',
    (btn) => ctrl.startNodeListPick(btn),
    'add-member-nodelist-add',
  );
  block.appendChild(addBtn);

  refreshNodeListUI(listEl, ctrl);
  return block;
}

export function refreshNodeListUI(listEl, ctrl) {
  listEl.replaceChildren();
  if (formState.panelNodeIds.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'add-member-nodelist-empty';
    empty.textContent = '（節点が未選択です）';
    listEl.appendChild(empty);
    return;
  }
  formState.panelNodeIds.forEach((nodeId, index) => {
    const li = document.createElement('li');
    li.className = 'add-member-nodelist-item';

    const idSpan = document.createElement('span');
    idSpan.className = 'add-member-nodelist-id';
    idSpan.textContent = `節点 #${nodeId}`;
    li.appendChild(idSpan);

    const ctrls = document.createElement('span');
    ctrls.className = 'add-member-nodelist-controls';
    const upBtn = makeListButton('▲', '上へ', index === 0, () => {
      [formState.panelNodeIds[index - 1], formState.panelNodeIds[index]] = [
        formState.panelNodeIds[index],
        formState.panelNodeIds[index - 1],
      ];
      refreshNodeListUI(listEl, ctrl);
      ctrl.onChange();
    });
    const downBtn = makeListButton('▼', '下へ', index === formState.panelNodeIds.length - 1, () => {
      [formState.panelNodeIds[index], formState.panelNodeIds[index + 1]] = [
        formState.panelNodeIds[index + 1],
        formState.panelNodeIds[index],
      ];
      refreshNodeListUI(listEl, ctrl);
      ctrl.onChange();
    });
    const delBtn = makeListButton('✕', '削除', false, () => {
      formState.panelNodeIds.splice(index, 1);
      refreshNodeListUI(listEl, ctrl);
      ctrl.onChange();
    });
    ctrls.append(upBtn, downBtn, delBtn);
    li.appendChild(ctrls);
    listEl.appendChild(li);
  });
}
