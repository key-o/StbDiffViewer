/** @fileoverview custom TagFamilyとカテゴリ別選択のJSON保存契約。DOM/localStorageを所有しない。 */
import {
  TAG_FAMILY_CATEGORIES,
  TAG_FAMILY_SCHEMA_VERSION,
  normalizeTagFamily,
} from './tagFamilyDefinition.js';

export const TAG_FAMILY_STATE_SCHEMA_VERSION = 1;

function assertKnownStateKeys(input) {
  for (const key of Object.keys(input)) {
    if (!['schemaVersion', 'families', 'selections'].includes(key))
      throw new TypeError(`TagFamily stateに未対応のfieldがあります: ${key}`);
  }
}

function normalizeBuiltIns(input) {
  if (!Array.isArray(input)) throw new TypeError('builtInsは配列で指定してください。');
  return input.map((family) => normalizeTagFamily(family, { builtIn: true }));
}

function familyIndex(families) {
  const byId = new Map();
  for (const family of families) {
    if (byId.has(family.id)) throw new TypeError(`TagFamily idが重複しています: ${family.id}`);
    byId.set(family.id, family);
  }
  return byId;
}

function normalizedSelections(input, byId) {
  if (input === undefined || input === null) input = {};
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('TagFamily selectionsが不正です。');
  for (const key of Object.keys(input)) {
    if (!TAG_FAMILY_CATEGORIES.includes(key))
      throw new TypeError(`未対応カテゴリの選択があります: ${key}`);
  }
  const selections = {};
  for (const category of TAG_FAMILY_CATEGORIES) {
    const id = input[category] ?? null;
    if (id !== null && (typeof id !== 'string' || !id.trim()))
      throw new TypeError(`${category}のTagFamily選択が不正です。`);
    if (id !== null) {
      const family = byId.get(id);
      if (!family) throw new TypeError(`選択されたTagFamilyがありません: ${id}`);
      if (family.category !== category)
        throw new TypeError(`TagFamily ${id} はカテゴリ${category}では使用できません。`);
    }
    selections[category] = id;
  }
  return Object.freeze(selections);
}

/** custom familyと選択を正規化し、built-inとのID衝突/カテゴリ不整合を拒否する。 */
export function normalizeTagFamilyState(input, { builtIns = [] } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('TagFamily stateが必要です。');
  assertKnownStateKeys(input);
  if (input.schemaVersion !== TAG_FAMILY_STATE_SCHEMA_VERSION)
    throw new TypeError(`TagFamily state v${TAG_FAMILY_STATE_SCHEMA_VERSION}が必要です。`);
  if (!Array.isArray(input.families)) throw new TypeError('TagFamily families配列が必要です。');

  const normalizedBuiltIns = normalizeBuiltIns(builtIns);
  const customFamilies = input.families.map((family) => normalizeTagFamily(family));
  const all = [...normalizedBuiltIns, ...customFamilies];
  const byId = familyIndex(all);
  const selections = normalizedSelections(input.selections, byId);
  return Object.freeze({
    schemaVersion: TAG_FAMILY_STATE_SCHEMA_VERSION,
    families: Object.freeze(customFamilies),
    selections,
  });
}

export function createEmptyTagFamilyState() {
  return Object.freeze({
    schemaVersion: TAG_FAMILY_STATE_SCHEMA_VERSION,
    families: Object.freeze([]),
    selections: Object.freeze(
      Object.fromEntries(TAG_FAMILY_CATEGORIES.map((category) => [category, null])),
    ),
  });
}

function rawFamily(family, overrides = {}) {
  const copy = JSON.parse(JSON.stringify(family));
  delete copy.builtIn;
  return {
    ...copy,
    schemaVersion: TAG_FAMILY_SCHEMA_VERSION,
    ...overrides,
  };
}

/** built-in/custom familyを編集可能なuser familyへ複製する。 */
export function duplicateTagFamily(source, { id, name } = {}) {
  const normalized = normalizeTagFamily(source, { builtIn: source?.builtIn === true });
  return normalizeTagFamily(
    rawFamily(normalized, {
      id,
      name,
      version: 1,
    }),
  );
}

export function upsertCustomTagFamily(stateInput, familyInput, { builtIns = [] } = {}) {
  const state = normalizeTagFamilyState(stateInput, { builtIns });
  const family = normalizeTagFamily(familyInput);
  const next = state.families.filter((candidate) => candidate.id !== family.id);
  next.push(family);
  next.sort((a, b) =>
    a.category === b.category ? a.id.localeCompare(b.id) : a.category.localeCompare(b.category),
  );
  return normalizeTagFamilyState(
    {
      schemaVersion: TAG_FAMILY_STATE_SCHEMA_VERSION,
      families: next,
      selections: state.selections,
    },
    { builtIns },
  );
}

export function removeCustomTagFamily(stateInput, familyId, { builtIns = [] } = {}) {
  const state = normalizeTagFamilyState(stateInput, { builtIns });
  if (typeof familyId !== 'string' || !familyId.startsWith('user:'))
    throw new TypeError('削除できるのはuser TagFamilyのみです。');
  const next = state.families.filter((family) => family.id !== familyId);
  if (next.length === state.families.length)
    throw new TypeError(`TagFamilyがありません: ${familyId}`);
  const selections = { ...state.selections };
  for (const category of TAG_FAMILY_CATEGORIES) {
    if (selections[category] === familyId) selections[category] = null;
  }
  return normalizeTagFamilyState(
    {
      schemaVersion: TAG_FAMILY_STATE_SCHEMA_VERSION,
      families: next,
      selections,
    },
    { builtIns },
  );
}

export function selectTagFamily(stateInput, category, familyId, { builtIns = [] } = {}) {
  const state = normalizeTagFamilyState(stateInput, { builtIns });
  if (!TAG_FAMILY_CATEGORIES.includes(category))
    throw new TypeError(`未対応のTagFamilyカテゴリです: ${String(category)}`);
  const selections = { ...state.selections, [category]: familyId };
  return normalizeTagFamilyState(
    {
      schemaVersion: TAG_FAMILY_STATE_SCHEMA_VERSION,
      families: state.families,
      selections,
    },
    { builtIns },
  );
}

/** key順に依存しない決定的JSON。 */
export function exportTagFamilyStateJson(stateInput, { builtIns = [] } = {}) {
  const state = normalizeTagFamilyState(stateInput, { builtIns });
  const families = [...state.families]
    .sort((a, b) =>
      a.category === b.category ? a.id.localeCompare(b.id) : a.category.localeCompare(b.category),
    )
    .map((family) => rawFamily(family));
  const selections = Object.fromEntries(
    TAG_FAMILY_CATEGORIES.map((category) => [category, state.selections[category]]),
  );
  return JSON.stringify(
    {
      schemaVersion: TAG_FAMILY_STATE_SCHEMA_VERSION,
      families,
      selections,
    },
    null,
    2,
  );
}

export function importTagFamilyStateJson(text, { builtIns = [] } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('TagFamily JSONが必要です。');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new TypeError(`TagFamily JSONを解析できません: ${error.message}`);
  }
  return normalizeTagFamilyState(parsed, { builtIns });
}
