/**
 * 仮想スクロールコンポーネント
 *
 * 大量の要素を効率的に表示するための仮想スクロール機能を提供
 * - 表示領域の要素のみDOMに追加
 * - スクロール位置に応じて動的に要素を入れ替え
 * - 要素数が閾値（デフォルト1000）を超える場合に自動適用
 */

/**
 * 仮想スクロールの設定
 */
const DEFAULT_CONFIG = {
  /** 仮想スクロールを有効にする要素数の閾値 */
  threshold: 1000,
  /** 1アイテムの高さ（px） */
  itemHeight: 28,
  /** 表示領域外に追加でレンダリングするバッファアイテム数 */
  bufferSize: 10,
  /** スクロールイベントのデバウンス時間（ms） */
  debounceTime: 16,
};

/**
 * 仮想スクロールマネージャー
 */
export class VirtualScrollManager {
  /**
   * @param {HTMLElement} container - スクロールコンテナ
   * @param {Object} options - オプション
   * @param {number} [options.threshold] - 仮想スクロールを有効にする閾値
   * @param {number} [options.itemHeight] - アイテムの高さ
   * @param {number} [options.bufferSize] - バッファサイズ
   * @param {Function} [options.renderItem] - アイテムをレンダリングする関数
   */
  constructor(container, options = {}) {
    this.container = container;
    this.config = { ...DEFAULT_CONFIG, ...options };
    this.items = [];
    this.renderedItems = new Map(); // index -> DOM element
    this.scrollTop = 0;
    this.containerHeight = 0;
    this.isEnabled = false;
    this.renderItem = options.renderItem || null;

    // 内部コンテナを作成
    this.viewport = null;
    this.content = null;
    this.spacerTop = null;
    this.spacerBottom = null;

    // スクロールハンドラ
    this.handleScroll = this._debounce(this._onScroll.bind(this), this.config.debounceTime);
    this.resizeObserver = null;
  }

  /**
   * 仮想スクロールを初期化
   * @param {Array} items - 表示するアイテムの配列
   */
  initialize(items) {
    this.items = items || [];
    this.isEnabled = this.items.length >= this.config.threshold;

    if (!this.isEnabled) {
      // 閾値未満の場合は通常のレンダリング
      return false;
    }

    this._setupDOM();
    this._setupEventListeners();
    this._updateContainerHeight();
    this._render();

    return true;
  }

  /**
   * DOM構造をセットアップ
   * @private
   */
  _setupDOM() {
    // 既存のコンテンツをクリア
    this.container.innerHTML = '';

    // ビューポートを作成
    this.viewport = document.createElement('div');
    this.viewport.className = 'virtual-scroll-viewport';
    this.viewport.style.cssText = `
      height: 100%;
      overflow-y: auto;
      position: relative;
    `;

    // コンテンツコンテナを作成
    this.content = document.createElement('div');
    this.content.className = 'virtual-scroll-content';
    this.content.style.cssText = `
      position: relative;
      width: 100%;
    `;

    // 上部スペーサー
    this.spacerTop = document.createElement('div');
    this.spacerTop.className = 'virtual-scroll-spacer-top';
    this.spacerTop.style.cssText = 'width: 100%;';

    // 下部スペーサー
    this.spacerBottom = document.createElement('div');
    this.spacerBottom.className = 'virtual-scroll-spacer-bottom';
    this.spacerBottom.style.cssText = 'width: 100%;';

    // アイテムコンテナ
    this.itemsContainer = document.createElement('div');
    this.itemsContainer.className = 'virtual-scroll-items';

    this.content.appendChild(this.spacerTop);
    this.content.appendChild(this.itemsContainer);
    this.content.appendChild(this.spacerBottom);
    this.viewport.appendChild(this.content);
    this.container.appendChild(this.viewport);
  }

  /**
   * イベントリスナーをセットアップ
   * @private
   */
  _setupEventListeners() {
    this.viewport.addEventListener('scroll', this.handleScroll);

    // リサイズ監視
    this.resizeObserver = new ResizeObserver(() => {
      this._updateContainerHeight();
      this._render();
    });
    this.resizeObserver.observe(this.viewport);
  }

  /**
   * コンテナの高さを更新
   * @private
   */
  _updateContainerHeight() {
    if (!this.viewport) return;
    this.containerHeight = this.viewport.clientHeight;
  }

  /**
   * スクロールイベントハンドラ
   * @private
   */
  _onScroll() {
    if (!this.viewport) return;
    this.scrollTop = this.viewport.scrollTop;
    this._render();
  }

  /**
   * 表示範囲を計算
   * @private
   * @returns {{startIndex: number, endIndex: number}}
   */
  _calculateVisibleRange() {
    const { itemHeight, bufferSize } = this.config;
    const totalItems = this.items.length;

    // 表示開始インデックス
    let startIndex = Math.floor(this.scrollTop / itemHeight) - bufferSize;
    startIndex = Math.max(0, startIndex);

    // 表示終了インデックス
    const visibleCount = Math.ceil(this.containerHeight / itemHeight);
    let endIndex = startIndex + visibleCount + bufferSize * 2;
    endIndex = Math.min(totalItems - 1, endIndex);

    return { startIndex, endIndex };
  }

  /**
   * 表示をレンダリング
   * @private
   */
  _render() {
    if (!this.isEnabled || !this.viewport) return;

    const { startIndex, endIndex } = this._calculateVisibleRange();
    const { itemHeight } = this.config;
    const totalHeight = this.items.length * itemHeight;

    // スペーサーの高さを更新
    const topSpacerHeight = startIndex * itemHeight;
    const bottomSpacerHeight = totalHeight - (endIndex + 1) * itemHeight;

    this.spacerTop.style.height = `${topSpacerHeight}px`;
    this.spacerBottom.style.height = `${Math.max(0, bottomSpacerHeight)}px`;

    // 不要なアイテムを削除
    for (const [index, element] of this.renderedItems) {
      if (index < startIndex || index > endIndex) {
        element.remove();
        this.renderedItems.delete(index);
      }
    }

    // 必要なアイテムを追加
    const fragment = document.createDocumentFragment();
    const itemsToAdd = [];

    for (let i = startIndex; i <= endIndex; i++) {
      if (!this.renderedItems.has(i)) {
        const item = this.items[i];
        if (item && this.renderItem) {
          const element = this.renderItem(item, i);
          if (element) {
            element.style.position = 'absolute';
            element.style.top = `${i * itemHeight}px`;
            element.style.width = '100%';
            element.dataset.virtualIndex = i;
            itemsToAdd.push({ index: i, element });
            fragment.appendChild(element);
          }
        }
      }
    }

    // 新しいアイテムを追加
    if (itemsToAdd.length > 0) {
      this.itemsContainer.appendChild(fragment);
      for (const { index, element } of itemsToAdd) {
        this.renderedItems.set(index, element);
      }
    }

    // コンテンツの総高さを設定
    this.content.style.height = `${totalHeight}px`;
  }

  /**
   * アイテムを更新
   * @param {Array} items - 新しいアイテム配列
   */
  updateItems(items) {
    this.items = items || [];

    // 閾値チェック
    const shouldEnable = this.items.length >= this.config.threshold;

    if (shouldEnable !== this.isEnabled) {
      if (shouldEnable) {
        this.isEnabled = true;
        this._setupDOM();
        this._setupEventListeners();
      } else {
        this.destroy();
        return false;
      }
    }

    if (this.isEnabled) {
      // 既存のレンダリングをクリア
      this.renderedItems.clear();
      this.itemsContainer.innerHTML = '';
      this._render();
    }

    return this.isEnabled;
  }

  /**
   * 特定のインデックスにスクロール
   * @param {number} index - スクロール先のインデックス
   * @param {string} [align='start'] - 位置合わせ ('start', 'center', 'end')
   */
  scrollToIndex(index, align = 'start') {
    if (!this.isEnabled || !this.viewport) return;

    const { itemHeight } = this.config;
    let scrollTop = index * itemHeight;

    if (align === 'center') {
      scrollTop -= (this.containerHeight - itemHeight) / 2;
    } else if (align === 'end') {
      scrollTop -= this.containerHeight - itemHeight;
    }

    this.viewport.scrollTop = Math.max(0, scrollTop);
  }

  /**
   * 特定のアイテムを検索してスクロール
   * @param {Function} predicate - 検索条件
   * @param {string} [align='start'] - 位置合わせ
   * @returns {number} 見つかったインデックス（見つからない場合は-1）
   */
  scrollToItem(predicate, align = 'start') {
    const index = this.items.findIndex(predicate);
    if (index !== -1) {
      this.scrollToIndex(index, align);
    }
    return index;
  }

  /**
   * 仮想スクロールが有効かどうか
   * @returns {boolean}
   */
  isVirtualScrollEnabled() {
    return this.isEnabled;
  }

  /**
   * 現在の表示範囲を取得
   * @returns {{startIndex: number, endIndex: number}|null}
   */
  getVisibleRange() {
    if (!this.isEnabled) return null;
    return this._calculateVisibleRange();
  }

  /**
   * デバウンス関数
   * @private
   */
  _debounce(func, wait) {
    let timeout;
    const debounced = function executedFunction(...args) {
      const later = () => {
        timeout = undefined;
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
    debounced.cancel = () => {
      clearTimeout(timeout);
      timeout = undefined;
    };
    return debounced;
  }

  /**
   * クリーンアップ
   */
  destroy() {
    this.handleScroll.cancel?.();
    if (this.viewport) {
      this.viewport.removeEventListener('scroll', this.handleScroll);
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.renderedItems.clear();
    this.isEnabled = false;
    this.viewport = null;
    this.content = null;
    this.itemsContainer = null;
    this.spacerTop = null;
    this.spacerBottom = null;
  }
}
