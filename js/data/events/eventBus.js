/**
 * @fileoverview イベントバスモジュール
 *
 * レイヤー間の疎結合通信を実現するイベントバスの実装。
 * Pub/Subパターンに基づき、コンポーネント間の直接依存を排除します。
 *
 * Layer 1 (data) に配置し、app/services/viewer/ui からimport可能です。
 *
 * 特徴:
 * - 型安全なイベント名（constants/eventTypesモジュールと連携）
 * - レガシーイベントとの後方互換性
 * - 開発時のデバッグサポート
 * - イベント履歴の追跡（オプション）
 *
 * @module data/events/eventBus
 */

import { createLogger } from '../../utils/logger.js';

const log = createLogger('data:events:eventBus');

/**
 * @typedef {Object} EventListener
 * @property {Function} callback - イベントコールバック関数
 * @property {Object} [context] - コールバックのthisコンテキスト
 * @property {boolean} [once] - 一度だけ実行するかどうか
 */

/**
 * @typedef {Object} EventBusOptions
 * @property {boolean} [debug=false] - デバッグモードを有効にする
 * @property {boolean} [trackHistory=false] - イベント履歴を追跡する
 * @property {number} [maxHistorySize=100] - 保持する履歴の最大数
 */

/**
 * イベントバスクラス
 * アプリケーション全体のイベント通信を管理します。
 */
class EventBus {
  /**
   * @param {EventBusOptions} options - オプション設定
   */
  constructor(options = {}) {
    /** @private @type {Map<string, Set<EventListener>>} */
    this._listeners = new Map();

    /** @private @type {boolean} */
    this._debug = options.debug ?? false;

    /** @private @type {boolean} */
    this._trackHistory = options.trackHistory ?? false;

    /** @private @type {number} */
    this._maxHistorySize = options.maxHistorySize ?? 100;

    /** @private @type {Array<{eventType: string, data: any, timestamp: number}>} */
    this._history = [];
  }

  /**
   * イベントリスナーを登録
   * @param {string} eventType - イベントタイプ
   * @param {Function} callback - コールバック関数
   * @param {Object} [context] - コールバックのthisコンテキスト
   * @returns {Function} リスナーを解除するための関数
   */
  on(eventType, callback, context = null) {
    if (typeof callback !== 'function') {
      throw new Error('EventBus.on: callback must be a function');
    }

    if (!this._listeners.has(eventType)) {
      this._listeners.set(eventType, new Set());
    }

    const listener = { callback, context, once: false };
    this._listeners.get(eventType).add(listener);

    // 解除関数は登録した listener オブジェクトを直接削除する
    return () => this._removeListener(eventType, listener);
  }

  /**
   * 一度だけ実行されるイベントリスナーを登録
   * @param {string} eventType - イベントタイプ
   * @param {Function} callback - コールバック関数
   * @param {Object} [context] - コールバックのthisコンテキスト
   * @returns {Function} リスナーを解除するための関数
   */
  once(eventType, callback, context = null) {
    if (typeof callback !== 'function') {
      throw new Error('EventBus.once: callback must be a function');
    }

    if (!this._listeners.has(eventType)) {
      this._listeners.set(eventType, new Set());
    }

    const listener = { callback, context, once: true };
    this._listeners.get(eventType).add(listener);

    return () => this._removeListener(eventType, listener);
  }

  /**
   * 特定の listener オブジェクトを削除
   * @private
   * @param {string} eventType
   * @param {EventListener} listener
   */
  _removeListener(eventType, listener) {
    const listeners = this._listeners.get(eventType);
    if (!listeners) return;
    listeners.delete(listener);
    if (listeners.size === 0) {
      this._listeners.delete(eventType);
    }
  }

  /**
   * イベントリスナーを解除
   * @param {string} eventType - イベントタイプ
   * @param {Function} [callback] - 解除するコールバック（省略時は全リスナーを解除）
   */
  off(eventType, callback) {
    if (!this._listeners.has(eventType)) {
      return;
    }

    if (!callback) {
      // 全リスナーを解除
      this._listeners.delete(eventType);
      return;
    }

    const listeners = this._listeners.get(eventType);
    for (const listener of listeners) {
      if (listener.callback === callback) {
        listeners.delete(listener);
        break;
      }
    }

    // 空になったらMapからも削除
    if (listeners.size === 0) {
      this._listeners.delete(eventType);
    }
  }

  /**
   * イベントを発行
   * @param {string} eventType - イベントタイプ
   * @param {*} [data] - イベントデータ
   */
  emit(eventType, data = null) {
    if (this._deferredEvents?.types.has(eventType)) {
      this._deferredEvents.queue.push([eventType, data]);
      return;
    }
    // 履歴を追跡
    if (this._trackHistory) {
      this._addToHistory(eventType, data);
    }

    // リスナーに通知
    if (this._listeners.has(eventType)) {
      const listeners = this._listeners.get(eventType);
      const toRemove = [];

      for (const listener of listeners) {
        try {
          if (listener.context) {
            listener.callback.call(listener.context, data);
          } else {
            listener.callback(data);
          }

          // onceリスナーは実行後に削除
          if (listener.once) {
            toRemove.push(listener);
          }
        } catch (error) {
          log.error(`[EventBus] Error in listener for ${eventType}:`, error);
        }
      }

      // onceリスナーを削除
      for (const listener of toRemove) {
        listeners.delete(listener);
      }
    }
  }

  /** Publish model lifecycle notifications only after a replacement has succeeded. */
  deferEvents(eventTypes) {
    if (this._deferredEvents) throw new Error('An event transaction is already active');
    const pending = { types: new Set(eventTypes), queue: [] };
    this._deferredEvents = pending;
    const finish = (publish, mapEvent = null) => {
      if (this._deferredEvents !== pending) return;
      if (publish && mapEvent != null && typeof mapEvent !== 'function')
        throw new TypeError('mapEvent must be a function');
      this._deferredEvents = null;
      if (publish)
        for (const [type, data] of pending.queue)
          this.emit(type, mapEvent ? mapEvent(type, data) : data);
      pending.queue.length = 0;
    };
    return {
      commit: ({ mapEvent } = {}) => finish(true, mapEvent),
      rollback: () => finish(false),
    };
  }

  /**
   * 履歴にイベントを追加
   * @private
   * @param {string} eventType - イベントタイプ
   * @param {*} data - イベントデータ
   */
  _addToHistory(eventType, data) {
    this._history.push({
      eventType,
      data,
      timestamp: Date.now(),
    });

    // 最大サイズを超えたら古いものを削除
    while (this._history.length > this._maxHistorySize) {
      this._history.shift();
    }
  }

  /**
   * イベント履歴を取得
   * @param {string} [eventType] - フィルタするイベントタイプ（省略時は全履歴）
   * @returns {Array} イベント履歴
   */
  getHistory(eventType = null) {
    if (eventType) {
      return this._history.filter((h) => h.eventType === eventType);
    }
    return [...this._history];
  }

  /**
   * イベント履歴をクリア
   */
  clearHistory() {
    this._history = [];
  }

  /**
   * 特定のイベントタイプのリスナー数を取得
   * @param {string} eventType - イベントタイプ
   * @returns {number} リスナー数
   */
  listenerCount(eventType) {
    return this._listeners.has(eventType) ? this._listeners.get(eventType).size : 0;
  }

  /**
   * 登録されている全イベントタイプを取得
   * @returns {string[]} イベントタイプの配列
   */
  getEventTypes() {
    return Array.from(this._listeners.keys());
  }

  /**
   * 全リスナーを解除
   */
  removeAllListeners() {
    this._listeners.clear();
  }

  /**
   * デバッグモードを設定
   * @param {boolean} enabled - デバッグモードを有効にするか
   */
  setDebug(enabled) {
    this._debug = enabled;
  }

  /**
   * 履歴追跡を設定
   * @param {boolean} enabled - 履歴追跡を有効にするか
   */
  setTrackHistory(enabled) {
    this._trackHistory = enabled;
  }
}

// シングルトンインスタンスを作成・エクスポート
const eventBus = new EventBus({
  debug: false, // 本番環境ではfalse
  trackHistory: false, // 必要に応じて有効化
});

export { EventBus, eventBus };
export default eventBus;
