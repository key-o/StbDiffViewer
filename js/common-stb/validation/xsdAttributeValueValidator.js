/**
 * @fileoverview XSD属性値検証
 *
 * 属性のfixed値、simpleType、組み込み型、およびファセット制約を検証する。
 */

import { getSimpleTypeForVersion, stripNsPrefix } from '../import/parser/xsdSchemaParser.js';
import { SEVERITY, CATEGORY } from './validationConstants.js';

/**
 * 属性値を検証
 *
 * @param {string} elementName - 要素名
 * @param {string} elementId - 要素ID
 * @param {Element} element - 対象要素
 * @param {string} attrName - 属性名
 * @param {string} value - 属性値
 * @param {Object} attrDef - 属性定義
 * @param {string} version - STBバージョン
 * @param {Array} issues - 検出した問題の追加先
 */
export function validateAttributeValue(
  elementName,
  elementId,
  element,
  attrName,
  value,
  attrDef,
  version,
  issues,
) {
  // fixed値チェック
  if (attrDef.fixed !== null && attrDef.fixed !== undefined && value !== attrDef.fixed) {
    issues.push({
      severity: SEVERITY.ERROR,
      category: CATEGORY.SCHEMA,
      message: `要素 '${elementName}' の属性 '${attrName}' の値 '${value}' はfixed値 '${attrDef.fixed}' と一致しません`,
      elementType: elementName,
      elementId,
      element,
      attribute: attrName,
      value,
      expected: attrDef.fixed,
      repairable: false,
    });
    return;
  }

  // インライン制約がある場合
  if (attrDef.constraints) {
    validateConstraintFacets(
      elementName,
      elementId,
      element,
      attrName,
      value,
      attrDef.constraints,
      issues,
    );
    return;
  }

  // 型参照による検証
  if (attrDef.type) {
    const typeName = stripNsPrefix(attrDef.type);

    // 組み込み型
    if (attrDef.type.startsWith('xs:') || attrDef.type.startsWith('xsd:')) {
      validateBuiltinType(elementName, elementId, element, attrName, value, typeName, issues);
      return;
    }

    // カスタムsimpleType
    const simpleType = getSimpleTypeForVersion(version, typeName);
    if (simpleType) {
      validateSimpleTypeValue(
        elementName,
        elementId,
        element,
        attrName,
        value,
        simpleType,
        version,
        issues,
      );
    }
  }
}

/**
 * XSDファセット制約（列挙値・数値・minLength・パターン）に基づいて属性値を検証する
 *
 * simpleType 定義とインライン制約定義は同一のファセット構造を持つため、
 * validateAttributeValue（インライン制約）と validateSimpleTypeValue の双方から共通利用する。
 *
 * @param {string} elementName - 要素名
 * @param {string} elementId - 要素ID
 * @param {Element} element - 対象要素
 * @param {string} attrName - 属性名
 * @param {string} value - 属性値
 * @param {Object} def - ファセット定義（enumerations / baseType / minLength / patterns）
 * @param {Array} issues - 検出した問題の追加先
 * @returns {boolean} 以降の検証を打ち切る場合 true
 */
function validateConstraintFacets(elementName, elementId, element, attrName, value, def, issues) {
  // 列挙値チェック
  if (def.enumerations && def.enumerations.length > 0) {
    if (!def.enumerations.includes(value)) {
      issues.push({
        severity: SEVERITY.ERROR,
        category: CATEGORY.SCHEMA,
        message: `要素 '${elementName}' の属性 '${attrName}' の値 '${value}' は許可されていません。期待値: ${def.enumerations.join(', ')}`,
        elementType: elementName,
        elementId,
        element,
        attribute: attrName,
        value,
        expected: def.enumerations,
        repairable: false,
      });
      return true;
    }
  }

  // 数値制約チェック
  const baseType = def.baseType ? stripNsPrefix(def.baseType) : null;
  if (baseType && isNumericType(baseType)) {
    const num = parseFloat(value);
    if (isNaN(num)) {
      issues.push({
        severity: SEVERITY.ERROR,
        category: CATEGORY.SCHEMA,
        message: `要素 '${elementName}' の属性 '${attrName}' の値 '${value}' は有効な数値ではありません`,
        elementType: elementName,
        elementId,
        element,
        attribute: attrName,
        value,
        repairable: false,
      });
      return true;
    }

    checkNumericConstraints(elementName, elementId, element, attrName, value, num, def, issues);
  }

  // minLengthチェック
  if (def.minLength !== null && def.minLength !== undefined) {
    if (value.length < def.minLength) {
      issues.push({
        severity: SEVERITY.ERROR,
        category: CATEGORY.SCHEMA,
        message: `要素 '${elementName}' の属性 '${attrName}' の値 '${value}' はminLength制約 '${def.minLength}' を満たしていません`,
        elementType: elementName,
        elementId,
        element,
        attribute: attrName,
        value,
        repairable: false,
      });
    }
  }

  // パターンチェック
  if (def.patterns && def.patterns.length > 0) {
    const matched = def.patterns.some((p) => {
      try {
        return new RegExp(`^${p}$`).test(value);
      } catch {
        return true;
      }
    });
    if (!matched) {
      issues.push({
        severity: SEVERITY.ERROR,
        category: CATEGORY.SCHEMA,
        message: `要素 '${elementName}' の属性 '${attrName}' の値 '${value}' はパターン制約に一致しません`,
        elementType: elementName,
        elementId,
        element,
        attribute: attrName,
        value,
        repairable: false,
      });
    }
  }
  return false;
}

/**
 * 数値制約のチェック
 */
function checkNumericConstraints(
  elementName,
  elementId,
  element,
  attrName,
  value,
  num,
  constraints,
  issues,
) {
  if (constraints.minExclusive !== null && constraints.minExclusive !== undefined) {
    if (num <= constraints.minExclusive) {
      issues.push({
        severity: SEVERITY.ERROR,
        category: CATEGORY.SCHEMA,
        message: `要素 '${elementName}' の属性 '${attrName}' の値 '${value}' はminExclusiveファセット '${constraints.minExclusive}' に違反しています`,
        elementType: elementName,
        elementId,
        element,
        attribute: attrName,
        value,
        expected: `> ${constraints.minExclusive}`,
        repairable: false,
      });
    }
  }

  if (constraints.maxExclusive !== null && constraints.maxExclusive !== undefined) {
    if (num >= constraints.maxExclusive) {
      issues.push({
        severity: SEVERITY.ERROR,
        category: CATEGORY.SCHEMA,
        message: `要素 '${elementName}' の属性 '${attrName}' の値 '${value}' はmaxExclusiveファセット '${constraints.maxExclusive}' に違反しています`,
        elementType: elementName,
        elementId,
        element,
        attribute: attrName,
        value,
        expected: `< ${constraints.maxExclusive}`,
        repairable: false,
      });
    }
  }

  if (constraints.minInclusive !== null && constraints.minInclusive !== undefined) {
    if (num < constraints.minInclusive) {
      issues.push({
        severity: SEVERITY.ERROR,
        category: CATEGORY.SCHEMA,
        message: `要素 '${elementName}' の属性 '${attrName}' の値 '${value}' はminInclusiveファセット '${constraints.minInclusive}' に違反しています`,
        elementType: elementName,
        elementId,
        element,
        attribute: attrName,
        value,
        expected: `>= ${constraints.minInclusive}`,
        repairable: false,
      });
    }
  }

  if (constraints.maxInclusive !== null && constraints.maxInclusive !== undefined) {
    if (num > constraints.maxInclusive) {
      issues.push({
        severity: SEVERITY.ERROR,
        category: CATEGORY.SCHEMA,
        message: `要素 '${elementName}' の属性 '${attrName}' の値 '${value}' はmaxInclusiveファセット '${constraints.maxInclusive}' に違反しています`,
        elementType: elementName,
        elementId,
        element,
        attribute: attrName,
        value,
        expected: `<= ${constraints.maxInclusive}`,
        repairable: false,
      });
    }
  }
}

/**
 * simpleTypeの値を検証
 */
function validateSimpleTypeValue(
  elementName,
  elementId,
  element,
  attrName,
  value,
  simpleType,
  version,
  issues,
) {
  // union型の場合
  if (simpleType.baseType === 'union' && simpleType.memberTypes) {
    const isValid = simpleType.memberTypes.some((mt) => {
      const mtName = stripNsPrefix(mt);
      const mtDef = getSimpleTypeForVersion(version, mtName);
      if (mtDef) {
        const tempErrors = [];
        validateSimpleTypeValue(
          elementName,
          elementId,
          element,
          attrName,
          value,
          mtDef,
          version,
          tempErrors,
        );
        return tempErrors.length === 0;
      }
      // 組み込み型
      const tempErrors = [];
      validateBuiltinType(elementName, elementId, element, attrName, value, mtName, tempErrors);
      return tempErrors.length === 0;
    });
    if (!isValid) {
      issues.push({
        severity: SEVERITY.ERROR,
        category: CATEGORY.SCHEMA,
        message: `要素 '${elementName}' の属性 '${attrName}' の値 '${value}' はunion型のいずれのメンバー型にも適合しません`,
        elementType: elementName,
        elementId,
        element,
        attribute: attrName,
        value,
        repairable: false,
      });
    }
    return;
  }

  if (
    validateConstraintFacets(elementName, elementId, element, attrName, value, simpleType, issues)
  ) {
    return;
  }

  // 基底型の検証（simpleType を継承している場合は再帰的に検証）
  const baseTypeName = simpleType.baseType ? stripNsPrefix(simpleType.baseType) : null;

  if (baseTypeName && !isBuiltinType(baseTypeName)) {
    const baseST = getSimpleTypeForVersion(version, baseTypeName);
    if (baseST) {
      validateSimpleTypeValue(
        elementName,
        elementId,
        element,
        attrName,
        value,
        baseST,
        version,
        issues,
      );
    }
  }
}

/**
 * 組み込みXSD型の検証
 */
function validateBuiltinType(elementName, elementId, element, attrName, value, typeName, issues) {
  switch (typeName) {
    case 'positiveInteger':
      if (!/^\d+$/.test(value) || parseInt(value, 10) <= 0) {
        issues.push({
          severity: SEVERITY.ERROR,
          category: CATEGORY.SCHEMA,
          message: `要素 '${elementName}' の属性 '${attrName}' の値 '${value}' は有効なpositiveIntegerではありません`,
          elementType: elementName,
          elementId,
          element,
          attribute: attrName,
          value,
          repairable: false,
        });
      }
      break;

    case 'nonNegativeInteger':
      if (!/^\d+$/.test(value) || parseInt(value, 10) < 0) {
        issues.push({
          severity: SEVERITY.ERROR,
          category: CATEGORY.SCHEMA,
          message: `要素 '${elementName}' の属性 '${attrName}' の値 '${value}' は有効なnonNegativeIntegerではありません`,
          elementType: elementName,
          elementId,
          element,
          attribute: attrName,
          value,
          repairable: false,
        });
      }
      break;

    case 'integer':
    case 'int':
    case 'long':
    case 'short':
      if (!/^-?\d+$/.test(value)) {
        issues.push({
          severity: SEVERITY.ERROR,
          category: CATEGORY.SCHEMA,
          message: `要素 '${elementName}' の属性 '${attrName}' の値 '${value}' は有効な整数ではありません`,
          elementType: elementName,
          elementId,
          element,
          attribute: attrName,
          value,
          repairable: false,
        });
      }
      break;

    case 'double':
    case 'float':
    case 'decimal':
      if (isNaN(parseFloat(value))) {
        issues.push({
          severity: SEVERITY.ERROR,
          category: CATEGORY.SCHEMA,
          message: `要素 '${elementName}' の属性 '${attrName}' の値 '${value}' は有効な${typeName}ではありません`,
          elementType: elementName,
          elementId,
          element,
          attribute: attrName,
          value,
          repairable: false,
        });
      }
      break;

    case 'boolean':
      if (!['true', 'false', '1', '0'].includes(value)) {
        issues.push({
          severity: SEVERITY.ERROR,
          category: CATEGORY.SCHEMA,
          message: `要素 '${elementName}' の属性 '${attrName}' の値 '${value}' は有効なbooleanではありません`,
          elementType: elementName,
          elementId,
          element,
          attribute: attrName,
          value,
          repairable: false,
        });
      }
      break;

    // string, token, normalizedString, NMTOKEN, ID, IDREF, NCName, anyURI
    // - 文字列型は基本的にOK
  }
}

/**
 * 数値型かどうか判定
 */
function isNumericType(typeName) {
  return [
    'double',
    'float',
    'decimal',
    'integer',
    'int',
    'long',
    'short',
    'positiveInteger',
    'nonNegativeInteger',
    'nonPositiveInteger',
    'negativeInteger',
    'unsignedInt',
    'unsignedLong',
    'unsignedShort',
    'unsignedByte',
    'byte',
  ].includes(typeName);
}

/**
 * 組み込み型かどうか判定
 */
function isBuiltinType(typeName) {
  return [
    'string',
    'token',
    'normalizedString',
    'NMTOKEN',
    'ID',
    'IDREF',
    'NCName',
    'anyURI',
    'double',
    'float',
    'decimal',
    'integer',
    'int',
    'long',
    'short',
    'positiveInteger',
    'nonNegativeInteger',
    'nonPositiveInteger',
    'negativeInteger',
    'unsignedInt',
    'unsignedLong',
    'unsignedShort',
    'unsignedByte',
    'byte',
    'boolean',
  ].includes(typeName);
}
