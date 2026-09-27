/**
 * @fileoverview 複数 semantic selection の属性を1 transactionで更新する Phase 5 batch editor。
 *
 * UI の Object3D transform を直接変更せず、各対象を ST-Bridge semantic Command へ解決する。
 * Section reference / member offset / Node座標を含め、単体 Property edit と同じ Command 種別を使い、
 * validation failure 時は transaction 全体を rollback する。
 */

import { createChangeSectionCommand } from '../../../../app/editing/changeSectionCommand.js';
import {
  findElementByTagAndId,
  resolveElementTagName,
} from '../../../../app/editing/attributeCommandUtils.js';
import editingSession from '../../../../app/editing/editingSession.js';
import { createSetAttributeCommand } from '../../../../app/editing/setAttributeCommand.js';
import { createSetMemberOffsetCommand } from '../../../../app/editing/setMemberOffsetCommand.js';
import {
  captureWorkingValidationBaseline,
  createIncrementalWorkingValidator,
} from '../../../../app/editing/workingEditValidation.js';

const SECTION_REFERENCE_ATTRIBUTES = new Set(['id_section', 'id_section_FD', 'id_section_WR']);
const CHANGE_SECTION_ELEMENT_TYPES = new Set([
  'Column',
  'Post',
  'Girder',
  'Beam',
  'Brace',
  'Slab',
  'Wall',
  'ShearWall',
  'Footing',
  'StripFooting',
  'Pile',
  'FoundationColumn',
  'Parapet',
]);
const MEMBER_OFFSET_ELEMENT_TYPES = new Set([
  'Column',
  'Post',
  'Girder',
  'Beam',
  'Brace',
  'Footing',
  'StripFooting',
  'Pile',
  'FoundationColumn',
  'Parapet',
]);

function isModelBOnly(selection) {
  const source = String(selection?.modelSource ?? '')
    .trim()
    .toLowerCase();
  return source === 'b' || source === 'onlyb';
}

function normalizeSelections(selections) {
  if (!Array.isArray(selections) || selections.length < 2) {
    throw new Error('一括属性編集には2件以上の選択要素が必要です。');
  }

  const result = [];
  const seen = new Set();
  for (const selection of selections) {
    if (isModelBOnly(selection)) {
      throw new Error('Model B のみの選択要素は Working Document 一括編集の対象にできません。');
    }
    if (selection?.subType || selection?.subId) {
      throw new Error('sub-selection を含む一括属性編集は未対応です。');
    }
    const elementType = String(selection?.elementType ?? '').trim();
    const elementId = String(selection?.elementId ?? '').trim();
    if (!elementType || !elementId) {
      throw new Error('一括属性編集の selection identity に elementType / elementId が必要です。');
    }
    const key = `${elementType}:${elementId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ elementType, elementId, modelSource: selection?.modelSource ?? null });
  }

  if (result.length < 2) {
    throw new Error('一括属性編集には重複しない2件以上の選択要素が必要です。');
  }
  return result;
}

function isBatchEditableAttribute(attributeName) {
  const name = String(attributeName || '');
  if (!name) return false;
  if (name === 'id' || name === 'guid' || name === 'kind_structure' || name === 'kind_wall') {
    return false;
  }
  if (name === 'id_member' || name === 'kind_member') return false;
  if (/^id_node(?:_|$)/.test(name)) return false;
  if (/^joint(?:_|$)/.test(name) || /^kind_joint(?:_|$)/.test(name)) return false;
  if (name.startsWith('id_') && !SECTION_REFERENCE_ATTRIBUTES.has(name)) return false;
  return true;
}

function resolveTargets(document, selections) {
  return normalizeSelections(selections).map((selection) => {
    const tagName = resolveElementTagName(selection.elementType);
    if (!tagName) {
      throw new Error(`一括属性編集対象の elementType が不正です: ${selection.elementType}`);
    }
    const element = findElementByTagAndId(document, tagName, selection.elementId);
    if (!element) {
      throw new Error(`${tagName}#${selection.elementId} が Working Document に見つかりません。`);
    }
    return { ...selection, tagName, element };
  });
}

function commonAttributeNames(targets) {
  let common = null;
  for (const target of targets) {
    const current = new Set(
      Array.from(target.element.attributes || [])
        .map((attribute) => attribute.name)
        .filter(isBatchEditableAttribute),
    );
    if (common === null) {
      common = current;
      continue;
    }
    common = new Set([...common].filter((name) => current.has(name)));
  }
  return [...(common || [])].sort((a, b) => a.localeCompare(b));
}

function createSemanticPropertyCommand(document, target, attributeName, nextValue) {
  if (
    SECTION_REFERENCE_ATTRIBUTES.has(attributeName) &&
    CHANGE_SECTION_ELEMENT_TYPES.has(target.elementType)
  ) {
    return createChangeSectionCommand(document, target.elementType, target.elementId, nextValue, {
      attributeName,
    });
  }

  if (MEMBER_OFFSET_ELEMENT_TYPES.has(target.elementType) && /^offset(?:_|$)/.test(attributeName)) {
    return createSetMemberOffsetCommand(document, target.elementType, target.elementId, {
      [attributeName]: nextValue,
    });
  }

  return createSetAttributeCommand(
    document,
    target.elementType,
    target.elementId,
    attributeName,
    nextValue,
  );
}

/**
 * 現在の Working Document に対する batch edit 対象を検査する。
 * @param {Array<Object>} selections semantic selection identities
 * @returns {{targets:Array<Object>,commonAttributes:string[],valuesByAttribute:Map<string,string[]>}}
 */
export function inspectBatchPropertyTargets(selections) {
  if (editingSession.getState()?.active !== true) {
    throw new Error('一括属性編集には Working Session が必要です。');
  }
  const document = editingSession.getWorkingDocument();
  if (!document) throw new Error('Working Document がありません。');

  const targets = resolveTargets(document, selections);
  const commonAttributes = commonAttributeNames(targets);
  const valuesByAttribute = new Map();
  for (const name of commonAttributes) {
    valuesByAttribute.set(
      name,
      targets.map((target) => target.element.getAttribute(name)),
    );
  }
  return { targets, commonAttributes, valuesByAttribute };
}

/**
 * 同一属性を複数 selection へ atomic に適用する。
 * @param {Array<Object>} selections semantic selection identities
 * @param {string} attributeName
 * @param {string|number|null} nextValue
 * @param {{label?:string,reason?:string}} [options]
 */
export function applyBatchPropertyEdit(selections, attributeName, nextValue, options = {}) {
  const document = editingSession.getWorkingDocument();
  if (!document || editingSession.getState()?.active !== true) {
    throw new Error('一括属性編集には Working Session が必要です。');
  }

  const { targets, commonAttributes } = inspectBatchPropertyTargets(selections);
  const name = String(attributeName || '').trim();
  if (!name || !commonAttributes.includes(name)) {
    throw new Error(`選択要素すべてに共通する編集可能属性ではありません: ${name || '(empty)'}`);
  }

  const commands = targets
    .map((target) => createSemanticPropertyCommand(document, target, name, nextValue))
    .filter((command) => command?.isNoop !== true);

  if (commands.length === 0) {
    return {
      changed: false,
      revision: editingSession.getState().workingRevision,
      affectedElements: [],
      targetCount: targets.length,
    };
  }

  const baseline = captureWorkingValidationBaseline(document);
  const validate = createIncrementalWorkingValidator(baseline);
  const result = editingSession.runTransaction(commands, {
    reason: options.reason || 'batchPropertyEdit',
    label: options.label || `${targets.length}要素の ${name} を一括変更`,
    validate,
  });
  return { ...result, targetCount: targets.length, attributeName: name };
}
