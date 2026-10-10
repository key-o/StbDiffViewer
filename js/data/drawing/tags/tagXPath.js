/**
 * @fileoverview タグparameterキーのSTB XPath記法。構文検査と正規化だけを持ち、XMLを読まない。
 *
 * 対応する記法は XPath 1.0 の相対location pathの部分集合とする。
 *   Expr      := Path ('|' Path)*
 *   Path      := Step ('/' Step)* ('/@' Name)?
 *   Step      := Name ('[@' Name '=' Literal ']')*
 * 先頭Stepはタグ対象部材の要素名（例: StbColumn）か、部材の @id_section が参照する
 * 断面要素名（StbSec で始まる要素名）とする。STB版ごとの要素名差は記法側で吸収せず、
 * 必要なら `|` で版ごとのpathを併記する。
 */

export const TAG_MEMBER_ELEMENT_BY_CATEGORY = Object.freeze({
  Girder: 'StbGirder',
  Beam: 'StbBeam',
  Column: 'StbColumn',
  Post: 'StbPost',
  Brace: 'StbBrace',
  Slab: 'StbSlab',
  Wall: 'StbWall',
});

export const TAG_SECTION_ELEMENT_PREFIX = 'StbSec';
const MAX_EXPRESSION_LENGTH = 1000;
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function syntaxError(expression, message) {
  return new TypeError(`XPath「${expression}」: ${message}`);
}

function splitTopLevel(expression, separator) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const char of expression) {
    if (quote) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '[') depth++;
    else if (char === ']') depth--;
    if (depth < 0) throw syntaxError(expression, '角括弧の対応が不正です。');
    if (char === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (quote || depth !== 0) throw syntaxError(expression, '引用符または角括弧が閉じていません。');
  parts.push(current);
  return parts;
}

function parseStep(text, expression) {
  const bracket = text.indexOf('[');
  const name = (bracket < 0 ? text : text.slice(0, bracket)).trim();
  if (!NAME.test(name)) throw syntaxError(expression, `要素名が不正です: ${name || '(空)'}`);
  const predicates = [];
  let rest = bracket < 0 ? '' : text.slice(bracket).trim();
  const predicatePattern = /^\[\s*@([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(?:'([^']*)'|"([^"]*)")\s*\]/;
  while (rest) {
    const match = predicatePattern.exec(rest);
    if (!match)
      throw syntaxError(expression, `述語は [@属性='値'] だけを指定できます: ${name}${rest}`);
    predicates.push(Object.freeze({ attribute: match[1], value: match[2] ?? match[3] }));
    rest = rest.slice(match[0].length).trim();
  }
  return Object.freeze({ name, predicates: Object.freeze(predicates) });
}

function parsePath(text, expression) {
  const trimmed = text.trim();
  if (!trimmed) throw syntaxError(expression, '空のpathがあります。');
  if (trimmed.startsWith('/'))
    throw syntaxError(expression, '先頭の / は使えません。部材または断面の要素名から書きます。');
  const parts = splitTopLevel(trimmed, '/');
  let attribute = null;
  const last = parts.at(-1).trim();
  if (last.startsWith('@')) {
    attribute = last.slice(1).trim();
    if (!NAME.test(attribute)) throw syntaxError(expression, `属性名が不正です: ${last}`);
    parts.pop();
  }
  if (parts.length === 0) throw syntaxError(expression, '要素名のStepが必要です。');
  const steps = parts.map((part) => {
    if (part.trim().startsWith('@'))
      throw syntaxError(expression, '属性(@)はpathの末尾だけに書けます。');
    return parseStep(part, expression);
  });
  return Object.freeze({ steps: Object.freeze(steps), attribute });
}

function literal(value) {
  return value.includes("'") ? `"${value}"` : `'${value}'`;
}

function formatPath(path) {
  const steps = path.steps.map(
    (step) =>
      step.name +
      step.predicates
        .map((predicate) => `[@${predicate.attribute}=${literal(predicate.value)}]`)
        .join(''),
  );
  return path.attribute ? `${steps.join('/')}/@${path.attribute}` : steps.join('/');
}

/**
 * XPath文字列を構文解析し、空白等を正規化した凍結ASTを返す。カテゴリ検査はしない。
 * @returns {{expression:string, paths:Array, resultKind:'attribute'|'element'}}
 */
export function parseTagXPath(input) {
  if (typeof input !== 'string' || !input.trim()) throw new TypeError('XPathが必要です。');
  if (input.length > MAX_EXPRESSION_LENGTH)
    throw new TypeError(`XPathは${MAX_EXPRESSION_LENGTH}文字以内にしてください。`);
  const expression = input.trim();
  const paths = splitTopLevel(expression, '|').map((part) => parsePath(part, expression));
  const kinds = new Set(paths.map((path) => (path.attribute ? 'attribute' : 'element')));
  if (kinds.size !== 1)
    throw syntaxError(expression, '属性pathと要素pathを `|` で混在できません。');
  return Object.freeze({
    expression: paths.map(formatPath).join(' | '),
    paths: Object.freeze(paths),
    resultKind: [...kinds][0],
  });
}

/** 先頭Stepが対象カテゴリの部材要素か、断面要素であることを検査する。 */
export function parseTagXPathForCategory(input, category) {
  const memberElement = TAG_MEMBER_ELEMENT_BY_CATEGORY[category];
  if (!memberElement) throw new TypeError(`未対応のタグカテゴリです: ${String(category)}`);
  const parsed = parseTagXPath(input);
  for (const path of parsed.paths) {
    const anchor = path.steps[0].name;
    if (anchor !== memberElement && !anchor.startsWith(TAG_SECTION_ELEMENT_PREFIX))
      throw syntaxError(
        parsed.expression,
        `先頭は ${memberElement} か断面要素(${TAG_SECTION_ELEMENT_PREFIX}…)にしてください: ${anchor}`,
      );
  }
  return parsed;
}

/** カテゴリ検査済みの正規化XPath文字列。 */
export function normalizeTagXPathKey(input, category) {
  return parseTagXPathForCategory(input, category).expression;
}
