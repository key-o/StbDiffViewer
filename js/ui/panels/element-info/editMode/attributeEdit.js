/**
 * @fileoverview 属性値編集（ParameterEditor モーダル・ライブプレビュー・prompt フォールバック）
 *
 * 属性値の編集フローを担当する。id のリナンバーは `idRenumber.handleIdRenumber` へ、
 * 実際の文書更新は `editAppliers.applyAttributeEditToDocument` へ委譲する。
 */

import { createLogger } from '../../../../utils/logger.js';
import {
  isSchemaLoaded,
  getAttributeInfo,
  validateAttributeValue,
} from '../../../../common-stb/import/parser/jsonSchemaLoader.js';
import { eventBus, EditEvents } from '../../../../data/events/index.js';
import { getParameterEditor, getSuggestionEngine } from '../ElementInfoProviders.js';
import { applyAttributeEditToDocument } from './editAppliers.js';
import { buildIdentityEditConfig, handleIdRenumber } from './idRenumber.js';
import { updateEditingSummary } from './editHistory.js';
import { getModifications, redisplayCurrentEditingElement } from './editState.js';

const log = createLogger('viewer:edit-mode');

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

  // 編集開始イベントを発行
  eventBus.emit(EditEvents.EDIT_STARTED, {
    elementType,
    elementId,
    attributeName,
    currentValue,
    timestamp: Date.now(),
  });

  let newValue = null;
  // プレビュー状態（try/catch をまたいで参照するためスコープを外に出す）
  let provisionalApplied = false;
  let previewTimer = null;

  try {
    const suggestionEngine = getSuggestionEngine();
    const parameterEditor = getParameterEditor();

    // サジェスト候補を取得
    const suggestions = suggestionEngine
      ? suggestionEngine.getSuggestions(elementType, attributeName, { currentValue, elementId })
      : [];

    // 属性情報を取得
    const tagName = elementType === 'Node' ? 'StbNode' : `Stb${elementType}`;
    const attrInfo = getAttributeInfo(tagName, attributeName);

    // ParameterEditorの設定
    const coordinateAttrNames = ['x', 'y', 'z'];
    const forceFreeText =
      elementType === 'Node' && coordinateAttrNames.includes((attributeName || '').toLowerCase());

    // プレビュー: 入力中の値をデバウンス付きで仮適用（modifications には追記しない）
    const onPreview = (previewValue) => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        applyAttributeEditToDocument(elementType, elementId, attributeName, previewValue, editPath);
        provisionalApplied = true;
      }, 400);
    };

    // 自己同一性属性（id / guid）は「既存値から選ぶ」のではなく「一意な新規値を入力・生成する」用途。
    // 既存値サジェストは重複を誘発するため使わず、直接入力＋自動生成（id は空き番号採番・重複検証付き）を提供する。
    const identity = buildIdentityEditConfig(attributeName, tagName, elementId);

    // id のリナンバーは参照追従を伴う確定処理として扱うため、入力中のライブ仮適用は行わない。
    const isIdRenumber = attributeName === 'id' && !editPath;

    const config = {
      attributeName,
      currentValue: currentValue || '',
      // 識別子は既存値サジェスト（＝重複候補）を出さない
      suggestions: identity ? [] : suggestions,
      elementType,
      elementId,
      // スキーマ定義（型・制約・列挙値）。ParameterEditor が入力コントロールの種別を決定する
      schema: attrInfo,
      allowFreeText:
        !!identity || forceFreeText || !attrInfo || !suggestions.length || suggestions.length > 10,
      required: attrInfo ? attrInfo.required : false,
      onPreview: isIdRenumber ? undefined : onPreview,
      // 識別子用の専用入力（直接入力＋自動生成ボタン）を有効化する
      ...(identity || {}),
    };

    // ParameterEditorモーダルを表示
    if (!parameterEditor) {
      log.warn('ParameterEditor not available');
      return;
    }
    newValue = await parameterEditor.show(config);
    clearTimeout(previewTimer);

    if (newValue !== null && suggestionEngine) {
      // 使用統計を記録
      suggestionEngine.recordUsage(elementType, attributeName, newValue);
    }
  } catch (error) {
    log.error('属性編集中にエラーが発生しました:', error);

    // フォールバック: 従来のprompt()を使用
    newValue = prompt(`属性「${attributeName}」の新しい値を入力してください:`, currentValue || '');

    // XSDバリデーション
    if (newValue !== null && isSchemaLoaded()) {
      const tagName = elementType === 'Node' ? 'StbNode' : `Stb${elementType}`;
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
    // プレビューで仮適用済みなら元の値に rollback
    if (provisionalApplied) {
      applyAttributeEditToDocument(
        elementType,
        elementId,
        attributeName,
        currentValue || null,
        editPath,
      );
    }
    // 編集キャンセルイベントを発行
    eventBus.emit(EditEvents.EDIT_CANCELLED, {
      elementType,
      elementId,
      attributeName,
      timestamp: Date.now(),
    });
    return;
  }

  // id のリナンバー（自己IDの変更）は参照追従更新と確認ダイアログを伴う専用処理へ委譲する。
  if (attributeName === 'id' && !editPath) {
    handleIdRenumber(elementType, elementId, currentValue, newValue);
    return;
  }

  // 修正を記録
  getModifications().push({
    op: 'attr',
    elementType,
    id: elementId,
    path: editPath,
    attribute: attributeName,
    oldValue: currentValue,
    newValue: newValue,
  });

  // XMLドキュメントを直接更新（モデルAのみ編集可能）
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

  // UIを更新（現在の要素を再表示）
  // 再表示は親部材（currentEditingElement）のタイプとIDで行う（断面ノード編集後も親部材パネルに戻す）
  redisplayCurrentEditingElement();

  updateEditingSummary();
}
