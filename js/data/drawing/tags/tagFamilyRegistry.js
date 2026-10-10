/** @fileoverview 図面符号タグとcustom/built-in TagFamilyを統合する選択・描画plan境界。 */
import { DRAWING_DETAIL_TAG_TEMPLATE_BY_ELEMENT_TYPE } from '../../../config/drawingTagTemplates.js';
import { BUILTIN_TAG_FAMILY_SOURCES } from './builtinTagFamilies.js';
import { createDrawingTagFacts, normalizeTagFacts } from './drawingTagFacts.js';
import { buildTagFamilyRenderPlan } from './tagFamilyRenderPlan.js';
import { normalizeTagFamily, tagFamilyCategoryForElementType } from './tagFamilyDefinition.js';
import { normalizeTagFamilyState } from './tagFamilyStore.js';
import { buildTagRenderPlan } from './tagRenderPlan.js';

export const TAG_SELECTION_FAMILY_PREFIX = 'family:';

export const BUILTIN_TAG_FAMILIES = Object.freeze(
  BUILTIN_TAG_FAMILY_SOURCES.map((source) => normalizeTagFamily(source.family, { builtIn: true })),
);

// built-in詳細タグの保存済み配置は旧テンプレートID(beam-detail-v1等)で照合する。
const BUILTIN_TEMPLATE_ID_BY_FAMILY_ID = new Map(
  BUILTIN_TAG_FAMILY_SOURCES.map((source) => [source.family.id, source.templateId]),
);

function builtInDetailFamily(category) {
  const templateId = DRAWING_DETAIL_TAG_TEMPLATE_BY_ELEMENT_TYPE[category];
  if (!templateId) return null;
  return (
    BUILTIN_TAG_FAMILIES.find(
      (family) =>
        family.category === category &&
        BUILTIN_TEMPLATE_ID_BY_FAMILY_ID.get(family.id) === templateId,
    ) || null
  );
}

export function familySelectionValue(familyId) {
  if (typeof familyId !== 'string' || !familyId.trim())
    throw new TypeError('TagFamily idが必要です。');
  return `${TAG_SELECTION_FAMILY_PREFIX}${familyId}`;
}

export function familyIdFromSelection(value) {
  if (typeof value !== 'string' || !value.startsWith(TAG_SELECTION_FAMILY_PREFIX)) return null;
  const id = value.slice(TAG_SELECTION_FAMILY_PREFIX.length);
  return id.trim() ? id : null;
}

export function listTagFamiliesForCategory(category, stateInput) {
  const state = normalizeTagFamilyState(stateInput, { builtIns: BUILTIN_TAG_FAMILIES });
  return Object.freeze([
    ...BUILTIN_TAG_FAMILIES.filter((family) => family.category === category),
    ...state.families.filter((family) => family.category === category),
  ]);
}

export function resolveTagFamily(stateInput, familyId) {
  const state = normalizeTagFamilyState(stateInput, { builtIns: BUILTIN_TAG_FAMILIES });
  const family = [...BUILTIN_TAG_FAMILIES, ...state.families].find(
    (candidate) => candidate.id === familyId,
  );
  if (!family) throw new TypeError(`TagFamilyがありません: ${familyId}`);
  return family;
}

/** familyが参照するSTB XPathキー(重複除去・定義順)。 */
export function tagFamilyStbKeys(familyInput) {
  const family = normalizeTagFamily(familyInput, { builtIn: familyInput?.builtIn === true });
  return Object.freeze([...new Set(family.parameters.map((parameter) => parameter.key))]);
}

/**
 * TagFamilyのSTB XPath値を resolveTagFacts(ref, keys) で解決して描画計画を作る。
 * built-in familyは保存済み配置との互換のため旧テンプレートIDをidentityにする。
 */
function familyPlan(record, source, family, resolveTagFacts) {
  const keys = tagFamilyStbKeys(family);
  if (typeof resolveTagFacts !== 'function')
    throw new Error('このTagFamilyにはSTBタグfacts resolverが必要です。');
  const facts = normalizeTagFacts(resolveTagFacts(record.ref, keys));
  if (facts.elementKey !== record.key)
    throw new TypeError('STBタグfactsの部材がDrawing recordと一致しません。');
  if (source?.modelRevision != null && facts.source.modelRevision !== source.modelRevision)
    throw new TypeError('STBタグfactsのモデル改訂がDrawingと一致しません。');
  const templateId = family.builtIn ? BUILTIN_TEMPLATE_ID_BY_FAMILY_ID.get(family.id) : null;
  return buildTagFamilyRenderPlan({
    facts,
    family,
    ...(templateId ? { template: { id: templateId, version: family.version } } : {}),
  });
}

/**
 * display selectionを図面符号/TagFamilyのTagRenderPlanへ解決する。
 * mark は図面符号、detail は要素種別のbuilt-in詳細タグ、family:<id> は指定TagFamily。
 */
export function buildSelectedDrawingTagPlan({
  record,
  source,
  selection = 'mark',
  tagFamilyState,
  resolveTagFacts = null,
} = {}) {
  if (!record?.ref?.elementType) throw new TypeError('Drawing recordが必要です。');
  const markPlan = () =>
    buildTagRenderPlan({
      facts: createDrawingTagFacts({ record, source }),
      templateId: 'member-mark-v1',
    });
  if (selection === 'mark') return markPlan();
  const category = tagFamilyCategoryForElementType(record.ref.elementType);
  if (selection === 'detail') {
    const family = builtInDetailFamily(category);
    // 既存一括「詳細」は未対応カテゴリを符号へ安全にfallbackする。
    return family ? familyPlan(record, source, family, resolveTagFacts) : markPlan();
  }

  const familyId = familyIdFromSelection(selection);
  if (!familyId) throw new TypeError(`未対応の図面タグ選択です: ${String(selection)}`);
  const family = resolveTagFamily(tagFamilyState, familyId);
  if (family.category !== category)
    throw new TypeError(`TagFamily ${family.id} は${record.ref.elementType}では使用できません。`);
  return familyPlan(record, source, family, resolveTagFacts);
}
