/**
 * @fileoverview PDF.js注入境界。実ライブラリの配布設定は呼出し側の責務。
 * ページ表示は必ずPDF.jsのviewportを使い、DPRを保存座標へ混ぜない。
 */
import { sha256 } from '../../utils/sha256.js';

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_PIXELS = 16 * 1024 * 1024;

function abortError(message = 'PDF処理を中止しました。') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function positive(value, label) {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(`${label}は正の有限値にしてください。`);
  return value;
}

function invertAffine(matrix, label = 'PDF.jsのviewport変換') {
  if (!Array.isArray(matrix) || matrix.length !== 6 || !matrix.every(Number.isFinite))
    throw new TypeError(`${label}が不正です。`);
  const [a, b, c, d, e, f] = matrix;
  const size = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
  const det = a * d - b * c;
  if (!Number.isFinite(det) || size === 0 || Math.abs(det) <= size * size * 1e-12)
    throw new Error(`${label}が特異です。`);
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** PDF.jsの実物、Worker、資産URLを明示注入する。代替図面へフォールバックしない。 */
export class PdfDocumentAdapter {
  constructor({
    pdfjs,
    worker = null,
    assetUrls = {},
    createCanvas = () => document.createElement('canvas'),
    digest = sha256,
    maxBytes = DEFAULT_MAX_BYTES,
    maxPixels = DEFAULT_MAX_PIXELS,
    maxCanvasSide = 8192,
  } = {}) {
    if (typeof pdfjs?.getDocument !== 'function')
      throw new TypeError('PDF.jsのgetDocumentを注入してください。');
    if (typeof createCanvas !== 'function' || typeof digest !== 'function')
      throw new TypeError('Canvas生成・ハッシュ関数が必要です。');
    this.pdfjs = pdfjs;
    this.worker = worker;
    this.assetUrls = {};
    for (const name of ['cMapUrl', 'standardFontDataUrl', 'wasmUrl', 'iccUrl']) {
      if (assetUrls[name] != null) {
        if (typeof assetUrls[name] !== 'string')
          throw new TypeError('PDF資産URLは文字列で指定してください。');
        this.assetUrls[name] = assetUrls[name];
      }
    }
    this.destroyedTasks = new WeakMap();
    this.createCanvas = createCanvas;
    this.digest = digest;
    this.maxBytes = positive(maxBytes, 'PDFサイズ上限');
    this.maxPixels = positive(maxPixels, '描画画素数上限');
    this.maxCanvasSide = positive(maxCanvasSide, 'Canvas辺長上限');
    this.generation = 0;
    this.renderGeneration = 0;
    this.loadingTask = null;
    this.pdf = null;
    this.renderTask = null;
    this.info = null;
  }

  destroyTask(task) {
    if (!task) return Promise.resolve();
    if (!this.destroyedTasks.has(task)) {
      this.destroyedTasks.set(
        task,
        Promise.resolve().then(() => task.destroy()),
      );
    }
    return this.destroyedTasks.get(task);
  }

  async cancelRender() {
    this.renderGeneration += 1;
    const task = this.renderTask;
    this.renderTask = null;
    if (!task) return;
    task.cancel();
    // 取消完了前に同じpageの資源を解放しない。
    await task.promise.catch(() => {});
  }

  async close() {
    this.generation += 1;
    const loading = this.loadingTask;
    this.loadingTask = null;
    this.pdf = null;
    this.info = null;
    const renderDone = this.cancelRender();
    const destroyDone = this.destroyTask(loading);
    await Promise.all([renderDone, destroyDone]);
  }

  /** File/Blobのバイト列を読み込む。外部URLやPDFのスクリプトは実行しない。 */
  async open(file, { requestPassword = null } = {}) {
    const closing = this.close();
    const generation = this.generation;
    await closing;
    const assertCurrent = () => {
      if (generation !== this.generation) throw abortError();
    };
    assertCurrent();
    if (
      typeof file?.arrayBuffer !== 'function' ||
      !Number.isFinite(file.size) ||
      file.size <= 0 ||
      file.size > this.maxBytes
    )
      throw new RangeError('PDFが空、サイズ超過、またはFile/Blobではありません。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    assertCurrent();
    if (bytes.length === 0 || bytes.length > this.maxBytes)
      throw new RangeError('PDFの実バイト数が上限を超えています。');
    const header = new TextDecoder('ascii').decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
    if (!header.includes('%PDF-')) throw new TypeError('PDFヘッダーがありません。');
    // Workerへ所有権が移る前に識別する。
    const byteLength = bytes.length;
    const hash = await this.digest(bytes);
    assertCurrent();
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))
      throw new TypeError('SHA-256が不正です。');
    const task = this.pdfjs.getDocument({
      ...this.assetUrls,
      cMapPacked: true,
      data: bytes,
      ...(this.worker ? { worker: this.worker } : {}),
      enableXfa: false,
      stopAtErrors: true,
      // Viewer/ScriptingManager/HTML annotation layerは構築しない。
    });
    this.loadingTask = task;
    let passwordFailure = null;
    let rejectPassword;
    const passwordRejected = new Promise((_, reject) => {
      rejectPassword = reject;
    });
    task.onPassword = (updatePassword, reason) => {
      Promise.resolve()
        .then(async () => {
          if (typeof requestPassword !== 'function') throw new Error('パスワードが必要なPDFです。');
          const password = await requestPassword({ reason, filename: file.name || '' });
          assertCurrent();
          if (password == null) throw abortError('パスワード入力を中止しました。');
          if (typeof password !== 'string')
            throw new TypeError('パスワードは文字列で指定してください。');
          updatePassword(password);
        })
        .catch((error) => {
          passwordFailure = error;
          rejectPassword(error);
        });
    };
    try {
      const pdf = await Promise.race([task.promise, passwordRejected]);
      assertCurrent();
      if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1)
        throw new Error('PDFのページ数が不正です。');
      this.pdf = pdf;
      this.info = Object.freeze({
        filename: file.name || '',
        sha256: hash,
        byteLength,
        numPages: pdf.numPages,
      });
      return this.info;
    } catch (error) {
      if (this.loadingTask === task) {
        this.loadingTask = null;
        this.pdf = null;
        this.info = null;
      }
      await this.destroyTask(task).catch(() => {});
      if (generation !== this.generation) throw abortError();
      throw passwordFailure || error;
    }
  }

  /**
   * 新しいCanvasへ描画し、完了後だけ返す。古い描画結果を採用しない。
   * rotationはPDF固有回転に加える表示回転（90度単位）。
   */
  async renderPage(
    pageNumber,
    { scale = 1, rotation = 0, outputScale = globalThis.devicePixelRatio || 1 } = {},
  ) {
    const pdf = this.pdf;
    const generation = this.generation;
    if (!pdf) throw new Error('PDFを読み込んでください。');
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages)
      throw new RangeError('ページ番号が範囲外です。');
    positive(scale, '表示倍率');
    positive(outputScale, '描画倍率');
    if (!Number.isInteger(rotation) || rotation % 90 !== 0)
      throw new RangeError('表示回転は90度単位です。');
    const cancelling = this.cancelRender();
    const renderGeneration = this.renderGeneration;
    const assertCurrent = () => {
      if (generation !== this.generation || renderGeneration !== this.renderGeneration)
        throw abortError();
    };
    await cancelling;
    assertCurrent();
    let page;
    let task;
    try {
      page = await pdf.getPage(pageNumber);
      assertCurrent();
      const box = [...page.view];
      if (box.length !== 4 || !box.every(Number.isFinite) || box[2] <= box[0] || box[3] <= box[1])
        throw new Error('PDFページ範囲が不正です。');
      positive(page.userUnit, 'PDF UserUnit');
      if (!Number.isInteger(page.rotate) || page.rotate % 90 !== 0)
        throw new Error('PDF固有回転が不正です。');
      const effectiveRotation = (((page.rotate + rotation) % 360) + 360) % 360;
      const viewport = page.getViewport({ scale, rotation: effectiveRotation });
      positive(viewport.width, 'ページ幅');
      positive(viewport.height, 'ページ高さ');
      const pdfToCss = [...viewport.transform];
      const cssToPdf = invertAffine(pdfToCss);
      const ratio = Math.min(
        outputScale,
        Math.sqrt(this.maxPixels / (viewport.width * viewport.height)),
        this.maxCanvasSide / viewport.width,
        this.maxCanvasSide / viewport.height,
      );
      positive(ratio, '出力解像度');
      const canvas = this.createCanvas();
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      if (canvas.style) {
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
      }
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas 2D contextを取得できません。');
      task = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: [ratio, 0, 0, ratio, 0, 0],
        annotationMode: this.pdfjs.AnnotationMode?.ENABLE ?? 1,
      });
      this.renderTask = task;
      await task.promise;
      assertCurrent();
      return {
        canvas,
        pageNumber,
        // page.view は PDF.js が採用した未回転 user-space の可視範囲
        // （CropBox と MediaBox の交差を反映）。保存座標の正本として保持する。
        box,
        viewBox: [...box],
        userUnit: page.userUnit,
        intrinsicRotation: page.rotate,
        rotation: effectiveRotation,
        width: viewport.width,
        height: viewport.height,
        pdfToCss,
        cssToPdf,
        outputScale: ratio,
        resolutionCapped: ratio < outputScale,
      };
    } catch (error) {
      assertCurrent();
      throw error;
    } finally {
      if (this.renderTask === task) this.renderTask = null;
      page?.cleanup?.();
    }
  }
}
