/**
 * @fileoverview パラメータ編集モーダル
 *
 * STB要素の属性値を編集するためのモーダルUIコンポーネント:
 * - ドロップダウン選択機能
 * - フリーテキスト入力機能
 * - リアルタイムバリデーション
 * - アクセシビリティ対応
 * - XSDスキーマ連携
 *
 * メソッド実装は責務ごとに parameterEditor/ 配下へ分割し、
 * ParameterEditor.prototype へ合成する（`this` の意味は変えない）。
 *
 * @module ui/panels/parameterEditor
 */

import { createLogger } from '../../utils/logger.js';
import { parameterEditorModalDomMethods } from './parameterEditor/modalDom.js';
import { parameterEditorInputControlMethods } from './parameterEditor/inputControls.js';
import { parameterEditorValueAccessMethods } from './parameterEditor/valueAccess.js';
import { parameterEditorEventMethods } from './parameterEditor/eventHandlers.js';

const log = createLogger('ui:panels:parameterEditor');

/**
 * パラメータ編集モーダルクラス
 */
export class ParameterEditor {
  constructor() {
    this.modal = null;
    this.currentConfig = null;
    this.resolvePromise = null;
    this.rejectPromise = null;
  }

  /**
   * パラメータ編集モーダルを表示
   * @param {Object} config - 編集設定
   * @param {string} config.attributeName - 属性名
   * @param {string} config.currentValue - 現在の値
   * @param {Array<string|Object>} config.suggestions - サジェスト候補
   * @param {string} config.elementType - 要素タイプ
   * @param {string} config.elementId - 要素ID
   * @param {boolean} config.allowFreeText - フリーテキスト入力許可
   * @param {boolean} config.required - 必須属性かどうか
   * @param {Object} [config.schema] - スキーマ属性定義（type / fixed / constraints）。
   *   入力コントロール（列挙ドロップダウン・数値入力・固定値）の決定に用いる
   * @returns {Promise<string|null>} 編集後の値、またはキャンセル時はnull
   */
  static async show(config) {
    const editor = new ParameterEditor();
    return editor.show(config);
  }

  /**
   * モーダル表示の実装
   * @param {Object} config - 編集設定
   * @returns {Promise<string|null>} 編集結果
   */
  async show(config) {
    this.currentConfig = config;

    return new Promise((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;

      try {
        this.createModal();
        this.showModal();
        this.setupEventListeners();
        this.focusInitialElement();
      } catch (error) {
        log.error('Error showing parameter editor:', error);
        reject(error);
      }
    });
  }
}

// 責務ごとに分割したメソッド群をプロトタイプへ合成する
Object.assign(
  ParameterEditor.prototype,
  parameterEditorModalDomMethods,
  parameterEditorInputControlMethods,
  parameterEditorValueAccessMethods,
  parameterEditorEventMethods,
);

// デフォルトエクスポート
export default ParameterEditor;
