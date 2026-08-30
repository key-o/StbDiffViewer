/**
 * @fileoverview XSDスキーマ検証モジュール（ブラウザ版）
 *
 * XSD解析済みスキーマに基づいて、STB XMLファイルの構文的整合性を検証する。
 * tools/stb-schema-checker/validator.js のロジックをブラウザ互換で実装。
 *
 * 検証項目:
 * - 未宣言属性の検出
 * - 必須属性の欠落チェック
 * - fixed値の一致チェック
 * - 数値ファセット制約（minExclusive, maxExclusive, minInclusive, maxInclusive）
 * - パターン制約
 * - minLength制約
 * - 列挙型制約
 * - 組み込み型検証（positiveInteger, boolean等）
 * - 予期しない要素の検出
 * - 必須子要素チェック（choiceグループ対応）
 */

import {
  getElementDefinitionForVersion,
  isVersionLoaded,
} from '../import/parser/xsdSchemaParser.js';
import { SEVERITY, CATEGORY } from './validationConstants.js';
import { validateAttributeValue } from './xsdAttributeValueValidator.js';

/**
 * XSDスキーマに基づいてSTB XMLドキュメントを検証
 *
 * @param {Document} xmlDoc - パース済みXMLドキュメント
 * @param {Object} options - オプション
 * @param {string} options.version - STBバージョン ('2.0.2' | '2.1.0')
 * @returns {Array<Object>} ValidationIssue配列
 */
export function validateXsdSchema(xmlDoc, options = {}) {
  const { version = '2.0.2' } = options;

  if (!xmlDoc || !xmlDoc.documentElement) {
    return [];
  }

  if (!isVersionLoaded(version)) {
    return [];
  }

  const issues = [];
  const root = xmlDoc.documentElement;

  // ルート要素から再帰的に検証
  validateElement(root, version, issues, null);

  return issues;
}

/**
 * 要素を再帰的に検証
 * @param {Element} element - XML要素
 * @param {string} version - STBバージョン
 * @param {Array} issues - エラー蓄積配列
 * @param {Object|null} parentDef - 親要素の定義
 */
function validateElement(element, version, issues, parentDef) {
  const elementName = element.localName || element.nodeName.replace(/^.*:/, '');

  // スキーマから要素定義を取得
  const elemDef = getElementDefinitionForVersion(version, elementName);

  if (!elemDef) {
    // 要素がスキーマで定義されていない場合
    if (parentDef) {
      // 親の子要素定義に含まれるか確認
      const isExpected =
        parentDef.children && parentDef.children.has && parentDef.children.has(elementName);

      if (!isExpected) {
        issues.push({
          severity: SEVERITY.ERROR,
          category: CATEGORY.SCHEMA,
          message: `要素 '${elementName}' はこのコンテキストで予期されていません（親要素: '${parentDef.name}'）`,
          elementType: elementName,
          elementId: element.getAttribute('id') || '',
          element,
          repairable: false,
        });
      }
    }
    // 子要素の検証は続行（定義があるものについて）
    validateChildElements(element, version, issues, null);
    return;
  }

  // 属性の検証
  validateAttributes(element, elementName, elemDef, version, issues);

  // 必須子要素のチェック
  validateRequiredChildren(element, elementName, elemDef, issues);

  // 子要素の再帰検証
  validateChildElements(element, version, issues, elemDef);
}

/**
 * 属性を検証
 * @param {Element} element - XML要素
 * @param {string} elementName - 要素名
 * @param {Object} elemDef - 要素定義
 * @param {string} version - STBバージョン
 * @param {Array} issues - エラー蓄積配列
 */
function validateAttributes(element, elementName, elemDef, version, issues) {
  const attrs = elemDef.attributes;
  if (!attrs) return;

  const elementId = element.getAttribute('id') || '';

  // 1. 必須属性チェック
  for (const [attrName, attrDef] of attrs) {
    if (attrDef.required) {
      const value = element.getAttribute(attrName);
      if (value === null || value === undefined) {
        issues.push({
          severity: SEVERITY.ERROR,
          category: CATEGORY.SCHEMA,
          message: `要素 '${elementName}' に必須属性 '${attrName}' がありません`,
          elementType: elementName,
          elementId,
          element,
          attribute: attrName,
          repairable: false,
        });
      }
    }
  }

  // 2. 各属性の検証（未宣言チェック + 値の検証）
  if (element.attributes) {
    for (let i = 0; i < element.attributes.length; i++) {
      const attr = element.attributes[i];
      const attrName = attr.localName || attr.name;

      // xmlns属性とxsi属性はスキップ
      if (attrName === 'xmlns' || attr.name.startsWith('xmlns:')) continue;
      if (attr.name.startsWith('xsi:')) continue;

      const attrDef = attrs.get(attrName);
      if (!attrDef) {
        // 未宣言属性
        issues.push({
          severity: SEVERITY.ERROR,
          category: CATEGORY.SCHEMA,
          message: `要素 '${elementName}' で属性 '${attrName}' は宣言されていません`,
          elementType: elementName,
          elementId,
          element,
          attribute: attrName,
          value: attr.value,
          repairable: false,
        });
        continue;
      }

      // 値のバリデーション
      const value = attr.value;
      if (value !== null && value !== undefined) {
        validateAttributeValue(
          elementName,
          elementId,
          element,
          attrName,
          value,
          attrDef,
          version,
          issues,
        );
      }
    }
  }
}

/**
 * 必須子要素の検証（choiceグループ対応）
 */
function validateRequiredChildren(element, elementName, elemDef, issues) {
  if (!elemDef.children || elemDef.children.size === 0) return;

  const elementId = element.getAttribute('id') || '';

  // choiceグループを特定
  const choiceGroups = new Map();

  for (const [, childDef] of elemDef.children) {
    if (childDef.choiceGroup) {
      if (!choiceGroups.has(childDef.choiceGroup)) {
        choiceGroups.set(childDef.choiceGroup, []);
      }
      choiceGroups.get(childDef.choiceGroup).push(childDef);
    }
  }

  // choiceグループの検証: グループ内のいずれか1つが存在すればOK
  // 注: STBスキーマではchoice自体がminOccurs="0"のケースが多いため、警告のみ
  // （今回はスキップ）

  // 通常の子要素（choiceグループに属さないもの）の必須チェック
  for (const [, childDef] of elemDef.children) {
    if (childDef.choiceGroup) continue;

    const minOccurs = parseInt(childDef.minOccurs || '1', 10);
    if (minOccurs <= 0) continue;

    const childElements = getDirectChildElementsByName(element, childDef.name);
    if (childElements.length < minOccurs) {
      issues.push({
        severity: SEVERITY.ERROR,
        category: CATEGORY.SCHEMA,
        message: `要素 '${elementName}' に必須の子要素 '${childDef.name}' がありません（最低 ${minOccurs} 個必要）`,
        elementType: elementName,
        elementId,
        element,
        expected: `>= ${minOccurs} occurrences of '${childDef.name}'`,
        repairable: false,
      });
    }
  }
}

/**
 * 子要素を再帰的に検証
 */
function validateChildElements(element, version, issues, parentDef) {
  for (let i = 0; i < element.childNodes.length; i++) {
    const child = element.childNodes[i];
    if (child.nodeType !== 1) continue;
    validateElement(child, version, issues, parentDef);
  }
}

/**
 * 直接の子要素を名前で取得
 */
function getDirectChildElementsByName(parent, name) {
  const results = [];
  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = parent.childNodes[i];
    if (child.nodeType !== 1) continue;
    const localName = child.localName || child.nodeName.replace(/^.*:/, '');
    if (localName === name) results.push(child);
  }
  return results;
}
