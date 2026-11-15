/** @fileoverview PDF図面照合モードの初期UI。PDF Canvas + STB SVGを同一viewportへ重ねる。 */
import { getState } from '../../../data/state/globalState.js';
import { isCoordinatedDrawingModelEvent } from '../../../app/pdfOverlay/drawingModelLifecycleEventGate.js';
import editingSession from '../../../app/editing/editingSession.js';
import { createCadOperationService } from '../../../app/editing/cadOperationService.js';
import { getSemanticGripsForSelections } from '../../../app/editing/semanticGripProvider.js';
import { cadGizmoAxisDirections } from './cadGeometryGizmoMath.js';
import { resolveCadPlanGizmoDrag } from './cadPlanGizmoSnap.js';
import {
  cadDrawingEditProjection,
  cadEditDepthVisible,
  cadProjectEditPoint,
  cadLiftEditVector,
  cadSameEditView,
} from './cadDrawingEditProjection.js';
import { bindCadPlanNodeDrag } from './cadPlanNodeDrag.js';
import { cadAbsoluteNodeMove, cadNodePosition } from './cadEditPropertyState.js';
import {
  cadTwoPointVector,
  collectCadPlanEdges,
  planCadFaceAlignment,
} from './cadEditPointerAlignment.js';
import { resolveSheetCssOverlay } from './sheetCssOverlay.js';
import {
  createCadPlanSnapEngine,
  cadPlanSnapToleranceMm,
  resolveCadPlanPointerPoint,
} from './cadPlanPointerSnap.js';
import {
  DEFAULT_DRAWING_TAG_ORIENTATION_MODE,
  normalizeDrawingTagOrientationMode,
} from '../../../config/drawingTagTemplates.js';
import { parseStories } from '../../../common-stb/import/parser/stbParserCore.js';
import { listCadDrawingViews, selectCadDrawingView } from './cadDrawingViewList.js';
import { CadSheetBrowser } from './cadSheetBrowser.js';
import { registerDrawingSheetSessionProvider } from '../../../data/drawing/drawingSheetSessionBridge.js';
import {
  inspectSavedCadElevationProject,
  serializeSavedCadElevationProject,
} from './cadElevationViewPersistence.js';
import { loadPdfJsRuntime, getPdfJsRuntimeInfo } from '../../../parser/pdf/pdfJsRuntime.js';
import { invertAffine, multiplyAffine, transformPoint } from '../../../data/drawing/affine2d.js';
import { planViewContextSnapshot } from '../../../data/drawing/drawingModel.js';
import {
  eventBus,
  EditEvents,
  InteractionEvents,
  MeasurementEvents,
  ModelEvents,
  UIEvents,
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
import { exportAnnotatedPdf, exportDrawingSheetPdf } from './PdfOverlayPdfExporter.js';
import {
  assertCadSheetPdfExportUnchanged,
  resolveCadPdfExportTarget,
} from './cadPdfExportTarget.js';
import { buildPdfOverlayPanelMarkup } from './pdfOverlayPanelMarkup.js';
import { formatLevelElevationDimensionValue } from '../../../viewer/drawing/levelElevationDimensions.js';
import { getCommandLabel, setCommandLabel } from '../../common/ribbon.js';
import { registerTopRibbon, refreshTopRibbonInset } from '../../common/ribbonInset.js';
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
import { downloadBlob } from '../../../utils/downloadHelper.js';

const log = createLogger('PdfOverlayPanel');
const WINDOW_ID = 'pdf-overlay-panel';
let panel = null;

function safeCadInfoScale(panel) {
  // Display-only information must not block drawing selection on an invalid input.
  try {
    return panel.scaleDenominator();
  } catch {
    return null;
  }
}

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
  const storyId =
    drawing?.view?.type === 'elevation'
      ? dxfFilenamePart(`${drawing.view.axisDirection}_${drawing.view.axisId}`, 'axis')
      : dxfFilenamePart(drawing?.view?.storyId, 'story');
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
    this.cadDrawingViews = [];
    this.cadViewImportSequence = 0;
    this.cadEditNodeId = null;
    this.cadEditNodeIds = [];
    this.cadEditMemberKeys = [];
    this.cadEditRestoreSelection = null;
    this.cadPointerTool = null;
    this.cadOperations = createCadOperationService(editingSession);
    this.elements = {};
    this.bindElements();
    this.regionUi = new PdfOverlayRegionController(this);
    this.sessionUi = new PdfOverlaySessionController(this);
    this.sheetBrowser = new CadSheetBrowser(this);
    this.sheetBrowser.bindEvents();
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
      'pdf-overlay-print-line-width',
      'pdf-overlay-print-line-pattern',
      'pdf-overlay-export-mode',
      'pdf-overlay-vector-font',
      'pdf-overlay-model',
      'pdf-overlay-story',
      'pdf-overlay-axis-view',
      'pdf-overlay-view-list',
      'pdf-overlay-view-name',
      'pdf-overlay-elevation-depth',
      'pdf-overlay-view-source',
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
      'cad-edit-toggle',
      'cad-edit-kind',
      'cad-edit-follow-nodes',
      'cad-edit-dx',
      'cad-edit-dy',
      'cad-edit-apply',
      'cad-edit-status',
      'cad-edit-property-title',
      'cad-edit-node-properties',
      'cad-edit-property-x',
      'cad-edit-property-y',
      'cad-edit-property-z',
      'cad-edit-position-apply',
      'cad-edit-align-axis',
      'cad-edit-align-value',
      'cad-edit-align-apply',
      'cad-edit-undo',
      'cad-edit-redo',
      'cad-edit-pointer-move',
      'cad-edit-pointer-copy',
      'cad-edit-pointer-face',
      'cad-edit-pointer-cancel',
      'cad-edit-pointer-status',
      'cad-edit-snap',
      'cad-edit-ortho',
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

  resetPlacementState(
    message = '未設定',
    invalidationCode = 'ALIGNMENT_MISSING',
    { invalidateReviews = true } = {},
  ) {
    this.registration = null;
    this.manualPlacement = null;
    this.anchorPickTarget = null;
    this.currentModelToCss = null;
    this.e['pdf-overlay-registration-result'].textContent = message;
    if (invalidateReviews) this.sessionUi?.invalidateReviews(invalidationCode);
  }

  invalidateDrawing(message) {
    // Any change to the source/view invalidates a pending named-view import.
    ++this.cadViewImportSequence;
    this.cadEditNodeId = null;
    this.cadEditNodeIds = [];
    this.cadEditMemberKeys = [];
    this.cadEditRestoreSelection = null;
    this.cadPointerTool = null;
    this.sessionUi?.closeOpenDrawingProject?.();
    this.measurementUi?.invalidateDrawing();
    this.abortController?.abort();
    this.abortController = null;
    this.drawing = null;
    this.sheetBrowser?.invalidatePreviewSources?.();
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

  /** Output is selected from the persistent catalog, never inferred from the visible SVG. */
  refreshPdfExportTargets() {
    const select = this.e?.['pdf-overlay-export-target'];
    if (!select?.replaceChildren) return '';
    const project = this.sessionUi?.loadedDrawingProject;
    const sheets = (project?.drawingSheets ?? []).filter((item) => item.kind !== 'section-list');
    const views = project?.drawingDocuments ?? [];
    const displayMode = this.e?.['pdf-overlay-display-mode']?.value;
    const pdfReady = Boolean(this.pdfAdapter?.info && this.pageRender);
    const currentReady = Boolean(this.drawing || this.referenceDrawings?.length);
    const entries = [
      ...sheets.map((item) => ['sheet:' + item.id, item.number + ' ' + item.name, 'シート']),
      ...views.map((item) => ['view:' + item.id, item.name || item.id, 'ビュー']),
      ...(displayMode === 'pdf' && pdfReady
        ? [['pdf', '読み込みPDF（注記付き・PDFのみ）', 'その他']]
        : []),
      ...(displayMode === 'stb' && currentReady && !this.sheetBrowser?.mainViewActive
        ? [['current', '現在表示中のビュー', 'ビュー']]
        : []),
    ];
    const signature = JSON.stringify(entries);
    const activeContext =
      displayMode === 'pdf'
        ? 'pdf'
        : this.sheetBrowser?.mainViewActive && this.sheetBrowser?.sheet?.()
          ? 'sheet:' + this.sheetBrowser.sheet().id
          : currentReady
            ? 'current'
            : this.sessionUi?.activeDrawingDocumentId
              ? 'view:' + this.sessionUi.activeDrawingDocumentId
              : '';
    const contextChanged = this.pdfExportActiveContext !== activeContext;
    const optionsChanged = this.pdfExportTargetSignature !== signature;
    if (optionsChanged || contextChanged) {
      const previous = select.value;
      if (optionsChanged) {
        select.replaceChildren();
        if (!entries.length) {
          const option = select.ownerDocument.createElement('option');
          option.value = '';
          option.textContent = '出力可能な図面なし';
          select.append(option);
        }
        const groups = new Map();
        for (const [value, label, category] of entries) {
          if (!groups.has(category)) {
            const group = select.ownerDocument.createElement('optgroup');
            group.label = category;
            groups.set(category, group);
            select.append(group);
          }
          const option = select.ownerDocument.createElement('option');
          option.value = value;
          option.textContent = label;
          groups.get(category).append(option);
        }
      }
      const possible = entries.map(([key]) => key);
      select.value =
        !contextChanged && possible.includes(previous)
          ? previous
          : [activeContext, ...possible].find((key) => possible.includes(key)) || '';
      this.pdfExportTargetSignature = signature;
      this.pdfExportActiveContext = activeContext;
    }
    select.disabled = !entries.length;
    return select.value;
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
    const sheetReady = Boolean(
      hasDrawingContent &&
      this.sheetLayout &&
      this.e['pdf-overlay-display-mode']?.value === 'stb' &&
      this.e['pdf-overlay-svg-layer']?.querySelector?.('svg'),
    );
    // The active CAD sheet is rendered from DrawingProject, not from sheetLayout.
    // Use its revision-checked preview instead of requiring a live single-view drawing.
    const activeCadSheet = Boolean(
      this.sheetBrowser?.mainViewActive && this.sheetBrowser?.sheet?.(),
    );
    const cadSheetReady = Boolean(
      activeCadSheet &&
      this.sheetBrowser?.sheetOccupancy?.() > 0 &&
      this.sheetBrowser?.isMainViewSheetCurrent?.(),
    );
    const selectedTarget = this.refreshPdfExportTargets();
    const project = this.sessionUi?.loadedDrawingProject;
    const chosenSheet = selectedTarget.startsWith('sheet:')
      ? project?.drawingSheets?.find(
          (item) => item.id === selectedTarget.slice(6) && item.kind !== 'section-list',
        )
      : null;
    const chosenView = selectedTarget.startsWith('view:')
      ? project?.drawingDocuments?.find((item) => item.id === selectedTarget.slice(5))
      : null;
    const sourcePresent = getState('models.documentA')?.nodeType === 9;
    const canExportPdf = selectedTarget
      ? chosenSheet
        ? sourcePresent &&
          Boolean(chosenSheet.placements?.length || chosenSheet.listPlacements?.length)
        : chosenView
          ? sourcePresent
          : selectedTarget === 'pdf'
            ? pdfPageReady && this.e['pdf-overlay-display-mode']?.value === 'pdf'
            : selectedTarget === 'current' && sheetReady
      : activeCadSheet
        ? cadSheetReady
        : pdfPageReady || sheetReady;
    setDisabled('#pdf-overlay-export-pdf', !canExportPdf || this.exportingPdf);
    const canExportDxf = chosenSheet
      ? sourcePresent &&
        Boolean(chosenSheet.placements?.length || chosenSheet.listPlacements?.length)
      : chosenView
        ? sourcePresent
        : selectedTarget === 'current'
          ? hasDrawingContent
          : !selectedTarget
            ? hasDrawingContent || cadSheetReady
            : false;
    setDisabled('#pdf-overlay-export-dxf', !canExportDxf || this.exportingDxf || this.exportingPdf);
    setDisabled('#pdf-overlay-print-line-width', this.exportingPdf);
    setDisabled('#pdf-overlay-print-line-pattern', this.exportingPdf);
    setDisabled('#pdf-overlay-export-mode', this.exportingPdf);
    setDisabled('#pdf-overlay-vector-font', this.exportingPdf);
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
    // A saved multi-view/sheet project is exportable without an active plan.
    setDisabled(
      '#pdf-overlay-export-drawing-project',
      !this.sessionUi?.loadedDrawingProject &&
        (!this.drawing || this.drawing.view?.type !== 'plan'),
    );
    // #565: a loaded sheet/view project is archived as saved, without an open drawing.
    const savedProjectLoaded = Boolean(this.sessionUi?.loadedDrawingProject);
    setDisabled(
      '#pdf-overlay-export-drawing-project-zip',
      !savedProjectLoaded && (!this.drawing || this.drawing.view?.type !== 'plan'),
    );
    setDisabled('#pdf-overlay-new-drawing-project', !this.drawing);
    setDisabled('#pdf-overlay-add-drawing-memo', !drawingTransformReady);
    this.sessionUi?.refreshLegacyPdfDrawingMemoMigrationStatus?.();
    setDisabled('#pdf-overlay-gizmo-pick-origin', !stbPdfViewReady);
    for (const key of ['a', 'b', 'c']) {
      setDisabled(`#pdf-overlay-pick-${key}`, !pdfViewReady);
      setDisabled(`#pdf-overlay-pick-model-${key}`, !stbPdfViewReady);
    }
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
    eventBus.on(ModelEvents.CLEARED, (payload) => {
      if (isCoordinatedDrawingModelEvent(payload, this)) return;
      this.invalidateDrawing('モデルが解除されました。図面を再生成してください。');
      this.refreshModelAndStories();
    });
    eventBus.on(ModelEvents.LOADED, (payload = {}) => {
      if (isCoordinatedDrawingModelEvent(payload, this)) return;
      this.handleModelLoaded(payload?.slot);
    });
    eventBus.on(EditEvents.MODE_TOGGLED, () => {
      this.cadPointerTool = null;
      this.cadEditNodeId = null;
      this.cadEditNodeIds = [];
      this.cadEditMemberKeys = [];
      this.updateCadEditControls();
      if (
        this.root.classList.contains('visible') &&
        this.drawing &&
        (!editingSession.getState()?.active || this.e['pdf-overlay-model'].value === 'A')
      )
        this.buildDrawing().catch((error) => this.fail(error));
    });
    eventBus.on(EditEvents.WORKING_DOCUMENT_CHANGED, () => {
      this.cadPointerTool = null;
      if (this.root.classList.contains('visible') && this.drawing)
        this.buildDrawing().catch((error) => this.fail(error));
    });
    this.e['cad-edit-toggle'].addEventListener('click', () => {
      if (!editingSession.getState()?.active && this.e['pdf-overlay-model'].value !== 'A')
        return showWarning('モデルAを選択してから編集を開始してください。');
      const button = document.getElementById('edit-mode-button');
      if (!button) return showWarning('モデル編集の切替コマンドがありません。');
      const wasActive = editingSession.getState()?.active === true;
      button.click();
      // Keep the historical 2D default (member offset with shared Nodes fixed).
      // Once active, this is the same setting exposed by the 3D editor.
      if (!wasActive && editingSession.getState()?.active)
        editingSession.setMoveFollowRelatedNodes(false);
      this.updateCadEditControls();
    });
    this.e['cad-edit-kind'].addEventListener('change', () => {
      this.cadPointerTool = null;
      this.clearSelection();
      this.renderOverlay();
      this.updateCadEditControls();
    });
    this.e['cad-edit-follow-nodes'].addEventListener('change', (event) => {
      if (editingSession.getState()?.active)
        editingSession.setMoveFollowRelatedNodes(event.currentTarget.checked);
      this.updateCadEditControls();
    });
    this.e['cad-edit-apply'].addEventListener('click', () => this.applyCadEditMove());
    this.e['cad-edit-position-apply'].addEventListener('click', () => this.applyCadEditPosition());
    this.e['cad-edit-align-apply'].addEventListener('click', () => this.applyCadEditAxisAlign());
    this.e['cad-edit-undo'].addEventListener('click', () => this.applyCadEditHistory('undo'));
    this.e['cad-edit-redo'].addEventListener('click', () => this.applyCadEditHistory('redo'));
    for (const kind of ['move', 'copy', 'face']) {
      this.e[`cad-edit-pointer-${kind}`].addEventListener('click', () =>
        this.startCadPointerTool(kind),
      );
    }
    this.e['cad-edit-pointer-cancel'].addEventListener('click', () => this.cancelCadPointerTool());
    for (const id of ['cad-edit-snap', 'cad-edit-ortho']) {
      this.e[id].addEventListener('change', () => {
        if (this.cadPointerTool) this.renderOverlay();
      });
    }
    this.updateCadEditControls();
    this.e['pdf-overlay-model'].addEventListener('change', () => {
      this.invalidateDrawing('モデルを変更しました。図面を再生成してください。');
      this.refreshModelAndStories();
    });
    this.e['pdf-overlay-view-list'].addEventListener('change', () => {
      this.sheetBrowser?.leaveMainViewSheet();
      ++this.cadViewImportSequence;
      this.e['pdf-overlay-view-name'].value = '';
      const view = this.selectedCadDrawingView();
      this.syncCadCutoutControls(view);
      this.invalidateDrawing('ビュー切替：図面を再生成します。');
      this.sheetBrowser?.showCadCandidateProperties?.(view, {
        modelKey: this.e['pdf-overlay-model'].value,
        depth:
          view?.type === 'elevation' ? Number(this.e['pdf-overlay-elevation-depth'].value) : null,
        scaleDenominator: safeCadInfoScale(this),
      });
      this.buildDrawing().catch((error) => this.fail(error));
    });
    this.e['pdf-overlay-axis-view'].addEventListener('change', () => {
      const axisKey = this.e['pdf-overlay-axis-view'].value;
      const view = axisKey
        ? this.cadDrawingViews.find(
            (candidate) => candidate.type === 'elevation' && candidate.key === axisKey,
          )
        : this.cadDrawingViews.find(
            (candidate) =>
              candidate.type === 'plan' && candidate.storyId === this.e['pdf-overlay-story'].value,
          );
      this.selectCadDrawingCandidate(view, '選択した通り芯または階は現在のSTBにありません。');
    });
    this.e['pdf-overlay-elevation-depth'].addEventListener('change', () => {
      if (this.selectedCadDrawingView()?.type !== 'elevation') return;
      this.invalidateDrawing('軸組図の奥行を変更しました。');
      this.buildDrawing().catch((error) => this.fail(error));
    });
    this.e['pdf-overlay-story'].addEventListener('change', () => {
      const matching = this.cadDrawingViews.find(
        (view) => view.type === 'plan' && view.storyId === this.e['pdf-overlay-story'].value,
      );
      this.selectCadDrawingCandidate(matching, '選択した階は現在のSTBにありません。');
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
    this.e['pdf-overlay-export-target']?.addEventListener('change', () =>
      this.updatePdfFeatureAvailability(),
    );
    this.root
      .querySelector('#pdf-overlay-export-dxf')
      .addEventListener('click', () =>
        this.exportSelectedDrawingDxf().catch((error) => this.fail(error)),
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
      } else if (event?.type === 'change' && target?.matches?.('#masterPdfDrawingTagMode')) {
        // 一括変更は子selectのchangeを発火しないため、保存済みfamily選択も同期する。
        document
          .querySelectorAll('.element-settings-table select[name="pdfDrawingTagMode"]')
          .forEach((select) =>
            this.sessionUi?.syncTagFamilySelection(select.dataset.elementType, select.value),
          );
      }
      if (this.drawing) this.sessionUi?.reviseOpenDrawingProject?.();
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
    this.root.querySelector('#pdf-overlay-build-btn').addEventListener('click', () => {
      // View Generation produces the selected cut and persists its ViewSpec.
      // A newer selection/import must never be registered after an old build resolves.
      const button = this.root.querySelector('#pdf-overlay-build-btn');
      if (button.disabled) return;
      this.sheetBrowser?.leaveMainViewSheet();
      const sequence = ++this.cadViewImportSequence;
      const selected = this.selectedCadDrawingView();
      const modelKey = this.e['pdf-overlay-model'].value;
      button.disabled = true;
      (async () => {
        if (!selected) throw new Error('ビュー一覧から切り出すビューを選択してください。');
        if (modelKey !== 'A')
          throw new Error('ビューの生成・登録はSTB-Aが対象です。STB-Bは表示・比較用です。');
        await this.buildDrawing();
        if (sequence !== this.cadViewImportSequence) return;
        if (
          this.e['pdf-overlay-model'].value !== modelKey ||
          this.selectedCadDrawingView()?.key !== selected.key ||
          !this.drawing ||
          this.abortController?.signal?.aborted
        )
          throw new Error('切り出し対象が変更されました。ビューを再選択して生成してください。');
        const result = await this.sheetBrowser.registerCurrentView({
          createProjectIfMissing: true,
        });
        this.setStatus(
          result.added || result.initialized
            ? `${selected.label}を生成・登録しました`
            : `${selected.label}を生成しました（ビュー登録済み）`,
        );
      })()
        .catch((error) => this.fail(error))
        .finally(() => {
          button.disabled = false;
        });
    });
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
          return showWarning('図面を先に生成してください。');
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
    if (this.cadPointerTool) {
      this.cancelCadPointerTool();
      event.preventDefault();
      return true;
    }
    if (
      !this.selectedElementKey &&
      !this.selectedReferenceKey &&
      !this.sessionUi?.selectedIdentity &&
      !this.cadEditNodeId &&
      !this.cadEditNodeIds?.length &&
      !this.cadEditMemberKeys?.length
    )
      return false;
    this.cadEditNodeId = null;
    this.clearSelection();
    this.updateCadEditControls();
    event.preventDefault();
    // window側の既存Esc処理へも伝え、3D/ツリー側の選択解除を妨げない。
    return true;
  }

  clearSelection({ preserveElementInfo = false } = {}) {
    this.selectedElementKey = null;
    this.selectedReferenceKey = null;
    this.cadEditNodeId = null;
    this.cadEditNodeIds = [];
    this.cadEditMemberKeys = [];
    this.wheelZoomAnchor = null;
    this.candidateUi?.clear();
    this.sessionUi?.clearSelection?.();
    this.applySelectionHighlight();
    this.refreshCadEditGizmo();
    if (this.e['pdf-overlay-element-info'])
      this.e['pdf-overlay-element-info'].textContent = '未選択';
    if (!preserveElementInfo)
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

  setDrawingRotationDeg(
    value,
    {
      invalidatePlacement = true,
      render = true,
      notify = false,
      skipRegistrationRevision = false,
    } = {},
  ) {
    const rotation = Number(value);
    if (![0, 90, 180, 270].includes(rotation))
      throw new RangeError('図面回転は0°、90°、180°、270°のいずれかにしてください。');
    const changed = rotation !== this.drawingRotationDeg;
    this.drawingRotationDeg = rotation;
    if (changed && !skipRegistrationRevision) this.sessionUi?.reviseOpenDrawingProject?.();
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
        `図面回転 ${rotation}°: PDF配置を再確認してください`,
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
        '図面回転を変更したため、PDF重ねの位置合わせを解除しました。再配置・再確認してください。',
      );
    return true;
  }

  setTagOrientationMode(value, { render = true, skipRegistrationRevision = false } = {}) {
    const mode = normalizeDrawingTagOrientationMode(value);
    const changed = mode !== this.tagOrientationMode;
    this.tagOrientationMode = mode;
    if (changed && !skipRegistrationRevision) this.sessionUi?.reviseOpenDrawingProject?.();
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
    this.sessionUi?.reviseOpenDrawingProject?.();
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
    if (this.sheetBrowser?.mainViewActive && this.sheetBrowser.sheet()) return 'sheet';
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
    const settings = readPdfDrawingDisplaySettings(document, this.sessionUi?.tagFamilyState);
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

  /** JSON is a ViewSpec carrier, never a saved DOM/2D raster or plan workspace. */
  async saveCadElevationView() {
    const drawing = this.drawing;
    const selected = this.selectedCadDrawingView();
    if (
      selected?.type !== 'elevation' ||
      drawing?.view?.type !== 'elevation' ||
      drawing.view.axisDirection !== selected.axisDirection ||
      drawing.view.axisId !== selected.axisId
    )
      throw new Error('保存前に対象の軸組図ビューを生成してください。');
    const source = drawing.source;
    const services = this.services || this.getServices();
    if (typeof services.assertDrawingSourceCurrent !== 'function')
      throw new Error('STB-A改訂検証サービスがありません。');
    await services.assertDrawingSourceCurrent({ source });
    if (this.drawing !== drawing || this.selectedCadDrawingView()?.key !== selected.key)
      throw new Error('保存処理中にビューが変わりました。');
    const name = this.e['pdf-overlay-view-name'].value.trim() || selected.label;
    const json = serializeSavedCadElevationProject({
      drawing,
      viewName: name,
      depth: Number(this.e['pdf-overlay-elevation-depth'].value),
      scaleDenominator: this.scaleDenominator(),
    });
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    downloadBlob(
      blob,
      `cad-elevation-${dxfFilenamePart(selected.axisDirection, 'X')}-${dxfFilenamePart(selected.axisId, 'axis')}.json`,
    );
    this.e['pdf-overlay-view-name'].value = name;
    this.setStatus(`${name} のViewSpec JSONを保存しました。`);
  }

  async loadCadElevationView(file) {
    if (!file) return;
    if (this.e['pdf-overlay-model'].value !== 'A')
      throw new Error('軸組図ビューJSONはSTB-Aを選択して読み込んでください。');
    const sequence = ++this.cadViewImportSequence;
    const originalDoc = getState('models.documentA');
    if (originalDoc?.nodeType !== 9) throw new Error('STB-Aを先に読み込んでください。');
    const saved = inspectSavedCadElevationProject(await file.text(), this.cadDrawingViews);
    if (sequence !== this.cadViewImportSequence || originalDoc !== getState('models.documentA'))
      throw new Error('JSON読込中にSTB-Aまたは選択ビューが変わりました。');
    const services = this.services || this.getServices();
    if (typeof services.assertDrawingSourceCurrent !== 'function')
      throw new Error('STB-A改訂検証サービスがありません。');
    await services.assertDrawingSourceCurrent({
      source: { modelKey: 'A', modelRevision: saved.revision },
    });
    if (
      sequence !== this.cadViewImportSequence ||
      originalDoc !== getState('models.documentA') ||
      this.e['pdf-overlay-model'].value !== 'A'
    )
      throw new Error('改訂検証中にSTB-Aまたは選択ビューが変わりました。');
    const previous = {
      selected: this.e['pdf-overlay-view-list'].value,
      depth: this.e['pdf-overlay-elevation-depth'].value,
      name: this.e['pdf-overlay-view-name'].value,
      depthDisabled: this.e['pdf-overlay-elevation-depth'].disabled,
    };
    try {
      this.e['pdf-overlay-view-list'].value = saved.view.key;
      this.syncCadCutoutControls(saved.view);
      this.e['pdf-overlay-elevation-depth'].disabled = false;
      this.e['pdf-overlay-elevation-depth'].value = String(saved.depth);
      await this.buildAxisElevationDrawing(saved.view);
      // The producer can return without committing when another build aborts it.
      // Never apply saved controls to a newer user-selected view.
      if (
        sequence !== this.cadViewImportSequence ||
        originalDoc !== getState('models.documentA') ||
        this.e['pdf-overlay-model'].value !== 'A' ||
        this.selectedCadDrawingView()?.key !== saved.view.key ||
        Number(this.e['pdf-overlay-elevation-depth'].value) !== saved.depth
      )
        throw new Error('復元中にSTB-Aまたは対象ビューが変更されました。');
      if (
        this.drawing?.view?.type !== 'elevation' ||
        this.drawing.view.axisDirection !== saved.view.axisDirection ||
        this.drawing.view.axisId !== saved.view.axisId ||
        this.drawing?.source?.modelRevision !== saved.revision
      )
        throw new Error('復元した軸組図のSTB改訂が保存値と一致しません。');
      this.setScaleDenominator(saved.scaleDenominator);
      this.sheetRenderPlan = null;
      this.e['pdf-overlay-view-name'].value = saved.name;
      this.renderOverlay();
      this.setStatus(`${saved.name} を復元しました（STB-A改訂を照合済み）。`);
    } catch (error) {
      // Never leave a committed new DrawingModel underneath restored old controls.
      // If a newer user selection superseded this import, do not disturb that view.
      if (sequence === this.cadViewImportSequence) {
        this.invalidateDrawing('ビューの復元を確定できませんでした。再選択してください。');
        this.e['pdf-overlay-view-list'].value = previous.selected;
        this.syncCadCutoutControls(this.selectedCadDrawingView());
        this.e['pdf-overlay-elevation-depth'].value = previous.depth;
        this.e['pdf-overlay-elevation-depth'].disabled = previous.depthDisabled;
        this.e['pdf-overlay-view-name'].value = previous.name;
      }
      throw error;
    }
  }

  selectedCadDrawingView() {
    const key = this.e['pdf-overlay-view-list']?.value;
    return this.cadDrawingViews.find((view) => view.key === key) || null;
  }

  /**
   * Legacy internal axis/story selectors delegate to the candidate list.
   * Only the list's change handler owns invalidation and drawing generation.
   */
  selectCadDrawingCandidate(view, errorMessage = '選択したビューは現在のSTBにありません。') {
    if (!view || !this.cadDrawingViews.some((candidate) => candidate.key === view.key)) {
      this.fail(new Error(errorMessage));
      return false;
    }
    const list = this.e['pdf-overlay-view-list'];
    if (!list || !Array.from(list.options).some((option) => option.value === view.key)) {
      this.fail(new Error(errorMessage));
      return false;
    }
    list.value = view.key;
    list.dispatchEvent(new this.root.ownerDocument.defaultView.Event('change'));
    return true;
  }

  /** Keep the floating cutout controls and the saved/candidate view selection synchronized. */
  syncCadCutoutControls(view) {
    const isElevation = view?.type === 'elevation';
    this.e['pdf-overlay-elevation-depth'].disabled = !isElevation;
    this.e['pdf-overlay-story'].disabled = isElevation;
    if (view?.type === 'plan') this.e['pdf-overlay-story'].value = view.storyId;
    this.e['pdf-overlay-axis-view'].value = isElevation ? view.key : '';
  }

  handleModelLoaded(slot) {
    if (slot !== this.e['pdf-overlay-model'].value) {
      // Loading STB-A must initialize its drawing catalog even when comparing STB-B.
      if (slot === 'A') this.initializeDefaultCadViews();
      return;
    }
    this.invalidateDrawing('モデルを更新しました。図面を再生成してください。');
    this.refreshModelAndStories();
  }

  /** Default views are sourced from STB-A even if STB-B is selected or not loaded. */
  initializeDefaultCadViews() {
    if (!this.root.classList.contains('visible')) return;
    this.sheetBrowser?.initializeDefaultViewsOnOpen().catch((error) => this.fail(error));
  }

  refreshModelAndStories() {
    const modelKey = this.e['pdf-overlay-model'].value;
    const doc = getState(`models.document${modelKey}`);
    const select = this.e['pdf-overlay-story'];
    const axisSelect = this.e['pdf-overlay-axis-view'];
    const list = this.e['pdf-overlay-view-list'];
    const previousKey = list.value;
    select.replaceChildren();
    axisSelect.replaceChildren(make('option', { value: '' }, '指定なし（伏図）'));
    axisSelect.disabled = true;
    list.replaceChildren();
    this.cadDrawingViews = [];
    if (doc?.nodeType !== 9) {
      select.append(make('option', { value: '' }, `モデル${modelKey}未読込`));
      select.disabled = true;
      this.e['pdf-overlay-view-source'].textContent = `モデル${modelKey}未読込`;
      this.e['pdf-overlay-elevation-depth'].disabled = true;
      // Persisted view navigation is independent of STB candidate availability.
      this.sheetBrowser?.renderViewListMarks?.();
      this.initializeDefaultCadViews();
      return;
    }
    for (const story of parseStories(doc)) {
      select.append(
        make('option', { value: story.id }, `${story.name || story.id} (${story.height} mm)`),
      );
    }
    this.cadDrawingViews = listCadDrawingViews({ document: doc, modelKey });
    for (const view of this.cadDrawingViews) {
      list.append(make('option', { value: view.key }, view.label));
      if (view.type === 'elevation')
        axisSelect.append(make('option', { value: view.key }, view.label));
    }
    axisSelect.disabled = axisSelect.options.length <= 1;
    const current = this.cadDrawingViews.find((view) => view.key === previousKey);
    const selected = current || this.cadDrawingViews[0] || null;
    if (selected) list.value = selected.key;
    this.syncCadCutoutControls(selected);
    this.e['pdf-overlay-view-source'].textContent =
      `モデル${modelKey} / ${this.cadDrawingViews.length}ビュー候補`;
    this.sheetBrowser?.renderViewListMarks?.();
    this.initializeDefaultCadViews();
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
    } else showSuccess('DXF参照を図面へ追加しました。');
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
    this.cadEditNodeId = null;
    this.cadEditNodeIds = [];
    this.cadEditMemberKeys = [];
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
          : 'PDFを読み込みました。表示は図面のままです。',
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
    const selectedTarget = this.e?.['pdf-overlay-export-target']?.value || '';
    if (selectedTarget.startsWith('sheet:') || selectedTarget.startsWith('view:')) {
      const button = this.root.querySelector('#pdf-overlay-export-pdf');
      const previousText = (button && getCommandLabel(button)) || 'PDF保存';
      this.exportingPdf = true;
      this.updatePdfFeatureAvailability();
      if (button) setCommandLabel(button, 'PDF保存中…');
      try {
        const result = await this.sheetBrowser.exportRegisteredPdfTarget(selectedTarget);
        this.setStatus(`${result.filename} を保存しました`);
        showSuccess(
          '選択した' +
            (selectedTarget.startsWith('sheet:') ? 'シート' : 'ビュー') +
            'をPDF保存しました。',
        );
      } finally {
        this.exportingPdf = false;
        this.updatePdfFeatureAvailability();
        if (button) setCommandLabel(button, previousText);
      }
      return;
    }
    if (!selectedTarget && this.sheetBrowser?.mainViewActive && this.sheetBrowser?.sheet?.()) {
      // A selected DrawingProject sheet does not populate the legacy sheetLayout.
      // Its source cache and revision validation belong to CadSheetBrowser.
      if (
        !this.sheetBrowser?.sheetOccupancy?.() ||
        !this.sheetBrowser?.isMainViewSheetCurrent?.()
      ) {
        return showWarning('シート内の全ビューを生成・確認してからPDF保存してください。');
      }
      const button = this.root.querySelector('#pdf-overlay-export-pdf');
      const previousText = (button && getCommandLabel(button)) || 'PDF保存';
      this.exportingPdf = true;
      this.updatePdfFeatureAvailability();
      if (button) setCommandLabel(button, 'PDF保存中…');
      try {
        await this.sheetBrowser.saveSheetPdf();
        showSuccess('選択中のシートをPDF保存しました。');
      } finally {
        this.exportingPdf = false;
        this.updatePdfFeatureAvailability();
        if (button) setCommandLabel(button, previousText);
      }
      return;
    }
    const pdfPageReady = Boolean(this.pdfAdapter?.info && this.pageRender);
    const sheetReady = Boolean(
      this.sheetLayout &&
      (this.drawing || this.referenceDrawings?.length) &&
      this.e['pdf-overlay-display-mode']?.value === 'stb' &&
      this.e['pdf-overlay-svg-layer']?.querySelector?.('svg'),
    );
    const displayMode = this.e['pdf-overlay-display-mode']?.value;
    const exportTarget = resolveCadPdfExportTarget({ displayMode, pdfPageReady, sheetReady });
    if (!exportTarget) {
      return showWarning(
        displayMode === 'stb'
          ? '表示中の図面が確定していません。ビューを再生成してからPDF保存してください。'
          : 'PDFページを読み込んでから保存してください。',
      );
    }

    // Freeze the user's selected surface before awaiting pending renders.
    // Otherwise a view switched during the flush can be mistaken for the requested export.
    const requestedDrawing = this.drawing;
    const requestedLayout = this.sheetLayout;
    const requestedReferenceDrawings = [...(this.referenceDrawings || [])];
    const requestedPdfAdapter = this.pdfAdapter;
    const requestedPdfPageNumber = this.pageRender?.pageNumber;

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

      if (exportTarget === 'sheet') {
        // An in-flight wheel zoom recreates the preview layout with a different
        // previewPxPerMm. Accept that only when the physical sheet is unchanged.
        assertCadSheetPdfExportUnchanged({
          expectedDrawing: requestedDrawing,
          expectedLayout: requestedLayout,
          expectedReferenceDrawings: requestedReferenceDrawings,
          drawing: this.drawing,
          layout: this.sheetLayout,
          referenceDrawings: this.referenceDrawings || [],
          displayMode: this.e['pdf-overlay-display-mode']?.value,
          allowEquivalentLayout: true,
        });
        const drawingAtExport = requestedDrawing;
        const layoutAtExport = this.sheetLayout;
        const svgAtExport = this.e['pdf-overlay-svg-layer']?.querySelector?.('svg');
        const assertUnchanged = () =>
          assertCadSheetPdfExportUnchanged({
            expectedDrawing: drawingAtExport,
            expectedLayout: layoutAtExport,
            expectedReferenceDrawings: requestedReferenceDrawings,
            expectedSvg: svgAtExport,
            drawing: this.drawing,
            layout: this.sheetLayout,
            referenceDrawings: this.referenceDrawings || [],
            svg: this.e['pdf-overlay-svg-layer']?.querySelector?.('svg'),
            displayMode: this.e['pdf-overlay-display-mode']?.value,
          });
        assertUnchanged();
        if (!svgAtExport) throw new Error('PDF保存前に図面が変更されました。再生成してください。');
        if (drawingAtExport?.view?.type === 'elevation') {
          this.services = this.services || this.getServices();
          if (typeof this.services.assertDrawingSourceCurrent !== 'function')
            throw new Error('軸組図PDFのSTB改訂確認が利用できません。');
          await this.services.assertDrawingSourceCurrent({ source: drawingAtExport.source });
        }
        assertUnchanged();
        const scaleDenominator = this.scaleDenominator();
        const filename = this.drawing
          ? currentDrawingDxfFilename(this.drawing, scaleDenominator).replace(/\.dxf$/i, '.pdf')
          : `DXF_reference_1-${dxfFilenamePart(scaleDenominator, 'scale')}.pdf`;
        try {
          await this.runSheetPdfExport({
            filename,
            mode: this.e['pdf-overlay-export-mode']?.value || 'vector',
            fontFile:
              this.e['pdf-overlay-vector-font']?.files?.[0] ||
              this.sessionUi?.archivedPdfFontFile ||
              null,
            printOptions: {
              lineWidthPreset: this.e['pdf-overlay-print-line-width']?.value || 'thin',
              linePattern: this.e['pdf-overlay-print-line-pattern']?.value || 'svg',
            },
            onProgress: ({ pageNumber, numPages }) => {
              this.setStatus(`PDF保存中 ${pageNumber}/${numPages}ページ`);
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.setStatus(`PDF保存失敗: ${message}`);
          showWarning(`PDF保存に失敗しました: ${message} ラスタ互換形式への変更も選択できます。`);
          return;
        }
        this.setStatus(`${filename} を保存しました`);
        showSuccess('A3図面をPDF保存しました。');
        return;
      }

      if (
        this.e['pdf-overlay-display-mode']?.value !== 'pdf' ||
        this.pdfAdapter !== requestedPdfAdapter ||
        this.pageRender?.pageNumber !== requestedPdfPageNumber
      )
        throw new Error(
          'PDF保存中に表示ビューが変更されました。選択したビューを再確認してください。',
        );

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

  runSheetPdfExport(options) {
    return exportDrawingSheetPdf(this, options);
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
      ...(this.drawing?.view?.type === 'elevation'
        ? { formatDimensionValue: formatLevelElevationDimensionValue }
        : {}),
    });
  }

  async exportSelectedDrawingDxf({ notify = true } = {}) {
    if (this.exportingDxf || this.exportingPdf) return null;
    const target = this.e?.['pdf-overlay-export-target']?.value || '';
    if (target.startsWith('sheet:') || target.startsWith('view:')) {
      const button = this.root.querySelector('#pdf-overlay-export-dxf');
      const previousText = (button && getCommandLabel(button)) || 'DXF保存';
      this.exportingDxf = true;
      this.updatePdfFeatureAvailability();
      if (button) setCommandLabel(button, 'DXF保存中…');
      try {
        const result = await this.sheetBrowser.exportRegisteredDxfTarget(target);
        this.setStatus(`${result.filename} を保存しました`);
        if (notify)
          showSuccess(
            '選択した' +
              (target.startsWith('sheet:') ? 'シート' : 'ビュー') +
              'をDXF保存しました。',
          );
        return result;
      } finally {
        this.exportingDxf = false;
        this.updatePdfFeatureAvailability();
        if (button) setCommandLabel(button, previousText);
      }
    }
    if (target && target !== 'current') {
      showWarning('読み込みPDFはDXFへ保存できません。ビューまたはシートを選択してください。');
      return null;
    }
    return this.exportCurrentDrawingDxf({ notify });
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

    const drawingAtExport = this.drawing;
    this.exportingDxf = true;
    this.updatePdfFeatureAvailability();
    if (button) setCommandLabel(button, 'DXF保存中…');
    try {
      if (drawingAtExport?.view?.type === 'elevation') {
        if (typeof this.services.assertDrawingSourceCurrent !== 'function')
          throw new Error('軸組図のSTB改訂確認が利用できません。');
        await this.services.assertDrawingSourceCurrent({ source: drawingAtExport.source });
      }
      // The preview may change while SHA-256 is being calculated.
      // Never download a RenderPlan captured for a superseded drawing.
      if (this.drawing !== drawingAtExport)
        throw new Error('DXF保存中にビューが変更されました。新しいビューで保存してください。');
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
        else showSuccess('現在の図面をDXF形式で保存しました。');
      }
      return result;
    } finally {
      this.exportingDxf = false;
      this.updatePdfFeatureAvailability();
      if (button) setCommandLabel(button, previousText);
    }
  }

  /** Expand only the empty workspace; populated A3/PDF pages retain their real size. */
  setEmptyCanvasState(empty) {
    this.e['pdf-overlay-scroll']?.classList?.toggle('cad-empty-surface', empty);
    if (empty) {
      this.e['pdf-overlay-stage']?.style?.removeProperty?.('width');
      this.e['pdf-overlay-stage']?.style?.removeProperty?.('height');
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
      this.setEmptyCanvasState(false);
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

  async buildAxisElevationDrawing(view) {
    selectCadDrawingView(this.cadDrawingViews, view.key);
    const previousDrawing = this.drawing;
    const previousSelectedElementKey = this.selectedElementKey;
    const previousMemberKeys = [...(this.cadEditMemberKeys || [])];
    const previousNodeIds = this.selectedCadNodeIds?.() || [];
    const pendingMemberRef = this.cadEditRestoreSelection;
    const modelKey = this.e['pdf-overlay-model'].value;
    if (modelKey !== 'A') throw new Error('軸組図はSTB-Aだけから作成できます。');
    const depth = Number(this.e['pdf-overlay-elevation-depth'].value);
    if (!Number.isFinite(depth) || depth <= 0) throw new Error('軸組図の奥行は正のmm値です。');
    this.abortController?.abort();
    const controller = new globalThis.AbortController();
    this.abortController = controller;
    this.services = this.services || this.getServices();
    if (typeof this.services.createAxisElevationDrawing !== 'function')
      throw new Error('軸組図の2D producerが初期化されていません。');
    this.setStatus(`${view.label}を2Dで生成中…`);
    let drawing;
    try {
      drawing = await this.services.createAxisElevationDrawing({
        modelKey,
        axisDirection: view.axisDirection,
        axisId: view.axisId,
        depth,
        signal: controller.signal,
        working: getState('models.editing.active') === true,
      });
    } catch (error) {
      if (controller.signal.aborted || this.abortController !== controller) return;
      throw error;
    }
    if (controller.signal.aborted || this.abortController !== controller) return;
    const sameWorkingView =
      editingSession.getState()?.active === true &&
      previousDrawing?.source?.modelKey === 'A' &&
      cadSameEditView(previousDrawing.view, drawing.view);
    const previousElementRefs = sameWorkingView
      ? previousMemberKeys
          .map((key) => previousDrawing.elements?.find((item) => item.key === key)?.ref)
          .filter(Boolean)
      : [];
    const selectedRef = sameWorkingView
      ? pendingMemberRef ||
        previousDrawing.elements?.find((item) => item.key === previousSelectedElementKey)?.ref
      : null;
    // Match the plan producer: a previous project's bound view must not survive
    // a new elevation DrawingModel installed via the Build button.
    this.sessionUi?.closeOpenDrawingProject?.();
    this.measurementUi?.invalidateDrawing();
    this.sessionUi?.invalidateTagPlacements('STB_VIEW_CHANGED');
    this.clearSelection();
    this.drawing = drawing;
    this.cadEditRestoreSelection = null;
    if (sameWorkingView && selectedRef) {
      const sameIdentity = (item, ref) =>
        item.ref?.modelKey === ref.modelKey &&
        item.ref?.elementType === ref.elementType &&
        String(item.ref?.elementId) === String(ref.elementId);
      const visibleRefs = previousElementRefs.length ? previousElementRefs : [selectedRef];
      this.cadEditMemberKeys = visibleRefs
        .map((ref) => drawing.elements.find((item) => sameIdentity(item, ref))?.key)
        .filter(Boolean);
      this.selectedElementKey =
        drawing.elements.find((item) => sameIdentity(item, selectedRef))?.key ||
        this.cadEditMemberKeys.at(-1) ||
        null;
      if (this.selectedElementKey && !this.cadEditMemberKeys.includes(this.selectedElementKey))
        this.cadEditMemberKeys.push(this.selectedElementKey);
    } else if (sameWorkingView && previousNodeIds.length) {
      const doc = editingSession.getWorkingDocument();
      const nodes = new Map(
        Array.from(doc?.getElementsByTagName('StbNode') || []).map((node) => [
          String(node.getAttribute('id')),
          {
            x: Number(node.getAttribute('X')),
            y: Number(node.getAttribute('Y')),
            z: Number(node.getAttribute('Z')),
          },
        ]),
      );
      this.cadEditNodeIds = previousNodeIds.filter((id) =>
        cadEditDepthVisible(drawing.view, nodes.get(String(id))),
      );
      this.cadEditNodeId = this.cadEditNodeIds.at(-1) ?? null;
    }
    this.sheetBrowser?.invalidatePreviewSources?.();
    this.tagFactsResolver = null;
    this.sheetLayout = null;
    this.sheetRenderPlan = null;
    this.resetPlacementState('軸組図ビュー：PDF位置合わせなし', 'STB_VIEW_CHANGED');
    this.regionUi.invalidateDrawing();
    this.clearAnchorInputs('model');
    this.alignmentCandidates = [];
    this.gizmoOrigin = null;
    this.e['pdf-overlay-display-mode'].value = 'stb';
    this.e['pdf-overlay-view-source'].textContent =
      `${view.label} / STB-A改訂 ${drawing.source.modelRevision.slice(0, 12)} / 奥行±${depth}mm`;
    this.renderOverlay();
    if (sameWorkingView && (this.selectedElementKey || this.cadEditNodeId))
      this.refreshSelectedCadElementInfo();
    this.updatePdfFeatureAvailability();
    this.renderDiagnostics();
    if (!this.sheetBrowser?.mainViewActive && this.selectedCadDrawingView()?.key === view.key)
      this.sheetBrowser?.showCadCandidateProperties?.(
        view,
        { modelKey: 'A', depth, scaleDenominator: safeCadInfoScale(this) },
        { reveal: false },
      );
  }

  async buildDrawing() {
    const selected = this.selectedCadDrawingView();
    if (selected?.type === 'elevation') return this.buildAxisElevationDrawing(selected);
    const previousDrawing = this.drawing;
    const modelKey = this.e['pdf-overlay-model'].value;
    const working = getState('models.editing.active') === true && modelKey === 'A';
    const doc = working
      ? getState('models.editing.workingDocument')
      : getState(`models.document${modelKey}`);
    if (doc?.nodeType !== 9) throw new Error(`モデル${modelKey}を先に読み込んでください。`);
    const stories = parseStories(doc);
    const storyId = this.e['pdf-overlay-story'].value;
    if (!storyId) throw new Error('対象階を選択してください。');
    if (selected?.type === 'plan' && selected.storyId !== storyId)
      throw new Error('選択ビューと階が不一致です。');
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
        working,
      });
    } catch (error) {
      if (abortController.signal.aborted || this.abortController !== abortController) return;
      throw error;
    }
    if (abortController.signal.aborted || this.abortController !== abortController) return;
    let tagFactsResolver = null;
    if (typeof this.services.createTagFactsResolver === 'function') {
      tagFactsResolver = await this.services.createTagFactsResolver({ modelKey, drawing, working });
    }
    if (abortController.signal.aborted || this.abortController !== abortController) return;
    // Revoke before any drawing-dependent controller mutates its runtime state.
    this.sessionUi?.closeOpenDrawingProject?.();
    this.measurementUi?.invalidateDrawing();
    const drawingChangeCode = !previousDrawing
      ? null
      : previousDrawing.source?.modelKey !== drawing.source?.modelKey
        ? 'MODEL_CHANGED'
        : previousDrawing.source?.modelRevision !== drawing.source?.modelRevision
          ? 'STB_CHANGED'
          : previousDrawing.view?.type !== 'plan' ||
              drawing.view?.type !== 'plan' ||
              JSON.stringify(planViewContextSnapshot(previousDrawing.view)) !==
                JSON.stringify(planViewContextSnapshot(drawing.view))
            ? 'STB_VIEW_CHANGED'
            : null;
    if (drawingChangeCode) this.sessionUi?.invalidateTagPlacements(drawingChangeCode);
    // Undo/Redo also emits WORKING_DOCUMENT_CHANGED. Preserve the selected
    // member on same-view revisions, not only immediately after a gizmo MOVE.
    const sameWorkingView =
      working &&
      previousDrawing?.source?.modelKey === modelKey &&
      previousDrawing?.view?.type === 'plan' &&
      String(previousDrawing.view.storyId) === String(view.storyId);
    const priorSelection = sameWorkingView
      ? previousDrawing.elements?.find((item) => item.key === this.selectedElementKey)?.ref
      : null;
    const priorMemberRefs = sameWorkingView
      ? this.cadEditMemberKeys
          .map((key) => previousDrawing.elements?.find((item) => item.key === key)?.ref)
          .filter(Boolean)
      : [];
    const restore = this.cadEditRestoreSelection || priorSelection;
    const restoreNodeIds = sameWorkingView && !restore ? this.selectedCadNodeIds() : [];
    const restoreNodeId = restoreNodeIds.at(-1) ?? null;
    this.cadEditRestoreSelection = null;
    this.clearSelection({ preserveElementInfo: Boolean(working && (restore || restoreNodeId)) });
    this.drawing = drawing;
    if (working && restore) {
      const restoredMemberRefs = priorMemberRefs.length ? priorMemberRefs : [restore];
      this.cadEditMemberKeys = restoredMemberRefs
        .map(
          (identity) =>
            drawing.elements.find(
              ({ ref }) =>
                ref.modelKey === identity.modelKey &&
                ref.elementType === identity.elementType &&
                String(ref.elementId) === String(identity.elementId),
            )?.key,
        )
        .filter(Boolean);
      const primary = drawing.elements.find(
        ({ ref }) =>
          ref.modelKey === restore.modelKey &&
          ref.elementType === restore.elementType &&
          String(ref.elementId) === String(restore.elementId),
      )?.key;
      this.selectedElementKey = primary ?? this.cadEditMemberKeys.at(-1) ?? null;
      if (this.selectedElementKey && !this.cadEditMemberKeys.includes(this.selectedElementKey))
        this.cadEditMemberKeys.push(this.selectedElementKey);
    } else if (working && restoreNodeIds.length) {
      const existing = new Set(
        [...(editingSession.getWorkingDocument()?.getElementsByTagName('StbNode') || [])].map(
          (node) => String(node.getAttribute('id')),
        ),
      );
      this.cadEditNodeIds = restoreNodeIds.filter((id) => existing.has(String(id)));
      this.cadEditNodeId = this.cadEditNodeIds.at(-1) ?? null;
    }
    this.sheetBrowser?.invalidatePreviewSources?.();
    this.tagFactsResolver = tagFactsResolver;
    // PDF配置は再生成ごとに解除するが、部材レビューはSTB原本・改訂・viewが実際に変わった場合だけ失効させる。
    this.resetPlacementState('STB図面更新: 配置未設定', drawingChangeCode || 'PLACEMENT_CHANGED');
    if (drawingChangeCode) this.regionUi.invalidateDrawing();
    this.clearAnchorInputs('model');
    this.alignmentCandidates = this.services.collectAlignmentCandidates({
      modelKey,
      drawing: this.drawing,
      working,
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
    if (working && (this.selectedElementKey || this.cadEditNodeId))
      this.refreshSelectedCadElementInfo();
    this.updatePdfFeatureAvailability();
    this.renderDiagnostics();
    await this.sessionUi?.onAssetsChanged();
    if (
      !this.sheetBrowser?.mainViewActive &&
      this.drawing === drawing &&
      !this.selectedElementKey &&
      !restoreNodeId &&
      selected &&
      this.selectedCadDrawingView()?.key === selected.key
    )
      this.sheetBrowser?.showCadCandidateProperties?.(
        selected,
        { modelKey, scaleDenominator: safeCadInfoScale(this) },
        { reveal: false },
      );
    if (this.e['pdf-overlay-display-mode'].value === 'stb') showSuccess('図面を生成しました。');
  }

  renderSheet({ focus = null } = {}) {
    this.currentModelToCss = null;
    this.updatePdfFeatureAvailability();
    const layer = this.e['pdf-overlay-svg-layer'];
    layer.replaceChildren();
    const sheetView = this.sheetBrowser?.renderMainViewSheet?.(
      layer,
      sheetPreviewPxPerMm(this.viewZoom),
    );
    if (sheetView) {
      this.setEmptyCanvasState(false);
      this.e['pdf-overlay-canvas-layer'].replaceChildren();
      const pxPerMm = sheetPreviewPxPerMm(this.viewZoom);
      this.e['pdf-overlay-stage'].style.width = `${sheetView.widthMm * pxPerMm}px`;
      this.e['pdf-overlay-stage'].style.height = `${sheetView.heightMm * pxPerMm}px`;
      this.updateZoomLabel();
      if (focus) this.restoreZoomFocus(focus);
      return;
    }
    if (!this.drawing && !(this.referenceDrawings?.length || 0)) {
      this.setEmptyCanvasState(true);
      return;
    }
    this.setEmptyCanvasState(false);
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
      onSelect: (ref, event) => {
        if (!this.measurementUi?.isActive())
          this.showSelectedElement(this.resolveCandidateRef(ref), event);
      },
      onReferenceSelect: (ref) => {
        if (!this.measurementUi?.isActive()) this.showSelectedReference(ref);
      },
    });
    this.candidateUi?.clear();
    layer.append(svg);
    this.applySelectionHighlight(svg);
    this.appendCadEditNodes(svg);
    this.appendCadEditGizmo(svg);
    this.appendCadPointerOverlay(svg);
    this.sessionUi?.appendDrawingMemos?.(svg);
    this.measurementUi?.appendVisuals?.(svg);
    this.sessionUi?.refreshSelectedTagControls();
    this.updatePdfFeatureAvailability();
    this.updateZoomLabel();
    if (focus) this.restoreZoomFocus(focus);
    const elevationMembers =
      (this.drawing?.primitives?.filter(
        (primitive) =>
          primitive.role === 'member-axis' || primitive.id?.includes('elevation-wall-outline'),
      ).length || 0) +
      (this.drawing?.diagnostics?.filter(
        (diagnostic) => diagnostic.code === 'ELEVATION_WALL_OUTLINE_UNSUPPORTED',
      ).length || 0);
    const elevationOutlines =
      this.drawing?.primitives?.filter(
        (primitive) =>
          primitive.role === 'member-outline' &&
          primitive.kind === 'polyline' &&
          primitive.closed === true &&
          (primitive.id?.includes('elevation-section-outline') ||
            primitive.id?.includes('elevation-wall-outline')),
      ).length || 0;
    const stbStatus =
      this.drawing?.view?.type === 'elevation'
        ? ` / Level・通り芯・部材外形 ${elevationOutlines}/${elevationMembers}（未対応は診断）`
        : this.drawing
          ? ` / ${this.drawing.coverage.drawn}部材`
          : '';
    const referenceCount = this.referenceDrawings?.length || 0;
    const dxfStatus = referenceCount ? ` / DXF ${referenceCount}ファイル` : '';
    this.setStatus(
      `図面 A3横 1:${scaleDenominator} / 図面回転 ${this.drawingRotationDeg}° / 表示 ${formatPdfOverlayViewZoom(this.viewZoom)}${stbStatus}${dxfStatus}`,
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
        this.cadEditMemberKeys.includes(node.dataset.elementKey) ||
          (Boolean(this.selectedElementKey) && node.dataset.elementKey === this.selectedElementKey),
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

  showSelectedElement(ref, event = null) {
    if (this.regionUi.consumeClick()) return;
    if (this.cadPointerTool) {
      this.cadPointerTool = null;
      this.e?.['pdf-overlay-svg-layer']?.querySelector?.('.cad-edit-pointer-overlay')?.remove();
    }
    this.cadEditNodeId = null;
    this.cadEditNodeIds = [];
    this.selectedReferenceKey = null;
    const record = this.drawing?.elements.find(
      (item) =>
        item.ref.modelKey === ref.modelKey &&
        item.ref.elementType === ref.elementType &&
        item.ref.elementId === ref.elementId,
    );
    const additive =
      this.canEditCadGeometry() &&
      this.e['cad-edit-kind']?.value === 'member' &&
      ref.modelKey === 'A' &&
      Boolean(event?.shiftKey || event?.ctrlKey || event?.metaKey);
    if (additive && record) {
      const previous = this.drawing?.elements.find(
        (item) => item.key === this.selectedElementKey && item.ref.modelKey === 'A',
      );
      const keys = this.cadEditMemberKeys.length
        ? [...this.cadEditMemberKeys]
        : previous
          ? [previous.key]
          : [];
      const index = keys.indexOf(record.key);
      if (index >= 0) keys.splice(index, 1);
      else keys.push(record.key);
      this.cadEditMemberKeys = keys;
      this.selectedElementKey = keys.at(-1) ?? null;
      if (!this.selectedElementKey) {
        this.clearSelection();
        this.updateCadEditControls();
        return;
      }
    } else {
      this.selectedElementKey = record?.key ?? null;
      this.cadEditMemberKeys =
        this.canEditCadGeometry() &&
        this.e['cad-edit-kind']?.value === 'member' &&
        ref.modelKey === 'A' &&
        record
          ? [record.key]
          : [];
    }
    const active = this.drawing?.elements.find((item) => item.key === this.selectedElementKey);
    if (active) ref = active.ref;
    this.applySelectionHighlight();
    this.updateCadEditControls();
    this.refreshCadEditGizmo();
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
      onDragCancel: () => {
        layer.style.transform = '';
        layer.classList.remove('gizmo-dragging');
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

  /** STB-A Working Document edits are supported only on a verified 2D plane. */
  canEditCadGeometry() {
    return (
      editingSession.getState()?.active === true &&
      this.e['pdf-overlay-model']?.value === 'A' &&
      cadDrawingEditProjection(this.drawing?.view) != null
    );
  }

  selectedCadNodeIds() {
    if (this.cadEditNodeIds?.length) return [...this.cadEditNodeIds];
    return this.cadEditNodeId ? [this.cadEditNodeId] : [];
  }

  selectedCadMemberRefs() {
    const keys = this.cadEditMemberKeys?.length
      ? this.cadEditMemberKeys
      : this.selectedElementKey
        ? [this.selectedElementKey]
        : [];
    const records = new Map((this.drawing?.elements || []).map((item) => [item.key, item]));
    return keys.map((key) => records.get(key)?.ref).filter((ref) => ref?.modelKey === 'A');
  }

  updateCadEditControls() {
    const state = editingSession.getState();
    const active = state?.active === true;
    const available = this.canEditCadGeometry();
    const projection = cadDrawingEditProjection(this.drawing?.view);
    const isPlan = this.drawing?.view?.type === 'plan';
    const isNode = this.e['cad-edit-kind']?.value === 'node';
    const selected = this.drawing?.elements?.find((item) => item.key === this.selectedElementKey);
    const member = selected?.ref?.modelKey === 'A' ? selected.ref : null;
    const nodeIds = isNode ? this.selectedCadNodeIds() : [];
    const memberRefs = isNode ? [] : this.selectedCadMemberRefs();
    const target = isNode ? nodeIds.length > 0 : memberRefs.length > 0;
    const follow = this.e['cad-edit-follow-nodes'];
    if (follow) {
      follow.disabled = !available || isNode;
      follow.checked = editingSession.getMoveFollowRelatedNodes();
    }
    const toggle = this.e['cad-edit-toggle'];
    if (toggle) {
      setCommandLabel(toggle, active ? '編集終了' : '編集開始');
      toggle.setAttribute('aria-pressed', String(active));
    }
    const apply = this.e['cad-edit-apply'];
    if (apply) apply.disabled = !available || !target;
    const pointer = this.cadPointerTool;
    if (projection) {
      const axisNames = [projection.horizontal, projection.vertical];
      for (const [id, text] of [
        ['cad-edit-first-axis', `Δ${axisNames[0]}`],
        ['cad-edit-second-axis', `Δ${axisNames[1]}`],
        ['cad-edit-ortho-axes', axisNames.join('/')],
      ]) {
        const element = this.root?.querySelector?.(`#${id}`);
        if (element && element.textContent !== text) element.textContent = text;
      }
      const select = this.e['cad-edit-align-axis'];
      if (select?.options) {
        const actual = Array.from(select.options).map((option) => option.value);
        if (actual.join(',') !== axisNames.join(',')) {
          const previous = select.value;
          select.replaceChildren(...axisNames.map((axis) => make('option', { value: axis }, axis)));
          if (axisNames.includes(previous)) select.value = previous;
        }
      }
      const inputApply = this.e['cad-edit-apply'];
      if (inputApply)
        inputApply.title = `モデル${axisNames.join('/')}平面の移動量をmmで指定（奥行軸は固定）`;
    }
    for (const id of ['cad-edit-snap', 'cad-edit-ortho']) {
      if (this.e[id]) this.e[id].disabled = !available;
    }
    for (const kind of ['move', 'copy', 'face']) {
      const button = this.e[`cad-edit-pointer-${kind}`];
      if (button) {
        button.disabled =
          !available || !isPlan || isNode || !member || (kind === 'face' && memberRefs.length > 1);
        button.setAttribute('aria-pressed', String(pointer?.kind === kind));
      }
    }
    const cancel = this.e['cad-edit-pointer-cancel'];
    if (cancel) cancel.disabled = !pointer;
    const pointerStatus = this.e['cad-edit-pointer-status'];
    if (pointerStatus)
      pointerStatus.textContent = !pointer
        ? '部材を選択して操作を開始'
        : pointer.kind === 'face'
          ? pointer.sourceEdge
            ? '基準側の辺をクリック'
            : '移動元の辺をクリック'
          : pointer.firstPoint
            ? '終点をクリック'
            : '始点をクリック';
    const undo = this.e['cad-edit-undo'];
    const redo = this.e['cad-edit-redo'];
    if (undo) undo.disabled = !active || !(state.history?.length > 0);
    if (redo) redo.disabled = !active || !(state.redoStack?.length > 0);
    const nodePosition =
      available && isNode && this.cadEditNodeId
        ? cadNodePosition(
            editingSession.getWorkingDocument(),
            editingSession.getWorkingNodeMap(),
            this.cadEditNodeId,
          )
        : null;
    const coordinatePanel = this.e['cad-edit-node-properties'];
    if (coordinatePanel) coordinatePanel.hidden = !nodePosition;
    const positionApply = this.e['cad-edit-position-apply'];
    if (positionApply) positionApply.disabled = !nodePosition || nodeIds.length !== 1;
    for (const id of ['cad-edit-align-axis', 'cad-edit-align-value', 'cad-edit-align-apply']) {
      if (this.e[id]) this.e[id].disabled = !nodePosition;
    }
    for (const axis of ['x', 'y', 'z']) {
      const input = this.e[`cad-edit-property-${axis}`];
      if (!input) continue;
      input.disabled = !nodePosition || nodeIds.length !== 1;
      // An in-progress numeric input is not overwritten by unrelated drawing updates.
      if (globalThis.document?.activeElement !== input)
        input.value = nodePosition ? String(nodePosition[axis]) : '';
    }
    const title = this.e['cad-edit-property-title'];
    if (title)
      title.textContent = !available
        ? 'モデルAの伏図または軸組図で編集開始してください'
        : isNode
          ? nodePosition
            ? nodeIds.length > 1
              ? `${nodeIds.length}節点を選択 / 基準 #${this.cadEditNodeId}（絶対座標は単体編集のみ）`
              : `節点 #${this.cadEditNodeId} / モデル絶対座標`
            : '節点を選択してください'
          : member
            ? memberRefs.length > 1
              ? `${memberRefs.length}部材を選択 / 基準 ${member.elementType} #${member.elementId}`
              : `${member.elementType} #${member.elementId}${selected?.mark ? ` / ${selected.mark}` : ''}（相対移動）`
            : '部材を選択してください';
    const status = this.e['cad-edit-status'];
    if (!status) return;
    status.textContent = !active
      ? '編集モードOFF'
      : !available
        ? 'モデルAの伏図・軸組図で編集できます'
        : isNode
          ? this.cadEditNodeId
            ? nodeIds.length > 1
              ? `${nodeIds.length}節点を選択`
              : `節点 #${this.cadEditNodeId}`
            : '図面の節点（丸印）を選択'
          : member
            ? memberRefs.length > 1
              ? `${memberRefs.length}部材を選択（節点追従${follow?.checked ? 'ON' : 'OFF'}）`
              : `${member.elementType} #${member.elementId}`
            : '図面の部材を選択';
  }

  /** Rebind the shared element-info panel after each Working Document revision. */
  refreshSelectedCadElementInfo({ reveal = false } = {}) {
    const isNode = this.e?.['cad-edit-kind']?.value === 'node';
    const ref =
      isNode && this.cadEditNodeId && this.canEditCadGeometry()
        ? { modelKey: 'A', elementType: 'Node', elementId: this.cadEditNodeId }
        : this.drawing?.elements?.find((item) => item.key === this.selectedElementKey)?.ref;
    if (!ref) return false;
    const info = this.e['pdf-overlay-element-info'];
    if (info) info.textContent = `${ref.modelKey} / ${ref.elementType} #${ref.elementId}`;
    eventBus.emit(InteractionEvents.DISPLAY_ELEMENT_INFO, {
      idA: ref.modelKey === 'A' ? ref.elementId : null,
      idB: ref.modelKey === 'B' ? ref.elementId : null,
      elementType: ref.elementType,
      modelSource: ref.modelKey,
    });
    if (reveal) eventBus.emit(InteractionEvents.OPEN_WINDOW, { windowId: 'component-info' });
    return true;
  }

  /** 2D mouse tools operate on the same selected Working Document member as numeric MOVE. */
  startCadPointerTool(kind) {
    if (!['move', 'copy', 'face'].includes(kind)) return;
    const selected = this.drawing?.elements?.find(
      (record) => record.key === this.selectedElementKey,
    );
    if (
      !this.canEditCadGeometry() ||
      this.drawing?.view?.type !== 'plan' ||
      this.e['cad-edit-kind']?.value !== 'member' ||
      this.e['pdf-overlay-display-mode']?.value !== 'stb' ||
      selected?.ref?.modelKey !== 'A' ||
      !Array.isArray(this.currentModelToCss)
    )
      return showWarning('2点移動・複写・辺揃えは現在、伏図の部材に限定しています。');
    const sourceRefs = this.selectedCadMemberRefs();
    if (!sourceRefs.length) return showWarning('モデルAの編集対象部材を選択してください。');
    if (kind === 'face' && sourceRefs.length !== 1)
      return showWarning('辺揃えでは移動元部材を1件だけ選択してください。');
    if (kind === 'face' && !collectCadPlanEdges(this.drawing, { elementKey: selected.key }).length)
      return showWarning('この部材には平面上で選択可能な閉じた外形がありません。');
    if (this.cadPointerTool?.kind === kind) return this.cancelCadPointerTool();
    const session = editingSession.getState();
    this.cadPointerTool = {
      kind,
      sourceKey: selected.key,
      sourceRef: { ...selected.ref },
      sourceRefs: sourceRefs.map((ref) => ({ ...ref })),
      drawing: this.drawing,
      sessionId: session?.sessionId,
      revision: session?.workingRevision,
      firstPoint: null,
      sourceEdge: null,
      snapEngine:
        kind === 'face'
          ? null
          : createCadPlanSnapEngine(editingSession.getWorkingDocument(), {
              nodeMap: editingSession.getWorkingNodeMap(),
              view: this.drawing.view,
              drawing: this.drawing,
              visibleTypes: this.drawingDisplaySettings()?.visibility,
            }),
    };
    this.renderOverlay();
  }

  cancelCadPointerTool({ redraw = true } = {}) {
    if (!this.cadPointerTool) return;
    this.cadPointerTool = null;
    if (redraw) this.renderOverlay();
    else this.updateCadEditControls();
  }

  isCurrentCadPointerTool(tool) {
    const session = editingSession.getState();
    return Boolean(
      tool &&
      tool === this.cadPointerTool &&
      this.canEditCadGeometry() &&
      tool.drawing === this.drawing &&
      tool.sourceKey === this.selectedElementKey &&
      tool.sessionId === session?.sessionId &&
      tool.revision === session?.workingRevision &&
      this.e['cad-edit-kind']?.value === 'member',
    );
  }

  /** Browser screen CTM includes zoom and any nested sheet viewBox transform. */
  cadPointerModelPoint(svgRoot, event) {
    const screen = svgRoot.getScreenCTM?.();
    if (!screen || !Array.isArray(this.currentModelToCss))
      throw new Error('図面座標変換が利用できません。');
    const determinant = screen.a * screen.d - screen.b * screen.c;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12)
      throw new Error('図面の表示倍率が不正です。');
    const x = event.clientX - screen.e;
    const y = event.clientY - screen.f;
    const local = [
      (screen.d * x - screen.c * y) / determinant,
      (-screen.b * x + screen.a * y) / determinant,
    ];
    return transformPoint(invertAffine(this.currentModelToCss), local);
  }

  resolveCadPointerPoint(event, svgRoot, tool) {
    const raw = this.cadPointerModelPoint(svgRoot, event);
    return resolveCadPlanPointerPoint(raw, {
      snapEngine: tool.snapEngine,
      startPoint: tool.firstPoint,
      snap: Boolean(this.e['cad-edit-snap']?.checked),
      ortho: Boolean(this.e['cad-edit-ortho']?.checked),
      toleranceMm: cadPlanSnapToleranceMm(this.currentModelToCss, svgRoot.getScreenCTM?.(), 10),
    });
  }

  applyCadPointerPoint(event, svgRoot, tool) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.isCurrentCadPointerTool(tool)) return this.cancelCadPointerTool();
    try {
      const { point } = this.resolveCadPointerPoint(event, svgRoot, tool);
      if (!tool.firstPoint) {
        tool.firstPoint = point;
        this.renderOverlay();
        return;
      }
      const result = cadTwoPointVector(tool.firstPoint, point);
      const { kind, sourceRef, sourceRefs } = tool;
      this.cancelCadPointerTool({ redraw: false });
      if (!result.changed) {
        this.renderOverlay();
        return showInfo('始点と終点が同一です。');
      }
      if (kind === 'copy') {
        this.cadOperations.copySelectionsByVector(sourceRefs, result.delta, {
          label: `簡易CAD ${sourceRefs.length}部材を2点複写`,
        });
        showSuccess('図面上の2点を基準に部材を複写しました。');
      } else {
        this.cadEditRestoreSelection = { ...sourceRef };
        this.cadOperations.moveSelectionsByVector(sourceRefs, result.delta, {
          followRelatedNodes: editingSession.getMoveFollowRelatedNodes(),
          label: `簡易CAD ${sourceRefs.length}部材を2点移動`,
        });
        showSuccess('図面上の2点を基準に部材を移動しました。');
      }
    } catch (error) {
      this.cadEditRestoreSelection = null;
      this.cancelCadPointerTool();
      this.fail(error);
    }
  }

  applyCadPointerEdge(event, edge, tool) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.isCurrentCadPointerTool(tool)) return this.cancelCadPointerTool();
    if (!tool.sourceEdge) {
      tool.sourceEdge = edge;
      this.renderOverlay();
      return;
    }
    let alignment;
    try {
      alignment = planCadFaceAlignment(tool.sourceEdge, edge);
    } catch (error) {
      return showWarning(error instanceof Error ? error.message : String(error));
    }
    const sourceRef = tool.sourceRef;
    if (!alignment.changed) {
      this.cancelCadPointerTool();
      return showInfo('指定された2辺は既に同じ位置にあります。');
    }
    try {
      this.cancelCadPointerTool({ redraw: false });
      this.cadEditRestoreSelection = { ...sourceRef };
      this.cadOperations.moveSelectionsByVector([sourceRef], alignment.delta, {
        followRelatedNodes: false,
        label: `簡易CAD ${sourceRef.elementType} #${sourceRef.elementId} の辺揃え`,
      });
      showSuccess(`外形辺を基準に ${alignment.distanceMm.toFixed(1)}mm 整列しました。`);
    } catch (error) {
      this.cadEditRestoreSelection = null;
      this.renderOverlay();
      this.fail(error);
    }
  }

  /** Pick actual model-space polyline edges rather than rectangular SVG bounds. */
  appendCadPointerOverlay(svg) {
    const tool = this.cadPointerTool;
    if (
      !this.isCurrentCadPointerTool(tool) ||
      this.e['pdf-overlay-display-mode']?.value !== 'stb' ||
      !Array.isArray(this.currentModelToCss)
    )
      return;
    const root = this.cadEditVisualRoot(svg);
    const overlay = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
    overlay.classList.add('cad-edit-pointer-overlay');
    root.append(overlay);
    const create = (tag) => svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', tag);
    const modelToCss = this.currentModelToCss;
    if (tool.kind !== 'face') {
      const viewBox = root.viewBox?.baseVal;
      const width = viewBox?.width || Number(root.getAttribute('width'));
      const height = viewBox?.height || Number(root.getAttribute('height'));
      if (!(width > 0 && height > 0)) return;
      const hit = create('rect');
      for (const [name, value] of Object.entries({
        x: 0,
        y: 0,
        width,
        height,
        fill: 'transparent',
        'pointer-events': 'all',
      }))
        hit.setAttribute(name, String(value));
      hit.setAttribute('class', 'cad-edit-pointer-canvas');
      hit.style.cursor = 'crosshair';
      hit.addEventListener('click', (event) => this.applyCadPointerPoint(event, root, tool));
      overlay.append(hit);
      if (tool.firstPoint) {
        const [cx, cy] = transformPoint(modelToCss, tool.firstPoint);
        const dot = create('circle');
        for (const [name, value] of Object.entries({
          cx,
          cy,
          r: 6,
          fill: '#f5a623',
          stroke: '#fff',
          'stroke-width': 2,
          'pointer-events': 'none',
        }))
          dot.setAttribute(name, String(value));
        overlay.append(dot);
      }
      const hover = create('g');
      hover.setAttribute('class', 'cad-edit-pointer-preview');
      hover.setAttribute('visibility', 'hidden');
      hover.setAttribute('pointer-events', 'none');
      const marker = create('circle');
      for (const [name, value] of Object.entries({
        r: 5,
        fill: '#fff',
        stroke: '#168b68',
        'stroke-width': 2,
      }))
        marker.setAttribute(name, String(value));
      const markerLabel = create('text');
      markerLabel.setAttribute('font-size', '12');
      markerLabel.setAttribute('fill', '#168b68');
      hover.append(marker, markerLabel);
      overlay.append(hover);
      hit.addEventListener('pointermove', (event) => {
        if (!this.isCurrentCadPointerTool(tool)) return;
        try {
          const result = this.resolveCadPointerPoint(event, root, tool);
          const [cx, cy] = transformPoint(modelToCss, result.point);
          marker.setAttribute('cx', String(cx));
          marker.setAttribute('cy', String(cy));
          marker.setAttribute('stroke', result.snap ? '#168b68' : '#e17b15');
          markerLabel.setAttribute('x', String(cx + 10));
          markerLabel.setAttribute('y', String(cy - 10));
          markerLabel.textContent = result.snap
            ? `Snap: ${result.snap.type}`
            : result.orthoAxis
              ? `Ortho: ${result.orthoAxis}`
              : '';
          hover.setAttribute('visibility', 'visible');
        } catch {
          hover.setAttribute('visibility', 'hidden');
        }
      });
      hit.addEventListener('pointerleave', () => hover.setAttribute('visibility', 'hidden'));
      return;
    }
    const edgeOptions = {
      ...(tool.sourceEdge ? {} : { elementKey: tool.sourceKey }),
      visibleTypes: this.drawingDisplaySettings()?.visibility,
    };
    const edges = collectCadPlanEdges(this.drawing, edgeOptions);
    for (const edge of edges) {
      if (tool.sourceEdge && edge.elementKey === tool.sourceKey) continue;
      const [x1, y1] = transformPoint(modelToCss, edge.start);
      const [x2, y2] = transformPoint(modelToCss, edge.end);
      const path = create('line');
      for (const [name, value] of Object.entries({
        x1,
        y1,
        x2,
        y2,
        stroke: tool.sourceEdge ? '#2d74ca' : '#e17b15',
        'stroke-opacity': 0.38,
        'stroke-width': 10,
        'stroke-linecap': 'round',
        'pointer-events': 'stroke',
        'vector-effect': 'non-scaling-stroke',
        'data-cad-edge-role': tool.sourceEdge ? 'target' : 'source',
        'data-cad-edge-element-key': edge.elementKey,
      }))
        path.setAttribute(name, String(value));
      path.style.cursor = 'crosshair';
      path.addEventListener('click', (event) => this.applyCadPointerEdge(event, edge, tool));
      const title = create('title');
      title.textContent = `${edge.ref.elementType} #${edge.ref.elementId} 外形辺`;
      path.append(title);
      overlay.append(path);
    }
    if (tool.sourceEdge) {
      const [x1, y1] = transformPoint(modelToCss, tool.sourceEdge.start);
      const [x2, y2] = transformPoint(modelToCss, tool.sourceEdge.end);
      const highlight = create('line');
      for (const [name, value] of Object.entries({
        x1,
        y1,
        x2,
        y2,
        stroke: '#e17b15',
        'stroke-width': 3,
        'pointer-events': 'none',
        'vector-effect': 'non-scaling-stroke',
      }))
        highlight.setAttribute(name, String(value));
      overlay.append(highlight);
    }
  }

  /** CAD編集の描画先。シート表示ではviewBox(mm)ではなくCSS px単位の入れ子SVGへ描く。 */
  cadEditVisualRoot(svg) {
    if (!this.e || this.viewportMode() !== 'sheet') return svg;
    return resolveSheetCssOverlay(svg, this.sheetLayout, 'cad-edit-css-overlay');
  }

  /** 表示中の部材につながるsemantic節点だけをSVG上に描画する。 */
  appendCadEditNodes(svg) {
    if (
      !this.canEditCadGeometry() ||
      this.e['cad-edit-kind']?.value !== 'node' ||
      !Array.isArray(this.currentModelToCss) ||
      !svg?.appendChild
    )
      return;
    const workingDocument = editingSession.getWorkingDocument();
    if (!workingDocument) return;
    const refs = (this.drawing?.elements || [])
      .filter((item) => item.ref?.modelKey === 'A')
      .map((item) => ({ elementType: item.ref.elementType, elementId: item.ref.elementId }));
    const grips = getSemanticGripsForSelections(workingDocument, refs, {
      nodeMap: editingSession.getWorkingNodeMap(),
    });
    const projection = cadDrawingEditProjection(this.drawing?.view);
    if (!projection) return;
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('class', 'cad-edit-node-grips');
    const visualRoot = this.cadEditVisualRoot(svg);
    for (const grip of grips) {
      if (!cadEditDepthVisible(this.drawing.view, grip.position)) continue;
      const nodeId = String(grip.target.elementId);
      const modelPoint = cadProjectEditPoint(projection, grip.position);
      const position = transformPoint(this.currentModelToCss, modelPoint);
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', String(position[0]));
      circle.setAttribute('cy', String(position[1]));
      circle.setAttribute('r', '5');
      circle.setAttribute(
        'stroke',
        this.selectedCadNodeIds().includes(nodeId) ? '#d83131' : '#1768b3',
      );
      circle.setAttribute('stroke-width', '2');
      circle.setAttribute('fill', '#fff');
      circle.style.cursor = 'grab';
      circle.setAttribute('aria-label', `節点 ${nodeId}`);
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `節点 ${nodeId} (${projection.horizontal}=${modelPoint[0]}, ${projection.vertical}=${modelPoint[1]})`;
      circle.appendChild(title);
      circle.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const additive = event.shiftKey || event.ctrlKey || event.metaKey;
        if (!additive || !this.selectedCadNodeIds().length) {
          this.clearSelection();
          this.cadEditNodeIds = [nodeId];
        } else {
          const selected = this.selectedCadNodeIds();
          const index = selected.indexOf(nodeId);
          if (index >= 0) selected.splice(index, 1);
          else selected.push(nodeId);
          this.cadEditNodeIds = selected;
          if (!selected.length) {
            this.clearSelection();
            this.updateCadEditControls();
            return;
          }
        }
        this.cadEditNodeId = this.cadEditNodeIds.at(-1);
        this.cadEditMemberKeys = [];
        this.updateCadEditControls();
        this.refreshCadEditGizmo();
        this.refreshSelectedCadElementInfo({ reveal: true });
        const selected = new Set(this.cadEditNodeIds);
        group.querySelectorAll('circle').forEach((handle) => {
          const id = handle.getAttribute('aria-label')?.replace('節点 ', '');
          handle.setAttribute('stroke', selected.has(id) ? '#d83131' : '#1768b3');
        });
      });
      this.bindCadNodeGripDrag(circle, grip, group, svg, visualRoot);
      group.appendChild(circle);
    }
    visualRoot.appendChild(group);
  }

  /** A node-circle drag is a 2D semantic edit, not a transform of the SVG circle. */
  bindCadNodeGripDrag(circle, grip, group, svg, root) {
    const nodeId = String(grip.target.elementId);
    const matrix = [...this.currentModelToCss];
    const projection = cadDrawingEditProjection(this.drawing?.view);
    if (!projection) return;
    const modelPoint = cadProjectEditPoint(projection, grip.position);
    const screenModel = () => root.getScreenCTM?.() || null;
    const resetPreview = (context) => {
      for (const handle of context.handles) handle.removeAttribute('transform');
      context.label.remove();
    };
    bindCadPlanNodeDrag(circle, {
      canStart: () =>
        this.canEditCadGeometry() &&
        this.e?.['cad-edit-kind']?.value === 'node' &&
        this.e?.['pdf-overlay-display-mode']?.value === 'stb' &&
        !this.cadPointerTool &&
        !this.measurementUi?.isActive() &&
        !this.sessionUi?.isTagEditMode() &&
        !this.regionUi?.isSelecting() &&
        !this.anchorPickTarget,
      startContext: () => {
        const selected = this.selectedCadNodeIds();
        const nodeIds = selected.includes(nodeId) ? selected : [nodeId];
        const ids = new Set(nodeIds);
        const label = circle.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('class', 'cad-edit-node-drag-status');
        label.setAttribute('pointer-events', 'none');
        label.setAttribute('fill', '#168b68');
        label.setAttribute('font-size', '12');
        const state = editingSession.getState();
        return {
          nodeIds,
          drawing: this.drawing,
          sessionId: state?.sessionId,
          revision: state?.workingRevision,
          snap: Boolean(this.e?.['cad-edit-snap']?.checked),
          ortho: Boolean(this.e?.['cad-edit-ortho']?.checked),
          snapEngine: null,
          label,
          handles: Array.from(group.querySelectorAll('circle')).filter((handle) =>
            ids.has(handle.getAttribute('aria-label')?.replace('節点 ', '')),
          ),
        };
      },
      isCurrent: (context) => {
        const state = editingSession.getState();
        return (
          svg.isConnected &&
          circle.isConnected &&
          this.canEditCadGeometry() &&
          this.e?.['cad-edit-kind']?.value === 'node' &&
          this.drawing === context.drawing &&
          state?.sessionId === context.sessionId &&
          state?.workingRevision === context.revision &&
          matrix.every((value, index) => this.currentModelToCss?.[index] === value)
        );
      },
      resolve: (context, displacement) => {
        if (context.snap && !context.snapEngine) {
          context.snapEngine = createCadPlanSnapEngine(editingSession.getWorkingDocument(), {
            nodeMap: editingSession.getWorkingNodeMap(),
            view: this.drawing?.view,
            drawing: this.drawing,
            visibleTypes: this.drawingDisplaySettings()?.visibility,
          });
        }
        return resolveCadPlanGizmoDrag({
          modelToSvg: matrix,
          originModel: modelPoint,
          projection,
          screenDelta: displacement,
          screenCtm: screenModel(),
          axis: 'xy',
          snapEngine: context.snapEngine,
          snap: context.snap,
          ortho: context.ortho,
          excludeNodeIds: context.nodeIds,
        });
      },
      preview: (context, result) => {
        const [dx, dy] = result.offsetSvg;
        for (const handle of context.handles)
          handle.setAttribute('transform', `translate(${dx} ${dy})`);
        context.label.setAttribute('x', String(Number(circle.getAttribute('cx')) + dx + 8));
        context.label.setAttribute('y', String(Number(circle.getAttribute('cy')) + dy - 12));
        context.label.textContent =
          `${projection.horizontal} ${result.delta[projection.horizontal.toLowerCase()].toFixed(1)} / ${projection.vertical} ${result.delta[projection.vertical.toLowerCase()].toFixed(1)} mm` +
          (result.snap ? ` / Snap: ${result.snap.type}` : '');
        if (!context.label.isConnected) group.appendChild(context.label);
      },
      reset: resetPreview,
      commit: (context, result) => {
        if (!this.selectedCadNodeIds().includes(nodeId)) {
          this.clearSelection();
          this.cadEditNodeIds = [...context.nodeIds];
          this.cadEditNodeId = nodeId;
          this.updateCadEditControls();
        }
        this.commitCadEditVector(result.delta, {
          target: { nodeIds: context.nodeIds },
          viaGizmo: true,
        });
      },
      fail: (error) => this.fail(error),
    });
  }

  /** Only the geometry gizmo is refreshed after a selection change. */
  refreshCadEditGizmo() {
    const svg = this.e?.['pdf-overlay-svg-layer']?.querySelector?.('svg');
    if (!svg) return;
    svg.querySelector('.cad-edit-geometry-gizmo')?.remove();
    svg.querySelector('.cad-edit-gizmo-preview')?.remove();
    this.appendCadEditGizmo(svg);
  }

  cadGizmoTarget(svg) {
    if (
      !this.canEditCadGeometry() ||
      this.e['pdf-overlay-display-mode']?.value !== 'stb' ||
      !Array.isArray(this.currentModelToCss) ||
      this.measurementUi?.isActive() ||
      this.sessionUi?.isTagEditMode() ||
      this.regionUi?.isSelecting() ||
      this.anchorPickTarget ||
      this.cadPointerTool
    )
      return null;

    const document = editingSession.getWorkingDocument();
    if (!document) return null;
    const nodeMap = editingSession.getWorkingNodeMap();
    if (this.e['cad-edit-kind']?.value === 'node') {
      if (!this.cadEditNodeId) return null;
      const nodeIds = this.selectedCadNodeIds();
      const projection = cadDrawingEditProjection(this.drawing?.view);
      const grip = getSemanticGripsForSelections(
        document,
        [{ elementType: 'Node', elementId: this.cadEditNodeId }],
        { nodeMap },
      )[0];
      if (!grip || !cadEditDepthVisible(this.drawing.view, grip.position)) return null;
      const modelPoint = cadProjectEditPoint(projection, grip.position);
      return grip
        ? {
            origin: transformPoint(this.currentModelToCss, modelPoint),
            modelPoint,
            nodeId: this.cadEditNodeId,
            nodeIds,
          }
        : null;
    }

    const record = this.drawing?.elements?.find((item) => item.key === this.selectedElementKey);
    if (record?.ref?.modelKey !== 'A') return null;
    const memberSvg = Array.from(svg.querySelectorAll('.stb-drawing-member')).find(
      (node) => node.dataset.elementKey === record.key,
    );
    const clientCenter = getPdfOverlayMemberClientCenter(memberSvg);
    let origin = null;
    let modelPoint = null;
    if (clientCenter) {
      const stageRect = this.e['pdf-overlay-stage'].getBoundingClientRect();
      origin = [clientCenter[0] - stageRect.left, clientCenter[1] - stageRect.top];
      try {
        modelPoint = this.cadPointerModelPoint(this.cadEditVisualRoot(svg), {
          clientX: clientCenter[0],
          clientY: clientCenter[1],
        });
      } catch {
        // The SVG screen CTM may be unavailable while layout is being updated.
      }
    } else {
      const grips = getSemanticGripsForSelections(
        document,
        [{ elementType: record.ref.elementType, elementId: record.ref.elementId }],
        { nodeMap },
      );
      if (grips.length) {
        const projection = cadDrawingEditProjection(this.drawing?.view);
        const projected = grips
          .filter((grip) => cadEditDepthVisible(this.drawing.view, grip.position))
          .map((grip) => cadProjectEditPoint(projection, grip.position));
        if (!projected.length) return null;
        const x = projected.reduce((sum, point) => sum + point[0], 0) / projected.length;
        const y = projected.reduce((sum, point) => sum + point[1], 0) / projected.length;
        modelPoint = [x, y];
        origin = transformPoint(this.currentModelToCss, modelPoint);
      }
    }
    return origin
      ? { origin, modelPoint, member: { ...record.ref }, members: this.selectedCadMemberRefs() }
      : null;
  }

  /** Use the existing 2D alignment gizmo as a shared pointer UI, not its PDF placement effect. */
  appendCadEditGizmo(svg) {
    const target = this.cadGizmoTarget(svg);
    if (!target || !target.origin.every(Number.isFinite)) return;
    const matrix = [...this.currentModelToCss];
    let axes;
    try {
      axes = cadGizmoAxisDirections(matrix);
    } catch {
      return;
    }
    const projection = cadDrawingEditProjection(this.drawing?.view);
    if (!projection) return;
    const [x, y] = target.origin;
    let originModel;
    try {
      originModel = target.modelPoint || transformPoint(invertAffine(matrix), target.origin);
    } catch {
      return;
    }
    const preview = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
    preview.setAttribute('class', 'cad-edit-gizmo-preview');
    preview.setAttribute('pointer-events', 'none');
    preview.setAttribute('visibility', 'hidden');
    const line = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'line');
    for (const [attribute, value] of Object.entries({
      x1: x,
      y1: y,
      x2: x,
      y2: y,
      stroke: '#e07d20',
      'stroke-width': 2,
      'stroke-dasharray': '5 3',
    }))
      line.setAttribute(attribute, String(value));
    const label = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('fill', '#b45e08');
    label.setAttribute('font-size', '12');
    preview.append(line, label);
    const root = this.cadEditVisualRoot(svg);
    root.append(preview);

    let dragging = false;
    let dragContext = null;
    const isSameDragContext = () => {
      if (!dragContext || !svg.isConnected || this.drawing !== dragContext.drawing) return false;
      if (this.e?.['cad-edit-kind']?.value !== dragContext.kind) return false;
      const state = editingSession.getState();
      // Preserve mock compatibility while protecting real active edit sessions.
      if (dragContext.sessionId != null) {
        if (state?.sessionId !== dragContext.sessionId) return false;
        if (state?.workingRevision !== dragContext.workingRevision) return false;
      }
      return true;
    };
    const reset = () => {
      dragging = false;
      preview.setAttribute('visibility', 'hidden');
      group?.setAttribute('transform', `translate(${x} ${y})`);
    };
    const resolveDrag = ({ dx, dy, axis }) =>
      resolveCadPlanGizmoDrag({
        modelToSvg: matrix,
        originModel,
        projection,
        screenDelta: { dx, dy },
        screenCtm: root.getScreenCTM?.() || null,
        axis,
        snapEngine: dragContext?.snapEngine,
        snap: dragContext?.snap,
        ortho: dragContext?.ortho,
        excludeNodeIds: target.nodeIds?.length
          ? target.nodeIds.map(String)
          : target.nodeId
            ? [String(target.nodeId)]
            : [],
      });
    const group = appendAlignmentGizmo(root, target.origin, {
      axisDirections: axes,
      onDragStart: () => {
        const state = editingSession.getState();
        dragContext = {
          sessionId: state?.active ? state.sessionId : null,
          workingRevision: state?.workingRevision,
          drawing: this.drawing,
          kind: this.e?.['cad-edit-kind']?.value,
          snap: Boolean(this.e?.['cad-edit-snap']?.checked),
          ortho: Boolean(this.e?.['cad-edit-ortho']?.checked),
          snapEngine: null,
        };
        if (dragContext.snap) {
          dragContext.snapEngine = createCadPlanSnapEngine(editingSession.getWorkingDocument(), {
            nodeMap: editingSession.getWorkingNodeMap(),
            view: this.drawing?.view,
            drawing: this.drawing,
            visibleTypes: this.drawingDisplaySettings()?.visibility,
          });
        }
        dragging = true;
      },
      onDragMove: ({ dx, dy, axis }) => {
        if (!dragging) return;
        if (!isSameDragContext()) {
          reset();
          return;
        }
        try {
          const resolved = resolveDrag({ dx, dy, axis });
          const [offsetX, offsetY] = resolved.offsetSvg;
          group.setAttribute('transform', `translate(${x + offsetX} ${y + offsetY})`);
          line.setAttribute('x2', String(x + offsetX));
          line.setAttribute('y2', String(y + offsetY));
          label.setAttribute('x', String(x + offsetX + 10));
          label.setAttribute('y', String(y + offsetY - 12));
          label.textContent =
            `${projection.horizontal} ${resolved.delta[projection.horizontal.toLowerCase()].toFixed(1)} / ${projection.vertical} ${resolved.delta[projection.vertical.toLowerCase()].toFixed(1)} mm` +
            (resolved.snap ? ` / Snap: ${resolved.snap.type}` : '');
          preview.setAttribute('visibility', 'visible');
        } catch {
          reset();
        }
      },
      onDragCancel: reset,
      onDragEnd: ({ dx, dy, axis }) => {
        if (!dragging) return;
        const stillCurrent = isSameDragContext();
        if (!stillCurrent || Math.hypot(dx, dy) < 2) {
          reset();
          return;
        }
        try {
          const { delta } = resolveDrag({ dx, dy, axis });
          reset();
          if (Math.hypot(delta.x, delta.y, delta.z) <= 1e-7) return;
          this.commitCadEditVector(delta, { target, viaGizmo: true });
        } catch (error) {
          reset();
          this.cadEditRestoreSelection = null;
          this.fail(error);
        }
      },
    });
    if (!group) {
      preview.remove();
      return;
    }
    group.classList.add('cad-edit-geometry-gizmo');
    group.setAttribute('aria-label', target.nodeId ? '節点移動ギズモ' : '部材移動ギズモ');
  }

  /** One pointerup = one EditingSession transaction; also shared by numeric MOVE. */
  commitCadEditVector(delta, { target = null, viaGizmo = false } = {}) {
    if (!this.canEditCadGeometry())
      throw new Error('編集モードでモデルAの伏図または軸組図を開いてください。');
    if (
      !delta ||
      ![delta.x, delta.y, delta.z].every(Number.isFinite) ||
      (delta.x === 0 && delta.y === 0 && delta.z === 0)
    )
      throw new Error('移動量はゼロ以外の有限の数値にしてください。');
    if (this.e['cad-edit-kind'].value === 'node') {
      const nodeIds = target?.nodeIds || this.selectedCadNodeIds();
      if (!nodeIds.length) throw new Error('図面から節点を選択してください。');
      this.cadOperations.moveNodesByVector(nodeIds, delta, {
        label: `簡易CAD ${nodeIds.length}節点を移動`,
      });
    } else {
      const refs = target?.members?.length ? target.members : this.selectedCadMemberRefs();
      if (!refs.length || refs.some((ref) => ref.modelKey !== 'A'))
        throw new Error('図面からモデルAの部材を選択してください。');
      this.cadEditRestoreSelection = target?.member || refs.at(-1);
      try {
        this.cadOperations.moveSelectionsByVector(refs, delta, {
          followRelatedNodes: editingSession.getMoveFollowRelatedNodes(),
          label: `簡易CAD ${refs.length}部材を移動`,
        });
      } catch (error) {
        this.cadEditRestoreSelection = null;
        throw error;
      }
    }
    const projection = cadDrawingEditProjection(this.drawing?.view);
    showSuccess(
      `${viaGizmo ? 'ギズモ' : '数値指定'}で移動しました（Δ${projection.horizontal}=${delta[projection.horizontal.toLowerCase()]}mm、Δ${projection.vertical}=${delta[projection.vertical.toLowerCase()]}mm）。`,
    );
  }

  applyCadEditMove() {
    const dxText = this.e['cad-edit-dx']?.value;
    const dyText = this.e['cad-edit-dy']?.value;
    const dx = Number(dxText);
    const dy = Number(dyText);
    if (!dxText?.trim() || !dyText?.trim() || !Number.isFinite(dx) || !Number.isFinite(dy))
      return showWarning('ΔX、ΔYには有限のmm値を指定してください。');
    if (dx === 0 && dy === 0) return showWarning('移動量を入力してください。');
    try {
      const projection = cadDrawingEditProjection(this.drawing?.view);
      if (!projection) throw new Error('編集対象の投影面が不正です。');
      this.commitCadEditVector(cadLiftEditVector(projection, [dx, dy]));
    } catch (error) {
      this.fail(error);
    }
  }

  /** Update a selected node's absolute model coordinates in one Undo-able transaction. */
  applyCadEditPosition() {
    if (
      !this.canEditCadGeometry() ||
      this.e['cad-edit-kind']?.value !== 'node' ||
      this.selectedCadNodeIds().length !== 1
    )
      return showWarning('絶対座標は単一節点を選択して編集してください。');
    try {
      const nodeId = this.cadEditNodeId;
      const current = cadNodePosition(
        editingSession.getWorkingDocument(),
        editingSession.getWorkingNodeMap(),
        nodeId,
      );
      const operation = cadAbsoluteNodeMove(nodeId, current, {
        x: this.e['cad-edit-property-x']?.value,
        y: this.e['cad-edit-property-y']?.value,
        z: this.e['cad-edit-property-z']?.value,
      });
      if (!operation.changed) return showInfo('節点座標に変更はありません。');
      this.cadOperations.moveNodesToPositions(operation.moves, {
        label: `簡易CAD 節点 ${nodeId} の座標を設定`,
      });
      showSuccess(`節点 #${nodeId} の座標を更新しました。`);
    } catch (error) {
      this.fail(error);
    }
  }

  /** Align selected Nodes on the current model plane using the shared 3D Node ALIGN. */
  applyCadEditAxisAlign() {
    if (
      !this.canEditCadGeometry() ||
      this.e['cad-edit-kind']?.value !== 'node' ||
      !this.cadEditNodeId
    )
      return showWarning('モデルAの伏図または軸組図で節点を選択してください。');

    const projection = cadDrawingEditProjection(this.drawing?.view);
    const axis = this.e['cad-edit-align-axis']?.value;
    const valueText = this.e['cad-edit-align-value']?.value;
    const value = Number(valueText);
    if (
      ![projection?.horizontal, projection?.vertical].includes(axis) ||
      !valueText?.trim() ||
      !Number.isFinite(value)
    )
      return showWarning('表示平面の座標軸と有限の参照座標(mm)を指定してください。');

    try {
      const nodeId = this.cadEditNodeId;
      const nodeIds = this.selectedCadNodeIds();
      if (!nodeIds.length) throw new Error('軸揃えの対象節点がありません。');
      const position = cadNodePosition(
        editingSession.getWorkingDocument(),
        editingSession.getWorkingNodeMap(),
        nodeId,
      );
      if (!position) throw new Error(`節点 #${nodeId} の座標を取得できません。`);
      if (
        nodeIds.every(
          (id) =>
            cadNodePosition(
              editingSession.getWorkingDocument(),
              editingSession.getWorkingNodeMap(),
              id,
            )?.[axis.toLowerCase()] === value,
        )
      )
        return showInfo('選択節点は既に指定したモデル座標上にあります。');
      this.cadOperations.alignNodesToAxis(nodeIds, axis, value, {
        label: `簡易CAD ${nodeIds.length}節点を ${axis}=${value}mm に軸揃え`,
      });
      showSuccess(`${nodeIds.length}節点をモデル ${axis}=${value}mm に揃えました。`);
    } catch (error) {
      this.fail(error);
    }
  }

  applyCadEditHistory(direction) {
    const state = editingSession.getState();
    if (!state?.active || !['undo', 'redo'].includes(direction)) return;
    try {
      const result = direction === 'undo' ? editingSession.undo() : editingSession.redo();
      if (result)
        showInfo(direction === 'undo' ? '編集を元に戻しました。' : '編集をやり直しました。');
      this.updateCadEditControls();
    } catch (error) {
      this.fail(error);
    }
  }

  renderOverlay() {
    this.updateCadEditControls();
    const layer = this.e['pdf-overlay-svg-layer'];
    layer.replaceChildren();
    const viewportMode = this.viewportMode();
    if (viewportMode === 'sheet') {
      this.renderSheet();
      // A background multi-view generation may have just made PDF export ready.
      this.updatePdfFeatureAvailability();
      return;
    }
    if (viewportMode !== 'pdf') {
      this.currentModelToCss = null;
      this.e['pdf-overlay-canvas-layer'].replaceChildren();
      this.setEmptyCanvasState(true);
      return;
    }
    this.setEmptyCanvasState(false);
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
      onSelect: (ref, event) => {
        if (
          !this.measurementUi?.isActive() &&
          !this.anchorPickTarget &&
          !this.regionUi.isSelecting()
        )
          this.showSelectedElement(this.resolveCandidateRef(ref), event);
      },
    });
    this.candidateUi?.clear();
    layer.append(svg);
    this.applySelectionHighlight(svg);
    this.sessionUi?.refreshSelectedTagControls();
    this.regionUi.appendVisuals(svg, true);
    this.sessionUi?.appendDrawingMemos(svg);
    this.measurementUi?.appendVisuals(svg);
    this.appendCadEditNodes(svg);
    this.appendCadEditGizmo(svg);
    if (this.gizmoPickOrigin || this.anchorPickTarget?.space === 'model') {
      appendAlignmentCandidateMarkers(
        svg,
        this.gizmoPickOrigin ? this.filteredGizmoCandidates() : this.alignmentCandidates,
        this.currentModelToCss,
      );
    }
    this.appendGizmo(svg);
    this.appendCadPointerOverlay(svg);
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

let unregisterCadRibbon = null;

function syncCadRibbonOffset(root) {
  const ribbon = root.querySelector('.ribbon');
  if (!unregisterCadRibbon && ribbon) {
    unregisterCadRibbon = registerTopRibbon(ribbon, { fullWidth: true });
  }
  refreshTopRibbonInset();
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
  registerDrawingSheetSessionProvider(() => panel);
  for (const def of PDF_OVERLAY_FLOAT_WINDOWS) {
    floatingWindowManager.registerWindow({
      windowId: def.windowId,
      toggleButtonId: def.toggleButtonId,
      closeButtonId: def.closeButtonId,
      headerId: def.headerId,
      draggable: true,
      resizable: true,
      ...(def.key === 'tagPlacement'
        ? {
            onShow: () => panel.sessionUi.onTagPlacementWindowVisibilityChanged(),
            onHide: () => panel.sessionUi.onTagPlacementWindowVisibilityChanged(),
          }
        : {}),
    });
  }

  // On the first CAD opening show both catalogs; later manual close/reopen choices
  // remain intact until the workspace is reconstructed.
  let catalogsInitialized = false;
  const setVisible = (visible) => {
    const wasVisible = root.classList.contains('visible');
    if (wasVisible !== visible) {
      eventBus.emit(MeasurementEvents.SEQUENCE_RESET, {
        targetSurface: visible ? 'pdf-overlay' : '3d',
        reason: 'workspace-switch',
      });
    }

    if (!visible) panel.sessionUi?.closeOpenDrawingProject?.();
    root.classList.toggle('visible', visible);
    root.setAttribute('aria-hidden', String(!visible));
    button.setAttribute('aria-expanded', String(visible));
    document.body.classList.toggle('workspace-view-active', visible);
    syncCadRibbonOffset(root);
    if (wasVisible !== visible) {
      eventBus.emit(UIEvents.WORKSPACE_VISIBILITY_CHANGED, { workspace: 'simple-cad', visible });
    }
    if (visible) {
      panel.refreshModelAndStories();
      panel.renderOverlay();
      if (!catalogsInitialized) {
        for (const key of ['sheetCatalog']) {
          const def = PDF_OVERLAY_FLOAT_WINDOWS.find((entry) => entry.key === key);
          if (def) floatingWindowManager.showWindow(def.windowId);
        }
        catalogsInitialized = true;
      }
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
