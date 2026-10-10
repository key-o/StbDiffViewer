/**
 * @fileoverview 3Dの「表示要素設定」を簡易CADにも適用するためのUI境界。
 * 図面側へ渡すのは要素表示・タグ選択・要素別色のsnapshotだけとし、renderer/UIを相互依存させない。
 */

import { DRAWING_DETAIL_TAG_TEMPLATE_BY_ELEMENT_TYPE } from '../../config/drawingTagTemplates.js';
import { tagFamilyCategoryForElementType } from '../../data/drawing/tags/tagFamilyDefinition.js';
import {
  familySelectionValue,
  listTagFamiliesForCategory,
} from '../../data/drawing/tags/tagFamilyRegistry.js';
import { createEmptyTagFamilyState } from '../../data/drawing/tags/tagFamilyStore.js';

export const PDF_DRAWING_TAG_MODES = Object.freeze({
  HIDDEN: 'hidden',
  MARK: 'mark',
  DETAIL: 'detail',
});

const PDF_DRAWING_MEMBER_TYPES = Object.freeze([
  'Column',
  'Post',
  'Girder',
  'Beam',
  'Brace',
  'Slab',
  'Wall',
]);

const PDF_DRAWING_MEMBER_TYPE_SET = new Set(PDF_DRAWING_MEMBER_TYPES);

export function canonicalPdfDrawingTagCategory(elementType) {
  return tagFamilyCategoryForElementType(elementType);
}

export function supportsPdfDrawingDetailTag(elementType) {
  return Object.hasOwn(DRAWING_DETAIL_TAG_TEMPLATE_BY_ELEMENT_TYPE, elementType);
}

function appendOption(select, value, text) {
  const option = select.ownerDocument.createElement('option');
  option.value = value;
  option.textContent = text;
  select.appendChild(option);
  return option;
}

export function createPdfDrawingTagCell(setting) {
  const td = document.createElement('td');
  td.className = 'pdf-drawing-tag-cell';
  if (!PDF_DRAWING_MEMBER_TYPE_SET.has(setting.type)) {
    td.textContent = '-';
    return td;
  }

  const select = document.createElement('select');
  select.id = `pdfDrawingTagMode-${setting.type}`;
  select.name = 'pdfDrawingTagMode';
  select.dataset.elementType = setting.type;
  select.className = 'form-control pdf-drawing-tag-mode';
  select.title = `${setting.jpName}の簡易CADタグを切替`;
  appendOption(select, PDF_DRAWING_TAG_MODES.HIDDEN, '非表示');
  appendOption(select, PDF_DRAWING_TAG_MODES.MARK, '符号');
  if (supportsPdfDrawingDetailTag(setting.type)) {
    appendOption(select, PDF_DRAWING_TAG_MODES.DETAIL, '詳細');
    select.dataset.supportsDetail = 'true';
  }
  select.value = PDF_DRAWING_TAG_MODES.MARK;
  td.appendChild(select);
  return td;
}

function removeFamilyOptionGroups(select) {
  for (const group of [...select.querySelectorAll('optgroup[data-tag-family-options="true"]')])
    group.remove();
}

/**
 * custom/built-in TagFamilyを既存「非表示/符号/詳細」に追加する。
 * 現在選択が消滅したfamilyなら黙って別familyへ置換せず「符号」へ戻す。
 */
export function refreshPdfDrawingTagFamilyOptions(
  stateInput = createEmptyTagFamilyState(),
  root = globalThis.document,
) {
  if (typeof root?.querySelectorAll !== 'function') return;
  root
    .querySelectorAll('.element-settings-table select[name="pdfDrawingTagMode"]')
    .forEach((select) => {
      const elementType = select.dataset.elementType;
      const category = canonicalPdfDrawingTagCategory(elementType);
      const previous = select.value;
      removeFamilyOptionGroups(select);
      const families = listTagFamiliesForCategory(category, stateInput);
      if (families.length) {
        const group = select.ownerDocument.createElement('optgroup');
        group.label = 'タグタイプ';
        group.dataset.tagFamilyOptions = 'true';
        for (const family of families) {
          const option = select.ownerDocument.createElement('option');
          option.value = familySelectionValue(family.id);
          option.textContent = family.builtIn ? `${family.name}（標準）` : family.name;
          option.dataset.tagFamilyId = family.id;
          option.dataset.builtIn = String(family.builtIn === true);
          group.appendChild(option);
        }
        select.appendChild(group);
      }
      const persistedFamilyId = stateInput?.selections?.[category] ?? null;
      const persistedValue = persistedFamilyId ? familySelectionValue(persistedFamilyId) : null;
      const persistedExists =
        persistedValue && [...select.options].some((option) => option.value === persistedValue);
      const stillExists = [...select.options].some((option) => option.value === previous);
      select.value = persistedExists
        ? persistedValue
        : stillExists
          ? previous
          : PDF_DRAWING_TAG_MODES.MARK;
    });
}

export function ensurePdfDrawingTagHeader(tbody) {
  const headerRow = tbody?.closest('table')?.querySelector('thead tr');
  if (!headerRow || headerRow.querySelector('[data-element-settings-column="pdf-drawing-tag"]'))
    return;

  const th = document.createElement('th');
  th.scope = 'col';
  th.dataset.elementSettingsColumn = 'pdf-drawing-tag';
  th.title = '簡易CADで表示する部材タグ形式';

  const label = document.createElement('span');
  label.textContent = '図面タグ ';
  th.appendChild(label);

  const select = document.createElement('select');
  select.id = 'masterPdfDrawingTagMode';
  select.className = 'form-control pdf-drawing-tag-master';
  select.title = '全ての簡易CADタグを一括切替';
  select.setAttribute('aria-label', '全ての簡易CADタグを一括切替');
  appendOption(select, '', '一括');
  appendOption(select, PDF_DRAWING_TAG_MODES.MARK, '符号');
  appendOption(select, PDF_DRAWING_TAG_MODES.DETAIL, '詳細');
  appendOption(select, PDF_DRAWING_TAG_MODES.HIDDEN, '非表示');
  th.appendChild(select);

  const colorHeader = headerRow.lastElementChild;
  if (colorHeader) headerRow.insertBefore(th, colorHeader);
  else headerRow.appendChild(th);
}

export function setupPdfDrawingTagControls() {
  const master = document.getElementById('masterPdfDrawingTagMode');
  if (!master || master.dataset.bound === 'true') return;
  master.dataset.bound = 'true';
  master.addEventListener('change', () => {
    const requested = master.value;
    if (!requested) return;
    const selects = document.querySelectorAll(
      '.element-settings-table select[name="pdfDrawingTagMode"]',
    );
    selects.forEach((select) => {
      select.value =
        requested === PDF_DRAWING_TAG_MODES.DETAIL && select.dataset.supportsDetail !== 'true'
          ? PDF_DRAWING_TAG_MODES.MARK
          : requested;
    });
    // 値変更は一括で行い、簡易CADの再描画はmaster自身のchange 1回に集約する。
    master.value = '';
  });
}

export function readPdfDrawingDisplaySettings(root = globalThis.document) {
  const visibility = {};
  const tagModes = {};
  const colors = {};
  if (typeof root?.querySelectorAll !== 'function') {
    return Object.freeze({
      visibility: Object.freeze(visibility),
      tagModes: Object.freeze(tagModes),
      colors: Object.freeze(colors),
    });
  }

  root.querySelectorAll('.element-settings-table input[name="elements"]').forEach((input) => {
    visibility[input.value] = Boolean(input.checked);
  });
  root
    .querySelectorAll('.element-settings-table select[name="pdfDrawingTagMode"]')
    .forEach((select) => {
      // tagModesは後方互換名。値は legacy mode または family:<TagFamily id>。
      tagModes[select.dataset.elementType] = select.value;
    });
  root
    .querySelectorAll('.element-settings-table input.element-color-input[data-element-type]')
    .forEach((input) => {
      const color = String(input.value || '').trim();
      if (/^#[0-9a-fA-F]{6}$/.test(color)) {
        colors[input.dataset.elementType] = color;
      }
    });

  return Object.freeze({
    visibility: Object.freeze(visibility),
    tagModes: Object.freeze(tagModes),
    colors: Object.freeze(colors),
  });
}

export function isPdfDrawingDisplaySettingControl(target) {
  if (typeof target?.matches !== 'function') return false;
  return target.matches(
    [
      '.element-settings-table input[name="elements"]',
      '.element-settings-table select[name="pdfDrawingTagMode"]',
      '.element-settings-table input.element-color-input[data-element-type]',
      '#masterPdfDrawingTagMode',
    ].join(','),
  );
}

export function shouldRedrawPdfDrawingForDisplaySettingEvent(event) {
  if (event?.type === 'change') {
    return isPdfDrawingDisplaySettingControl(event.target);
  }
  return (
    event?.type === 'click' &&
    typeof event.target?.matches === 'function' &&
    event.target.matches('#resetElementColors')
  );
}
