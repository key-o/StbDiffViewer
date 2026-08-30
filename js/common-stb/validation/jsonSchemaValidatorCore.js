/**
 * @fileoverview JSON Schema 検証モジュール（ブラウザ版）
 *
 * JSON Schema と ajv を使って STB XML ファイルを検証する。
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

import Ajv from 'ajv';
import {
  getElementDefinitionForVersion,
  isVersionLoaded,
} from '../import/parser/jsonSchemaLoader.js';
import { SEVERITY, CATEGORY } from './validationConstants.js';
import { buildIssueLocation as buildBaseIssueLocation } from './issueLocation.js';

// ajv インスタンスのキャッシュ（バージョン別）
const ajvCache = new Map(); // version -> { ajv, validatorCache }

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

  const ctx = getAjvContext(version);
  const issues = [];

  validateElement(xmlDoc.documentElement, version, ctx, issues);

  return issues;
}

// ============================================================
// 内部: ajv コンテキスト管理
// ============================================================

/**
 * バージョン別 ajv コンテキストを取得（キャッシュ）
 */
function getAjvContext(version) {
  if (ajvCache.has(version)) return ajvCache.get(version);

  const ajv = new Ajv({
    allErrors: true,
    coerceTypes: true, // XML 属性値は全て文字列 → 型変換
    strict: false, // 未知キーワードを無視
  });

  const ctx = { ajv, validatorCache: new Map() };
  ajvCache.set(version, ctx);
  return ctx;
}

/**
 * 要素名に対応する ajv 検証関数を取得（キャッシュ）
 */
function getValidator(elementName, version, ctx) {
  const { ajv, validatorCache } = ctx;
  if (validatorCache.has(elementName)) return validatorCache.get(elementName);

  const def = getElementDefinitionForVersion(version, elementName);
  if (!def) {
    validatorCache.set(elementName, null);
    return null;
  }

  // JSON Schema オブジェクトを構築
  const schema = buildElementSchema(def);

  try {
    const validator = ajv.compile(schema);
    validatorCache.set(elementName, validator);
    return validator;
  } catch {
    validatorCache.set(elementName, null);
    return null;
  }
}

/**
 * 要素定義から ajv 用の JSON Schema を構築
 */
function buildElementSchema(def) {
  const properties = {};
  const required = [];

  for (const [attrName, attrDef] of def.attributes) {
    properties[attrName] = buildPropertySchema(attrDef);
    if (attrDef.required) required.push(attrName);
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
    additionalProperties: false,
  };
}

/**
 * attrDef から JSON Schema プロパティを構築
 */
function buildPropertySchema(attrDef) {
  const schema = {};

  if (attrDef.fixed !== null && attrDef.fixed !== undefined) {
    schema.const = attrDef.fixed;
    return schema;
  }

  const type = attrDef.type;
  if (type === 'number' || type === 'integer') {
    schema.type = type;
  } else if (type === 'boolean') {
    schema.type = 'boolean';
  } else {
    schema.type = 'string';
  }

  const c = attrDef.constraints;
  if (c) {
    if (c.enumerations.length > 0) {
      schema.enum = c.enumerations;
      delete schema.type;
    }
    if (c.patterns.length > 0) schema.pattern = c.patterns[0];
    if (c.minExclusive !== null) schema.exclusiveMinimum = c.minExclusive;
    if (c.maxExclusive !== null) schema.exclusiveMaximum = c.maxExclusive;
    if (c.minInclusive !== null) schema.minimum = c.minInclusive;
    if (c.maxInclusive !== null) schema.maximum = c.maxInclusive;
    if (c.minLength !== null) schema.minLength = c.minLength;
  }

  return schema;
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

  const validator = getValidator(elementName, version, ctx);

  if (validator) {
    const attrs = attrsToObject(element);
    const valid = validator(attrs);

    if (!valid && validator.errors) {
      for (const err of validator.errors) {
        const issue = convertAjvError(err, elementName, elementId, attrs, element);
        if (issue) issues.push(issue);
      }
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
