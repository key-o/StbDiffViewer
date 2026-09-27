/**
 * @fileoverview 継手生成フォーム
 *
 * ST-Bridge 2.0.2:
 * - StbJoints 直下の梁H形・柱H/T/十字形継手詳細をXSD駆動で作成
 * - 作成後、S/SRC部材または断面鉄骨図形の joint_id_* へ割当可能
 *
 * ST-Bridge 2.1.x:
 * - StbJointArrangement を対象部材へ配置する
 */

import { getState } from '../../../data/state/globalState.js';
import { showError } from '../../common/toast.js';
import { buildTemplateNode } from '../../../common-stb/import/section/sectionTemplateModel.js';
import {
  getActiveVersion,
  setActiveVersion,
  validateElement,
} from '../../../common-stb/import/parser/jsonSchemaLoader.js';
import { detectStbVersion } from '../../../common-stb/import/parser/utils/stbVersionDetection.js';
import {
  addNewJointElement,
  assignJointDefinition202,
  addJointArrangement,
} from './editMode/index.js';
import { openSchemaElementBuilder } from './SchemaElementBuilderForm.js';
import { createAttrFieldRow } from './schemaFieldFactory.js';

const ROOTS_202 = [
  'StbJointBeamShapeH',
  'StbJointColumnShapeH',
  'StbJointColumnShapeT',
  'StbJointColumnShapeCross',
];
const MEMBER_TAGS_21 = ['StbColumn', 'StbPost', 'StbGirder', 'StbBeam', 'StbBrace'];
const KIND_BY_TAG = {
  StbColumn: 'COLUMN',
  StbPost: 'POST',
  StbGirder: 'GIRDER',
  StbBeam: 'BEAM',
  StbBrace: 'BRACE',
};
const RELATION_ATTRS_21 = new Set(['id', 'guid', 'id_section', 'kind_member', 'id_member']);

const COLUMN_JOINT_TAGS_202 = new Set([
  'StbJointColumnShapeH',
  'StbJointColumnShapeT',
  'StbJointColumnShapeCross',
]);
const MEMBER_TARGET_TAGS_202 = {
  column: ['StbColumn', 'StbPost'],
  beam: ['StbGirder', 'StbBeam', 'StbBrace'],
};
const SECTION_TARGETS_202 = {
  column: [
    { sectionTag: 'StbSecColumn_S', figureTag: 'StbSecSteelFigureColumn_S' },
    { sectionTag: 'StbSecColumn_SRC', figureTag: 'StbSecSteelFigureColumn_SRC' },
  ],
  beam: [
    { sectionTag: 'StbSecBeam_S', figureTag: 'StbSecSteelFigureBeam_S' },
    { sectionTag: 'StbSecBeam_SRC', figureTag: 'StbSecSteelFigureBeam_SRC' },
    { sectionTag: 'StbSecBrace_S', figureTag: 'StbSecSteelFigureBrace_S' },
  ],
};

const LABELS = {
  StbJointBeamShapeH: '梁H形継手',
  StbJointColumnShapeH: '柱H形継手',
  StbJointColumnShapeT: '柱T形継手',
  StbJointColumnShapeCross: '柱十字形継手',
  StbJointShapeH: 'H形継手共通',
  StbJointShapeHFlange: 'フランジ継手',
  StbJointShapeHWeb: 'ウェブ継手',
  StbJointShapeT: 'T形継手共通',
  StbJointShapeTFlangeH: 'H側フランジ継手',
  StbJointShapeTWebHLong: 'H側ウェブ継手（長辺）',
  StbJointShapeTWebHShort: 'H側ウェブ継手（短辺）',
  StbJointShapeTFlangeT: 'T側フランジ継手',
  StbJointShapeTWebT: 'T側ウェブ継手',
  StbJointShapeCross: '十字形継手共通',
  StbJointShapeCrossXFlange: 'X側フランジ継手',
  StbJointShapeCrossXWebLong: 'X側ウェブ継手（長辺）',
  StbJointShapeCrossXWebShort: 'X側ウェブ継手（短辺）',
  StbJointShapeCrossYFlange: 'Y側フランジ継手',
  StbJointShapeCrossYWebLong: 'Y側ウェブ継手（長辺）',
  StbJointShapeCrossYWebShort: 'Y側ウェブ継手（短辺）',
};

function labelFor(name) {
  return LABELS[name] || name;
}

function createSelectRow(labelText) {
  const row = document.createElement('div');
  row.className = 'add-member-row';
  const label = document.createElement('label');
  label.className = 'add-member-label';
  label.textContent = labelText;
  const select = document.createElement('select');
  select.className = 'parameter-dropdown';
  row.append(label, select);
  return { row, select };
}

function createInputRow(labelText, type = 'text') {
  const row = document.createElement('div');
  row.className = 'add-member-row';
  const label = document.createElement('label');
  label.className = 'add-member-label';
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = type;
  input.className = 'parameter-input';
  row.append(label, input);
  return { row, input };
}

function jointFamily202(jointTag) {
  if (jointTag === 'StbJointBeamShapeH') return 'beam';
  if (COLUMN_JOINT_TAGS_202.has(jointTag)) return 'column';
  return null;
}

function getJointMembers(doc) {
  return MEMBER_TAGS_21.flatMap((tagName) =>
    Array.from(doc.querySelectorAll(tagName))
      .filter((element) => element.getAttribute('id') && element.getAttribute('id_section'))
      .map((element) => ({ tagName, element })),
  );
}

function getMemberTargets202(doc, family) {
  return (MEMBER_TARGET_TAGS_202[family] || []).flatMap((tagName) =>
    Array.from(doc.querySelectorAll(tagName))
      .filter(
        (element) =>
          element.getAttribute('id') &&
          ['S', 'SRC'].includes(String(element.getAttribute('kind_structure'))),
      )
      .map((element) => ({
        targetKind: 'member',
        targetTag: tagName,
        targetId: element.getAttribute('id'),
        element,
      })),
  );
}

function getSectionTargets202(doc, family) {
  return (SECTION_TARGETS_202[family] || []).flatMap(({ sectionTag, figureTag }) =>
    Array.from(doc.querySelectorAll(`StbSections > ${sectionTag}`))
      .filter((section) => {
        if (!section.getAttribute('id')) return false;
        return Array.from(section.children || []).some((child) => child.tagName === figureTag);
      })
      .map((section) => ({
        targetKind: 'section',
        targetTag: sectionTag,
        targetId: section.getAttribute('id'),
        figureTag,
        element: section,
      })),
  );
}

function assignmentTargetLabel(target) {
  const name = target.element?.getAttribute('name');
  if (target.targetKind === 'member') {
    return name
      ? `${target.targetTag} ${name} (#${target.targetId})`
      : `${target.targetTag} #${target.targetId}`;
  }
  return name
    ? `${target.targetTag} ${name} (#${target.targetId}) / ${target.figureTag}`
    : `${target.targetTag} #${target.targetId} / ${target.figureTag}`;
}

function endpointSuffix202(family, endpoint) {
  if (family === 'column') return endpoint === 'START' ? 'bottom' : 'top';
  return endpoint === 'START' ? 'start' : 'end';
}

function openJointAssignment202(created) {
  return new Promise((resolve) => {
    const doc = getState('models.documentA');
    const family = jointFamily202(created?.tagName);
    if (!doc || !family || !created?.id) {
      resolve(created || null);
      return;
    }

    const memberTargets = getMemberTargets202(doc, family);
    const sectionTargets = getSectionTargets202(doc, family);
    if (memberTargets.length === 0 && sectionTargets.length === 0) {
      resolve(created);
      return;
    }

    let settled = false;
    let onKeydown = null;
    let targets = memberTargets.length > 0 ? memberTargets : sectionTargets;

    const overlay = document.createElement('div');
    overlay.className = 'parameter-editor-overlay add-member-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const close = (value) => {
      if (settled) return;
      settled = true;
      if (onKeydown) document.removeEventListener('keydown', onKeydown);
      overlay.remove();
      resolve(value);
    };

    const container = document.createElement('div');
    container.className = 'parameter-editor-container';
    const header = document.createElement('div');
    header.className = 'parameter-editor-header';
    const title = document.createElement('h3');
    title.className = 'parameter-editor-title';
    title.textContent = `${labelFor(created.tagName)} #${created.id} の割当`;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'parameter-editor-close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', '閉じる');
    header.append(title, closeBtn);

    const content = document.createElement('div');
    content.className = 'parameter-editor-content';

    const scopeRow = createSelectRow('割当単位');
    if (memberTargets.length > 0) {
      const option = document.createElement('option');
      option.value = 'member';
      option.textContent = '部材へ配置（距離・継手種別を含む）';
      scopeRow.select.appendChild(option);
    }
    if (sectionTargets.length > 0) {
      const option = document.createElement('option');
      option.value = 'section';
      option.textContent = '断面の既定継手（joint_idのみ）';
      scopeRow.select.appendChild(option);
    }
    content.appendChild(scopeRow.row);

    const targetRow = createSelectRow('割当先');
    content.appendChild(targetRow.row);

    const endpointRow = createSelectRow(family === 'column' ? '柱脚・柱頭' : '始端・終端');
    for (const [value, text] of family === 'column'
      ? [
          ['START', '柱脚側（START / bottom）'],
          ['END', '柱頭側（END / top）'],
          ['BOTH', '柱脚・柱頭の両方'],
        ]
      : [
          ['START', '始端側（START）'],
          ['END', '終端側（END）'],
          ['BOTH', '始端・終端の両方'],
        ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      endpointRow.select.appendChild(option);
    }
    content.appendChild(endpointRow.row);

    const startDistanceRow = createInputRow(
      family === 'column' ? '柱脚側 継手距離' : '始端側 継手距離',
      'number',
    );
    startDistanceRow.input.min = '0.000001';
    startDistanceRow.input.step = 'any';
    content.appendChild(startDistanceRow.row);

    const startKindRow = createSelectRow(
      family === 'column' ? '柱脚側 継手種別' : '始端側 継手種別',
    );
    for (const value of ['', 'BOLT', 'WBOLT', 'WELD']) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value || '（既存値を維持 / 未指定）';
      startKindRow.select.appendChild(option);
    }
    content.appendChild(startKindRow.row);

    const endDistanceRow = createInputRow(
      family === 'column' ? '柱頭側 継手距離' : '終端側 継手距離',
      'number',
    );
    endDistanceRow.input.min = '0.000001';
    endDistanceRow.input.step = 'any';
    content.appendChild(endDistanceRow.row);

    const endKindRow = createSelectRow(family === 'column' ? '柱頭側 継手種別' : '終端側 継手種別');
    for (const value of ['', 'BOLT', 'WBOLT', 'WELD']) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value || '（既存値を維持 / 未指定）';
      endKindRow.select.appendChild(option);
    }
    content.appendChild(endKindRow.row);

    const populateTargets = () => {
      targets = scopeRow.select.value === 'section' ? sectionTargets : memberTargets;
      targetRow.select.innerHTML = '';
      targets.forEach((target, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = assignmentTargetLabel(target);
        targetRow.select.appendChild(option);
      });
      targetRow.select.value = targets.length ? '0' : '';
    };

    const loadExistingValues = () => {
      const target = targets[Number(targetRow.select.value)];
      if (!target || target.targetKind !== 'member') {
        startDistanceRow.input.value = '';
        endDistanceRow.input.value = '';
        startKindRow.select.value = '';
        endKindRow.select.value = '';
        return;
      }
      const startSuffix = endpointSuffix202(family, 'START');
      const endSuffix = endpointSuffix202(family, 'END');
      startDistanceRow.input.value = target.element.getAttribute(`joint_${startSuffix}`) || '';
      endDistanceRow.input.value = target.element.getAttribute(`joint_${endSuffix}`) || '';
      startKindRow.select.value = target.element.getAttribute(`kind_joint_${startSuffix}`) || '';
      endKindRow.select.value = target.element.getAttribute(`kind_joint_${endSuffix}`) || '';
    };

    const updateVisibility = () => {
      const isMember = scopeRow.select.value !== 'section';
      const endpoint = endpointRow.select.value;
      endpointRow.row.style.display = '';
      startDistanceRow.row.style.display = isMember && endpoint !== 'END' ? '' : 'none';
      startKindRow.row.style.display = isMember && endpoint !== 'END' ? '' : 'none';
      endDistanceRow.row.style.display = isMember && endpoint !== 'START' ? '' : 'none';
      endKindRow.row.style.display = isMember && endpoint !== 'START' ? '' : 'none';
    };

    populateTargets();
    loadExistingValues();
    updateVisibility();
    scopeRow.select.addEventListener('change', () => {
      populateTargets();
      loadExistingValues();
      updateVisibility();
    });
    targetRow.select.addEventListener('change', loadExistingValues);
    endpointRow.select.addEventListener('change', updateVisibility);

    const note = document.createElement('div');
    note.className = 'add-member-summary';
    note.textContent =
      '部材へ配置する場合は joint_id_* に加えて joint_*（継手位置）と kind_joint_* を必要に応じて設定します。断面へ割り当てる場合は StbSecSteelFigure* の joint_id_* のみを設定します。';
    content.appendChild(note);

    const buttonArea = document.createElement('div');
    buttonArea.className = 'parameter-editor-buttons';
    buttonArea.innerHTML = `
      <button type="button" class="parameter-editor-cancel joint-definition-only">定義のみ</button>
      <button type="button" class="parameter-editor-ok joint-assign-submit">割り当てる</button>
    `;
    container.append(header, content, buttonArea);
    overlay.appendChild(container);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));

    const onSubmit = () => {
      const target = targets[Number(targetRow.select.value)];
      if (!target) {
        showError('割当先を選択してください');
        return;
      }
      const result = assignJointDefinition202({
        jointTag: created.tagName,
        jointId: created.id,
        targetKind: target.targetKind,
        targetTag: target.targetTag,
        targetId: target.targetId,
        figureTag: target.figureTag,
        endpoint: endpointRow.select.value,
        distanceStart: startDistanceRow.input.value,
        distanceEnd: endDistanceRow.input.value,
        kindStart: startKindRow.select.value,
        kindEnd: endKindRow.select.value,
        combineWithCreation: true,
      });
      if (result.success) close({ ...created, assignment: result });
      else showError(result.error || '継手の割当に失敗しました');
    };

    closeBtn.addEventListener('click', () => close(created));
    buttonArea
      .querySelector('.joint-definition-only')
      ?.addEventListener('click', () => close(created));
    buttonArea.querySelector('.joint-assign-submit')?.addEventListener('click', onSubmit);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(created);
    });
    onKeydown = (event) => {
      if (event.key === 'Escape') close(created);
    };
    document.addEventListener('keydown', onKeydown);
  });
}

function openJointArrangementBuilder() {
  return new Promise((resolve) => {
    const doc = getState('models.documentA');
    if (!doc) {
      showError('モデルAが読み込まれていません');
      resolve(null);
      return;
    }

    const modelVersion = detectStbVersion(doc);
    const previousVersion = getActiveVersion();
    const switched = modelVersion !== 'unknown' && modelVersion !== previousVersion;
    if (switched) setActiveVersion(modelVersion);

    const template = buildTemplateNode('StbJointArrangement');
    if (!template) {
      if (switched) setActiveVersion(previousVersion);
      showError('StbJointArrangement のスキーマ定義を取得できません');
      resolve(null);
      return;
    }

    const members = getJointMembers(doc);
    if (members.length === 0) {
      if (switched) setActiveVersion(previousVersion);
      showError('継手を配置できる柱・間柱・梁・ブレースがありません');
      resolve(null);
      return;
    }

    let settled = false;
    let onKeydown = null;
    let fieldCtrls = [];

    const overlay = document.createElement('div');
    overlay.className = 'parameter-editor-overlay add-member-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const close = (value) => {
      if (settled) return;
      settled = true;
      if (switched) setActiveVersion(previousVersion);
      if (onKeydown) document.removeEventListener('keydown', onKeydown);
      overlay.remove();
      resolve(value);
    };

    const container = document.createElement('div');
    container.className = 'parameter-editor-container';
    const header = document.createElement('div');
    header.className = 'parameter-editor-header';
    const title = document.createElement('h3');
    title.className = 'parameter-editor-title';
    title.textContent = `新規継手配置（ST-Bridge ${modelVersion}）`;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'parameter-editor-close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', '閉じる');
    header.append(title, closeBtn);

    const content = document.createElement('div');
    content.className = 'parameter-editor-content';
    const memberRow = createSelectRow('対象部材');
    members.forEach(({ tagName, element }, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      const id = element.getAttribute('id');
      const name = element.getAttribute('name');
      option.textContent = name ? `${tagName} ${name} (#${id})` : `${tagName} #${id}`;
      memberRow.select.appendChild(option);
    });
    content.appendChild(memberRow.row);

    const sourceRow = createSelectRow('コピー元継手配置');
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '（コピーしない）';
    sourceRow.select.appendChild(blank);
    const sources = Array.from(
      doc.querySelectorAll('StbMembers > StbJointArrangements > StbJointArrangement'),
    ).filter((element) => element.getAttribute('id'));
    sources.forEach((source, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      const name = source.getAttribute('name');
      option.textContent = name
        ? `${name} / StbJointArrangement #${source.getAttribute('id')}`
        : `StbJointArrangement #${source.getAttribute('id')}`;
      sourceRow.select.appendChild(option);
    });
    content.appendChild(sourceRow.row);

    const editorHost = document.createElement('div');
    editorHost.className = 'section-builder-editor';
    content.appendChild(editorHost);

    const rebuildFields = (source = null) => {
      editorHost.innerHTML = '';
      fieldCtrls = [];
      for (const attr of template.attributes) {
        if (RELATION_ATTRS_21.has(attr.name)) continue;
        const ctrl = createAttrFieldRow(attr, {
          initialValue: source?.getAttribute(attr.name) ?? undefined,
        });
        editorHost.appendChild(ctrl.row);
        fieldCtrls.push(ctrl);
      }
    };
    rebuildFields();
    sourceRow.select.addEventListener('change', () => {
      const source = sourceRow.select.value === '' ? null : sources[Number(sourceRow.select.value)];
      rebuildFields(source || null);
    });

    const buttonArea = document.createElement('div');
    buttonArea.className = 'parameter-editor-buttons';
    buttonArea.innerHTML = `
      <button type="button" class="parameter-editor-cancel">キャンセル</button>
      <button type="button" class="parameter-editor-ok">作成</button>
    `;
    container.append(header, content, buttonArea);
    overlay.appendChild(container);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));

    const onSubmit = () => {
      const selected = members[Number(memberRow.select.value)];
      if (!selected) return;
      const attrs = {};
      for (const ctrl of fieldCtrls) attrs[ctrl.name] = ctrl.getValue();

      const memberId = selected.element.getAttribute('id');
      const validationAttrs = {
        ...attrs,
        id: '1',
        id_section: selected.element.getAttribute('id_section'),
        kind_member: KIND_BY_TAG[selected.tagName],
        id_member: memberId,
      };
      const validation = validateElement('StbJointArrangement', validationAttrs);
      const errors = (validation.errors || []).filter(
        (error) => !RELATION_ATTRS_21.has(error.attr),
      );
      if (errors.length > 0) {
        const first = errors[0];
        showError(`入力エラー（${first.attr}）: ${first.error}`);
        return;
      }

      const result = addJointArrangement({
        memberTag: selected.tagName,
        memberId,
        attrs,
      });
      if (result.success) close(result);
      else showError(result.error || '継手配置の作成に失敗しました');
    };

    closeBtn.addEventListener('click', () => close(null));
    buttonArea
      .querySelector('.parameter-editor-cancel')
      ?.addEventListener('click', () => close(null));
    buttonArea.querySelector('.parameter-editor-ok')?.addEventListener('click', onSubmit);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(null);
    });
    onKeydown = (event) => {
      if (event.key === 'Escape') close(null);
    };
    document.addEventListener('keydown', onKeydown);
  });
}

async function openJointDefinitionBuilder202() {
  const created = await openSchemaElementBuilder({
    schemaContainerName: 'StbJoints',
    rootElementNames: ROOTS_202,
    initialRootElementName: ROOTS_202[0],
    rootSelectLabel: '継手種別',
    copySelectLabel: 'コピー元',
    emptyCopyLabel: '（コピーしない：空の継手から作成）',
    labelFor,
    titleForRoot: (rootName) => `新規継手の作成（${labelFor(rootName)}）`,
    addElement: addNewJointElement,
  });
  if (!created) return null;
  return openJointAssignment202(created);
}

/** 継手ビルダーをモデルのST-Bridgeバージョンに応じて開く。 */
export function openJointBuilder() {
  const doc = getState('models.documentA');
  const version = doc ? detectStbVersion(doc) : 'unknown';
  if (String(version).startsWith('2.1')) return openJointArrangementBuilder();
  return openJointDefinitionBuilder202();
}

/** 編集操作列に「＋ 継手」ボタンを追加する。 */
export function initJointBuilderForm() {
  if (document.getElementById('add-joint-button')) return;
  const memberButton = document.getElementById('add-member-button');
  if (!memberButton?.parentElement) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'add-joint-button';
  button.className = memberButton.className || 'btn btn-secondary';
  button.title = 'ST-Bridgeバージョンに応じた継手定義または継手配置を作成します';
  button.textContent = '＋ 継手';
  button.addEventListener('click', () => openJointBuilder());
  memberButton.insertAdjacentElement('afterend', button);
}
