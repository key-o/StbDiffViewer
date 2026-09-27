/**
 * @fileoverview バリデーション issue の表示分類を共通化する純粋関数群。
 *
 * ValidationIssue のカテゴリ・属性・メッセージから、UIで利用する粒度の
 * 「欠落属性 / 属性値 / 子要素 / choice / sequence / MVD」等へ分類する。
 * 生XMLビューやバリデーション一覧など、複数UIから同じ分類規則を再利用できる。
 */

import { CATEGORY } from './validationConstants.js';

const VALIDATION_ISSUE_KIND = Object.freeze({
  MISSING_ATTRIBUTE: 'missing-attribute',
  UNDECLARED_ATTRIBUTE: 'undeclared-attribute',
  ATTRIBUTE_VALUE: 'attribute-value',
  MISSING_CHILD: 'missing-child',
  CHOICE: 'choice',
  SEQUENCE: 'sequence',
  NAMESPACE: 'namespace',
  MVD: 'mvd',
  SCHEMA_ELEMENT: 'schema-element',
  OTHER: 'other',
});

const VALIDATION_ISSUE_KIND_META = Object.freeze({
  [VALIDATION_ISSUE_KIND.MISSING_ATTRIBUTE]: { label: '必須属性の欠落', order: 10 },
  [VALIDATION_ISSUE_KIND.UNDECLARED_ATTRIBUTE]: { label: '未定義属性', order: 20 },
  [VALIDATION_ISSUE_KIND.ATTRIBUTE_VALUE]: { label: '属性値・制約', order: 30 },
  [VALIDATION_ISSUE_KIND.MISSING_CHILD]: { label: '子要素・出現回数', order: 40 },
  [VALIDATION_ISSUE_KIND.CHOICE]: { label: 'choice制約', order: 50 },
  [VALIDATION_ISSUE_KIND.SEQUENCE]: { label: 'sequence順序', order: 60 },
  [VALIDATION_ISSUE_KIND.NAMESPACE]: { label: '名前空間', order: 70 },
  [VALIDATION_ISSUE_KIND.MVD]: { label: 'MVD要件', order: 80 },
  [VALIDATION_ISSUE_KIND.SCHEMA_ELEMENT]: { label: '要素スキーマ', order: 90 },
  [VALIDATION_ISSUE_KIND.OTHER]: { label: 'その他', order: 100 },
});

/**
 * ValidationIssue相当の情報をUI用の分類へ変換する。
 * @param {{message?:string, category?:string, attribute?:string|null}} issue
 * @param {{missingAttribute?:boolean}} [options]
 * @returns {string}
 */
export function classifyValidationIssue(issue = {}, options = {}) {
  const message = String(issue.message || '');
  const category = String(issue.category || '').toLowerCase();
  const hasAttribute = Boolean(issue.attribute);

  // MVDは欠落属性を含めてMVD要件としてまとめる。
  if (category === CATEGORY.MVD) return VALIDATION_ISSUE_KIND.MVD;
  if (options.missingAttribute) return VALIDATION_ISSUE_KIND.MISSING_ATTRIBUTE;

  if (hasAttribute) {
    if (/必須属性.+(ありません|未設定|欠落)/.test(message)) {
      return VALIDATION_ISSUE_KIND.MISSING_ATTRIBUTE;
    }
    if (/(宣言されていません|未定義属性)/.test(message)) {
      return VALIDATION_ISSUE_KIND.UNDECLARED_ATTRIBUTE;
    }
    return VALIDATION_ISSUE_KIND.ATTRIBUTE_VALUE;
  }

  if (/名前空間/.test(message)) return VALIDATION_ISSUE_KIND.NAMESPACE;
  if (/choice/i.test(message)) return VALIDATION_ISSUE_KIND.CHOICE;
  if (/sequence/i.test(message)) return VALIDATION_ISSUE_KIND.SEQUENCE;
  if (/(必須の子要素|子.+個.+必要|子.+最大|出現回数|子として.+許可されていません)/.test(message)) {
    return VALIDATION_ISSUE_KIND.MISSING_CHILD;
  }
  if (category === CATEGORY.SCHEMA) return VALIDATION_ISSUE_KIND.SCHEMA_ELEMENT;
  return VALIDATION_ISSUE_KIND.OTHER;
}

function getValidationIssueKindLabel(kind) {
  return VALIDATION_ISSUE_KIND_META[kind]?.label || VALIDATION_ISSUE_KIND_META.other.label;
}

function getValidationIssueKindOrder(kind) {
  return VALIDATION_ISSUE_KIND_META[kind]?.order ?? VALIDATION_ISSUE_KIND_META.other.order;
}

/**
 * 表示用descriptorを「種別 → 要素タイプ/属性」の2段階で集約する。
 * descriptor自体は保持するため、UI側は任意の項目へジャンプできる。
 * @param {Array<{kind:string, elementType?:string, attribute?:string|null}>} descriptors
 * @returns {Array<{kind:string,label:string,count:number,subgroups:Array}>}
 */
export function groupValidationIssueDescriptors(descriptors = []) {
  const kindMap = new Map();

  for (const descriptor of descriptors) {
    const kind = descriptor.kind || VALIDATION_ISSUE_KIND.OTHER;
    if (!kindMap.has(kind)) {
      kindMap.set(kind, {
        kind,
        label: getValidationIssueKindLabel(kind),
        count: 0,
        subgroupMap: new Map(),
      });
    }

    const group = kindMap.get(kind);
    group.count += 1;
    const elementType = descriptor.elementType || '(要素不明)';
    const attribute = descriptor.attribute || '';
    const subgroupKey = `${elementType}|${attribute}`;

    if (!group.subgroupMap.has(subgroupKey)) {
      group.subgroupMap.set(subgroupKey, {
        elementType,
        attribute: attribute || null,
        count: 0,
        items: [],
      });
    }

    const subgroup = group.subgroupMap.get(subgroupKey);
    subgroup.count += 1;
    subgroup.items.push(descriptor);
  }

  return [...kindMap.values()]
    .sort((a, b) => getValidationIssueKindOrder(a.kind) - getValidationIssueKindOrder(b.kind))
    .map(({ subgroupMap, ...group }) => ({
      ...group,
      subgroups: [...subgroupMap.values()].sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        const byType = a.elementType.localeCompare(b.elementType);
        if (byType !== 0) return byType;
        return String(a.attribute || '').localeCompare(String(b.attribute || ''));
      }),
    }));
}
