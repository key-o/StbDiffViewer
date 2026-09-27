/**
 * @fileoverview 属性値編集（ParameterEditor モーダル・ライブプレビュー・prompt フォールバック）
 *
 * 属性値の編集フローを担当する。Working Session 有効時は ST-Bridge semantic Command へ
 * 確定処理をルーティングし、source document へは fallback しない。旧セッション未開始時のみ
 * 従来の documentA mutation 経路を維持する。
 */

import { createLogger } from '../../../../utils/logger.js';
import {
  isSchemaLoaded,
  getAttributeInfo,
  validateAttributeValue,
} from '../../../../common-stb/import/parser/jsonSchemaLoader.js';
import { eventBus, EditEvents } from '../../../../data/events/index.js';
import { getParameterEditor, getSuggestionEngine } from '../ElementInfoProviders.js';
import { showError } from '../../../common/toast.js';
import editingSession from '../../../../app/editing/editingSession.js';
import { resolveElementTagName } from '../../../../app/editing/attributeCommandUtils.js';
import {
  captureWorkingValidationBaseline,
  createIncrementalWorkingValidator,
} from '../../../../app/editing/workingEditValidation.js';
import { applyAttributeEditToDocument } from './editAppliers.js';
import { buildIdentityEditConfig, handleIdRenumber } from './idRenumber.js';
import { updateEditingSummary } from './editHistory.js';
import {
  getModifications,
  getCurrentEditingElement,
  redisplayCurrentEditingElement,
} from './editState.js';

const log = createLogger('viewer:edit-mode');

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

function isWorkingSessionActive() {
  return editingSession.getState()?.active === true;
}

function createWorkingValidationGate() {
  const workingDocument = editingSession.getWorkingDocument();
  if (!workingDocument) {
    throw new Error('Working Document がありません。');
  }
  const baseline = captureWorkingValidationBaseline(workingDocument);
  return createIncrementalWorkingValidator(baseline);
}

export function commitWorkingAttributeEdit(
  elementType,
  elementId,
  attributeName,
  newValue,
  editPath,
) {
  const validate = createWorkingValidationGate();

  if (attributeName === 'id' && !editPath) {
    return editingSession.renumberId(elementType, elementId, newValue, { validate });
  }

  if (
    !editPath &&
    SECTION_REFERENCE_ATTRIBUTES.has(attributeName) &&
    CHANGE_SECTION_ELEMENT_TYPES.has(elementType)
  ) {
    return editingSession.changeSection(elementType, elementId, newValue, {
      attributeName,
      validate,
    });
  }

  if (
    !editPath &&
    MEMBER_OFFSET_ELEMENT_TYPES.has(elementType) &&
    /^offset(?:_|$)/.test(attributeName)
  ) {
    return editingSession.setMemberOffset(
      elementType,
      elementId,
      { [attributeName]: newValue },
      { validate },
    );
  }

  return editingSession.setAttribute(elementType, elementId, attributeName, newValue, {
    editPath,
    validate,
  });
}

/**
 * 属性値を編集（ParameterEditorモーダル、失敗時はprompt()フォールバック）
 * @param {string} elementType - 要素タイプ（タグ名から 'Stb' を除いたもの）
 * @param {string} elementId - 要素ID（id属性を持たない要素は空文字）
 * @param {string} attributeName - 属性名
 * @param {string} currentValue - 現在の値
 * @param {{path?: string|null}} [options] - 編集パス（id属性を持たない子要素用）
 */
export async function editAttributeValue(
  elementType,
  elementId,
  attributeName,
  currentValue,
  options = {},
) {
  const editPath = options.path || null;
  const workingSessionAtStart = isWorkingSessionActive();

  eventBus.emit(EditEvents.EDIT_STARTED, {
    elementType,
    elementId,
    attributeName,
    currentValue,
    timestamp: Date.now(),
  });

  let newValue = null;
  let provisionalApplied = false;
  let previewTimer = null;

  try {
    const suggestionEngine = getSuggestionEngine();
    const parameterEditor = getParameterEditor();
    const tagName = resolveElementTagName(elementType) || `Stb${elementType}`;

    const suggestions = suggestionEngine
      ? suggestionEngine.getSuggestions(elementType, attributeName, {
          currentValue,
          elementId,
          tagName,
        })
      : [];

    const attrInfo = getAttributeInfo(tagName, attributeName);

    const coordinateAttrNames = ['x', 'y', 'z'];
    const forceFreeText =
      elementType === 'Node' && coordinateAttrNames.includes((attributeName || '').toLowerCase());

    const onPreview = workingSessionAtStart
      ? undefined
      : (previewValue) => {
          clearTimeout(previewTimer);
          previewTimer = setTimeout(() => {
            applyAttributeEditToDocument(
              elementType,
              elementId,
              attributeName,
              previewValue,
              editPath,
            );
            provisionalApplied = true;
          }, 400);
        };

    const identity = buildIdentityEditConfig(attributeName, tagName, elementId);
    const isIdRenumber = attributeName === 'id' && !editPath;

    const config = {
      attributeName,
      currentValue: currentValue || '',
      suggestions: identity ? [] : suggestions,
      elementType,
      elementId,
      schemaTagName: tagName,
      schema: attrInfo,
      allowFreeText:
        !!identity || forceFreeText || !attrInfo || !suggestions.length || suggestions.length > 10,
      required: attrInfo ? attrInfo.required : false,
      onPreview: isIdRenumber ? undefined : onPreview,
      ...(identity || {}),
    };

    if (!parameterEditor) {
      log.warn('ParameterEditor not available');
      return;
    }
    newValue = await parameterEditor.show(config);
    clearTimeout(previewTimer);

    if (newValue !== null && suggestionEngine) {
      suggestionEngine.recordUsage(elementType, attributeName, newValue);
    }
  } catch (error) {
    log.error('属性編集中にエラーが発生しました:', error);
    newValue = prompt(`属性「${attributeName}」の新しい値を入力してください:`, currentValue || '');

    if (newValue !== null && isSchemaLoaded()) {
      const tagName = resolveElementTagName(elementType) || `Stb${elementType}`;
      const validation = validateAttributeValue(tagName, attributeName, newValue);

      if (!validation.valid) {
        const proceed = confirm(
          `警告: ${validation.error}\n\n` +
            (validation.suggestions ? `推奨値: ${validation.suggestions.join(', ')}\n\n` : '') +
            'それでも続行しますか？',
        );
        if (!proceed) return;
      }
    }
  }

  if (newValue === null) {
    if (provisionalApplied) {
      applyAttributeEditToDocument(
        elementType,
        elementId,
        attributeName,
        currentValue || null,
        editPath,
      );
    }
    eventBus.emit(EditEvents.EDIT_CANCELLED, {
      elementType,
      elementId,
      attributeName,
      timestamp: Date.now(),
    });
    return;
  }

  if (isWorkingSessionActive()) {
    try {
      const result = commitWorkingAttributeEdit(
        elementType,
        elementId,
        attributeName,
        newValue,
        editPath,
      );

      if (attributeName === 'id' && !editPath && result?.changed === true) {
        const currentEditingElement = getCurrentEditingElement();
        if (currentEditingElement && String(currentEditingElement.idA) === String(elementId)) {
          currentEditingElement.idA = String(newValue);
        }
      }
    } catch (error) {
      log.error('Working Document の属性編集を確定できませんでした:', error);
      showError(`編集を確定できませんでした: ${error.message}`);
      eventBus.emit(EditEvents.EDIT_CANCELLED, {
        elementType,
        elementId,
        attributeName,
        timestamp: Date.now(),
      });
      redisplayCurrentEditingElement();
      updateEditingSummary();
      return;
    }

    redisplayCurrentEditingElement();
    updateEditingSummary();
    return;
  }

  if (attributeName === 'id' && !editPath) {
    handleIdRenumber(elementType, elementId, currentValue, newValue);
    return;
  }

  getModifications().push({
    op: 'attr',
    elementType,
    id: elementId,
    path: editPath,
    attribute: attributeName,
    oldValue: currentValue,
    newValue: newValue,
  });

  const success = applyAttributeEditToDocument(
    elementType,
    elementId,
    attributeName,
    newValue,
    editPath,
  );

  if (!success) {
    log.warn('XML更新に失敗しましたが、修正履歴には記録されました');
  }

  redisplayCurrentEditingElement();
  updateEditingSummary();
}
