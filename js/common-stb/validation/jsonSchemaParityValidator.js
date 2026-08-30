/**
 * @fileoverview JSON Schema 検証に XSD 1.0 の構造差分を補完するバリデータ。
 *
 * 既存の Ajv ベース属性検証はそのまま利用し、XSD→JSON Schema 変換で
 * 情報が不足する以下を補完する。
 * - XML 名前空間
 * - 通常 xs:sequence の順序（sequenceOrder が未生成の場合は XSD 由来配列順を使用）
 * - choice 内 sequence に同名の任意子要素がある場合の枝判定
 * - ST-Bridge 2.0.2 の stb:monolist simple content
 */

import { validateJsonSchema as validateJsonSchemaCore } from './jsonSchemaValidatorCore.js';
import { getElementDefinitionForVersion } from '../import/parser/jsonSchemaLoader.js';
import { SEVERITY, CATEGORY } from './validationConstants.js';
import { buildIssueLocation as buildBaseIssueLocation } from './issueLocation.js';
import { validateStbNamespace, validateSimpleContent } from './xsdParityRules.js';

/**
 * XSD parity 補完付き JSON Schema 検証。
 * @param {Document} xmlDoc
 * @param {{version?: string}} options
 * @returns {Array<Object>}
 */
export function validateJsonSchema(xmlDoc, options = {}) {
  const { version = '2.0.2' } = options;
  if (!xmlDoc || !xmlDoc.documentElement) return [];

  const coreIssues = validateJsonSchemaCore(xmlDoc, options);

  // core の属性検証は維持し、子要素構造のエラーだけを parity 実装で置き換える。
  // choice 枝の共有要素による誤検出を残さないため、attribute を持たない
  // schema issue のうち要素定義が存在するものを構造 issue とみなして除外する。
  const issues = coreIssues.filter((issue) => !isCoreChildRelationshipIssue(issue, version));

  validateNamespace(xmlDoc.documentElement, issues);
  validateElementTree(xmlDoc.documentElement, version, issues);

  return dedupeIssues(issues);
}

function isCoreChildRelationshipIssue(issue, version) {
  if (!issue || issue.category !== CATEGORY.SCHEMA || issue.attribute) return false;
  if (!issue.elementType) return false;
  const def = getElementDefinitionForVersion(version, issue.elementType);
  return Boolean(def);
}

function validateNamespace(root, issues) {
  const result = validateStbNamespace(root);
  if (!result || result.valid) return;

  issues.push({
    severity: SEVERITY.ERROR,
    category: CATEGORY.SCHEMA,
    elementType: root.localName || root.nodeName || 'ST_BRIDGE',
    elementId: root.getAttribute?.('id') || '',
    element: root,
    message: `ST_BRIDGE の名前空間 '${result.actual || '（なし）'}' は XSD の targetNamespace '${result.expected}' と一致しません`,
    value: result.actual,
    expected: result.expected,
    ...buildIssueLocation(root, null),
    repairable: false,
  });
}

function validateElementTree(element, version, issues) {
  const elementName = element.localName || element.nodeName.replace(/^.*:/, '');
  const elementId = element.getAttribute ? element.getAttribute('id') || '' : '';

  validateChildRelationships(element, elementName, elementId, version, issues);
  validateElementSimpleContent(element, elementName, elementId, version, issues);

  for (let i = 0; i < element.childNodes.length; i += 1) {
    const child = element.childNodes[i];
    if (child.nodeType === 1) validateElementTree(child, version, issues);
  }
}

function validateElementSimpleContent(element, elementName, elementId, version, issues) {
  const result = validateSimpleContent(version, elementName, element.textContent);
  if (!result || result.valid) return;

  issues.push({
    severity: SEVERITY.ERROR,
    category: CATEGORY.SCHEMA,
    elementType: elementName,
    elementId,
    element,
    message: `要素 '${elementName}' の文字内容が XSD simple content 制約に違反しています: ${result.reason}`,
    value: element.textContent,
    expected: result.expected,
    ...buildIssueLocation(element, null),
    repairable: false,
  });
}

/**
 * 親要素の子要素構造を XSD の sequence / choice と同等になるよう検証する。
 */
function validateChildRelationships(element, elementName, elementId, version, issues) {
  const def = getElementDefinitionForVersion(version, elementName);
  if (!def || !Array.isArray(def.children)) return;

  const allowedChildren = def.children;
  const allowedNameSet = new Set(allowedChildren.map((c) => c.name));
  const actualCounts = {};
  const childPositions = {};

  for (let i = 0; i < element.childNodes.length; i += 1) {
    const child = element.childNodes[i];
    if (child.nodeType !== 1) continue;
    const name = child.localName || child.nodeName.replace(/^.*:/, '');
    actualCounts[name] = (actualCounts[name] || 0) + 1;
    if (!childPositions[name]) childPositions[name] = [];
    childPositions[name].push(i);
  }

  for (const name of Object.keys(actualCounts)) {
    if (!allowedNameSet.has(name)) {
      pushChildIssue(
        issues,
        element,
        elementName,
        elementId,
        `要素 '${elementName}' の子として '${name}' は許可されていません`,
      );
    }
  }

  const choiceGroups = new Map();
  for (const childDef of allowedChildren) {
    if (!childDef.choiceGroup) continue;
    if (!choiceGroups.has(childDef.choiceGroup)) choiceGroups.set(childDef.choiceGroup, []);
    choiceGroups.get(childDef.choiceGroup).push(childDef);
  }

  for (const [, members] of choiceGroups) {
    validateChoiceGroup(
      members,
      actualCounts,
      childPositions,
      issues,
      element,
      elementName,
      elementId,
    );
  }

  const nonChoiceMembers = allowedChildren.filter((childDef) => !childDef.choiceGroup);
  checkSequenceOrder(
    nonChoiceMembers,
    actualCounts,
    childPositions,
    issues,
    element,
    elementName,
    elementId,
    'direct sequence',
  );

  for (const childDef of nonChoiceMembers) {
    validateOccurrence(childDef, actualCounts, issues, element, elementName, elementId);
  }
}

function validateChoiceGroup(
  members,
  actualCounts,
  childPositions,
  issues,
  element,
  elementName,
  elementId,
) {
  const seqGroups = new Map();
  const directMembers = [];

  for (const member of members) {
    if (member.sequenceGroup) {
      if (!seqGroups.has(member.sequenceGroup)) seqGroups.set(member.sequenceGroup, []);
      seqGroups.get(member.sequenceGroup).push(member);
    } else {
      directMembers.push(member);
    }
  }

  const seqCandidates = [];
  for (const [sgId, sgMembers] of seqGroups) {
    const hasAny = sgMembers.some((m) => occurrence(actualCounts, m.name) > 0);
    if (!hasAny) continue;

    const requiredSatisfied = sgMembers.every(
      (m) => occurrence(actualCounts, m.name) >= minOccurs(m),
    );
    seqCandidates.push({ sgId, sgMembers, requiredSatisfied });
  }

  // 共有される任意要素だけで複数枝を「選択済み」にしない。
  // まず必須要素まで満たす枝を採用し、該当がなければ部分一致が1枝だけの時のみ
  // その枝を採用して minOccurs の詳細エラーを出す。
  const satisfiedSeqGroups = seqCandidates.filter((c) => c.requiredSatisfied);
  const selectedSeqGroups =
    satisfiedSeqGroups.length > 0
      ? satisfiedSeqGroups
      : seqCandidates.length === 1
        ? seqCandidates
        : [];

  const presentDirectMembers = directMembers.filter(
    (m) => occurrence(actualCounts, m.name) > 0,
  );
  const selectedBranchCount = selectedSeqGroups.length + presentDirectMembers.length;

  if (selectedBranchCount > 1) {
    const names = [
      ...selectedSeqGroups.flatMap(({ sgMembers }) =>
        sgMembers.map((m) => m.name).filter((name) => occurrence(actualCounts, name) > 0),
      ),
      ...presentDirectMembers.map((m) => m.name),
    ];
    pushChildIssue(
      issues,
      element,
      elementName,
      elementId,
      `要素 '${elementName}' のchoiceグループで複数の枝が同時に成立（混在）しています: ${[
        ...new Set(names),
      ].join(', ')}`,
    );
  }

  const groupRequired = members.some((m) => minOccurs(m) > 0);
  if (groupRequired && selectedBranchCount === 0) {
    const choices = [...new Set(members.map((m) => m.name))].join(' / ');
    pushChildIssue(
      issues,
      element,
      elementName,
      elementId,
      `要素 '${elementName}' には必須の子要素（choice枝）がありません。次のいずれかが必要です: ${choices}`,
    );
  }

  for (const { sgMembers, sgId } of selectedSeqGroups) {
    checkSequenceOrder(
      sgMembers,
      actualCounts,
      childPositions,
      issues,
      element,
      elementName,
      elementId,
      `choice sequence '${sgId}'`,
    );
    for (const member of sgMembers) {
      validateOccurrence(member, actualCounts, issues, element, elementName, elementId);
    }
  }

  if (presentDirectMembers.length === 1) {
    validateOccurrence(
      presentDirectMembers[0],
      actualCounts,
      issues,
      element,
      elementName,
      elementId,
    );
  }
}

function checkSequenceOrder(
  members,
  actualCounts,
  childPositions,
  issues,
  element,
  elementName,
  elementId,
  label,
) {
  const presentMembers = members.filter((m) => occurrence(actualCounts, m.name) > 0);
  if (presentMembers.length <= 1) return;

  const hasExplicitOrder = presentMembers.some(
    (m) => m.sequenceOrder !== null && m.sequenceOrder !== undefined,
  );
  const orderedMembers = hasExplicitOrder
    ? [...presentMembers].sort(
        (a, b) =>
          (a.sequenceOrder ?? Number.MAX_SAFE_INTEGER) -
          (b.sequenceOrder ?? Number.MAX_SAFE_INTEGER),
      )
    : presentMembers;

  for (let i = 1; i < orderedMembers.length; i += 1) {
    const prev = orderedMembers[i - 1];
    const curr = orderedMembers[i];
    const prevPositions = childPositions[prev.name] || [];
    const currPositions = childPositions[curr.name] || [];
    if (prevPositions.length === 0 || currPositions.length === 0) continue;

    if (prevPositions[prevPositions.length - 1] > currPositions[0]) {
      pushChildIssue(
        issues,
        element,
        elementName,
        elementId,
        `sequenceOrder violation (${label}): '${elementName}' では '${prev.name}' を '${curr.name}' より前に配置する必要があります`,
      );
      return;
    }
  }
}

function validateOccurrence(childDef, actualCounts, issues, element, elementName, elementId) {
  const count = occurrence(actualCounts, childDef.name);
  const min = minOccurs(childDef);
  const max = maxOccurs(childDef);

  if (count < min) {
    pushChildIssue(
      issues,
      element,
      elementName,
      elementId,
      `要素 '${elementName}' の子 '${childDef.name}' が ${count} 個ですが、${min} 個以上必要です`,
    );
  }
  if (max !== -1 && count > max) {
    pushChildIssue(
      issues,
      element,
      elementName,
      elementId,
      `要素 '${elementName}' の子 '${childDef.name}' が ${count} 個ありますが、最大 ${max} 個までです`,
    );
  }
}

function minOccurs(childDef) {
  const value = Number.parseInt(childDef.minOccurs ?? 1, 10);
  return Number.isNaN(value) ? 1 : value;
}

function maxOccurs(childDef) {
  if (childDef.maxOccurs === -1 || childDef.maxOccurs === 'unbounded') return -1;
  const value = Number.parseInt(childDef.maxOccurs ?? 1, 10);
  return Number.isNaN(value) ? 1 : value;
}

function occurrence(actualCounts, name) {
  return actualCounts[name] || 0;
}

function pushChildIssue(issues, element, elementName, elementId, message) {
  issues.push({
    severity: SEVERITY.ERROR,
    category: CATEGORY.SCHEMA,
    elementType: elementName,
    elementId,
    element,
    message,
    ...buildIssueLocation(element, null),
    repairable: false,
  });
}

function buildIssueLocation(element, attributeName) {
  return buildBaseIssueLocation(element, attributeName, { useNameAnchor: true });
}

function dedupeIssues(issues) {
  const seen = new Set();
  return issues.filter((issue) => {
    const key = [
      issue.category,
      issue.severity,
      issue.elementType,
      issue.elementId,
      issue.attribute || '',
      issue.message,
    ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}