/**
 * @fileoverview JSON Schema 検証モジュール（ブラウザ版）
 *
 * バージョン別 JSON Schema 属性メタデータを使って STB XML ファイルを検証する。
 * xsdSchemaValidator.js の JSON Schema 版。
 *
 * 検証項目:
 * - 未宣言属性の検出（additionalProperties: false）
 * - 必須属性の欠落チェック
 * - const 値（fixed 値）の一致チェック
 * - 数値制約（minimum, maximum, exclusiveMinimum, exclusiveMaximum）
 * - パターン制約
 * - 列挙型制約（enum）
 * - 型チェック（number, boolean 等）
 */

import {
  getElementDefinitionForVersion,
  isVersionLoaded,
} from '../import/parser/jsonSchemaLoader.js';
import { SEVERITY, CATEGORY } from './validationConstants.js';
import { buildIssueLocation as buildBaseIssueLocation } from './issueLocation.js';

// 属性インタープリターのキャッシュ（バージョン別）
const attributeValidatorCache = new Map(); // version -> Map<elementName, validator | null>

/**
 * JSON Schema に基づいて STB XML ドキュメントを検証
 *
 * @param {Document} xmlDoc - パース済み XML ドキュメント
 * @param {Object} options
 * @param {string} [options.version='2.0.2'] - STB バージョン
 * @returns {Array<Object>} ValidationIssue 配列
 */
export function validateJsonSchema(xmlDoc, options = {}) {
  const { version = '2.0.2' } = options;

  if (!xmlDoc || !xmlDoc.documentElement) return [];
  if (!isVersionLoaded(version)) return [];

  const ctx = getAttributeValidatorContext(version);
  const issues = [];

  validateElement(xmlDoc.documentElement, version, ctx, issues);

  return issues;
}

// ============================================================
// 内部: 属性検証コンテキスト管理
// ============================================================

/**
 * バージョン別属性検証コンテキストを取得（キャッシュ）
 */
function getAttributeValidatorContext(version) {
  if (attributeValidatorCache.has(version)) {
    return attributeValidatorCache.get(version);
  }

  const ctx = { version, validatorCache: new Map() };
  attributeValidatorCache.set(version, ctx);
  return ctx;
}

/**
 * 要素名に対応する属性検証関数を取得（キャッシュ）
 */
function getAttributeValidator(elementName, ctx) {
  const { version, validatorCache } = ctx;
  if (validatorCache.has(elementName)) return validatorCache.get(elementName);

  const def = getElementDefinitionForVersion(version, elementName);
  if (!def) {
    validatorCache.set(elementName, null);
    return null;
  }

  try {
    const validator = buildAttributeValidator(def);
    validatorCache.set(elementName, validator);
    return validator;
  } catch {
    validatorCache.set(elementName, null);
    return null;
  }
}

/**
 * バージョン付き属性定義から、Ajv の allErrors/coerceTypes に相当する
 * 属性検証関数を構築する。Ajv のコード生成には依存しない。
 */
function buildAttributeValidator(def) {
  const attributes = [];
  const required = [];
  const allowedNames = new Set();

  for (const [name, attrDef] of def.attributes) {
    allowedNames.add(name);
    if (attrDef.required) required.push(name);

    const constraints = attrDef.constraints;
    const enumerations = constraints?.enumerations || [];
    const pattern = constraints?.patterns?.[0];
    // buildPropertySchema は enum がある場合に type を省略する。
    const type =
      enumerations.length > 0
        ? null
        : attrDef.type === 'number' || attrDef.type === 'integer'
          ? attrDef.type
          : attrDef.type === 'boolean'
            ? 'boolean'
            : 'string';

    attributes.push({
      name,
      fixed: attrDef.fixed,
      type,
      enumerations,
      pattern: pattern === undefined ? null : new RegExp(pattern, 'u'),
      patternSource: pattern,
      minExclusive: constraints?.minExclusive ?? null,
      maxExclusive: constraints?.maxExclusive ?? null,
      minInclusive: constraints?.minInclusive ?? null,
      maxInclusive: constraints?.maxInclusive ?? null,
      minLength: constraints?.minLength ?? null,
    });
  }

  return (attrs) => validateAttributes(attrs, attributes, required, allowedNames);
}

/**
 * 属性オブジェクトを検証し、既存の Ajv エラー変換が扱う形式で返す。
 */
function validateAttributes(attrs, attributes, required, allowedNames) {
  const errors = [];

  // Ajv は required / additionalProperties を properties の制約より先に報告する。
  for (const name of required) {
    if (!Object.prototype.hasOwnProperty.call(attrs, name)) {
      errors.push({ keyword: 'required', instancePath: '', params: { missingProperty: name } });
    }
  }

  for (const name of Object.keys(attrs)) {
    if (!allowedNames.has(name)) {
      errors.push({
        keyword: 'additionalProperties',
        instancePath: '',
        params: { additionalProperty: name },
      });
    }
  }

  for (const attr of attributes) {
    if (!Object.prototype.hasOwnProperty.call(attrs, attr.name)) continue;

    const instancePath = `/${attr.name.replace(/~/g, '~0').replace(/\//g, '~1')}`;
    let value = attrs[attr.name];
    const pushError = (keyword, params) => errors.push({ keyword, instancePath, params });

    if (attr.fixed !== null && attr.fixed !== undefined) {
      if (value !== attr.fixed) pushError('const', { allowedValue: attr.fixed });
      continue;
    }

    if (attr.enumerations.length > 0 && !attr.enumerations.includes(value)) {
      pushError('enum', { allowedValues: attr.enumerations });
    }

    if (attr.type && !coerceAttributeType(attrs, attr.name, attr.type)) {
      pushError('type', { type: attr.type });
    }
    value = attrs[attr.name];

    // JSON Schema numeric keywords only apply to numbers. This guard matters for
    // enum properties, where the generated schema deliberately has no type.
    if (typeof value === 'number' && !Number.isNaN(value)) {
      if (attr.maxInclusive !== null && value > attr.maxInclusive) {
        pushError('maximum', { comparison: '<=', limit: attr.maxInclusive });
      }
      if (attr.minInclusive !== null && value < attr.minInclusive) {
        pushError('minimum', { comparison: '>=', limit: attr.minInclusive });
      }
      if (attr.maxExclusive !== null && value >= attr.maxExclusive) {
        pushError('exclusiveMaximum', { comparison: '<', limit: attr.maxExclusive });
      }
      if (attr.minExclusive !== null && value <= attr.minExclusive) {
        pushError('exclusiveMinimum', { comparison: '>', limit: attr.minExclusive });
      }
    }

    if (
      attr.minLength !== null &&
      typeof value === 'string' &&
      countCodePoints(value) < attr.minLength
    ) {
      pushError('minLength', { limit: attr.minLength });
    }

    if (attr.pattern && typeof value === 'string' && !attr.pattern.test(value)) {
      pushError('pattern', { pattern: attr.patternSource });
    }
  }

  return errors;
}

/**
 * Ajv の coerceTypes: true と同じく XML 属性の文字列を対応型へ変換する。
 */
function coerceAttributeType(attrs, name, type) {
  const value = attrs[name];
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') {
    if (value === 'true') {
      attrs[name] = true;
      return true;
    }
    if (value === 'false') {
      attrs[name] = false;
      return true;
    }
    return typeof value === 'boolean';
  }

  if (type === 'number' || type === 'integer') {
    if (typeof value === 'number') {
      return type === 'number' ? !Number.isNaN(value) : Number.isInteger(value);
    }

    // Ajv does not coerce the empty string. Whitespace-only strings coerce to 0.
    if (typeof value !== 'string' || value === '') return false;
    const number = Number(value);
    if (
      Number.isNaN(number) ||
      (type === 'integer' && number % 1 !== 0 && Number.isFinite(number))
    ) {
      return false;
    }
    attrs[name] = number;
    return true;
  }

  return true;
}

/** JSON Schema minLength counts Unicode code points rather than UTF-16 code units. */
function countCodePoints(value) {
  return Array.from(value).length;
}

// ============================================================
// 内部: XML 走査と検証
// ============================================================

/**
 * 要素を再帰的に検証
 */
function validateElement(element, version, ctx, issues) {
  const elementName = element.localName || element.nodeName.replace(/^.*:/, '');
  const elementId = element.getAttribute ? element.getAttribute('id') || '' : '';

  const validator = getAttributeValidator(elementName, ctx);

  if (validator) {
    const attrs = attrsToObject(element);
    const errors = validator(attrs);

    for (const err of errors) {
      const issue = convertAjvError(err, elementName, elementId, attrs, element);
      if (issue) issues.push(issue);
    }
  }

  // 子要素の親子関係を検証
  validateChildRelationships(element, elementName, elementId, version, issues);

  // 子要素を再帰的に検証
  for (let i = 0; i < element.childNodes.length; i++) {
    const child = element.childNodes[i];
    if (child.nodeType === 1) {
      validateElement(child, version, ctx, issues);
    }
  }
}

/**
 * 親要素の子要素構造を検証（許可要素・個数・choiceGroup排他性）
 */
function validateChildRelationships(element, elementName, elementId, version, issues) {
  const def = getElementDefinitionForVersion(version, elementName);
  if (!def || !def.children) return;

  const allowedChildren = def.children;
  const allowedNameSet = new Set(allowedChildren.map((c) => c.name));

  // 直接子要素の出現数と出現位置を収集
  const actualCounts = {};
  const childPositions = {};
  for (let i = 0; i < element.childNodes.length; i++) {
    const child = element.childNodes[i];
    if (child.nodeType !== 1) continue;
    const name = child.localName || child.nodeName.replace(/^.*:/, '');
    actualCounts[name] = (actualCounts[name] || 0) + 1;
    if (!childPositions[name]) {
      childPositions[name] = [];
    }
    childPositions[name].push(i);
  }

  // 未許可の子要素を検出
  for (const name of Object.keys(actualCounts)) {
    if (!allowedNameSet.has(name)) {
      issues.push({
        severity: SEVERITY.ERROR,
        category: CATEGORY.SCHEMA,
        elementType: elementName,
        elementId,
        element,
        message: `要素 '${elementName}' の子として '${name}' は許可されていません`,
        ...buildIssueLocation(element, null),
        repairable: false,
      });
    }
  }

  // choiceGroup の排他性・必須チェック
  const choiceGroups = new Map(); // groupId -> childDef[]
  for (const childDef of allowedChildren) {
    if (!childDef.choiceGroup) continue;
    if (!choiceGroups.has(childDef.choiceGroup)) choiceGroups.set(childDef.choiceGroup, []);
    choiceGroups.get(childDef.choiceGroup).push(childDef);
  }

  const checkSequenceOrder = (members, label) => {
    const orderedMembers = members
      .filter(
        (m) =>
          (actualCounts[m.name] || 0) > 0 &&
          m.sequenceOrder !== null &&
          m.sequenceOrder !== undefined,
      )
      .sort((a, b) => a.sequenceOrder - b.sequenceOrder);

    if (orderedMembers.length <= 1) return;

    for (let i = 1; i < orderedMembers.length; i += 1) {
      const prev = orderedMembers[i - 1];
      const curr = orderedMembers[i];
      const prevPositions = childPositions[prev.name] || [];
      const currPositions = childPositions[curr.name] || [];
      if (prevPositions.length === 0 || currPositions.length === 0) continue;

      const prevLastPosition = prevPositions[prevPositions.length - 1];
      const currFirstPosition = currPositions[0];
      if (prevLastPosition > currFirstPosition) {
        const scopeMessage = label ? ` (${label})` : '';
        issues.push({
          severity: SEVERITY.ERROR,
          category: CATEGORY.SCHEMA,
          elementType: elementName,
          elementId,
          message: `sequenceOrder violation${scopeMessage}: '${elementName}' should keep '${prev.name}' before '${curr.name}'`,
          ...buildIssueLocation(element, null),
          repairable: false,
        });
        break;
      }
    }
  };

  // choiceGroup未指定でもsequenceOrderが付与されている子要素は、
  // 親要素内で順序を検証する。
  const directSequenceMembers = allowedChildren.filter(
    (c) => c.choiceGroup === null && c.sequenceOrder !== null && c.sequenceOrder !== undefined,
  );
  checkSequenceOrder(directSequenceMembers, 'non-choice sequenceOrder');

  for (const [, members] of choiceGroups) {
    // sequenceGroup ごとにメンバーをグループ化（null = 直接の choice 枝）
    const seqGroups = new Map(); // sequenceGroupId -> childDef[]
    const directMembers = [];
    for (const m of members) {
      if (m.sequenceGroup) {
        if (!seqGroups.has(m.sequenceGroup)) seqGroups.set(m.sequenceGroup, []);
        seqGroups.get(m.sequenceGroup).push(m);
      } else {
        directMembers.push(m);
      }
    }

    // どの choice 枝が「選択された」か判定
    // sequenceGroup: グループ内の要素が1つでも存在すれば「選択済み」
    const presentSeqGroups = [];
    for (const [sgId, sgMembers] of seqGroups) {
      const hasAny = sgMembers.some((m) => (actualCounts[m.name] || 0) > 0);
      if (hasAny) presentSeqGroups.push({ sgId, sgMembers });
    }
    const presentDirectMembers = directMembers.filter((m) => (actualCounts[m.name] || 0) > 0);
    const selectedBranchCount = presentSeqGroups.length + presentDirectMembers.length;

    // 複数の choice 枝が選択されている → 排他性違反
    if (selectedBranchCount > 1) {
      const presentNames = [
        ...presentSeqGroups.flatMap(({ sgMembers }) =>
          sgMembers.map((m) => m.name).filter((n) => (actualCounts[n] || 0) > 0),
        ),
        ...presentDirectMembers.map((m) => m.name),
      ];
      issues.push({
        severity: SEVERITY.ERROR,
        category: CATEGORY.SCHEMA,
        elementType: elementName,
        elementId,
        element,
        message: `要素 '${elementName}' のchoiceグループ内で複数種類の子要素が混在しています: ${presentNames.join(', ')}（いずれか1種類のみ許可）`,
        ...buildIssueLocation(element, null),
        repairable: false,
      });
    }

    for (const { sgMembers, sgId } of presentSeqGroups) {
      checkSequenceOrder(sgMembers, `sequenceGroup '${sgId || 'default'}'`);
    }

    // choiceGroup 全体として必須か（いずれかのメンバーが minOccurs > 0）
    const groupRequired = members.some((m) => m.minOccurs > 0);
    if (groupRequired && selectedBranchCount === 0) {
      const choices = members.map((m) => m.name).join(' / ');
      issues.push({
        severity: SEVERITY.ERROR,
        category: CATEGORY.SCHEMA,
        elementType: elementName,
        elementId,
        element,
        message: `要素 '${elementName}' には必須の子要素がありません。次のいずれかが必要です: ${choices}`,
        ...buildIssueLocation(element, null),
        repairable: false,
      });
    }

    // 選択された枝の個数チェック
    // sequenceGroup が選択された場合: グループ内の各要素の個数を検証
    for (const { sgMembers } of presentSeqGroups) {
      for (const m of sgMembers) {
        const count = actualCounts[m.name] || 0;
        if (m.minOccurs > 0 && count < m.minOccurs) {
          issues.push({
            severity: SEVERITY.ERROR,
            category: CATEGORY.SCHEMA,
            elementType: elementName,
            elementId,
            message: `要素 '${elementName}' の子 '${m.name}' が ${count} 個ですが、${m.minOccurs} 個以上必要です`,
            ...buildIssueLocation(element, null),
            repairable: false,
          });
        }
        if (m.maxOccurs !== -1 && count > m.maxOccurs) {
          issues.push({
            severity: SEVERITY.ERROR,
            category: CATEGORY.SCHEMA,
            elementType: elementName,
            elementId,
            message: `要素 '${elementName}' の子 '${m.name}' が ${count} 個ありますが、最大 ${m.maxOccurs} 個までです`,
            ...buildIssueLocation(element, null),
            repairable: false,
          });
        }
      }
    }
    // 直接の choice 枝が選択された場合: 従来通りの個数チェック
    if (presentDirectMembers.length === 1) {
      const m = presentDirectMembers[0];
      const count = actualCounts[m.name] || 0;
      if (m.minOccurs > 0 && count < m.minOccurs) {
        issues.push({
          severity: SEVERITY.ERROR,
          category: CATEGORY.SCHEMA,
          elementType: elementName,
          elementId,
          message: `要素 '${elementName}' の子 '${m.name}' が ${count} 個ですが、${m.minOccurs} 個以上必要です`,
          ...buildIssueLocation(element, null),
          repairable: false,
        });
      }
      if (m.maxOccurs !== -1 && count > m.maxOccurs) {
        issues.push({
          severity: SEVERITY.ERROR,
          category: CATEGORY.SCHEMA,
          elementType: elementName,
          elementId,
          message: `要素 '${elementName}' の子 '${m.name}' が ${count} 個ありますが、最大 ${m.maxOccurs} 個までです`,
          ...buildIssueLocation(element, null),
          repairable: false,
        });
      }
    }
  }

  // choiceGroup 以外の sequenceOrder 定義がある場合の順序チェック
  const nonChoiceSequenceMembers = allowedChildren.filter((childDef) => !childDef.choiceGroup);
  checkSequenceOrder(nonChoiceSequenceMembers, 'direct children');

  // choiceGroup に属さない必須/個数制約チェック
  for (const childDef of allowedChildren) {
    if (childDef.choiceGroup) continue;
    const count = actualCounts[childDef.name] || 0;
    if (childDef.minOccurs > 0 && count < childDef.minOccurs) {
      issues.push({
        severity: SEVERITY.ERROR,
        category: CATEGORY.SCHEMA,
        elementType: elementName,
        elementId,
        element,
        message: `要素 '${elementName}' に必須の子要素 '${childDef.name}' がありません（${childDef.minOccurs} 個以上必要、現在 ${count} 個）`,
        ...buildIssueLocation(element, null),
        repairable: false,
      });
    }
    if (childDef.maxOccurs !== -1 && count > childDef.maxOccurs) {
      issues.push({
        severity: SEVERITY.ERROR,
        category: CATEGORY.SCHEMA,
        elementType: elementName,
        elementId,
        element,
        message: `要素 '${elementName}' の子 '${childDef.name}' が ${count} 個ありますが、最大 ${childDef.maxOccurs} 個までです`,
        ...buildIssueLocation(element, null),
        repairable: false,
      });
    }
  }
}

/**
 * XML 要素の属性を JSON オブジェクトに変換（xmlns:*, xsi:* は除外）
 */
function attrsToObject(element) {
  const obj = {};
  if (!element.attributes) return obj;

  for (let i = 0; i < element.attributes.length; i++) {
    const attr = element.attributes[i];
    const name = attr.localName || attr.name;
    const fullName = attr.name || name;

    if (fullName === 'xmlns' || fullName.startsWith('xmlns:')) continue;
    if (fullName.startsWith('xsi:')) continue;

    obj[name] = attr.value;
  }

  return obj;
}

/**
 * ajv エラーを ValidationIssue に変換
 */
function convertAjvError(err, elementName, elementId, attrs, element) {
  const { keyword, instancePath, params, message } = err;

  // instancePath: "/attrName" → attrName
  const attrName = instancePath ? instancePath.replace(/^\//, '') : null;
  const value = attrName ? attrs[attrName] : undefined;
  const makeIssue = (overrides = {}) => {
    const hasAttribute = Object.prototype.hasOwnProperty.call(overrides, 'attribute');
    const resolvedAttribute = hasAttribute ? overrides.attribute : attrName || undefined;
    const issue = {
      severity: SEVERITY.ERROR,
      category: CATEGORY.SCHEMA,
      elementType: elementName,
      elementId,
      element,
      ...buildIssueLocation(element, resolvedAttribute),
      ...overrides,
    };
    if (resolvedAttribute) {
      issue.attribute = resolvedAttribute;
    }
    return issue;
  };

  switch (keyword) {
    case 'required': {
      const missing = params.missingProperty;
      return makeIssue({
        message: `要素 '${elementName}' に必須属性 '${missing}' がありません`,
        attribute: missing,
        repairable: false,
      });
    }

    case 'additionalProperties': {
      const extra = params.additionalProperty;
      return makeIssue({
        message: `要素 '${elementName}' で属性 '${extra}' は宣言されていません`,
        attribute: extra,
        value: attrs[extra],
        repairable: false,
      });
    }

    case 'const': {
      return makeIssue({
        message: `要素 '${elementName}' の属性 '${attrName}' の値 '${value}' は固定値 '${params.allowedValue}' と一致しません`,
        value,
        expected: params.allowedValue,
        repairable: false,
      });
    }

    case 'enum': {
      const allowed = params.allowedValues ? params.allowedValues.join(', ') : '（定義参照）';
      return makeIssue({
        message: `要素 '${elementName}' の属性 '${attrName}' の値 '${value}' は許可されていません。期待値: ${allowed}`,
        value,
        expected: params.allowedValues,
        repairable: false,
      });
    }

    case 'type': {
      return makeIssue({
        message: `要素 '${elementName}' の属性 '${attrName}' の値 '${value}' は型 '${params.type}' ではありません`,
        value,
        repairable: false,
      });
    }

    case 'minimum':
    case 'maximum':
    case 'exclusiveMinimum':
    case 'exclusiveMaximum': {
      const comparison = params?.comparison;
      const limit = params?.limit;
      const numericConstraint =
        comparison && limit !== undefined ? `値 ${comparison} ${limit}` : keyword;
      return makeIssue({
        message: `要素 '${elementName}' の属性 '${attrName}' の値 '${value}' は数値制約（${numericConstraint}）に違反しています`,
        value,
        expected: comparison && limit !== undefined ? `${comparison} ${limit}` : undefined,
        repairable: false,
      });
    }

    case 'pattern': {
      return makeIssue({
        message: `要素 '${elementName}' の属性 '${attrName}' の値 '${value}' はパターン制約に一致しません`,
        value,
        repairable: false,
      });
    }

    case 'minLength': {
      return makeIssue({
        message: `要素 '${elementName}' の属性 '${attrName}' の値 '${value}' は最小文字数制約 '${params.limit}' を満たしていません`,
        value,
        repairable: false,
      });
    }

    default:
      if (message) {
        return makeIssue({
          message: `要素 '${elementName}' のスキーマエラー: ${message}`,
          attribute: attrName || undefined,
          repairable: false,
        });
      }
      return null;
  }
}

/**
 * 要素/属性の XPath 情報を生成する
 */
function buildIssueLocation(element, attributeName) {
  return buildBaseIssueLocation(element, attributeName, { useNameAnchor: true });
}
