/**
 * @fileoverview ParameterEditor のイベント配線・入力操作ハンドラ
 *
 * モーダル内のボタン・ドロップダウン・テキスト入力・キーボード操作の配線と、
 * 確定／キャンセルの処理を担う。
 * ParameterEditor.prototype へ Object.assign して合成する（`this` はエディタインスタンス）。
 *
 * @module ui/panels/parameterEditor/eventHandlers
 */

export const parameterEditorEventMethods = {
  /**
   * イベントリスナーを設定
   */
  setupEventListeners() {
    // 閉じるボタン
    const closeBtn = this.modal.querySelector('.parameter-editor-close');
    closeBtn.addEventListener('click', () => this.cancel());

    // キャンセルボタン
    const cancelBtn = this.modal.querySelector('.parameter-editor-cancel');
    cancelBtn.addEventListener('click', () => this.cancel());

    // OKボタン
    const okBtn = this.modal.querySelector('.parameter-editor-ok');
    okBtn.addEventListener('click', () => this.confirm());

    // ドロップダウン変更
    const dropdown = this.modal.querySelector('.parameter-dropdown');
    if (dropdown) {
      dropdown.addEventListener('change', (e) => this.handleDropdownChange(e));
    }

    // テキスト入力変更
    const textInput = this.modal.querySelector('.parameter-text-input');
    if (textInput) {
      textInput.addEventListener('input', (e) => this.handleTextInputChange(e));
      textInput.addEventListener('keydown', (e) => this.handleKeydown(e));
    }

    // 識別子（guid / id 等）の自動生成ボタン
    const generateBtn = this.modal.querySelector('.parameter-editor-generate-btn');
    if (generateBtn) {
      generateBtn.addEventListener('click', () => this.handleIdentityGenerate());
    }

    // ESCキーでキャンセル
    document.addEventListener('keydown', this.handleGlobalKeydown.bind(this));

    // モーダル背景クリックでキャンセル
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) {
        this.cancel();
      }
    });

    // 初期バリデーション
    this.validateCurrentInput();
  },

  /**
   * ドロップダウン変更時の処理
   * @param {Event} event - 変更イベント
   */
  handleDropdownChange(event) {
    const selectedValue = event.target.value;

    // 混合モードの場合、テキストフィールドにも反映
    const textInput = this.modal.querySelector('.parameter-text-input');
    if (textInput && selectedValue) {
      textInput.value = selectedValue;
      this.handleTextInputChange({ target: textInput });
    } else {
      this.validateCurrentInput();
      if (this.currentConfig.onPreview && selectedValue) {
        this.currentConfig.onPreview(selectedValue);
      }
    }
  },

  /**
   * テキスト入力変更時の処理
   * @param {Event} event - 入力イベント
   */
  handleTextInputChange(event) {
    const currentValue = event.target.value;

    // 混合モードの場合、ドロップダウンの選択もクリア
    const dropdown = this.modal.querySelector('.parameter-dropdown');
    if (dropdown) {
      const matchingOption = Array.from(dropdown.options).find((opt) => opt.value === currentValue);
      dropdown.value = matchingOption ? currentValue : '';
    }

    this.validateCurrentInput();

    // プレビューコールバック（デバウンスは呼び出し元で管理）
    if (this.currentConfig.onPreview && currentValue) {
      this.currentConfig.onPreview(currentValue);
    }
  },

  /**
   * 識別子の自動生成ボタン処理
   *
   * config.generate() の値をテキスト入力へ反映し、バリデーション・プレビューを更新する。
   */
  handleIdentityGenerate() {
    const textInput = this.modal.querySelector('.parameter-text-input');
    if (!textInput || typeof this.currentConfig.generate !== 'function') return;
    textInput.value = this.currentConfig.generate();
    this.handleTextInputChange({ target: textInput });
    textInput.focus();
  },

  /**
   * キーボード操作処理
   * @param {KeyboardEvent} event - キーボードイベント
   */
  handleKeydown(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      const okBtn = this.modal.querySelector('.parameter-editor-ok');
      if (!okBtn.disabled) {
        this.confirm();
      }
    }
  },

  /**
   * グローバルキーボード処理
   * @param {KeyboardEvent} event - キーボードイベント
   */
  handleGlobalKeydown(event) {
    if (event.key === 'Escape') {
      this.cancel();
    }
  },

  /**
   * 確定処理
   */
  confirm() {
    const okBtn = this.modal.querySelector('.parameter-editor-ok');
    if (okBtn && okBtn.disabled) {
      return;
    }

    const value = this.getCurrentValue();
    this.closeModal();
    this.resolvePromise(value);
  },

  /**
   * キャンセル処理
   */
  cancel() {
    this.closeModal();
    this.resolvePromise(null);
  },
};
