/**
 * @fileoverview XSD駆動の汎用要素ビルダー
 *
 * StbSections / StbJoints など、モデル直下のコンテナ要素にぶら下がる
 * id付きルート要素をXSD定義から構築する。choice / sequence / minOccurs /
 * maxOccurs を sectionTemplateModel で復元し、既存同型要素のコピーも扱う。
 *
 * @module ui/panels/element-info/SchemaElementBuilderForm
 */

import { createLogger } from '../../../utils/logger.js';
import editDocumentProvider from '../../../app/editing/editDocumentProvider.js';
import { showError } from '../../common/toast.js';
import {
  buildTemplateNode,
  findMatchingChoiceOption,
  UNBOUNDED_OCCURS,
  validateTemplateTree,
} from '../../../common-stb/import/section/sectionTemplateModel.js';
import {
  buildSectionElement,
  sectionElementToFormState,
} from '../../../common-stb/import/section/sectionXmlBuilder.js';
import {
  getElementChildren,
  validateElement,
  getActiveVersion,
  setActiveVersion,
} from '../../../common-stb/import/parser/jsonSchemaLoader.js';
import { detectStbVersion } from '../../../common-stb/import/parser/utils/stbVersionDetection.js';
import { createAttrFieldRow } from './schemaFieldFactory.js';

const log = createLogger('ui:panels:schema-element-builder');
const SKIP_ATTRS = new Set(['id', 'guid']);

function directChildrenByName(initialChildren, name) {
  return (initialChildren || []).filter((child) => child.elementName === name);
}

function renderNode(elementName, host, options) {
  const node = buildTemplateNode(elementName);
  const initialState =
    options.initialState?.elementName === elementName ? options.initialState : null;
  if (!node) return { collect: () => ({ elementName, attrs: {}, children: [] }) };

  const fieldCtrls = [];
  for (const attr of node.attributes) {
    if (SKIP_ATTRS.has(attr.name)) continue;
    const indexDefault = attr.name === 'pos' ? options.posIndex : undefined;
    const ctrl = createAttrFieldRow(attr, {
      indexDefault,
      initialValue: initialState?.attrs?.[attr.name],
    });
    host.appendChild(ctrl.row);
    fieldCtrls.push(ctrl);
  }

  const initialChildren = initialState?.children || [];
  const groupCollectors = node.childGroups.map((group) =>
    renderChildGroup(group, host, initialChildren, {
      ...options,
      hasInitialState: !!initialState,
    }),
  );

  return {
    collect: () => {
      const attrs = {};
      for (const ctrl of fieldCtrls) attrs[ctrl.name] = ctrl.getValue();
      return {
        elementName,
        attrs,
        children: groupCollectors.flatMap((collect) => collect()),
      };
    },
  };
}

function renderChildGroup(group, host, initialChildren, options) {
  if (group.kind === 'choice') return renderChoiceGroup(group, host, initialChildren, options);
  const member = group.options[0];
  const initialStates = directChildrenByName(initialChildren, member.name);
  return renderMemberOccurrences(member, host, initialStates, {
    ...options,
    optionalSingle: group.kind === 'optional' && member.maxOccurs === 1,
  });
}

function renderMemberOccurrences(member, host, initialStates, options = {}) {
  const labelFor = options.labelFor;
  if (options.optionalSingle) {
    const defaultOn = options.hasInitialState
      ? initialStates.length > 0
      : member.name.includes('Figure');
    const block = appendGroupBlock(host, labelFor(member.name), {
      optional: true,
      defaultOn,
    });
    let ctrl = null;

    const rebuild = (state = initialStates[0] || null) => {
      block.body.innerHTML = '';
      ctrl = block.checkbox.checked
        ? renderNode(member.name, block.body, { ...options, initialState: state })
        : null;
      block.body.style.display = block.checkbox.checked ? '' : 'none';
    };
    block.checkbox.addEventListener('change', () => rebuild(null));
    rebuild();
    return () => (ctrl ? [ctrl.collect()] : []);
  }

  const maxLabel = member.maxOccurs === UNBOUNDED_OCCURS ? '∞' : String(member.maxOccurs);
  const block = appendGroupBlock(
    host,
    member.minOccurs === member.maxOccurs
      ? labelFor(member.name)
      : `${labelFor(member.name)}（${member.minOccurs}..${maxLabel}）`,
  );

  const instancesHost = document.createElement('div');
  block.body.appendChild(instancesHost);
  const controls = document.createElement('div');
  controls.className = 'section-builder-occurrence-controls';
  block.body.appendChild(controls);

  let instanceCtrls = [];
  let seedStates =
    initialStates.length > 0
      ? [...initialStates]
      : Array.from({ length: Math.max(0, member.minOccurs) }, () => null);

  const snapshot = () => instanceCtrls.map((ctrl) => ctrl.collect());

  const rebuild = (nextStates = seedStates) => {
    seedStates = [...nextStates];
    instancesHost.innerHTML = '';
    controls.innerHTML = '';
    instanceCtrls = [];

    seedStates.forEach((state, index) => {
      const instanceBlock =
        seedStates.length > 1 || member.maxOccurs > 1
          ? appendGroupBlock(instancesHost, `${labelFor(member.name)} #${index + 1}`)
          : { body: instancesHost };
      const ctrl = renderNode(member.name, instanceBlock.body, {
        ...options,
        posIndex: index,
        initialState: state,
      });
      instanceCtrls.push(ctrl);

      if (seedStates.length > member.minOccurs) {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'parameter-editor-cancel section-builder-occurrence-remove';
        removeBtn.textContent = 'この要素を削除';
        removeBtn.addEventListener('click', () => {
          const current = snapshot();
          current.splice(index, 1);
          rebuild(current);
        });
        instanceBlock.body.appendChild(removeBtn);
      }
    });

    if (seedStates.length < member.maxOccurs) {
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'parameter-editor-ok section-builder-occurrence-add';
      addBtn.textContent = `＋ ${labelFor(member.name)} を追加`;
      addBtn.addEventListener('click', () => {
        const current = snapshot();
        current.push(null);
        rebuild(current);
      });
      controls.appendChild(addBtn);
    }
  };

  rebuild();
  return () => instanceCtrls.map((ctrl) => ctrl.collect());
}

function renderChoiceGroup(group, host, initialChildren, options) {
  const labelFor = options.labelFor;
  const block = appendGroupBlock(host, '種別');
  const select = document.createElement('select');
  select.className = 'parameter-dropdown';

  group.options.forEach((option, index) => {
    const opt = document.createElement('option');
    opt.value = String(index);
    const members = option.members || [option];
    const optionalNames = members
      .filter((member) => member.minOccurs === 0)
      .map((member) => labelFor(member.name));
    opt.textContent = optionalNames.length
      ? `${labelFor(option.name)}（+ ${optionalNames.join(' / ')} 任意）`
      : labelFor(option.name);
    select.appendChild(opt);
  });

  const selectRow = document.createElement('div');
  selectRow.className = 'add-member-row';
  const selectLabel = document.createElement('label');
  selectLabel.className = 'add-member-label';
  selectLabel.textContent = '選択';
  selectRow.append(selectLabel, select);
  block.body.appendChild(selectRow);

  const groupNames = new Set(
    group.options.flatMap((option) => (option.members || [option]).map((member) => member.name)),
  );
  const relevantInitial = initialChildren.filter((child) => groupNames.has(child.elementName));
  const matched = findMatchingChoiceOption(group, relevantInitial);
  if (matched) {
    const matchedIndex = group.options.indexOf(matched);
    if (matchedIndex >= 0) select.value = String(matchedIndex);
  }

  const instanceHost = document.createElement('div');
  block.body.appendChild(instanceHost);
  let memberCollectors = [];
  let useInitial = true;

  const rebuild = () => {
    instanceHost.innerHTML = '';
    memberCollectors = [];
    const option = group.options[Number(select.value)] || group.options[0];
    if (!option) return;

    for (const member of option.members || [option]) {
      memberCollectors.push(
        renderMemberOccurrences(
          member,
          instanceHost,
          useInitial ? directChildrenByName(relevantInitial, member.name) : [],
          {
            ...options,
            optionalSingle: member.minOccurs === 0 && member.maxOccurs === 1,
            hasInitialState: options.hasInitialState && useInitial,
          },
        ),
      );
    }
    useInitial = false;
  };

  select.addEventListener('change', rebuild);
  rebuild();
  return () => memberCollectors.flatMap((collect) => collect());
}

function appendGroupBlock(host, title, { optional = false, defaultOn = false } = {}) {
  const block = document.createElement('div');
  block.className = 'section-builder-group';
  const heading = document.createElement('div');
  heading.className = 'section-builder-group-title';

  let checkbox;
  if (optional) {
    checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = defaultOn;
    const label = document.createElement('label');
    label.className = 'section-builder-group-check';
    label.append(checkbox, document.createTextNode(` ${title}`));
    heading.appendChild(label);
  } else {
    heading.textContent = title;
  }
  block.appendChild(heading);

  const body = document.createElement('div');
  body.className = 'section-builder-group-body';
  block.appendChild(body);
  host.appendChild(block);
  return { body, checkbox };
}

function validateAttributeTree(formState, errors) {
  const result = validateElement(formState.elementName, formState.attrs || {});
  for (const error of result.errors || []) {
    if (SKIP_ATTRS.has(error.attr)) continue;
    errors.push({ element: formState.elementName, attr: error.attr, error: error.error });
  }
  for (const child of formState.children || []) validateAttributeTree(child, errors);
}

function validateFormStateTree(formState) {
  const errors = [];
  validateAttributeTree(formState, errors);
  for (const error of validateTemplateTree(formState)) {
    errors.push({ element: error.element, attr: '子要素', error: error.error });
  }
  return errors;
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

function sourceElementsForRoot(doc, containerName, rootName) {
  const container = doc.querySelector(containerName);
  if (!container) return [];
  return Array.from(container.children).filter(
    (child) => child.tagName === rootName && child.getAttribute('id'),
  );
}

/**
 * XSD駆動要素ビルダーを開く。
 * @param {Object} config
 * @param {string} config.schemaContainerName XSD上の親要素名（StbSections / StbJoints）
 * @param {string[]} config.rootElementNames 作成候補ルート
 * @param {string} [config.initialRootElementName]
 * @param {string} [config.rootSelectLabel]
 * @param {string} [config.copySelectLabel]
 * @param {string} [config.emptyCopyLabel]
 * @param {(name:string)=>string} [config.labelFor]
 * @param {(rootName:string)=>string} [config.titleForRoot]
 * @param {(element:Element)=>{success:boolean,id:string|null,tagName?:string,error?:string}} config.addElement
 * @returns {Promise<{id:string,tagName:string}|null>}
 */
export function openSchemaElementBuilder(config) {
  return new Promise((resolve) => {
    const docA = editDocumentProvider.getActiveEditDocument();
    if (!docA) {
      showError('モデルAが読み込まれていません');
      resolve(null);
      return;
    }

    const labelFor = config.labelFor || ((name) => name);
    const modelAVersion = detectStbVersion(docA);
    const previousActiveVersion = getActiveVersion();
    const versionSwitched = modelAVersion !== 'unknown' && modelAVersion !== previousActiveVersion;
    if (versionSwitched) setActiveVersion(modelAVersion);

    const schemaRoots = new Set(
      (getElementChildren(config.schemaContainerName) || []).map((child) => child.name),
    );
    const requested = [...new Set((config.rootElementNames || []).filter(Boolean))];
    const rootElementNames = requested.filter((name) => schemaRoots.has(name));
    if (rootElementNames.length === 0) {
      if (versionSwitched) setActiveVersion(previousActiveVersion);
      showError(`このST-Bridgeバージョンで作成可能な${config.schemaContainerName}要素がありません`);
      resolve(null);
      return;
    }

    let settled = false;
    let rootCtrl = null;
    let onKeydown = null;

    const overlay = document.createElement('div');
    overlay.className = 'parameter-editor-overlay add-member-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const close = (value) => {
      if (settled) return;
      settled = true;
      if (versionSwitched) setActiveVersion(previousActiveVersion);
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
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'parameter-editor-close';
    closeBtn.setAttribute('aria-label', '閉じる');
    closeBtn.textContent = '×';
    header.append(title, closeBtn);

    const content = document.createElement('div');
    content.className = 'parameter-editor-content';
    const rootRow = createSelectRow(config.rootSelectLabel || '要素種別');
    for (const rootName of rootElementNames) {
      const option = document.createElement('option');
      option.value = rootName;
      option.textContent = `${labelFor(rootName)} (${rootName})`;
      rootRow.select.appendChild(option);
    }
    rootRow.select.value = rootElementNames.includes(config.initialRootElementName)
      ? config.initialRootElementName
      : rootElementNames[0];
    rootRow.select.disabled = rootElementNames.length === 1;
    content.appendChild(rootRow.row);

    const sourceRow = createSelectRow(config.copySelectLabel || 'コピー元');
    content.appendChild(sourceRow.row);
    const editorHost = document.createElement('div');
    editorHost.className = 'section-builder-editor';
    content.appendChild(editorHost);

    const populateSources = () => {
      sourceRow.select.innerHTML = '';
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = config.emptyCopyLabel || '（コピーしない：空の要素から作成）';
      sourceRow.select.appendChild(blank);
      for (const source of sourceElementsForRoot(
        docA,
        config.schemaContainerName,
        rootRow.select.value,
      )) {
        const option = document.createElement('option');
        option.value = source.getAttribute('id');
        const name = source.getAttribute('name') || source.getAttribute('joint_name');
        option.textContent = name
          ? `${name} / ${source.tagName} #${option.value}`
          : `${source.tagName} #${option.value}`;
        sourceRow.select.appendChild(option);
      }
    };

    const rebuildEditor = () => {
      editorHost.innerHTML = '';
      const rootName = rootRow.select.value;
      const sourceId = sourceRow.select.value;
      const source = sourceId
        ? sourceElementsForRoot(docA, config.schemaContainerName, rootName).find(
            (element) => element.getAttribute('id') === sourceId,
          )
        : null;
      rootCtrl = renderNode(rootName, editorHost, {
        initialState: source ? sectionElementToFormState(source) : null,
        labelFor,
      });
      title.textContent = config.titleForRoot
        ? config.titleForRoot(rootName)
        : `新規${labelFor(rootName)}の作成`;
    };

    populateSources();
    rebuildEditor();
    rootRow.select.addEventListener('change', () => {
      populateSources();
      sourceRow.select.value = '';
      rebuildEditor();
    });
    sourceRow.select.addEventListener('change', rebuildEditor);

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
      const doc = editDocumentProvider.getActiveEditDocument();
      if (!doc || !rootCtrl) return;
      const formState = rootCtrl.collect();
      const errors = validateFormStateTree(formState);
      if (errors.length > 0) {
        const first = errors[0];
        showError(`入力エラー（${first.element} / ${first.attr}）: ${first.error}`);
        return;
      }

      let builtElement;
      try {
        builtElement = buildSectionElement(doc, formState);
      } catch (error) {
        log.warn('XML要素の構築に失敗:', error);
        showError('要素の構築に失敗しました');
        return;
      }

      const result = config.addElement(builtElement);
      if (result.success) close({ id: result.id, tagName: result.tagName || builtElement.tagName });
      else showError(result.error || '要素の追加に失敗しました');
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
