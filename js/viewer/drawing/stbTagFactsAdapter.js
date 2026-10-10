/**
 * @fileoverview STB原本snapshot→部材タグfacts adapter(STB XPath評価)。
 * XMLを読む責務はこの境界に限定し、data/drawing/tags/へDOMを持ち込まない。
 */
import { normalizeWallViewerElementType } from '../../common-stb/walls/wallClassification.js';
import {
  createElementRef,
  elementRefKey,
  normalizeDrawingSource,
} from '../../data/drawing/drawingModel.js';
import { normalizeTagFacts } from '../../data/drawing/tags/drawingTagFacts.js';
import { tagFamilyCategoryForElementType } from '../../data/drawing/tags/tagFamilyDefinition.js';
import {
  TAG_MEMBER_ELEMENT_BY_CATEGORY,
  parseTagXPathForCategory,
} from '../../data/drawing/tags/tagXPath.js';
import {
  resolveRcBeamSectionFigure,
  resolveRcColumnSectionFigure,
} from './stbTagSectionFigureAdapter.js';

/** 要素pathで断面図を解決できる断面要素。定義側の SECTION_FIGURE_ELEMENTS_BY_CATEGORY と対応する。 */
const SECTION_FIGURE_RESOLVERS = Object.freeze({
  StbSecColumn_RC: resolveRcColumnSectionFigure,
  StbSecBeam_RC: resolveRcBeamSectionFigure,
});
import { directChildren, localName, readVersion, uniqueById } from './stbTagFactsAdapterSupport.js';

/** 部材 @kind_structure → @id_section が参照する断面要素名。 */
const SECTION_ELEMENT_BY_KIND = Object.freeze({
  Girder: Object.freeze({ RC: 'StbSecBeam_RC', S: 'StbSecBeam_S', SRC: 'StbSecBeam_SRC' }),
  Beam: Object.freeze({ RC: 'StbSecBeam_RC', S: 'StbSecBeam_S', SRC: 'StbSecBeam_SRC' }),
  Column: Object.freeze({
    RC: 'StbSecColumn_RC',
    S: 'StbSecColumn_S',
    SRC: 'StbSecColumn_SRC',
    CFT: 'StbSecColumn_CFT',
  }),
  Post: Object.freeze({
    RC: 'StbSecColumn_RC',
    S: 'StbSecColumn_S',
    SRC: 'StbSecColumn_SRC',
    CFT: 'StbSecColumn_CFT',
  }),
  Brace: Object.freeze({ S: 'StbSecBrace_S' }),
  Slab: Object.freeze({
    RC: 'StbSecSlab_RC',
    DECK: 'StbSecSlabDeck',
    PRECAST: 'StbSecSlabPrecast',
  }),
  Wall: Object.freeze({ RC: 'StbSecWall_RC' }),
});

function describe(element) {
  return `${localName(element)}[@id='${element.getAttribute('id')}']`;
}

/** 部材が @id_section で参照する断面要素。解決できない場合は理由を返す。 */
function resolveSection(document, member, category) {
  const sectionId = member.getAttribute('id_section');
  if (!sectionId) return { element: null, reason: 'SECTION_ID_MISSING' };
  const kind = member.getAttribute('kind_structure');
  const tagName =
    kind === 'UNDEFINED' ? 'StbSecUndefined' : SECTION_ELEMENT_BY_KIND[category]?.[kind];
  if (!kind) return { element: null, reason: 'KIND_STRUCTURE_MISSING' };
  if (!tagName) return { element: null, reason: 'SECTION_KIND_UNSUPPORTED' };
  const element = uniqueById(document, tagName, sectionId, { required: false });
  return element ? { element, reason: null } : { element: null, reason: 'SECTION_MISSING' };
}

function matchesStep(element, step) {
  return (
    localName(element) === step.name &&
    step.predicates.every(
      (predicate) => element.getAttribute(predicate.attribute) === predicate.value,
    )
  );
}

/** 文書順(先頭Step要素のpre-order)の通し番号。 */
function preorderIndex(root) {
  const order = new Map();
  const visit = (element) => {
    order.set(element, order.size);
    for (const child of directChildren(element)) visit(child);
  };
  visit(root);
  return order;
}

function evaluatePath(path, anchors) {
  const root = anchors.find((anchor) => matchesStep(anchor, path.steps[0])) || null;
  if (!root) return { root: null, elements: [] };
  let current = [root];
  for (const step of path.steps.slice(1)) {
    current = current.flatMap((element) =>
      directChildren(element).filter((child) => matchesStep(child, step)),
    );
  }
  return { root, elements: current };
}

/**
 * 1つのXPathキーをTagValueへ評価する。
 * 値の順序は先頭Step(部材→断面)ごとの文書順、同一要素内は `|` の記述順。
 */
function evaluateKey({ expression, category, member, section, version }) {
  const xpath = parseTagXPathForCategory(expression, category);
  const anchors = [member, section.element].filter(Boolean);
  const rule = [`context=${describe(member)}`];
  if (section.element) rule.push(`section=${describe(section.element)}`);
  const provenance = {
    kind: 'stb',
    path: xpath.expression,
    version,
    rule: rule.join('; '),
  };
  const valueType = xpath.resultKind === 'element' ? 'figure' : 'text';
  const state = (status, reason) => ({ valueType, status, value: null, reason, provenance });

  const results = xpath.paths.map((path) => ({ path, ...evaluatePath(path, anchors) }));
  // 断面を参照するpathだけで、部材の断面参照自体が解決できない場合はmissing。
  const noMatch = () =>
    section.reason && results.every((result) => result.path.steps[0].name !== localName(member))
      ? state('missing', section.reason)
      : state('not-applicable', 'XPATH_NO_MATCH');
  if (xpath.resultKind === 'element') {
    const elements = [...new Set(results.flatMap((result) => result.elements))];
    if (elements.length === 0) return noMatch();
    if (elements.length > 1) return state('invalid', 'XPATH_MULTIPLE_ELEMENTS');
    const resolveFigure = SECTION_FIGURE_RESOLVERS[localName(elements[0])];
    if (!resolveFigure) return state('invalid', 'SECTION_FIGURE_UNSUPPORTED');
    const figure = resolveFigure(elements[0]);
    if (figure.status !== 'known') return state(figure.status, figure.reason);
    return { valueType, value: figure.value, provenance };
  }

  const orders = new Map();
  const values = [];
  const seen = new Map();
  results.forEach((result, branchIndex) => {
    if (!result.root) return;
    if (!orders.has(result.root)) orders.set(result.root, preorderIndex(result.root));
    for (const element of result.elements) {
      const attribute = result.path.attribute;
      if (!element.hasAttribute(attribute)) continue;
      if (!seen.has(element)) seen.set(element, new Set());
      if (seen.get(element).has(attribute)) continue;
      seen.get(element).add(attribute);
      values.push({
        sort: [anchors.indexOf(result.root), orders.get(result.root).get(element), branchIndex],
        value: element.getAttribute(attribute),
      });
    }
  });
  if (values.length === 0)
    return results.some((result) => result.elements.length > 0)
      ? state('missing', 'ATTRIBUTE_MISSING')
      : noMatch();
  values.sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || a.sort[2] - b.sort[2]);
  const texts = values.map((item) => item.value);
  return texts.length === 1
    ? { valueType, value: texts[0], provenance }
    : { valueType, shape: 'list', value: texts, provenance };
}

/**
 * STB原本から、TagFamilyが参照するXPathキーの値を取得する。cache/scene/renderer/sessionは所有しない。
 * @param {{document:Document, source:object, ref:object, keys:string[]}} input
 */
export function createStbMemberTagFactsFromDocument({
  document,
  source,
  ref: inputRef,
  keys,
} = {}) {
  const normalizedSource = normalizeDrawingSource(source);
  if (inputRef?.modelKey !== normalizedSource.modelKey)
    throw new TypeError('elementRefとsourceのmodelKeyが一致しません。');
  if (!Array.isArray(keys)) throw new TypeError('取得するXPathキー配列が必要です。');

  const elementType = normalizeWallViewerElementType(inputRef?.elementType);
  const category = tagFamilyCategoryForElementType(elementType);
  const memberTag = TAG_MEMBER_ELEMENT_BY_CATEGORY[category];
  if (!memberTag)
    throw new RangeError(`未対応のタグ部材種別です: ${String(inputRef?.elementType)}`);
  const ref = createElementRef(normalizedSource, elementType, inputRef.elementId, inputRef.guid);
  const { version } = readVersion(document);
  const member = uniqueById(document, memberTag, ref.elementId);
  const originalGuid = member.getAttribute('guid');
  if (ref.guid && originalGuid && ref.guid !== originalGuid)
    throw new Error('elementRefのGUIDがSTB原本と一致しません。');

  const section = resolveSection(document, member, category);
  const fields = {};
  for (const key of keys) {
    fields[key] = evaluateKey({ expression: key, category, member, section, version });
  }
  return normalizeTagFacts({
    schemaVersion: 1,
    ref,
    elementKey: elementRefKey(ref),
    source: { ...normalizedSource, stbVersion: version },
    fields,
  });
}
