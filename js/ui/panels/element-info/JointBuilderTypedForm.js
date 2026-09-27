/**
 * @fileoverview ST-Bridge 2.1.x の typed StbJointArrangement builder。
 *
 * 2.1.x では StbJointArrangement.id_section は host 部材の断面IDではなく、
 * StbJoints 直下の継手定義IDを参照する。2.0.2 は既存 JointBuilderForm へ委譲する。
 */

import { getState } from '../../../data/state/globalState.js';
import editingSession from '../../../app/editing/editingSession.js';
import { showError } from '../../common/toast.js';
import { buildTemplateNode } from '../../../common-stb/import/section/sectionTemplateModel.js';
import {
  getActiveVersion,
  setActiveVersion,
  validateElement,
} from '../../../common-stb/import/parser/jsonSchemaLoader.js';
import { detectStbVersion } from '../../../common-stb/import/parser/utils/stbVersionDetection.js';
import { addJointArrangement, getCompatibleJointDefinitions21 } from './editMode/index.js';
import { openJointBuilder as openLegacyJointBuilder } from './JointBuilderForm.js';
import { createAttrFieldRow } from './schemaFieldFactory.js';

const MEMBER_TAGS = ['StbColumn', 'StbPost', 'StbGirder', 'StbBeam', 'StbBrace'];
const KIND_BY_TAG = Object.freeze({
  StbColumn: 'COLUMN',
  StbPost: 'POST',
  StbGirder: 'GIRDER',
  StbBeam: 'BEAM',
  StbBrace: 'BRACE',
});
const RELATION_ATTRS = new Set(['id', 'guid', 'id_section', 'kind_member', 'id_member']);

function activeDocument() {
  if (editingSession.getState?.()?.active === true) {
    return editingSession.getWorkingDocument?.() || null;
  }
  return getState('models.documentA');
}

function is21(version) {
  return String(version || '').startsWith('2.1');
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

function memberLabel({ tagName, element }) {
  const id = element.getAttribute('id');
  const name = element.getAttribute('name');
  return name ? `${tagName} ${name} (#${id})` : `${tagName} #${id}`;
}

function jointLabel(definition) {
  return definition.name
    ? `${definition.tagName} ${definition.name} (#${definition.id})`
    : `${definition.tagName} #${definition.id}`;
}

function getMembersWithJointDefinitions(doc) {
  return MEMBER_TAGS.flatMap((tagName) => {
    if (getCompatibleJointDefinitions21(doc, tagName).length === 0) return [];
    return Array.from(doc.querySelectorAll(tagName))
      .filter((element) => element.getAttribute('id'))
      .map((element) => ({ tagName, element }));
  });
}

function getArrangementSources(doc) {
  return Array.from(
    doc.querySelectorAll('StbMembers > StbJointArrangements > StbJointArrangement'),
  ).filter((element) => element.getAttribute('id'));
}

function sourceLabel(source) {
  const name = source.getAttribute('name');
  const id = source.getAttribute('id');
  const jointId = source.getAttribute('id_section');
  return name
    ? `${name} / StbJointArrangement #${id} / 継手 #${jointId || '?'}`
    : `StbJointArrangement #${id} / 継手 #${jointId || '?'}`;
}

function populateJointDefinitions(select, doc, memberTag, preferredId = '') {
  const definitions = getCompatibleJointDefinitions21(doc, memberTag);
  select.innerHTML = '';
  for (const definition of definitions) {
    const option = document.createElement('option');
    option.value = definition.id;
    option.textContent = jointLabel(definition);
    select.appendChild(option);
  }
  if (preferredId && definitions.some((definition) => definition.id === String(preferredId))) {
    select.value = String(preferredId);
  } else if (definitions.length > 0) {
    select.selectedIndex = 0;
  }
  return definitions;
}

function openTypedJointArrangementBuilder() {
  return new Promise((resolve) => {
    const doc = activeDocument();
    if (!doc) {
      showError('モデルAまたは Working Document が読み込まれていません');
      resolve(null);
      return;
    }

    const modelVersion = detectStbVersion(doc);
    if (!is21(modelVersion)) {
      resolve(null);
      return;
    }

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

    const members = getMembersWithJointDefinitions(doc);
    if (members.length === 0) {
      if (switched) setActiveVersion(previousVersion);
      showError('StbJoints に対応継手定義を持つ配置可能部材がありません');
      resolve(null);
      return;
    }

    const sources = getArrangementSources(doc);
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
    members.forEach((member, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = memberLabel(member);
      memberRow.select.appendChild(option);
    });
    content.appendChild(memberRow.row);

    const jointRow = createSelectRow('継手定義（StbJoints）');
    content.appendChild(jointRow.row);

    const sourceRow = createSelectRow('コピー元継手配置');
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '（コピーしない）';
    sourceRow.select.appendChild(blank);
    sources.forEach((source, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = sourceLabel(source);
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
        if (RELATION_ATTRS.has(attr.name)) continue;
        const ctrl = createAttrFieldRow(attr, {
          initialValue: source?.getAttribute(attr.name) ?? undefined,
        });
        editorHost.appendChild(ctrl.row);
        fieldCtrls.push(ctrl);
      }
    };

    const currentMember = () => members[Number(memberRow.select.value)] || null;
    const refreshJointDefinitions = (preferredId = '') => {
      const member = currentMember();
      return member
        ? populateJointDefinitions(jointRow.select, doc, member.tagName, preferredId)
        : [];
    };

    rebuildFields();
    refreshJointDefinitions();

    memberRow.select.addEventListener('change', () => refreshJointDefinitions());
    sourceRow.select.addEventListener('change', () => {
      const source = sourceRow.select.value === '' ? null : sources[Number(sourceRow.select.value)];
      rebuildFields(source || null);
      refreshJointDefinitions(source?.getAttribute('id_section') || '');
    });

    const note = document.createElement('div');
    note.className = 'add-member-summary';
    note.textContent =
      'ST-Bridge 2.1.x の id_section は部材断面ではなく StbJoints の継手定義IDです。柱・間柱は StbJointColumn*、梁・ブレースは StbJointBeam* から選択します。';
    content.appendChild(note);

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
      const selected = currentMember();
      if (!selected) {
        showError('対象部材を選択してください');
        return;
      }
      const jointId = String(jointRow.select.value || '').trim();
      if (!jointId) {
        showError('対象部材種別に対応する継手定義を選択してください');
        return;
      }

      const attrs = {};
      for (const ctrl of fieldCtrls) attrs[ctrl.name] = ctrl.getValue();
      attrs.id_section = jointId;
      const memberId = selected.element.getAttribute('id');
      const validationAttrs = {
        ...attrs,
        id: '1',
        id_section: jointId,
        kind_member: KIND_BY_TAG[selected.tagName],
        id_member: memberId,
      };
      const validation = validateElement('StbJointArrangement', validationAttrs);
      const errors = (validation.errors || []).filter((error) => !RELATION_ATTRS.has(error.attr));
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

/** ST-Bridge バージョンに応じて typed 2.1 builder / 既存2.0.2 builderを開く。 */
export function openJointBuilder() {
  const doc = activeDocument();
  const version = doc ? detectStbVersion(doc) : 'unknown';
  if (is21(version)) return openTypedJointArrangementBuilder();
  return openLegacyJointBuilder();
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
