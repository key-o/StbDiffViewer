/** @fileoverview 宣言的テンプレート+facts→描画計画。座標変換/DOM/保存は所有しない。 */
import { DRAWING_TAG_TEMPLATES } from '../../../config/drawingTagTemplates.js';
import { assertPoint } from '../affine2d.js';
import { elementRefKey } from '../drawingModel.js';
import { normalizeTagFacts } from './drawingTagFacts.js';
import { normalizeTagValue } from './tagValue.js';
import { formatTagValue, isKnownZeroTagValue } from './tagValueFormatter.js';

const ITEM_KINDS = Object.freeze(['text', 'line', 'frame', 'circled-value']);

function getTemplate(id) {
  if (typeof id !== 'string' || !Object.hasOwn(DRAWING_TAG_TEMPLATES, id))
    throw new TypeError(`未対応のタグテンプレートです: ${String(id)}`);
  return DRAWING_TAG_TEMPLATES[id];
}

function pointSnapshot(point) {
  return Object.freeze([...assertPoint(point)]);
}

function linePointsSnapshot(points) {
  if (!Array.isArray(points) || points.length !== 2) throw new TypeError('lineには2点が必要です。');
  return Object.freeze(points.map((point) => pointSnapshot(point)));
}

function rectSnapshot(rect) {
  if (
    !Array.isArray(rect) ||
    rect.length !== 4 ||
    !rect.every(Number.isFinite) ||
    rect[2] <= 0 ||
    rect[3] <= 0
  )
    throw new TypeError('frameの矩形が不正です。');
  return Object.freeze([...rect]);
}

function optionalPositive(value, name) {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name}が不正です。`);
  return value;
}

function optionalNonNegative(value, name) {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name}が不正です。`);
  return value;
}

function decorateText(item, value, text) {
  if (item.omitKnownZero && isKnownZeroTagValue(value)) return '';
  return `${item.prefix || ''}${text}${item.suffix || ''}`;
}

function resolveField(facts, item) {
  const read = (field) => (Object.hasOwn(facts.fields, field) ? facts.fields[field] : null);
  let field = item.field;
  let value = read(field);
  if (!value) {
    if (item.optionalField) return null;
    throw new TypeError(`タグfieldがありません: ${field}`);
  }
  // fallbackは定義で明示したmissingのみ。field欠落/invalid/該当なしは隠さない。
  if (value.status === 'missing' && item.fallbackField) {
    field = item.fallbackField;
    value = read(field);
    if (!value) throw new TypeError(`タグfieldがありません: ${field}`);
  }
  const normalized = normalizeTagValue(value);
  return {
    requestedField: item.field,
    resolvedField: field,
    value: normalized,
    text: decorateText(item, normalized, formatTagValue(normalized, item.format)),
  };
}

function buildPlanItem(item, facts) {
  if (!item || typeof item !== 'object' || !ITEM_KINDS.includes(item.kind))
    throw new TypeError('未対応のタグ描画項目です。');
  if (typeof item.id !== 'string' || !item.id.trim()) throw new TypeError('タグ項目IDが必要です。');

  if (item.kind === 'frame') {
    if (!['rect', 'rounded-rect'].includes(item.shape))
      throw new TypeError('未対応のframe形状です。');
    const radius =
      item.shape === 'rounded-rect' ? optionalPositive(item.radius, 'frame半径') : null;
    return Object.freeze({
      id: item.id,
      kind: item.kind,
      shape: item.shape,
      rect: rectSnapshot(item.rect),
      radius,
      strokeWidth: optionalPositive(item.strokeWidth, 'frame線幅'),
    });
  }

  if (item.kind === 'line') {
    return Object.freeze({
      id: item.id,
      kind: item.kind,
      points: linePointsSnapshot(item.points),
      strokeWidth: optionalPositive(item.strokeWidth, 'line線幅'),
    });
  }

  const point = pointSnapshot(item.point);
  const fontSize = optionalPositive(item.fontSize, 'タグ文字サイズ');
  const strokeWidth = optionalNonNegative(item.strokeWidth, 'タグ線幅');

  if (Object.hasOwn(item, 'literal')) {
    if (typeof item.literal !== 'string') throw new TypeError('タグliteralが不正です。');
    if (item.field || item.fallbackField || item.optionalField)
      throw new TypeError('literalとfield指定は併用できません。');
    return Object.freeze({
      id: item.id,
      kind: item.kind,
      point,
      text: item.literal,
      fontSize,
      strokeWidth,
      ...(item.kind === 'circled-value' ? { radius: optionalPositive(item.radius, '円半径') } : {}),
    });
  }

  if (typeof item.field !== 'string' || !item.field.trim() || typeof item.format !== 'string')
    throw new TypeError('タグfield/formatが必要です。');
  const resolved = resolveField(facts, item);
  if (!resolved) return null;
  return Object.freeze({
    id: item.id,
    kind: item.kind,
    point,
    ...resolved,
    fontSize,
    strokeWidth,
    ...(item.kind === 'circled-value' ? { radius: optionalPositive(item.radius, '円半径') } : {}),
  });
}

export function buildTagRenderPlan({ facts: input, templateId = 'member-mark-v1' } = {}) {
  const facts = normalizeTagFacts(input);
  const definition = getTemplate(templateId);
  const ids = new Set();
  const items = [];
  for (const item of definition.items) {
    if (ids.has(item.id)) throw new TypeError(`タグ定義IDが重複しています: ${item.id}`);
    ids.add(item.id);
    const built = buildPlanItem(item, facts);
    if (built) items.push(built);
  }
  return Object.freeze({
    schemaVersion: 1,
    units: definition.units,
    overflow: definition.overflow || 'visible',
    fontFamily: definition.fontFamily,
    template: Object.freeze({ id: definition.id, version: definition.version }),
    elementKey: facts.elementKey,
    ref: facts.ref,
    source: facts.source,
    items: Object.freeze(items),
  });
}

function equalPoint(left, right) {
  const a = assertPoint(left);
  const b = assertPoint(right);
  return a[0] === b[0] && a[1] === b[1];
}

function assertFieldItem(item, definition) {
  if (!equalPoint(item.point, definition.point))
    throw new TypeError('タグ描画項目の位置が不正です。');
  if (item.fontSize !== (definition.fontSize ?? null))
    throw new TypeError('タグ文字サイズがテンプレートと一致しません。');
  if (item.strokeWidth !== (definition.strokeWidth ?? null))
    throw new TypeError('タグ線幅がテンプレートと一致しません。');

  if (Object.hasOwn(definition, 'literal')) {
    if (item.text !== definition.literal)
      throw new TypeError('タグliteralがテンプレートと一致しません。');
  } else {
    const allowedResolvedFields = [definition.field, definition.fallbackField].filter(Boolean);
    if (
      typeof item.text !== 'string' ||
      item.requestedField !== definition.field ||
      !allowedResolvedFields.includes(item.resolvedField)
    )
      throw new TypeError('タグfield参照がテンプレートと一致しません。');
    const value = normalizeTagValue(item.value);
    const expected = decorateText(definition, value, formatTagValue(value, definition.format));
    if (item.text !== expected) throw new TypeError('タグ表示文字が値と一致しません。');
  }

  if (definition.kind === 'circled-value') {
    if (item.radius !== definition.radius)
      throw new TypeError('円半径がテンプレートと一致しません。');
  }
}

function assertStaticItem(item, definition) {
  if (definition.kind === 'line') {
    if (
      !Array.isArray(item.points) ||
      item.points.length !== 2 ||
      !equalPoint(item.points[0], definition.points[0]) ||
      !equalPoint(item.points[1], definition.points[1]) ||
      item.strokeWidth !== (definition.strokeWidth ?? null)
    )
      throw new TypeError('lineがテンプレートと一致しません。');
    return;
  }

  if (
    item.shape !== definition.shape ||
    !Array.isArray(item.rect) ||
    item.rect.length !== 4 ||
    item.rect.some((value, index) => value !== definition.rect[index]) ||
    item.radius !== (definition.shape === 'rounded-rect' ? definition.radius : null) ||
    item.strokeWidth !== (definition.strokeWidth ?? null)
  )
    throw new TypeError('frameがテンプレートと一致しません。');
}

/** 内部描画契約の検証。文字の再計算や原本参照はしない。 */
export function assertTagRenderPlan(plan) {
  if (plan?.schemaVersion !== 1) throw new TypeError('TagRenderPlan v1が必要です。');
  const definition = getTemplate(plan.template?.id);
  if (plan.units !== definition.units)
    throw new TypeError('タグ描画計画の単位がテンプレートと一致しません。');
  if (plan.overflow !== (definition.overflow || 'visible'))
    throw new TypeError('タグoverflow方針がテンプレートと一致しません。');
  if (
    typeof plan.fontFamily !== 'string' ||
    !plan.fontFamily.trim() ||
    plan.fontFamily !== definition.fontFamily
  )
    throw new TypeError('タグフォントがテンプレートと一致しません。');
  if (plan.template.version !== definition.version)
    throw new TypeError('タグテンプレートの版が一致しません。');
  if (
    elementRefKey(plan.ref) !== plan.elementKey ||
    plan.source?.modelKey !== plan.ref.modelKey ||
    !(
      plan.source.modelRevision === null ||
      (typeof plan.source.modelRevision === 'string' && plan.source.modelRevision.trim())
    )
  )
    throw new TypeError('TagRenderPlanの部材/モデル参照が不正です。');
  if (!Array.isArray(plan.items)) throw new TypeError('タグ描画項目が不正です。');

  const definitions = new Map();
  for (const item of definition.items) {
    if (definitions.has(item.id)) throw new TypeError('タグ定義IDが重複しています。');
    definitions.set(item.id, item);
  }

  const seen = new Set();
  for (const item of plan.items) {
    if (!item || typeof item !== 'object' || seen.has(item.id))
      throw new TypeError('タグ描画項目IDが不正です。');
    seen.add(item.id);
    const itemDefinition = definitions.get(item.id);
    if (!itemDefinition || item.kind !== itemDefinition.kind)
      throw new TypeError('未対応または不正なタグ描画項目です。');
    if (item.kind === 'line' || item.kind === 'frame') assertStaticItem(item, itemDefinition);
    else assertFieldItem(item, itemDefinition);
  }

  const expectedIds = definition.items
    .filter((itemDefinition) => !itemDefinition.optionalField || seen.has(itemDefinition.id))
    .map((itemDefinition) => itemDefinition.id);
  if (
    plan.items.length !== expectedIds.length ||
    plan.items.some((item, index) => item.id !== expectedIds[index])
  )
    throw new TypeError('タグ描画項目の順序がテンプレートと一致しません。');

  for (const itemDefinition of definition.items) {
    if (!itemDefinition.optionalField && !seen.has(itemDefinition.id))
      throw new TypeError(`必須タグ描画項目がありません: ${itemDefinition.id}`);
  }
  return plan;
}
