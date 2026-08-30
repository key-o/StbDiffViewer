/**
 * @fileoverview ParameterEditor のモーダルDOM構築・表示制御メソッド
 *
 * モーダル本体の生成、表示アニメーション、初期フォーカス、クローズ処理を担う。
 * ParameterEditor.prototype へ Object.assign して合成する（`this` はエディタインスタンス）。
 *
 * @module ui/panels/parameterEditor/modalDom
 */

export const parameterEditorModalDomMethods = {
  /**
   * モーダルDOM要素を作成
   */
  createModal() {
    const { attributeName, currentValue, suggestions, allowFreeText, required } =
      this.currentConfig;
    const normalizedSuggestions = this.normalizeSuggestionList(suggestions);

    // モーダル背景
    this.modal = document.createElement('div');
    this.modal.className = 'parameter-editor-overlay';
    this.modal.setAttribute('role', 'dialog');
    this.modal.setAttribute('aria-modal', 'true');
    this.modal.setAttribute('aria-labelledby', 'param-editor-title');

    // モーダルコンテナー
    const container = document.createElement('div');
    container.className = 'parameter-editor-container';

    // ヘッダー
    const header = document.createElement('div');
    header.className = 'parameter-editor-header';
    header.innerHTML = `
      <h3 id="param-editor-title" class="parameter-editor-title">
        属性の編集: ${attributeName}
        ${required ? '<span class="required-indicator" title="必須">*</span>' : ''}
      </h3>
      <button type="button" class="parameter-editor-close" aria-label="閉じる">×</button>
    `;

    // メインコンテンツ
    const content = document.createElement('div');
    content.className = 'parameter-editor-content';

    // 入力セクション
    const inputSection = this.createInputSection(
      normalizedSuggestions,
      currentValue,
      allowFreeText,
    );
    content.appendChild(inputSection);

    // バリデーションメッセージエリア
    const validationArea = document.createElement('div');
    validationArea.className = 'parameter-editor-validation';
    validationArea.setAttribute('role', 'alert');
    validationArea.setAttribute('aria-live', 'polite');
    content.appendChild(validationArea);

    // サジェスト情報
    if (normalizedSuggestions.length > 0) {
      const suggestInfo = document.createElement('div');
      suggestInfo.className = 'parameter-editor-info';
      suggestInfo.innerHTML = `
        <small>📋 ${normalizedSuggestions.length}個の候補値があります</small>
      `;
      content.appendChild(suggestInfo);
    }

    // ボタンエリア
    const buttonArea = document.createElement('div');
    buttonArea.className = 'parameter-editor-buttons';
    buttonArea.innerHTML = `
      <button type="button" class="parameter-editor-cancel">キャンセル</button>
      <button type="button" class="parameter-editor-ok" disabled>OK</button>
    `;

    container.appendChild(header);
    container.appendChild(content);
    container.appendChild(buttonArea);
    this.modal.appendChild(container);

    document.body.appendChild(this.modal);
  },

  /**
   * モーダルを表示
   */
  showModal() {
    this.modal.style.display = 'flex';
    document.body.style.overflow = 'hidden'; // 背景のスクロールを無効化

    // アニメーション用のクラスを追加
    requestAnimationFrame(() => {
      this.modal.classList.add('show');
    });
  },

  /**
   * 初期フォーカス設定
   */
  focusInitialElement() {
    // 適切な要素にフォーカスを設定
    const textInput = this.modal.querySelector('.parameter-text-input');
    const dropdown = this.modal.querySelector('.parameter-dropdown');

    if (textInput) {
      textInput.focus();
      // テキストが既にある場合は選択
      if (textInput.value) {
        textInput.select();
      }
    } else if (dropdown) {
      dropdown.focus();
    }
  },

  /**
   * モーダルを閉じる
   */
  closeModal() {
    if (this.modal) {
      this.modal.classList.remove('show');
      document.body.style.overflow = ''; // スクロール復元

      // アニメーション完了後に削除
      setTimeout(() => {
        if (this.modal && this.modal.parentNode) {
          this.modal.parentNode.removeChild(this.modal);
        }
        this.modal = null;
      }, 300);
    }

    // グローバルイベントリスナーを削除
    document.removeEventListener('keydown', this.handleGlobalKeydown.bind(this));
  },
};
