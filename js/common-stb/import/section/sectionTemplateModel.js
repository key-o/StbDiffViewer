/**
 * @fileoverview スキーマ駆動 断面テンプレートモデル
 *
 * JSON Schema の要素定義（属性 + x-children）を辿り、
 * UI が雛形フォームを描画するための「テンプレート記述子」を構築する。
 *
 * x-children は XSD の choiceGroup に加え、choice 内 sequence を sequenceGroup として保持する。
 * 断面ビルダー側では sequenceGroup を「choice の1分岐」として扱う必要があるため、
 * 本モジュールで branch 単位へ正規化する。
 *
 * @module common-stb/import/section/sectionTemplateModel
 */

import { getElementAttributes, getElementChildren } from '../parser/jsonSchemaLoader.js';

/** maxOccurs の unbounded / -1 を大きな有限値として扱う */
export const UNBOUNDED_OCCURS = Number.MAX_SAFE_INTEGER;

/**
 * @typedef {Object} TemplateAttr
 * @property {string} name
 * @property {string} type
 * @property {boolean} required
 * @property {string|null} default
 * @property {string[]} enum
 * @property {Object|null} constraints
 */

/**
 * @typedef {Object} TemplateChildOption
 * @property {string} name - 分岐の代表要素名（sequence の場合は先頭要素）
 * @property {number} minOccurs
 * @property {number} maxOccurs
 * @property {Array<{name:string,minOccurs:number,maxOccurs:number,sequenceOrder:number|null}>} members
 *   choice 内 sequence の構成要素。単一分岐の場合も1要素を格納する。
 */

/**
 * @typedef {Object} TemplateChildGroup
 * @property {'choice'|'required'|'optional'} kind
 * @property {string|null} group
 * @property {TemplateChildOption[]} options
 */

/**
 * minOccurs/maxOccurs を数値へ正規化する。
 * JSON Schema 生成側では unbounded を -1 として保持する版もある。
 */
function toOccurs(value, fallback) {
  if (value === 'unbounded' || Number(value) === -1) return UNBOUNDED_OCCURS;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeMember(child) {
  return {
    name: child.name,
    minOccurs: toOccurs(child.minOccurs, 1),
    maxOccurs: toOccurs(child.maxOccurs, 1),
    sequenceOrder:
      child.sequenceOrder === null || child.sequenceOrder === undefined
        ? null
        : Number(child.sequenceOrder),
  };
}

/** 属性定義を UI 用記述子へ変換。fixed は XML 生成時に補完するため除外する。 */
function buildAttributes(elementName) {
  const attrMap = getElementAttributes(elementName);
  if (!attrMap) return [];

  const attrs = [];
  for (const [name, def] of attrMap) {
    if (def.fixed !== null && def.fixed !== undefined) continue;
    attrs.push({
      name,
      type: def.type || 'string',
      required: !!def.required,
      default: def.default ?? null,
      enum: def.constraints?.enumerations ? [...def.constraints.enumerations] : [],
      constraints: def.constraints ?? null,
    });
  }
  return attrs;
}

/**
 * 1つの choiceGroup を XSD の分岐単位へ復元する。
 *
 * - sequenceGroup なし: その要素単体が1分岐
 * - sequenceGroup あり: 同じ sequenceGroup の要素列全体が1分岐
 */
function buildChoiceOptions(children) {
  const branches = [];
  const sequenceBranches = new Map();

  for (const child of children) {
    const member = normalizeMember(child);
    if (child.sequenceGroup) {
      let branch = sequenceBranches.get(child.sequenceGroup);
      if (!branch) {
        branch = { sequenceGroup: child.sequenceGroup, members: [] };
        sequenceBranches.set(child.sequenceGroup, branch);
        branches.push(branch);
      }
      branch.members.push(member);
    } else {
      branches.push({ sequenceGroup: null, members: [member] });
    }
  }

  return branches.map((branch) => {
    const members = [...branch.members].sort((a, b) => {
      if (a.sequenceOrder == null && b.sequenceOrder == null) return 0;
      if (a.sequenceOrder == null) return 1;
      if (b.sequenceOrder == null) return -1;
      return a.sequenceOrder - b.sequenceOrder;
    });
    const primary = members.find((m) => m.minOccurs > 0) || members[0];
    return {
      name: primary.name,
      minOccurs: primary.minOccurs,
      maxOccurs: primary.maxOccurs,
      members,
    };
  });
}

/** 子要素定義を choice/required/optional のグループへ変換する。 */
function buildChildGroups(elementName) {
  const children = getElementChildren(elementName);
  if (!children || children.length === 0) return [];

  const groups = [];
  const choiceIndexes = new Map();

  for (const child of children) {
    if (child.choiceGroup) {
      if (!choiceIndexes.has(child.choiceGroup)) {
        choiceIndexes.set(child.choiceGroup, groups.length);
        groups.push({
          kind: 'choice',
          group: child.choiceGroup,
          options: [],
          _children: [],
        });
      }
      groups[choiceIndexes.get(child.choiceGroup)]._children.push(child);
      continue;
    }

    const member = normalizeMember(child);
    groups.push({
      kind: member.minOccurs >= 1 ? 'required' : 'optional',
      group: null,
      options: [{ ...member, members: [member] }],
    });
  }

  for (const group of groups) {
    if (group.kind !== 'choice') continue;
    group.options = buildChoiceOptions(group._children);
    delete group._children;
  }

  return groups;
}

/**
 * 指定要素のテンプレートノードを構築する。
 */
export function buildTemplateNode(elementName) {
  const attrMap = getElementAttributes(elementName);
  const children = getElementChildren(elementName);
  if (!attrMap && (!children || children.length === 0)) return null;

  return {
    elementName,
    attributes: buildAttributes(elementName),
    childGroups: buildChildGroups(elementName),
  };
}

/** 葉要素（子要素を持たない）かどうかを返す。 */
export function isLeafElement(elementName) {
  const children = getElementChildren(elementName);
  return !children || children.length === 0;
}

function countChildren(children) {
  const counts = new Map();
  for (const child of children || []) {
    const name = child?.elementName;
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

function memberCountValid(member, counts) {
  const count = counts.get(member.name) || 0;
  return count >= member.minOccurs && count <= member.maxOccurs;
}

/**
 * choice のいずれかの分岐が「子要素0個」で成立するかを返す。
 * 例: S柱の柱脚 choice は Product/Conventional の双方が minOccurs=0 のため柱脚なしが正当。
 */
export function choiceAllowsEmpty(group) {
  return !!group?.options?.some((option) =>
    (option.members || [option]).every((member) => member.minOccurs === 0),
  );
}

/**
 * choice 分岐として成立する option を探す。
 * 空の子構成は choiceAllowsEmpty() で別途扱うため、ここでは一意に分岐を特定できる場合のみ返す。
 */
export function findMatchingChoiceOption(group, childStates) {
  if (!group || group.kind !== 'choice') return null;
  const counts = countChildren(childStates);
  const groupNames = new Set(
    group.options.flatMap((option) => (option.members || [option]).map((member) => member.name)),
  );

  const candidates = group.options.filter((option) => {
    const members = option.members || [option];
    const memberNames = new Set(members.map((member) => member.name));

    for (const name of groupNames) {
      if (!memberNames.has(name) && (counts.get(name) || 0) > 0) return false;
    }
    return members.every((member) => memberCountValid(member, counts));
  });

  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * formState の子要素構成を XSD由来テンプレートに照らして検証する。
 * 属性値は jsonSchemaLoader.validateElement 側で検証するため、ここでは compositor/cardinality/order を扱う。
 */
export function validateTemplateTree(formState) {
  const errors = [];
  if (!formState?.elementName) return [{ element: '', error: 'elementName がありません' }];

  const node = buildTemplateNode(formState.elementName);
  if (!node) return [{ element: formState.elementName, error: 'スキーマに未定義の要素です' }];

  const children = formState.children || [];
  const counts = countChildren(children);
  const knownNames = new Set();
  const expectedNames = [];

  for (const group of node.childGroups) {
    if (group.kind === 'choice') {
      const groupNames = new Set();
      for (const option of group.options) {
        for (const member of option.members || [option]) {
          knownNames.add(member.name);
          groupNames.add(member.name);
        }
      }

      const groupChildren = children.filter((child) => groupNames.has(child.elementName));
      if (groupChildren.length === 0 && choiceAllowsEmpty(group)) {
        continue;
      }

      const selected = findMatchingChoiceOption(group, groupChildren);
      if (!selected) {
        errors.push({ element: formState.elementName, error: 'choice の子要素構成がXSD定義と一致しません' });
        continue;
      }
      for (const member of selected.members || [selected]) {
        const count = counts.get(member.name) || 0;
        for (let i = 0; i < count; i += 1) expectedNames.push(member.name);
      }
      continue;
    }

    const member = group.options[0];
    knownNames.add(member.name);
    const count = counts.get(member.name) || 0;
    if (count < member.minOccurs || count > member.maxOccurs) {
      errors.push({
        element: formState.elementName,
        error: `${member.name} の個数 ${count} が ${member.minOccurs}..${member.maxOccurs === UNBOUNDED_OCCURS ? 'unbounded' : member.maxOccurs} の範囲外です`,
      });
    }
    for (let i = 0; i < count; i += 1) expectedNames.push(member.name);
  }

  for (const child of children) {
    if (!knownNames.has(child.elementName)) {
      errors.push({
        element: formState.elementName,
        error: `${child.elementName} は許可された子要素ではありません`,
      });
    }
  }

  const actualNames = children.filter((child) => knownNames.has(child.elementName)).map((child) => child.elementName);
  if (errors.length === 0 && actualNames.join('\u0000') !== expectedNames.join('\u0000')) {
    errors.push({ element: formState.elementName, error: '子要素の順序がXSDの sequence 定義と一致しません' });
  }

  for (const child of children) errors.push(...validateTemplateTree(child));
  return errors;
}
