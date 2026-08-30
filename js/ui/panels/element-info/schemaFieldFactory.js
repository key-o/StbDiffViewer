/**
 * @fileoverview スキーマ駆動 入力フィールド生成
 *
 * sectionTemplateModel の TemplateAttr から、型・列挙・制約に応じた入力コントロール行を生成する。
 *
 * @module ui/panels/element-info/schemaFieldFactory
 */

/** DOM id の一意性を保つための連番 */
let fieldSeq = 0;

/**
 * 属性 1 件の入力行を生成する。
 * @param {import('../../../common-stb/import/section/sectionTemplateModel.js').TemplateAttr} attr
 * @param {Object} [options]
 * @param {number} [options.indexDefault] - enum 属性の既定値を enum[indexDefault] にする
 * @param {string|number|boolean|null} [options.initialValue] - コピー元などの初期値。既定値より優先する
 * @returns {{ row: HTMLElement, name: string, getValue: () => string }}
 */
export function createAttrFieldRow(attr, options = {}) {
  const row = document.createElement('div');
  row.className = 'add-member-row';

  const fieldId = `sec-field-${attr.name}-${(fieldSeq += 1)}`;

  const label = document.createElement('label');
  label.className = 'add-member-label';
  label.textContent = attr.required ? `${attr.name} *` : attr.name;
  label.htmlFor = fieldId;
  row.appendChild(label);

  const input = createInput(attr, options);
  input.id = fieldId;
  input.dataset.attr = attr.name;
  row.appendChild(input);

  return { row, name: attr.name, getValue: () => input.value };
}

function preferredValue(attr, options, fallback) {
  if (options.initialValue !== undefined && options.initialValue !== null) {
    return String(options.initialValue);
  }
  return fallback;
}

/** 属性の型・制約から入力コントロールを生成する。 */
function createInput(attr, options) {
  if (attr.enum && attr.enum.length > 0) {
    const select = document.createElement('select');
    select.className = 'parameter-dropdown';
    for (const value of attr.enum) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value;
      select.appendChild(opt);
    }
    const idxDefault =
      Number.isInteger(options.indexDefault) && attr.enum[options.indexDefault] !== undefined
        ? attr.enum[options.indexDefault]
        : null;
    const preferred = preferredValue(attr, options, idxDefault ?? attr.default ?? attr.enum[0]);
    if (attr.enum.includes(preferred)) select.value = preferred;
    return select;
  }

  if (attr.type === 'boolean') {
    const select = document.createElement('select');
    select.className = 'parameter-dropdown';
    for (const value of ['', 'true', 'false']) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value || '（未設定）';
      select.appendChild(opt);
    }
    const preferred = preferredValue(attr, options, attr.default != null ? String(attr.default) : '');
    if ([...select.options].some((option) => option.value === preferred)) select.value = preferred;
    return select;
  }

  if (attr.type === 'number' || attr.type === 'integer') {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'parameter-text-input parameter-number-input';
    const c = attr.constraints;
    if (c) {
      if (c.minInclusive != null) input.min = String(c.minInclusive);
      if (c.maxInclusive != null) input.max = String(c.maxInclusive);
      if (c.minExclusive != null) input.min = String(Number(c.minExclusive) + Number.EPSILON);
      if (c.maxExclusive != null) input.max = String(Number(c.maxExclusive) - Number.EPSILON);
    }
    if (attr.type === 'integer') input.step = '1';
    const preferred = preferredValue(attr, options, attr.default != null ? String(attr.default) : '');
    if (preferred !== '') input.value = preferred;
    return input;
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'parameter-text-input';
  const preferred = preferredValue(attr, options, attr.default != null ? String(attr.default) : '');
  if (preferred !== '') input.value = preferred;
  return input;
}
