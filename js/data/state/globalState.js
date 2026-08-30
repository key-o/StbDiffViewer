/**
 * @fileoverview グローバル状態管理モジュール
 *
 * このファイルは、アプリケーション全体の状態を集中管理します:
 * - 状態の初期化と更新
 * - 状態変更の通知機能
 * - 型安全な状態アクセス
 * - デバッグ用の状態監視
 *
 * 従来のwindowオブジェクトへの直接割り当てを置き換え、
 * より構造化された状態管理を提供します。
 */

/**
 * アプリケーションの全体状態
 */

import { createLogger } from '../../utils/logger.js';
import { createInitialModelState } from './modelStateFactory.js';

const log = createLogger('app:globalState');

class ApplicationState {
  constructor() {
    this.state = {
      // レンダリング関連
      rendering: {
        scheduleRender: null,
        requestRender: null,
        rendererInitialized: false,
      },

      // モデル関連
      models: createInitialModelState(),

      // UI関連
      ui: {
        nodeLabels: [],
        stories: [],
        axesData: { xAxes: [], yAxes: [] },
        currentViewMode: 'diff',
        editMode: false,
        labelContentType: 'id', // ラベル表示内容: 'id', 'name', 'section'
      },

      // 表示モード関連
      viewModes: {
        columnViewMode: 'line',
        beamViewMode: 'line',
        isModelAVisible: true,
        isModelBVisible: true,
        // 断面が異なる一致要素(ATTRIBUTE_MISMATCH)でモデルB側の形状を
        // 半透明で重ねて表示するか（形状差の可視化用トグル、既定OFF）
        showMatchedModelBOverlay: false,
      },

      // 機能関数
      functions: {
        toggleLegend: null,
        applyStoryClip: null,
        applyAxisClip: null,
        displayElementInfo: null,
        clearClippingPlanes: null,
        toggleEditMode: null,
        setModelVisibility: null,
      },

      // 重要度関連
      importance: {
        elementRatings: new Map(),
        evaluationResults: null,
        currentMode: 'default',
        filterSettings: {},
        // MVD設定情報
        currentConfigId: null, // 's2' | 's4' | 'mvd-combined'
        currentConfigName: null, // 'MVD S2 (必須)' など
        // フォールバック統計
        fallbackStats: {
          totalChecks: 0,
          fallbackCount: 0,
          undefinedPaths: new Set(),
        },
      },

      // ファイル関連（IFC変換用）
      files: {
        originalFileA: null,
        originalFileB: null,
      },

      // Viewer関連（common/viewer統合）
      viewer: {
        adapter: null, // StbViewerAdapterインスタンス
        useCommonViewer: false, // common/viewerを使用するかどうか（実験的機能）
      },
    };

    this.listeners = new Map();
    this.debug = false;
  }

  /**
   * 状態を設定
   * @param {string} path - 状態のパス（例: 'models.modelsLoaded'）
   * @param {any} value - 設定する値
   */
  set(path, value) {
    const keys = path.split('.');
    let target = this.state;

    for (let i = 0; i < keys.length - 1; i++) {
      if (!target[keys[i]]) {
        target[keys[i]] = {};
      }
      target = target[keys[i]];
    }

    const lastKey = keys[keys.length - 1];
    const oldValue = target[lastKey];
    target[lastKey] = value;

    // 変更通知
    this.notifyListeners(path, value, oldValue);
  }

  /**
   * 状態を取得
   * @param {string} path - 状態のパス
   * @returns {any} 状態の値
   */
  get(path) {
    if (!path) {
      return this.state;
    }

    const keys = path.split('.');
    let target = this.state;

    for (const key of keys) {
      if (target === null || target === undefined) {
        return undefined;
      }
      target = target[key];
    }

    return target;
  }

  /**
   * 状態変更リスナーを追加
   * @param {string} path - 監視する状態のパス
   * @param {Function} listener - コールバック関数
   */
  addListener(path, listener) {
    if (!this.listeners.has(path)) {
      this.listeners.set(path, []);
    }
    this.listeners.get(path).push(listener);
  }

  /**
   * 状態変更リスナーを削除
   * @param {string} path - 監視する状態のパス
   * @param {Function} listener - コールバック関数
   */
  removeListener(path, listener) {
    const pathListeners = this.listeners.get(path);
    if (pathListeners) {
      const index = pathListeners.indexOf(listener);
      if (index > -1) {
        pathListeners.splice(index, 1);
      }
    }
  }

  /**
   * リスナーに変更を通知
   * @private
   */
  notifyListeners(path, newValue, oldValue) {
    const pathListeners = this.listeners.get(path);
    if (pathListeners) {
      pathListeners.forEach((listener) => {
        try {
          listener(newValue, oldValue, path);
        } catch (error) {
          log.error(`${path}の状態リスナーでエラーが発生しました:`, error);
        }
      });
    }
  }

  /**
   * 関数を登録してグローバルに公開
   * @param {string} name - 関数名
   * @param {Function} func - 関数
   */
  registerFunction(name, func) {
    this.set(`functions.${name}`, func);

    // 後方互換性のためにwindowにも設定
    if (typeof window !== 'undefined') {
      window[name] = func;
    }
  }

  /**
   * 登録された関数を取得
   * @param {string} name - 関数名
   * @returns {Function} 関数
   */
  getFunction(name) {
    return this.get(`functions.${name}`);
  }

  /**
   * デバッグモードを有効/無効にする
   * @param {boolean} enabled - デバッグモード有効フラグ
   */
  setDebugMode(enabled) {
    this.debug = enabled;
  }

  /**
   * ログ出力用に状態をシリアライズ（Map対応）
   * @private
   * @param {any} obj - シリアライズ対象
   * @param {WeakSet} seen - 循環参照検出用
   * @returns {any} シリアライズされた値
   */
  _serializeForLogging(obj, seen = new WeakSet()) {
    if (obj === null || obj === undefined) {
      return obj;
    }

    // プリミティブ型
    if (typeof obj !== 'object') {
      // 関数は文字列として表示
      if (typeof obj === 'function') {
        return `[Function: ${obj.name || 'anonymous'}]`;
      }
      return obj;
    }

    // 循環参照チェック
    if (seen.has(obj)) {
      return '[Circular]';
    }
    seen.add(obj);

    // Map型の処理
    if (obj instanceof Map) {
      const result = {};
      result['__type__'] = 'Map';
      result['size'] = obj.size;
      result['entries'] = {};
      for (const [key, value] of obj.entries()) {
        const keyStr = typeof key === 'object' ? JSON.stringify(key) : String(key);
        result['entries'][keyStr] = this._serializeForLogging(value, seen);
      }
      return result;
    }

    // Set型の処理
    if (obj instanceof Set) {
      return {
        __type__: 'Set',
        size: obj.size,
        values: Array.from(obj).map((v) => this._serializeForLogging(v, seen)),
      };
    }

    // 配列の処理
    if (Array.isArray(obj)) {
      return obj.map((item) => this._serializeForLogging(item, seen));
    }

    // 通常のオブジェクトの処理
    const result = {};
    for (const key of Object.keys(obj)) {
      try {
        result[key] = this._serializeForLogging(obj[key], seen);
      } catch (e) {
        result[key] = `[Error: ${e.message}]`;
      }
    }
    return result;
  }

  /**
   * 状態をリセット
   */
  reset() {
    const functions = this.state.functions; // 関数は保持
    this.state = {
      rendering: {
        scheduleRender: null,
        requestRender: null,
        rendererInitialized: false,
      },
      models: createInitialModelState(),
      ui: {
        nodeLabels: [],
        stories: [],
        axesData: { xAxes: [], yAxes: [] },
        currentViewMode: 'diff',
        editMode: false,
        labelContentType: 'id', // ラベル表示内容: 'id', 'name', 'section'
      },
      viewModes: {
        columnViewMode: 'line',
        beamViewMode: 'line',
        isModelAVisible: true,
        isModelBVisible: true,
      },
      functions,
      importance: {
        elementRatings: new Map(),
        evaluationResults: null,
        currentMode: 'default',
        filterSettings: {},
        currentConfigId: null,
        currentConfigName: null,
        fallbackStats: {
          totalChecks: 0,
          fallbackCount: 0,
          undefinedPaths: new Set(),
        },
      },
      files: {
        originalFileA: null,
        originalFileB: null,
      },
      viewer: {
        adapter: this.state.viewer?.adapter || null, // アダプターは保持
        useCommonViewer: this.state.viewer?.useCommonViewer || false,
      },
    };
  }
}

// シングルトンインスタンス
const globalState = new ApplicationState();

// 開発時のデバッグ用にwindowに公開
if (typeof window !== 'undefined') {
  window.globalState = globalState;
}

export default globalState;

/**
 * 便利な関数をエクスポート
 */
export const setState = (path, value) => globalState.set(path, value);
export const getState = (path) => globalState.get(path);
export const addStateListener = (path, listener) => globalState.addListener(path, listener);
export const registerGlobalFunction = (name, func) => globalState.registerFunction(name, func);
export const resetApplicationState = () => globalState.reset();

// 重要度機能専用の便利関数
export const setImportanceState = (path, value) => globalState.set(`importance.${path}`, value);
export const getImportanceState = (path) => globalState.get(`importance.${path}`);
