/** @fileoverview PDF図面照合モードの初期UI。PDF Canvas + STB SVGを同一viewportへ重ねる。 */
import { getState } from '../../../data/state/globalState.js';
import {
  DEFAULT_DRAWING_TAG_ORIENTATION_MODE,
  normalizeDrawingTagOrientationMode,
} from '../../../config/drawingTagTemplates.js';
import { parseStories } from '../../../common-stb/import/parser/stbParserCore.js';
import { loadPdfJsRuntime, getPdfJsRuntimeInfo } from '../../../parser/pdf/pdfJsRuntime.js';
import { multiplyAffine, transformPoint } from '../../../data/drawing/affine2d.js';
import { planViewContextSnapshot } from '../../../data/drawing/drawingModel.js';
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
import { PdfOverlayCandidateController } from './PdfOverlayCandidateController.js';
import { PdfOverlayMeasurementController } from './PdfOverlayMeasurementController.js';
import { exportAnnotatedPdf } from './PdfOverlayPdfExporter.js';
import { buildPdfOverlayPanelMarkup } from './pdfOverlayPanelMarkup.js';
import { getCommandLabel, setCommandLabel } from '../../common/ribbon.js';
import { PDF_OVERLAY_FLOAT_WINDOWS } from './pdfOverlayRibbonMarkup.js';
import { floatingWindowManager } from '../floatingWindowManager.js';
import { resolvePdfOverlayTreeSelection } from './pdfOverlaySelection.js';
import { renderPdfOverlayDiagnostics } from './PdfOverlayDiagnosticsView.js';
import {
  createPdfDimensionRenderContext,
  make,
  num,
  resolvePdfPaperMmToCss,
  resolveScaleDenominator,
  storyView,
} from './pdfOverlayPanelHelpers.js';
import {
  readPdfDrawingDisplaySettings,
  shouldRedrawPdfDrawingForDisplaySettingEvent,
} from '../pdfDrawingDisplaySettings.js';
import { appendAlignmentCandidateMarkers, appendAlignmentGizmo } from './alignmentGizmo2d.js';
import {
  capturePdfOverlayZoomAnchor,
  formatPdfOverlayViewZoom,
  getPdfOverlayMemberClientCenter,
  nextPdfOverlayViewZoom,
  resolveOverlayViewportMode,
  resolvePdfOverlayZoomScroll,
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

export function isDxfFile(file) {
  if (!file || typeof file.name !== 'string') return false;
  return /\.dxf$/i.test(file.name) || file.type === 'application/dxf';
}

export function selectedFileDisplayPath(file) {
  for (const candidate of [file?.path, file?.webkitRelativePath, file?.name]) {
    const value = typeof candidate === 'string' ? candidate.trim() : '';
    if (value) return value;
  }
  return '名称不明';
}

function dxfFilenamePart(value, fallback) {
  const normalized = String(value ?? '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+|\.+$/g, '');
  return normalized || fallback;
}

export function currentDrawingDxfFilename(drawing, scaleDenominator) {
  const modelKey = dxfFilenamePart(drawing?.source?.modelKey, 'model');
  const storyId = dxfFilenamePart(drawing?.view?.storyId, 'story');
  const scale = Number(scaleDenominator);
  if (!Number.isFinite(scale) || scale < 1)
    throw new RangeError('DXFファイル名には有効な縮尺分母が必要です。');
  return `STB_${modelKey}_${storyId}_1-${dxfFilenamePart(scale, 'scale')}.dxf`;
}

export class PdfOverlayPanelController {
  constructor(root) {
    this.root = root;
    this.services = null;
    this.pdfAdapter = null;
    this.pageRender = null;
    this.drawing = null;
    this.referenceDrawings = [];
    this.referenceDisplaySettings = {};
    this.referenceAssets = new Map();
    this.referenceDocumentSequence = 0;
    this.selectedReferenceKey = null;
    this.sheetLayout = null;
    this.drawingRotationDeg = 0;
    this.tagOrientationMode = DEFAULT_DRAWING_TAG_ORIENTATION_MODE;
    this.tagFactsResolver = null;
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
    this.wheelZoomAnchor = null;
    this.viewportPan = null;
    this.pdfDragDepth = 0;
    this.exportingPdf = false;
    this.exportingDxf = false;
    this.sheetRenderPlan = null;
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
      'pdf-overlay-dxf-file',
      'pdf-overlay-dxf-file-status',
      'pdf-overlay-dxf-unit',
      'pdf-overlay-dxf-offset-x',
      'pdf-overlay-dxf-offset-y',
      'pdf-overlay-dxf-rotation',
      'pdf-overlay-dxf-reference-status',
      'pdf-overlay-dxf-reference-list',
      'pdf-overlay-export-dxf',
      'pdf-overlay-model',
      'pdf-overlay-story',
      'pdf-overlay-page',
      'pdf-overlay-rotation',
      'pdf-overlay-drawing-rotation',
      'pdf-overlay-tag-orientation',
      'pdf-overlay-cut-fill',
      'pdf-overlay-cut-fill-opacity',
      'pdf-overlay-scale',
      'pdf-overlay-custom-scale',
      'pdf-overlay-custom-scale-wrap',
      'pdf-overlay-display-mode',
      'pdf-overlay-opacity',
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
    this.sheetLayout = null;
    this.sheetRenderPlan = null;
    this.tagFactsResolver = null;
    this.clearSelection();
    this.sessionUi?.invalidateTagPlacements('STB_VIEW_CHANGED');
    this.regionUi.invalidateDrawing();
    this.alignmentCandidates = [];
    this.gizmoOrigin = null;
    this.gizmoPickOrigin = false;
    this.resetPlacementState();
    this.clearAnchorInputs('model');
    this.e['pdf-overlay-svg-layer'].replaceChildren();
    this.e['pdf-overlay-element-info'].textContent = '未選択';
    this.updatePdfFeatureAvailability();
    const referenceCount = this.referenceDrawings?.length || 0;
    if (referenceCount && this.e['pdf-overlay-display-mode']?.value === 'stb') {
      this.renderOverlay();
      this.setStatus(`${message} / DXF参照 ${referenceCount}ファイルは固定表示を維持しています。`);
    } else {
      this.setStatus(message);
    }
  }

  updatePdfFeatureAvailability() {
    const pdfPageReady = Boolean(this.pdfAdapter?.info && this.pageRender);
    const pdfViewReady =
      pdfPageReady && this.elements?.['pdf-overlay-display-mode']?.value === 'pdf';
    const drawingTransformReady = Boolean(this.drawing && this.currentModelToCss);
    const stbPdfViewReady = Boolean(pdfViewReady && drawingTransformReady);
    const setDisabled = (selector, disabled) => {
      const control = this.root?.querySelector(selector);
      if (control) control.disabled = disabled;
    };

    const hasDrawingContent = Boolean(this.drawing || this.referenceDrawings?.length || 0);
    setDisabled('#pdf-overlay-export-pdf', !pdfPageReady || this.exportingPdf);
    setDisabled(
      '#pdf-overlay-export-dxf',
      !hasDrawingContent || this.exportingDxf || this.exportingPdf,
    );
    setDisabled('#pdf-overlay-file', this.exportingPdf);
    setDisabled('#pdf-overlay-dxf-file', this.exportingPdf || this.exportingDxf);
    setDisabled(
      '#pdf-overlay-dxf-clear',
      !(this.referenceDrawings?.length || 0) || this.exportingPdf,
    );
    setDisabled('#pdf-overlay-page', !pdfPageReady || this.exportingPdf);
    setDisabled('#pdf-overlay-rotation', !pdfPageReady || this.exportingPdf);
    setDisabled('#pdf-overlay-drawing-rotation', this.exportingPdf);
    setDisabled('#pdf-overlay-tag-orientation', this.exportingPdf);
    setDisabled('#pdf-overlay-cut-fill', this.exportingPdf);
    setDisabled(
      '#pdf-overlay-cut-fill-opacity',
      this.exportingPdf || !this.e['pdf-overlay-cut-fill']?.checked,
    );
    setDisabled('#pdf-overlay-display-mode', this.exportingPdf);
    setDisabled('#pdf-overlay-select-region', !pdfPageReady);
    setDisabled('#pdf-overlay-export-session', !pdfPageReady);
    setDisabled('#pdf-overlay-export-drawing-project', !this.drawing);
    setDisabled('#pdf-overlay-add-drawing-memo', !drawingTransformReady);
    this.sessionUi?.refreshLegacyPdfDrawingMemoMigrationStatus?.();
    setDisabled('#pdf-overlay-gizmo-pick-origin', !stbPdfViewReady);
    for (const key of ['a', 'b', 'c']) {
      setDisabled(`#pdf-overlay-pick-${key}`, !pdfViewReady);
      setDisabled(`#pdf-overlay-pick-model-${key}`, !stbPdfViewReady);
    }

    const status = this.root?.querySelector('#pdf-overlay-feature-prerequisites');
    if (!status) return;
    status.textContent = pdfPageReady
      ? 'PDF読込済み：PDFはSVG図面への重ね合わせとして利用中です'
      : drawingTransformReady
        ? 'SVG図面を表示中：部材レビュー・自由メモはPDFなしで利用できます'
        : 'PDF未読込：SVG図面を生成するとレビュー・自由メモを利用できます';
    status.title = pdfPageReady
      ? 'PDFは任意の重ね合わせです。部材レビュー・自由メモ・DXF保存はSVG図面を基準に利用できます。PDF保存・領域選択・PDF照合セッションJSON・PDF基準点取得はPDF機能です。'
      : 'SVG図面の表示・DXF保存・回転・寸法測定・部材レビュー・自由メモはPDFなしで利用できます。PDF保存・領域選択・PDF照合セッションJSON書き出し・PDF基準点取得にはPDFの読み込みが必要です。';
  }

  bindEvents() {
    this.candidateUi = new PdfOverlayCandidateController({
      surface: this.e['pdf-overlay-scroll'],
      isEnabled: () =>
        this.root.classList.contains('visible') &&
        !this.measurementUi?.isActive() &&
        !this.sessionUi?.isTagEditMode(),
      describe: (elementKey) => {
        const record = this.drawing?.elements.find((item) => item.key === elementKey);
        return record
          ? `${record.ref.elementType} ${record.ref.elementId}${record.mark ? ` (${record.mark})` : ''} [${record.ref.modelKey}]`
          : elementKey;
      },
    });
    eventBus.on(ModelEvents.CLEARED, () => {
      this.invalidateDrawing('モデルが解除されました。SVG図面を再生成してください。');
      this.refreshModelAndStories();
    });
    eventBus.on(ModelEvents.LOADED, ({ slot } = {}) => {
      if (slot !== this.e['pdf-overlay-model'].value) return;
      this.invalidateDrawing('モデルを更新しました。SVG図面を再生成してください。');
      this.refreshModelAndStories();
    });
    this.e['pdf-overlay-model'].addEventListener('change', () => {
      this.invalidateDrawing('モデルを変更しました。SVG図面を再生成してください。');
      this.refreshModelAndStories();
    });
    this.e['pdf-overlay-story'].addEventListener('change', () => {
      this.invalidateDrawing('階を変更しました。SVG図面を再生成してください。');
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
    this.e['pdf-overlay-dxf-file'].addEventListener('change', () =>
      this.loadReferenceDxfFiles().catch((error) => this.fail(error)),
    );
    this.root
      .querySelector('#pdf-overlay-dxf-clear')
      .addEventListener('click', () => this.clearReferenceDrawings());
    this.e['pdf-overlay-dxf-reference-list'].addEventListener('change', (event) =>
      this.handleReferenceDrawingControl(event),
    );
    this.e['pdf-overlay-dxf-reference-list'].addEventListener('input', (event) =>
      this.handleReferenceDrawingControl(event),
    );
    this.e['pdf-overlay-dxf-reference-list'].addEventListener('click', (event) => {
      const remove = event.target?.closest?.('[data-reference-action="remove"]');
      if (remove) this.removeReferenceDrawing(remove.dataset.documentId);
    });
    this.root
      .querySelector('#pdf-overlay-export-pdf')
      .addEventListener('click', () =>
        this.exportPdfWithAnnotations().catch((error) => this.fail(error)),
      );
    this.root
      .querySelector('#pdf-overlay-export-dxf')
      .addEventListener('click', () =>
        this.exportCurrentDrawingDxf().catch((error) => this.fail(error)),
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
    this.e['pdf-overlay-drawing-rotation'].addEventListener('change', () => {
      try {
        this.setDrawingRotationDeg(this.e['pdf-overlay-drawing-rotation'].value, {
          invalidatePlacement: true,
          render: true,
          notify: true,
        });
      } catch (error) {
        this.fail(error);
      }
    });
    this.e['pdf-overlay-tag-orientation'].addEventListener('change', () => {
      try {
        this.setTagOrientationMode(this.e['pdf-overlay-tag-orientation'].value);
      } catch (error) {
        this.fail(error);
      }
    });
    this.e['pdf-overlay-cut-fill'].addEventListener('change', () => {
      this.e['pdf-overlay-cut-fill-opacity'].disabled =
        this.exportingPdf || !this.e['pdf-overlay-cut-fill'].checked;
      this.renderOverlay();
    });
    this.e['pdf-overlay-cut-fill-opacity'].addEventListener('input', () => this.renderOverlay());
    this.e['pdf-overlay-opacity'].addEventListener('input', () => {
      this.e['pdf-overlay-svg-layer'].style.opacity = this.e['pdf-overlay-opacity'].value;
    });
    const redrawForDrawingDisplaySetting = (event) => {
      if (!shouldRedrawPdfDrawingForDisplaySettingEvent(event)) return;
      const target = event?.target;
      if (
        event?.type === 'change' &&
        target?.matches?.('.element-settings-table select[name="pdfDrawingTagMode"]')
      ) {
        this.sessionUi?.syncTagFamilySelection(target.dataset.elementType, target.value);
      }
      if (this.drawing && this.root.classList.contains('visible')) this.renderOverlay();
    };
    document.addEventListener('change', redrawForDrawingDisplaySetting);
    document.addEventListener('click', redrawForDrawingDisplaySetting);
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
          return showWarning('SVG図面を先に生成してください。');
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
    this.e['pdf-overlay-stage'].addEventListener('pointermove', (event) =>
      this.measurementUi?.handleStagePointerMove(event),
    );
    this.e['pdf-overlay-stage'].addEventListener('pointerleave', () =>
      this.measurementUi?.handleStagePointerLeave(),
    );
    this.e['pdf-overlay-stage'].addEventListener('click', (event) => this.handleStageClick(event));
    this.root.ownerDocument.addEventListener('keydown', (event) =>
      this.handleSelectionEscape(event),
    );
    this.updateScaleControls();
    this.updateZoomLabel();
  }

  /** 図面表示中のEscで選択だけを解除する。入力・IME・他ツールの取消を奪わない。 */
  handleSelectionEscape(event) {
    if (
      event.key !== 'Escape' ||
      event.isComposing ||
      event.defaultPrevented ||
      !this.root.classList.contains('visible')
    )
      return false;
    const target = event.target;
    if (
      target?.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || '') ||
      target?.closest?.('[role="textbox"], [role="dialog"], dialog')
    )
      return false;
    if (!this.selectedElementKey && !this.selectedReferenceKey && !this.sessionUi?.selectedIdentity)
      return false;
    this.clearSelection();
    event.preventDefault();
    // window側の既存Esc処理へも伝え、3D/ツリー側の選択解除を妨げない。
    return true;
  }

  clearSelection() {
    this.selectedElementKey = null;
    this.selectedReferenceKey = null;
    this.wheelZoomAnchor = null;
    this.candidateUi?.clear();
    this.sessionUi?.clearSelection?.();
    this.applySelectionHighlight();
    if (this.e['pdf-overlay-element-info'])
      this.e['pdf-overlay-element-info'].textContent = '未選択';
    eventBus.emit(InteractionEvents.DISPLAY_ELEMENT_INFO, {
      idA: null,
      idB: null,
      elementType: null,
      modelSource: null,
    });
  }

  scaleDenominator() {
    return resolveScaleDenominator(
      this.e['pdf-overlay-scale'].value,
      this.e['pdf-overlay-custom-scale'].value,
    );
  }

  setDrawingRotationDeg(value, { invalidatePlacement = true, render = true, notify = false } = {}) {
    const rotation = Number(value);
    if (![0, 90, 180, 270].includes(rotation))
      throw new RangeError('SVG回転は0°、90°、180°、270°のいずれかにしてください。');
    const changed = rotation !== this.drawingRotationDeg;
    this.drawingRotationDeg = rotation;
    if (this.e['pdf-overlay-drawing-rotation'])
      this.e['pdf-overlay-drawing-rotation'].value = String(rotation);
    if (!changed) {
      if (render) this.renderOverlay();
      return false;
    }

    this.cancelScheduledZoom();
    this.sheetLayout = null;
    this.sheetRenderPlan = null;
    const invalidatedPdfMeasurements =
      invalidatePlacement && Boolean(this.measurementUi?.invalidatePdfMeasurements?.());
    if (!invalidatedPdfMeasurements) this.resetMeasurementSequence('drawing-rotation');
    const hadPlacement = Boolean(this.registration || this.manualPlacement);
    if (invalidatePlacement && hadPlacement) {
      this.resetPlacementState(
        `SVG回転 ${rotation}°: PDF配置を再確認してください`,
        'DRAWING_ROTATION_CHANGED',
      );
      this.clearAnchorInputs('all');
    }
    if (render) {
      this.renderOverlay();
      this.renderDiagnostics();
    }
    if (notify && hadPlacement)
      showWarning(
        'SVG回転を変更したため、PDF重ねの位置合わせを解除しました。再配置・再確認してください。',
      );
    return true;
  }

  setTagOrientationMode(value, { render = true } = {}) {
    const mode = normalizeDrawingTagOrientationMode(value);
    const changed = mode !== this.tagOrientationMode;
    this.tagOrientationMode = mode;
    if (changed) this.sheetRenderPlan = null;
    if (this.e['pdf-overlay-tag-orientation']) this.e['pdf-overlay-tag-orientation'].value = mode;
    if (render) this.renderOverlay();
    return changed;
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
    this.sheetRenderPlan = null;
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
      hasDrawing: Boolean(this.drawing || this.referenceDrawings?.length || 0),
    });
  }

  renderDiagnostics() {
    renderPdfOverlayDiagnostics(
      this.e['pdf-overlay-diagnostics'],
      this.drawing,
      this.e['pdf-overlay-registration-result'].textContent,
    );
  }

  drawingDisplaySettings() {
    const settings = readPdfDrawingDisplaySettings(document);
    const requestedOpacity = Number(this.e['pdf-overlay-cut-fill-opacity']?.value);
    const cutSurfaceFillOpacity =
      Number.isFinite(requestedOpacity) && requestedOpacity >= 0 && requestedOpacity <= 1
        ? requestedOpacity
        : 0.18;
    return Object.freeze({
      ...settings,
      cutSurfaceFill: Boolean(this.e['pdf-overlay-cut-fill']?.checked),
      cutSurfaceFillOpacity,
    });
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

  referenceDisplaySettingsSnapshot() {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(this.referenceDisplaySettings || {}).map(([documentId, settings]) => [
          documentId,
          Object.freeze({
            visible: settings.visible !== false,
            opacity: Number(settings.opacity),
            color: settings.color || null,
            layers: Object.freeze({ ...(settings.layers || {}) }),
          }),
        ]),
      ),
    );
  }

  referenceAssetDescriptorsSnapshot() {
    const descriptors = [];
    for (const referenceDrawing of this.referenceDrawings || []) {
      const documentId = referenceDrawing?.source?.documentId;
      const descriptor = documentId ? this.referenceAssets?.get(documentId)?.descriptor : null;
      if (descriptor) descriptors.push(descriptor);
    }
    return Object.freeze(descriptors);
  }

  referencePersistenceSnapshot() {
    const records = [];
    for (const referenceDrawing of this.referenceDrawings || []) {
      const documentId = referenceDrawing?.source?.documentId;
      if (!documentId) continue;
      const descriptor = this.referenceAssets?.get(documentId)?.descriptor || null;
      if (!descriptor) continue;
      const settings = this.referenceDisplaySettings?.[documentId] || {};
      records.push(
        Object.freeze({
          schemaVersion: 1,
          kind: 'DxfReferencePersistenceRecord',
          asset: descriptor,
          display: Object.freeze({
            visible: settings.visible !== false,
            opacity:
              Number.isFinite(Number(settings.opacity)) &&
              Number(settings.opacity) >= 0 &&
              Number(settings.opacity) <= 1
                ? Number(settings.opacity)
                : 1,
            color: settings.color || null,
            layers: Object.freeze({ ...(settings.layers || {}) }),
          }),
        }),
      );
    }
    return Object.freeze(records);
  }

  referenceImportPlacement() {
    const offsetX = Number(this.e['pdf-overlay-dxf-offset-x']?.value || 0);
    const offsetY = Number(this.e['pdf-overlay-dxf-offset-y']?.value || 0);
    const rotationDeg = Number(this.e['pdf-overlay-dxf-rotation']?.value || 0);
    if (![offsetX, offsetY, rotationDeg].every(Number.isFinite))
      throw new TypeError('DXF参照の配置値が不正です。');
    return Object.freeze({ originMm: Object.freeze([offsetX, offsetY]), rotationDeg });
  }

  nextReferenceDocumentId() {
    this.referenceDocumentSequence += 1;
    return `dxf-reference-${this.referenceDocumentSequence}`;
  }

  setDxfFileSelectionStatus(files) {
    const status = this.e['pdf-overlay-dxf-file-status'];
    if (!status) return;
    const paths = Array.from(files || [])
      .map(selectedFileDisplayPath)
      .filter(Boolean);
    const text = paths.length ? paths.join(' / ') : '未選択';
    status.textContent = text;
    status.title = text;
  }

  async loadReferenceDxfFiles(files = this.e['pdf-overlay-dxf-file']?.files) {
    const selected = Array.from(files || []);
    if (!selected.length) return [];
    this.setDxfFileSelectionStatus(selected);
    // Capture Files before clearing the picker so the same file can be retried
    // after correcting its unit/placement, including after a failed import.
    if (this.e['pdf-overlay-dxf-file']) this.e['pdf-overlay-dxf-file'].value = '';
    for (const file of selected) {
      if (!isDxfFile(file)) throw new TypeError(`DXFファイルではありません: ${file.name}`);
    }
    this.services = this.services || this.getServices();
    if (typeof this.services.createDxfReferenceDrawing !== 'function')
      throw new Error('DXF参照取込サービスが初期化されていません。');

    const unitOverride = this.e['pdf-overlay-dxf-unit']?.value || null;
    const placement = this.referenceImportPlacement();
    const pending = [];
    this.setStatus(`DXF参照を読み込んでいます… ${selected.length}ファイル`);
    for (const file of selected) {
      const documentId = this.nextReferenceDocumentId();
      const imported = await this.services.createDxfReferenceDrawing({
        file,
        documentId,
        unitOverride,
        placement,
      });
      pending.push({ file, documentId, imported });
    }

    for (const { file, documentId, imported } of pending) {
      const referenceDrawing = imported.referenceDrawing;
      this.referenceDrawings.push(referenceDrawing);
      this.referenceAssets.set(
        documentId,
        Object.freeze({
          file,
          descriptor: imported.assetDescriptor,
        }),
      );
      this.referenceDisplaySettings[documentId] = {
        visible: true,
        opacity: 0.65,
        color: null,
        layers: Object.fromEntries(referenceDrawing.layers.map((layer) => [layer.id, true])),
      };
    }
    this.sheetLayout = null;
    this.sheetRenderPlan = null;
    this.renderReferenceDrawingList();
    this.updatePdfFeatureAvailability();
    if (this.e['pdf-overlay-display-mode'].value === 'stb') this.renderOverlay();

    const diagnostics = pending.reduce(
      (sum, item) =>
        sum +
        item.imported.referenceDrawing.stats.approximated +
        item.imported.referenceDrawing.stats.unsupported +
        item.imported.referenceDrawing.stats.failed,
      0,
    );
    const defaultedUnits = pending.filter(
      (item) => item.imported.referenceDrawing.transform?.unitResolution === 'default-mm',
    ).length;
    this.setStatus(
      `DXF参照 ${this.referenceDrawings.length}ファイル / 追加 ${pending.length}ファイル / 診断 ${diagnostics}件${defaultedUnits ? ` / 単位未定義→mm ${defaultedUnits}件` : ''}`,
    );
    if (diagnostics || defaultedUnits) {
      const notices = [];
      if (defaultedUnits)
        notices.push(`単位を確認できない${defaultedUnits}ファイルはmmとして読み込みました`);
      if (diagnostics) notices.push(`近似・未対応・失敗の診断が${diagnostics}件あります`);
      showWarning(`DXF参照を追加しました。${notices.join('。')}。`);
    } else showSuccess('DXF参照をSVG図面へ追加しました。');
    return pending.map((item) => item.imported.referenceDrawing);
  }

  clearReferenceDrawings() {
    if (!this.referenceDrawings.length) return;
    this.referenceDrawings = [];
    this.referenceDisplaySettings = {};
    this.referenceAssets.clear();
    this.selectedReferenceKey = null;
    this.sheetLayout = null;
    this.sheetRenderPlan = null;
    this.renderReferenceDrawingList();
    this.updatePdfFeatureAvailability();
    this.renderOverlay();
    this.setStatus(
      this.drawing ? 'DXF参照を全解除しました。STB図面を表示します。' : 'DXF参照を全解除しました。',
    );
  }

  removeReferenceDrawing(documentId) {
    if (!documentId) return;
    const before = this.referenceDrawings.length;
    this.referenceDrawings = this.referenceDrawings.filter(
      (referenceDrawing) => referenceDrawing.source.documentId !== documentId,
    );
    if (this.referenceDrawings.length === before) return;
    delete this.referenceDisplaySettings[documentId];
    this.referenceAssets.delete(documentId);
    this.selectedReferenceKey = null;
    this.sheetLayout = null;
    this.sheetRenderPlan = null;
    this.renderReferenceDrawingList();
    this.updatePdfFeatureAvailability();
    this.renderOverlay();
  }

  handleReferenceDrawingControl(event) {
    const target = event.target;
    const documentId = target?.dataset?.documentId;
    if (!documentId || !this.referenceDisplaySettings[documentId]) return;
    const settings = this.referenceDisplaySettings[documentId];
    const role = target.dataset.referenceRole;
    if (role === 'visible') settings.visible = Boolean(target.checked);
    else if (role === 'opacity') settings.opacity = Number(target.value);
    else if (role === 'color-enabled') {
      settings.color = target.checked
        ? target
            .closest('[data-reference-document]')
            ?.querySelector('[data-reference-role="color"]')?.value || '#6c757d'
        : null;
    } else if (role === 'color') {
      const enabled = target
        .closest('[data-reference-document]')
        ?.querySelector('[data-reference-role="color-enabled"]')?.checked;
      if (enabled) settings.color = target.value;
    } else if (role === 'layer') {
      settings.layers[target.dataset.layerId] = Boolean(target.checked);
    } else return;
    this.sheetRenderPlan = null;
    if (this.e['pdf-overlay-display-mode'].value === 'stb') this.renderOverlay();
  }

  renderReferenceDrawingList() {
    const container = this.e['pdf-overlay-dxf-reference-list'];
    const status = this.e['pdf-overlay-dxf-reference-status'];
    if (!container || !status) return;
    container.replaceChildren();
    if (!this.referenceDrawings.length) {
      status.textContent = 'DXF未読込';
      return;
    }
    status.textContent = `${this.referenceDrawings.length}ファイル / layer ${this.referenceDrawings.reduce(
      (sum, referenceDrawing) => sum + referenceDrawing.layers.length,
      0,
    )}`;

    for (const referenceDrawing of this.referenceDrawings) {
      const documentId = referenceDrawing.source.documentId;
      const settings = this.referenceDisplaySettings[documentId];
      const details = make('details', { open: true, 'data-reference-document': documentId });
      const summary = make('summary');
      const visible = make('input', {
        type: 'checkbox',
        'data-document-id': documentId,
        'data-reference-role': 'visible',
      });
      visible.checked = settings.visible !== false;
      const diagnosticCount =
        referenceDrawing.stats.approximated +
        referenceDrawing.stats.unsupported +
        referenceDrawing.stats.failed;
      const unitLabel =
        referenceDrawing.transform?.unitResolution === 'default-mm'
          ? 'mm（未定義→既定）'
          : referenceDrawing.transform?.sourceUnits || '単位不明';
      summary.append(
        visible,
        document.createTextNode(
          ` ${referenceDrawing.source.filename || documentId} / ${referenceDrawing.stats.primitives}図形 / 単位 ${unitLabel} / 診断 ${diagnosticCount}件`,
        ),
      );
      details.append(summary);

      const controls = make('div', { class: 'pdf-overlay-dxf-reference-controls' });
      const opacity = make('input', {
        type: 'range',
        min: '0',
        max: '1',
        step: '0.05',
        value: String(settings.opacity),
        'data-document-id': documentId,
        'data-reference-role': 'opacity',
      });
      const colorEnabled = make('input', {
        type: 'checkbox',
        'data-document-id': documentId,
        'data-reference-role': 'color-enabled',
      });
      colorEnabled.checked = Boolean(settings.color);
      const color = make('input', {
        type: 'color',
        value: settings.color || '#6c757d',
        'data-document-id': documentId,
        'data-reference-role': 'color',
      });
      const remove = make(
        'button',
        {
          type: 'button',
          class: 'btn btn-secondary btn-sm',
          'data-document-id': documentId,
          'data-reference-action': 'remove',
        },
        '解除',
      );
      const opacityLabel = make('label', {}, '濃さ ');
      opacityLabel.append(opacity);
      const colorLabel = make('label');
      colorLabel.append(colorEnabled, document.createTextNode(' 色上書き '), color);
      controls.append(opacityLabel, colorLabel, remove);
      details.append(controls);

      const layerList = make('div', { class: 'pdf-overlay-dxf-layer-list' });
      for (const layer of referenceDrawing.layers) {
        const checkbox = make('input', {
          type: 'checkbox',
          'data-document-id': documentId,
          'data-reference-role': 'layer',
          'data-layer-id': layer.id,
        });
        checkbox.checked = settings.layers[layer.id] !== false;
        const layerLabel = make('label');
        layerLabel.append(checkbox, document.createTextNode(` ${layer.id}`));
        layerList.append(layerLabel);
      }
      details.append(layerList);

      if (referenceDrawing.diagnostics?.length) {
        const diagnostics = make('ul', { class: 'pdf-overlay-dxf-diagnostics' });
        for (const diagnostic of referenceDrawing.diagnostics.slice(0, 20)) {
          const item = make('li', {
            'data-dxf-diagnostic-status': diagnostic.status || diagnostic.severity || 'warning',
          });
          const source = diagnostic.sourceRef;
          const sourceLabel = source
            ? `${source.layer || '0'} / ${source.entityType || 'ENTITY'}${source.handle ? ` #${source.handle}` : ''}`
            : 'DXF';
          item.textContent = `[${diagnostic.status || diagnostic.severity || 'warning'}] ${sourceLabel}: ${diagnostic.reason || diagnostic.code || '診断'}`;
          diagnostics.append(item);
        }
        if (referenceDrawing.diagnostics.length > 20) {
          diagnostics.append(
            make(
              'li',
              {},
              `ほか ${referenceDrawing.diagnostics.length - 20}件（entityResultsに全件保持）`,
            ),
          );
        }
        details.append(diagnostics);
      }
      container.append(details);
    }
  }

  showSelectedReference(ref) {
    this.selectedElementKey = null;
    this.sessionUi?.clearSelection?.();
    this.selectedReferenceKey =
      ref.primitiveId ||
      JSON.stringify([
        ref.documentId,
        ...(ref.blockOccurrence || []),
        ref.entityType,
        ref.entityId,
      ]);
    this.applySelectionHighlight();
    const drawing = this.referenceDrawings.find(
      (referenceDrawing) => referenceDrawing.source.documentId === ref.documentId,
    );
    const filename = drawing?.source.filename || ref.documentId;
    this.e['pdf-overlay-element-info'].textContent =
      `DXF / ${filename} / ${ref.layer} / ${ref.entityType}${ref.handle ? ` #${ref.handle}` : ''}`;
  }

  async loadPdfRuntime() {
    return loadPdfJsRuntime();
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
    this.cancelScheduledZoom();
    this.viewZoom = 1;
    this.updateZoomLabel();
    this.resetPlacementState('PDF変更: 配置未設定', 'PDF_CHANGED');
    this.measurementUi?.invalidatePdfMeasurements();
    this.clearAnchorInputs('pdf');
    this.pageRender = null;
    this.updatePdfFeatureAvailability();
    this.regionUi.resetForPdf();
    const preserveSvgDisplay =
      this.e['pdf-overlay-display-mode'].value !== 'pdf' &&
      Boolean(this.drawing || this.referenceDrawings?.length || 0);
    this.e['pdf-overlay-canvas-layer'].replaceChildren();
    if (!preserveSvgDisplay) this.e['pdf-overlay-svg-layer'].replaceChildren();
    this.setStatus('PDF.jsを読み込んでいます…');
    try {
      const runtimeInfo = getPdfJsRuntimeInfo();
      const pdfjs = await this.loadPdfRuntime();
      this.services = this.getServices();
      await this.pdfAdapter?.close?.();
      this.pdfAdapter = this.services.createPdfDocument({
        pdfjs,
        assetUrls: runtimeInfo.assetUrls,
      });
      const info = await this.pdfAdapter.open(file, {
        requestPassword: async () =>
          globalThis.prompt?.('PDFパスワードを入力してください。') ?? null,
      });
      this.e['pdf-overlay-page'].max = String(info.numPages);
      this.e['pdf-overlay-page'].value = '1';
      this.setStatus(`${info.filename} / ${info.numPages}ページ`);
      await this.renderPdf();
      showSuccess(
        this.e['pdf-overlay-display-mode'].value === 'pdf'
          ? 'PDFを読み込みました。'
          : 'PDFを読み込みました。表示はSVG図面のままです。',
      );
    } catch (error) {
      if (preserveSvgDisplay) {
        try {
          this.renderOverlay();
        } catch (restoreError) {
          log.error(restoreError);
        }
      }
      this.updatePdfFeatureAvailability();
      throw error;
    }
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
    const pdfFile = files.find(isPdfFile) || null;
    const dxfFiles = files.filter(isDxfFile);
    if (!pdfFile && !dxfFiles.length) {
      showWarning('PDFまたはDXFファイルをドロップしてください。');
      return true;
    }
    if (pdfFile) await this.loadPdfFile(pdfFile);
    if (dxfFiles.length) await this.loadReferenceDxfFiles(dxfFiles);
    return true;
  }

  async exportPdfWithAnnotations() {
    if (this.exportingPdf) return;
    if (!this.pdfAdapter?.info || !this.pageRender)
      return showWarning('PDFを読み込み、表示してから保存してください。');

    const button = this.root.querySelector('#pdf-overlay-export-pdf');
    const previousText = (button && getCommandLabel(button)) || 'PDF保存';
    this.exportingPdf = true;
    this.updatePdfFeatureAvailability();
    if (button) {
      button.disabled = true;
      setCommandLabel(button, 'PDF保存中…');
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
        setCommandLabel(button, previousText);
      }
    }
  }

  runPdfExport(options) {
    return exportAnnotatedPdf(this, options);
  }

  createCurrentSheetRenderPlan(
    layout,
    displaySettings = this.drawingDisplaySettings(),
    { registerTagContext = true } = {},
  ) {
    this.services = this.services || this.getServices();
    if (typeof this.services.createSheetRenderPlan !== 'function')
      throw new Error('共通DrawingRenderPlanサービスが初期化されていません。');
    return this.services.createSheetRenderPlan({
      drawing: this.drawing,
      referenceDrawings: this.referenceDrawings || [],
      referenceDisplaySettings: this.referenceDisplaySettingsSnapshot(),
      layout,
      displaySettings,
      measurements: this.measurementUi?.completedSheetMeasurements() || [],
      showLabels: true,
      tagFamilyState: this.sessionUi?.tagFamilyState || null,
      resolveTagFacts: this.tagFactsResolver,
      resolveTagPlacement: (context) => {
        if (!this.sessionUi) return null;
        if (registerTagContext) return this.sessionUi.resolveTagPlacement(context) || null;
        return this.sessionUi.placementForContext?.(context) || null;
      },
      tagOrientationMode: this.tagOrientationMode,
    });
  }

  async exportCurrentDrawingDxf({ notify = true } = {}) {
    if (this.exportingDxf) return null;
    if (!this.drawing && !(this.referenceDrawings?.length || 0)) {
      showWarning('STB図面を生成するかDXF参照を追加してからDXF保存してください。');
      return null;
    }
    this.services = this.services || this.getServices();
    if (typeof this.services.downloadDrawingRenderPlanDxf !== 'function')
      throw new Error('DrawingRenderPlan DXFサービスが初期化されていません。');

    const scaleDenominator = this.scaleDenominator();
    const layout = this.services.createSheetLayout({
      drawing: this.drawing,
      referenceDrawings: this.referenceDrawings || [],
      paper: 'A3',
      orientation: 'landscape',
      scaleDenominator,
      drawingRotationDeg: this.drawingRotationDeg,
    });
    const canReuseCurrentPlan =
      this.e['pdf-overlay-display-mode'].value === 'stb' &&
      this.sheetRenderPlan &&
      this.sheetLayout?.scaleDenominator === scaleDenominator &&
      this.sheetLayout?.drawingRotationDeg === this.drawingRotationDeg;
    const renderPlan = canReuseCurrentPlan
      ? this.sheetRenderPlan
      : this.createCurrentSheetRenderPlan(layout, this.drawingDisplaySettings(), {
          registerTagContext: false,
        });
    const filename = this.drawing
      ? currentDrawingDxfFilename(this.drawing, scaleDenominator)
      : `DXF_reference_1-${dxfFilenamePart(scaleDenominator, 'scale')}.dxf`;
    const button = this.root.querySelector('#pdf-overlay-export-dxf');
    const previousText = (button && getCommandLabel(button)) || 'DXF保存';

    this.exportingDxf = true;
    this.updatePdfFeatureAvailability();
    if (button) setCommandLabel(button, 'DXF保存中…');
    try {
      const result = await this.services.downloadDrawingRenderPlanDxf(renderPlan, filename);
      log.info('DrawingRenderPlan DXF保存:', {
        filename,
        ...(result?.exportLog || {}),
        stats: result?.stats || null,
      });
      const warnings = (result?.diagnostics || []).filter(
        (diagnostic) => diagnostic.severity === 'warning' || diagnostic.severity === 'error',
      );
      this.setStatus(
        warnings.length
          ? `${filename} を保存しました / DXF診断 ${warnings.length}件`
          : `${filename} を保存しました`,
      );
      if (notify) {
        if (warnings.length)
          showWarning(`DXFを保存しました。表現差・未対応の診断が${warnings.length}件あります。`);
        else showSuccess('現在のSVG図面と同じRenderPlanからDXFを保存しました。');
      }
      return result;
    } finally {
      this.exportingDxf = false;
      this.updatePdfFeatureAvailability();
      if (button) setCommandLabel(button, previousText);
    }
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
      this.renderDiagnostics();
      await this.sessionUi?.onAssetsChanged();
      // diagnostics/session UIの更新後、次frameのlayoutまで含めてズーム固定点を復元する。
      if (focus) await this.restoreZoomFocusAfterLayout(focus);
    })();
    this.pdfRenderPromise = renderPromise;
    try {
      await renderPromise;
    } finally {
      if (this.pdfRenderPromise === renderPromise) this.pdfRenderPromise = null;
    }
  }

  async buildDrawing() {
    const previousDrawing = this.drawing;
    const modelKey = this.e['pdf-overlay-model'].value;
    const doc = getState(`models.document${modelKey}`);
    if (doc?.nodeType !== 9) throw new Error(`モデル${modelKey}を先に読み込んでください。`);
    const stories = parseStories(doc);
    const storyId = this.e['pdf-overlay-story'].value;
    if (!storyId) throw new Error('対象階を選択してください。');
    const view = storyView(stories, storyId);
    this.abortController?.abort();
    const abortController = new globalThis.AbortController();
    this.abortController = abortController;
    this.services = this.services || this.getServices();
    this.setStatus('STB平面図を抽出しています…');
    let drawing;
    try {
      drawing = await this.services.createDrawing({
        modelKey,
        view,
        signal: abortController.signal,
      });
    } catch (error) {
      if (abortController.signal.aborted || this.abortController !== abortController) return;
      throw error;
    }
    if (abortController.signal.aborted || this.abortController !== abortController) return;
    let tagFactsResolver = null;
    if (typeof this.services.createTagFactsResolver === 'function') {
      tagFactsResolver = await this.services.createTagFactsResolver({ modelKey, drawing });
    }
    if (abortController.signal.aborted || this.abortController !== abortController) return;
    this.measurementUi?.invalidateDrawing();
    const drawingChangeCode = !previousDrawing
      ? null
      : previousDrawing.source?.modelKey !== drawing.source?.modelKey
        ? 'MODEL_CHANGED'
        : previousDrawing.source?.modelRevision !== drawing.source?.modelRevision
          ? 'STB_CHANGED'
          : JSON.stringify(planViewContextSnapshot(previousDrawing.view)) !==
              JSON.stringify(planViewContextSnapshot(drawing.view))
            ? 'STB_VIEW_CHANGED'
            : null;
    if (drawingChangeCode) this.sessionUi?.invalidateTagPlacements(drawingChangeCode);
    this.clearSelection();
    this.drawing = drawing;
    this.tagFactsResolver = tagFactsResolver;
    // PDF配置は再生成ごとに解除するが、部材レビューはSTB原本・改訂・viewが実際に変わった場合だけ失効させる。
    this.resetPlacementState('STB図面更新: 配置未設定', drawingChangeCode || 'PLACEMENT_CHANGED');
    if (drawingChangeCode) this.regionUi.invalidateDrawing();
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
    if (this.e['pdf-overlay-display-mode'].value === 'stb') showSuccess('SVG図面を生成しました。');
  }

  renderSheet({ focus = null } = {}) {
    this.currentModelToCss = null;
    this.updatePdfFeatureAvailability();
    const layer = this.e['pdf-overlay-svg-layer'];
    layer.replaceChildren();
    if (!this.drawing && !(this.referenceDrawings?.length || 0)) return;
    this.services = this.services || this.getServices();
    const scaleDenominator = this.scaleDenominator();
    const layout = this.services.createSheetLayout({
      drawing: this.drawing,
      referenceDrawings: this.referenceDrawings || [],
      paper: 'A3',
      orientation: 'landscape',
      scaleDenominator,
      previewPxPerMm: sheetPreviewPxPerMm(this.viewZoom),
      drawingRotationDeg: this.drawingRotationDeg,
    });
    this.sheetLayout = layout;
    const modelToSheetCss = multiplyAffine([...layout.paperToCss], [...layout.modelToPaper]);
    this.currentModelToCss = Array.isArray(layout.modelToPreviewCss)
      ? [...layout.modelToPreviewCss]
      : multiplyAffine([layout.previewPxPerMm, 0, 0, layout.previewPxPerMm, 0, 0], modelToSheetCss);
    this.updatePdfFeatureAvailability();
    this.e['pdf-overlay-canvas-layer'].replaceChildren();
    this.e['pdf-overlay-stage'].style.width = `${layout.previewWidthPx}px`;
    this.e['pdf-overlay-stage'].style.height = `${layout.previewHeightPx}px`;
    if (this.drawing) this.sessionUi?.beginTagRender();
    const displaySettings = this.drawingDisplaySettings();
    const renderPlan = this.createCurrentSheetRenderPlan(layout, displaySettings);
    this.sheetRenderPlan = renderPlan;
    const svg = this.services.renderDrawingSheetSvg({
      drawing: this.drawing,
      referenceDrawings: this.referenceDrawings || [],
      referenceDisplaySettings: this.referenceDisplaySettingsSnapshot(),
      layout,
      renderPlan,
      displaySettings,
      tagFamilyState: this.sessionUi?.tagFamilyState || null,
      resolveTagFacts: this.tagFactsResolver,
      resolveTagPlacement: (context) => this.sessionUi?.resolveTagPlacement(context) || null,
      tagOrientationMode: this.tagOrientationMode,
      tagOffsetToCss: (offsetModel) => {
        if (
          !Array.isArray(offsetModel) ||
          offsetModel.length !== 2 ||
          !offsetModel.every(Number.isFinite)
        )
          throw new TypeError('STBタグ配置オフセットが不正です。');
        const [a, b, c, d] = modelToSheetCss;
        return [a * offsetModel[0] + c * offsetModel[1], b * offsetModel[0] + d * offsetModel[1]];
      },
      onTagPointerDown: this.sessionUi?.isTagEditMode()
        ? (event, context) => this.sessionUi.handleTagPointerDown(event, context)
        : null,
      onSelect: (ref) => {
        if (!this.measurementUi?.isActive())
          this.showSelectedElement(this.resolveCandidateRef(ref));
      },
      onReferenceSelect: (ref) => {
        if (!this.measurementUi?.isActive()) this.showSelectedReference(ref);
      },
    });
    this.candidateUi?.clear();
    layer.append(svg);
    this.applySelectionHighlight(svg);
    this.sessionUi?.appendDrawingMemos?.(svg);
    this.measurementUi?.appendVisuals?.(svg);
    this.sessionUi?.refreshSelectedTagControls();
    this.updateZoomLabel();
    if (focus) this.restoreZoomFocus(focus);
    const stbStatus = this.drawing ? ` / ${this.drawing.coverage.drawn}部材` : '';
    const referenceCount = this.referenceDrawings?.length || 0;
    const dxfStatus = referenceCount ? ` / DXF ${referenceCount}ファイル` : '';
    this.setStatus(
      `SVG図面 A3横 1:${scaleDenominator} / SVG回転 ${this.drawingRotationDeg}° / 表示 ${formatPdfOverlayViewZoom(this.viewZoom)}${stbStatus}${dxfStatus}`,
    );
  }

  /** Tabで切り替えた選択候補があれば、クリックした部材の代わりにその候補を選択する。 */
  resolveCandidateRef(clickedRef) {
    const key = this.candidateUi?.consumeCandidateKey();
    const record = key ? this.drawing?.elements.find((item) => item.key === key) : null;
    return record ? { ...record.ref } : clickedRef;
  }

  /**
   * 3D表示の選択ハイライトと同様に、選択部材のSVGだけを強調する。
   * 既定引数に ?.() を置くとesbuildの構文降格で一時変数が未宣言になり、ビルド版でReferenceErrorになるため本体で解決する。
   */
  applySelectionHighlight(svgArg) {
    const svg = svgArg ?? this.e['pdf-overlay-svg-layer']?.querySelector?.('svg');
    if (!svg?.querySelectorAll) return;
    for (const node of svg.querySelectorAll('.stb-drawing-member')) {
      node.classList.toggle(
        'is-selected',
        Boolean(this.selectedElementKey) && node.dataset.elementKey === this.selectedElementKey,
      );
    }
    for (const node of svg.querySelectorAll('.reference-drawing-primitive')) {
      node.classList.toggle(
        'is-selected',
        Boolean(this.selectedReferenceKey) &&
          node.dataset.referencePrimitiveId === this.selectedReferenceKey,
      );
    }
  }

  showSelectedElement(ref) {
    if (this.regionUi.consumeClick()) return;
    const record = this.drawing?.elements.find(
      (item) =>
        item.ref.modelKey === ref.modelKey &&
        item.ref.elementType === ref.elementType &&
        item.ref.elementId === ref.elementId,
    );
    this.selectedElementKey = record?.key ?? null;
    this.applySelectionHighlight();
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
    this.wheelZoomAnchor = null;
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
    if (mode !== 'pdf' && mode !== 'sheet') return null;
    if (mode === 'pdf' && !this.pageRender) return null;
    const scroll = this.e['pdf-overlay-scroll'];
    const stage = this.e['pdf-overlay-stage'];
    return {
      mode,
      ...capturePdfOverlayZoomAnchor({
        clientX: event.clientX,
        clientY: event.clientY,
        scrollLeft: scroll.scrollLeft,
        scrollTop: scroll.scrollTop,
        scrollRect: scroll.getBoundingClientRect(),
        stageRect: stage.getBoundingClientRect(),
      }),
    };
  }

  restoreZoomFocus(focus) {
    if (!focus || focus.mode !== this.viewportMode()) return;
    const scroll = this.e['pdf-overlay-scroll'];

    // 選択部材のズームはstage比率の近似ではなく、再描画後の実際のSVG中心を
    // 元のclient位置へ戻す。PDFのCropBox/UserUnit/回転や小数px丸めがあっても
    // 部材中心そのものを不動点にできる。
    if (
      focus.elementKey &&
      Array.isArray(focus.selectedClientPoint) &&
      focus.selectedClientPoint.length === 2 &&
      focus.selectedClientPoint.every(Number.isFinite)
    ) {
      const members =
        this.e['pdf-overlay-svg-layer']?.querySelectorAll?.('.stb-drawing-member') || [];
      const member = Array.from(members).find(
        (node) => node.dataset.elementKey === focus.elementKey,
      );
      let center = getPdfOverlayMemberClientCenter(member);
      if (center) {
        // scroll更新でスクロールバーや小数px丸めが再解決されるブラウザがあるため、
        // 実測中心を最大3回補正して固定点へ収束させる。
        for (let iteration = 0; iteration < 3; iteration += 1) {
          const dx = center[0] - focus.selectedClientPoint[0];
          const dy = center[1] - focus.selectedClientPoint[1];
          if (Math.hypot(dx, dy) <= 0.01) break;
          const beforeLeft = scroll.scrollLeft;
          const beforeTop = scroll.scrollTop;
          scroll.scrollLeft = beforeLeft + dx;
          scroll.scrollTop = beforeTop + dy;
          if (scroll.scrollLeft === beforeLeft && scroll.scrollTop === beforeTop) break;
          center = getPdfOverlayMemberClientCenter(member);
          if (!center) break;
        }
        return;
      }
    }

    const stage = this.e['pdf-overlay-stage'];
    const target = resolvePdfOverlayZoomScroll(focus, stage.getBoundingClientRect());
    scroll.scrollLeft = target.left;
    scroll.scrollTop = target.top;
  }

  async restoreZoomFocusAfterLayout(focus) {
    if (!focus) return;
    this.restoreZoomFocus(focus);
    if (typeof globalThis.requestAnimationFrame !== 'function') return;
    await new Promise((resolve) => {
      globalThis.requestAnimationFrame(() => {
        // PDF canvas/SVGの置換後、browser layoutが次frameで小数pxを再解決する場合がある。
        // paint直前の実測位置でもう一度選択部材またはカーソル固定点を補正する。
        this.restoreZoomFocus(focus);
        resolve();
      });
    });
  }

  resolveWheelZoomFocus(event, mode) {
    const elementKey = this.selectedElementKey;
    const members = elementKey
      ? this.e['pdf-overlay-svg-layer']?.querySelectorAll?.('.stb-drawing-member') || []
      : [];
    const member = Array.from(members).find((node) => node.dataset.elementKey === elementKey);
    const center = getPdfOverlayMemberClientCenter(member);
    if (center) {
      // 選択部材のmodel中心は毎回実測するが、同じ選択・同じ表示モードで連続ズームする間は
      // 最初のclient位置を正規の固定点として保持する。scrollLeft/Topが整数pxへ丸められる
      // ブラウザでも各stepの丸め誤差を次stepへ累積させない。
      const existing = this.wheelZoomAnchor;
      const selectedClientPoint =
        existing?.mode === mode &&
        existing?.elementKey === elementKey &&
        Array.isArray(existing.focus?.selectedClientPoint)
          ? existing.focus.selectedClientPoint
          : center;
      const stageFocus = this.captureZoomFocus({ clientX: center[0], clientY: center[1] }, mode);
      const focus = stageFocus
        ? {
            ...stageFocus,
            elementKey,
            selectedClientPoint: [...selectedClientPoint],
          }
        : null;
      this.wheelZoomAnchor = focus ? { mode, elementKey, focus } : null;
      return focus;
    }

    const clientX = Number(event?.clientX);
    const clientY = Number(event?.clientY);
    const hasPointer = Number.isFinite(clientX) && Number.isFinite(clientY);
    const anchor = this.wheelZoomAnchor;
    if (
      hasPointer &&
      anchor?.mode === mode &&
      anchor.clientPoint?.[0] === clientX &&
      anchor.clientPoint?.[1] === clientY
    )
      return anchor.focus;

    const focus = this.captureZoomFocus(event, mode);
    this.wheelZoomAnchor =
      focus && hasPointer
        ? {
            mode,
            clientPoint: [clientX, clientY],
            focus,
          }
        : null;
    return focus;
  }

  beginViewportPan(event) {
    if (event.button !== 2 || this.viewportMode() === 'none') return;
    const scroll = this.e['pdf-overlay-scroll'];
    event.preventDefault();
    this.wheelZoomAnchor = null;
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
    if (this.viewportMode() === 'none') return;
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

    const focus = this.resolveWheelZoomFocus(event, mode);
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
    if (viewportMode !== 'pdf') {
      this.currentModelToCss = null;
      this.e['pdf-overlay-canvas-layer'].replaceChildren();
      return;
    }
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
          drawingRotationDeg: this.drawingRotationDeg,
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
    const displaySettings = this.drawingDisplaySettings();
    const paperMmToCss = resolvePdfPaperMmToCss(this.pageRender);
    let dimensionGroups = null;
    let dimensionPaperToCss = null;
    if (Array.isArray(this.drawing.dimensionIntents) && this.drawing.dimensionIntents.length > 0) {
      if (typeof this.services.compileDimensions !== 'function')
        throw new Error('共通DimensionRenderPlanサービスが初期化されていません。');
      const dimensionContext = createPdfDimensionRenderContext(registration, this.pageRender);
      dimensionGroups = this.services.compileDimensions({
        drawing: this.drawing,
        modelToPaper: dimensionContext.modelToPaper,
        displaySettings,
      });
      dimensionPaperToCss = dimensionContext.paperToCss;
    }
    this.sessionUi?.beginTagRender();
    const tagOffsetToCss = (offsetModel) => {
      if (
        !Array.isArray(offsetModel) ||
        offsetModel.length !== 2 ||
        !offsetModel.every(Number.isFinite)
      )
        throw new TypeError('STBタグ配置オフセットが不正です。');
      const [a, b, c, d] = this.currentModelToCss;
      return [a * offsetModel[0] + c * offsetModel[1], b * offsetModel[0] + d * offsetModel[1]];
    };
    const svg = this.services.renderDrawingSvg({
      drawing: this.drawing,
      registration,
      pdfToCss,
      width: this.pageRender.width,
      height: this.pageRender.height,
      displaySettings,
      tagFamilyState: this.sessionUi?.tagFamilyState || null,
      resolveTagFacts: this.tagFactsResolver,
      resolveTagPlacement: (context) => this.sessionUi?.resolveTagPlacement(context) || null,
      tagOffsetToCss,
      tagOrientationMode: this.tagOrientationMode,
      onTagPointerDown: this.sessionUi?.isTagEditMode()
        ? (event, context) => this.sessionUi.handleTagPointerDown(event, context)
        : null,
      dimensionGroups,
      dimensionPaperToCss,
      paperMmToCss,
      onSelect: (ref) => {
        if (
          !this.measurementUi?.isActive() &&
          !this.anchorPickTarget &&
          !this.regionUi.isSelecting()
        )
          this.showSelectedElement(this.resolveCandidateRef(ref));
      },
    });
    this.candidateUi?.clear();
    layer.append(svg);
    this.applySelectionHighlight(svg);
    this.sessionUi?.refreshSelectedTagControls();
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
    showError(error?.message || '簡易CAD処理に失敗しました。');
  }
}

export function initializePdfOverlayPanel() {
  if (panel) return panel;
  const button = document.getElementById('toggle-pdf-overlay-btn');
  if (!button) {
    log.warn('簡易CADボタンがツールサイドバーに見つかりません。');
    return null;
  }

  const root = buildPdfOverlayPanelMarkup(WINDOW_ID);
  panel = new PdfOverlayPanelController(root);
  for (const def of PDF_OVERLAY_FLOAT_WINDOWS) {
    floatingWindowManager.registerWindow({
      windowId: def.windowId,
      toggleButtonId: def.toggleButtonId,
      closeButtonId: def.closeButtonId,
      headerId: def.headerId,
      draggable: true,
      resizable: true,
    });
  }

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
    if (visible) {
      panel.refreshModelAndStories();
      if (panel.drawing) panel.renderOverlay();
    }

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
