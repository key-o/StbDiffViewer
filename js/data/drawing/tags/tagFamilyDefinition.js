/** @fileoverview Revitタグファミリ型の宣言的タグ定義契約。DOM/保存/UIを所有しない。 */
import { TAG_FIGURE_FORMATS, TAG_TEXT_FORMATS } from './tagValueFormatter.js';
import { parseTagXPathForCategory } from './tagXPath.js';
import { legacyTagParameterXPath } from './tagXPathCatalog.js';

export const TAG_FAMILY_SCHEMA_VERSION = 2;
export const TAG_FAMILY_MIN_SCALE = 0.5;
export const TAG_FAMILY_MAX_SCALE = 2;
export const SECTION_FIGURE_DEFAULT_SCALE_DENOMINATOR = 40;

export const TAG_FAMILY_CATEGORIES = Object.freeze([
  'Girder',
  'Beam',
  'Column',
  'Post',
  'Brace',
  'Slab',
  'Wall',
]);

/** Viewer固有の要素種別をTagFamilyの正規カテゴリへ写像する。 */
export function tagFamilyCategoryForElementType(elementType) {
  return elementType === 'ShearWall' ? 'Wall' : elementType;
}

export const TAG_FAMILY_PRIMITIVE_KINDS = Object.freeze([
  'text',
  'parameter-text',
  'line',
  'rectangle',
  'rounded-rectangle',
  'circle',
  'circled-value',
  'separator',
  'leader-anchor',
  'section-figure',
]);

export const TAG_PARAMETER_FORMATS = Object.freeze([...TAG_TEXT_FORMATS, ...TAG_FIGURE_FORMATS]);

/** 断面図(豆図)を描画できる断面要素。外形と配筋はRC柱・RC梁断面だけ解決する。 */
export const SECTION_FIGURE_ELEMENTS_BY_CATEGORY = Object.freeze({
  Girder: Object.freeze(['StbSecBeam_RC']),
  Beam: Object.freeze(['StbSecBeam_RC']),
  Column: Object.freeze(['StbSecColumn_RC']),
  Post: Object.freeze(['StbSecColumn_RC']),
});

const ALIGN_VALUES = Object.freeze(['left', 'center', 'right']);
const ORIENTATION_VALUES = Object.freeze(['model', 'member']);
const CONDITION_STATUSES = Object.freeze(['known', 'missing', 'invalid', 'not-applicable']);
const LEGACY_FORMATS = Object.freeze({
  text: 'text',
  dimension: 'dimension',
  level: 'level',
  'dimension-profile': 'dimension',
  'level-profile': 'level',
});

const stringValue = (value, name, { allowEmpty = false, max = 160 } = {}) => {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max)
    throw new TypeError(`${name}が不正です。`);
  return value;
};

const finite = (value, name) => {
  if (!Number.isFinite(value)) throw new TypeError(`${name}が不正です。`);
  return value;
};

const positive = (value, name) => {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name}が不正です。`);
  return value;
};

const nonNegative = (value, name) => {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name}が不正です。`);
  return value;
};

function assertKnownKeys(input, allowed, name) {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError(`${name}に未対応のfieldがあります: ${key}`);
  }
}

function optionalString(value, name, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return stringValue(value, name, { allowEmpty: true, max: 80 });
}

function normalizeFontFamily(value) {
  const font = stringValue(value, 'font-family', { max: 160 });
  if (!/^[\p{L}\p{N}\s,"'._-]+$/u.test(font))
    throw new TypeError('font-familyに未対応の文字が含まれます。');
  return font;
}

function normalizeCondition(input, parameterIds) {
  if (input === undefined || input === null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('タグ条件が不正です。');
  assertKnownKeys(input, new Set(['parameterId', 'statusIn']), 'タグ条件');
  const parameterId = stringValue(input.parameterId, '条件parameterId', { max: 80 });
  if (!parameterIds.has(parameterId)) throw new TypeError(`未定義parameterIdです: ${parameterId}`);
  if (!Array.isArray(input.statusIn) || input.statusIn.length === 0)
    throw new TypeError('条件statusInが必要です。');
  const statusIn = [...new Set(input.statusIn)];
  if (statusIn.some((status) => !CONDITION_STATUSES.includes(status)))
    throw new TypeError('条件statusInに未対応の値があります。');
  return Object.freeze({ parameterId, statusIn: Object.freeze(statusIn) });
}

function normalizeParameter(input, category) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('タグparameterが不正です。');
  assertKnownKeys(
    input,
    new Set([
      'id',
      'key',
      'format',
      'prefix',
      'suffix',
      'unit',
      'delimiter',
      'omitKnownZero',
      'optional',
      'missingText',
      'invalidText',
      'notApplicableText',
    ]),
    'タグparameter',
  );
  const id = stringValue(input.id, 'parameter id', { max: 80 });
  const xpath = parseTagXPathForCategory(
    stringValue(input.key, 'parameter key', { max: 1000 }),
    category,
  );
  const key = xpath.expression;
  const format = input.format ?? (xpath.resultKind === 'element' ? 'section-figure' : 'text');
  if (!TAG_PARAMETER_FORMATS.includes(format))
    throw new TypeError(`未対応のタグ書式です: ${format}`);
  if (xpath.resultKind === 'element') {
    const figureElements = SECTION_FIGURE_ELEMENTS_BY_CATEGORY[category] || [];
    if (
      format !== 'section-figure' ||
      xpath.paths.some(
        (path) =>
          path.steps.length !== 1 ||
          path.steps[0].predicates.length > 0 ||
          !figureElements.includes(path.steps[0].name),
      )
    )
      throw new TypeError(
        `要素を指すXPathは断面図書式で ${figureElements.join(' / ') || '(対応断面なし)'} だけ指定できます: ${key}`,
      );
  } else if (format === 'section-figure') {
    throw new TypeError(`断面図書式には断面要素のXPathを指定してください: ${key}`);
  }
  const unit = input.unit ?? '';
  if (!['', 'mm'].includes(unit)) throw new TypeError(`未対応の表示単位です: ${unit}`);
  return Object.freeze({
    id,
    key,
    format,
    prefix: optionalString(input.prefix, 'parameter prefix'),
    suffix: optionalString(input.suffix, 'parameter suffix'),
    unit,
    delimiter: optionalString(input.delimiter, 'parameter delimiter', '〜'),
    omitKnownZero: input.omitKnownZero === true,
    optional: input.optional === true,
    missingText: optionalString(input.missingText, 'missing表示', '?'),
    invalidText: optionalString(input.invalidText, 'invalid表示', '!'),
    notApplicableText: optionalString(input.notApplicableText, 'not-applicable表示', '—'),
  });
}

function referencedParameter(input, id, parameters, figure) {
  const parameterId = stringValue(input.parameterId, `${id}.parameterId`, { max: 80 });
  const parameter = parameters.get(parameterId);
  if (!parameter) throw new TypeError(`未定義parameterIdです: ${parameterId}`);
  if ((parameter.format === 'section-figure') !== figure)
    throw new TypeError(
      figure
        ? `${id}には断面図書式のparameterを指定してください。`
        : `${id}には文字書式のparameterを指定してください。`,
    );
  return parameterId;
}

function normalizePrimitive(input, parameters, style) {
  const parameterIds = new Set(parameters.keys());
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('タグprimitiveが不正です。');
  const id = stringValue(input.id, 'primitive id', { max: 80 });
  const kind = input.kind;
  if (!TAG_FAMILY_PRIMITIVE_KINDS.includes(kind))
    throw new TypeError(`未対応のタグprimitiveです: ${String(kind)}`);
  const primitiveKeys = {
    text: [
      'id',
      'kind',
      'condition',
      'x',
      'y',
      'text',
      'fontSize',
      'align',
      'radius',
      'haloWidth',
      'strokeWidth',
    ],
    'parameter-text': [
      'id',
      'kind',
      'condition',
      'x',
      'y',
      'parameterId',
      'fontSize',
      'align',
      'radius',
      'haloWidth',
      'strokeWidth',
    ],
    'circled-value': [
      'id',
      'kind',
      'condition',
      'x',
      'y',
      'parameterId',
      'fontSize',
      'align',
      'radius',
      'haloWidth',
      'strokeWidth',
    ],
    line: ['id', 'kind', 'condition', 'x1', 'y1', 'x2', 'y2', 'strokeWidth'],
    separator: ['id', 'kind', 'condition', 'x1', 'y1', 'x2', 'y2', 'strokeWidth'],
    rectangle: ['id', 'kind', 'condition', 'x', 'y', 'width', 'height', 'radius', 'strokeWidth'],
    'rounded-rectangle': [
      'id',
      'kind',
      'condition',
      'x',
      'y',
      'width',
      'height',
      'radius',
      'strokeWidth',
    ],
    circle: ['id', 'kind', 'condition', 'x', 'y', 'radius', 'strokeWidth'],
    'leader-anchor': ['id', 'kind', 'condition', 'x', 'y'],
    'section-figure': [
      'id',
      'kind',
      'condition',
      'x',
      'y',
      'parameterId',
      'scaleDenominator',
      'strokeWidth',
      'fontSize',
    ],
  }[kind];
  assertKnownKeys(input, new Set(primitiveKeys), `タグprimitive ${kind}`);
  const condition = normalizeCondition(input.condition, parameterIds);

  const common = { id, kind, condition };
  if (kind === 'text' || kind === 'parameter-text' || kind === 'circled-value') {
    const x = finite(input.x, `${id}.x`);
    const y = finite(input.y, `${id}.y`);
    const fontSize =
      input.fontSize === undefined ? style.fontSize : positive(input.fontSize, `${id}.fontSize`);
    const align = input.align ?? style.align;
    if (!ALIGN_VALUES.includes(align)) throw new TypeError(`${id}.alignが不正です。`);
    const parameterId = kind === 'text' ? null : referencedParameter(input, id, parameters, false);
    if (kind === 'text') stringValue(input.text, `${id}.text`, { allowEmpty: true, max: 500 });
    const radius = kind === 'circled-value' ? positive(input.radius, `${id}.radius`) : null;
    return Object.freeze({
      ...common,
      x,
      y,
      ...(kind === 'text' ? { text: input.text } : { parameterId }),
      fontSize,
      align,
      radius,
      haloWidth:
        input.haloWidth === undefined
          ? style.haloWidth
          : nonNegative(input.haloWidth, `${id}.haloWidth`),
      strokeWidth:
        kind === 'circled-value'
          ? input.strokeWidth === undefined
            ? style.strokeWidth
            : nonNegative(input.strokeWidth, `${id}.strokeWidth`)
          : null,
    });
  }

  if (kind === 'line' || kind === 'separator') {
    return Object.freeze({
      ...common,
      x1: finite(input.x1, `${id}.x1`),
      y1: finite(input.y1, `${id}.y1`),
      x2: finite(input.x2, `${id}.x2`),
      y2: finite(input.y2, `${id}.y2`),
      strokeWidth:
        input.strokeWidth === undefined
          ? style.strokeWidth
          : positive(input.strokeWidth, `${id}.strokeWidth`),
    });
  }

  if (kind === 'rectangle' || kind === 'rounded-rectangle') {
    return Object.freeze({
      ...common,
      x: finite(input.x, `${id}.x`),
      y: finite(input.y, `${id}.y`),
      width: positive(input.width, `${id}.width`),
      height: positive(input.height, `${id}.height`),
      radius: kind === 'rounded-rectangle' ? positive(input.radius, `${id}.radius`) : null,
      strokeWidth:
        input.strokeWidth === undefined
          ? style.strokeWidth
          : positive(input.strokeWidth, `${id}.strokeWidth`),
    });
  }

  if (kind === 'circle') {
    return Object.freeze({
      ...common,
      x: finite(input.x, `${id}.x`),
      y: finite(input.y, `${id}.y`),
      radius: positive(input.radius, `${id}.radius`),
      strokeWidth:
        input.strokeWidth === undefined
          ? style.strokeWidth
          : positive(input.strokeWidth, `${id}.strokeWidth`),
    });
  }

  if (kind === 'section-figure') {
    const scaleDenominator = input.scaleDenominator ?? SECTION_FIGURE_DEFAULT_SCALE_DENOMINATOR;
    if (!Number.isFinite(scaleDenominator) || scaleDenominator < 1 || scaleDenominator > 1000)
      throw new RangeError(`${id}.scaleDenominatorは1〜1000で指定してください。`);
    return Object.freeze({
      ...common,
      x: finite(input.x, `${id}.x`),
      y: finite(input.y, `${id}.y`),
      parameterId: referencedParameter(input, id, parameters, true),
      scaleDenominator,
      strokeWidth:
        input.strokeWidth === undefined
          ? style.strokeWidth
          : positive(input.strokeWidth, `${id}.strokeWidth`),
      fontSize:
        input.fontSize === undefined ? style.fontSize : positive(input.fontSize, `${id}.fontSize`),
    });
  }

  return Object.freeze({
    ...common,
    x: finite(input.x, `${id}.x`),
    y: finite(input.y, `${id}.y`),
  });
}

/**
 * TagFamily v1(`.`区切りキー)をv2(STB XPathキー)へ写像する。
 * STB原本に直接の値が無い廃止キーのparameterは、それを参照するprimitive/条件ごと除外する。
 */
function migrateTagFamilyV1(input) {
  const category = input.category;
  if (!TAG_FAMILY_CATEGORIES.includes(category) || !Array.isArray(input.parameters))
    return { ...input, schemaVersion: TAG_FAMILY_SCHEMA_VERSION };
  const removed = new Set();
  const parameters = [];
  for (const parameter of input.parameters) {
    const key = legacyTagParameterXPath(category, parameter?.key);
    if (key === null) {
      removed.add(parameter?.id);
      continue;
    }
    const migrated = { ...parameter, key };
    if (parameter.format !== undefined)
      migrated.format = LEGACY_FORMATS[parameter.format] ?? parameter.format;
    parameters.push(migrated);
  }
  const primitives = Array.isArray(input.primitives)
    ? input.primitives.filter(
        (primitive) =>
          !removed.has(primitive?.parameterId) && !removed.has(primitive?.condition?.parameterId),
      )
    : input.primitives;
  return { ...input, schemaVersion: TAG_FAMILY_SCHEMA_VERSION, parameters, primitives };
}

/** JSON化可能なTagFamily v2を検証し、凍結snapshotを返す。v1保存データはv2へ移行する。 */
export function normalizeTagFamily(input, { builtIn = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('TagFamilyが必要です。');
  assertKnownKeys(
    input,
    new Set([
      'schemaVersion',
      'id',
      'name',
      'category',
      'version',
      'paperScale',
      'orientationMode',
      'parameters',
      'primitives',
      'style',
      'builtIn',
    ]),
    'TagFamily',
  );
  if ('builtIn' in input && input.builtIn !== (builtIn === true))
    throw new TypeError('TagFamily builtIn指定が名前空間と一致しません。');
  if (input.schemaVersion === 1) input = migrateTagFamilyV1(input);
  if (input.schemaVersion !== TAG_FAMILY_SCHEMA_VERSION)
    throw new TypeError(`TagFamily v${TAG_FAMILY_SCHEMA_VERSION}が必要です。`);
  const id = stringValue(input.id, 'TagFamily id', { max: 120 });
  const expectedPrefix = builtIn ? 'builtin:' : 'user:';
  if (!id.startsWith(expectedPrefix) || !/^[A-Za-z0-9._:-]+$/.test(id))
    throw new TypeError(
      builtIn
        ? 'built-in idはbuiltin:で開始する安全な識別子にしてください。'
        : 'user idはuser:で開始する安全な識別子にしてください。',
    );
  const category = input.category;
  if (!TAG_FAMILY_CATEGORIES.includes(category))
    throw new TypeError(`未対応のTagFamilyカテゴリです: ${String(category)}`);
  if (!Number.isSafeInteger(input.version) || input.version < 1)
    throw new TypeError('TagFamily versionが不正です。');
  const paperScale = input.paperScale ?? 1;
  if (
    !Number.isFinite(paperScale) ||
    paperScale < TAG_FAMILY_MIN_SCALE ||
    paperScale > TAG_FAMILY_MAX_SCALE
  )
    throw new RangeError(
      `paperScaleは${TAG_FAMILY_MIN_SCALE}〜${TAG_FAMILY_MAX_SCALE}で指定してください。`,
    );
  const orientationMode = input.orientationMode ?? 'model';
  if (!ORIENTATION_VALUES.includes(orientationMode))
    throw new TypeError(`未対応のorientationModeです: ${orientationMode}`);
  if (!Array.isArray(input.parameters) || !Array.isArray(input.primitives))
    throw new TypeError('parameters/primitives配列が必要です。');

  const styleInput = input.style ?? {};
  if (!styleInput || typeof styleInput !== 'object' || Array.isArray(styleInput))
    throw new TypeError('TagFamily styleが不正です。');
  assertKnownKeys(
    styleInput,
    new Set(['fontFamily', 'fontSize', 'align', 'padding', 'strokeWidth', 'haloWidth']),
    'TagFamily style',
  );
  const styleAlign = styleInput.align ?? 'center';
  if (!ALIGN_VALUES.includes(styleAlign)) throw new TypeError('style.alignが不正です。');
  const style = Object.freeze({
    fontFamily: normalizeFontFamily(
      styleInput.fontFamily ?? '"Meiryo UI", "MS Gothic", sans-serif',
    ),
    fontSize: positive(styleInput.fontSize ?? 1.5, 'style.fontSize'),
    align: styleAlign,
    padding: nonNegative(styleInput.padding ?? 0, 'style.padding'),
    strokeWidth: positive(styleInput.strokeWidth ?? 0.35, 'style.strokeWidth'),
    haloWidth: nonNegative(styleInput.haloWidth ?? 0.55, 'style.haloWidth'),
  });

  const parameters = input.parameters.map((parameter) => normalizeParameter(parameter, category));
  const parameterById = new Map();
  for (const parameter of parameters) {
    if (parameterById.has(parameter.id))
      throw new TypeError(`parameter idが重複しています: ${parameter.id}`);
    parameterById.set(parameter.id, parameter);
  }

  const primitives = input.primitives.map((primitive) =>
    normalizePrimitive(primitive, parameterById, style),
  );
  const primitiveIds = new Set();
  for (const primitive of primitives) {
    if (primitiveIds.has(primitive.id))
      throw new TypeError(`primitive idが重複しています: ${primitive.id}`);
    primitiveIds.add(primitive.id);
  }

  return Object.freeze({
    schemaVersion: TAG_FAMILY_SCHEMA_VERSION,
    id,
    name: stringValue(input.name, 'TagFamily name', { max: 80 }),
    category,
    version: input.version,
    paperScale,
    orientationMode,
    parameters: Object.freeze(parameters),
    primitives: Object.freeze(primitives),
    style,
    builtIn: builtIn === true,
  });
}
