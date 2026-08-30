/**
 * @fileoverview 新規部材追加フォームの汎用入力コントロール生成・操作ヘルパー
 */

/** セレクトに単純な文字列候補を設定する。 */
export function populateSelectOptions(select, options, emptyLabel) {
  select.innerHTML = '';
  if (options.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = emptyLabel;
    select.appendChild(opt);
  }
  for (const value of options) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    select.appendChild(opt);
  }
}

/**
 * 断面候補をタグ名込みで設定する。
 * 異なる StbSec* 要素で同じ id が存在できるため、option.dataset.sectionTag を識別子として保持する。
 */
export function populateSectionOptions(select, sections, emptyLabel = '（断面なし）') {
  select.innerHTML = '';
  if (sections.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = emptyLabel;
    select.appendChild(opt);
    return;
  }

  for (const section of sections) {
    const opt = document.createElement('option');
    opt.value = section.id;
    opt.dataset.sectionTag = section.tag;
    if (section.structure) opt.dataset.structure = section.structure;
    const name = section.name ? `${section.name} / ` : '';
    opt.textContent = `${name}${section.tag} #${section.id}`;
    select.appendChild(opt);
  }
}

/** id+tag が一致する断面 option を選択する。 */
export function selectSectionOption(select, id, tagName) {
  const option = [...select.options].find(
    (opt) => opt.value === String(id) && (!tagName || opt.dataset.sectionTag === tagName),
  );
  if (!option) return false;
  option.selected = true;
  return true;
}

export function makeListButton(text, title, disabled, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'add-member-nodelist-btn';
  btn.textContent = text;
  btn.title = title;
  btn.disabled = disabled;
  btn.addEventListener('click', onClick);
  return btn;
}

export function makePickButton(label, title, onClick, extraClass) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = extraClass ? `add-member-pick-btn ${extraClass}` : 'add-member-pick-btn';
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener('click', () => onClick(btn));
  return btn;
}

export function ensureOption(select, value) {
  if (value == null || value === '') return;
  if ([...select.options].some((o) => o.value === String(value))) return;
  const opt = document.createElement('option');
  opt.value = String(value);
  opt.textContent = String(value);
  select.appendChild(opt);
}

export function setFieldValue(fieldsContainer, attr, value) {
  const el = fieldsContainer.querySelector(`[data-attr="${attr}"]`);
  if (el != null && value != null) el.value = value;
}

export function clearPickingButtons(fieldsContainer) {
  for (const btn of fieldsContainer.querySelectorAll('.add-member-pick-btn.picking')) {
    btn.classList.remove('picking');
  }
}
