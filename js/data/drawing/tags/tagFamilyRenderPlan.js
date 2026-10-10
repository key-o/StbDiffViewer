/** @fileoverview TagFamily + TagFacts → custom TagRenderPlan v2。DOM/UI/保存を所有しない。 */
import { elementRefKey } from '../drawingModel.js';
import { normalizeTagFacts } from './drawingTagFacts.js';
import { normalizeTagFamily, tagFamilyCategoryForElementType } from './tagFamilyDefinition.js';
import { sectionFigurePlanItems } from './tagSectionFigure.js';
import { normalizeTagValue } from './tagValue.js';
import { formatTagValue, isKnownZeroTagValue } from './tagValueFormatter.js';

const PLAN_ITEM_KINDS = Object.freeze([
  'text',
  'line',
  'frame',
  'circle',
  'circled-value',
  'leader-anchor',
]);
const TEXT_ANCHORS = Object.freeze({ left: 'start', center: 'middle', right: 'end' });

function point(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError('タグ座標が不正です。');
  return Object.freeze([x, y]);
}

function statusText(value, parameter) {
  if (value.status === 'missing') return parameter.missingText;
  if (value.status === 'invalid') return parameter.invalidText;
  if (value.status === 'not-applicable') return parameter.notApplicableText;
  return null;
}

function formatParameterValue(value, parameter) {
  if (parameter.format === 'section-figure') return statusText(value, parameter) ?? '';
  if (value.valueType !== 'text')
    throw new TypeError(`parameter ${parameter.id} の値は文字である必要があります。`);
  if (parameter.omitKnownZero && isKnownZeroTagValue(value)) return '';
  let text = statusText(value, parameter);
  if (text === null) {
    text = formatTagValue(value, parameter.format, { delimiter: parameter.delimiter });
    // 数値書式で数値化できないSTB属性値は、推定せずinvalid表示にする。
    if (text === null) text = parameter.invalidText;
    else if (parameter.unit === 'mm' && text) text = `${text} mm`;
  }
  // 値が空(既知0の省略・空の状態表示)なら接頭辞/接尾辞も出さない。
  return text ? `${parameter.prefix}${text}${parameter.suffix}` : '';
}

function resolveParameters(facts, family) {
  const resolved = new Map();
  for (const parameter of family.parameters) {
    if (!Object.hasOwn(facts.fields, parameter.key)) {
      if (parameter.optional) {
        resolved.set(parameter.id, null);
        continue;
      }
      throw new TypeError(`タグfieldがありません: ${parameter.key}`);
    }
    const value = normalizeTagValue(facts.fields[parameter.key]);
    if ((value.valueType === 'figure') !== (parameter.format === 'section-figure'))
      throw new TypeError(`parameter ${parameter.id} の値の型と書式が一致しません。`);
    resolved.set(
      parameter.id,
      Object.freeze({
        parameter,
        requestedField: parameter.key,
        resolvedField: parameter.key,
        value,
        text: formatParameterValue(value, parameter),
      }),
    );
  }
  return resolved;
}

function conditionMatches(condition, parameters) {
  if (!condition) return true;
  const resolved = parameters.get(condition.parameterId);
  return Boolean(resolved && condition.statusIn.includes(resolved.value.status));
}

function textItem(primitive, resolved = null) {
  return Object.freeze({
    id: primitive.id,
    kind: primitive.kind === 'circled-value' ? 'circled-value' : 'text',
    point: point(primitive.x, primitive.y),
    text: resolved ? resolved.text : primitive.text,
    fontSize: primitive.fontSize,
    strokeWidth: primitive.haloWidth,
    textAnchor: TEXT_ANCHORS[primitive.align],
    ...(resolved
      ? {
          requestedField: resolved.requestedField,
          resolvedField: resolved.resolvedField,
          value: resolved.value,
        }
      : {}),
    ...(primitive.kind === 'circled-value'
      ? { radius: primitive.radius, circleStrokeWidth: primitive.strokeWidth }
      : {}),
  });
}

function sectionFigureItems(primitive, resolved) {
  if (resolved.value.status === 'known')
    return sectionFigurePlanItems(resolved.value.value, primitive);
  if (!resolved.text) return [];
  // 断面図を描けない状態は、図の上辺中央に状態文字だけを示す。
  return [
    Object.freeze({
      id: `${primitive.id}:status`,
      sourcePrimitiveId: primitive.id,
      kind: 'text',
      point: point(primitive.x, primitive.y + primitive.fontSize),
      text: resolved.text,
      fontSize: primitive.fontSize,
      strokeWidth: 0,
      textAnchor: 'middle',
      requestedField: resolved.requestedField,
      resolvedField: resolved.resolvedField,
      value: resolved.value,
    }),
  ];
}

function buildPrimitive(primitive, parameters) {
  if (!conditionMatches(primitive.condition, parameters)) return [];
  if (primitive.kind === 'section-figure') {
    const resolved = parameters.get(primitive.parameterId);
    return resolved ? sectionFigureItems(primitive, resolved) : [];
  }
  if (primitive.kind === 'text') return [textItem(primitive)];
  if (primitive.kind === 'parameter-text' || primitive.kind === 'circled-value') {
    const resolved = parameters.get(primitive.parameterId);
    if (!resolved) return [];
    return [textItem(primitive, resolved)];
  }
  if (primitive.kind === 'line' || primitive.kind === 'separator') {
    return [
      Object.freeze({
        id: primitive.id,
        kind: 'line',
        points: Object.freeze([
          point(primitive.x1, primitive.y1),
          point(primitive.x2, primitive.y2),
        ]),
        strokeWidth: primitive.strokeWidth,
      }),
    ];
  }
  if (primitive.kind === 'rectangle' || primitive.kind === 'rounded-rectangle') {
    return [
      Object.freeze({
        id: primitive.id,
        kind: 'frame',
        shape: primitive.kind === 'rounded-rectangle' ? 'rounded-rect' : 'rect',
        rect: Object.freeze([primitive.x, primitive.y, primitive.width, primitive.height]),
        radius: primitive.kind === 'rounded-rectangle' ? primitive.radius : null,
        strokeWidth: primitive.strokeWidth,
      }),
    ];
  }
  if (primitive.kind === 'circle') {
    return [
      Object.freeze({
        id: primitive.id,
        kind: 'circle',
        point: point(primitive.x, primitive.y),
        radius: primitive.radius,
        strokeWidth: primitive.strokeWidth,
      }),
    ];
  }
  if (primitive.kind === 'leader-anchor') {
    return [
      Object.freeze({
        id: primitive.id,
        kind: 'leader-anchor',
        point: point(primitive.x, primitive.y),
      }),
    ];
  }
  throw new TypeError(`未対応のタグprimitiveです: ${primitive.kind}`);
}

function templateIdentity(family, template) {
  if (template === undefined || template === null)
    return Object.freeze({ id: family.id, version: family.version });
  if (
    typeof template?.id !== 'string' ||
    !template.id.trim() ||
    !Number.isSafeInteger(template.version) ||
    template.version < 1
  )
    throw new TypeError('TagRenderPlanのtemplate identityが不正です。');
  return Object.freeze({ id: template.id, version: template.version });
}

/** custom/built-in TagFamilyをpaper-mm TagRenderPlan v2へ展開する。 */
export function buildTagFamilyRenderPlan({
  facts: inputFacts,
  family: inputFamily,
  template = null,
} = {}) {
  const facts = normalizeTagFacts(inputFacts);
  const family = normalizeTagFamily(inputFamily, { builtIn: inputFamily?.builtIn === true });
  if (tagFamilyCategoryForElementType(facts.ref.elementType) !== family.category)
    throw new TypeError(
      `TagFamilyカテゴリ${family.category}と部材${facts.ref.elementType}が一致しません。`,
    );

  const parameters = resolveParameters(facts, family);
  const items = [];
  for (const primitive of family.primitives) items.push(...buildPrimitive(primitive, parameters));

  return Object.freeze({
    schemaVersion: 2,
    units: 'paper-mm',
    overflow: 'visible',
    fontFamily: family.style.fontFamily,
    paperScale: family.paperScale,
    orientationMode: family.orientationMode,
    template: templateIdentity(family, template),
    category: family.category,
    elementKey: facts.elementKey,
    ref: facts.ref,
    source: facts.source,
    items: Object.freeze(items),
  });
}

function assertPoint(value, name) {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite))
    throw new TypeError(`${name}が不正です。`);
}

function assertPositive(value, name, { allowZero = false } = {}) {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0))
    throw new TypeError(`${name}が不正です。`);
}

function assertPlanItem(item) {
  if (!item || typeof item !== 'object' || !PLAN_ITEM_KINDS.includes(item.kind))
    throw new TypeError('custom TagRenderPlan itemが不正です。');
  if (typeof item.id !== 'string' || !item.id.trim()) throw new TypeError('item idが必要です。');
  if (item.kind === 'line') {
    if (!Array.isArray(item.points) || item.points.length !== 2)
      throw new TypeError('line pointsが不正です。');
    assertPoint(item.points[0], 'line始点');
    assertPoint(item.points[1], 'line終点');
    assertPositive(item.strokeWidth, 'line線幅');
    return;
  }
  if (item.kind === 'frame') {
    if (!['rect', 'rounded-rect'].includes(item.shape))
      throw new TypeError('frame形状が不正です。');
    if (
      !Array.isArray(item.rect) ||
      item.rect.length !== 4 ||
      !item.rect.every(Number.isFinite) ||
      item.rect[2] <= 0 ||
      item.rect[3] <= 0
    )
      throw new TypeError('frame矩形が不正です。');
    if (item.shape === 'rounded-rect') assertPositive(item.radius, 'frame半径');
    assertPositive(item.strokeWidth, 'frame線幅');
    return;
  }
  assertPoint(item.point, 'item位置');
  if (item.kind === 'leader-anchor') return;
  if (item.kind === 'circle') {
    assertPositive(item.radius, '円半径');
    assertPositive(item.strokeWidth, '円線幅');
    if (item.filled !== undefined && item.filled !== true)
      throw new TypeError('円の塗り指定が不正です。');
    return;
  }
  if (typeof item.text !== 'string') throw new TypeError('タグtextが不正です。');
  assertPositive(item.fontSize, 'タグ文字サイズ');
  assertPositive(item.strokeWidth, 'タグhalo幅', { allowZero: true });
  if (!['start', 'middle', 'end'].includes(item.textAnchor))
    throw new TypeError('textAnchorが不正です。');
  if (item.kind === 'circled-value') {
    assertPositive(item.radius, '丸囲み半径');
    assertPositive(item.circleStrokeWidth, '丸囲み線幅', { allowZero: true });
  }
}

/** rendererへ渡すcustom TagRenderPlan v2をfail-closedで検証する。 */
export function assertTagFamilyRenderPlan(plan) {
  if (plan?.schemaVersion !== 2) throw new TypeError('custom TagRenderPlan v2が必要です。');
  if (plan.units !== 'paper-mm' || plan.overflow !== 'visible')
    throw new TypeError('custom TagRenderPlanの単位/overflowが不正です。');
  if (typeof plan.fontFamily !== 'string' || !plan.fontFamily.trim())
    throw new TypeError('custom TagRenderPlanのfontFamilyが不正です。');
  if (!Number.isFinite(plan.paperScale) || plan.paperScale < 0.5 || plan.paperScale > 2)
    throw new RangeError('custom TagRenderPlanのpaperScaleが不正です。');
  if (!['model', 'member'].includes(plan.orientationMode))
    throw new TypeError('custom TagRenderPlanのorientationModeが不正です。');
  if (
    !plan.template ||
    typeof plan.template.id !== 'string' ||
    !Number.isSafeInteger(plan.template.version) ||
    plan.template.version < 1
  )
    throw new TypeError('custom TagRenderPlanのtemplateが不正です。');
  if (plan.category !== tagFamilyCategoryForElementType(plan.ref?.elementType))
    throw new TypeError('custom TagRenderPlanのcategory/refが一致しません。');
  if (
    elementRefKey(plan.ref) !== plan.elementKey ||
    plan.source?.modelKey !== plan.ref.modelKey ||
    !(
      plan.source.modelRevision === null ||
      (typeof plan.source.modelRevision === 'string' && plan.source.modelRevision.trim())
    )
  )
    throw new TypeError('custom TagRenderPlanの部材/モデル参照が不正です。');
  if (!Array.isArray(plan.items)) throw new TypeError('custom TagRenderPlanのitemsが不正です。');
  const ids = new Set();
  for (const item of plan.items) {
    assertPlanItem(item);
    if (ids.has(item.id))
      throw new TypeError(`custom TagRenderPlan item idが重複しています: ${item.id}`);
    ids.add(item.id);
  }
  return plan;
}
