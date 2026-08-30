/**
 * @fileoverview 壁・床開口の新規作成＋割当フォーム
 *
 * 2.0.2 は StbOpen + StbOpenIdList、2.1.x は StbOpenArrangement を生成する。
 * 開口補強断面 StbSecOpen_RC は既存選択または SectionBuilder から新規作成できる。
 */

import { getState } from '../../../data/state/globalState.js';
import { showError } from '../../common/toast.js';
import { buildTemplateNode } from '../../../common-stb/import/section/sectionTemplateModel.js';
import {
  validateElement,
  getActiveVersion,
  setActiveVersion,
} from '../../../common-stb/import/parser/jsonSchemaLoader.js';
import { detectStbVersion } from '../../../common-stb/import/parser/utils/stbVersionDetection.js';
import { addOpenWithAssignment } from './editMode/index.js';
import { openSectionBuilder } from './SectionBuilderForm.js';
import { createAttrFieldRow } from './schemaFieldFactory.js';

function is21(version) {
  return String(version || '').startsWith('2.1');
}

function selectorById(tagName, id) {
  return `${tagName}[id="${String(id).replace(/"/g, '\\"')}"]`;
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

function getPanels(doc) {
  return [...Array.from(doc.querySelectorAll('StbWall')), ...Array.from(doc.querySelectorAll('StbSlab'))]
    .filter((element) => element.getAttribute('id'))
    .sort((a, b) => {
      if (a.tagName !== b.tagName) return a.tagName.localeCompare(b.tagName);
      return Number(a.getAttribute('id')) - Number(b.getAttribute('id'));
    });
}

function getOpenSections(doc) {
  return Array.from(doc.querySelectorAll('StbSections > StbSecOpen_RC')).filter((element) =>
    element.getAttribute('id'),
  );
}

function getOpenSources(doc, openTagName) {
  const selector =
    openTagName === 'StbOpenArrangement'
      ? 'StbMembers > StbOpenArrangements > StbOpenArrangement'
      : 'StbMembers > StbOpens > StbOpen';
  return Array.from(doc.querySelectorAll(selector)).filter((element) => element.getAttribute('id'));
}

function populatePanelSelect(select, doc) {
  select.innerHTML = '';
  const panels = getPanels(doc);
  if (panels.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '（壁・床がありません）';
    select.appendChild(option);
    return;
  }
  for (const panel of panels) {
    const option = document.createElement('option');
    const id = panel.getAttribute('id');
    option.value = `${panel.tagName}:${id}`;
    const kind = panel.tagName === 'StbWall' ? '壁' : '床';
    const name = panel.getAttribute('name');
    option.textContent = name ? `${kind} ${name} (#${id})` : `${kind} #${id}`;
    select.appendChild(option);
  }
}

function populateSectionSelect(select, doc, selectedId = '', required = false) {
  select.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = required ? '（開口断面を選択）' : '（補強断面なし）';
  select.appendChild(blank);
  for (const section of getOpenSections(doc)) {
    const option = document.createElement('option');
    option.value = section.getAttribute('id');
    const name = section.getAttribute('name');
    option.textContent = name ? `${name} / #${option.value}` : `StbSecOpen_RC #${option.value}`;
    select.appendChild(option);
  }
  select.value =
    selectedId && Array.from(select.options).some((option) => option.value === selectedId)
      ? selectedId
      : '';
}

/** 壁・床開口の作成フォームを開く。 */
export function openOpenBuilder() {
  return new Promise((resolve) => {
    const doc = getState('models.documentA');
    if (!doc) {
      showError('モデルAが読み込まれていません');
      resolve(null);
      return;
    }

    const modelVersion = detectStbVersion(doc);
    const version21 = is21(modelVersion);
    const openTagName = version21 ? 'StbOpenArrangement' : 'StbOpen';
    const relationAttrs = new Set(['id', 'guid', 'id_section']);
    if (version21) {
      relationAttrs.add('kind_member');
      relationAttrs.add('id_member');
    }

    const previousVersion = getActiveVersion();
    const switched = modelVersion !== 'unknown' && modelVersion !== previousVersion;
    if (switched) setActiveVersion(modelVersion);

    const template = buildTemplateNode(openTagName);
    if (!template) {
      if (switched) setActiveVersion(previousVersion);
      showError(`${openTagName} のスキーマ定義を取得できません`);
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
    title.textContent = `新規開口の作成・割当（ST-Bridge ${modelVersion}）`;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'parameter-editor-close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', '閉じる');
    header.append(title, closeBtn);

    const content = document.createElement('div');
    content.className = 'parameter-editor-content';

    const panelRow = createSelectRow('割当先（壁・床）');
    populatePanelSelect(panelRow.select, doc);
    content.appendChild(panelRow.row);

    const sourceRow = createSelectRow('コピー元開口');
    const noSource = document.createElement('option');
    noSource.value = '';
    noSource.textContent = '（コピーしない）';
    sourceRow.select.appendChild(noSource);
    for (const source of getOpenSources(doc, openTagName)) {
      const option = document.createElement('option');
      option.value = source.getAttribute('id');
      const name = source.getAttribute('name');
      option.textContent = name
        ? `${name} / ${openTagName} #${option.value}`
        : `${openTagName} #${option.value}`;
      sourceRow.select.appendChild(option);
    }
    content.appendChild(sourceRow.row);

    const sectionRow = createSelectRow(version21 ? '開口断面（必須）' : '開口補強断面');
    populateSectionSelect(sectionRow.select, doc, '', version21);
    const newSectionBtn = document.createElement('button');
    newSectionBtn.type = 'button';
    newSectionBtn.className = 'parameter-editor-ok add-member-new-section-btn';
    newSectionBtn.textContent = '＋ 新規開口断面';
    sectionRow.row.appendChild(newSectionBtn);
    content.appendChild(sectionRow.row);

    const editorHost = document.createElement('div');
    editorHost.className = 'section-builder-editor';
    content.appendChild(editorHost);

    const rebuildFields = (source = null) => {
      editorHost.innerHTML = '';
      fieldCtrls = [];
      for (const attr of template.attributes) {
        if (relationAttrs.has(attr.name)) continue;
        const ctrl = createAttrFieldRow(attr, {
          initialValue: source?.getAttribute(attr.name) ?? undefined,
        });
        editorHost.appendChild(ctrl.row);
        fieldCtrls.push(ctrl);
      }
      populateSectionSelect(
        sectionRow.select,
        doc,
        source?.getAttribute('id_section') || '',
        version21,
      );
    };

    rebuildFields();
    sourceRow.select.addEventListener('change', () => {
      const source = sourceRow.select.value
        ? doc.querySelector(selectorById(openTagName, sourceRow.select.value))
        : null;
      rebuildFields(source);
    });

    newSectionBtn.addEventListener('click', async () => {
      const result = await openSectionBuilder({
        rootElementNames: ['StbSecOpen_RC'],
        initialRootElementName: 'StbSecOpen_RC',
      });
      if (!result?.id) return;
      populateSectionSelect(sectionRow.select, doc, result.id, version21);
    });

    const buttonArea = document.createElement('div');
    buttonArea.className = 'parameter-editor-buttons';
    buttonArea.innerHTML = `
      <button type="button" class="parameter-editor-cancel">キャンセル</button>
      <button type="button" class="parameter-editor-ok">作成して割当</button>
    `;
    container.append(header, content, buttonArea);
    overlay.appendChild(container);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));

    const onSubmit = () => {
      const panelValue = panelRow.select.value;
      const separator = panelValue.indexOf(':');
      if (separator < 0) {
        showError('割当先の壁または床を選択してください');
        return;
      }
      const panelTag = panelValue.slice(0, separator);
      const panelId = panelValue.slice(separator + 1);
      const attrs = {};
      for (const ctrl of fieldCtrls) attrs[ctrl.name] = ctrl.getValue();
      if (sectionRow.select.value) attrs.id_section = sectionRow.select.value;

      const validationAttrs = { ...attrs };
      if (version21) {
        validationAttrs.id = '1';
        validationAttrs.kind_member = panelTag === 'StbWall' ? 'WALL' : 'SLAB';
        validationAttrs.id_member = panelId;
      } else {
        validationAttrs.id = '1';
      }
      const validation = validateElement(openTagName, validationAttrs);
      const errors = (validation.errors || []).filter((error) => !relationAttrs.has(error.attr));
      if (errors.length > 0) {
        const first = errors[0];
        showError(`入力エラー（${first.attr}）: ${first.error}`);
        return;
      }

      const result = addOpenWithAssignment({ panelTag, panelId, attrs });
      if (result.success) close(result);
      else showError(result.error || '開口の作成・割当に失敗しました');
    };

    closeBtn.addEventListener('click', () => close(null));
    buttonArea.querySelector('.parameter-editor-cancel')?.addEventListener('click', () => close(null));
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

/** 編集操作列に「＋ 開口」ボタンを追加する。 */
export function initOpenBuilderForm() {
  if (document.getElementById('add-open-button')) return;
  const memberButton = document.getElementById('add-member-button');
  if (!memberButton?.parentElement) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'add-open-button';
  button.className = memberButton.className || 'btn btn-secondary';
  button.title = 'ST-Bridgeバージョンに応じた開口を作成し、壁または床へ割り当てます';
  button.textContent = '＋ 開口';
  button.addEventListener('click', () => openOpenBuilder());
  memberButton.insertAdjacentElement('afterend', button);
}
