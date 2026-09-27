/**
 * @fileoverview 生XMLビュー上の validation mark を一覧表示用descriptorへ変換する。
 */

import { classifyValidationIssue } from '../../common-stb/validation/issuePresentation.js';

const validationIssuesByMark = new WeakMap();

function normalizeCategoryLabel(label) {
  const categoryLabel = String(label || '')
    .trim()
    .toUpperCase();
  if (categoryLabel === 'MVD') return 'mvd';
  if (categoryLabel === 'XSD' || categoryLabel === 'SCHEMA') return 'schema';
  return (
    String(label || 'other')
      .trim()
      .toLowerCase() || 'other'
  );
}

/**
 * XML描画時に、markと元のValidationIssue配列を関連付ける。
 * titleはツールチップ表示用に件数を省略し得るため、一覧ではこちらを優先する。
 * @param {Element} mark
 * @param {Array<Object>} issues
 */
export function registerXmlValidationMarkIssues(mark, issues = []) {
  if (!mark || !Array.isArray(issues)) return;
  validationIssuesByMark.set(mark, [...issues]);
}

/**
 * mark.title に含まれる `[ERROR/XSD] message` 形式を全件取り出す。
 * スキーマtooltip等の補助行は無視する。レジストリ未登録mark向けのフォールバック。
 * @param {string} title
 * @returns {Array<{severity:string,category:string,message:string}>}
 */
function parseXmlValidationMarkTitle(title = '') {
  const lines = String(title).split(/\r?\n/);
  const issues = [];

  for (const line of lines) {
    const match = line.match(/^\[(ERROR|WARNING|INFO)\/([^\]]+)\]\s*(.*)$/i);
    if (!match) continue;
    issues.push({
      severity: match[1].trim().toLowerCase(),
      category: normalizeCategoryLabel(match[2]),
      message: match[3].trim(),
    });
  }

  if (issues.length > 0) return issues;

  return [
    {
      severity: null,
      category: 'other',
      message: lines.find((line) => line.trim())?.trim() || '',
    },
  ];
}

function findAttributeName(mark) {
  if (mark.classList.contains('xml-missing-attr')) {
    return mark.textContent.match(/@([^\s⟫]+)/)?.[1] || null;
  }

  const previous = mark.previousElementSibling;
  if (previous?.classList.contains('xml-attr-name')) return previous.textContent.trim() || null;
  return null;
}

function findElementType(mark) {
  const line = mark.closest('.xml-line');
  const tag = line?.querySelector('.xml-tag-name');
  return tag?.textContent?.trim() || '(要素不明)';
}

function findIdentityLabel(mark) {
  const lineText = mark.closest('.xml-line')?.textContent || '';
  const id = lineText.match(/\bid="([^"]+)"/)?.[1];
  const name = lineText.match(/\bname="([^"]+)"/)?.[1];
  const floor = lineText.match(/\bfloor="([^"]+)"/)?.[1];
  const parts = [];
  if (id) parts.push(`id=${id}`);
  if (name) parts.push(`name=${name}`);
  if (floor) parts.push(`floor=${floor}`);
  return parts.join(' / ');
}

/**
 * XML上の1つのmarkを、含まれる全issue分のdescriptorへ変換する。
 * 1つのmarkに複数issueが集約されている場合も件数・分類を失わない。
 * @param {Element} mark
 * @param {number} index XML上のmark位置インデックス
 * @returns {Object[]}
 */
export function describeXmlValidationMarks(mark, index = -1) {
  const registeredIssues = validationIssuesByMark.get(mark);
  const sourceIssues =
    registeredIssues && registeredIssues.length > 0
      ? registeredIssues
      : parseXmlValidationMarkTitle(mark?.title || '');
  const markAttribute = findAttributeName(mark);
  const missingAttribute = Boolean(mark?.classList?.contains('xml-missing-attr'));
  const markElementType = findElementType(mark);
  const identity = findIdentityLabel(mark);
  const fallbackSeverity = mark?.classList?.contains('xml-mark-error') ? 'error' : 'warning';

  return sourceIssues.map((source) => {
    const category = normalizeCategoryLabel(source?.category);
    const attribute = source?.attribute || markAttribute;
    const message = source?.message || '(詳細なし)';
    const elementType = source?.elementType || markElementType;
    const issue = { category, message, attribute };

    return {
      mark,
      index,
      kind: classifyValidationIssue(issue, { missingAttribute }),
      category,
      message,
      elementType,
      attribute,
      identity,
      severity: String(source?.severity || fallbackSeverity).toLowerCase(),
    };
  });
}

/**
 * 後方互換用。1つ目のdescriptorのみ返す。
 * @param {Element} mark
 * @param {number} index
 * @returns {Object}
 */
export function describeXmlValidationMark(mark, index = -1) {
  return describeXmlValidationMarks(mark, index)[0];
}
