/** @fileoverview 簡易CADワークスペースのTagFamily管理UI。 */
import {
  BUILTIN_TAG_FAMILIES,
  listTagFamiliesForCategory,
} from '../../../data/drawing/tags/tagFamilyRegistry.js';
import { TAG_FAMILY_CATEGORIES } from '../../../data/drawing/tags/tagFamilyDefinition.js';
import {
  createDefaultCustomTagFamily,
  duplicateTagFamilyForUser,
  updateCustomTagFamilyMeta,
} from '../../../data/drawing/tags/tagFamilyEditorModel.js';
import {
  exportTagFamilyStateJson,
  importTagFamilyStateJson,
  removeCustomTagFamily,
  selectTagFamily,
  upsertCustomTagFamily,
} from '../../../data/drawing/tags/tagFamilyStore.js';
import { downloadBlob } from '../../../utils/downloadHelper.js';
import { TagFamilyEditorController } from './TagFamilyEditorController.js';

function readFileAsText(file) {
  if (typeof file?.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('TagFamily JSONを読み込めません。'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsText(file, 'UTF-8');
  });
}

function categoryLabel(category) {
  return (
    {
      Girder: '大梁',
      Beam: '小梁',
      Column: '柱',
      Post: '間柱',
      Brace: 'ブレース',
      Slab: 'スラブ',
      Wall: '壁',
    }[category] || category
  );
}

export class TagFamilyManagerController {
  constructor(sessionController) {
    this.session = sessionController;
    this.root = sessionController.root;
    this.editor = new TagFamilyEditorController(this);
    this.bound = false;
  }

  e(id) {
    return this.root.querySelector(`#${id}`);
  }

  bindEvents() {
    if (this.bound) return;
    const category = this.e('pdf-overlay-tag-family-category');
    const family = this.e('pdf-overlay-tag-family');
    if (!category || !family) return;
    this.bound = true;

    category.replaceChildren();
    for (const value of TAG_FAMILY_CATEGORIES) {
      const option = this.root.ownerDocument.createElement('option');
      option.value = value;
      option.textContent = categoryLabel(value);
      category.appendChild(option);
    }

    category.addEventListener('change', () => this.refresh());
    family.addEventListener('change', () => this.applySelectedFamily());
    this.e('pdf-overlay-tag-family-new')?.addEventListener('click', () => this.create());
    this.e('pdf-overlay-tag-family-duplicate')?.addEventListener('click', () => this.duplicate());
    this.e('pdf-overlay-tag-family-delete')?.addEventListener('click', () => this.remove());
    this.e('pdf-overlay-tag-family-save-meta')?.addEventListener('click', () => this.saveMeta());
    this.e('pdf-overlay-tag-family-export')?.addEventListener('click', () => this.exportJson());
    this.e('pdf-overlay-tag-family-import-trigger')?.addEventListener('click', () =>
      this.e('pdf-overlay-tag-family-import')?.click(),
    );
    this.e('pdf-overlay-tag-family-import')?.addEventListener('change', (event) =>
      this.importJson(event.target.files?.[0]).catch((error) => this.fail(error)),
    );
    this.e('pdf-overlay-tag-family-edit-layout')?.addEventListener('click', () => {
      const selected = this.selectedFamily();
      if (selected) this.editor.open(selected);
    });
    this.editor.bindEvents();
    this.refresh();
  }

  status(message) {
    const output = this.e('pdf-overlay-tag-family-status');
    if (output) output.textContent = message;
  }

  fail(error) {
    this.status(error?.message || 'TagFamily操作に失敗しました。');
  }

  state() {
    return this.session.tagFamilyState;
  }

  category() {
    return this.e('pdf-overlay-tag-family-category')?.value || 'Girder';
  }

  selectedFamily() {
    const id = this.e('pdf-overlay-tag-family')?.value;
    return listTagFamiliesForCategory(this.category(), this.state()).find(
      (family) => family.id === id,
    );
  }

  applyState(state, { render = true } = {}) {
    this.session.setTagFamilyState(state, { render });
    this.refresh();
  }

  refresh() {
    const select = this.e('pdf-overlay-tag-family');
    if (!select) return;
    const category = this.category();
    const previous = select.value;
    const state = this.state();
    const families = listTagFamiliesForCategory(category, state);
    select.replaceChildren();
    for (const family of families) {
      const option = this.root.ownerDocument.createElement('option');
      option.value = family.id;
      option.textContent = family.builtIn ? `${family.name}（標準）` : family.name;
      select.appendChild(option);
    }
    const selectedId = state.selections?.[category] || null;
    if (selectedId && families.some((family) => family.id === selectedId))
      select.value = selectedId;
    else if (families.some((family) => family.id === previous)) select.value = previous;
    this.refreshDetails();
  }

  /** 選択したタグタイプをそのカテゴリの図面タグ表示へ適用する(要素設定表のセレクトも同期)。 */
  applySelectedFamily() {
    try {
      const family = this.selectedFamily();
      if (!family) return this.refreshDetails();
      const state = selectTagFamily(this.state(), family.category, family.id, {
        builtIns: BUILTIN_TAG_FAMILIES,
      });
      this.applyState(state);
      this.e('pdf-overlay-tag-family').value = family.id;
      this.refreshDetails();
    } catch (error) {
      this.fail(error);
    }
  }

  refreshDetails() {
    const family = this.selectedFamily();
    const name = this.e('pdf-overlay-tag-family-name');
    const scale = this.e('pdf-overlay-tag-family-scale');
    const duplicate = this.e('pdf-overlay-tag-family-duplicate');
    const remove = this.e('pdf-overlay-tag-family-delete');
    const save = this.e('pdf-overlay-tag-family-save-meta');
    const editLayout = this.e('pdf-overlay-tag-family-edit-layout');

    if (!family) {
      if (name) name.value = '';
      if (scale) scale.value = '100';
      if (duplicate) duplicate.disabled = true;
      if (remove) remove.disabled = true;
      if (save) save.disabled = true;
      if (editLayout) editLayout.disabled = true;
      this.status('このカテゴリのタグタイプはありません。');
      return;
    }

    if (name) {
      name.value = family.name;
      name.disabled = family.builtIn;
    }
    if (scale) {
      scale.value = String(Math.round(family.paperScale * 100));
      scale.disabled = family.builtIn;
    }
    if (duplicate) duplicate.disabled = false;
    if (remove) remove.disabled = family.builtIn;
    if (save) save.disabled = family.builtIn;
    if (editLayout) editLayout.disabled = family.builtIn;
    this.status(
      `${categoryLabel(family.category)} / ${family.builtIn ? '標準・読取専用' : 'ユーザー定義'} / v${family.version} / ${family.primitives.length}要素`,
    );
  }

  create() {
    try {
      const category = this.category();
      let state = this.state();
      const family = createDefaultCustomTagFamily(state, category, {
        builtIns: BUILTIN_TAG_FAMILIES,
      });
      state = upsertCustomTagFamily(state, family, { builtIns: BUILTIN_TAG_FAMILIES });
      state = selectTagFamily(state, category, family.id, { builtIns: BUILTIN_TAG_FAMILIES });
      this.applyState(state);
      this.e('pdf-overlay-tag-family').value = family.id;
      this.refreshDetails();
      this.status(`${family.name} を作成しました。`);
    } catch (error) {
      this.fail(error);
    }
  }

  duplicate() {
    try {
      const source = this.selectedFamily();
      if (!source) throw new TypeError('複製元のタグタイプを選択してください。');
      let state = this.state();
      const family = duplicateTagFamilyForUser(state, source, {
        builtIns: BUILTIN_TAG_FAMILIES,
      });
      state = upsertCustomTagFamily(state, family, { builtIns: BUILTIN_TAG_FAMILIES });
      state = selectTagFamily(state, family.category, family.id, {
        builtIns: BUILTIN_TAG_FAMILIES,
      });
      this.applyState(state);
      this.e('pdf-overlay-tag-family').value = family.id;
      this.refreshDetails();
      this.status(`${source.name} を ${family.name} として複製しました。`);
    } catch (error) {
      this.fail(error);
    }
  }

  remove() {
    try {
      const family = this.selectedFamily();
      if (!family || family.builtIn)
        throw new TypeError('削除できるユーザー定義を選択してください。');
      const state = removeCustomTagFamily(this.state(), family.id, {
        builtIns: BUILTIN_TAG_FAMILIES,
      });
      this.applyState(state);
      this.status(`${family.name} を削除しました。`);
    } catch (error) {
      this.fail(error);
    }
  }

  saveMeta() {
    try {
      const family = this.selectedFamily();
      if (!family || family.builtIn)
        throw new TypeError('編集できるユーザー定義を選択してください。');
      const name = this.e('pdf-overlay-tag-family-name')?.value?.trim();
      const scalePercent = Number(this.e('pdf-overlay-tag-family-scale')?.value);
      if (!Number.isFinite(scalePercent) || scalePercent < 50 || scalePercent > 200)
        throw new RangeError('タグ倍率は50〜200%で指定してください。');
      const result = updateCustomTagFamilyMeta(
        this.state(),
        family.id,
        { name, paperScale: scalePercent / 100 },
        { builtIns: BUILTIN_TAG_FAMILIES },
      );
      this.applyState(result.state);
      this.e('pdf-overlay-tag-family').value = result.family.id;
      this.refreshDetails();
      this.status(`${result.family.name} を v${result.family.version} として保存しました。`);
    } catch (error) {
      this.fail(error);
    }
  }

  exportJson() {
    try {
      const json = exportTagFamilyStateJson(this.state(), { builtIns: BUILTIN_TAG_FAMILIES });
      downloadBlob(
        new Blob([json], { type: 'application/json;charset=utf-8' }),
        'stb-tag-families.json',
      );
      this.status('TagFamily JSONを書き出しました。');
    } catch (error) {
      this.fail(error);
    }
  }

  async importJson(file) {
    if (!file) return;
    try {
      const state = importTagFamilyStateJson(await readFileAsText(file), {
        builtIns: BUILTIN_TAG_FAMILIES,
      });
      this.applyState(state);
      this.status(`${state.families.length}件のユーザー定義を読み込みました。`);
    } finally {
      const input = this.e('pdf-overlay-tag-family-import');
      if (input) input.value = '';
    }
  }
}
