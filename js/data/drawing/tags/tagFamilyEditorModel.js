/** @fileoverview TagFamily管理UI用の純粋編集helper。DOM/保存先を所有しない。 */
import { TAG_FAMILY_SCHEMA_VERSION, normalizeTagFamily } from './tagFamilyDefinition.js';
import {
  duplicateTagFamily,
  normalizeTagFamilyState,
  upsertCustomTagFamily,
} from './tagFamilyStore.js';
import { parseTagXPath } from './tagXPath.js';
import { STB_TAG_XPATHS } from './tagXPathCatalog.js';

function familyRaw(family) {
  const copy = JSON.parse(JSON.stringify(family));
  delete copy.builtIn;
  return copy;
}

function slugCategory(category) {
  return String(category)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
}

export function nextCustomTagFamilyId(stateInput, category, { builtIns = [] } = {}) {
  const state = normalizeTagFamilyState(stateInput, { builtIns });
  const prefix = `user:${slugCategory(category)}:tag-`;
  const ids = new Set([...builtIns, ...state.families].map((family) => family.id));
  for (let index = 1; index < 100000; index++) {
    const id = `${prefix}${index}`;
    if (!ids.has(id)) return id;
  }
  throw new RangeError('TagFamily idを採番できません。');
}

export function createDefaultCustomTagFamily(stateInput, category, { builtIns = [] } = {}) {
  const id = nextCustomTagFamilyId(stateInput, category, { builtIns });
  const sequence = Number(id.split('-').pop());
  return normalizeTagFamily({
    schemaVersion: TAG_FAMILY_SCHEMA_VERSION,
    id,
    name: `新規タグ ${sequence}`,
    category,
    version: 1,
    paperScale: 1,
    orientationMode: 'model',
    parameters: [{ id: 'mark', key: STB_TAG_XPATHS.sectionName(category), format: 'text' }],
    primitives: [
      {
        id: 'mark',
        kind: 'parameter-text',
        x: 0,
        y: 0,
        parameterId: 'mark',
        align: 'center',
      },
    ],
    style: {
      fontFamily: '"Meiryo UI", "MS Gothic", sans-serif',
      fontSize: 1.5,
      align: 'center',
      padding: 0,
      strokeWidth: 0.35,
      haloWidth: 0.55,
    },
  });
}

export function duplicateTagFamilyForUser(
  stateInput,
  sourceFamily,
  { builtIns = [], name = null } = {},
) {
  const id = nextCustomTagFamilyId(stateInput, sourceFamily.category, { builtIns });
  return duplicateTagFamily(sourceFamily, {
    id,
    name: name || `${sourceFamily.name} のコピー`,
  });
}

/**
 * familyメタ情報変更はversionを+1する。
 * 既存配置が古い定義へ黙って追従しないようtemplate identityを明示的に更新する。
 */
export function updateCustomTagFamilyMeta(
  stateInput,
  familyId,
  { name, paperScale },
  { builtIns = [] } = {},
) {
  const state = normalizeTagFamilyState(stateInput, { builtIns });
  const current = state.families.find((family) => family.id === familyId);
  if (!current) throw new TypeError(`編集可能なTagFamilyがありません: ${familyId}`);
  const next = normalizeTagFamily({
    ...familyRaw(current),
    name: name ?? current.name,
    paperScale: paperScale ?? current.paperScale,
    version: current.version + 1,
  });
  return Object.freeze({
    family: next,
    state: upsertCustomTagFamily(state, next, { builtIns }),
  });
}

function nextLocalId(values, prefix) {
  const ids = new Set(values.map((value) => value.id));
  for (let index = 1; index < 100000; index++) {
    const id = `${prefix}-${index}`;
    if (!ids.has(id)) return id;
  }
  throw new RangeError(`${prefix} idを採番できません。`);
}

function firstParameterId(raw, figure) {
  return (
    raw.parameters.find((parameter) => (parameter.format === 'section-figure') === figure)?.id ??
    null
  );
}

/** STB XPathをparameterとして追加し、表示用primitive(文字または断面図)を1つ置く。 */
export function addTagFamilyParameter(familyInput, keyInput) {
  const family = normalizeTagFamily(familyInput, { builtIn: familyInput?.builtIn === true });
  if (family.builtIn) throw new TypeError('標準TagFamilyは直接編集できません。');
  const xpath = parseTagXPath(keyInput);
  const key = xpath.expression;
  if (family.parameters.some((parameter) => parameter.key === key))
    throw new TypeError(`すでに追加済みのparameterです: ${key}`);
  const figure = xpath.resultKind === 'element';
  const raw = familyRaw(family);
  const parameterId = nextLocalId(raw.parameters, 'parameter');
  raw.parameters.push({ id: parameterId, key, format: figure ? 'section-figure' : 'text' });
  const primitiveId = nextLocalId(raw.primitives, figure ? 'figure' : 'value');
  raw.primitives.push(
    figure
      ? { id: primitiveId, kind: 'section-figure', x: 0, y: 0, parameterId }
      : {
          id: primitiveId,
          kind: 'parameter-text',
          x: 0,
          y: raw.parameters.length * 4 - 4,
          parameterId,
          align: 'center',
        },
  );
  return normalizeTagFamily(raw);
}

export function updateTagFamilyParameter(familyInput, parameterId, patch) {
  const family = normalizeTagFamily(familyInput, { builtIn: familyInput?.builtIn === true });
  if (family.builtIn) throw new TypeError('標準TagFamilyは直接編集できません。');
  const raw = familyRaw(family);
  const index = raw.parameters.findIndex((parameter) => parameter.id === parameterId);
  if (index < 0) throw new TypeError(`parameterがありません: ${parameterId}`);
  raw.parameters[index] = { ...raw.parameters[index], ...patch, id: parameterId };
  return normalizeTagFamily(raw);
}

export function removeTagFamilyParameter(familyInput, parameterId) {
  const family = normalizeTagFamily(familyInput, { builtIn: familyInput?.builtIn === true });
  if (family.builtIn) throw new TypeError('標準TagFamilyは直接編集できません。');
  const raw = familyRaw(family);
  const before = raw.parameters.length;
  raw.parameters = raw.parameters.filter((parameter) => parameter.id !== parameterId);
  if (raw.parameters.length === before)
    throw new TypeError(`parameterがありません: ${parameterId}`);
  raw.primitives = raw.primitives.filter((primitive) => primitive.parameterId !== parameterId);
  return normalizeTagFamily(raw);
}

export function addTagFamilyPrimitive(familyInput, kind) {
  const family = normalizeTagFamily(familyInput, { builtIn: familyInput?.builtIn === true });
  if (family.builtIn) throw new TypeError('標準TagFamilyは直接編集できません。');
  const raw = familyRaw(family);
  const id = nextLocalId(raw.primitives, kind.replace(/[^a-z0-9]+/gi, '-').toLowerCase());
  const firstParameter = firstParameterId(raw, false);
  let primitive;
  switch (kind) {
    case 'text':
      primitive = { id, kind, x: 0, y: 0, text: 'TEXT', align: 'center' };
      break;
    case 'parameter-text':
      if (!firstParameter) throw new TypeError('parameter-textにはparameterが必要です。');
      primitive = { id, kind, x: 0, y: 0, parameterId: firstParameter, align: 'center' };
      break;
    case 'line':
    case 'separator':
      primitive = { id, kind, x1: -5, y1: 0, x2: 5, y2: 0 };
      break;
    case 'rectangle':
      primitive = { id, kind, x: -10, y: -5, width: 20, height: 10 };
      break;
    case 'rounded-rectangle':
      primitive = { id, kind, x: -10, y: -5, width: 20, height: 10, radius: 2 };
      break;
    case 'circle':
      primitive = { id, kind, x: 0, y: 0, radius: 4 };
      break;
    case 'circled-value':
      if (!firstParameter) throw new TypeError('circled-valueにはparameterが必要です。');
      primitive = {
        id,
        kind,
        x: 0,
        y: 0,
        radius: 4,
        parameterId: firstParameter,
        align: 'center',
      };
      break;
    case 'leader-anchor':
      primitive = { id, kind, x: 0, y: 6 };
      break;
    case 'section-figure': {
      const figureParameter = firstParameterId(raw, true);
      if (!figureParameter)
        throw new TypeError('断面図には断面要素XPath(例: StbSecColumn_RC)のparameterが必要です。');
      primitive = { id, kind, x: 0, y: 0, parameterId: figureParameter };
      break;
    }
    default:
      throw new TypeError(`未対応のprimitiveです: ${kind}`);
  }
  raw.primitives.push(primitive);
  return normalizeTagFamily(raw);
}

export function updateTagFamilyPrimitive(familyInput, primitiveId, patch) {
  const family = normalizeTagFamily(familyInput, { builtIn: familyInput?.builtIn === true });
  if (family.builtIn) throw new TypeError('標準TagFamilyは直接編集できません。');
  const raw = familyRaw(family);
  const index = raw.primitives.findIndex((primitive) => primitive.id === primitiveId);
  if (index < 0) throw new TypeError(`primitiveがありません: ${primitiveId}`);
  raw.primitives[index] = { ...raw.primitives[index], ...patch, id: primitiveId };
  return normalizeTagFamily(raw);
}

export function removeTagFamilyPrimitive(familyInput, primitiveId) {
  const family = normalizeTagFamily(familyInput, { builtIn: familyInput?.builtIn === true });
  if (family.builtIn) throw new TypeError('標準TagFamilyは直接編集できません。');
  const raw = familyRaw(family);
  const before = raw.primitives.length;
  raw.primitives = raw.primitives.filter((primitive) => primitive.id !== primitiveId);
  if (raw.primitives.length === before)
    throw new TypeError(`primitiveがありません: ${primitiveId}`);
  return normalizeTagFamily(raw);
}

export function commitTagFamilyDraft(stateInput, familyInput, { builtIns = [] } = {}) {
  const state = normalizeTagFamilyState(stateInput, { builtIns });
  const family = normalizeTagFamily(familyInput);
  const current = state.families.find((candidate) => candidate.id === family.id);
  if (!current) throw new TypeError(`保存対象のTagFamilyがありません: ${family.id}`);
  const committed = normalizeTagFamily({
    ...familyRaw(family),
    version: current.version + 1,
  });
  return Object.freeze({
    family: committed,
    state: upsertCustomTagFamily(state, committed, { builtIns }),
  });
}
