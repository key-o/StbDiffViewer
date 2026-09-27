/** @fileoverview PDF図面照合モードの初期UI。PDF Canvas + STB SVGを同一viewportへ重ねる。 */
import { getState } from '../../../data/state/globalState.js';
import { parseStories } from '../../../common-stb/import/parser/stbParserCore.js';
import { loadPdfJsRuntime, getPdfJsRuntimeInfo } from '../../../parser/pdf/pdfJsRuntime.js';
import { multiplyAffine, transformPoint } from '../../../data/drawing/affine2d.js';
import {
  eventBus,
  InteractionEvents,
  MeasurementEvents,
  ModelEvents,
} from '../../../data/events/index.js';
import {
  createManualPlacementFromDisplay,
  rescaleManualPlacement,
  translateManualPlacementFromDisplay,
} from '../../../app/pdfOverlay/displayRegistrationState.js';
import { PdfOverlayRegionController } from './PdfOverlayRegionController.js';
import { PdfOverlaySessionController } from './PdfOverlaySessionController.js';
import { PdfOverlayMeasurementController } from './PdfOverlayMeasurementController.js';
import { exportAnnotatedPdf } from './PdfOverlayPdfExporter.js';
import { buildPdfOverlayPanelMarkup } from './pdfOverlayPanelMarkup.js';
import { resolvePdfOverlayTreeSelection } from './pdfOverlaySelection.js';
import { renderPdfOverlayDiagnostics } from './PdfOverlayDiagnosticsView.js';
import { make, num, resolveScaleDenominator, storyView } from './pdfOverlayPanelHelpers.js';
import { appendAlignmentCandidateMarkers, appendAlignmentGizmo } from './alignmentGizmo2d.js';
import {
  formatPdfOverlayViewZoom,
  nextPdfOverlayViewZoom,
  resolveOverlayViewportMode,
  sheetPreviewPxPerMm,
} from './pdfOverlayViewportZoom.js';
import { showError, showInfo, showSuccess, showWarning } from '../../common/toast.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('PdfOverlayPanel');
const WINDOW_ID = 'pdf-overlay-panel';
let panel = null;

function hasFileDrag(event) {
  return Array.from(event?.dataTransfer?.types || []).includes('Files');
}

export function isPdfFile(file) {
  if (!file || typeof file.name !== 'string') return false;
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

export class PdfOverlayPanelController {
  constructor(root) {
    this.root = root;
    this.services = null;
    this.pdfAdapter = null;
    this.pageRender = null;
    this.drawing = null;
    this.registration = null;
    this.manualPlacement = null;
    this.anchorPickTarget = null;
    this.abortController = null;
    this.alignmentCandidates = [];
    this.gizmoOrigin = null;
    this.gizmoPickOrigin = false;
    this.currentModelToCss = null;
    this.viewZoom = 1;
    this.zoomRenderTimer = null;
    this.zoomRenderPromise = null;
    this.zoomRenderSequence = 0;
    this.pdfRenderPromise = null;
    this.pendingZoomFocus = null;
    this.pendingZoomMode = null;
    this.viewportPan = null;
    this.pdfDragDepth = 0;
    this.exportingPdf = false;
    this.elements = {};
    this.bindElements();
    this.regionUi = new PdfOverlayRegionController(this);
    this.sessionUi = new PdfOverlaySessionController(this);
    this.measurementUi = new PdfOverlayMeasurementController(this);
    this.bindEvents();
    this.regionUi.bindEvents();
    this.refreshModelAndStories();
    this.updatePdfFeatureAvailability();
  }

  bindElements() {
    for (const id of [
      'pdf-overlay-file',
      'pdf-overlay-model',
      'pdf-overlay-story',
      'pdf-overlay-page',
      'pdf-overlay-rotation',
      'pdf-overlay-scale',
      'pdf-overlay-custom-scale',
      'pdf-overlay-custom-scale-wrap',
      'pdf-overlay-display-mode',
      'pdf-overlay-opacity',
      'pdf-overlay-labels',
      'pdf-overlay-status',
      'pdf-overlay-zoom-value',
      'pdf-overlay-scroll',
      'pdf-overlay-stage',
      'pdf-overlay-canvas-layer',
      'pdf-overlay-svg-layer',
      'pdf-overlay-a-mx',
      'pdf-overlay-a-my',
      'pdf-overlay-a-px',
      'pdf-overlay-a-py',
      'pdf-overlay-b-mx',
      'pdf-overlay-b-my',
      'pdf-overlay-b-px',
      'pdf-overlay-b-py',
      'pdf-overlay-c-mx',
      'pdf-overlay-c-my',
      'pdf-overlay-c-px',
      'pdf-overlay-c-py',
      'pdf-overlay-registration-result',
      'pdf-overlay-element-info',
      'pdf-overlay-gizmo-enabled',
      'pdf-overlay-gizmo-candidate-type',
      'pdf-overlay-gizmo-origin-info',
      'pdf-overlay-region-status',
      'pdf-overlay-diagnostics',
      'pdf-overlay-region-selection-box',
      'pdf-overlay-drop-overlay',
    ])
      this.elements[id] = this.root.querySelector(`#${id}`);
  }

  get e() {
    return this.elements;
  }

  resetMeasurementSequence(reason = 'pdf-tool-switch') {
    eventBus.emit(MeasurementEvents.SEQUENCE_RESET, {
      targetSurface: 'pdf-overlay',
      reason,
    });
  }

  clearAnchorInputs(space = 'all') {
    for (const key of ['a', 'b', 'c']) {
      if (space === 'all' || space === 'model') {
        this.e[`pdf-overlay-${key}-mx`].value = '0';
        this.e[`pdf-overlay-${key}-my`].value = '0';
      }
      if (space === 'all' || space === 'pdf') {
        this.e[`pdf-overlay-${key}-px`].value = '0';
        this.e[`pdf-overlay-${key}-py`].value = '0';
      }
    }
  }

  resetPlacementState(message = '未設定', invalidationCode = 'ALIGNMENT_MISSING') {
    this.registration = null;
    this.manualPlacement = null;
    this.anchorPickTarget = null;
    this.currentModelToCss = null;
    this.e['pdf-overlay-registration-result'].textContent = message;
    this.sessionUi?.invalidateReviews(invalidationCode);
  }

  invalidateDrawing(message) {
    this.measurementUi?.invalidateDrawing();
    this.abortController?.abort();
    this.abortController = null;
    this.drawing = null;
    this.regionUi.invalidateDrawing();
    this.alignmentCandidates = [];
    this.gizmoOrigin = null;
    this.gizmoPickOrigin = false;
    this.resetPlacementState();
    this.clearAnchorInputs('model');
    this.e['pdf-overlay-svg-layer'].replaceChildren();
    this.e['pdf-overlay-element-info'].textContent = '未選択';
    this.updatePdfFeatureAvailability();
    this.setStatus(message);
  }

  updatePdfFeatureAvailability() {
    const pdfPageReady = Boolean(this.pdfAdapter?.info && this.pageRender);
    const pdfViewReady =
      pdfPageReady && this.elements?.['pdf-overlay-display-mode']?.value === 'pdf';
    const stbPdfViewReady = Boolean(pdfViewReady && this.drawing && this.currentModelToCss);
    const setDisabled = (selector, disabled) => {
      const control = this.root?.querySelector(selector);
      if (control) control.disabled = disabled;
    };

    setDisabled('#pdf-overlay-export-pdf', !pdfPageReady || this.exportingPdf);
    setDisabled('#pdf-overlay-file', this.exportingPdf);
    setDisabled('#pdf-overlay-page', !pdfPageReady || this.exportingPdf);
    setDisabled('#pdf-overlay-rotation', !pdfPageReady || this.exportingPdf);
    setDisabled('#pdf-overlay-display-mode', this.exportingPdf);
    setDisabled('#pdf-overlay-select-region', !pdfPageReady);
    setDisabled('#pdf-overlay-export-session', !pdfPageReady);
    setDisabled('#pdf-overlay-add-drawing-memo', !pdfPageReady);
    setDisabled('#pdf-overlay-gizmo-pick-origin', !stbPdfViewReady);
    for (const key of ['a', 'b', 'c']) {
      setDisabled(`#pdf-overlay-pick-${key}`, !pdfViewReady);
      setDisabled(`#pdf-overlay-pick-model-${key}`, !stbPdfViewReady);
    }

    const status = this.root?.querySelector('#pdf-overlay-feature-prerequisites');
    if (!status) return;
    status.textContent = pdfPageReady
      ? 'PDF読込済み：PDF保存・領域選択・自由メモ配置・セッションJSON書き出しが利用できます。PDF上の基準点取得はPDF照合表示、STB候補点取得と寸法測定はPDF照合表示とSTB図面の生成が必要です。'
      : 'PDF未読込：PDF保存・領域選択・自由メモ配置・セッションJSON書き出し・PDF基準点取得・寸法測定にはPDFの読み込みが必要です。STB図面と部材メモはA3表示でも利用できます。';
  }

  bindEvents() {
    eventBus.on(ModelEvents.CLEARED, () => {
      this.invalidateDrawing('モデルが解除されました。STB図面を再生成してください。');
      this.refreshModelAndStories();
    });
    eventBus.on(ModelEvents.LOADED, ({ slot } = {}) => {
      if (slot !== this.e['pdf-overlay-model'].value) return;
      this.invalidateDrawing('モデルを更新しました。STB図面を再生成してください。');
      this.refreshModelAndStories();
    });
    this.e['pdf-overlay-model'].addEventListener('change', () => {
      this.invalidateDrawing('モデルを変更しました。STB図面を再生成してください。');
      this.refreshModelAndStories();
    });
    this.e['pdf-overlay-story'].addEventListener('change', () => {
      this.invalidateDrawing('階を変更しました。STB図面を再生成してください。');
    });
    this.e['pdf-overlay-display-mode'].addEventListener('change', () => {
      this.cancelScheduledZoom();
      this.updatePdfFeatureAvailability();
      if (this.e['pdf-overlay-display-mode'].value === 'pdf' && this.pdfAdapter)
        this.renderPdf().catch((error) => this.handlePdfRenderError(error));
      else {
        this.regionUi.cancelSelection();
        this.renderOverlay();
      }
    });
    this.e['pdf-overlay-file'].addEventListener('change', () =>
      this.loadPdf().catch((error) => this.fail(error)),
    );
    this.root
      .querySelector('#pdf-overlay-export-pdf')
      .addEventListener('click', () =>
        this.exportPdfWithAnnotations().catch((error) => this.fail(error)),
      );
    this.root.addEventListener('dragenter', (event) => this.handlePdfDragEnter(event));
    this.root.addEventListener('dragover', (event) => this.handlePdfDragOver(event));
    this.root.addEventListener('dragleave', (event) => this.handlePdfDragLeave(event));
    this.root.addEventListener('drop', (event) =>
      this.handlePdfDrop(event).catch((error) => this.fail(error)),
    );
    this.e['pdf-overlay-page'].addEventListener('change', () => {
      this.cancelScheduledZoom();
      this.resetPlacementState('PDFページ変更: 配置未設定', 'PAGE_CHANGED');
      this.clearAnchorInputs('pdf');
      this.e['pdf-overlay-svg-layer'].replaceChildren();
      this.regionUi.renderStatus();
      this.renderPdf().catch((error) => this.handlePdfRenderError(error));
    });
    this.e['pdf-overlay-rotation'].addEventListener('change', () => {
      this.cancelScheduledZoom();
      this.renderPdf().catch((error) => this.handlePdfRenderError(error));
    });
    this.e['pdf-overlay-opacity'].addEventListener('input', () => {
      this.e['pdf-overlay-svg-layer'].style.opacity = this.e['pdf-overlay-opacity'].value;
    });
    this.e['pdf-overlay-labels'].addEventListener('change', () => this.renderOverlay());
    this.e['pdf-overlay-gizmo-enabled'].addEventListener('change', () => this.renderOverlay());
    this.e['pdf-overlay-gizmo-candidate-type'].addEventListener('change', () => {
      if (this.gizmoPickOrigin) this.renderOverlay();
    });
    this.root.querySelector('#pdf-overlay-gizmo-pick-origin').addEventListener('click', () => {
      if (!this.drawing || !this.pageRender)
        return showWarning('PDFとSTB図面を先に表示してください。');
      this.resetMeasurementSequence('gizmo-origin-pick');
      this.sessionUi?.cancelDrawingMemo();
      this.regionUi.cancelSelection();
      this.anchorPickTarget = null;
      this.gizmoPickOrigin = true;
      this.renderOverlay();
      showInfo('STB上の候補点をクリックしてギズモ起点を選択してください。');
    });
    this.root.querySelector('#pdf-overlay-gizmo-reset').addEventListener('click', () => {
      const hadManualPlacement = Boolean(this.manualPlacement);
      this.manualPlacement = null;
      this.renderOverlay();
      if (hadManualPlacement) this.sessionUi?.onPlacementChanged('PLACEMENT_CHANGED');
    });
    this.e['pdf-overlay-scale'].addEventListener('change', () => {
      this.updateScaleControls();
      this.applyScaleChange();
    });
    this.e['pdf-overlay-custom-scale'].addEventListener('input', () =>
      this.applyScaleChange({ silentInvalid: true }),
    );
    this.e['pdf-overlay-custom-scale'].addEventListener('change', () => this.applyScaleChange());
    this.root
      .querySelector('#pdf-overlay-build-btn')
      .addEventListener('click', () => this.buildDrawing().catch((error) => this.fail(error)));
    this.root.querySelector('#pdf-overlay-solve-btn').addEventListener('click', () => {
      try {
        this.solveRegistration();
      } catch (error) {
        this.fail(error);
      }
    });
    this.root.querySelector('#pdf-overlay-clear-registration-btn').addEventListener('click', () => {
      const code = this.registration ? 'ALIGNMENT_CHANGED' : 'PLACEMENT_CHANGED';
      this.resetPlacementState('初期配置へ戻しました', code);
      this.renderOverlay();
      this.renderDiagnostics();
    });
    for (const key of ['a', 'b', 'c']) {
      this.root.querySelector(`#pdf-overlay-pick-${key}`).addEventListener('click', () => {
        this.resetMeasurementSequence('pdf-anchor-pick');
        this.sessionUi?.cancelDrawingMemo();
        this.regionUi.cancelSelection();
        this.gizmoPickOrigin = false;
        this.anchorPickTarget = { key, space: 'pdf' };
        this.renderOverlay();
        showInfo(`PDF上で基準点${key.toUpperCase()}をクリックしてください。`);
      });
      this.root.querySelector(`#pdf-overlay-pick-model-${key}`).addEventListener('click', () => {
        if (
          !this.drawing ||
          !this.currentModelToCss ||
          this.e['pdf-overlay-display-mode'].value !== 'pdf'
        )
          return showWarning('STB図面を先に生成してください。');
        this.resetMeasurementSequence('model-anchor-pick');
        this.sessionUi?.cancelDrawingMemo();
        this.regionUi.cancelSelection();
        this.anchorPickTarget = { key, space: 'model' };
        this.gizmoPickOrigin = false;
        this.renderOverlay();
        showInfo(`STB上の候補点をクリックして基準点${key.toUpperCase()}を取得してください。`);
      });
    }
    this.e['pdf-overlay-scroll'].addEventListener('wheel', (event) => this.handleWheelZoom(event), {
      passive: false,
    });
    this.e['pdf-overlay-scroll'].addEventListener('pointerdown', (event) =>
      this.beginViewportPan(event),
    );
    this.e['pdf-overlay-scroll'].addEventListener('pointermove', (event) =>
      this.updateViewportPan(event),
    );
    this.e['pdf-overlay-scroll'].addEventListener('pointerup', (event) =>
      this.finishViewportPan(event),
    );
    this.e['pdf-overlay-scroll'].addEventListener('pointercancel', (event) =>
      this.finishViewportPan(event),
    );
    this.e['pdf-overlay-scroll'].addEventListener('contextmenu', (event) =>
      this.handleViewportContextMenu(event),
    );
    this.e['pdf-overlay-stage'].addEventListener('click', (event) => this.handleStageClick(event));
    this.updateScaleControls();
    this.updateZoomLabel();
  }

  scaleDenominator() {
    return resolveScaleDenominator(
      this.e['pdf-overlay-scale'].value,
      this.e['pdf-overlay-custom-scale'].value,
    );
  }

  updateScaleControls() {
    const custom = this.e['pdf-overlay-scale'].value === 'custom';
    this.e['pdf-overlay-custom-scale-wrap'].hidden = !custom;
    this.e['pdf-overlay-custom-scale'].disabled = !custom;
  }

  setScaleDenominator(value) {
    const denominator = Number(value);
    if (!Number.isFinite(denominator) || denominator < 1)
      throw new RangeError('縮尺分母は1以上の数値で指定してください。');
    const preset = [...this.e['pdf-overlay-scale'].options].find(
      (option) => option.value !== 'custom' && Number(option.value) === denominator,
    );
    if (preset) this.e['pdf-overlay-scale'].value = preset.value;
    else {
      this.e['pdf-overlay-scale'].value = 'custom';
      this.e['pdf-overlay-custom-scale'].value = String(denominator);
    }
    this.updateScaleControls();
  }

  applyScaleChange({ silentInvalid = false } = {}) {
    let scaleDenominator;
    try {
      scaleDenominator = this.scaleDenominator();
    } catch (error) {
      if (!silentInvalid) this.fail(error);
      return;
    }
    if (!this.registration && this.manualPlacement) {
      this.manualPlacement = rescaleManualPlacement(
        this.manualPlacement,
        scaleDenominator,
        this.manualScaleAnchor(),
      );
      this.sessionUi?.onPlacementChanged('PLACEMENT_CHANGED');
    }
    if (this.e['pdf-overlay-display-mode'].value === 'stb' || !this.registration)
      this.renderOverlay();
  }

  manualScaleAnchor() {
    if (this.gizmoOrigin?.point) return [...this.gizmoOrigin.point];
    if (!this.drawing?.bounds) return [0, 0];
    return [
      (this.drawing.bounds.minX + this.drawing.bounds.maxX) / 2,
      (this.drawing.bounds.minY + this.drawing.bounds.maxY) / 2,
    ];
  }

  viewportMode() {
    return resolveOverlayViewportMode(this.e['pdf-overlay-display-mode'].value, {
      hasPdfPage: Boolean(this.pageRender),
      hasDrawing: Boolean(this.drawing),
    });
  }

  renderDiagnostics() {
    renderPdfOverlayDiagnostics(
      this.e['pdf-overlay-diagnostics'],
      this.drawing,
      this.e['pdf-overlay-registration-result'].textContent,
    );
  }

  getServices() {
    const factory = getState('functions.getPdfOverlayServices');
    if (typeof factory !== 'function') throw new Error('PDF照合サービスが初期化されていません。');
    return factory();
  }

  refreshModelAndStories() {
    const modelKey = this.e['pdf-overlay-model'].value;
    const doc = getState(`models.document${modelKey}`);
    const select = this.e['pdf-overlay-story'];
    select.replaceChildren();
    if (doc?.nodeType !== 9) {
      select.append(make('option', { value: '' }, `モデル${modelKey}未読込`));
      return;
    }
    for (const story of parseStories(doc)) {
      select.append(
        make('option', { value: story.id }, `${story.name || story.id} (${story.height} mm)`),
      );
    }
  }

  async loadPdf() {
    const file = this.e['pdf-overlay-file'].files?.[0];
    if (!file) return;
    await this.loadPdfFile(file);
  }

  async loadPdfFile(file) {
    if (this.exportingPdf) {
      showWarning('PDF保存中はPDFを変更できません。');
      return;
    }
    if (!isPdfFile(file)) throw new TypeError('PDFファイルを選択してください。');
    this.e['pdf-overlay-display-mode'].value = 'pdf';
    this.cancelScheduledZoom();
    this.viewZoom = 1;
    this.updateZoomLabel();
    this.resetPlacementState('PDF変更: 配置未設定', 'PDF_CHANGED');
    this.measurementUi?.invalidateDrawing();
    this.clearAnchorInputs('pdf');
    this.pageRender = null;
    this.updatePdfFeatureAvailability();
    this.regionUi.resetForPdf();
    this.e['pdf-overlay-canvas-layer'].replaceChildren();
    this.e['pdf-overlay-svg-layer'].replaceChildren();
    this.setStatus('PDF.jsを読み込んでいます…');
    const runtimeInfo = getPdfJsRuntimeInfo();
    const pdfjs = await loadPdfJsRuntime();
    this.services = this.getServices();
    await this.pdfAdapter?.close?.();
    this.pdfAdapter = this.services.createPdfDocument({
      pdfjs,
      assetUrls: runtimeInfo.assetUrls,
    });
    const info = await this.pdfAdapter.open(file, {
      requestPassword: async () => globalThis.prompt?.('PDFパスワードを入力してください。') ?? null,
    });
    this.e['pdf-overlay-page'].max = String(info.numPages);
    this.e['pdf-overlay-page'].value = '1';
    this.setStatus(`${info.filename} / ${info.numPages}ページ`);
    await this.renderPdf();
    showSuccess('PDFを読み込みました。');
  }

  setPdfDropActive(active) {
    const overlay = this.e['pdf-overlay-drop-overlay'];
    if (!overlay) return;
    overlay.classList.toggle('active', Boolean(active));
    overlay.setAttribute('aria-hidden', String(!active));
  }

  handlePdfDragEnter(event) {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    this.pdfDragDepth += 1;
    this.setPdfDropActive(true);
  }

  handlePdfDragOver(event) {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.setPdfDropActive(true);
  }

  handlePdfDragLeave(event) {
    if (this.pdfDragDepth <= 0) return;
    event.preventDefault();
    this.pdfDragDepth = Math.max(0, this.pdfDragDepth - 1);
    if (this.pdfDragDepth === 0) this.setPdfDropActive(false);
  }

  async handlePdfDrop(event) {
    if (!hasFileDrag(event)) return false;
    event.preventDefault();
    this.pdfDragDepth = 0;
    this.setPdfDropActive(false);
    const files = Array.from(event.dataTransfer?.files || []);
    const file = files.find(isPdfFile);
    if (!file) {
      showWarning('PDFファイルをドロップしてください。');
      return true;
    }
    await this.loadPdfFile(file);
    return true;
  }

  async exportPdfWithAnnotations() {
    if (this.exportingPdf) return;
    if (!this.pdfAdapter?.info || !this.pageRender)
      return showWarning('PDFを読み込み、表示してから保存してください。');

    const button = this.root.querySelector('#pdf-overlay-export-pdf');
    const previousText = button?.textContent || 'PDF保存';
    this.exportingPdf = true;
    this.updatePdfFeatureAvailability();
    if (button) {
      button.disabled = true;
      button.textContent = 'PDF保存中…';
    }

    try {
      await this.flushScheduledZoom();
      await this.flushPendingPdfRender();

      if (this.e['pdf-overlay-display-mode'].value !== 'pdf') {
        this.e['pdf-overlay-display-mode'].value = 'pdf';
        await this.renderPdf();
      }

      const filename = await this.runPdfExport({
        onProgress: ({ pageNumber, numPages }) => {
          this.setStatus(`PDF保存中 ${pageNumber}/${numPages}ページ`);
        },
      });
      this.setStatus(`${filename} を保存しました`);
      showSuccess('STB・寸法・メモを焼き込んだPDFを保存しました。');
    } finally {
      this.exportingPdf = false;
      this.updatePdfFeatureAvailability();
      if (button) {
        button.textContent = previousText;
      }
    }
  }

  runPdfExport(options) {
    return exportAnnotatedPdf(this, options);
  }

  async renderPdf({ focus = null } = {}) {
    if (!this.pdfAdapter) return;
    const page = Number(this.e['pdf-overlay-page'].value || 1);
    const rotation = Number(this.e['pdf-overlay-rotation'].value || 0);
    const renderPromise = (async () => {
      const result = await this.pdfAdapter.renderPage(page, { scale: this.viewZoom, rotation });
      this.pageRender = result;
      const layer = this.e['pdf-overlay-canvas-layer'];
      layer.replaceChildren(result.canvas);
      this.e['pdf-overlay-stage'].style.width = `${result.width}px`;
      this.e['pdf-overlay-stage'].style.height = `${result.height}px`;
      this.updateZoomLabel();
      this.regionUi.renderStatus();
      this.renderOverlay();
      this.updatePdfFeatureAvailability();
      if (focus) this.restoreZoomFocus(focus);
      this.renderDiagnostics();
      await this.sessionUi?.onAssetsChanged();
    })();
    this.pdfRenderPromise = renderPromise;
    try {
      await renderPromise;
    } finally {
      if (this.pdfRenderPromise === renderPromise) this.pdfRenderPromise = null;
    }
  }

  async buildDrawing() {
    const modelKey = this.e['pdf-overlay-model'].value;
    const doc = getState(`models.document${modelKey}`);
    if (doc?.nodeType !== 9) throw new Error(`モデル${modelKey}を先に読み込んでください。`);
    const stories = parseStories(doc);
    const storyId = this.e['pdf-overlay-story'].value;
    if (!storyId) throw new Error('対象階を選択してください。');
    this.abortController?.abort();
    const abortController = new globalThis.AbortController();
    this.abortController = abortController;
    this.services = this.services || this.getServices();
    this.setStatus('STB平面図を抽出しています…');
    let drawing;
    try {
      drawing = await this.services.createDrawing({
        modelKey,
        view: storyView(stories, storyId),
        signal: abortController.signal,
      });
    } catch (error) {
      if (abortController.signal.aborted || this.abortController !== abortController) return;
      throw error;
    }
    if (abortController.signal.aborted || this.abortController !== abortController) return;
    this.measurementUi?.invalidateDrawing();
    this.drawing = drawing;
    // STB原本・階・改訂が変わったDrawingModelへ、以前の位置合わせを暗黙に流用しない。
    this.resetPlacementState('STB図面更新: 配置未設定', 'STB_VIEW_CHANGED');
    this.regionUi.invalidateDrawing();
    this.clearAnchorInputs('model');
    this.alignmentCandidates = this.services.collectAlignmentCandidates({
      modelKey,
      drawing: this.drawing,
    });
    this.gizmoOrigin = this.pickDefaultGizmoOrigin();
    if (this.gizmoOrigin) {
      this.e['pdf-overlay-gizmo-origin-info'].textContent =
        `${this.gizmoOrigin.label} / X=${this.gizmoOrigin.point[0].toFixed(1)} Y=${this.gizmoOrigin.point[1].toFixed(1)}`;
    }
    this.setStatus(
      `STB抽出 ${this.drawing.coverage.drawn}/${this.drawing.coverage.sourceMembers} 部材`,
    );
    if (this.drawing.coverage.failed)
      showWarning(`${this.drawing.coverage.failed}部材は抽出診断があります。`);
    this.regionUi.renderStatus();
    this.renderOverlay();
    this.updatePdfFeatureAvailability();
    this.renderDiagnostics();
    await this.sessionUi?.onAssetsChanged();
    if (this.e['pdf-overlay-display-mode'].value === 'stb')
      showSuccess('STB単独図面を生成しました。');
  }

  renderSheet({ focus = null } = {}) {
    this.currentModelToCss = null;
    this.updatePdfFeatureAvailability();
    const layer = this.e['pdf-overlay-svg-layer'];
    layer.replaceChildren();
    if (!this.drawing) return;
    this.services = this.services || this.getServices();
    const scaleDenominator = this.scaleDenominator();
    const layout = this.services.createSheetLayout({
      drawing: this.drawing,
      paper: 'A3',
      orientation: 'landscape',
      scaleDenominator,
      previewPxPerMm: sheetPreviewPxPerMm(this.viewZoom),
    });
    this.e['pdf-overlay-canvas-layer'].replaceChildren();
    this.e['pdf-overlay-stage'].style.width = `${layout.previewWidthPx}px`;
    this.e['pdf-overlay-stage'].style.height = `${layout.previewHeightPx}px`;
    const svg = this.services.renderDrawingSheetSvg({
      drawing: this.drawing,
      layout,
      showLabels: this.e['pdf-overlay-labels'].checked,
      onSelect: (ref) => {
        if (!this.measurementUi?.isActive()) this.showSelectedElement(ref);
      },
    });
    layer.append(svg);
    this.updateZoomLabel();
    if (focus) this.restoreZoomFocus(focus);
    this.setStatus(
      `STB図面 A3横 1:${scaleDenominator} / 表示 ${formatPdfOverlayViewZoom(this.viewZoom)} / ${this.drawing.coverage.drawn}部材`,
    );
  }

  showSelectedElement(ref) {
    if (this.regionUi.consumeClick()) return;
    const record = this.drawing?.elements.find(
      (item) =>
        item.ref.modelKey === ref.modelKey &&
        item.ref.elementType === ref.elementType &&
        item.ref.elementId === ref.elementId,
    );
    this.e['pdf-overlay-element-info'].textContent =
      `${ref.modelKey} / ${ref.elementType} #${ref.elementId}${record?.mark ? ` / ${record.mark}` : ''}`;
    this.sessionUi?.selectMember(ref);
    const idA = ref.modelKey === 'A' ? ref.elementId : null;
    const idB = ref.modelKey === 'B' ? ref.elementId : null;
    eventBus.emit(InteractionEvents.DISPLAY_ELEMENT_INFO, {
      idA,
      idB,
      elementType: ref.elementType,
      modelSource: ref.modelKey,
    });
    eventBus.emit(InteractionEvents.SELECT_ELEMENT_IN_TREE, resolvePdfOverlayTreeSelection(ref));
    eventBus.emit(InteractionEvents.OPEN_WINDOW, { windowId: 'component-info' });
  }

  solveRegistration() {
    this.services = this.services || this.getServices();
    const point = (key, space) => [
      num(this.e[`pdf-overlay-${key}-${space}x`], `${key.toUpperCase()} ${space.toUpperCase()} X`),
      num(this.e[`pdf-overlay-${key}-${space}y`], `${key.toUpperCase()} ${space.toUpperCase()} Y`),
    ];
    const anchors = {
      a: { model: point('a', 'm'), pdf: point('a', 'p') },
      b: { model: point('b', 'm'), pdf: point('b', 'p') },
      c: { model: point('c', 'm'), pdf: point('c', 'p') },
    };
    const matrix = this.services.solveSimilarity(
      anchors.a.model,
      anchors.b.model,
      anchors.a.pdf,
      anchors.b.pdf,
    );
    const check = this.services.evaluateRegistration(
      this.services.createRegistrationInput(anchors),
      matrix,
      { userUnit: this.pageRender?.userUnit || 1 },
    );
    const resultText = `${check.code}${check.errorMm == null ? '' : ` / C残差 ${check.errorMm.toFixed(1)} mm`}`;
    if (check.code !== 'CHECK_WITHIN_GUIDE' && check.code !== 'CHECK_EXCEEDS_GUIDE') {
      this.registration = null;
      this.renderOverlay();
      this.e['pdf-overlay-registration-result'].textContent = `${resultText} / 未適用`;
      this.sessionUi?.invalidateReviews('ALIGNMENT_INVALID');
      this.renderDiagnostics();
      showWarning('基準点条件が不十分なため位置合わせを適用しません。');
      return;
    }
    this.registration = matrix;
    this.manualPlacement = null;
    this.e['pdf-overlay-registration-result'].textContent = resultText;
    this.sessionUi?.onRegistrationChanged();
    this.renderDiagnostics();
    this.renderOverlay();
    check.ok
      ? showSuccess('位置合わせを更新しました。')
      : showWarning('C点残差を確認してください。');
  }

  pickDefaultGizmoOrigin() {
    if (!this.alignmentCandidates.length || !this.drawing?.bounds) return null;
    const center = [
      (this.drawing.bounds.minX + this.drawing.bounds.maxX) / 2,
      (this.drawing.bounds.minY + this.drawing.bounds.maxY) / 2,
    ];
    const preferred = this.alignmentCandidates.filter((candidate) => candidate.type === 'grid');
    const pool = preferred.length ? preferred : this.alignmentCandidates;
    return pool.reduce((best, candidate) => {
      const d = Math.hypot(candidate.point[0] - center[0], candidate.point[1] - center[1]);
      return !best || d < best.distance ? { ...candidate, distance: d } : best;
    }, null);
  }

  filteredGizmoCandidates() {
    const type = this.e['pdf-overlay-gizmo-candidate-type'].value;
    return type === 'all'
      ? this.alignmentCandidates
      : this.alignmentCandidates.filter((candidate) => candidate.type === type);
  }

  stagePoint(event) {
    const rect = this.e['pdf-overlay-stage'].getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  updateZoomLabel() {
    if (this.e['pdf-overlay-zoom-value'])
      this.e['pdf-overlay-zoom-value'].textContent = formatPdfOverlayViewZoom(this.viewZoom);
  }

  cancelScheduledZoom() {
    if (this.zoomRenderTimer != null) {
      globalThis.clearTimeout(this.zoomRenderTimer);
      this.zoomRenderTimer = null;
    }
    this.pendingZoomFocus = null;
    this.pendingZoomMode = null;
  }

  startScheduledZoomRender(mode, focus) {
    let renderResult;
    try {
      if (this.viewportMode() === mode) {
        this.zoomRenderSequence += 1;
        renderResult = mode === 'sheet' ? this.renderSheet({ focus }) : this.renderPdf({ focus });
      }
    } catch (error) {
      renderResult = Promise.reject(error);
    }

    const renderPromise = Promise.resolve(renderResult).finally(() => {
      if (this.zoomRenderPromise === renderPromise) this.zoomRenderPromise = null;
    });
    this.zoomRenderPromise = renderPromise;
    return renderPromise;
  }

  async flushScheduledZoom() {
    let scheduledZoom = null;
    if (this.zoomRenderTimer != null) {
      globalThis.clearTimeout(this.zoomRenderTimer);
      this.zoomRenderTimer = null;
      scheduledZoom = {
        mode: this.pendingZoomMode,
        focus: this.pendingZoomFocus,
      };
      this.pendingZoomMode = null;
      this.pendingZoomFocus = null;
    }

    while (this.zoomRenderPromise) {
      const activeRender = this.zoomRenderPromise;
      const activeSequence = this.zoomRenderSequence;
      try {
        await activeRender;
      } catch (error) {
        if (error?.name === 'AbortError' && this.zoomRenderSequence !== activeSequence) continue;
        throw error;
      }
      if (this.zoomRenderSequence !== activeSequence) continue;
      if (this.zoomRenderPromise && this.zoomRenderPromise !== activeRender) continue;
      break;
    }

    if (scheduledZoom && this.viewportMode() === scheduledZoom.mode)
      await this.startScheduledZoomRender(scheduledZoom.mode, scheduledZoom.focus);
  }

  async flushPendingPdfRender() {
    while (this.pdfRenderPromise) {
      const pendingRender = this.pdfRenderPromise;
      try {
        await pendingRender;
      } catch (error) {
        if (
          error?.name === 'AbortError' &&
          this.pdfRenderPromise &&
          this.pdfRenderPromise !== pendingRender
        )
          continue;
        throw error;
      }
      if (this.pdfRenderPromise === pendingRender) return;
    }
  }

  captureZoomFocus(event, mode = this.viewportMode()) {
    const scroll = this.e['pdf-overlay-scroll'];
    const scrollRect = scroll.getBoundingClientRect();
    const viewportPoint = [event.clientX - scrollRect.left, event.clientY - scrollRect.top];

    if (mode === 'pdf') {
      if (!this.pageRender) return null;
      return {
        mode: 'pdf',
        pdfPoint: transformPoint(this.pageRender.cssToPdf, this.stagePoint(event)),
        viewportPoint,
      };
    }

    if (mode === 'sheet') {
      const stageRect = this.e['pdf-overlay-stage'].getBoundingClientRect();
      if (!(stageRect.width > 0) || !(stageRect.height > 0)) return null;
      return {
        mode: 'sheet',
        sheetFraction: [
          (event.clientX - stageRect.left) / stageRect.width,
          (event.clientY - stageRect.top) / stageRect.height,
        ],
        viewportPoint,
      };
    }

    return null;
  }

  restoreZoomFocus(focus) {
    if (!focus?.viewportPoint) return;
    const scroll = this.e['pdf-overlay-scroll'];
    const scrollRect = scroll.getBoundingClientRect();
    const stageRect = this.e['pdf-overlay-stage'].getBoundingClientRect();
    let point;

    if (focus.mode === 'pdf') {
      if (!focus.pdfPoint || !this.pageRender) return;
      point = transformPoint(this.pageRender.pdfToCss, focus.pdfPoint);
    } else if (focus.mode === 'sheet') {
      if (!focus.sheetFraction) return;
      point = [stageRect.width * focus.sheetFraction[0], stageRect.height * focus.sheetFraction[1]];
    } else return;

    const originX = stageRect.left - scrollRect.left + scroll.scrollLeft;
    const originY = stageRect.top - scrollRect.top + scroll.scrollTop;
    scroll.scrollLeft = Math.max(0, originX + point[0] - focus.viewportPoint[0]);
    scroll.scrollTop = Math.max(0, originY + point[1] - focus.viewportPoint[1]);
  }

  beginViewportPan(event) {
    if (event.button !== 2 || this.viewportMode() !== 'pdf') return;
    const scroll = this.e['pdf-overlay-scroll'];
    event.preventDefault();
    this.viewportPan = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startScrollLeft: scroll.scrollLeft,
      startScrollTop: scroll.scrollTop,
    };
    scroll.setPointerCapture?.(event.pointerId);
    scroll.classList.add('panning');
  }

  updateViewportPan(event) {
    const pan = this.viewportPan;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.preventDefault();
    const scroll = this.e['pdf-overlay-scroll'];
    scroll.scrollLeft = pan.startScrollLeft - (event.clientX - pan.startClientX);
    scroll.scrollTop = pan.startScrollTop - (event.clientY - pan.startClientY);
  }

  finishViewportPan(event) {
    const pan = this.viewportPan;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.preventDefault();
    const scroll = this.e['pdf-overlay-scroll'];
    try {
      if (scroll.hasPointerCapture?.(event.pointerId))
        scroll.releasePointerCapture(event.pointerId);
    } catch {
      // pointer capture が既に解除されている場合は何もしない。
    }
    scroll.classList.remove('panning');
    this.viewportPan = null;
  }

  handleViewportContextMenu(event) {
    if (this.viewportMode() !== 'pdf') return;
    event.preventDefault();
  }

  handleWheelZoom(event) {
    if (this.exportingPdf) {
      event.preventDefault();
      return;
    }

    const mode = this.viewportMode();
    if (mode === 'none') return;

    event.preventDefault();
    const nextZoom = nextPdfOverlayViewZoom(this.viewZoom, event.deltaY, event.deltaMode);
    if (nextZoom === this.viewZoom) return;

    const focus = this.captureZoomFocus(event, mode);
    this.viewZoom = nextZoom;
    this.updateZoomLabel();

    this.pendingZoomFocus = focus;
    this.pendingZoomMode = mode;
    if (this.zoomRenderTimer != null) globalThis.clearTimeout(this.zoomRenderTimer);
    this.zoomRenderTimer = globalThis.setTimeout(() => {
      this.zoomRenderTimer = null;
      const pendingFocus = this.pendingZoomFocus;
      const pendingMode = this.pendingZoomMode;
      this.pendingZoomFocus = null;
      this.pendingZoomMode = null;
      this.startScheduledZoomRender(pendingMode, pendingFocus).catch((error) => {
        if (error?.name !== 'AbortError') this.fail(error);
      });
    }, 60);
  }

  handleStageClick(event) {
    if (this.measurementUi?.consumeSuppressedStageClick?.()) return;

    // 明示的にarmされたPDFツールを寸法測定より優先する。
    // 領域選択後の抑止clickも最初に消費し、意図しない寸法確定を防ぐ。
    if (this.regionUi.consumeClick()) return;

    if (this.gizmoPickOrigin && this.currentModelToCss) {
      const rect = this.e['pdf-overlay-stage'].getBoundingClientRect();
      const point = [event.clientX - rect.left, event.clientY - rect.top];
      let nearest = null;
      for (const candidate of this.filteredGizmoCandidates()) {
        const css = transformPoint(this.currentModelToCss, candidate.point);
        const distance = Math.hypot(css[0] - point[0], css[1] - point[1]);
        if (!nearest || distance < nearest.distance) nearest = { candidate, distance };
      }
      if (!nearest || nearest.distance > 20) {
        showWarning('候補点の近くをクリックしてください。');
        return;
      }
      this.gizmoOrigin = nearest.candidate;
      this.gizmoPickOrigin = false;
      this.e['pdf-overlay-gizmo-origin-info'].textContent =
        `${nearest.candidate.label} / X=${nearest.candidate.point[0].toFixed(1)} Y=${nearest.candidate.point[1].toFixed(1)}`;
      this.renderOverlay();
      return;
    }

    if (this.sessionUi?.handleStageClick(event)) return;

    if (this.anchorPickTarget?.space === 'model') {
      this.pickModelPoint(event);
      return;
    }
    if (this.anchorPickTarget?.space === 'pdf') {
      this.pickPdfPoint(event);
      return;
    }

    if (this.measurementUi?.handleStageClick(event)) return;
  }

  appendGizmo(svg) {
    if (
      !this.e['pdf-overlay-gizmo-enabled'].checked ||
      !this.gizmoOrigin ||
      !this.currentModelToCss ||
      this.gizmoPickOrigin ||
      this.anchorPickTarget ||
      this.measurementUi?.isActive() ||
      this.e['pdf-overlay-display-mode'].value !== 'pdf'
    )
      return;
    const originCss = transformPoint(this.currentModelToCss, this.gizmoOrigin.point);
    const layer = this.e['pdf-overlay-svg-layer'];
    appendAlignmentGizmo(svg, originCss, {
      onDragStart: () => {
        layer.classList.add('gizmo-dragging');
      },
      onDragMove: ({ dx, dy }) => {
        layer.style.transform = `translate(${dx}px, ${dy}px)`;
      },
      onDragEnd: ({ dx, dy }) => {
        layer.style.transform = '';
        layer.classList.remove('gizmo-dragging');
        if (dx === 0 && dy === 0) return;
        const hadRegistration = Boolean(this.registration);
        this.manualPlacement = translateManualPlacementFromDisplay({
          modelToCss: this.currentModelToCss,
          cssToPdf: this.pageRender.cssToPdf,
          dx,
          dy,
          scaleDenominator: this.scaleDenominator(),
        });
        this.registration = null;
        this.renderOverlay();
        this.sessionUi?.onPlacementChanged(
          hadRegistration ? 'ALIGNMENT_CHANGED' : 'PLACEMENT_CHANGED',
        );
        this.renderDiagnostics();
      },
    });
  }

  pickPdfPoint(event) {
    if (!this.anchorPickTarget || !this.pageRender) return;
    const rect = this.e['pdf-overlay-stage'].getBoundingClientRect();
    const css = [event.clientX - rect.left, event.clientY - rect.top];
    const pdf = transformPoint(this.pageRender.cssToPdf, css);
    const { key, space } = this.anchorPickTarget;
    if (space !== 'pdf') return;
    this.e[`pdf-overlay-${key}-px`].value = pdf[0].toFixed(3);
    this.e[`pdf-overlay-${key}-py`].value = pdf[1].toFixed(3);
    this.anchorPickTarget = null;
    this.sessionUi?.onAnchorInputChanged();
    showInfo(`基準点${key.toUpperCase()}のPDF座標を取得しました。`);
  }

  pickModelPoint(event) {
    if (!this.anchorPickTarget || !this.currentModelToCss) return;
    const point = this.stagePoint(event);
    let nearest = null;
    for (const candidate of this.alignmentCandidates) {
      const css = transformPoint(this.currentModelToCss, candidate.point);
      const distance = Math.hypot(css[0] - point[0], css[1] - point[1]);
      if (!nearest || distance < nearest.distance) nearest = { candidate, distance };
    }
    if (!nearest || nearest.distance > 20) {
      showWarning('青い候補点の近くをクリックしてください。');
      return;
    }
    const { key } = this.anchorPickTarget;
    this.e[`pdf-overlay-${key}-mx`].value = nearest.candidate.point[0].toFixed(3);
    this.e[`pdf-overlay-${key}-my`].value = nearest.candidate.point[1].toFixed(3);
    this.anchorPickTarget = null;
    this.sessionUi?.onAnchorInputChanged();
    showInfo(`基準点${key.toUpperCase()}のSTB座標を取得しました。`);
  }

  renderOverlay() {
    const layer = this.e['pdf-overlay-svg-layer'];
    layer.replaceChildren();
    const viewportMode = this.viewportMode();
    if (viewportMode === 'sheet') {
      this.renderSheet();
      return;
    }
    if (viewportMode !== 'pdf') return;
    if (!this.drawing) {
      this.currentModelToCss = null;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', String(this.pageRender.width));
      svg.setAttribute('height', String(this.pageRender.height));
      svg.setAttribute('viewBox', `0 0 ${this.pageRender.width} ${this.pageRender.height}`);
      layer.append(svg);
      this.regionUi.appendVisuals(svg, false);
      this.sessionUi?.appendDrawingMemos(svg);
      return;
    }
    this.services = this.services || this.getServices();
    let registration = this.registration;
    const pdfToCss = this.pageRender.pdfToCss;
    if (!registration) {
      if (!this.manualPlacement) {
        const scaleDenominator = this.scaleDenominator();
        const layout = this.services.createSheetLayout({
          drawing: this.drawing,
          paper: 'A3',
          orientation: 'landscape',
          scaleDenominator,
        });
        const sheetToViewport = [
          ...this.services.createSheetToViewportTransform(
            layout,
            this.pageRender.width,
            this.pageRender.height,
          ),
        ];
        const modelToCss = multiplyAffine(sheetToViewport, [...layout.modelToPaper]);
        this.manualPlacement = createManualPlacementFromDisplay({
          modelToCss,
          cssToPdf: this.pageRender.cssToPdf,
          scaleDenominator,
        });
      }
      registration = [...this.manualPlacement.matrix];
      this.e['pdf-overlay-registration-result'].textContent =
        `手動配置 A3横 1:${this.manualPlacement.scaleDenominator}`;
    }
    this.currentModelToCss = multiplyAffine(pdfToCss, registration);
    const svg = this.services.renderDrawingSvg({
      drawing: this.drawing,
      registration,
      pdfToCss,
      width: this.pageRender.width,
      height: this.pageRender.height,
      showLabels: this.e['pdf-overlay-labels'].checked,
      onSelect: (ref) => {
        if (
          !this.measurementUi?.isActive() &&
          !this.anchorPickTarget &&
          !this.regionUi.isSelecting()
        )
          this.showSelectedElement(ref);
      },
    });
    layer.append(svg);
    this.regionUi.appendVisuals(svg, true);
    this.sessionUi?.appendDrawingMemos(svg);
    this.measurementUi?.appendVisuals(svg);
    if (this.gizmoPickOrigin || this.anchorPickTarget?.space === 'model') {
      appendAlignmentCandidateMarkers(
        svg,
        this.gizmoPickOrigin ? this.filteredGizmoCandidates() : this.alignmentCandidates,
        this.currentModelToCss,
      );
    }
    this.appendGizmo(svg);
  }

  setStatus(message) {
    this.e['pdf-overlay-status'].textContent = message;
  }

  handlePdfRenderError(error) {
    if (error?.name === 'AbortError') return;
    this.fail(error);
  }

  fail(error) {
    log.error(error);
    this.setStatus(error?.message || 'エラー');
    showError(error?.message || 'PDF照合処理に失敗しました。');
  }
}

export function initializePdfOverlayPanel() {
  if (panel) return panel;
  const button = document.getElementById('toggle-pdf-overlay-btn');
  if (!button) {
    log.warn('PDF図面ボタンがツールサイドバーに見つかりません。');
    return null;
  }

  const root = buildPdfOverlayPanelMarkup(WINDOW_ID);
  panel = new PdfOverlayPanelController(root);

  const setVisible = (visible) => {
    const wasVisible = root.classList.contains('visible');
    if (wasVisible !== visible) {
      eventBus.emit(MeasurementEvents.SEQUENCE_RESET, {
        targetSurface: visible ? 'pdf-overlay' : '3d',
        reason: 'workspace-switch',
      });
    }

    root.classList.toggle('visible', visible);
    root.setAttribute('aria-hidden', String(!visible));
    button.setAttribute('aria-expanded', String(visible));
    document.body.classList.toggle('workspace-view-active', visible);
    if (visible) panel.refreshModelAndStories();

    globalThis.requestAnimationFrame?.(() => {
      globalThis.dispatchEvent?.(new Event('resize'));
    });
  };

  button.addEventListener('click', () => setVisible(!root.classList.contains('visible')));
  root.querySelector('#pdf-overlay-close').addEventListener('click', () => setVisible(false));
  for (const id of ['viewModePerspectiveBtn', 'viewModeOrthographicBtn']) {
    document.getElementById(id)?.addEventListener('click', () => {
      if (root.classList.contains('visible')) setVisible(false);
    });
  }
  return panel;
}
