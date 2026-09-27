/**
 * @fileoverview XSD/JSON Schema 定義をUI表示向けに整理する共通ヘルパー。
 *
 * スキーマローダー固有の取得処理とは分離し、要素定義・属性定義オブジェクトから
 * 「必須/任意/choice/固定値/列挙」等の表示メタデータを組み立てる。
 */

/**
 * XML 名前空間宣言・XSI属性かを判定する。
 * @param {string} attributeName
 * @returns {boolean}
 */
function isXmlNamespaceAttribute(attributeName) {
  const name = String(attributeName || '');
  return name === 'xmlns' || name.startsWith('xmlns:') || name.startsWith('xsi:');
}

/**
 * 要素定義から、XML上に存在しない必須属性名を返す。
 * @param {{attributes?: Map<string, Object>}|null} elementDef
 * @param {Iterable<string>} presentAttributeNames
 * @returns {string[]}
 */
export function getMissingRequiredAttributeNames(elementDef, presentAttributeNames = []) {
  if (!elementDef?.attributes) return [];

  const present = new Set(Array.from(presentAttributeNames, (name) => String(name)));
  const missing = [];
  for (const [name, attrInfo] of elementDef.attributes) {
    if (attrInfo?.required && !present.has(name)) missing.push(name);
  }
  return missing;
}

/**
 * 属性のXSD上の役割を返す。
 * required/optional を基礎に、fixed/enum は modifiers として併記する。
 * @param {Object|null} attrInfo
 * @param {string} attributeName
 * @returns {{role:'required'|'optional'|'namespace'|'unknown', modifiers:string[]}}
 */
export function getAttributeSchemaPresentation(attrInfo, attributeName) {
  if (isXmlNamespaceAttribute(attributeName)) {
    return { role: 'namespace', modifiers: [] };
  }
  if (!attrInfo) {
    return { role: 'unknown', modifiers: [] };
  }

  const modifiers = [];
  if (attrInfo.fixed !== null && attrInfo.fixed !== undefined) modifiers.push('fixed');
  if (attrInfo.constraints?.enumerations?.length > 0) modifiers.push('enum');

  return {
    role: attrInfo.required ? 'required' : 'optional',
    modifiers,
  };
}

/**
 * 親要素定義から、子要素の出現上の役割を返す。
 * choice配下は個々を「必須」と断定せず choice として扱う。
 * @param {{children?: Array<Object>}|null} parentDef
 * @param {string} childName
 * @returns {'required'|'optional'|'choice'|'unknown'}
 */
export function getChildElementSchemaRole(parentDef, childName) {
  if (!parentDef?.children || !Array.isArray(parentDef.children)) return 'unknown';
  const matches = parentDef.children.filter((child) => child?.name === childName);
  if (matches.length === 0) return 'unknown';
  if (matches.some((child) => child.choiceGroup)) return 'choice';
  return matches.some((child) => Number(child.minOccurs ?? 1) > 0) ? 'required' : 'optional';
}

/**
 * 属性定義をツールチップ用の短い説明に整形する。
 * @param {Object} params
 * @param {string} params.elementName
 * @param {string} params.attributeName
 * @param {Object|null} params.attrInfo
 * @param {string} params.version
 * @returns {string}
 */
export function formatAttributeSchemaTitle({ elementName, attributeName, attrInfo, version }) {
  if (isXmlNamespaceAttribute(attributeName)) {
    return `XML名前空間属性: ${attributeName}`;
  }
  if (!attrInfo) {
    return `XSD未定義属性: <${elementName}> @${attributeName} (version: ${version})`;
  }

  const lines = [
    `<${elementName}> @${attributeName}`,
    `XSD: ${attrInfo.required ? '必須属性' : '任意属性'}`,
  ];

  if (attrInfo.type) lines.push(`型: ${attrInfo.type}`);
  if (attrInfo.fixed !== null && attrInfo.fixed !== undefined) {
    lines.push(`固定値: ${attrInfo.fixed}`);
  }
  const enums = attrInfo.constraints?.enumerations || [];
  if (enums.length > 0) lines.push(`候補: ${enums.join(', ')}`);
  if (attrInfo.default !== null && attrInfo.default !== undefined) {
    lines.push(`既定値: ${attrInfo.default}`);
  }
  if (attrInfo.documentation) lines.push(attrInfo.documentation);

  return lines.join('\n');
}
