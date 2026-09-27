/** @fileoverview PDF領域選択とSTB階への一時対応付けUI。 */
import {
  createPdfRegionMapping,
  inspectPdfRegionMapping,
  mapCssSelectionToPdfRegion,
  mapPdfRegionToCssPolygon,
} from '../../../app/pdfOverlay/pdfOverlayRegion.js';
import { showInfo, showSuccess, showWarning } from '../../common/toast.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export class PdfOverlayRegionController {
  constructor(panel) {
    this.panel = panel;
    this.regionSelectionArmed = false;
    this.regionSelectionDrag = null;
    this.selectedRegion = null;
    this.selectedRegionPageNumber = null;
    this.regionMapping = null;
    this.suppressStageClick = false;
  }

  bindEvents() {
    const { root, e } = this.panel;
    root.querySelector('#pdf-overlay-select-region').addEventListener('click', () => {
      if (!this.panel.pdfAdapter) return showWarning('PDFを先に読み込んでください。');
      const arm = () => {
        this.panel.resetMeasurementSequence?.('region-select');
        this.panel.sessionUi?.cancelDrawingMemo();
        this.regionSelectionArmed = true;
        this.panel.anchorPickTarget = null;
        this.panel.gizmoPickOrigin = false;
        this.panel.setStatus('PDF上で図面領域をドラッグ選択してください。');
        showInfo('PDF上で図面領域をドラッグ選択してください。');
      };
      if (e['pdf-overlay-display-mode'].value !== 'pdf') {
        e['pdf-overlay-display-mode'].value = 'pdf';
        this.panel
          .renderPdf()
          .then(arm)
          .catch((error) => this.panel.fail(error));
      } else if (this.panel.pageRender) arm();
      else
        this.panel
          .renderPdf()
          .then(arm)
          .catch((error) => this.panel.fail(error));
    });
    root.querySelector('#pdf-overlay-map-region').addEventListener('click', () => {
      try {
        this.mapSelectedRegionToDrawing();
      } catch (error) {
        this.panel.fail(error);
      }
    });
    root.querySelector('#pdf-overlay-clear-region').addEventListener('click', () => this.clear());
    e['pdf-overlay-stage'].addEventListener('pointerdown', (event) => this.beginSelection(event));
    e['pdf-overlay-stage'].addEventListener('pointermove', (event) => this.updateSelection(event));
    e['pdf-overlay-stage'].addEventListener('pointerup', (event) => this.finishSelection(event));
    e['pdf-overlay-stage'].addEventListener('pointercancel', () => this.cancelSelection());
  }

  clear() {
    this.selectedRegion = null;
    this.selectedRegionPageNumber = null;
    this.regionMapping = null;
    this.panel.sessionUi?.invalidateReviews('REGION_CHANGED');
    this.regionSelectionArmed = false;
    this.removeSelectionBox();
    this.renderStatus();
    this.panel.renderOverlay();
  }

  resetForPdf() {
    this.selectedRegion = null;
    this.selectedRegionPageNumber = null;
    this.regionMapping = null;
    this.panel.sessionUi?.invalidateReviews('PDF_CHANGED');
    this.cancelSelection();
    this.renderStatus();
  }

  invalidateDrawing() {
    this.regionMapping = null;
    this.panel.sessionUi?.invalidateReviews('STB_VIEW_CHANGED');
    this.renderStatus();
  }

  stagePoint(event) {
    const rect = this.panel.e['pdf-overlay-stage'].getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  beginSelection(event) {
    if (
      !this.regionSelectionArmed ||
      this.panel.e['pdf-overlay-display-mode'].value !== 'pdf' ||
      event.button !== 0 ||
      !this.panel.pageRender
    )
      return;
    if (event.target?.closest?.('.pdf-overlay-gizmo')) return;
    event.preventDefault();
    event.stopPropagation();
    const start = this.stagePoint(event);
    this.regionSelectionDrag = { pointerId: event.pointerId, start, end: start };
    this.panel.e['pdf-overlay-stage'].setPointerCapture?.(event.pointerId);
    this.panel.e['pdf-overlay-region-selection-box'].classList.add('active');
    this.updateSelectionBox(start, start);
  }

  updateSelection(event) {
    const drag = this.regionSelectionDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    drag.end = this.stagePoint(event);
    this.updateSelectionBox(drag.start, drag.end);
  }

  finishSelection(event) {
    const drag = this.regionSelectionDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.end = this.stagePoint(event);
    this.regionSelectionDrag = null;
    this.regionSelectionArmed = false;
    this.removeSelectionBox();
    this.suppressStageClick = true;
    setTimeout(() => {
      this.suppressStageClick = false;
    }, 250);
    try {
      const { pageRender } = this.panel;
      this.selectedRegion = mapCssSelectionToPdfRegion({
        start: drag.start,
        end: drag.end,
        cssToPdf: pageRender.cssToPdf,
        viewBox: pageRender.viewBox,
      });
      this.selectedRegionPageNumber = pageRender.pageNumber;
      this.regionMapping = null;
      this.panel.sessionUi?.invalidateReviews('REGION_CHANGED');
      this.renderStatus();
      this.panel.renderOverlay();
      showSuccess('PDF図面領域を選択しました。階を選んで対応付けてください。');
    } catch (error) {
      this.selectedRegion = null;
      this.selectedRegionPageNumber = null;
      this.panel.sessionUi?.invalidateReviews('REGION_CHANGED');
      this.renderStatus();
      showWarning(error?.message || 'PDF図面領域を選択できませんでした。');
    }
  }

  cancelSelection() {
    const pointerId = this.regionSelectionDrag?.pointerId;
    this.regionSelectionDrag = null;
    this.regionSelectionArmed = false;
    const stage = this.panel.e['pdf-overlay-stage'];
    try {
      if (pointerId != null && stage.hasPointerCapture?.(pointerId))
        stage.releasePointerCapture(pointerId);
    } catch {
      // Pointer capture may already have been released by the browser.
    }
    this.removeSelectionBox();
  }

  updateSelectionBox(start, end) {
    const box = this.panel.e['pdf-overlay-region-selection-box'];
    const left = Math.min(start[0], end[0]);
    const top = Math.min(start[1], end[1]);
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${Math.abs(end[0] - start[0])}px`;
    box.style.height = `${Math.abs(end[1] - start[1])}px`;
  }

  removeSelectionBox() {
    const box = this.panel.e['pdf-overlay-region-selection-box'];
    box.classList.remove('active');
    box.style.width = '0';
    box.style.height = '0';
  }

  mapSelectedRegionToDrawing() {
    const { pdfAdapter, pageRender, drawing } = this.panel;
    if (!pdfAdapter?.info || !pageRender || !drawing || !this.selectedRegion)
      throw new Error('PDF領域、PDFページ、STB図面を先に用意してください。');
    if (this.selectedRegionPageNumber !== pageRender.pageNumber)
      throw new Error('選択領域のページが現在のPDFページと異なります。');
    this.regionMapping = createPdfRegionMapping({
      pdfInfo: pdfAdapter.info,
      pageRender,
      region: this.selectedRegion,
      drawing,
    });
    this.panel.sessionUi?.invalidateReviews('REGION_CHANGED');
    this.renderStatus();
    this.panel.renderOverlay();
  }

  mappingState() {
    if (!this.regionMapping) return null;
    const { pdfAdapter, pageRender, drawing } = this.panel;
    return inspectPdfRegionMapping(this.regionMapping, {
      pdfInfo: pdfAdapter?.info,
      pageRender,
      drawing,
    });
  }

  activeRegion() {
    const mappingState = this.mappingState();
    if (mappingState?.current) return this.regionMapping.region;
    if (this.selectedRegionPageNumber === this.panel.pageRender?.pageNumber)
      return this.selectedRegion;
    return null;
  }

  renderStatus() {
    const { e, pageRender, pdfAdapter, drawing } = this.panel;
    const status = this.mappingState();
    const region = this.activeRegion();
    const format = (value) => Number(value).toFixed(1);
    if (status?.current) {
      e['pdf-overlay-region-status'].textContent =
        `PDF ${this.regionMapping.pdf.pageNumber}頁 / STB ${this.regionMapping.stb.modelKey}・${this.regionMapping.stb.view.storyId}階 / X ${format(region.xMin)}–${format(region.xMax)}, Y ${format(region.yMin)}–${format(region.yMax)}`;
    } else if (status) {
      e['pdf-overlay-region-status'].textContent = `以前の対応は無効: ${status.code}`;
    } else if (region) {
      e['pdf-overlay-region-status'].textContent =
        `PDF ${this.selectedRegionPageNumber}頁の領域 / 未対応 X ${format(region.xMin)}–${format(region.xMax)}, Y ${format(region.yMin)}–${format(region.yMax)}`;
    } else if (this.selectedRegion) {
      e['pdf-overlay-region-status'].textContent =
        `選択領域はPDF ${this.selectedRegionPageNumber}頁にあります。`;
    } else {
      e['pdf-overlay-region-status'].textContent = '領域未選択';
    }
    const ready = Boolean(
      this.selectedRegion &&
      this.selectedRegionPageNumber === pageRender?.pageNumber &&
      pageRender &&
      pdfAdapter?.info &&
      drawing,
    );
    this.panel.root.querySelector('#pdf-overlay-map-region').disabled = !ready;
    this.panel.root.querySelector('#pdf-overlay-clear-region').disabled =
      !this.selectedRegion && !this.regionMapping;
  }

  consumeClick() {
    if (!this.suppressStageClick) return false;
    this.suppressStageClick = false;
    return true;
  }

  isSelecting() {
    return (
      this.regionSelectionArmed || Boolean(this.regionSelectionDrag) || this.suppressStageClick
    );
  }

  appendVisuals(svg, clipDrawing) {
    const region = this.activeRegion();
    const { pageRender } = this.panel;
    if (!region || !pageRender) return;
    const polygon = mapPdfRegionToCssPolygon(region, pageRender.pdfToCss);
    const points = polygon.map(([x, y]) => `${x},${y}`).join(' ');
    const mapped = this.mappingState()?.current === true;
    if (clipDrawing && mapped) {
      const defs = document.createElementNS(SVG_NS, 'defs');
      const clip = document.createElementNS(SVG_NS, 'clipPath');
      clip.setAttribute('id', 'pdf-overlay-region-clip');
      clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
      const clipPolygon = document.createElementNS(SVG_NS, 'polygon');
      clipPolygon.setAttribute('points', points);
      clip.append(clipPolygon);
      defs.append(clip);
      const drawingGroup = document.createElementNS(SVG_NS, 'g');
      while (svg.firstChild) drawingGroup.append(svg.firstChild);
      drawingGroup.setAttribute('clip-path', 'url(#pdf-overlay-region-clip)');
      svg.append(defs, drawingGroup);
    }
    const outline = document.createElementNS(SVG_NS, 'polygon');
    outline.setAttribute('points', points);
    outline.setAttribute(
      'class',
      mapped ? 'pdf-overlay-region-outline mapped' : 'pdf-overlay-region-outline',
    );
    outline.setAttribute('pointer-events', 'none');
    svg.append(outline);
  }
}
