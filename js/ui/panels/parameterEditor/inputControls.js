/**
 * @fileoverview ParameterEditor の入力コントロール生成メソッド
 *
 * スキーマ定義（固定値・列挙・数値）とサジェスト候補から、
 * ドロップダウン／数値入力／混合入力／フリーテキスト／識別子入力を組み立てる。
 * ParameterEditor.prototype へ Object.assign して合成する（`this` はエディタインスタンス）。
 *
 * @module ui/panels/parameterEditor/inputControls
 */

export const parameterEditorInputControlMethods = {
  /**
   * 入力セクションを作成
   * @param {Array<Object>} suggestions - サジェスト候補
   * @param {string} currentValue - 現在の値
   * @param {boolean} allowFreeText - フリーテキスト許可
   * @returns {HTMLElement} 入力セクション要素
   */
  createInputSection(suggestions, currentValue, allowFreeText) {
    const section = document.createElement('div');
    section.className = 'parameter-editor-input-section';

    // 識別子（guid / id）など「一意な新規値を入力・生成する」用途は、専用入力
    // （直接入力＋自動生成ボタン）を最優先で用いる。既存値サジェストによる
    // ドロップダウン固定を避けるための特別扱い。呼び出し元が config.generate を
    // 与えることで有効化される。
    if (typeof this.currentConfig.generate === 'function') {
      section.appendChild(this.createIdentityInput(currentValue));
      return section;
    }

    // スキーマ定義がある場合は、それに従って入力コントロールを決定する（最優先）
    const schemaMode = this.resolveSchemaInputMode();

    if (schemaMode.mode === 'fixed') {
      // 固定値（const）: 読み取り専用表示
      section.appendChild(this.createFixedInput(schemaMode.value));
    } else if (schemaMode.mode === 'enum') {
      // 列挙値・boolean: スキーマ定義値のみの厳格なドロップダウン
      section.appendChild(this.createEnumSelect(schemaMode.options, currentValue));
    } else if (schemaMode.mode === 'number') {
      // 数値: min/max/step 付きの数値入力（候補は datalist で補助）
      section.appendChild(this.createNumberInput(schemaMode, currentValue, suggestions));
    } else {
      // スキーマ非定義: サジェスト候補に基づく従来のモード選択
      const hasEnumeration = suggestions.length > 0;
      const useDropdownOnly = hasEnumeration && suggestions.length <= 10 && !allowFreeText;
      const useMixedMode = hasEnumeration && (suggestions.length > 10 || allowFreeText);

      if (useDropdownOnly) {
        section.appendChild(this.createDropdownInput(suggestions, currentValue));
      } else if (useMixedMode) {
        section.appendChild(this.createMixedInput(suggestions, currentValue));
      } else {
        section.appendChild(this.createTextInput(currentValue));
      }
    }

    return section;
  },

  /**
   * スキーマ定義から入力コントロールの種別を判定する
   * @returns {{mode: 'fixed'|'enum'|'number'|null, value?: string, options?: string[],
   *   isInteger?: boolean, min?: number|null, max?: number|null,
   *   minExclusive?: number|null, maxExclusive?: number|null}}
   */
  resolveSchemaInputMode() {
    const schema = this.currentConfig.schema;
    if (!schema) return { mode: null };

    // const（固定値）
    if (schema.fixed !== null && schema.fixed !== undefined) {
      return { mode: 'fixed', value: String(schema.fixed) };
    }

    const constraints = schema.constraints || {};
    const enumerations = Array.isArray(constraints.enumerations) ? constraints.enumerations : [];

    // 列挙値
    if (enumerations.length > 0) {
      return { mode: 'enum', options: enumerations.map(String) };
    }

    // boolean は true / false の2択
    if (schema.type === 'boolean') {
      return { mode: 'enum', options: ['true', 'false'] };
    }

    // 数値（min/max 制約を反映）
    if (schema.type === 'number' || schema.type === 'integer') {
      return {
        mode: 'number',
        isInteger: schema.type === 'integer',
        min: constraints.minInclusive ?? null,
        max: constraints.maxInclusive ?? null,
        minExclusive: constraints.minExclusive ?? null,
        maxExclusive: constraints.maxExclusive ?? null,
      };
    }

    return { mode: null };
  },

  /**
   * 固定値（const）の読み取り専用入力を作成
   * @param {string} fixedValue - スキーマで固定された値
   * @returns {HTMLElement}
   */
  createFixedInput(fixedValue) {
    const container = document.createElement('div');
    container.className = 'input-container fixed-only';

    const label = document.createElement('label');
    label.textContent = '値（固定）:';
    label.setAttribute('for', 'param-text');

    const input = document.createElement('input');
    input.id = 'param-text';
    input.type = 'text';
    input.className = 'parameter-text-input';
    input.value = fixedValue;
    input.readOnly = true;

    const help = document.createElement('small');
    help.className = 'input-help';
    help.textContent = 'この属性の値はスキーマで固定されています';

    container.appendChild(label);
    container.appendChild(input);
    container.appendChild(help);

    return container;
  },

  /**
   * 列挙値（enum / boolean）の厳格なドロップダウンを作成
   *
   * スキーマで許可された値のみを選択肢にする。現在値がスキーマ外の場合は
   * 区別できるオプションとして先頭に追加し、選択状態を保持する。
   * @param {string[]} options - スキーマで許可された値
   * @param {string} currentValue - 現在の値
   * @returns {HTMLElement}
   */
  createEnumSelect(options, currentValue) {
    const container = document.createElement('div');
    container.className = 'input-container dropdown-only';

    const label = document.createElement('label');
    label.textContent = '値を選択:';
    label.setAttribute('for', 'param-dropdown');

    const select = document.createElement('select');
    select.id = 'param-dropdown';
    select.className = 'parameter-dropdown';

    // 空の選択肢（未選択状態）
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = '-- 選択してください --';
    select.appendChild(emptyOption);

    // 現在値がスキーマ定義外の場合は、区別できる形で先頭付近に追加
    if (currentValue && !options.includes(currentValue)) {
      const invalidOption = document.createElement('option');
      invalidOption.value = currentValue;
      invalidOption.textContent = `${currentValue}（スキーマ外）`;
      invalidOption.selected = true;
      select.appendChild(invalidOption);
    }

    options.forEach((value) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      if (value === currentValue) {
        option.selected = true;
      }
      select.appendChild(option);
    });

    const help = document.createElement('small');
    help.className = 'input-help';
    help.textContent = 'スキーマで定義された値から選択してください';

    container.appendChild(label);
    container.appendChild(select);
    container.appendChild(help);

    return container;
  },

  /**
   * 数値（number / integer）入力を作成
   *
   * min / max / step を HTML 属性として設定し、サジェスト候補は datalist で補助する。
   * @param {Object} schemaMode - resolveSchemaInputMode の結果
   * @param {string} currentValue - 現在の値
   * @param {Array<Object>} suggestions - サジェスト候補
   * @returns {HTMLElement}
   */
  createNumberInput(schemaMode, currentValue, suggestions) {
    const container = document.createElement('div');
    container.className = 'input-container number-only';

    const label = document.createElement('label');
    label.textContent = '値を入力:';
    label.setAttribute('for', 'param-text');

    const input = document.createElement('input');
    input.id = 'param-text';
    input.type = 'number';
    // 既存のイベント配線・値取得が .parameter-text-input を前提とするため両クラスを付与
    input.className = 'parameter-text-input parameter-number-input';
    input.value = currentValue || '';
    input.step = schemaMode.isInteger ? '1' : 'any';

    // min / max を反映（exclusive は HTML 属性では厳密に表現できないためバリデーションで担保）
    const min = schemaMode.min ?? schemaMode.minExclusive;
    const max = schemaMode.max ?? schemaMode.maxExclusive;
    if (min !== null && min !== undefined) input.min = String(min);
    if (max !== null && max !== undefined) input.max = String(max);

    // 既存モデル値などの候補を datalist で補助
    const numericSuggestions = (suggestions || [])
      .map((entry) => this.normalizeSuggestionEntry(entry))
      .filter((entry) => entry && entry.value !== '' && !isNaN(Number(entry.value)));

    if (numericSuggestions.length > 0) {
      const listId = 'param-number-list';
      input.setAttribute('list', listId);
      const datalist = document.createElement('datalist');
      datalist.id = listId;
      numericSuggestions.forEach((entry) => {
        const option = document.createElement('option');
        option.value = entry.value;
        datalist.appendChild(option);
      });
      container.appendChild(datalist);
    }

    const help = document.createElement('small');
    help.className = 'input-help';
    help.textContent = this.buildNumberHelpText(schemaMode);

    container.appendChild(label);
    container.appendChild(input);
    container.appendChild(help);

    return container;
  },

  /**
   * 数値入力の制約ヒント文を生成
   * @param {Object} schemaMode - resolveSchemaInputMode の結果
   * @returns {string}
   */
  buildNumberHelpText(schemaMode) {
    const parts = [schemaMode.isInteger ? '整数を入力してください' : '数値を入力してください'];

    if (schemaMode.min !== null && schemaMode.min !== undefined)
      parts.push(`${schemaMode.min} 以上`);
    if (schemaMode.minExclusive !== null && schemaMode.minExclusive !== undefined)
      parts.push(`${schemaMode.minExclusive} より大きい`);
    if (schemaMode.max !== null && schemaMode.max !== undefined)
      parts.push(`${schemaMode.max} 以下`);
    if (schemaMode.maxExclusive !== null && schemaMode.maxExclusive !== undefined)
      parts.push(`${schemaMode.maxExclusive} 未満`);

    return parts.join(' / ');
  },

  /**
   * ドロップダウン入力を作成
   * @param {Array<Object>} suggestions - 候補値
   * @param {string} currentValue - 現在の値
   * @returns {HTMLElement} ドロップダウン要素
   */
  createDropdownInput(suggestions, currentValue) {
    const container = document.createElement('div');
    container.className = 'input-container dropdown-only';

    const label = document.createElement('label');
    label.textContent = '値を選択:';
    label.setAttribute('for', 'param-dropdown');

    const select = document.createElement('select');
    select.id = 'param-dropdown';
    select.className = 'parameter-dropdown';
    select.setAttribute('aria-describedby', 'dropdown-help');

    // 空の選択肢（未選択状態）
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = '-- 選択してください --';
    select.appendChild(emptyOption);

    // 候補値をオプションとして追加
    suggestions.forEach((suggestion) => {
      const entry = this.normalizeSuggestionEntry(suggestion);
      if (!entry) return;
      const option = document.createElement('option');
      option.value = entry.value;
      option.textContent = entry.label || entry.value;
      if (entry.meta) {
        option.title = Object.values(entry.meta)
          .filter((val) => !!val)
          .join(' / ');
      }
      if (entry.value === currentValue) {
        option.selected = true;
      }
      select.appendChild(option);
    });

    const help = document.createElement('small');
    help.id = 'dropdown-help';
    help.className = 'input-help';
    help.textContent = '候補から選択してください';

    container.appendChild(label);
    container.appendChild(select);
    container.appendChild(help);

    return container;
  },

  /**
   * 混合入力（ドロップダウン + テキスト）を作成
   * @param {Array<Object>} suggestions - 候補値
   * @param {string} currentValue - 現在の値
   * @returns {HTMLElement} 混合入力要素
   */
  createMixedInput(suggestions, currentValue) {
    const container = document.createElement('div');
    container.className = 'input-container mixed-mode';

    // ドロップダウン部分
    const dropdownContainer = document.createElement('div');
    dropdownContainer.className = 'dropdown-section';

    const dropdownLabel = document.createElement('label');
    dropdownLabel.textContent = '候補から選択:';
    dropdownLabel.setAttribute('for', 'param-dropdown');

    const select = document.createElement('select');
    select.id = 'param-dropdown';
    select.className = 'parameter-dropdown';

    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = '-- 候補から選択 --';
    select.appendChild(emptyOption);

    suggestions.forEach((suggestion) => {
      const entry = this.normalizeSuggestionEntry(suggestion);
      if (!entry) return;
      const option = document.createElement('option');
      option.value = entry.value;
      option.textContent = entry.label || entry.value;
      if (entry.meta) {
        option.title = Object.values(entry.meta)
          .filter((val) => !!val)
          .join(' / ');
      }
      select.appendChild(option);
    });

    dropdownContainer.appendChild(dropdownLabel);
    dropdownContainer.appendChild(select);

    // または区切り
    const separator = document.createElement('div');
    separator.className = 'input-separator';
    separator.textContent = 'または';

    // テキスト入力部分
    const textContainer = document.createElement('div');
    textContainer.className = 'text-section';

    const textLabel = document.createElement('label');
    textLabel.textContent = '直接入力:';
    textLabel.setAttribute('for', 'param-text');

    const textInput = document.createElement('input');
    textInput.id = 'param-text';
    textInput.type = 'text';
    textInput.className = 'parameter-text-input';
    textInput.value = currentValue || '';
    textInput.setAttribute('aria-describedby', 'text-help');

    const textHelp = document.createElement('small');
    textHelp.id = 'text-help';
    textHelp.className = 'input-help';
    textHelp.textContent = '任意の値を入力できます';

    if (currentValue) {
      const hasMatch = suggestions.some((entry) => {
        const normalized = this.normalizeSuggestionEntry(entry);
        return normalized && normalized.value === currentValue;
      });
      if (hasMatch) {
        select.value = currentValue;
        textInput.value = currentValue;
      }
    }

    textContainer.appendChild(textLabel);
    textContainer.appendChild(textInput);
    textContainer.appendChild(textHelp);

    container.appendChild(dropdownContainer);
    container.appendChild(separator);
    container.appendChild(textContainer);

    return container;
  },

  /**
   * フリーテキスト入力を作成
   * @param {string} currentValue - 現在の値
   * @returns {HTMLElement} テキスト入力要素
   */
  createTextInput(currentValue) {
    const container = document.createElement('div');
    container.className = 'input-container text-only';

    const label = document.createElement('label');
    label.textContent = '値を入力:';
    label.setAttribute('for', 'param-text');

    const input = document.createElement('input');
    input.id = 'param-text';
    input.type = 'text';
    input.className = 'parameter-text-input';
    input.value = currentValue || '';
    input.setAttribute('aria-describedby', 'text-help');

    const help = document.createElement('small');
    help.id = 'text-help';
    help.className = 'input-help';
    help.textContent = '任意の値を入力してください';

    container.appendChild(label);
    container.appendChild(input);
    container.appendChild(help);

    return container;
  },

  /**
   * 識別子（guid / id 等）専用入力（直接入力 ＋ 自動生成ボタン）を作成
   *
   * 既存値サジェストに依存せず、常にテキスト直接入力を許可する。
   * 「自動生成」ボタンは config.generate() の戻り値を入力欄へ反映する。
   * ボタン文言は config.generateLabel、補助文は config.inputHelp で差し替え可能。
   * @param {string} currentValue - 現在の値
   * @returns {HTMLElement}
   */
  createIdentityInput(currentValue) {
    const container = document.createElement('div');
    container.className = 'input-container text-only identity-input';

    const label = document.createElement('label');
    label.textContent = '値を入力:';
    label.setAttribute('for', 'param-text');

    const inputRow = document.createElement('div');
    inputRow.className = 'identity-input-row';

    const input = document.createElement('input');
    input.id = 'param-text';
    input.type = 'text';
    input.className = 'parameter-text-input';
    input.value = currentValue || '';
    input.setAttribute('aria-describedby', 'text-help');

    const generateBtn = document.createElement('button');
    generateBtn.type = 'button';
    generateBtn.className = 'parameter-editor-generate-btn';
    generateBtn.textContent = this.currentConfig.generateLabel || '🔄 自動生成';

    inputRow.appendChild(input);
    inputRow.appendChild(generateBtn);

    const help = document.createElement('small');
    help.id = 'text-help';
    help.className = 'input-help';
    help.textContent = this.currentConfig.inputHelp || '値を直接入力するか、自動生成してください';

    container.appendChild(label);
    container.appendChild(inputRow);
    container.appendChild(help);

    return container;
  },
};
