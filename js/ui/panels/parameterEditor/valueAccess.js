/**
 * @fileoverview ParameterEditor の値の読み書き・バリデーションメソッド
 *
 * サジェスト候補の正規化、現在の入力値の取得、必須／XSD／追加バリデーションの評価と
 * バリデーション表示の更新を担う。
 * ParameterEditor.prototype へ Object.assign して合成する（`this` はエディタインスタンス）。
 *
 * @module ui/panels/parameterEditor/valueAccess
 */

import { validationController } from '../../../app/controllers/validationController.js';

export const parameterEditorValueAccessMethods = {
  /**
   * サジェストエントリを正規化
   * @param {Array<string|Object>} suggestions
   * @returns {Array<Object>}
   */
  normalizeSuggestionList(suggestions = []) {
    return suggestions
      .map((entry) => this.normalizeSuggestionEntry(entry))
      .filter((entry) => entry !== null);
  },

  normalizeSuggestionEntry(entry) {
    if (!entry) {
      return null;
    }

    if (typeof entry === 'string') {
      const value = entry.trim();
      if (!value) return null;
      return { value, label: entry };
    }

    if (typeof entry === 'object') {
      const value = (entry.value ?? '').toString().trim();
      if (!value) return null;
      const label = (entry.label ?? value).toString();
      return {
        value,
        label,
        meta: entry.meta || {},
        source: entry.source || 'unknown',
      };
    }

    return null;
  },

  /**
   * 現在の入力値をバリデーション
   */
  validateCurrentInput() {
    const currentValue = this.getCurrentValue();
    const validationArea = this.modal.querySelector('.parameter-editor-validation');
    const okBtn = this.modal.querySelector('.parameter-editor-ok');

    let isValid = true;
    let isBlocking = true;
    let message = '';

    // 必須チェック
    if (this.currentConfig.required && (!currentValue || currentValue.trim() === '')) {
      isValid = false;
      isBlocking = true;
      message = '⚠️ この属性は必須です';
    }
    // XSDバリデーション
    else if (validationController.isSchemaReady() && currentValue && currentValue.trim() !== '') {
      const { elementType, attributeName } = this.currentConfig;
      const tagName = elementType === 'Node' ? 'StbNode' : `Stb${elementType}`;
      const validation = validationController.validateAttribute(
        tagName,
        attributeName,
        currentValue,
      );

      if (!validation.valid) {
        isValid = false;
        // blocking: false の場合（スキーマ未定義など）はOKを有効のまま警告のみ表示
        isBlocking = validation.blocking !== false;
        message = `⚠️ ${validation.error}`;

        if (validation.suggestions && validation.suggestions.length > 0) {
          message += `<br><small>💡 推奨値: ${validation.suggestions
            .slice(0, 3)
            .join(', ')}</small>`;
        }
      }
    }

    // 追加バリデーション（呼び出し元が与える文脈依存チェック。id の一意性など）。
    // XSD で問題が無い場合のみ評価し、メッセージが返れば編集を確定不可（blocking）にする。
    if (isValid && typeof this.currentConfig.extraValidate === 'function' && currentValue) {
      const extraMessage = this.currentConfig.extraValidate(currentValue);
      if (extraMessage) {
        isValid = false;
        isBlocking = true;
        message = `⚠️ ${extraMessage}`;
      }
    }

    // UI更新
    validationArea.innerHTML = message;
    validationArea.className = `parameter-editor-validation ${isValid ? 'valid' : isBlocking ? 'invalid' : 'warning'}`;
    okBtn.disabled = isBlocking && !isValid;

    return isValid;
  },

  /**
   * 現在の入力値を取得
   * @returns {string} 現在の値
   */
  getCurrentValue() {
    const textInput = this.modal.querySelector('.parameter-text-input');
    const dropdown = this.modal.querySelector('.parameter-dropdown');

    if (textInput) {
      return textInput.value.trim();
    } else if (dropdown) {
      return dropdown.value;
    }

    return '';
  },
};
