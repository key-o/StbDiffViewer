/**
 * @fileoverview Viewer runtime lifecycle primitives.
 *
 * WebGLRenderer の animation loop と viewport resize listener の開始/停止を
 * 明示的なライフサイクルとして管理する。core.js は Three.js 固有の描画判断を
 * 保持し、このモジュールは副作用の登録/解除だけを担当する。
 */

/**
 * WebGLRenderer.setAnimationLoop の登録状態を管理する。
 */
export class AnimationLoopController {
  /**
   * @param {{getRenderer: () => Object|null, frameHandler: Function}} options
   */
  constructor({ getRenderer, frameHandler }) {
    this._getRenderer = getRenderer;
    this._frameHandler = frameHandler;
    this._running = false;
    this._attachedRenderer = null;
    this._boundFrame = (...args) => this._frameHandler(...args);
  }

  /**
   * animation loop を開始する。同じrendererで開始済みなら何もしない。
   * rendererが差し替わっていた場合は旧rendererから解除して付け替える。
   * @returns {boolean} 新たに登録した場合 true
   */
  start() {
    const renderer = this._getRenderer?.();
    if (!renderer || typeof renderer.setAnimationLoop !== 'function') return false;

    if (this._running && this._attachedRenderer === renderer) return false;
    if (this._running) this.stop();

    renderer.setAnimationLoop(this._boundFrame);
    this._attachedRenderer = renderer;
    this._running = true;
    return true;
  }

  /** animation loop を解除する。 */
  stop() {
    if (this._attachedRenderer && typeof this._attachedRenderer.setAnimationLoop === 'function') {
      this._attachedRenderer.setAnimationLoop(null);
    }
    this._attachedRenderer = null;
    this._running = false;
  }

  /** @returns {boolean} */
  isRunning() {
    return this._running;
  }
}

/**
 * window resize と ResizeObserver を一つのライフサイクルとして管理する。
 */
export class ViewportResizeController {
  /**
   * @param {{
   *   getCanvas: () => HTMLElement|null,
   *   onResize: Function,
   *   isBlocked?: () => boolean,
   *   getWindow?: () => Window|null,
   *   getResizeObserverClass?: () => Function|null,
   *   scheduleFrame?: (callback: Function) => *,
   * }} options
   */
  constructor({
    getCanvas,
    onResize,
    isBlocked = () => false,
    getWindow = () => globalThis.window ?? null,
    getResizeObserverClass = () => globalThis.ResizeObserver ?? null,
    scheduleFrame = (callback) => {
      const windowObject = getWindow();
      if (typeof windowObject?.requestAnimationFrame === 'function') {
        return windowObject.requestAnimationFrame(callback);
      }
      return globalThis.setTimeout(callback, 0);
    },
  }) {
    this._getCanvas = getCanvas;
    this._onResize = onResize;
    this._isBlocked = isBlocked;
    this._getWindow = getWindow;
    this._getResizeObserverClass = getResizeObserverClass;
    this._scheduleFrame = scheduleFrame;

    this._active = false;
    this._windowObject = null;
    this._observedCanvas = null;
    this._resizeObserver = null;
    this._frameQueued = false;
    this._windowResizeHandler = () => this._queueResize();
  }

  _queueResize() {
    if (this._frameQueued) return;
    this._frameQueued = true;
    this._scheduleFrame(() => {
      this._frameQueued = false;
      if (!this._active || this._isBlocked()) return;
      this._onResize();
    });
  }

  /**
   * listener/observer を登録する。canvasが変わっていれば付け替える。
   * @returns {boolean} 新たに登録した場合 true
   */
  start() {
    const windowObject = this._getWindow?.();
    const canvas = this._getCanvas?.();
    if (!windowObject) return false;

    if (this._active && this._windowObject === windowObject && this._observedCanvas === canvas) {
      return false;
    }
    if (this._active) this.dispose();

    this._windowObject = windowObject;
    this._observedCanvas = canvas;
    this._windowObject.addEventListener('resize', this._windowResizeHandler, false);

    const ResizeObserverClass = this._getResizeObserverClass?.();
    if (ResizeObserverClass && canvas) {
      this._resizeObserver = new ResizeObserverClass(() => this._queueResize());
      this._resizeObserver.observe(canvas);
    }

    this._active = true;
    return true;
  }

  /** listener/observer を解除する。 */
  dispose() {
    if (this._windowObject) {
      this._windowObject.removeEventListener('resize', this._windowResizeHandler, false);
    }
    this._resizeObserver?.disconnect?.();

    this._active = false;
    this._windowObject = null;
    this._observedCanvas = null;
    this._resizeObserver = null;
    this._frameQueued = false;
  }

  /** @returns {boolean} */
  isActive() {
    return this._active;
  }
}
